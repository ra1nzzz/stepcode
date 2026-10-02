/**
 * 工具执行（file/shell/web/browser/memory/cwd）。
 * 授权门、补偿门、沙箱日志由宿主注入；本模块持有会话 cwd Map。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALLOWED_COMMANDS,
  FILE_READ_RESULT_MAX,
  WEB_FETCH_RESULT_MAX,
  hasShellMetachars,
  type ToolCall,
  type ToolResult,
} from './agent-runtime';
import {
  buildClickExpression,
  buildLinksExpression,
  buildTextExpression,
  buildTypeExpression,
  buildWaitForSelectorExpression,
  clipBrowserText,
  describeBrowserState,
  normalizeBrowserArgs,
  scanScriptRisks,
} from './browser-tools';
import {
  closeBrowser as cdpCloseBrowser,
  evalInPage,
  getBrowserState,
  openBrowser as cdpOpenBrowser,
  screenshotBrowser,
} from './browser-cdp';
import { getService } from './dsh-runtime';
import { buildChildEnv } from './terminal-tools';
import { FILE_READ_MAX_BYTES } from './file-panel';
import { getHostServices, isBlockedHost } from './host-services';
import type { SandboxLogEntry } from './sandbox-log';

export type ToolExecHost = {
  dataDir: () => string;
  getAppPath: (name: 'home' | 'userData' | 'temp') => string | undefined;
  approvalGate: (toolName: string, reason: string, sessionId?: string, target?: string, signal?: AbortSignal) => Promise<string | null>;
  recordSandbox: (input: {
    tool: string;
    kind: SandboxLogEntry['kind'];
    target: string;
    decision: SandboxLogEntry['decision'];
    reason?: string;
    sessionId?: string;
  }) => void;
};

interface MemoryServiceLike {
  record?(domain: string, text: string, meta?: Record<string, unknown>): unknown;
}

let host: ToolExecHost | undefined;

export function initToolExec(deps: ToolExecHost): void {
  host = deps;
}

function requireHost(): ToolExecHost {
  if (!host) throw new Error('initToolExec 未调用');
  return host;
}

function dataDir(): string { return requireHost().dataDir(); }
function getAppPath(name: 'home' | 'userData' | 'temp'): string | undefined {
  return requireHost().getAppPath(name);
}
function approvalGate(toolName: string, reason: string, sessionId?: string, target?: string, signal?: AbortSignal): Promise<string | null> {
  return requireHost().approvalGate(toolName, reason, sessionId, target, signal);
}
function recordSandbox(input: {
  tool: string;
  kind: SandboxLogEntry['kind'];
  target: string;
  decision: SandboxLogEntry['decision'];
  reason?: string;
  sessionId?: string;
}): void {
  requireHost().recordSandbox(input);
}

/**
 * 命令执行的工作目录：必须是**存在**的目录，否则子进程 spawn 直接 ENOENT。
 * 依次尝试 user home → 数据目录 → 当前工作目录 → 系统临时目录。
 */
function resolveShellCwd(): string {
  const candidates: string[] = [];
  const home = getAppPath('home');
  if (home) candidates.push(home);
  try { candidates.push(os.homedir()); } catch { /* ignore */ }
  try { candidates.push(dataDir()); } catch { /* ignore */ }
  candidates.push(process.cwd(), os.tmpdir());
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch { /* 继续尝试下一个 */ }
  }
  return os.tmpdir();
}

// app.getPath 结果缓存：isPathAllowed 是工具执行热路径（每个 file_* 工具一次），
// 历史实现每次调用都跑 3 次 getPath。app 未就绪时拿不到路径，此时不缓存，下次再试。
let cachedAllowedRoots: string[] | null = null;

function allowedRoots(): string[] {
  if (!cachedAllowedRoots) {
    const roots: string[] = [];
    for (const name of ['home', 'userData', 'temp'] as const) {
      const p = getAppPath(name);
      if (p) roots.push(path.resolve(p));
    }
    if (roots.length) cachedAllowedRoots = roots;
  }
  return cachedAllowedRoots ?? [];
}

/**
 * M4：PRD FR-8 沙箱模式在工具执行层真实强制。
 * resolve 失败 / 策略未注入 / 未知模式 → 一律 read-only（fail-safe，不静默放宽）。
 */
function currentSandboxMode(sessionId?: string): 'workspace-write' | 'read-only' {
  try {
    const policy = getHostServices()?.sandboxPolicy;
    const resolved = policy?.resolve?.(sessionId ? { session: { id: sessionId } } : undefined);
    return resolved?.mode === 'workspace-write' ? 'workspace-write' : 'read-only';
  } catch {
    return 'read-only';
  }
}

/** M4：read-only 模式下拒绝的变更类工具（读操作不受影响）。 */
const MUTATING_TOOLS: Record<string, SandboxLogEntry['kind']> = {
  file_write: 'path',
  shell_command: 'command',
  set_cwd: 'path',
  browser_click: 'browser',
  browser_type: 'browser',
  browser_eval: 'browser',
};

/** M4：写/变更类工具的统一模式门（在授权门之前——模式不对就没必要问用户）。 */
function denyIfReadOnly(tool: ToolCall, sessionCtx?: { sessionId?: string }): ToolResult | null {
  const kind = MUTATING_TOOLS[tool.name];
  if (!kind) return null;
  const args = (tool.arguments || {}) as Record<string, unknown>;
  const target = String(args.path || args.command || args.selector || args.expression || args.url || tool.name).slice(0, 200);
  if (!getHostServices()?.sandboxPolicy) {
    recordSandbox({ tool: tool.name, kind, target, decision: 'denied', reason: '沙箱服务已停止', sessionId: sessionCtx?.sessionId });
    return { name: tool.name, result: '', error: '沙箱服务已停止，变更类操作被拒绝' };
  }
  if (currentSandboxMode(sessionCtx?.sessionId) !== 'read-only') return null;
  recordSandbox({ tool: tool.name, kind, target, decision: 'denied', reason: '沙箱为只读模式（read-only）', sessionId: sessionCtx?.sessionId });
  return { name: tool.name, result: '', error: '沙箱为只读模式（read-only），变更类操作被拒绝。本壳没有模式切换入口：模式取自数据目录里的 sandbox.json，设置页能改的只有网络域名白名单。' };
}

/** 安全沙箱：读操作路径白名单（home/userData/temp/数据目录/会话绑定工作区）。
 * M4：移除 process.cwd() 隐式根——以任意目录为启动 cwd 就让它变成可读写根，
 * 等于把安装目录/用户碰巧 cd 进的任何目录拖进沙箱（安全审查 M2）。 */
function isPathAllowed(p: string): boolean {
  const resolved = path.resolve(p);
  // BUG-023：会话工作区（用户在 GUI 里绑定的项目目录）也是白名单根——
  // 否则 cwd 切到 D 盘项目后，file_*/set_cwd 全被沙箱拒绝，「工作区」名存实亡。
  // sessionCwds 只能经 set-session-cwd（用户驱动）写入，Agent 无法借此扩权。
  const roots = [...allowedRoots(), dataDir(), ...sessionCwds.values()];
  return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

/**
 * M4：写操作路径白名单（workspace-write 模式下的 file_write / set_cwd）。
 * 比读白名单更窄：只有会话绑定工作区 + 数据目录 + 临时目录可写——
 * PRD FR-8「文件写入限定白名单目录」；home 仅可读（否则 ~/.ssh、
 * Startup 启动项都在同一个"白名单"里，与授权门叠加也只是双确认而非边界）。
 */
function isWritePathAllowed(p: string): boolean {
  const resolved = path.resolve(p);
  const roots = [...sessionCwds.values(), dataDir(), ...(getAppPath('temp') ? [path.resolve(getAppPath('temp')!)] : [])];
  return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

/** 允许执行的命令白名单（集合形式，O(1) 判定）。 */
const ALLOWED_COMMAND_SET = new Set(ALLOWED_COMMANDS);

// 会话级工作目录：set_cwd 写入，shell/file 操作读取。进程内 Map，重启即失——
// ponytail: 升级路径 = 持久化到 sessions.json 的会话字段。
const sessionCwds = new Map<string, string>();

export function setSessionCwd(sessionId: string, dir: string): void {
  sessionCwds.set(sessionId, dir);
}


export function sessionCwd(sessionId?: string): string {
  const set = sessionId ? sessionCwds.get(sessionId) : undefined;
  return set || resolveShellCwd();
}

// ---------------------------------------------------------------------------
// 浏览器工具（ADR-0011：Electron 自带 CDP，零额外依赖）
// ---------------------------------------------------------------------------
// 安全口径沿用既有工具：
//   - 导航 = 边界外网络访问 → 域名白名单 fail-closed（非白名单直接拒，不再有
//     补偿层自动放行兜底）+ SSRF 防护（同 web_fetch；首跳校验，浏览器内部 302 的
//     逐跳复检是 CDP 侧后续增强）
//   - 点击 / 输入 / 执行脚本 = 真实改变页面（下单、发帖、删数据都可能）→ 授权门（同 file_write）
//   - 每一次判定都进沙箱日志：事后能回答「Agent 在哪个网页上点了什么」
// 浏览器共享用户默认 session（保留登录态）——这是能力的一半，也是为什么写操作必须过门。

/** 浏览器工具在沙箱日志里的判定对象（不记录输入文本，避免把密码写进日志）。 */
function browserTargetOf(name: string, args: Record<string, unknown>): string {
  const st = getBrowserState();
  const where = st.open && st.url ? st.url : '(浏览器未打开)';
  if (name === 'browser_type') return `${where} · 输入到 ${String(args.selector || '').slice(0, 80)}`;
  if (name === 'browser_click') return `${where} · 点击 ${String(args.selector || '').slice(0, 80)}`;
  if (name === 'browser_eval') return `${where} · 执行脚本 ${String(args.expression || '').length} 字符`;
  if (name === 'browser_open') return String(args.url || '').slice(0, 300) || '(空 URL)';
  return where;
}

async function executeBrowserTool(name: string, args: Record<string, unknown>, sessionId?: string, signal?: AbortSignal): Promise<ToolResult> {
  const parsed = normalizeBrowserArgs(name, args);
  if (!parsed.ok) {
    recordSandbox({ tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'error', reason: parsed.error, sessionId });
    return { name, result: '', error: parsed.error };
  }
  const v = parsed.value;
  const fail = (reason: string, decision: 'denied' | 'error' = 'error'): ToolResult => {
    recordSandbox({ tool: name, kind: 'browser', target: browserTargetOf(name, args), decision, reason, sessionId });
    return { name, result: '', error: reason };
  };

  switch (v.name) {
    case 'browser_open': {
      const policy = getHostServices()?.sandboxPolicy;
      if (!policy?.isDomainAllowed) return fail('沙箱服务已停止，外发被拒绝', 'denied');
      const allowed = policy.isDomainAllowed(v.url);
      if (!allowed) {
        // B-3：与 web_fetch 同口径——域名白名单 fail-closed 直接拒绝，
        // 不再走「补偿服务缺失即放行」的外发确认门。
        recordSandbox({ tool: name, kind: 'network', target: v.url, decision: 'denied', reason: '域名不在白名单（fail-closed）', sessionId });
        return fail('域名不在白名单（fail-closed）。请在设置页「沙箱」的网络域名白名单中添加该域名，或显式添加 "*" 放开全部。', 'denied');
      }
      if (isBlockedHost(v.url)) {
        recordSandbox({ tool: name, kind: 'network', target: v.url, decision: 'denied', reason: '目标为内网/回环/链路本地/云元数据地址（SSRF 防护）', sessionId });
        return fail('目标地址为内网/回环/链路本地/云元数据端点，已被 SSRF 防护拒绝', 'denied');
      }
      try {
        const st = await cdpOpenBrowser(v.url, { waitUntil: v.waitUntil, timeoutMs: v.timeoutMs });
        recordSandbox({
          tool: name, kind: 'browser', target: v.url, decision: 'allowed',
          reason: st.title ? `已打开：${st.title}`.slice(0, 200) : '已打开', sessionId,
        });
        return { name, result: describeBrowserState(st) };
      } catch (err) {
        return fail((err as Error).message.slice(0, 500));
      }
    }

    case 'browser_text': {
      if (!getBrowserState().open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const r = await evalInPage(buildTextExpression(v.selector, v.maxChars));
      if (!r.ok) return fail(r.error || '读取页面文本失败');
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: `读取 ${String(r.value || '').length} 字符`, sessionId,
      });
      return { name, result: clipBrowserText(r.value || '', v.maxChars) };
    }

    case 'browser_links': {
      if (!getBrowserState().open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const r = await evalInPage(buildLinksExpression(v.selector, v.limit));
      if (!r.ok) return fail(r.error || '读取链接失败');
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: '列出页面链接', sessionId,
      });
      return { name, result: r.value || '(页面内没有链接)' };
    }

    case 'browser_click': {
      const st = getBrowserState();
      if (!st.open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const denied = await approvalGate('browser_click', `在网页上点击 ${v.selector}`, sessionId, st.url || '', signal);
      if (denied) return fail(denied, 'denied');
      const wait = await evalInPage(buildWaitForSelectorExpression(v.selector, v.timeoutMs));
      if (!wait.ok) return fail(wait.error || `等待元素 ${v.selector} 超时`);
      const r = await evalInPage(buildClickExpression(v.selector));
      if (!r.ok) return fail(r.error || '点击失败');
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: r.value, sessionId,
      });
      return { name, result: `${r.value}（${v.selector}）` };
    }

    case 'browser_type': {
      const st = getBrowserState();
      if (!st.open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const denied = await approvalGate('browser_type', `在网页输入框填入 ${v.text.length} 个字符`, sessionId, st.url || '', signal);
      if (denied) return fail(denied, 'denied');
      const r = await evalInPage(buildTypeExpression(v.selector, v.text, { clear: v.clear, pressEnter: v.pressEnter }));
      if (!r.ok) return fail(r.error || '填入失败');
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: r.value, sessionId,
      });
      return { name, result: r.value || '已填入' };
    }

    case 'browser_screenshot': {
      const st = getBrowserState();
      if (!st.open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const shot = await screenshotBrowser({ fullPage: v.fullPage, timeoutMs: v.timeoutMs }, dataDir());
      if (!shot.ok) return fail(shot.error || '截图失败');
      recordSandbox({
        tool: name, kind: 'browser', target: shot.path || '(截图)', decision: 'allowed',
        reason: `已保存截图${v.fullPage ? '（整页）' : ''}${shot.via === 'capturePage' ? '（CDP 截图不可用，已回退 capturePage）' : ''}`, sessionId,
      });
      // 回退路径只在视口大小，如实告诉模型，别让它以为拿到了整页
      const tail = shot.via === 'capturePage' ? '（视口截图：CDP 整页/合成截图在本环境不可用）' : '';
      return { name, result: `截图已保存：${shot.path}${tail}` };
    }

    case 'browser_eval': {
      const st = getBrowserState();
      if (!st.open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const risks = scanScriptRisks(v.expression);
      const reason = `执行脚本${risks.length ? `（涉及：${risks.join('、')}）` : ''}：${v.expression.slice(0, 160)}`;
      const denied = await approvalGate('browser_eval', reason, sessionId, st.url || '', signal);
      if (denied) return fail(denied, 'denied');
      const r = await evalInPage(v.expression, v.timeoutMs);
      if (!r.ok) {
        recordSandbox({
          tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'error',
          reason: (r.error || '脚本执行失败').slice(0, 300), sessionId,
        });
        return { name, result: '', error: r.error || '脚本执行失败' };
      }
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: risks.length ? `风险项：${risks.join('、')}` : '页面内求值', sessionId,
      });
      return { name, result: r.value || '(脚本返回空值)' };
    }

    case 'browser_close': {
      const closed = cdpCloseBrowser();
      recordSandbox({
        tool: name, kind: 'browser', target: '(关闭浏览器)', decision: 'allowed',
        reason: closed ? '浏览器窗口已关闭' : '浏览器本来就没打开', sessionId,
      });
      return { name, result: closed ? '浏览器已关闭（登录态保留）' : '浏览器未打开，无需关闭' };
    }

    default:
      return fail(`未接线的浏览器工具：${name}`);
  }
}

export async function executeTool(tool: ToolCall, sessionCtx?: { sessionId?: string; signal?: AbortSignal }): Promise<ToolResult> {
  const { name, arguments: args } = tool;
  const cwd = sessionCwd(sessionCtx?.sessionId);
  try {
    // M4：变更类工具先过沙箱模式门（read-only 直接拒，不打扰授权门）。
    const modeDenied = denyIfReadOnly(tool, sessionCtx);
    if (modeDenied) return modeDenied;
    switch (name) {
      case 'file_read': {
        const filePath = path.resolve(cwd, String(args.path || ''));
        const sid = sessionCtx?.sessionId;
        if (!isPathAllowed(filePath)) {
          recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'denied', reason: '路径不在允许范围内', sessionId: sid });
          return { name, result: '', error: '路径不在允许范围内' };
        }
        // 防御超大文件：工具承诺最大回传 50KB，但整读不入上限文件会阻塞主进程并吃内存尖峰。
        // 先 stat 拿尺寸，超上限直接拒绝（不整读），与渲染层 file 面板的 2MB 读取上限呼应。
        let size = -1;
        try {
          size = fs.statSync(filePath).size;
        } catch (err) {
          recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'error', reason: `stat 失败：${(err as Error).message}`, sessionId: sid });
          return { name, result: '', error: `无法读取文件：${(err as Error).message}` };
        }
        // ④H-1：读取上限单源化 —— 与渲染层 file 面板共用 FILE_READ_MAX_BYTES（file-panel.ts:31）。
        // 注意 file_read 工具超限=拒绝，面板 IPC=截断+truncated 标记：仅共享上限值，处理语义各自保留。
        if (size > FILE_READ_MAX_BYTES) {
          recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'denied', reason: `文件 ${size} 字节超过 ${FILE_READ_MAX_BYTES} 读取上限`, sessionId: sid });
          return { name, result: '', error: `文件过大（${size} 字节），超过 2MB 读取上限，请用文件面板或分段读取` };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'allowed', sessionId: sid });
        return { name, result: content.slice(0, FILE_READ_RESULT_MAX) }; // ④M-3：回传上限单源（agent-runtime.ts）
      }
      case 'file_write': {
        const filePath = path.resolve(cwd, String(args.path || ''));
        const content = String(args.content || '');
        const sid = sessionCtx?.sessionId;
        // M4：写路径白名单比读白名单更窄（会话工作区 + 数据目录 + temp）。
        if (!isPathAllowed(filePath) || !isWritePathAllowed(filePath)) {
          recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'denied', reason: '路径不在允许范围内', sessionId: sid });
          return { name, result: '', error: '路径不在允许范围内' };
        }
        // 写文件可覆盖白名单内任意内容 → 同样过授权门（与 shell 同一 helper）
        const denied = await approvalGate('file_write', `写入 ${filePath}`, sessionCtx?.sessionId, filePath);
        if (denied) {
          recordSandbox({ tool: name, kind: 'approval', target: filePath, decision: 'denied', reason: denied, sessionId: sid });
          return { name, result: '', error: denied };
        }
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        recordSandbox({
          tool: name, kind: 'approval', target: filePath, decision: 'allowed',
          reason: `已写入 ${path.basename(filePath)} (${content.length} 字节)`, sessionId: sid,
        });
        return { name, result: `已写入 ${path.basename(filePath)} (${content.length} 字节)` };
      }
      case 'file_list': {
        const dirPath = path.resolve(cwd, String(args.path || '.'));
        const sid = sessionCtx?.sessionId;
        if (!isPathAllowed(dirPath)) {
          recordSandbox({ tool: name, kind: 'path', target: dirPath, decision: 'denied', reason: '路径不在允许范围内', sessionId: sid });
          return { name, result: '', error: '路径不在允许范围内' };
        }
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const items = entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`).join('\n');
        recordSandbox({ tool: name, kind: 'path', target: dirPath, decision: 'allowed', sessionId: sid });
        return { name, result: items || '(空目录)' };
      }
      case 'shell_command': {
        const cmd = String(args.command || '');
        const cmdName = (cmd.split(/[\s/\\]+/)[0] || '').toLowerCase();
        const sid = sessionCtx?.sessionId;
        if (!cmdName) return { name, result: '', error: '命令为空' };
        // B-2：shell 元字符一律拒绝——`&&`/`|`/`;`/`$()` 等拼接可让「白名单首词 +
        // 任意后随命令」整条执行，是命令白名单被结构绕过的唯一入口。
        if (hasShellMetachars(cmd)) {
          recordSandbox({
            tool: name, kind: 'command', target: cmd, decision: 'denied',
            reason: '命令含 shell 元字符（& | ; < > $ ` 或换行），已拒绝', sessionId: sid,
          });
          return { name, result: '', error: '命令不得包含 & | ; < > $ ` 或换行等 shell 元字符（防命令拼接绕过白名单）。请拆成多条独立命令。' };
        }
        if (!ALLOWED_COMMAND_SET.has(cmdName)) {
          recordSandbox({
            tool: name, kind: 'command', target: cmd, decision: 'denied',
            reason: `命令「${cmdName}」不在白名单中`, sessionId: sid,
          });
          return { name, result: '', error: `命令「${cmdName}」不在白名单中。允许: ${ALLOWED_COMMANDS.slice(0, 20).join(', ')}...` };
        }
        // ---- 授权门（PRD L3/L4 / T-P3-2）：命令执行必须过审批 ----
        // 白名单只挡「明显无害」命令；真正的安全边界是此授权门 + 沙箱日志。
        const denied = await approvalGate('shell_command', cmd, sessionCtx?.sessionId, cmd, sessionCtx?.signal);
        if (denied) {
          recordSandbox({ tool: name, kind: 'approval', target: cmd, decision: 'denied', reason: denied, sessionId: sid });
          return { name, result: '', error: denied };
        }
        // 补偿层的「第二道确认」不接回：SPEC 删除清单写着 compensation 不作为第二套审批，
        // dsh 卸下后该服务恒为 null。命令的真实关卡是上面的 approvalGate + 锁定包两档裁决。
        // 进程隔离 + 不阻塞主进程：在子进程中异步执行。
        // cwd 用会话工作目录（set_cwd 可切换），缺省回落 resolveShellCwd()。
        const { exec } = await import('node:child_process');
        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = exec(cmd, {
              // BUG-050：这里以前不传 env，node 的 exec 于是把宿主 env 整份交给子进程——
              // 而这正是三个出口里最常被走到的一条：Agent 每跑一条白名单命令、每过一次审批命令都算。
              // 后果与 BUG-049 同源：命令能读到自己不该知道的 ORCHDESK_DATA_DIR / ORCHDESK_HOME，
              // 也就是能定位那个放着 sandbox.json、凭据与会话历史的目录。
              env: buildChildEnv(),
              cwd,
              encoding: 'utf-8',
              timeout: 30_000,
              maxBuffer: 8 * 1024 * 1024,
              windowsHide: true,
            }, (err, stdout, stderr) => {
              if (err) {
                // 超时被杀也要把已产出的输出交回，便于诊断
                const partial = `${stdout || ''}${stderr ? '\n[stderr]\n' + stderr : ''}`;
                reject(new Error(`${(err as Error).message}${partial ? '：' + partial.slice(0, 500) : ''}`));
                return;
              }
              resolve(`${stdout || ''}${stderr ? '\n[stderr]\n' + stderr : ''}`);
            });
            child.on('error', reject);
            // M-8：回合中止时 kill 子进程——否则「已停止」后 shell 写盘/外发照常完成。
            const onAbort = () => { try { child.kill(); } catch { /* 可能已退出 */ } reject(new Error('已中止（回合被用户停止）')); };
            if (sessionCtx?.signal) {
              if (sessionCtx.signal.aborted) onAbort();
              else sessionCtx.signal.addEventListener('abort', onAbort, { once: true });
            }
          });
          recordSandbox({ tool: name, kind: 'approval', target: cmd, decision: 'allowed', sessionId: sid });
          return { name, result: output.slice(0, 50000) };
        } catch (err) {
          recordSandbox({
            tool: name, kind: 'command', target: cmd, decision: 'error',
            reason: (err as Error).message, sessionId: sid,
          });
          return { name, result: '', error: (err as Error).message.slice(0, 2000) };
        }
      }
      case 'web_fetch': {
        const url = String(args.url || '');
        const sid = sessionCtx?.sessionId;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          recordSandbox({ tool: name, kind: 'network', target: url, decision: 'denied', reason: 'URL 必须以 http(s) 开头', sessionId: sid });
          return { name, result: '', error: 'URL 必须以 http(s) 开头' };
        }
        // B-3：域名白名单 fail-closed——非白名单直接拒绝，不再走「会自动放行的外发确认」。
        // 历史实现把未命中域名转 outboundGate（补偿服务缺失即 WARN 放行），使设置页里的
        // 「网络域名白名单」从不真正阻断（安全审查 B-2 / 架构 M1）。
        const policy = getHostServices()?.sandboxPolicy;
        if (!policy?.isDomainAllowed) {
          recordSandbox({ tool: name, kind: 'network', target: url, decision: 'denied', reason: '沙箱服务已停止', sessionId: sid });
          return { name, result: '', error: '沙箱服务已停止，外发被拒绝' };
        }
        const domainAllowed = policy.isDomainAllowed(url);
        if (!domainAllowed) {
          recordSandbox({ tool: name, kind: 'network', target: url, decision: 'denied', reason: '域名不在白名单（fail-closed）', sessionId: sid });
          return { name, result: '', error: '域名不在白名单（fail-closed，不再自动放行外发）。请在设置页「沙箱」的网络域名白名单中添加该域名，或显式添加 "*" 放开全部。' };
        }
        // SSRF：白名单命中也不能打内网/元数据端点（与白名单独立，B-2）。
        if (isBlockedHost(url)) {
          recordSandbox({ tool: name, kind: 'network', target: url, decision: 'denied', reason: '目标为内网/回环/链路本地/云元数据地址（SSRF 防护）', sessionId: sid });
          return { name, result: '', error: '目标地址为内网/回环/链路本地/云元数据端点，已被 SSRF 防护拒绝' };
        }
        // current 提升到 try 外：catch 的沙箱日志要记「实际请求到哪个落点」。
        let current = url;
        try {
          // 手动跟随重定向：每一跳都重新过域名白名单 + SSRF 判定，
          // 防止 302 跳到白名单外地址或内网元数据端点。
          const MAX_REDIRECTS = 5;
          let res: Response | null = null;
          let hops = 0;
          for (;;) {
            res = await fetch(current, {
              redirect: 'manual',
              signal: sessionCtx?.signal
                ? AbortSignal.any([sessionCtx.signal, AbortSignal.timeout(15000)])
                : AbortSignal.timeout(15000),
            });
            if (![301, 302, 303, 307, 308].includes(res.status)) break;
            // 3xx response body 不消费会拖住连接（undici 到 GC 才释放）——cancel 后继续。
            void res.body?.cancel().catch(() => { /* body 可能已空 */ });
            const loc = res.headers.get('location');
            if (!loc) break;
            if (hops >= MAX_REDIRECTS) {
              recordSandbox({ tool: name, kind: 'network', target: current, decision: 'denied', reason: `重定向次数超过上限（${MAX_REDIRECTS}）`, sessionId: sid });
              return { name, result: '', error: `重定向次数超过上限（${MAX_REDIRECTS}），已中止（防重定向环）` };
            }
            hops++;
            const next = new URL(loc, current).toString();
            if (!policy?.isDomainAllowed || !policy.isDomainAllowed(next)) {
              recordSandbox({ tool: name, kind: 'network', target: next, decision: 'denied', reason: '重定向目标不在白名单（fail-closed）', sessionId: sid });
              return { name, result: '', error: `重定向目标域名不在白名单：${next}` };
            }
            if (isBlockedHost(next)) {
              recordSandbox({ tool: name, kind: 'network', target: next, decision: 'denied', reason: '重定向目标为内网/元数据地址（SSRF 防护）', sessionId: sid });
              return { name, result: '', error: '重定向目标为内网/回环/链路本地/云元数据端点，已被 SSRF 防护拒绝' };
            }
            current = next;
          }
          if (!res) throw new Error('请求未能建立');
          if ([301, 302, 303, 307, 308].includes(res.status)) {
            // 跳数内拿到 3xx 但无 location：视同不可跟随，显式报错而非把 3xx 空 body 当结果。
            recordSandbox({ tool: name, kind: 'network', target: current, decision: 'error', reason: '重定向响应无 location', sessionId: sid });
            void res.body?.cancel().catch(() => { /* body 可能已空 */ });
            return { name, result: '', error: `服务器返回 ${res.status} 但无 location 头，无法跟随` };
          }
          // 响应体积护栏：承诺只回传 WEB_FETCH_RESULT_MAX（30KB），但不能因此整读超大响应进内存（防 OOM / 主进程阻塞）。
          // content-length 预检 + 流式读满上限即停，两重保险。
          const MAX_FETCH_BYTES = 1 * 1024 * 1024;
          const declared = Number(res.headers.get('content-length') || '0');
          if (declared > MAX_FETCH_BYTES) {
            recordSandbox({ tool: name, kind: 'network', target: current, decision: 'denied', reason: `响应声明 ${declared} 字节超 ${MAX_FETCH_BYTES} 上限`, sessionId: sid });
            void res.body?.cancel().catch(() => { /* body 可能已空 */ });
            return { name, result: '', error: `响应过大（${declared} 字节），超过读取上限` };
          }
          if (!res.body) {
            const buf = Buffer.from(await res.arrayBuffer());
            recordSandbox({ tool: name, kind: 'network', target: current, decision: 'allowed', sessionId: sid });
            return { name, result: buf.toString('utf-8').slice(0, WEB_FETCH_RESULT_MAX) };
          }
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of res.body) {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += b.length;
            if (total > MAX_FETCH_BYTES) break; // 超上限即截停，不整读
            chunks.push(b);
          }
          // 沙箱日志记最终落点（重定向后的真实域名），而非原始 URL。
          recordSandbox({ tool: name, kind: 'network', target: current, decision: 'allowed', sessionId: sid });
          return { name, result: Buffer.concat(chunks).toString('utf-8').slice(0, WEB_FETCH_RESULT_MAX) };
        } catch (err) {
          recordSandbox({ tool: name, kind: 'network', target: current, decision: 'error', reason: (err as Error).message, sessionId: sid });
          return { name, result: '', error: (err as Error).message.slice(0, 2000) };
        }
      }
      // ---- 浏览器（CDP）工具：导航 / 读页面 / 点击 / 输入 / 截图 / 求值 / 关闭 ----
      case 'browser_open':
      case 'browser_text':
      case 'browser_links':
      case 'browser_click':
      case 'browser_type':
      case 'browser_screenshot':
      case 'browser_eval':
      case 'browser_close':
        return await executeBrowserTool(name, args, sessionCtx?.sessionId, sessionCtx?.signal);
      case 'memory_save': {
        // dsh memory 服务（global 域）落地——「记住 X」从口头应答变成真实持久化
        const content = String(args.content || '').trim();
        if (!content) return { name, result: '', error: '内容为空' };
        const svc = getService<MemoryServiceLike>('memory');
        if (!svc?.record) return { name, result: '', error: '记忆服务未就绪（运行时未启动）' };
        svc.record('global', content, { origin: 'agent:memory_save' });
        return { name, result: `已记住：${content.slice(0, 100)}` };
      }
      case 'set_cwd': {
        const resolved = path.resolve(String(args.path || ''));
        const sid = sessionCtx?.sessionId;
        if (!isPathAllowed(resolved) || !isWritePathAllowed(resolved)) {
          recordSandbox({ tool: name, kind: 'path', target: resolved, decision: 'denied', reason: '路径不在允许范围内', sessionId: sid });
          return { name, result: '', error: '路径不在允许范围内' };
        }
        let isDir = false;
        try { isDir = fs.statSync(resolved).isDirectory(); } catch { /* not exist */ }
        if (!isDir) return { name, result: '', error: `目录不存在：${resolved}` };
        if (sessionCtx?.sessionId) sessionCwds.set(sessionCtx.sessionId, resolved);
        recordSandbox({ tool: name, kind: 'path', target: resolved, decision: 'allowed', sessionId: sid });
        return { name, result: `工作目录已切换：${resolved}` };
      }
      default:
        return { name, result: '', error: `未知工具: ${name}` };
    }
  } catch (err) {
    // 执行期异常也是要可追溯的事实（file_read 读不存在的文件、磁盘满、权限被拒…）。
    // 此前这类错误直接返回，沙箱日志里一条都没有，事后查不到「Agent 到底碰了什么」。
    const message = (err as Error).message;
    recordSandbox({
      tool: name,
      kind: sandboxKindOf(name),
      target: sandboxTargetOf(name, args, cwd),
      decision: 'error',
      reason: message,
      sessionId: sessionCtx?.sessionId,
    });
    return { name, result: '', error: message };
  }
}

/** 工具 → 判定类型（异常路径没有显式 kind，按工具归类以便检索）。 */
function sandboxKindOf(toolName: string): SandboxLogEntry['kind'] {
  if (toolName === 'shell_command') return 'command';
  if (toolName === 'web_fetch') return 'network';
  if (toolName.startsWith('browser_')) return 'browser';
  return 'path';
}

/** 工具 → 判定对象（取最能说明「碰了什么」的那一个入参）。 */
function sandboxTargetOf(toolName: string, args: Record<string, unknown> | undefined, cwd: string): string {
  const a = args || {};
  const raw = toolName === 'shell_command' ? a.command
    : toolName === 'web_fetch' ? a.url
      : (a.path ?? a.content);
  if (raw === undefined || raw === null || raw === '') return cwd;
  const s = String(raw);
  // 相对路径解析成绝对路径再记，否则检索「D:/x/y.txt」永远命中不了。
  if (/^[a-zA-Z]:[\\/]|^\//.test(s)) return s;
  try { return path.resolve(cwd, s); } catch { return s; }
}


