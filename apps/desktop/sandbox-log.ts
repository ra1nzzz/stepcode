/**
 * 沙箱日志（PRD FR-8「沙箱日志可检索」）
 * ----------------------------------------------------------------------------
 * 纯逻辑层，零 electron 依赖（与 data-dir.ts / agent-runtime.ts 同一约定）。
 *
 * 记录每一次**沙箱判定**：路径白名单、命令白名单、网络域名白名单、授权门、
 * 补偿门外发预判，以及执行结果（成功 / 失败）。此前这些判定只散落在
 * executeTool 的 return 里，事后无法回答「Agent 刚才到底对磁盘做了什么」。
 *
 * 设计取舍：
 * - **环形缓冲（默认 500 条）**：审计日志的目的是追溯最近的事故，不是当数据库。
 *   无限增长会拖慢启动并撑大数据目录，超量淘汰最旧的条目（有明确提示）。
 * - **写穿落盘**：与授权白名单同一节奏。安全审计不容「刚发生、还没落盘就崩了」
 *   的窗口（记忆是 20s 去抖，因为量大且变更频繁；日志量少、变更罕见）。
 * - **落盘失败不阻断操作**：日志是观测设施，不是安全门。写盘失败只 WARN，
 *   绝不因为记不下来就拒绝工具执行。
 */

/** 判定结果：放行 / 拒绝 / 执行出错。 */
export type SandboxDecision = 'allowed' | 'denied' | 'error';

/**
 * 沙箱判定类型（比工具名更粗的维度，便于按类检索）。
 * browser：内置浏览器（CDP）的导航与页面内操作——同样要能回答「Agent 刚刚在哪个网页上点了什么」。
 */
export type SandboxKind = 'path' | 'command' | 'network' | 'approval' | 'outbound' | 'browser' | 'config';

export interface SandboxLogEntry {
  id: string;
  /** epoch ms */
  ts: number;
  /** 触发判定的工具名（file_write / shell_command / web_fetch …）；配置变更记 sandbox.<项>。 */
  tool: string;
  kind: SandboxKind;
  /** 判定对象：路径 / 命令 / URL。 */
  target: string;
  decision: SandboxDecision;
  /** 拒绝或出错的原因（放行时可为空）。 */
  reason?: string;
  /** 授权模式快照（default / trusted / paranoid）。 */
  mode?: string;
  /** 来源会话（可空：部分判定发生在会话之外）。 */
  sessionId?: string;
}

export const SANDBOX_FILE_NAME = 'sandbox-log.json';

/** 环形缓冲上限：超出后淘汰最旧条目。 */
export const SANDBOX_LOG_MAX = 500;

const KINDS: SandboxKind[] = ['path', 'command', 'network', 'approval', 'outbound', 'browser', 'config'];
const DECISIONS: SandboxDecision[] = ['allowed', 'denied', 'error'];

export function isSandboxKind(v: unknown): v is SandboxKind {
  return typeof v === 'string' && (KINDS as string[]).includes(v);
}

export function isSandboxDecision(v: unknown): v is SandboxDecision {
  return typeof v === 'string' && (DECISIONS as string[]).includes(v);
}

/** 摘要长度上限：日志条目里只留可读摘要，不放完整 stdout。 */
export const SANDBOX_DETAIL_MAX = 300;

function clip(v: unknown, max: number): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

let seq = 0;

/**
 * 归一化一条日志：缺关键字段 → null（宁可少一条，也不要不可检索的脏数据）。
 * tool / target / decision 三缺一即丢弃。
 */
export function normalizeSandboxEntry(raw: unknown): SandboxLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tool = String(r.tool ?? '').trim();
  const target = String(r.target ?? '').trim();
  if (!tool || !target) return null;
  if (!isSandboxDecision(r.decision)) return null;
  const ts = Number(r.ts);
  const out: SandboxLogEntry = {
    id: String(r.id ?? '').trim() || `sl-${Date.now().toString(36)}-${(++seq).toString(36)}`,
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    tool,
    kind: isSandboxKind(r.kind) ? r.kind : 'path',
    target,
    decision: r.decision as SandboxDecision,
  };
  const reason = clip(r.reason, SANDBOX_DETAIL_MAX);
  if (reason) out.reason = reason;
  const mode = String(r.mode ?? '').trim();
  if (mode) out.mode = mode;
  const sid = String(r.sessionId ?? '').trim();
  if (sid) out.sessionId = sid;
  return out;
}

/** 从任意输入重建日志列表：坏条目静默跳过，超量保留最新的 MAX 条。 */
export function normalizeSandboxLog(raw: unknown): SandboxLogEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: SandboxLogEntry[] = [];
  for (const item of list) {
    const e = normalizeSandboxEntry(item);
    if (e) out.push(e);
  }
  return out.slice(-SANDBOX_LOG_MAX);
}

/** 追加一条（返回新数组，环形缓冲淘汰最旧；不改原数组）。 */
export function appendSandboxLog(
  list: readonly SandboxLogEntry[],
  entry: unknown,
  now = Date.now(),
): SandboxLogEntry[] {
  const e = normalizeSandboxEntry({ ...(entry && typeof entry === 'object' ? entry : {}), ts: (entry as { ts?: unknown } | null)?.ts ?? now });
  if (!e) return [...list];
  const next = [...list, e];
  return next.length > SANDBOX_LOG_MAX ? next.slice(next.length - SANDBOX_LOG_MAX) : next;
}

export interface SandboxLogQuery {
  /** 全文关键词（tool / target / reason / sessionId，大小写不敏感）。 */
  keyword?: string;
  /** 按判定结果过滤。 */
  decision?: SandboxDecision | 'all';
  /** 按判定类型过滤。 */
  kind?: SandboxKind | 'all';
  /** 返回条数上限（默认 200，UI 不需要一次拉 500 条）。 */
  limit?: number;
}

/**
 * 检索：默认返回**最新的** N 条（审计追溯从后往前看）。
 * 关键词空 = 不按关键词过滤（不是「匹配一切」）。
 */
export function searchSandboxLog(list: readonly SandboxLogEntry[], q: SandboxLogQuery = {}): SandboxLogEntry[] {
  const kw = String(q.keyword ?? '').trim().toLowerCase();
  const decision = q.decision && q.decision !== 'all' ? q.decision : null;
  const kind = q.kind && q.kind !== 'all' ? q.kind : null;
  const limitRaw = Number(q.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 200;

  const out: SandboxLogEntry[] = [];
  // 从后往前扫，凑够 limit 即停（日志量大时不全量过滤）。
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const e = list[i];
    if (!e) continue;
    if (decision && e.decision !== decision) continue;
    if (kind && e.kind !== kind) continue;
    if (kw) {
      const hay = `${e.tool} ${e.target} ${e.reason || ''} ${e.sessionId || ''}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    out.push(e);
  }
  return out;
}

export interface SandboxLogStats {
  total: number;
  allowed: number;
  denied: number;
  error: number;
  /** 按工具名计数（降序，取前 N）。 */
  byTool: Array<{ tool: string; count: number }>;
}

export function sandboxLogStats(list: readonly SandboxLogEntry[], topN = 6): SandboxLogStats {
  const stats: SandboxLogStats = { total: list.length, allowed: 0, denied: 0, error: 0, byTool: [] };
  const counter = new Map<string, number>();
  for (const e of list) {
    if (e.decision === 'allowed') stats.allowed++;
    else if (e.decision === 'denied') stats.denied++;
    else stats.error++;
    counter.set(e.tool, (counter.get(e.tool) || 0) + 1);
  }
  stats.byTool = [...counter.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, topN);
  return stats;
}
