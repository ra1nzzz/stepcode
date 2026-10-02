/**
 * 沙箱 IPC（PRD FR-8）。
 * 环形缓冲 / 检索 / 统计在 sandbox-log.ts（纯逻辑、零 electron）。
 * 本模块管文件读写、dirty 合并 flush、真实策略读写、以及 IPC 挂载。
 * 注册须在 main.ts patch ipcMain.handle 之后调用，才能走 sender 门。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcMain } from 'electron';
import { DATA_FILE_NAMES } from './data-dir';
import { getHostServices } from './host-services';
import { log } from './logger';
import {
  appendSandboxLog,
  normalizeSandboxLog,
  SANDBOX_LOG_MAX,
  sandboxLogStats,
  searchSandboxLog,
  type SandboxLogEntry,
  type SandboxLogQuery,
} from './sandbox-log';

export type SandboxIpcHost = {
  dataDir: () => string;
};

let host: SandboxIpcHost | undefined;
let sandboxLog: SandboxLogEntry[] = [];
/** 最近一次读到的授权模式（getMode 是异步的，日志只能留快照）。 */
/**
 * BUG-045：沙箱模式的界面口径。键集必须与 `host-services.ts` 的 SANDBOX_MODES 一致
 * （由 `step-t4-verify` 的一致性断言钉住：主进程加了档位而这里漏一行，状态栏就会显示
 * 「未识别档位」并被判红）。
 */
const SANDBOX_MODE_LABELS: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '工作区内可写',
  'danger-full-access': '完全访问（危险）',
};

let lastAuthMode = '';

export function initSandbox(deps: SandboxIpcHost): void {
  host = deps;
}

function requireHost(): SandboxIpcHost {
  if (!host) throw new Error('initSandbox 未调用');
  return host;
}

export function noteAuthMode(mode: string): void {
  lastAuthMode = mode;
}

export function sandboxLogFile(): string {
  return path.join(requireHost().dataDir(), DATA_FILE_NAMES.sandboxLog);
}

/** 启动装载：坏文件 / 缺文件 → 空日志（与白名单同策略，不猜内容）。 */
export function loadSandboxLog(): number {
  try {
    sandboxLog = normalizeSandboxLog(JSON.parse(fs.readFileSync(sandboxLogFile(), 'utf-8')));
  } catch {
    sandboxLog = [];
  }
  return sandboxLog.length;
}

/** 写穿落盘（与授权白名单同一节奏：安全审计不留「刚发生就崩了」的窗口）。 */
function persistSandboxLog(): boolean {
  try {
    const file = sandboxLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sandboxLog, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log('WARN', 'sandbox', `沙箱日志落盘失败（不影响工具执行）: ${(err as Error).message}`);
    return false;
  }
}

/* 写放大治理（复审项⑥）：recordSandbox 原先每条判定都全量重写 sandbox-log.json，
 * 工具循环上限 200 步 → 最坏 200 次同步全文件写。改为 dirty 合并 flush：
 *   1. 标记后延迟 100ms（微任务合帧窗口）合并为一次写；
 *   2. before-quit / 关键路径可显式 flush（见 app 生命周期钩子）；
 *   3. flush 失败只 WARN——日志是观测设施，不是安全门（原语义保持）。 */
let sandboxLogDirty = false;
let sandboxLogFlushTimer: NodeJS.Timeout | null = null;
const SANDBOX_LOG_FLUSH_MS = 100;

export function flushSandboxLog(): void {
  if (sandboxLogFlushTimer) { clearTimeout(sandboxLogFlushTimer); sandboxLogFlushTimer = null; }
  if (!sandboxLogDirty) return;
  sandboxLogDirty = false;
  persistSandboxLog();
}

/**
 * 记一条沙箱判定。
 * 入参缺 tool / target / decision 会被 normalizeSandboxEntry 丢弃 —— 那种条目
 * 存进去也检索不到，不如不留。
 */
export function recordSandbox(input: {
  tool: string;
  kind: SandboxLogEntry['kind'];
  target: string;
  decision: SandboxLogEntry['decision'];
  reason?: string;
  sessionId?: string;
}): void {
  const before = sandboxLog.length;
  sandboxLog = appendSandboxLog(sandboxLog, {
    ...input,
    mode: lastAuthMode,
    ts: Date.now(),
  });
  if (sandboxLog.length === before) return; // 被归一化丢弃，无需落盘
  sandboxLogDirty = true;
  if (sandboxLogFlushTimer) return; // 已有排定的 flush
  sandboxLogFlushTimer = setTimeout(() => {
    sandboxLogFlushTimer = null;
    flushSandboxLog();
  }, SANDBOX_LOG_FLUSH_MS);
}

export function registerSandboxIpc(ipc: IpcMain): void {
  // PRD FR-8：沙箱策略（模式 + 网络域名白名单）
  ipc.handle('orchdesk:sandbox-get', () => {
    const policy = getHostServices()?.sandboxPolicy;
    if (!policy) return { unavailable: true, reason: '沙箱服务已停止', mode: '', modeLabel: '', networkAllow: [] };
    const mode = policy.resolve?.().mode || '';
    return {
      mode,
      // BUG-045：`mode` 是机器标识，只能留在 IPC 边界里；界面要的是中文口径。
      // 映射放在生产侧，渲染层拿不到、也不需要沙箱模式白名单。
      // 未识别的取值不猜口径——留空串，由渲染层显示「未识别档位」，不冒充已知模式。
      modeLabel: SANDBOX_MODE_LABELS[mode] ?? '',
      networkAllow: policy.getNetworkAllow ? policy.getNetworkAllow() : [],
    };
  });
  ipc.handle('orchdesk:sandbox-set-network-allow', (_e, list: string[]) => {
    const policy = getHostServices()?.sandboxPolicy;
    if (!policy?.setNetworkAllow) return { ok: false, reason: '沙箱服务未就绪' };
    // 收紧/放宽白名单是安全相关变更：落盘失败必须让用户看到（否则「删了域名但没
    // 落盘」= 内存收紧/磁盘旧宽名单双源，重启后悄悄失效——fail-open 窗口）。
    const saved = policy.setNetworkAllow(Array.isArray(list) ? list : []);
    if (!saved) return { ok: false, reason: '白名单已在本会话生效，但落盘失败（重启后恢复旧配置）' };
    const next = policy.getNetworkAllow ? policy.getNetworkAllow() : [];
    // 放宽网络白名单是安全相关配置变更 → 入沙箱日志，事后可追溯「什么时候放开了哪些域名」。
    recordSandbox({
      tool: 'sandbox.network',
      kind: 'config',
      target: next.join(','),
      decision: 'allowed',
      reason: `网络域名白名单已更新（${next.length} 项）`,
    });
    return { ok: true, networkAllow: next };
  });

  // PRD FR-8：沙箱日志检索（设置页入口）
  ipc.handle('orchdesk:sandbox-log', (_e, q: SandboxLogQuery | undefined) => {
    const query = (q && typeof q === 'object' ? q : {}) as SandboxLogQuery;
    return {
      entries: searchSandboxLog(sandboxLog, query),
      stats: sandboxLogStats(sandboxLog),
      total: sandboxLog.length,
      max: SANDBOX_LOG_MAX,
    };
  });
  ipc.handle('orchdesk:sandbox-log-clear', () => {
    const cleared = sandboxLog.length;
    sandboxLog = [];
    persistSandboxLog();
    return { ok: true, cleared, entries: [], stats: sandboxLogStats(sandboxLog) };
  });
}
