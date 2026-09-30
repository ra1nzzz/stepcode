/// <reference types="electron" />
/**
 * OrchDesk 宿主服务（Host Services）
 * ----------------------------------------------------------------------------
 * dsh 底座提供「一切皆插件、可逆效应」的运行时，但 PRD §2 明确：dsh 缺的恰好是
 * OrchDesk 的增量——**桌面壳、跨平台沙箱、系统边界外补偿层、上游意图网关**。
 *
 * 因此 OrchDesk 的 9 个 Cordis 插件所注入的三个服务（sandboxPolicy / approval /
 * agents），由 OrchDesk 自己在桌面侧提供真实实现，而不是去拉完整的 dsh 发行版：
 *
 *   sandboxPolicy —— 目录白名单 + 命令白名单 + 沙箱模式持久化（跨平台 backend 的桌面实现）
 *   approval      —— 审批请求路由到 GUI 弹窗，fail-closed（无应答方/超时 → unavailable）
 *   agents        —— SubAgent 以独立 Cordis fiber 创建/销毁，满足「即用即走、可逆效应」
 *
 * 这是真实实现，不是占位：每个服务都可执行、可审计、可持久化。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
/**
 * dsh 已卸下（T2），Cordis 不再装载。这个 apply 只是残留的可观测接口，
 * 不调用任何宿主能力。本地最小形状取代公网上的 @deepseek-ai/cordis 类型。
 */
type Context = unknown;
import { getDataDir } from './data-dir';

// ---------------------------------------------------------------------------
// 沙箱模式（对齐 dsh SandboxMode 命名）
// ---------------------------------------------------------------------------

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

const SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

export interface SandboxPolicyLike {
  resolve(req?: { session?: { id: string } }): { mode: SandboxMode };
  setSandboxMode(session: { id: string }, mode: string): void;
  /** PRD FR-8：网络请求域名白名单（['*'] = 不限；**空数组 = 全部拒绝**，fail-closed）。可读写。 */
  getNetworkAllow?(): string[];
  /** @returns 落盘是否成功（收紧白名单属安全变更，失败必须可感知）。 */
  setNetworkAllow?(list: string[]): boolean;
  /** PRD FR-8：域名准入判定（供 web_fetch 等外发工具调用）。 */
  isDomainAllowed?(url: string): boolean;
  /** C1：风控档位（authz 插件经此持久化 mode id，重启后仍可分辨）。 */
  getAuthMode?(): AuthzModeId;
  setAuthMode?(mode: AuthzModeId): void;
}

interface SandboxState {
  mode: SandboxMode;
  sessionModes: Record<string, SandboxMode>;
  /** 网络域名白名单：'*' 表示不限制；支持后缀匹配（如 'github.com'）。 */
  networkAllow: string[];
  /** 风控档位（C1：三模式总开关）。default=修好后的意图门形态；trusted=意图门纯审计
      + 网络白名单合并预置种子；paranoid=最严（意图门无模型回退 BLOCK）。 */
  authMode: AuthzModeId;
  audit: Array<{ ts: number; kind: 'sandbox-mode'; mode: string; sessionId?: string }>;
}

export type AuthzModeId = 'default' | 'trusted' | 'paranoid';

/** 信任模式预置的开发常用域名（C1）：与用户自填合并（并集），不替代、可增删。
 * 不做「一键全放行」——种子是常用开发域名，不是 '*';
 * SSRF 防护（BLOCKED_HOSTNAME_*）独立生效，种子不削弱它。 */
export const TRUSTED_NETWORK_SEED: readonly string[] = [
  'github.com', 'raw.githubusercontent.com', 'registry.npmjs.org',
  'pypi.org', 'files.pythonhosted.org', 'models.dev',
  'api.deepseek.com', 'api.moonshot.cn', 'open.bigmodel.cn', 'dashscope.aliyuncs.com',
];

/** 有效白名单 = 用户自填 ∪（trusted 模式时的种子）。存储态永远是用户自填。 */
function effectiveNetworkAllow(state: SandboxState): string[] {
  const own = normalizeNetworkAllow(state.networkAllow);
  if (state.authMode !== 'trusted') return own;
  return normalizeNetworkAllow([...own, ...TRUSTED_NETWORK_SEED]);
}

function sandboxFile(): string {
  // M3：统一走 getDataDir() 单源（resolver → ORCHDESK_DATA_DIR → ORCHDESK_HOME → 抛错）。
  // 历史实现直读 env 且回退 '.'（进程 cwd）——测试夹具/启动顺序一变就把沙箱状态
  // 悄悄写进 exe 目录且不报错。
  return path.join(getDataDir(), 'sandbox.json');
}

function loadSandbox(): SandboxState {
  const base: SandboxState = { mode: 'workspace-write', sessionModes: {}, networkAllow: [], authMode: 'default', audit: [] };
  try {
    const f = sandboxFile();
    if (!fs.existsSync(f)) return base;
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Partial<SandboxState>;
    return {
      mode: SANDBOX_MODES.includes(raw.mode as SandboxMode) ? (raw.mode as SandboxMode) : 'workspace-write',
      // R4-4：sessionModes 逐值过白名单——与顶层 mode（上一行）同口径。手改或损坏的
      // sandbox.json 写入非法模式串时，原样采信会让 resolve() 返回未定义行为，所有
      // === 'read-only' 判定落空（该会话被当作可写）；setSandboxMode 对未知模式是
      // 降级为最严的，装载侧不能反其道而行之。不认识的条目整体丢弃，回落全局 mode。
      sessionModes: raw.sessionModes && typeof raw.sessionModes === 'object'
        ? Object.fromEntries(Object.entries(raw.sessionModes).filter(([, v]) => SANDBOX_MODES.includes(v as SandboxMode)))
        : {},
      networkAllow: normalizeNetworkAllow(raw.networkAllow),
      authMode: raw.authMode === 'trusted' || raw.authMode === 'paranoid' ? raw.authMode : 'default',
      audit: Array.isArray(raw.audit) ? raw.audit.slice(-200) : [],
    };
  } catch {
    return base;
  }
}

/** 归一化域名白名单：非法项丢弃；**空数组 = 全部拒绝**（fail-closed，安全审查 B-2）。
 * 历史实现空数组回落 ['*']（全网放开）是「误配导致全网被封死」的便利性倒逼安全让步——
 * 默认安全（PRD §7 本地优先）优先：不配白名单就不放行，用户显式加 '*' 才放开。 */
export function normalizeNetworkAllow(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const cleaned = list
    .map((d) => String(d || '').trim().toLowerCase())
    .filter((d) => d.length > 0 && d.length < 256 && !/[\s/]/.test(d));
  return cleaned;
}

/**
 * 域名白名单判定纯函数（白名单为入参，内存态/磁盘态两种调用方共用）。
 * 白名单含 '*' → 放行全部；否则 host 命中任一项（精确或后缀 .domain）→ 放行。
 * 白名单为空或 URL 无法解析 → 一律拒绝（fail-closed）。
 */
export function checkDomainAllowed(url: string, list: readonly string[]): boolean {
  const allow = normalizeNetworkAllow(list);
  if (allow.includes('*')) return true;
  if (!allow.length) return false;
  let host = '';
  try {
    host = new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return allow.some((d) => (d.startsWith('*.') ? host === d.slice(2) || host.endsWith(d.slice(1)) : host === d || host.endsWith('.' + d)));
}

/** 磁盘态域名判定（外部/verify 调用方用；热路径请用 policy.isDomainAllowed 的内存态）。 */
export function isDomainAllowed(url: string): boolean {
  return checkDomainAllowed(url, loadSandbox().networkAllow);
}

// ---------------------------------------------------------------------------
// SSRF 防护（安全审查 B-2）：白名单管「域名准不准出」，这里管「目标危不危险」。
// 两类必须拦的目标：① 私网/回环/链路本地/CGNAT 的 IP 字面量（云元数据 169.254.169.254、
// 本机服务 127.0.0.1、内网管理端）；② 已知元数据主机名。与白名单独立生效——
// 用户显式 '*' 放开域名时不改变这里的拒绝。
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAME_EXACT = new Set([
  'localhost', 'metadata', 'metadata.google.internal', 'instance-data',
]);
const IPV4_BLOCKED: RegExp[] = [
  /^0\./,                       // 0.0.0.0/8
  /^127\./,                     // IPv4 回环
  /^10\./,                      // 私网 10/8
  /^192\.168\./,                // 私网 192.168/16
  /^172\.(1[6-9]|2\d|3[01])\./, // 私网 172.16/12
  /^169\.254\./,                // 链路本地（含云元数据端点）
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

/** URL 主机是否属于必须拒绝的内网/元数据目标。URL 无法解析 → true（fail-closed）。 */
export function isBlockedHost(url: string): boolean {
  let host = '';
  try {
    host = new URL(String(url || '')).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (!host) return true;
  if (BLOCKED_HOSTNAME_EXACT.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (host.includes(':')) { // IPv6 字面量（WHATWG URL 输出小写十六进制、无方括号）
    if (host === '::1') return true;
    if (/^f[cd]/.test(host)) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 链路本地
    // IPv4-mapped IPv6（::ffff:0:0/96）：WHATWG 归一为 ::ffff:7f00:1 形态，
    // 不剥离会绕过全部 IPv4 规则（2026-09 二审实测 ::ffff:169.254.169.254 被放行）。
    const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const hi = parseInt(mapped[1]!, 16);
      const lo = parseInt(mapped[2]!, 16);
      const v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      if (IPV4_BLOCKED.some((re) => re.test(v4))) return true;
    }
    // NAT64（64:ff9b::/96）：末 32 位为 IPv4
    const nat64 = host.match(/^64:ff9b:(?::|0:)*([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (nat64) {
      const hi = parseInt(nat64[1]!, 16);
      const lo = parseInt(nat64[2]!, 16);
      const v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      if (IPV4_BLOCKED.some((re) => re.test(v4))) return true;
    }
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return IPV4_BLOCKED.some((re) => re.test(host));
  return false;
}

/** 落盘返回结果：收紧白名单/切换模式是安全相关变更，失败必须可感知（fail-closed 语义）。 */
function saveSandbox(state: SandboxState): boolean {
  try {
    fs.writeFileSync(sandboxFile(), JSON.stringify({ ...state, audit: state.audit.slice(-200) }, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[orchdesk] 沙箱状态持久化失败:', (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 审批
// ---------------------------------------------------------------------------

/** 审批超时（fail-closed 兜底）：main.ts 的 uiAnswerer 与本 service 共用同一常量，防双源漂移。 */
export const APPROVAL_TIMEOUT_MS = 120_000;

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface ApprovalRequestLike {
  toolName?: string;
  reason?: string;
  sessionId?: string;
  /**
   * PRD FR-9：被授权操作的具体目标（文件路径 / shell 命令 / URL）。
   * 白名单按「操作类型 + 目标」匹配，没有目标就只能被 '*' 规则命中。
   */
  target?: string;
  signal?: AbortSignal;
}

export interface ApprovalServiceLike {
  request(req: ApprovalRequestLike, signal?: AbortSignal): Promise<ApprovalOutcome>;
  setPolicy(agent: unknown, policy: 'ask' | 'never'): void;
  /** 由主进程注册「GUI 应答方」；未注册 → fail-closed 返回 unavailable。 */
  setUiAnswerer(fn: ((req: ApprovalRequestLike) => Promise<string>) | null): void;
}

// ---------------------------------------------------------------------------
// SubAgent（agents 服务）
// ---------------------------------------------------------------------------

export interface CreateAgentOptionsLike {
  sessionId?: string;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface AgentHandleLike {
  agent: { id: string; meta?: Record<string, unknown> };
  dispose(): Promise<void>;
}

/**
 * SubAgent 运行器：由 main.ts 注入真实实现（复用现有 callModel + 工具循环）。
 * 未注入时 create 仍成功，但 followup 会返回明确错误（不静默伪造结果）。
 */
export type AgentRunner = (
  input: { sessionId: string; meta?: Record<string, unknown>; messages: Array<{ role: string; content: string }> },
) => Promise<{ text: string }>;

export interface AgentsServiceLike {
  create(opts: CreateAgentOptionsLike): Promise<AgentHandleLike>;
  followup(sessionId: string, messages: Array<{ role: string; content: string }>): Promise<{ text: string }>;
  list(): string[];
}

// ---------------------------------------------------------------------------
// 对外：注册到主进程的句柄
// ---------------------------------------------------------------------------

export interface HostServices {
  approval: ApprovalServiceLike;
  /** PRD FR-8：沙箱策略（模式 + 网络域名白名单），供主进程工具链直接查询。 */
  sandboxPolicy: SandboxPolicyLike;
  /** 主进程注册 GUI 审批应答方（渲染层弹窗 → 回传 outcome）。 */
  setUiAnswerer(fn: ((req: ApprovalRequestLike) => Promise<string>) | null): void;
  /** 主进程注入 SubAgent 真实运行器。 */
  setAgentRunner(fn: AgentRunner | null): void;
}

// ---------------------------------------------------------------------------
// 插件定义
// ---------------------------------------------------------------------------

/**
 * apply() 的返回值不会被 ctx.plugin() 透出，所以用模块级句柄把服务暴露给主进程。
 * 未初始化时为 null（运行时尚未启动）。
 */
let currentHandle: HostServices | null = null;

/** 取宿主服务句柄；运行时未启动返回 null（调用方需判空，不静默降级）。 */
export function getHostServices(): HostServices | null {
  return currentHandle;
}

export const hostServices = {
  name: 'orchdesk-host-services',
  apply(ctx: Context): void {
    void ctx;
    currentHandle = null;
    return;
  },
};
