/// <reference types="electron" />
import { app, BrowserWindow, ipcMain, safeStorage, shell, globalShortcut } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  SHORTCUT_LABEL,
  loadDesktopConfig,
} from './desktop-integration';
import * as bootDesktop from './boot-desktop';
import {
  aggregateUsage,
  defaultUsageFile,
  readUsageFile,
  writeUsageFile,
  type UsageEntry,
  type UsageFile,
} from './usage-registry';
import {
  appendEvents,
  collectLabeled,
  eventFileFor,
  hasIncompleteAncestry,
  readEvents,
  rebuildContext,
  sanitizeSessionId,
  timelineFromLabeled,
  type SessionEvent,
} from './session-events';
import { stopRuntime, getService, DSH_UNLOAD_REASON } from './dsh-runtime';
import { nextApprovalId, pendingApprovals, registerAuthzIpc, type AuthzServiceLike, type GrantRuleLike } from './ipc-authz';
import { registerMemoryIpc, loadPromotionLog, type MemoryServiceLike } from './ipc-memory';

import { registerPromptIpc } from './ipc-prompt';
import { registerPluginCapabilityIpc } from './ipc-plugins';
import { APPROVAL_TIMEOUT_MS, getHostServices } from './host-services';
import { connectStepExtension, createGuiStepConfirm, currentStepExtension, listGuiPermissionModes, resolveStepCheckout, selectGuiPreset } from './step-extension';
import { prepareOfficialRuntime } from './step-follow';
import { withTimeout } from './memory-summarize';
import { encryptSecret, decryptSecret, isV1Cipher } from './credentials';
import { initLogger, mirrorConsole, log, logFilePath } from './logger';
import {
  DATA_DIR_NAMES,
  DATA_FILE_NAMES,
  candidateLegacyDirs,
  mergeProvidersData,
  mergeSessionsData,
  sanitizeIncomingProject,
  migrateDataDirs,
  migrateDataFiles,
  formatBytes,

  resolveDataDir,
  scanDataDir,
  setDataDirResolver,
  type MigrateFileSpec,
} from './data-dir';
import {
  TOOL_DEFS,
  type ApiMessage,
  type ModelReply,
  type NativeToolCall,
  type ToolCall,
  type ToolResult,
  MAX_TOOL_ITERATIONS_CAP,
  MAX_TOOL_ITERATIONS_DEFAULT,
  DEFAULT_MODEL,

} from './agent-runtime';
import { isAbsoluteLike, isProviderBaseUrlAllowed } from './common-tools';
import { callModel as callModelHttp, initModelClient } from './model-client';
import { initModelCatalog, refreshCatalogInBackground, getCatalogPresets, listAvailableModels } from './model-catalog';
import { abortStepSession, hasActiveStepTurn, resetStepSessionCache, runStepSessionTurn, type StepSessionHost, type StepUiContext } from './step-session';
import { abortCliTurn, cliCoreDisabled, findOfficialCli, hasActiveCliTurn, runCliCoreTurn } from './cli-process';
import { executeTool, initToolExec, sessionCwd, setSessionCwd } from './tool-exec';
import { registerBrowserIpc } from './ipc-browser';
import { preloadTerminalPty, registerTerminalIpc } from './ipc-terminal';
import { closeAllTerminals } from './terminal-pty';
import { destroyBrowserWindow } from './browser-cdp';
import { registerFilePanelIpc } from './ipc-file-panel';
import { connectorsFilePath, initConnectors, loadConnectors, registerConnectorIpc } from './ipc-connectors';
import { initMcp, loadMcp, mcpFilePath, registerMcpIpc } from './ipc-mcp';
import { hydrateMarketEnabled, initMarket, registerMarketIpc } from './ipc-market';
import { flushSandboxLog, initSandbox, loadSandboxLog, noteAuthMode, recordSandbox, registerSandboxIpc, sandboxLogFile } from './ipc-sandbox';
import { mergeStores } from './session-merge';
import { registerGuanjiIpc } from './ipc-guanji';
import { registerHubIpc } from './ipc-hub';
import { registerDataOpsIpc, checkForUpdates } from './ipc-data-ops';
import { registerDesktopIpc } from './ipc-desktop';
// ============================================================================
// OrchDesk 桌面壳主进程（P1）
// ----------------------------------------------------------------------------
// 桥接契约（渲染进程经 contextBridge 调用，红线：nodeIntegration:false）：
//   orchdesk:load-sessions()             启动时拉取持久化会话（空 = 首次运行）
//   orchdesk:persist-sessions(arr)       任意变更后落盘（userData JSON，可重启回放）
//   orchdesk:run-agent-turn(id,text,opt) 用户回合 seam：由 Step 会话执行（step-session.ts）
//
// 设计：渲染进程持有 UI 会话状态；主进程负责「持久化」与「会话执行」两层。
// T5 起 run-agent-turn 走锁定点的 AgentSession（createStepAgentSession），会话
// 经 DefaultResourceLoader 挂上本 GUI 已组合的 Step 扩展：工具裁决、两档权限、
// 危险命令确认都在锁定点侧，本 GUI 只提供确认弹窗。dsh 已卸下。
// ============================================================================

const isDev = !app.isPackaged;
bootDesktop.initBootDesktop({
  log: (level, scope, msg) => log(level === 'ERROR' || level === 'WARN' ? level : 'INFO', scope, msg),
  // 更新检查实现已移至 ipc-data-ops（deps 注入式）；这里包一层补足依赖。
  checkForUpdates: () => checkForUpdates({ dataDir, logFilePath }),
});
initModelClient({ decryptKey });
// models.dev 目录缓存落 userData/cache（live 优先拉取失败时的回退源 + 预设下拉数据）。
// 启动即后台刷新一次：失败静默（缓存/TTL 内下次再说），不阻塞窗口。
initModelCatalog({ cacheDir: path.join(app.getPath('userData'), 'cache') });
refreshCatalogInBackground();

// ---------------------------------------------------------------------------
// IPC sender 校验（遗留项①，纵深防御）：全仓唯一带 preload 的窗口是 mainWindow
// （悬浮窗 floatingWindow 与浏览器窗 browser-cdp 均无 preload → 无 ipcRenderer，
// 发不出 invoke）。故唯一可信 IPC 调用方 = mainWindow.webContents。
//
// fail-closed 语义：
//   - event.sender 为 null/undefined → 放行。这是进程内直调（verify 套件 stub
//     dist/main.js 后以 (null, args) 直调 handler、以及任何无 IPC 上下文的调用），
//     不是来自某个 webContents 的真实 IPC，无渲染层威胁面。
//   - event.sender 是真实 webContents → 必须 === mainWindow.webContents，否则拒绝。
//     当前不存在第二可信窗；未来若加带 preload 的合法窗，在此白名单追加。
//
// 实现：顶层 patch ipcMain.handle 一次。因 92 个 handler 全经 ipcMain.handle 注册
// （模块顶层 + bootRuntime 内），此 patch 在首个注册（orchdesk:tool-execute）之前
// 生效即全覆盖，无需逐个改动。拒绝一律抛错（fail-closed，不静默回假数据）。
// ---------------------------------------------------------------------------
function isTrustedIpcSender(sender: unknown): boolean {
  // R4-6：项目规则禁用 ==/!=（null 合并判断也列外），空值两种形态显式并列。
  if (sender === null || sender === undefined) return true; // 进程内直调（测试后门等），非真实 webContents
  try {
    return !!(bootDesktop.mainWindow && !bootDesktop.mainWindow.isDestroyed() && sender === bootDesktop.mainWindow.webContents);
  } catch { return false; }
}
// 可被 verify 套件断言（不导出默认走 tsc 无害；仅供测试观测校验决策）
const _ipcHandleOrig = ipcMain.handle.bind(ipcMain);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(ipcMain as any).handle = (channel: string, listener: (event: any, ...args: any[]) => any): void => {
  _ipcHandleOrig(channel, async (event: any, ...args: any[]): Promise<any> => {
    if (!isTrustedIpcSender(event && event.sender)) {
      console.warn(`[orchdesk] 拒绝不可信 IPC sender 调用 ${channel}（仅主窗可信）`);
      throw new Error(`ipc:untrusted-sender:${channel}`);
    }
    return listener(event, ...args);
  });
};

// ---------------------------------------------------------------------------
// 会话持久化（本地 JSON，作为 SessionEvent 日志的落盘形态；可重启回放）
// ---------------------------------------------------------------------------
let store: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// BUG-013：数据目录统一 + 历史数据迁移
// ----------------------------------------------------------------------------
// userData 的取值随安装形态漂移（dev / portable / NSIS 各不相同），导致重装后
// 会话与模型配置「凭空消失」。这里改为解析一个**与安装形态无关的规范化目录**：
//
//   1) ORCHDESK_HOME 环境变量（最高优先级，便于调试与多实例隔离）
//   2) 便携模式：exe 同目录存在 orchdesk-data/ 或 PORTABLE 标记 → 数据随 exe 走
//   3) 其余（含 NSIS 安装、portable 首次运行、dev）→ %APPDATA%/OrchDesk
//
// 由于 NSIS 的 userData 本身就是 %APPDATA%\OrchDesk，第 3 条让 **portable 与
// NSIS 天然共用同一目录**，重装 / 换安装包类型不再丢数据。
// 启动时会从所有历史候选路径迁移：会话/模型配置按 key 合并，凭据类文件与
// skills 目录「目标侧缺失才搬运」（只在乎不丢，绝不覆盖目标侧已有数据）。
// 目录解析与迁移逻辑全在 data-dir.ts（纯逻辑、无 electron 依赖、可单测）。
// ---------------------------------------------------------------------------

const DATA_FILES: MigrateFileSpec[] = [
  { name: DATA_FILE_NAMES.sessions, mode: 'merge-json', merge: mergeSessionsData },
  { name: DATA_FILE_NAMES.models, mode: 'merge-json', merge: mergeProvidersData },
  // 凭据类：整份搬运，禁止深合并——合并会破坏 safeStorage 密文结构。
  { name: DATA_FILE_NAMES.guanji, mode: 'copy-if-absent' },
  { name: DATA_FILE_NAMES.hub, mode: 'copy-if-absent' },
  // 沙箱日志：换数据目录后要能接着追溯历史判定，故随目录迁移。
  { name: DATA_FILE_NAMES.sandboxLog, mode: 'copy-if-absent' },
  // 晋升审计：同上。「谁把 Worker 的结论升进了长期记忆」是安全追溯链，不能因换目录断档。
  { name: DATA_FILE_NAMES.promotions, mode: 'copy-if-absent' },
  // 连接器注册表：密文是**机器派生密钥**加密的（见 credentials.ts），跨机器迁移后
  // 解不开。这里仍随目录迁移，是为了保住「哪些连接器配过、上次探测结论」的追溯链；
  // 解不开的凭证会表现为「未配置」，UI 会明确提示重新录入，不会静默当一个能用的连接。
  { name: DATA_FILE_NAMES.connectors, mode: 'copy-if-absent' },
  // FR-5 用量追踪：真实记账不因换目录断档（0 记录也是历史事实）。
  { name: DATA_FILE_NAMES.usage, mode: 'copy-if-absent' },
  // MCP 配置：env 密文同连接器（机器派生密钥），跨机器解不开表现为「连接失败」。
  { name: DATA_FILE_NAMES.mcp, mode: 'copy-if-absent' },
];
const DATA_DIRS = [DATA_DIR_NAMES.skills];

/** 读取 electron 路径；app 未就绪时返回 undefined（不影响候选目录枚举）。 */
function safeGetPath(name: Parameters<typeof app.getPath>[0]): string | undefined {
  try { return app.getPath(name); } catch { return undefined; }
}

/** exe 所在目录（便携模式判定用）。 */
function safeExeDir(): string | undefined {
  try { return path.dirname(app.getPath('exe')); } catch { return undefined; }
}

let resolvedDataDir: string | null = null;

function dataDir(): string {
  if (resolvedDataDir) return resolvedDataDir;
  const userData = safeGetPath('userData');
  const dir = resolveDataDir({
    envHome: process.env.ORCHDESK_HOME,
    isPackaged: app.isPackaged,
    exeDir: safeExeDir(),
    appData: safeGetPath('appData'),
    userData,
    // 必须显式注入：缺省是 () => false，会让便携模式探测恒失败而永远落 %APPDATA%。
    existsSync: (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    },
    canUse: (d) => {
      try {
        fs.mkdirSync(d, { recursive: true });
        return true;
      } catch (err) {
        // 兜底目录（userData）即使创建失败也照原样返回，交由上层报错。
        if (userData && d === userData) return true;
        console.error('[orchdesk] 数据目录不可用，回退 userData:', (err as Error).message);
        return false;
      }
    },
  });
  resolvedDataDir = dir;
  console.log(`[orchdesk] 数据目录: ${dir}`);
  return dir;
}

// guanji / hub 与主进程共用同一目录：由 data-dir 模块转发（惰性闭包，app 就绪
// 后才真正解析），避免它们反向 import main 造成循环依赖。
setDataDirResolver(() => dataDir());

/** 所有历史可能的数据目录（用于迁移）。 */
function legacyDataDirs(): string[] {
  return candidateLegacyDirs({
    userData: safeGetPath('userData'),
    appData: safeGetPath('appData'),
    isPackaged: app.isPackaged,
    exeDir: safeExeDir(),
    moduleDir: __dirname,
    // 排除目标目录本身：候选里可能含同址路径（大小写/尾分隔符不同），自我迁移无意义。
    exclude: [dataDir()],
  });
}

/**
 * 启动迁移：从所有历史候选目录合并数据到规范化目录。
 * 只「补齐」不「覆盖」——目标侧已存在的数据永远优先。
 */
function migrateLegacyData(): void {
  const target = dataDir();
  const sources = legacyDataDirs();
  for (const r of migrateDataFiles({ targetDir: target, sourceDirs: sources, files: DATA_FILES })) {
    if (r.moved) console.log(`[orchdesk] 迁移 ${r.file}（${r.added} 项）：${r.from}`);
  }
  for (const r of migrateDataDirs({ targetDir: target, sourceDirs: sources, dirs: DATA_DIRS })) {
    if (r.moved) console.log(`[orchdesk] 迁移目录 ${r.dir}（${r.copied} 个文件）：${r.from}`);
  }
}

function sessionsFile(): string {
  // 惰性获取：app.getPath 需在 app ready 之后才稳定可用。
  return path.join(dataDir(), DATA_FILE_NAMES.sessions);
}

function projectsFile(): string {
  return path.join(dataDir(), 'orchdesk-projects.json');
}

/** 项目分组（侧栏层级）持久化；此前缺失导致重启后项目全丢。 */
function loadProjects(): Array<Record<string, unknown>> {
  try {
    const file = projectsFile();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    console.error('[orchdesk] 读取项目分组失败:', (err as Error).message);
    return [];
  }
}

function saveProjects(projects: Array<Record<string, unknown>>): void {
  try {
    fs.writeFileSync(projectsFile(), JSON.stringify(projects), 'utf-8');
  } catch (err) {
    console.error('[orchdesk] 写入项目分组失败:', (err as Error).message);
  }
}

function loadStore(): void {
  try {
    const file = sessionsFile();
    if (fs.existsSync(file)) {
      store = JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err) {
    console.error('[orchdesk] 读取会话存档失败，使用空存储:', (err as Error).message);
    store = {};
  }
}
function saveStore(): void {
  try {
    fs.writeFileSync(sessionsFile(), JSON.stringify(store), 'utf-8');
  } catch (err) {
    console.error('[orchdesk] 写入会话存档失败:', (err as Error).message);
  }
}

// ===========================================================================
// FR-5 模型管理：配置持久化 + 真实模型调用
// ===========================================================================

interface ModelProvider {
  id: string;
  name: string;
  type: 'ollama' | 'openai-compatible';
  apiMode?: 'chat' | 'responses' | 'completions';
  baseUrl: string;
  apiKeyEnc?: string;      // safeStorage 加密后 base64
  apiKey?: string;          // 明文（传输用，保存后丢弃）
  models: string[];
}

interface ModelConfig {
  providers: ModelProvider[];
  defaultProvider?: string;
  defaultModel?: string;
  maxToolIterations?: number;
}

const MODELS_FILE = () => path.join(dataDir(), DATA_FILE_NAMES.models);

/**
 * 「models.json 读坏了」与「用户还没配提供商」是两件事，原实现把两者都返回空表。
 * `orchdesk:models-save` 以 `loadModelConfig()` 的结果为基底再落盘，所以一次损坏
 * （权限、半截写入、手工改坏）会让下一次保存把全部提供商和已存 key 静默丢掉，
 * 而 UI 仍然显示「保存成功」。这个标志把损坏单独拎出来，保存端据此拒绝写。
 */
let modelsFileUnreadable = false;

function loadModelConfig(): ModelConfig {
  modelsFileUnreadable = false;
  let raw: Record<string, unknown>;
  try {
    const file = MODELS_FILE();
    // 三路径默认一致（MAX_TOOL_ITERATIONS_DEFAULT = 200；用户显式配置最多到 500，见 saveModelConfig 钳制）。
    if (!fs.existsSync(file)) return { providers: [], defaultProvider: 'ollama', defaultModel: DEFAULT_MODEL, maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT };
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    // 只有「读不出/解析不了」才置这个标志。写盘的异常必须在下面的作用域之外，
    // 否则一次 rename 失败（Windows 目标被占用、磁盘满）会被当成读坏，
    // 从此永久拒绝保存，而文件本身是好的。
    modelsFileUnreadable = true;
    return { providers: [], defaultProvider: 'ollama', defaultModel: DEFAULT_MODEL, maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT };
  }
  let cfg: ModelConfig = { providers: [], defaultProvider: 'ollama', defaultModel: DEFAULT_MODEL, maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT };
  try {
    let migrated = false;
    const providers = (raw.providers as Array<Record<string, unknown>> | undefined)?.map(p => {
      const { apiKey: _k, ...rest } = p;
      const prov = rest as unknown as ModelProvider;
      // 明文 key（用户手改 models.json 塞入）就地加密迁移为 apiKeyEnc，不再静默丢弃。
      // 注意：任何分支都禁止把明文写进日志。
      if (typeof p.apiKey === 'string' && p.apiKey) {
        const enc = encryptKey(p.apiKey);
        if (enc) { prov.apiKeyEnc = enc; migrated = true; }
      }
      return prov;
    }) || [];
    cfg = {
      providers,
      defaultProvider: (raw.defaultProvider as string | undefined) || 'ollama',
      defaultModel: (raw.defaultModel as string | undefined) || DEFAULT_MODEL,
      // ?? 而非 ||：显式配置 0 不应用默认值吞掉（虽随后被消费端钳到 1）。
      maxToolIterations: (raw.maxToolIterations as number | undefined) ?? MAX_TOOL_ITERATIONS_DEFAULT,
    };
    const hasPlainKey = migrated;
    if (hasPlainKey) saveModelConfig(cfg);
    return cfg;
  } catch (err) {
    // 读与解析已经在上一个 try 里判过；走到这里只能是明文 key 迁移写盘失败。
    // 那不能置 modelsFileUnreadable：文件是好的，永久拒绝保存会把用户锁死。
    log('WARN', 'models', `明文 key 迁移写入失败（本次按内存值继续）：${(err as Error).message}`);
    return cfg;
  }
}

/** 原子替换：先写同目录临时文件再 rename，崩溃/断电不会留下半个 models.json。 */
function saveModelConfig(cfg: ModelConfig): void {
  const file = MODELS_FILE();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    // 写入自身失败也要清：半个文件留在 .tmp 里等于把带 apiKeyEnc 的残片长期摊在数据目录。
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不覆盖真因 */ }
    throw err;
  }
}

/**
 * 加密 API Key。
 * 优先用 PRD 要求的 AES-256-GCM + 机器指纹派生（credentials.ts）；
 * 若该路径失败（极老版本 safeStorage 密文），回落 safeStorage 以保兼容。
 * 无加密后端时**不**写明文，返回空串并告警（PRD NFR：凭据必须加密）。
 */
function encryptKey(key: string): string {
  if (!key) return '';
  try {
    const enc = encryptSecret(key);
    if (enc) return enc;
  } catch (err) {
    console.warn('[orchdesk] AES-256-GCM 加密失败，回落 safeStorage:', (err as Error).message);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('[orchdesk] 无可用加密后端，API Key 未保存（拒绝明文落盘）');
    return '';
  }
  return safeStorage.encryptString(key).toString('base64');
}

/**
 * 解密 API Key。
 * v1 密文走 AES-256-GCM；历史 safeStorage 密文自动兼容，并在下次保存时升级。
 */
function decryptKey(encB64?: string): string {
  if (!encB64) return '';
  // 1) 新格式：AES-256-GCM（机器指纹派生）
  if (isV1Cipher(encB64)) {
    const v = decryptSecret(encB64);
    if (v) return v;
    console.warn('[orchdesk] AES-256-GCM 密文解密失败（可能换过机器），请在设置页重新填写 API Key');
    return '';
  }
  // 2) 历史格式：safeStorage
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(encB64, 'base64')) as unknown as string;
  } catch {
    return '';
  }
}

// ---- 真实模型调用：实现见 model-client.ts（可注入 AbortSignal）----
async function callModel(
  provider: ModelProvider,
  model: string,
  messages: ApiMessage[],
  toolDefs: typeof TOOL_DEFS = [],
  signal?: AbortSignal,
  onDelta?: (chunk: string) => void,
): Promise<ModelReply> {
  return callModelHttp(provider, model, messages, toolDefs, { signal, onDelta });
}

/** 时间戳 helper */
function nowTime(): string { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

// ============================================================================
// OrchDesk 桌面壳主进程（P1–P6）
// ----------------------------------------------------------------------------
// 桥接契约（渲染进程经 contextBridge 调用，红线：nodeIntegration:false）：
//   orchdesk:load-sessions()             启动时拉取持久化会话
//   orchdesk:persist-sessions(arr)       任意变更后落盘
//   orchdesk:run-agent-turn(id,text,opt) 用户回合（工具调用 + Step 会话）
// ============================================================================

// --- 工具执行引擎：见 tool-exec.ts ---

/**
 * 授权门（PRD L3/L4 / T-P3-2）：审批链路不可用一律 fail-closed（与 ADR-0008 intent 的
 * 「基础设施缺失放行」边界不同——走此门的操作兜底不足：命令白名单含万能 shell、
 * file_write 可覆盖白名单内任意文件）。
 * BUG-043：这里原本还挂着一整套授权阶梯（读 authzService.getMode()、paranoid 直接拒、
 * matchGrant 白名单压倒审批）。`authzService` 在 973 行声明后唯一写入是 `= null` 且不导出，
 * 所以 mode 恒等于 'default'、paranoid 分支与白名单命中全不可达，还让每条沙箱日志都被盖上
 * SPEC 判死的字面值 `default`。删掉死阶梯，只留唯一有语义的判断：没有审批服务就拒。
 * @returns null = 放行；字符串 = 拒绝原因。
 */
async function approvalGate(toolName: string, reason: string, sessionId?: string, target?: string, signal?: AbortSignal): Promise<string | null> {
  // 日志里的「当时生效的模式」改记真实 GUI 档（bypass / autopilot）；运行时没起来就记空串，
  // ipc-sandbox 的归一化会把空 mode 整条丢掉——宁可不写，也不写一个恒等的假值。
  noteAuthMode(currentStepExtension()?.preset ?? '');

  const approval = getHostServices()?.approval;
  if (!approval) return '授权审批服务不可用，操作被拒绝（fail-closed）';
  // M-8：signal 下传——回合中止时审批请求一并取消，不等用户应答/超时。
  const outcome = signal?.aborted ? 'cancelled' : await approval.request({ toolName, reason: reason.slice(0, 200), sessionId, target }, signal);
  return outcome === 'allowed-once' ? null : `操作未获批准（${outcome}）`;
}

/**
 * 边界外的补偿门已删除。SPEC 的删除清单写着 compensation「删除。不迁。不作为第二套审批」
 * （[ADR 0005](../../docs/70-决策/0005-进程内嵌入与插件删除.md)），而 dsh 卸下后
 * `getService('compensation')` 恒为 null：这道门每次被调用都只落一行
 * 「补偿层服务未接入，外发预判放行（fail-open）」再返回放行——既不是第二套审批，
 * 又给沙箱日志和运维日志制造「缺一层保护」的误读。真正的两档裁决与危险命令确认
 * 只在 `approvalGate` 和锁定包的 `tool_call` 上，渲染层的发前高风险提示是提示不是审批。
 * `arch-guard` R13 钉住这条不再回来。
 */

// --- Agent Runtime：模型回合 + 工具调用循环 ---

/** 取可下发 IPC 的渲染窗口：mainWindow 优先，回退首个未销毁窗。
 * 桌面集成开启后悬浮窗先建排第 0，但无 preload 不订阅业务事件，不能当推送目标。
 * 全库此前散落 4 份同款三元式（浏览器状态/终端数据/终端退出/工具步骤），统一收口。 */
/**
 * 只有带 preload 的主窗能应答审批。`rendererWindow()` 的兜底是「任意活着的窗」，
 * 那个兜底给通知类通道是有意的（主窗重建后不断流），但用在确认门上会出事：
 * 悬浮窗 / 内置浏览器窗都没有 preload，不订阅 `orchdesk:approval-request`，
 * `hasWindow()` 却为真 → 弹窗发给死窗 → 危险命令要等满 APPROVAL_TIMEOUT_MS（120s）
 * 才被超时兜底拒绝。同一形态的「发给死窗」缺陷本文件 notifyToolStep 已记过一次。
 */
function hasBridgeWindow(): boolean {
  try {
    return !!bootDesktop.mainWindow && !bootDesktop.mainWindow.isDestroyed();
  } catch { return false; }
}

function rendererWindow(): BrowserWindow | null {
  try {
    if (bootDesktop.mainWindow && !bootDesktop.mainWindow.isDestroyed()) return bootDesktop.mainWindow;
    return BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) || null;
  } catch { return null; }
}

function sendToRenderer(channel: string, payload: unknown): void {
  try {
    const w = rendererWindow();
    if (w) w.webContents.send(channel, payload);
  } catch { /* 窗口已关闭 */ }
}

/** 把一次工具执行同步给渲染层（步骤条 + 通知）。 */
function notifyToolStep(sessionId: string, name: string, ph: 'running' | 'done' | 'error', result?: string): void {
  try {
    // BUG（全盘死挂点扫描）：原实现取 BrowserWindow.getAllWindows()[0] —— 桌面集成开启
    // 悬浮窗后，悬浮窗先建排第 0（无 preload、不订阅 tool-step），工具步骤全发向死窗，
    // 渲染层订阅方永远收不到。改走统一 helper rendererWindow()（mainWindow 优先）。
    const w = rendererWindow();
    if (w) w.webContents.send('orchdesk:tool-step', { sessionId, name, ph, result: result || '' });
  } catch { /* 忽略：窗口可能已关闭 */ }
}

/** 模型增量文本（JSON 整包一次；SSE 解析后按 chunk）。 */
function notifyAgentDelta(sessionId: string, text: string): void {
  if (!text) return;
  try {
    const w = rendererWindow();
    if (w) w.webContents.send('orchdesk:agent-delta', { sessionId, text });
  } catch { /* 忽略：窗口可能已关闭 */ }
}

initSandbox({ dataDir });
initToolExec({
  dataDir,
  getAppPath: (name) => safeGetPath(name),
  approvalGate,
  recordSandbox,
});
initConnectors({ dataDir });
initMcp({ dataDir });
initMarket({ dataDir });

// T5：作曲栏发送由 Step 会话执行（见 step-session.ts）。界面上下文全部走本 GUI 的
// confirm：锁定包的权限控制器在 tool_call 上读 ctx.ui.confirm，只有这一个审批入口。
// 其余 UI 方法是主进程里的空操作——本 GUI 的界面就是渲染层，主进程不另画一套。
const stepSessionHost: StepSessionHost = {
  composed: () => currentStepExtension() ?? undefined,
  // 必须把 sessionId 透出去：tool-exec 的 sessionCwd 不带 id 时永远返回全局
  // 默认目录，用户在侧栏会话上绑定的项目目录会被静默忽略。
  sessionCwd: (sessionId?: string) => sessionCwd(sessionId),
  notifyAgentDelta,
  notifyToolStep,
  // BUG-053：Agent 在锁定点内执行的变更 / 命令类工具，结果写进沙箱日志（PRD FR-8）。
  // 与 GUI 确认的审批留痕（guiStepConfirm 的 record）是两条互补记录：那条说「批没批」，
  // 这条说「真跑成了什么」。
  recordToolRun: (entry) => recordSandbox(entry),
  uiContext: () => buildStepUiContext(),
  // GUI 模型页配的提供商 → Step 会话该用的模型。key 在这里用 safeStorage 解好，
  // 明文只交给 step-model-bridge 投影，不进日志。
  modelConfig: () => {
    const cfg = loadModelConfig();
    return {
      providers: cfg.providers.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        apiMode: p.apiMode,
        apiKey: decryptKey(p.apiKeyEnc),
        models: p.models,
      })),
      defaultProvider: cfg.defaultProvider,
      defaultModel: cfg.defaultModel,
    };
  },
  // bootRuntime 已经解析过一次锁定点；这里取缓存值，避免首次发送再同
  // 步跑一遍 git checkout 探测（Electron 主进程同步阻塞整个 UI）。
  root: () => stepCheckoutRoot ?? resolveStepCheckout(),
};

function buildStepUiContext(): StepUiContext {
  return {
    select: async () => undefined,
    // 没有已接上的组合时返回 false，不放行——与没有确认界面同义。
    confirm: async (title, message, opts) => {
      const ask = currentStepExtension()?.confirm;
      if (!ask) return false;
      return ask(title, message, opts as { signal?: AbortSignal });
    },
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: buildStepUiTheme(),
    getAllThemes: () => [],
    getTheme: () => 'default',
    setTheme: () => ({}),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

/** 锁定包的界面上下文会读 ctx.ui.theme.fg(...) 之类；缺字段要到调用点才抛，这里补全。 */
function buildStepUiTheme(): Record<string, (value: string) => string> {
  const color = (value: string) => value;
  return {
    fg: color, bg: color, bold: color, italic: color, dim: color, underline: color,
    inverse: color, strikethrough: color, primary: color, success: color, error: color,
    warning: color, info: color, muted: color, accent: color,
  };
}

// 测试后门（非渲染层桥）：browser-tools-verify / credentials-verify 经此驱动
// executeTool 做接线级断言。渲染层不触达（preload 无对应 invoke），生产仅作
// 单工具执行入口（无会话装配/回放记账）——测试专用，勿接 UI。
ipcMain.handle('orchdesk:tool-execute', async (_e, tool: ToolCall) => {
  const result = await executeTool(tool);
  return result;
});

// ---------------------------------------------------------------------------
// 模型回合（FR-5 真实闭环）
// 当前实现：OpenAI 兼容 API + Ollama 本地模型；配置存储于 userData/models.json，
// API Key 经 safeStorage 加密。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 桥接：渲染进程 → 主进程（持久化 + 模型回合）
// ---------------------------------------------------------------------------
// 渲染层就绪标记：审批弹窗只在渲染层可应答时才发起（见 uiAnswerer）。
// 渲染层 init 的首个 IPC（load-sessions）即视为就绪——在那之前不存在用户输入源。
let rendererReady = false;

/** 存档会话的最小形状：store 的值类型是 unknown，读侧必须窄气（R4-9，不再用 any 绕过）。 */
type StoredSession = { id?: string; msgs?: unknown };
function isStoredSession(s: unknown): s is StoredSession {
  if (!s || typeof s !== 'object') return false;
  const o = s as StoredSession;
  return !!o.id && Array.isArray(o.msgs) && o.msgs.length > 0;
}

ipcMain.handle('orchdesk:load-sessions', async () => {
  rendererReady = true;
  // 只返回有效会话（有真实消息的）；忽略过期数据
  return Object.values(store).filter(isStoredSession);
});

// 插件真实热插拔（FR-3）：启用 = 注册 effect，停用 = 逆回滚，不重启、无残留
ipcMain.handle('orchdesk:plugin-set-enabled', async () => {
  return { ok: false, unavailable: true, reason: DSH_UNLOAD_REASON };
});
ipcMain.handle('orchdesk:persist-sessions', async (_e, sessions: unknown[]) => {
  // 读-改-写竞态修复（复审项⑤）：渲染层快照整表替换会把 step-session 刚写入的
  // assistant 回复抹掉。合并策略见 session-merge.ts：msgs 去重合并（stored 优先），
  // 元数据取 incoming；snapshot 缺失视为删除，但进行中回合的会话不删。
  const { merged, deleted } = mergeStores(store as Record<string, never>, (sessions || []) as never, { isActive: (id) => hasActiveStepTurn(id) || hasActiveCliTurn(id) });
  store = merged;
  if (deleted.length) log('INFO', 'sessions', `渲染层删除会话：${deleted.join(', ')}`);
  saveStore();
  return { ok: true };
});

// ---- FR-6 SessionEvent 事件流桥接（ADR-0009）----
/** 血缘加载器：沿 fork-origin 链读父日志；非法 sid / 缺文件 → 空日志（回放不中断）。 */
function loadEventLog(sid: string): SessionEvent[] {
  const clean = sanitizeSessionId(sid);
  if (!clean) return [];
  try {
    return readEvents(eventFileFor(dataDir(), clean));
  } catch {
    return [];
  }
}

/** 回放数据源：事件流时间线（沿血缘链拼接）；日志为空 → source='legacy'（渲染层回退消息数组重建并显式标注）。 */
ipcMain.handle('orchdesk:session-events', async (_e, sid: string) => {
  try {
    const key = String(sid || '');
    const events = loadEventLog(key);
    if (!events.length) return { ok: true, source: 'legacy', count: 0, timeline: [] };
    // 血缘链上任一祖先日志为空（如 legacy 历史会话先被分叉）→ 事件流缺继承前缀，
    // 整体回落 legacy：消息数组含分叉时拷贝的切片，回放完整——不拿残缺事件流冒充 event-log。
    if (hasIncompleteAncestry(loadEventLog, key)) return { ok: true, source: 'legacy', count: 0, timeline: [] };
    // 一次收集（loadLog 链只走 1 遍），时间线与上下文从同一份派生
    // （审阅修复：此前 buildTimeline 与 collectLineageEvents 各自重读同一批 NDJSON，血缘链被读 3 遍）。
    const labeled = collectLabeled(loadEventLog, key);
    return {
      ok: true,
      source: 'event-log',
      count: events.length,
      timeline: timelineFromLabeled(labeled),
      // 上下文重建走全量血缘链（祖先前缀按 atIndex 截断后拼接），分叉子分支的
      // 模型上下文不依赖消息数组切片（ADR-0009 §4）。
      context: rebuildContext(labeled.map((x) => x.ev)),
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, source: 'legacy', count: 0, timeline: [] };
  }
});

/** 分叉落事件（渲染层 doFork 调用）：子日志只写一条 fork-origin 血缘，不拷贝父事件。 */
ipcMain.handle('orchdesk:fork-event', async (_e, payload: unknown) => {
  const p = (payload || {}) as Record<string, unknown>;
  const newId = sanitizeSessionId(p.newId);
  if (!newId) return { ok: false, reason: '非法的新会话 id' };
  const from = sanitizeSessionId(p.from);
  if (!from) return { ok: false, reason: '非法的源会话 id' };
  const atIndex = Number(p.atIndex);
  if (!Number.isFinite(atIndex) || atIndex < 0) return { ok: false, reason: '分叉点必须是真数字（null 语义由渲染层夹紧）' };
  try {
    const w = appendEvents(eventFileFor(dataDir(), newId), [{
      ts: Number(p.at) || Date.now(),
      kind: 'fork-origin',
      from, fromTitle: String(p.fromTitle || ''), atIndex: Math.floor(atIndex),
    }]);
    if (!w.ok) return { ok: false, reason: w.reason };
    return { ok: true, count: w.written?.length || 0 };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

// ---- FR-5 用量追踪桥接 ----
ipcMain.handle('orchdesk:usage', async () => {
  try {
    const file = readUsageFile(path.join(dataDir(), DATA_FILE_NAMES.usage));
    return { ok: true, ...aggregateUsage(file.entries) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, total: { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 }, byModel: [], bySession: [] };
  }
});
ipcMain.handle('orchdesk:usage-clear', async () => {
  const wr = writeUsageFile(path.join(dataDir(), DATA_FILE_NAMES.usage), defaultUsageFile());
  return wr.ok ? { ok: true } : { ok: false, reason: wr.reason };
});

// 项目分组持久化（BUG：此前只存 sessions，重启后项目全丢、会话退化为「任务」组）
ipcMain.handle('orchdesk:load-projects', async () => loadProjects());
ipcMain.handle('orchdesk:persist-projects', async (_e, projects: unknown[]) => {
  if (!Array.isArray(projects)) return { ok: false, reason: 'projects 必须是数组' };
  saveProjects(projects as Array<Record<string, unknown>>);
  return { ok: true };
});
ipcMain.handle('orchdesk:run-agent-turn', async (_e, sessionId: unknown, text: unknown, opts: unknown) => {
  // R4-3：补运行时入参闸门。同文件的 terminal/mcp/connector/file-panel handler 都有
  // typeof 校验，此处原是例外——text 非字符串时旧实现直接抛
  // TypeError 把整条链路带崩。预载层有 TS 标注，但 IPC 边界不能只靠类型。
  if (typeof sessionId !== 'string' || !sessionId) return { text: '', intent: 'ERROR', error: 'sessionId 不合法' };
  if (typeof text !== 'string' || !text) return { text: '', intent: 'ERROR', error: 'text 不合法（必须是非空字符串）' };
  return runDesktopAgentTurn(sessionId, text);
});
ipcMain.handle('orchdesk:abort-agent-turn', async (_e, sessionId: string) => {
  const id = String(sessionId || '');
  const cliStopped = abortCliTurn(id);
  const inProcess = abortStepSession(id);
  return cliStopped || inProcess;
});

// ---- R5-01：本地版本源（状态栏显示用，不再向上游仓库要 commit） ----
ipcMain.handle('orchdesk:app-version', async () => {
  return { version: typeof app.getVersion === 'function' ? app.getVersion() : '' };
});

// ---- FR-5 模型管理桥接 ----
ipcMain.handle('orchdesk:models-get', async () => {
  const cfg = loadModelConfig();
  // 字段必须与 `orchdesk:models-save` 写进去的对齐。原先只回 id/name/type/baseUrl/models，
  // 而设置页编辑回填读 `p.apiMode || 'chat'`、`p.presetId`，保存又写回这两个字段：
  // 重启后编辑一个 responses 模式的提供商（哪怕只换 key），保存就被静默降级成 chat
  // 并丢掉预设，回合随即报协议/模型错。读写不对称在这条路上是数据丢失，不是显示问题。
  return {
    providers: cfg.providers.map((p) => {
      const extra = p as unknown as { apiMode?: string; presetId?: string };
      return {
        id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, models: p.models,
        apiMode: extra.apiMode, presetId: extra.presetId,
      };
    }),
    defaultProvider: cfg.defaultProvider, defaultModel: cfg.defaultModel, maxToolIterations: cfg.maxToolIterations,
  };
});

ipcMain.handle('orchdesk:models-save', async (_e, config: unknown) => {
  try {
    // R4-3：入参闸门。config 来自渲染层（preload 只标 Record<string, unknown>），
    // 缺 providers / providers 非数组 / 条目非对象时，原实现会把
    // `incoming.providers.map is not a function` 这类内部结构错误直接回给 UI。
    // 先校验再动任何状态（loadModelConfig 可能触发明文 key 迁移落盘）。
    if (!config || typeof config !== 'object') return { ok: false, reason: '模型配置格式不合法（必须是对象）' };
    const incoming = config as ModelConfig;
    if (!Array.isArray(incoming.providers)) return { ok: false, reason: '模型配置格式不合法（providers 必须是数组）' };
    if (incoming.providers.some((p) => !p || typeof p !== 'object')) {
      return { ok: false, reason: '模型配置格式不合法（providers 含非对象条目）' };
    }
    const current = loadModelConfig();
    // 读坏的文件不能当「没配过」：本函数以 current 为基底落盘，否则会静默清空全部提供商与 key。
    if (modelsFileUnreadable) {
      return { ok: false, reason: `模型配置读取失败（${MODELS_FILE()}）。为避免覆盖掉已有配置，本次保存已中止` };
    }
    // 提供商 id 必须非空且唯一。投影端 `toStepModelsJson` 按 id 写对象（后写胜出），
    // 读取端 `find` 取首个（先写胜出），而渲染层用显示名生成 id（纯中文名会折叠成 '--'）。
    // 同 id 的两个提供商因此会让回合把 key 发往另一个 baseUrl，或选中的模型不在写出的文件里。
    // 提供商 id 必须非空。**重复只拦新引入的**：编辑态保留旧 id（渲染层
    // renderer/actions/session.js 用 mpEditing.id），而 id 由显示名生成（纯中文名都折叠成
    // '--'），所以对存量脏数据一律拒绝会把用户钉死——改任何一项设置都存不下，且改名无效。
    const ids = incoming.providers.map((p) => {
      const raw = (p as unknown as Record<string, unknown>).id;
      return typeof raw === 'string' ? raw.trim() : '';
    });
    if (ids.some((id) => !id)) return { ok: false, reason: '模型配置格式不合法（提供商 id 不能为空）' };
    const incomingDup = new Set(ids.filter((id, i) => ids.indexOf(id) !== i));
    const existingIds = current.providers.map((p) => (typeof p.id === 'string' ? p.id.trim() : ''));
    const preExisting = new Set(existingIds.filter((id, i) => existingIds.indexOf(id) !== i));
    const fresh = [...incomingDup].filter((id) => !preExisting.has(id));
    if (fresh.length) {
      return { ok: false, reason: `模型配置格式不合法（新增的提供商 id 重复：${fresh.join('、')}）。显示名相同会撞出同一个 id，请改一个可区分的名字` };
    }
    if (incomingDup.size) {
      // 放行但可见：存量重复仍会让投影端与读取端判给不同提供商，要让用户知道它存在。
      log('WARN', 'models', `保存放行存量重复的提供商 id：${[...incomingDup].join('、')}（投影时后写胜出，请逐个改成可区分的名字）`);
    }
    // BUG-054：baseUrl 决定解密后的 key 发往哪里。放在 id 等形状校验**之后**——
    // 那些是更基础的入参问题，先报它们才不会让一条坏 URL 抢掉更准确的错误。
    for (const p of incoming.providers as unknown as Array<Record<string, unknown>>) {
      const gate = isProviderBaseUrlAllowed(p.baseUrl);
      if (!gate.ok) {
        return { ok: false, reason: `提供商「${String(p.name ?? p.id ?? '?')}」的 baseUrl 被拒绝：${gate.reason}` };
      }
    }
    // 无加密后端时 encryptKey 拒绝写明文并返回 ''。原实现照样回 {ok:true}，
    // 于是 key 被丢掉而 UI 显示「保存成功」。宁可保存失败并说明原因。
    const droppedKey: string[] = [];
    current.providers = incoming.providers.map(p => {
      const existing = current.providers.find(e => e.id === p.id);
      const supplied = (p as unknown as Record<string, unknown>).apiKey as string | undefined;
      let apiKeyEnc = existing?.apiKeyEnc || '';
      if (supplied) {
        apiKeyEnc = encryptKey(supplied);
        if (!apiKeyEnc) droppedKey.push(String(p.id ?? p.name ?? '?'));
      }
      const { apiKey: _k, ...rest } = p as unknown as Record<string, unknown>;
      return { ...rest, apiKeyEnc } as unknown as ModelProvider;
    });
    if (droppedKey.length) {
      return { ok: false, reason: `系统密钥库不可用，API Key 未保存（拒绝明文落盘）：${droppedKey.join('、')}` };
    }
    if (incoming.defaultProvider) current.defaultProvider = incoming.defaultProvider;
    // 默认提供商必须真的存在：删掉正被使用的那一个之后，旧实现会把指向已删 id 的
    // defaultProvider 继续落盘，下一回合去读一个不存在的提供商。兜到第一个可用项并留一行 WARN。
    if (current.providers.length && !current.providers.some((p) => p.id === current.defaultProvider)) {
      const fallback = current.providers[0]?.id;
      if (fallback) {
        log('WARN', 'models', `默认提供商 ${current.defaultProvider} 已不存在，改指 ${fallback}`);
        current.defaultProvider = fallback;
      }
    }
    if (incoming.defaultModel) current.defaultModel = incoming.defaultModel;
    // 与运行时钳制一致（1–500，单源常量 MAX_TOOL_ITERATIONS_CAP），保证所见即所得。
    if (incoming.maxToolIterations) current.maxToolIterations = Math.max(1, Math.min(MAX_TOOL_ITERATIONS_CAP, incoming.maxToolIterations));
    saveModelConfig(current);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

/**
 * 「测试连接」超时上限（R1-6）：callModel 自身最坏等 MODEL_MAX_MS（600s）+ 空闲 300s，
 * 黑洞端点会让设置页的「测试连接」无反馈悬挂约 10 分钟。取 30s：慢端点（冷启动 Ollama /
 * 跨境中转）仍能通过，真挂死的端点不会把人钉在设置页。
 */
const MODEL_TEST_TIMEOUT_MS = 30_000;

ipcMain.handle('orchdesk:models-test', async (_e, providerId: string, model: string) => {
  const cfg = loadModelConfig();
  const provider = cfg.providers.find(p => p.id === providerId);
  if (!provider) return { ok: false, error: '提供商不存在' };
  const t0 = Date.now();
  try {
    // R1-6：包一层超时（与记忆摘要 seam 同手段）。不传 signal——测试连接没有回合上下文，
    // 也没有可 abort 的对象；超时由 Promise.race 兜底。
    await withTimeout(callModel(provider, model, [{ role: 'user', content: 'ping' }]), MODEL_TEST_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // withTimeout 的拒绝信息固定为 `summarize-timeout:<ms>`（memory-summarize 未参数化错误
    // 文案），回给设置页的必须是可读的超时说明，而不是别的模块的内部措辞。
    if (/^summarize-timeout:/.test(msg)) {
      return { ok: false, error: `连接测试超时（${MODEL_TEST_TIMEOUT_MS / 1000} 秒内无响应，请检查 Base URL 与网络）`, latencyMs: Date.now() - t0 };
    }
    return { ok: false, error: msg, latencyMs: Date.now() - t0 };
  }
});

// ---- models.dev 目录预设 + 可用模型拉取（方案 A：live 优先，目录增强/回退） ----
ipcMain.handle('orchdesk:models-catalog', async () => {
  return getCatalogPresets();
});

ipcMain.handle('orchdesk:models-list', async (_e, input: unknown) => {
  const req = (input && typeof input === 'object' ? input : {}) as { type?: unknown; baseUrl?: unknown; apiKey?: unknown; presetId?: unknown };
  if (typeof req.baseUrl !== 'string' || !req.baseUrl.trim()) return { ok: false as const, reason: '缺少 Base URL' };
  return listAvailableModels({
    type: typeof req.type === 'string' && req.type ? req.type : 'openai-compatible',
    baseUrl: req.baseUrl.trim(),
    apiKey: typeof req.apiKey === 'string' && req.apiKey ? req.apiKey : undefined,
    presetId: typeof req.presetId === 'string' && req.presetId ? req.presetId : undefined,
  });
});

// ---- P2 模型内嵌：本机 Ollama 自发现 ----
// composer 模型 chip 的零配置入口：启动时探一次 127.0.0.1:11434，探到就把
// 「发现 Ollama · 一键接入」摆到 chip 上。复用 listAvailableModels（已含
// /api/tags → /v1/models 老版本回退），不另造探测轮子。失败必须带回 reason——
// 渲染层要区分「没装 Ollama」与「探到但拉取失败」，不许把两者都显示成未配置。
ipcMain.handle('orchdesk:ollama-probe', async () => {
  try {
    const r = await listAvailableModels({ type: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    if (r && r.ok) return { ok: true as const, models: (r.models || []).map((m) => m.id) };
    return { ok: false as const, models: [] as string[], reason: (r && r.reason) || '未探测到本机 Ollama' };
  } catch (err) {
    return { ok: false as const, models: [] as string[], reason: (err as Error).message };
  }
});

// ---------------------------------------------------------------------------
// 授权桥（T-P3-2 + BUG-014 接线）：authz 插件由 dsh-runtime 真实装载后，
// 经 ctx.get('authz') 取得 AuthzService。主进程把 GUI 应答回调注入该服务：
// dsh 工具管道在回合内经 approval/request 等待应答 → 推渲染层弹窗 →
// 用户操作后 submitDecision 回传 outcome（fail-closed：超时/异常 → unavailable）。
//
// 关键修复：此前这里传入占位 ctx（{get: () => undefined}），导致 authzService
// 恒为 null，L0–L4 矩阵 / 审计日志 / 审批弹窗 / 模式切换四块 UI 全部空转。
// ---------------------------------------------------------------------------


let authzService: AuthzServiceLike | null = null;

/**
 * bootRuntime 解析出的锁定点根。第一次建会话时顺手记住，后续复用：
 * resolveStepCheckout 会同步跑 git 探测，不能放到用户点击发送的那一帧上。
 */
let stepCheckoutRoot: string | null = null;

/**
 * dsh 已卸下。不启动宿主服务。
 * 产品默认是明确的 bypass，不是锁定包未选择策略时的交互默认。
 */
async function bootRuntime(): Promise<void> {
  log('INFO', 'dsh', DSH_UNLOAD_REASON);
  authzService = null;
  try {
    const prepared = prepareOfficialRuntime();
    if (prepared.root) {
      process.env.ORCHDESK_STEP_RUNTIME = prepared.root;
      log('INFO', 'step', prepared.note);
    } else {
      log('WARN', 'step', prepared.note);
    }
    const wired = await connectStepExtension({
      preset: 'bypass',
      confirm: guiStepConfirm(),
    });
    stepCheckoutRoot = resolveStepCheckout();
    log('INFO', 'step', `进程内组合已接上，预设 ${wired.preset}`);
    const cli = cliCoreDisabled() ? null : findOfficialCli();
    log(cli ? 'INFO' : 'WARN', 'step', cli ? `Agent 核使用官方 CLI ${cli}` : '未找到官方 CLI，回合用包内核');
  } catch (err) {
    log('WARN', 'step', `进程内组合未接上（fail-closed）：${(err as Error).message}`);
  }
}

async function runDesktopAgentTurn(sessionId: string, text: string) {
  // 装了官方 CLI 就用它。失败不偷偷换回包内核，否则更新了 CLI 界面仍在跑旧核。
  if (!cliCoreDisabled() && findOfficialCli()) {
    return runCliCoreTurn(sessionId, text, stepSessionHost);
  }
  return runStepSessionTurn(sessionId, text, stepSessionHost);
}

function guiStepConfirm() {
  return createGuiStepConfirm({
    hasWindow: hasBridgeWindow,
    send: sendToRenderer,
    nextId: nextApprovalId,
    wait: waitForGuiDecision,
    // BUG-053：GUI 确认的批准/拒绝写进沙箱日志（PRD FR-8 的可检索判定必须覆盖 Agent 路径）。
    record: (e) => recordSandbox({
      tool: e.toolName,
      kind: 'approval',
      target: e.reason.slice(0, 200),
      decision: e.decision,
      reason: e.reason,
    }),
  });
}

function waitForGuiDecision(id: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: string) => {
      if (settled) return;
      settled = true;
      const pending = pendingApprovals.get(id);
      if (pending) clearTimeout(pending.timer);
      pendingApprovals.delete(id);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('unavailable'), APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(id, { resolve: finish, timer });
    if (!signal) return;
    if (signal.aborted) finish('cancelled');
    else signal.addEventListener('abort', () => finish('cancelled'), { once: true });
  });
}

// TRACE 插件已删除。状态查询与开关都不读不写 trace.json。
ipcMain.handle('orchdesk:trace-status', () => {
  return { unavailable: true, reason: DSH_UNLOAD_REASON, enabled: false, builtin: false };
});
ipcMain.handle('orchdesk:trace-set-enabled', (_e, enabled: boolean) => {
  return { ok: false, unavailable: true, reason: DSH_UNLOAD_REASON };
});

registerSandboxIpc(ipcMain);

// TRACE 用户反馈（PRD FR-7，第八死挂点修复）：渲染层每条 Agent 消息底部
// 「有帮助 / 需改进」→ 真实写入 trace 遥测队列（source='user'）。
// 此前按钮只改渲染层本地 Set + persist()，反馈从未进入遥测链路。
interface TraceServiceLike {
  recordFeedback(intent: string, feedback: string, sessionKey?: string, messageKey?: string): void;
  // R3-12：disabled = repoUrl 为空（用户关了遥测）。没有它，UI 分不清「队列空」
  // 与「已关闭」——前者是健康，后者是配置态，显示成同一件事就是撒谎。
  queueSize(): { pending: number; retry: number; errors: number; disabled?: boolean };
}
ipcMain.handle(
  'orchdesk:trace-feedback',
  (_e, payload: { intent?: string; feedback?: string; sessionKey?: string; messageKey?: string }) => {
    const svc = getService<TraceServiceLike>('trace');
    if (!svc) return { ok: false, unavailable: true, reason: DSH_UNLOAD_REASON };
    const feedback = payload?.feedback === 'negative' ? 'negative' : payload?.feedback === 'neutral' ? 'neutral' : 'positive';
    try {
      svc.recordFeedback(
        String(payload?.intent || 'unknown'),
        feedback,
        payload?.sessionKey ? String(payload.sessionKey) : undefined,
        payload?.messageKey ? String(payload.messageKey) : undefined,
      );
      return { ok: true, queue: svc.queueSize() };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  },
);

// ---------------------------------------------------------------------------
// T-P4/T-P5 智能层 + 补偿 + 自进化桥
// ----------------------------------------------------------------------------
// BUG-014 接线：此前这些 handler 统一调用 dshBridgeStub 返回静态占位（11 个），
// 导致记忆/提示词/补偿/自进化四块 UI 永久空转。现在改为调用 dsh-runtime 中
// 真实装载的插件服务；服务不可用时返回 null 并明确告知渲染层「未接入」，
// 而不是塞一份假数据（项目铁律：不伪造、不静默）。
// ----------------------------------------------------------------------------

/** 服务不可用时统一返回结构（渲染层据此显示「未接入」，不显示假数据）。 */
function unavailable(reason: string): { ok: false; unavailable: true; reason: string } {
  return { ok: false, unavailable: true, reason };
}

// ---- 分层记忆（memory 插件）----






// --- 面板 IPC：见 ipc-browser.ts / ipc-terminal.ts / ipc-file-panel.ts ---
registerBrowserIpc(ipcMain, { dataDir, notify: sendToRenderer });
// M2：授权 IPC（模式/白名单/审批应答）抽至 ipc-authz.ts——组合根只做编排。
registerAuthzIpc(ipcMain, {
  getAuthz: () => authzService,
  sendToRenderer,
  isTrustedSender: isTrustedIpcSender,
  listGuiModes: () => listGuiPermissionModes(),
  getGuiPreset: () => currentStepExtension()?.preset ?? null,
  setGuiPreset: async (mode) => {
    const r = await selectGuiPreset({ preset: mode, confirm: guiStepConfirm() });
    // 权限策略随组合扩展进会话：换了档就必须丢掉旧会话，否则新档只对新
    // 建会话生效，正在跑的那条仍用旧策略。
    if (r.ok) resetStepSessionCache();
    return r;
  },
});
// M2：记忆/提示词/插件能力 IPC 抽至独立模块——组合根只保留编排与注册。
registerMemoryIpc(ipcMain, { dataDir, loadModelConfig });
registerPromptIpc(ipcMain);
registerPluginCapabilityIpc(ipcMain);
registerTerminalIpc(ipcMain, { notify: sendToRenderer });
registerFilePanelIpc(ipcMain);

registerConnectorIpc(ipcMain);
registerMcpIpc(ipcMain);
registerMarketIpc(ipcMain);
// M2 第二轮：观雅集 / Hub / 数据运维 / 桌面集成 IPC 抽至独立模块——
// 组合根只保留编排与注册（R13 守卫「导入即接线」）。
registerGuanjiIpc(ipcMain);
registerHubIpc(ipcMain);
registerDataOpsIpc(ipcMain, { dataDir, logFilePath });
registerDesktopIpc(ipcMain, { dataDir });


/**
 * 设置会话工作区（BUG-023）：项目绑定目录 → 会话默认 cwd 的唯一贯通点。
 * 渲染层在「创建会话 / 打开会话 / 重选项目 / 分叉」时调用；主进程 sessionCwds 是
 * 进程内 Map（重启即失），所以渲染层每次重放，主进程不负责持久化。
 *
 * 口径：这是**用户在 GUI 里亲手绑定**的目录（原生对话框选择 / 手输），与 file Tab
 * 「用户亲手操作不走授权门」同理，不做 isPathAllowed 预检——否则绑 D 盘项目永远
 * 设不上（白名单只有 home/userData/temp）。但校验必须严格：绝对路径 + 存在 + 是目录；
 * 通过后该目录成为此会话 file_* 与 set_cwd 的沙箱白名单根（见 isPathAllowed）。
 * 失败如实返回 reason，渲染层 toast 可见——静默失败会让工作区悄悄回落 user home，
 * Agent 又在 C:\\Users\\my 里找 git 仓库，正是本 BUG 的形态。
 */
ipcMain.handle('orchdesk:set-session-cwd', async (_e, sessionId: unknown, dir: unknown) => {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  const raw = typeof dir === 'string' ? dir.trim() : '';
  if (!sid) return { ok: false, reason: '缺少会话 ID' };
  if (!raw || !isAbsoluteLike(raw)) return { ok: false, reason: '需要绝对路径的项目目录' };
  const resolved = path.resolve(raw);
  let isDir = false;
  try { isDir = fs.statSync(resolved).isDirectory(); } catch { /* 不存在 */ }
  if (!isDir) return { ok: false, reason: `目录不存在或不是文件夹：${resolved}` };
  setSessionCwd(sid, resolved);
  recordSandbox({
    tool: 'set_session_cwd', kind: 'path', target: resolved, decision: 'allowed',
    reason: '用户绑定项目工作区（GUI 驱动，非 Agent 路径）', sessionId: sid,
  });
  return { ok: true, path: resolved };
});

/**
 * PRD FR-4.2「数据目录 · 内容清单」：真实扫描数据目录。
 * 设置页此前写死「~ 24 MB」——与实际磁盘无关的数字，等于拿假数据向用户承诺备份体积。
 * 扫描失败（目录不存在 = 首次运行）返回空清单而不是报错。
 */
ipcMain.handle('orchdesk:data-dir-inventory', () => {
  try {
    const inv = scanDataDir(dataDir());
    // 体积文案在主进程侧格式化（复用 data-dir.formatBytes），渲染层不再各写一套换算。
    return {
      ok: true,
      ...inv,
      items: inv.items.map((i) => ({ ...i, sizeText: formatBytes(i.size) })),
      totalSizeText: formatBytes(inv.totalSize),
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, dir: dataDir(), items: [], totalSize: 0, totalFiles: 0, totalSizeText: '0 B', errors: [] };
  }
});

/** 打开文件夹选择对话框 */
ipcMain.handle('orchdesk:pick-folder', async () => {
  try {
    const { dialog } = await import('electron');
    const opts = { properties: ['openDirectory' as const], title: '选择项目本地文件夹' };
    // 主窗可能尚未创建（托盘/菜单触发），勿用非空断言
    const result = bootDesktop.mainWindow ? await dialog.showOpenDialog(bootDesktop.mainWindow, opts) : await dialog.showOpenDialog(opts);
    if (!result.canceled && result.filePaths.length) return { ok: true, path: result.filePaths[0] };
    return { ok: false, reason: 'cancelled' };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

// ---------------------------------------------------------------------------
// BUG-013 方案 B：数据导出 / 导入（跨机器迁移 + 手动备份，单文件 JSON）
// ----------------------------------------------------------------------------
// 导出 = BACKUP_SECTIONS 列出的业务数据打包为一个可读 JSON（kind: orchdesk-backup）。
// 注意：usage / connectors / mcp / sandbox-log / promotions / desktop 等运行时数据不在导出范围
// （迁移它们请直接复制数据目录，见设置页「数据目录 → 打开目录」）。
// 导入 = 与启动迁移同一套「只补齐不覆盖」合并策略：
//   sessions/models 走 merge-json（同 id 保留较新），guanji/hub 凭据类走
//   copy-if-absent（不深合并，避免破坏密文结构），projects 按 id 补齐。
// 注意：apiKeyEnc / hub tokenCipher 是机器绑定的密文，跨机器导入后解密会失败
// ——此时对应凭据视为未配置，需在设置页重新填写（导入摘要中提示，不静默）。
// ---------------------------------------------------------------------------
const BACKUP_KIND = 'orchdesk-backup';

/** 备份包内允许出现的数据键（白名单，防止导入包夹带任意文件写入）。 */
const BACKUP_SECTIONS = ['sessions', 'projects', 'models', 'guanji', 'hub'] as const;

/** 导入备份体积上限：超出按无效文件拒绝，防止主进程被超大 JSON 阻塞。 */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

/**
 * 凭据类结构校验（fail-closed）：伪造备份不得绕过「无加密后端拒绝明文落盘」。
 * guanji.json = { enc: base64密文 }；hub.json = { url, tokenCipher }。
 */
function credentialSectionValid(name: string, data: unknown): boolean {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== 'object') return false;
  if (name === DATA_FILE_NAMES.guanji) return typeof d.enc === 'string' && d.enc.length > 0;
  if (name === DATA_FILE_NAMES.hub) {
    return typeof d.url === 'string' && d.url.length > 0 && typeof d.tokenCipher === 'string' && d.tokenCipher.length > 0;
  }
  return false;
}

function readJsonFile(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}

/** 把备份包内的凭据类（guanji/hub）搬进数据目录：目标不存在才写，绝不覆盖。 */
function importCredentialSection(root: string, name: string, data: unknown, imported: Record<string, number>): boolean {
  // R4-6：typeof 已覆盖 undefined，这里只需显式并列 null（禁 == null）。
  if (data === null || typeof data !== 'object') return false;
  const target = path.join(root, name);
  if (fs.existsSync(target)) return false; // 目标侧已有凭据：保留，不覆盖
  fs.writeFileSync(target, JSON.stringify(data), 'utf-8');
  imported[name.replace(/\.json$/, '')] = 1;
  return true;
}

ipcMain.handle('orchdesk:export-data', async () => {
  try {
    const { dialog } = await import('electron');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const opts = {
      title: '导出 OrchDesk 数据',
      defaultPath: `orchdesk-backup-${stamp}.json`,
      filters: [{ name: 'OrchDesk 备份', extensions: ['json'] }],
    };
    // 主窗可能尚未创建（如托盘菜单触发）：electron 允许无窗调用，勿用非空断言
    const result = bootDesktop.mainWindow ? await dialog.showSaveDialog(bootDesktop.mainWindow, opts) : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return { ok: false, reason: 'cancelled' };
    const root = dataDir();
    const bundle: Record<string, unknown> = {
      kind: BACKUP_KIND,
      version: 1,
      exportedAt: new Date().toISOString(),
    };
    for (const section of BACKUP_SECTIONS) {
      const file = section === 'projects' ? projectsFile() : path.join(root, DATA_FILE_NAMES[section]);
      bundle[section] = readJsonFile(file);
    }
    fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf-8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

ipcMain.handle('orchdesk:import-data', async () => {
  try {
    const { dialog } = await import('electron');
    const openOpts = {
      title: '导入 OrchDesk 数据',
      properties: ['openFile' as const],
      filters: [{ name: 'OrchDesk 备份', extensions: ['json'] }],
    };
    const result = bootDesktop.mainWindow ? await dialog.showOpenDialog(bootDesktop.mainWindow, openOpts) : await dialog.showOpenDialog(openOpts);
    if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' };
    const srcFile = result.filePaths[0]!;
    try {
      const stat = fs.statSync(srcFile);
      if (stat.size > MAX_IMPORT_BYTES) {
        return { ok: false, reason: `备份文件过大（${Math.round(stat.size / 1024 / 1024)}MB，上限 256MB）` };
      }
    } catch { /* 文件此刻不可读时交给后续 readJsonFile 报错 */ }
    const raw = readJsonFile(srcFile);
    if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).kind !== BACKUP_KIND) {
      return { ok: false, reason: '不是有效的 OrchDesk 备份文件（缺少 kind 标识）' };
    }
    const bundle = raw as Record<string, unknown>;
    const root = dataDir();
    const imported: Record<string, number> = { sessions: 0, projects: 0, providers: 0 };

    // sessions / models：与启动迁移同一套合并器（只补齐不覆盖）
    const sessionsFile = path.join(root, DATA_FILE_NAMES.sessions);
    const sessOutcome = mergeSessionsData(readJsonFile(sessionsFile), bundle.sessions);
    if (sessOutcome && sessOutcome.changed) {
      fs.writeFileSync(sessionsFile, JSON.stringify(sessOutcome.data), 'utf-8');
      imported.sessions = sessOutcome.added;
    }
    const modelsFile = path.join(root, DATA_FILE_NAMES.models);
    // BUG-054：备份里的提供商同样不能带着明文 http 进来。合并前逐条校验 baseUrl，
    // 不合格的直接丢掉并如实记 notes（与凭据段「结构无效已跳过」同一口径）。
    const bundleModels = (bundle.models && typeof bundle.models === 'object'
      ? bundle.models : {}) as Record<string, unknown>;
    const rawProviders = Array.isArray(bundleModels.providers)
      ? (bundleModels.providers as Array<Record<string, unknown>>)
      : [];
    const goodProviders = rawProviders.filter((p) => !!p && typeof p === 'object' && isProviderBaseUrlAllowed(p.baseUrl).ok);
    const droppedProviders = rawProviders.length - goodProviders.length;
    const modelOutcome = mergeProvidersData(readJsonFile(modelsFile), { ...bundleModels, providers: goodProviders });
    if (modelOutcome && modelOutcome.changed) {
      fs.writeFileSync(modelsFile, JSON.stringify(modelOutcome.data), 'utf-8');
      imported.providers = modelOutcome.added;
    }

    // projects：按 id 补齐（目标侧已有的项目保持不变）
    const curProjects = loadProjects();
    const srcProjects = Array.isArray(bundle.projects) ? bundle.projects as Array<Record<string, unknown>> : [];
    const known = new Set(curProjects.map((p) => String(p.id ?? '')));
    // BUG-047：条目形状先过白名单再落盘——过去这里只按 id 去重，内容一概不校验，
    // 伪造备份可以塞进任意键，或把 path（渲染层用来显示「绑定目录」）写成带换行的任意文本。
    const addProjects = srcProjects
      .map((p) => sanitizeIncomingProject(p))
      .filter((p): p is Record<string, unknown> => !!p && !known.has(String(p.id)));
    if (addProjects.length) {
      saveProjects([...curProjects, ...addProjects]);
      imported.projects = addProjects.length;
    }

    // 凭据类：copy-if-absent + 结构校验（伪造备份不得写入明文凭据）
    const notes: string[] = [];
    if (droppedProviders > 0) notes.push(`备份中有 ${droppedProviders} 个提供商因 baseUrl 不合格（明文 http 非回环 / 无法解析）被跳过`);
    for (const [key, fileName] of [['guanji', DATA_FILE_NAMES.guanji], ['hub', DATA_FILE_NAMES.hub]] as const) {
      const section = bundle[key];
      if (section === null || section === undefined) continue; // R4-6：禁 == null
      if (!credentialSectionValid(fileName, section)) {
        notes.push(`${key === 'hub' ? 'Hub' : '观雅集'}凭据结构无效，已跳过（拒绝明文凭据落盘）`);
        continue;
      }
      if (importCredentialSection(root, fileName, section, imported)) {
        notes.push(`${key === 'hub' ? 'Hub 配对凭据' : '观雅集 TOKEN'} 已导入（跨机器时密文不可解，需重新配置）`);
      }
    }

    // 内存态重载（渲染层随后自行拉取新会话/项目）
    loadStore();
    return { ok: true, imported, notes, path: srcFile };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

app.whenReady().then(async () => {
  // 日志系统最先初始化：后续迁移 / 运行时启动 / 模型调用全部留痕
  initLogger(dataDir());
  mirrorConsole();
  log('INFO', 'boot', `OrchDesk 启动（版本 ${typeof app.getVersion === 'function' ? app.getVersion() : 'dev'}，数据目录 ${dataDir()}）`);

  // BUG-013：先把历史位置的数据合并进规范化目录，再加载会话。
  try { migrateLegacyData(); } catch (err) { console.warn('[orchdesk] 数据迁移异常:', (err as Error).message); }
  loadStore();

  // 数据目录确定后告知宿主服务（沙箱状态落盘位置）。
  process.env.ORCHDESK_DATA_DIR = dataDir();

  // 终端（P2-10）：启动期探测 node-pty 可用性，让 getTerminalState 的
  // ptyAvailable 从一开始就是确定值（未探测 ≠ 不可用，不许混淆）。
  try {
    const ok = preloadTerminalPty();
    log('INFO', 'terminal', ok ? 'node-pty 已加载（真 PTY 模式）' : 'node-pty 不可用，终端将以管道模式降级');
  } catch (err) {
    log('WARN', 'terminal', 'node-pty 探测异常：' + (err as Error).message);
  }

  // dsh 已卸下。bootRuntime 只记录原因，不创建 Cordis，不装载九个插件。
  await bootRuntime();

  // PRD FR-8：沙箱日志装载（必须在 migrateLegacyData 之后——日志随数据目录迁移）。
  // 坏文件 → 空日志，不阻断启动：日志是观测设施。
  try {
    const n = loadSandboxLog();
    if (n > 0) log('INFO', 'sandbox', `沙箱日志已装载：${n} 条（${sandboxLogFile()}）`);
  } catch (err) {
    console.warn('[orchdesk] 沙箱日志装载失败:', (err as Error).message);
  }

  // PRD FR-10：晋升审计装载（同样在 migrateLegacyData 之后，审计随目录迁移）。
  try {
    loadPromotionLog(dataDir);
  } catch (err) {
    console.warn('[orchdesk] 晋升审计装载失败:', (err as Error).message);
  }

  // PRD FR-3：连接器注册表装载（凭证密文随目录迁移，跨机器解不开会表现为「未配置」）。
  try {
    const n = loadConnectors();
    if (n > 0) log('INFO', 'connector', `连接器注册表已装载：${n} 个已配置（${connectorsFilePath()}）`);
  } catch (err) {
    console.warn('[orchdesk] 连接器注册表装载失败:', (err as Error).message);
  }

  // PRD FR-3：本地插件市场启用状态装载（插件代码在 dataDir()/plugins/，这里只存意愿）。
  try {
    hydrateMarketEnabled();
  } catch (err) {
    console.warn('[orchdesk] 插件市场状态装载失败:', (err as Error).message);
  }

  // MCP 真接入：配置装载（env 密文随目录迁移，跨机器解不开会表现为「连接失败」而非明文泄漏）。
  try {
    const n = loadMcp();
    if (n > 0) log('INFO', 'mcp', `MCP 配置已装载：${n} 个 server（${mcpFilePath()}）`);
  } catch (err) {
    console.warn('[orchdesk] MCP 配置装载失败:', (err as Error).message);
  }

  // PRD FR-4.2：桌面集成开关全量重放（此前 6 项全是设置页空壳，见第十个死挂点）。
  // 必须在 createWindow 之前——全局快捷键/托盘都依赖 mainWindow 存在与否。
  bootDesktop.setDesktopConfig(loadDesktopConfig(dataDir()));
  bootDesktop.applyDesktopConfig();

  bootDesktop.createWindow();
  // 托盘由 applyTray 按配置决定是否创建；此处不再无条件 createTray()。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) bootDesktop.createWindow();
  });

  // 开机提醒（FR-4.2）：启动完成发一条系统通知，配置关闭时静默跳过。
  if (bootDesktop.desktopConfig.notify) bootDesktop.notifyDesktop('OrchDesk 已启动', '点击托盘图标或按 ' + SHORTCUT_LABEL + ' 唤起主窗');
});

function installProcessGuards(): void {
  process.on('uncaughtException', (err) => {
    const msg = (err && err.stack) || String(err);
    try { log('ERROR', 'boot', `uncaughtException: ${msg}`); } catch { /* 日志失败不能再抛 */ }
    let packaged = false;
    try { packaged = !!app.isPackaged; } catch { packaged = false; }
    if (packaged) process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason as { stack?: string; message?: string } | undefined;
    const msg = err?.stack || err?.message || String(reason);
    try { log('ERROR', 'boot', `unhandledRejection: ${msg}`); } catch { /* ignore */ }
  });
}
installProcessGuards();

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (bootDesktop.isRecoveringRenderer()) {
    log('WARN', 'desktop', '渲染进程恢复中，跳过退出');
    return;
  }
  app.quit();
});

app.on('before-quit', () => {
  // 注销全局快捷键：不注销会在进程退出后残留加速器（Windows 上表现为快捷键失灵）
  try { globalShortcut.unregisterAll(); } catch { /* 忽略 */ }
  bootDesktop.destroyFloatingWindow();
  // PTY 子进程与浏览器窗要在退出前收掉：Windows 上原先会留下 cmd.exe / ConPTY 孤儿
  // 和一个隐藏的 Chromium 窗口，下次启动像「上一个还没退」。
  try {
    const killed = closeAllTerminals();
    if (killed) log('INFO', 'terminal', `退出前关闭 ${killed} 个终端会话`);
  } catch (err) { log('WARN', 'terminal', `退出前关闭终端失败：${(err as Error).message}`); }
  try {
    destroyBrowserWindow();
  } catch (err) { log('WARN', 'browser', `退出前销毁浏览器窗失败：${(err as Error).message}`); }
  // 沙箱日志 dirty flush（治理项⑥）：合并写未到期时退出不能丢尾部判定
  try { flushSandboxLog(); } catch { /* 忽略 */ }
  // 触发全部插件的逆效应（卸载无残留）
  void stopRuntime();
});
