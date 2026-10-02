/**
 * 规范化数据目录（BUG-013 延伸：会话 / 模型 / 观雅集 / Hub 统一落盘）
 * ----------------------------------------------------------------------------
 * 纯逻辑模块：**不 import electron**，可在 node 下直接 require 编译产物验证。
 *
 *   resolveDataDir(opts)   目录优先级判定（纯函数）
 *   candidateLegacyDirs()  历史候选目录（去重）
 *   migrateDataFiles()     文件迁移：merge-json（按 key 合并）/ copy-if-absent（只补齐）
 *   migrateDataDirs()      目录迁移（递归，只补齐）
 *   setDataDirResolver()   由 main.ts 注入统一目录，供 guanji/hub 取用（避免循环依赖）
 *   getDataDir()           取目录（未注入时回退 ORCHDESK_HOME）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 默认数据目录名（位于 appData 下）。 */
export const DATA_DIR_NAME = 'OrchDesk';
/** 便携模式数据目录名（位于 exe 同目录）。 */
export const PORTABLE_DIR_NAME = 'orchdesk-data';
/** 便携模式标记文件名（存在即视为便携模式）。 */
export const PORTABLE_MARKER = 'PORTABLE';
/** 观雅集技能包目录名（随数据目录迁移）。 */
export const SKILLS_DIR_NAME = 'skills';

/**
 * 数据文件名：main（迁移清单 + 读写处）/ guanji / hub 共用同一份常量，
 * 避免各处字面量漂移导致「迁移搬了 A 名、读取读 B 名」。
 */
export const DATA_FILE_NAMES = {
  sessions: 'orchdesk-sessions.json',
  models: 'models.json',
  guanji: 'guanji.json',
  hub: 'hub.json',
  /** PRD FR-4.2 桌面集成开关（托盘 / 快捷键 / 自启动 / 更新 / 悬浮窗 / 通知）。 */
  desktop: 'desktop.json',
  /** PRD FR-8 沙箱日志（可检索；随数据目录迁移，否则换目录后追溯断档）。 */
  sandboxLog: 'sandbox-log.json',
  /** PRD FR-10 分层记忆晋升审计（随数据目录迁移：谁把什么从哪个域升到了哪个域）。 */
  promotions: 'memory-promotions.json',
  /** PRD FR-3 连接器注册表（加密凭证 + 探测状态 + 审计；随数据目录迁移）。 */
  connectors: 'connectors.json',
  /** PRD FR-3 本地插件市场启用状态（目录内容本身在 dataDir()/plugins/）。 */
  market: 'plugin-market.json',
  /** PRD FR-5 模型用量追踪（回合级条目 + 聚合；随数据目录迁移）。 */
  usage: 'usage.json',
  /** MCP server 配置（真接入：命令/参数/env，随数据目录迁移）。 */
  mcp: 'mcp.json',
} as const;

/** 随数据目录迁移的目录名（与 DATA_FILE_NAMES 同理，集中登记）。 */
export const DATA_DIR_NAMES = {
  skills: SKILLS_DIR_NAME,
  /** PRD FR-6 SessionEvent append-only 事件日志（每会话一个 NDJSON，ADR-0009）。 */
  events: 'events',
} as const;

// ---------------------------------------------------------------------------
// 目录解析
// ----------------------------------------------------------------------------

export interface ResolveDataDirOptions {
  /** ORCHDESK_HOME 环境变量值（最高优先级，空白视为未设置）。 */
  envHome?: string;
  /** 是否打包运行（未打包不启用便携模式探测）。 */
  isPackaged?: boolean;
  /** exe 所在目录（未打包可省略）。 */
  exeDir?: string;
  /** app.getPath('appData')。 */
  appData?: string;
  /** app.getPath('userData')，作为目录不可用时的兜底。 */
  userData?: string;
  /** 覆盖默认目录名（测试用）。 */
  appDirName?: string;
  /** 覆盖便携目录名（测试用）。 */
  portableDirName?: string;
  /** 存在性探测；缺省一律视为不存在。 */
  existsSync?: (p: string) => boolean;
  /** 可用性探测（如 mkdir 是否成功）；缺省一律视为可用。 */
  canUse?: (dir: string) => boolean;
}

/**
 * 解析规范化数据目录，优先级：
 *   1) ORCHDESK_HOME
 *   2) 便携模式（打包 + exe 同目录存在 orchdesk-data/ 或 PORTABLE 标记）
 *   3) appData/<OrchDesk>
 *   4) 上述目录不可用时兜底 userData
 * 纯函数：不做 IO（创建/可用性由 canUse 回调决定）。
 */
export function resolveDataDir(opts: ResolveDataDirOptions = {}): string {
  const envHome = (opts.envHome ?? '').trim();
  const preferred = envHome
    ? path.resolve(envHome)
    : detectPortableDataDir(opts) ?? (opts.appData ? path.join(opts.appData, opts.appDirName ?? DATA_DIR_NAME) : '');
  if (preferred && canUseDir(opts, preferred)) return preferred;
  const userData = opts.userData ?? '';
  if (userData && canUseDir(opts, userData)) return userData;
  return preferred || userData;
}

function canUseDir(opts: ResolveDataDirOptions, dir: string): boolean {
  return opts.canUse ? opts.canUse(dir) : true;
}

function detectPortableDataDir(opts: ResolveDataDirOptions): string | null {
  if (!opts.isPackaged) return null;
  const exeDir = (opts.exeDir ?? '').trim();
  if (!exeDir) return null;
  const existsSync = opts.existsSync ?? (() => false);
  const dir = path.join(exeDir, opts.portableDirName ?? PORTABLE_DIR_NAME);
  if (existsSync(dir) || existsSync(path.join(exeDir, PORTABLE_MARKER))) return dir;
  return null;
}

export interface CandidateLegacyDirsOptions {
  userData?: string;
  appData?: string;
  isPackaged?: boolean;
  exeDir?: string;
  /** 主进程模块所在目录（编译产物为 dist/），用于推导 dev 期历史位置。 */
  moduleDir?: string;
  appDirName?: string;
  portableDirName?: string;
  /** 需要排除的目录（通常传目标目录本身，避免自我迁移）。 */
  exclude?: string[];
}

/** 目录归一键：win32 路径大小写不敏感，需小写后比较；其余平台仅 resolve 归一。 */
function dirKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 所有历史可能的数据目录（保持原 legacyDataDirs 的枚举顺序）。
 * 去重按「实际同一地址」判定：win32 下 userData / appData/OrchDesk /
 * appData/orchdesk 可能指向同一处，只保留**首次出现的原始字符串**。
 */
export function candidateLegacyDirs(opts: CandidateLegacyDirsOptions = {}): string[] {
  const excluded = new Set((opts.exclude ?? []).map(dirKey));
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string | undefined): void => {
    if (!p) return;
    const key = dirKey(p);
    if (excluded.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  const { userData, appData, exeDir, moduleDir, isPackaged } = opts;
  push(userData);
  if (appData) push(path.join(appData, opts.appDirName ?? DATA_DIR_NAME));
  if (appData) push(path.join(appData, 'orchdesk'));
  if (userData) push(path.join(userData, '..'));
  if (isPackaged && exeDir) push(path.join(exeDir, opts.portableDirName ?? PORTABLE_DIR_NAME));
  if (moduleDir) {
    push(path.resolve(moduleDir, '..'));
    push(path.resolve(moduleDir, '../..'));
    push(path.join(path.resolve(moduleDir, '..'), '.orchdesk-home'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 迁移
// ----------------------------------------------------------------------------

/**
 * 文件迁移模式：
 *  - merge-json      按 key 合并（会话 / 模型配置）
 *  - copy-if-absent  目标不存在才整份搬运（凭据类，禁止深合并以免破坏密文）
 */
export type MigrateMode = 'merge-json' | 'copy-if-absent';

export interface MergeOutcome {
  data: unknown;
  /** 本次合并涉及的条目数（日志诊断用，**不代表需要落盘**）。 */
  added: number;
  /**
   * 是否有实质变化；只有它为 true 时调用方才写盘。
   * 与 added 的区别：同源会话被反复合并时 added 恒 > 0，但内容无变化则不该重写
   * （30MB 会话档每次启动 parse + stringify + 写盘即 60~90MB IO）。
   */
  changed: boolean;
}

export interface MigrateFileSpec {
  /** 文件名（位于 targetDir / sourceDirs 下）。 */
  name: string;
  mode: MigrateMode;
  /** merge-json 的合并器；缺省为「目标不存在才写入来源」。 */
  merge?: (target: unknown, source: unknown) => MergeOutcome | null;
}

export interface MigrateFileResult {
  file: string;
  /** 来源目录；moved=false 时为来源目录（未采纳）。 */
  from: string;
  moved: boolean;
  /** 新增条目数 / 复制文件数。 */
  added: number;
  /** 失败原因（结构化）；成功时无此字段。便于测试断言，不必依赖 console 输出。 */
  error?: string;
}

export interface MigrateDirResult {
  dir: string;
  from: string;
  moved: boolean;
  copied: number;
  /** 失败原因（结构化）；成功时无此字段。 */
  error?: string;
}

export interface DataDirIo {
  existsSync: (p: string) => boolean;
  readJson: (file: string) => unknown | null;
  writeJson: (file: string, data: unknown) => void;
  copyFile: (src: string, dest: string) => void;
  /** 递归创建目录。 */
  mkdir: (dir: string) => void;
  readDir: (dir: string) => Array<{ name: string; isDirectory: boolean }>;
}

/** 默认 fs 实现（无 electron 依赖，node 下可直接跑）。 */
export const fsIo: DataDirIo = {
  existsSync: (p) => fs.existsSync(p),
  readJson: (file) => {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    } catch { return null; }
  },
  writeJson: (file, data) => { fs.writeFileSync(file, JSON.stringify(data), 'utf-8'); },
  copyFile: (src, dest) => { fs.copyFileSync(src, dest); },
  mkdir: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
  readDir: (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
    } catch { return []; }
  },
};

export interface MigrateFilesOptions {
  targetDir: string;
  sourceDirs: string[];
  files: MigrateFileSpec[];
  io?: DataDirIo;
}

export interface MigrateDirsOptions {
  targetDir: string;
  sourceDirs: string[];
  /** 目录名列表（位于 targetDir / sourceDirs 下）。 */
  dirs: string[];
  io?: DataDirIo;
}

/**
 * 从历史目录迁移文件到目标目录：只补齐不覆盖（目标侧已有数据永远优先）。
 * 返回逐条结果，便于日志与验证。
 */
export function migrateDataFiles(opts: MigrateFilesOptions): MigrateFileResult[] {
  const io = opts.io ?? fsIo;
  const results: MigrateFileResult[] = [];
  if (opts.targetDir) io.mkdir(opts.targetDir);
  for (const spec of opts.files) {
    const target = path.join(opts.targetDir, spec.name);
    // 目标文件每个 spec 只探测/读取一次：历史实现在内层循环对每个 sourceDir 都
    // 全量 readJson(target)，候选目录一多就是成倍的整档 IO。
    let targetExists = io.existsSync(target);
    let targetLoaded = false;
    let targetData: unknown = null;
    const readTarget = (): unknown => {
      if (!targetExists) return null;
      if (!targetLoaded) {
        targetData = io.readJson(target);
        targetLoaded = true;
      }
      return targetData;
    };
    for (const src of opts.sourceDirs) {
      if (!src || src === opts.targetDir) continue;
      const srcFile = path.join(src, spec.name);
      if (!io.existsSync(srcFile)) continue;
      let moved = false;
      let added = 0;
      let error: string | undefined;
      try {
        if (spec.mode === 'copy-if-absent') {
          // 凭据类：整份搬运，绝不深合并（合并会破坏 safeStorage 密文结构）
          if (!targetExists) {
            io.copyFile(srcFile, target);
            moved = true;
            added = 1;
            targetExists = true;
            targetLoaded = false; // 内容已变（二进制原样搬运），下次按需重读
          }
        } else {
          const source = io.readJson(srcFile);
          if (source !== null && source !== undefined) {
            const merge = spec.merge ?? mergeJsonIfAbsent;
            const outcome = merge(readTarget(), source);
            // 只看 changed：added>0 会把「已存在且合并后无变化」也判成需要写盘。
            if (outcome && outcome.changed) {
              io.writeJson(target, outcome.data);
              moved = true;
              added = outcome.added;
              targetExists = true;
              targetData = outcome.data;
              targetLoaded = true;
            }
          }
        }
      } catch (err) {
        error = (err as Error).message;
        // 合并器会就地改目标副本：失败后缓存可能已脏，重新探测并按需重读，
        // 避免上一次失败的结果被后续来源「带落盘」。
        targetExists = io.existsSync(target);
        targetLoaded = false;
        // 保留告警（生产诊断仍需），同时把原因结构化到返回值里。
        console.warn(`[orchdesk] 迁移 ${srcFile} 失败:`, error);
      }
      results.push({
        file: spec.name,
        from: src,
        moved,
        added,
        ...(error === undefined ? {} : { error }),
      });
    }
  }
  return results;
}

/** 目录迁移：递归复制，只补齐目标侧缺失的文件，不覆盖、不删除。 */
export function migrateDataDirs(opts: MigrateDirsOptions): MigrateDirResult[] {
  const io = opts.io ?? fsIo;
  const results: MigrateDirResult[] = [];
  if (opts.targetDir) io.mkdir(opts.targetDir);
  for (const dir of opts.dirs) {
    const targetRoot = path.join(opts.targetDir, dir);
    for (const src of opts.sourceDirs) {
      if (!src || src === opts.targetDir) continue;
      const srcRoot = path.join(src, dir);
      if (!io.existsSync(srcRoot)) continue;
      let copied = 0;
      let error: string | undefined;
      try {
        io.mkdir(targetRoot);
        // 已建目录记入 Set：copyTree 逐文件 mkdir 是大量重复 syscall。
        copied = copyTree(io, srcRoot, targetRoot, '', new Set([targetRoot]));
      } catch (err) {
        error = (err as Error).message;
        console.warn(`[orchdesk] 迁移目录 ${srcRoot} 失败:`, error);
      }
      results.push({
        dir,
        from: src,
        moved: copied > 0,
        copied,
        ...(error === undefined ? {} : { error }),
      });
    }
  }
  return results;
}

/** 递归复制：只补齐目标侧缺失的文件，不覆盖、不删除。created 缓存已建目录。 */
function copyTree(io: DataDirIo, srcRoot: string, targetRoot: string, rel: string, created: Set<string>): number {
  const entries = io.readDir(rel ? path.join(srcRoot, rel) : srcRoot);
  let copied = 0;
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory) {
      copied += copyTree(io, srcRoot, targetRoot, childRel, created);
      continue;
    }
    const dest = path.join(targetRoot, childRel);
    if (io.existsSync(dest)) continue; // 只补齐不覆盖
    const destDir = path.dirname(dest);
    if (!created.has(destDir)) {
      io.mkdir(destDir);
      created.add(destDir);
    }
    io.copyFile(path.join(srcRoot, childRel), dest);
    copied++;
  }
  return copied;
}

// ---------------------------------------------------------------------------
// 内置合并器（纯数据，便于单测）
// ---------------------------------------------------------------------------

/** 目标不存在才写入来源（JSON 层面的「只补齐不覆盖」）。 */
export function mergeJsonIfAbsent(target: unknown, source: unknown): MergeOutcome | null {
  if (target !== null && target !== undefined) return null;
  return { data: source, added: 1, changed: true };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isSessionEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Array.isArray((value as { msgs?: unknown }).msgs);
}

/**
 * BUG-047：进来的会话条目只保证「对象 + msgs 是数组」，其余字段一律原样采信。
 * 伪造的备份（以及历史遗留的旧位置数据文件，走的是同一个合并器）因此可以往
 * `orchdesk-sessions.json` 塞任意 `cwd`/`title`/`pid`。它们今天不会变成代码执行——
 * `ipc-terminal.ts` 用前会 `statSync().isDirectory()` 校验、`buildSystemPrompt` 无调用方、
 * 渲染层输出走 `esc()`——但换行能把任意文本混进「绑定目录」显示与落盘数据。
 * 这里只剪掉确实危险的形态，不丢用户数据：
 *   · `cwd`：含控制字符或超长 → 删掉这个键（宁可不绑目录，也不留一个假路径；
 *     终端回落 `process.cwd()`，chip 回落工作目录设置）。
 *   · `title`：含控制字符 → 删键；超长 → 截断（纯显示，截了不丢正确性）。
 *   · `pid` / `expert` / `model`：非字符串或含控制字符 → 删键。
 * `msgs` 不动：消息正文里的换行是用户内容，不是路径或标识。
 */
const SESSION_PATH_KEYS = ['cwd'] as const;
const SESSION_LABEL_KEYS = ['title', 'expert', 'model', 'pid'] as const;
const MAX_PATH_LEN = 512;
const MAX_LABEL_LEN = 200;
const CONTROL_RE = /[\r\n\u0000]/;

function sanitizeIncomingSession(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  for (const key of SESSION_PATH_KEYS) {
    const v = out[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || CONTROL_RE.test(v) || v.length > MAX_PATH_LEN) {
      delete out[key];
      continue;
    }
  }
  for (const key of SESSION_LABEL_KEYS) {
    const v = out[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || CONTROL_RE.test(v)) {
      delete out[key];
    } else if (key === 'title' && v.length > MAX_LABEL_LEN) {
      out.title = v.slice(0, MAX_LABEL_LEN);
    }
  }
  return out;
}

/**
 * BUG-047 的项目侧：导入分支过去只按 `id` 去重，条目内容一概不校验，
 * 于是伪造备份可以塞进任意键、把 `path`（渲染层拿来显示「绑定目录」）写成带换行的任意文本。
 * 规则与会话侧同口径：`id` 不合法就整条丢弃（没 id 的项目在渲染层本就不可寻址），
 * 其余危险键只删键、不丢整条。
 */
const PROJECT_LABEL_KEYS = ['name', 'title', 'color', 'icon'] as const;

export function sanitizeIncomingProject(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  const id = out.id;
  if (typeof id !== 'string' || !id || CONTROL_RE.test(id) || id.length > 128) return null;
  if (out.path !== undefined) {
    const p = out.path;
    if (typeof p !== 'string' || CONTROL_RE.test(p) || p.length > MAX_PATH_LEN) delete out.path;
  }
  for (const key of PROJECT_LABEL_KEYS) {
    const v = out[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || CONTROL_RE.test(v) || v.length > MAX_LABEL_LEN) delete out[key];
  }
  return out;
}

/**
 * 会话合并：同 id 保留 updated 较新的一份，并把对方独有的消息并入。
 * 目标侧已有会话永不回退到旧版本。
 */
export function mergeSessionsData(target: unknown, source: unknown): MergeOutcome | null {
  const src = asRecord(source);
  const dst = asRecord(target);
  let added = 0;
  let changed = false;
  for (const [id, raw] of Object.entries(src)) {
    if (!isSessionEntry(raw)) continue;
    // BUG-047：进来的条目先剪掉危险形态再参与合并（下面按 updated 取新的那一份，
    // 危险键可能在任一侧，所以清洗放在比较之前，不让它有机会被选为 newer）。
    const incoming = sanitizeIncomingSession(raw);
    const cur = dst[id];
    if (!cur) {
      dst[id] = incoming;
      added++;
      changed = true;
      continue;
    }
    const curEntry = cur as { updated?: unknown; msgs?: unknown; title?: unknown };
    const curT = String(curEntry.updated || '');
    const srcT = String(incoming.updated || '');
    const newer = srcT > curT ? incoming : curEntry;
    const older = srcT > curT ? curEntry : incoming;
    const newerMsgs = Array.isArray(newer.msgs) ? newer.msgs : [];
    const olderMsgs = Array.isArray(older.msgs) ? older.msgs : [];
    const base = newerMsgs.length >= olderMsgs.length ? newerMsgs : olderMsgs;
    const merged: Record<string, unknown> = { ...older, ...newer, msgs: base };
    // 已存在 id：只有合并结果与现有条目实质不同（updated / 消息条数 / 标题）才算变化，
    // 否则每次启动都会把整份 sessions 重写一遍。
    if (String(merged.updated ?? '') !== curT
      || (Array.isArray(merged.msgs) ? merged.msgs.length : 0) !== (Array.isArray(curEntry.msgs) ? curEntry.msgs.length : 0)
      || String(merged.title ?? '') !== String(curEntry.title ?? '')) {
      changed = true;
    }
    dst[id] = merged;
    added++;
  }
  if (!added) return null;
  return { data: dst, added, changed };
}

/** 模型配置合并：按 provider id 去重补齐，已存在的提供商保持目标侧配置。 */
export function mergeProvidersData(target: unknown, source: unknown): MergeOutcome | null {
  const srcProviders = providersOf(source);
  if (!srcProviders.length) return null;
  const dst = asRecord(target);
  const dstProviders = providersOf(dst);
  let added = 0;
  for (const p of srcProviders) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id ?? p.name ?? '');
    if (!id || dstProviders.some((d) => String(d?.id ?? '') === id)) continue;
    dstProviders.push(p);
    added++;
  }
  if (!added) return null;
  dst.providers = dstProviders;
  return { data: dst, added, changed: true };
}

function providersOf(data: unknown): Array<Record<string, unknown>> {
  const providers = asRecord(data).providers;
  return Array.isArray(providers) ? providers as Array<Record<string, unknown>> : [];
}

// ---------------------------------------------------------------------------
// 模块级解析器（供 guanji / hub 取用，避免反向 import main 造成循环依赖）
// ---------------------------------------------------------------------------

let dataDirResolver: (() => string) | null = null;

/** 注入数据目录解析器（传 null 解除）。 */
export function setDataDirResolver(fn: (() => string) | null): void {
  dataDirResolver = fn;
}

/** 清掉已注入的解析器（测试用，对齐 credentials.resetKeyCache）。 */
export function resetDataDirResolver(): void {
  dataDirResolver = null;
}

/** 取统一数据目录。解析顺序：注入的解析器 → ORCHDESK_DATA_DIR → ORCHDESK_HOME → 抛错。
 * 三者皆无则抛错——绝不静默回退到 '.'（进程 cwd，打包版即 exe 目录，会把
 * 沙箱状态/桌面配置写进安装目录且不报错，M3 数据目录多真源的根因）。 */
export function getDataDir(): string {
  if (dataDirResolver) return dataDirResolver();
  const envDir = (process.env.ORCHDESK_DATA_DIR || '').trim();
  if (envDir) return path.resolve(envDir);
  const envHome = (process.env.ORCHDESK_HOME || '').trim();
  if (envHome) return path.resolve(envHome);
  throw new Error('[orchdesk] 数据目录解析器尚未注入（setDataDirResolver），且未设置 ORCHDESK_DATA_DIR/ORCHDESK_HOME');
}

// ---------------------------------------------------------------------------
// 数据目录内容清单（PRD FR-4.2「内容清单」）
// ----------------------------------------------------------------------------
// 设置页此前写死「~ 24 MB」——一个与实际磁盘毫无关系的数字。清单必须来自真实
// 文件系统，否则「备份整个数据目录」这句承诺的大小是编的。
// ----------------------------------------------------------------------------

export interface DataDirItem {
  /** 相对数据目录的路径（统一用 / 分隔，UI 展示与检索都方便）。 */
  name: string;
  /** 字节数；目录取其递归内所有文件之和。 */
  size: number;
  /** 'file' | 'dir'。 */
  kind: 'file' | 'dir';
  /** 目录内的文件数（文件恒为 1）。 */
  files: number;
  /** epoch ms；读取失败为 0。 */
  mtime: number;
}

export interface DataDirInventory {
  dir: string;
  items: DataDirItem[];
  totalSize: number;
  totalFiles: number;
  /** 扫描未完成的目录（权限 / 竞态删除），如实上报而不是假装扫全了。 */
  errors: string[];
}

interface TreeStat { size: number; files: number }

/**
 * 递归统计目录（不跟随符号链接，避免软链成环把扫描拖死）。
 *
 * 返回本目录的 {size, files} 汇总供父级累加 —— **不要**改成让父级去扫 out 里新增
 * 的条目：out 里既有后代文件，也有后代目录条目本身，父级照单全收会把子目录的重量
 * 算两遍（FR-4.2 首版踩过：logs 实为 120 B 却报 190 B，根汇总 520 B 却报 780 B）。
 */
function statTree(abs: string, rel: string, out: DataDirItem[], errors: string[]): TreeStat {
  const none: TreeStat = { size: 0, files: 0 };
  let st;
  try { st = fs.statSync(abs); } catch { return none; }
  if (st.isSymbolicLink()) return none;
  if (st.isFile()) {
    out.push({ name: rel, size: st.size, kind: 'file', files: 1, mtime: st.mtimeMs });
    return { size: st.size, files: 1 };
  }
  if (!st.isDirectory()) return none;

  let size = 0;
  let files = 0;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (err) { errors.push((rel || '.') + ': ' + (err as Error).message); }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const childRel = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      const r = statTree(path.join(abs, e.name), childRel, out, errors);
      size += r.size; files += r.files;
    } else if (e.isFile()) {
      let cst;
      try { cst = fs.statSync(path.join(abs, e.name)); } catch { continue; }
      out.push({ name: childRel, size: cst.size, kind: 'file', files: 1, mtime: cst.mtimeMs });
      size += cst.size; files++;
    }
  }
  out.push({ name: rel || '.', size, kind: 'dir', files, mtime: st.mtimeMs });
  return { size, files };
}

/**
 * 扫描数据目录，产出内容清单。
 * 只扫一层子项 + 各自的递归汇总，便于 UI 直接列「sessions.json / memory / plugins / logs」。
 * 目录不存在 → 空清单（首次运行），不抛错。
 */
export function scanDataDir(dir: string): DataDirInventory {
  const items: DataDirItem[] = [];
  const errors: string[] = [];
  let exists = false;
  try { exists = fs.statSync(dir).isDirectory(); } catch { exists = false; }
  if (!exists) return { dir, items, totalSize: 0, totalFiles: 0, errors };

  statTree(dir, '', items, errors);
  // 顶层：子项排在根汇总之前；同级按体积降序（大的先看）。
  const top = items.filter((i) => i.name && !i.name.includes('/')).sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const root = items.find((i) => i.name === '.');
  return {
    dir,
    items: [...top, ...(root ? [root] : [])],
    totalSize: root ? root.size : 0,
    totalFiles: root ? root.files : 0,
    errors,
  };
}

/** 人类可读体积（与 UI 展示口径一致，放这里避免各处各写一套）。 */
export function formatBytes(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0 B';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
