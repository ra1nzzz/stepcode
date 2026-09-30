/**
 * 授权 IPC（PRD FR-9）：三模式 + L0–L4 + 白名单 + 审批应答。
 * 从 main.ts 抽出（组合根只保留编排）：handler 是业务面，与窗口/托盘/启动无关。
 * 依赖经 registerAuthzIpc 注入——authzService 是运行时就绪后赋值的模块变量，
 * 必须传 getter 而非快照。
 */
import type { IpcMain, IpcMainEvent } from 'electron';
import { log } from './logger';
import { persistGrantsNow } from './dsh-runtime';

export type AuthzServiceLike = {
  getMode(sessionId?: string): Promise<string>;
  setMode(mode: string, sessionId?: string): Promise<{ ok: boolean; reason?: string }>;
  getLevels(): Array<{ level: number; label: string; scope: string; requiresApproval: boolean }>;
  getAuditLog(): Array<{ kind: string; ts: number; mode?: string; outcome?: string; toolName?: string; reason?: string; sessionId?: string }>;
  setUiAnswerer(fn: ((req: { toolName: string; reason?: string; sessionId?: string }) => Promise<string>) | null): void;
  getModes?(): Array<{ id: string; label: string; sandboxMode: string; approvalPolicy: string; blurb: string }>;
  getGrantTools?(): readonly string[];
  subscribe?(cb: (evt: unknown) => void): () => void;
  // ---- PRD FR-9：会话 / 永久授权白名单 ----
  listGrants?(): GrantRuleLike[];
  grant?(input: unknown): { ok: boolean; rule?: GrantRuleLike; reason?: string };
  revoke?(id: string): boolean;
  revokeAll?(): number;
  matchGrant?(q: { toolName?: string; target?: string; sessionId?: string }): GrantRuleLike | null;
};

export interface GrantRuleLike {
  id: string;
  tool: string;
  pattern: string;
  scope: 'session' | 'permanent';
  sessionId?: string;
  note?: string;
  hits: number;
  createdAt: number;
}

export interface GuiModeLike {
  id: string;
  label: string;
  blurb: string;
}

export interface AuthzIpcDeps {
  /** 取当前授权服务（运行时就绪前为 null → handler 明确返回未加载，不造假数据）。 */
  getAuthz: () => AuthzServiceLike | null;
  /** 推渲染层（审批弹窗）。 */
  sendToRenderer: (channel: string, payload: unknown) => void;
  /** 界面两档。提供后不再把已卸下的授权插件模式透传给界面。 */
  listGuiModes?: () => readonly GuiModeLike[];
  getGuiPreset?: () => string | null;
  setGuiPreset?: (mode: string) => Promise<{ ok: boolean; preset?: string; reason?: string }>;
}

/** 审批挂起表：id → 应答方 + 超时兜底器（fail-closed：超时 resolve unavailable）。 */
export const pendingApprovals = new Map<string, { resolve: (o: string) => void; timer: NodeJS.Timeout }>();
let approvalSeq = 0;

/** 写穿落盘（白名单数量少、变更罕见，不走记忆那套 20s 轮询）。 */
function persistGrants(): void {
  try {
    if (!persistGrantsNow()) log('WARN', 'authz', '授权白名单落盘失败（本次会话仍生效，重启后丢失）');
  } catch (err) {
    log('WARN', 'authz', `授权白名单落盘异常：${(err as Error).message}`);
  }
}

export function registerAuthzIpc(ipc: IpcMain, deps: AuthzIpcDeps): void {
  const { getAuthz, sendToRenderer } = deps;

  ipc.handle('orchdesk:authz-get-mode', async () => {
    if (!deps.getGuiPreset) return { unavailable: true, reason: '进程内组合未接上' };
    const mode = deps.getGuiPreset();
    if (mode === 'bypass' || mode === 'autopilot') return { mode };
    return { unavailable: true, reason: '进程内组合未接上' };
  });
  ipc.handle('orchdesk:authz-set-mode', async (_e, mode: string) => {
    if (mode !== 'bypass' && mode !== 'autopilot') {
      return { ok: false, reason: '权限策略只能是 bypass 或 autopilot' };
    }
    if (!deps.setGuiPreset) return { ok: false, reason: '进程内组合未接上' };
    try { return await deps.setGuiPreset(mode); } catch { return { ok: false, reason: '切换异常' }; }
  });
  ipc.handle('orchdesk:authz-get-levels', async () => {
    const authz = getAuthz();
    if (!authz) return [];
    try { return authz.getLevels(); } catch { return []; }
  });
  // 界面模式只来自两档。已卸下的授权插件不再向界面透传模式。
  ipc.handle('orchdesk:authz-get-modes', async () => {
    if (!deps.listGuiModes) return { unavailable: true, reason: '进程内组合未接上', modes: [], grantTools: [] };
    return { modes: deps.listGuiModes().map((mode) => ({ ...mode })), grantTools: [] };
  });
  ipc.handle('orchdesk:authz-get-audit', async () => {
    const authz = getAuthz();
    if (!authz) return [];
    try { return authz.getAuditLog(); } catch { return []; }
  });

  // ---------------------------------------------------------------------------
  // PRD FR-9：授权白名单（操作类型 + 路径白名单，可查看可撤销）
  // ---------------------------------------------------------------------------
  // 粒度三选一此前只实现了「单次」——每次写同一个文件都要重新点确认。
  // 这里补 session / permanent 两种记住粒度；持久化走 dsh-runtime 写穿落盘
  // （authz-grants.json），撤销立即生效并全部入审计。
  ipc.handle('orchdesk:authz-list-grants', async () => {
    const authz = getAuthz();
    if (!authz?.listGrants) return [];
    try { return authz.listGrants(); } catch { return []; }
  });

  ipc.handle('orchdesk:authz-grant', async (_e, input: unknown) => {
    const authz = getAuthz();
    if (!authz?.grant) return { ok: false, reason: '授权服务未加载' };
    const res = authz.grant(input);
    if (res.ok) persistGrants();
    else log('WARN', 'authz', `白名单规则被拒：${res.reason}`);
    return { ...res, grants: authz.listGrants?.() ?? [] };
  });

  ipc.handle('orchdesk:authz-revoke-grant', async (_e, id: string) => {
    const authz = getAuthz();
    if (!authz?.revoke) return { ok: false, reason: '授权服务未加载' };
    const ok = authz.revoke(String(id || ''));
    if (ok) persistGrants();
    return { ok, grants: authz.listGrants?.() ?? [] };
  });

  ipc.handle('orchdesk:authz-revoke-all-grants', async () => {
    const authz = getAuthz();
    if (!authz?.revokeAll) return { ok: false, reason: '授权服务未加载' };
    const revoked = authz.revokeAll();
    persistGrants();
    return { ok: true, revoked, grants: authz.listGrants?.() ?? [] };
  });

  // 审批应答：渲染层弹窗 → submitDecision → 解除挂起的 approvalGate。
  // 非法 outcome 归一化为 unavailable（fail-closed 不猜用户意图）。
  // R4-2：这条通道走 ipcMain.on，**不在 main.ts 对 ipcMain.handle 的 sender 门 patch
  // 覆盖范围内**（main.ts:125 与 ipc-guard-verify 都声明「92 个 handler 全过 sender 门」）。
  // 今天只有一个带 preload 的窗所以没有实际越权面，但一旦加入第二个合法窗，它就能
  // 代替主窗应答——甚至自动应答 allowed-once——全部挂起审批，用户确认门被绕过。
  // 这里按同一口径补一道 sender 校验：只接受主 frame 发来的应答。
  ipc.on('orchdesk:authz-submit-decision', (e: IpcMainEvent, id: string, outcome: string) => {
    // 只接受主 frame 的应答，拒绝 iframe / 子 frame 代答。真实主窗 IPC 的
    // senderFrame 就是主 frame，所以判「是子 frame 即拒绝」。空安全：验证探针会以
    // (null, ...) 直调本通道，没有 sender，按进程内直调放行，不读 frame。
    const sender = e ? e.sender : null;
    const frame = e ? e.senderFrame : null;
    const mainFrame = sender && typeof sender.mainFrame !== 'undefined' ? sender.mainFrame : null;
    if (frame && mainFrame && frame !== mainFrame) return;   // 子 frame 代答一律拒绝
    const pending = pendingApprovals.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingApprovals.delete(id);
    const allowed = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];
    pending.resolve(allowed.includes(outcome) ? outcome : 'unavailable');
  });
}

/** bootRuntime 里生成审批 id 用（序号单调，ID 只在本进程有效）。 */
export function nextApprovalId(): string {
  return `apr-${++approvalSeq}`;
}
