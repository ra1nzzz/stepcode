/**
 * 分层记忆晋升审计（PRD FR-10「Worker 输出须经 Director 过滤才能晋升上层」）
 * ----------------------------------------------------------------------------
 * 纯逻辑层，零 electron 依赖（与 sandbox-log.ts / data-dir.ts 同一约定）。
 *
 * PRD 原文要求「director→project / 任意→global 须显式操作并写审计」——
 * 晋升是把 Agent 的临时结论搬进长期记忆的动作，方向不可逆（Worker 的垃圾结论
 * 一旦进了 global 域，之后每轮都会污染召回）。所以每一次晋升，无论成功失败，
 * 都要留下可追溯的记录：谁、何时、从哪个域到哪个域、Director 放没放行、为什么。
 *
 * 设计取舍（与沙箱日志保持一致）：
 * - **成功与失败都记**：被 Director 驳回的晋升比成功的更有审计价值——它说明
 *   「Worker 试图往上层写东西，但被拦了」。只记成功等于把拦截的证据抹掉。
 * - **环形缓冲（200 条）**：晋升比沙箱判定稀疏得多，容量小一档即可。
 * - **写穿落盘**：与沙箱日志同节奏，安全审计不留「刚发生就崩了」的窗口。
 * - **只存摘要不存全文**：完整正文在对应域的条目里，审计条目里留全文会让文件
 *   随记忆体积线性膨胀，且审计检索时多半只想看「晋升了什么」而不是「内容是什么」。
 */

/** 四域（与 packages/plugin/memory 的 MemoryDomain 对齐，此处不引入依赖）。 */
export type MemoryDomainName = 'global' | 'project' | 'director' | 'worker';

export const MEMORY_DOMAINS: MemoryDomainName[] = ['global', 'project', 'director', 'worker'];

export interface PromotionEntry {
  id: string;
  /** epoch ms */
  ts: number;
  from: MemoryDomainName;
  to: MemoryDomainName;
  /** 被晋升的记忆条目 id。 */
  memoryId: string;
  /** 正文摘要（截断，审计不存全文）。 */
  preview: string;
  /** 是否晋升成功。false = 被拦截或出错（reason 说明原因）。 */
  ok: boolean;
  /**
   * 结果说明。成功时形如 `promoted:worker->director`；
   * 失败时形如 `director-rejected:<原因>` / `brain-filter-unavailable` /
   * `entry-not-found` / `same-domain` / `error:<消息>`。
   */
  reason: string;
  /** 触发来源：用户在设置页手动点，还是自动晋升通道。 */
  actor: 'user' | 'auto';
}

export const PROMOTION_FILE_NAME = 'memory-promotions.json';

/** 环形缓冲上限：超出后淘汰最旧条目。 */
export const PROMOTION_LOG_MAX = 200;

/** 审计摘要上限。 */
export const PROMOTION_PREVIEW_MAX = 120;

export function isMemoryDomain(v: unknown): v is MemoryDomainName {
  return typeof v === 'string' && (MEMORY_DOMAINS as string[]).includes(v);
}

function clip(v: unknown, max: number): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

let seq = 0;

/**
 * 归一化一条审计：缺 from / to / memoryId → null。
 * 这三个字段是审计的检索维度，缺任何一个都定位不到被晋升的条目。
 */
export function normalizePromotionEntry(raw: unknown): PromotionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isMemoryDomain(r.from) || !isMemoryDomain(r.to)) return null;
  const memoryId = String(r.memoryId ?? '').trim();
  if (!memoryId) return null;
  const ts = Number(r.ts);
  return {
    id: String(r.id ?? '').trim() || `pm-${Date.now().toString(36)}-${(++seq).toString(36)}`,
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    from: r.from,
    to: r.to,
    memoryId,
    preview: clip(r.preview, PROMOTION_PREVIEW_MAX),
    ok: r.ok === true,
    reason: clip(r.reason, 200),
    actor: r.actor === 'auto' ? 'auto' : 'user',
  };
}

/** 从任意输入重建审计列表：坏条目静默跳过，超量保留最新的 MAX 条。 */
export function normalizePromotionLog(raw: unknown): PromotionEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: PromotionEntry[] = [];
  for (const item of list) {
    const e = normalizePromotionEntry(item);
    if (e) out.push(e);
  }
  return out.slice(-PROMOTION_LOG_MAX);
}

/** 追加一条（返回新数组，环形缓冲淘汰最旧；不改原数组）。 */
export function appendPromotionLog(
  list: readonly PromotionEntry[],
  entry: unknown,
  now = Date.now(),
): PromotionEntry[] {
  const merged = entry && typeof entry === 'object'
    ? { ...entry, ts: (entry as { ts?: unknown }).ts ?? now }
    : { ts: now };
  const e = normalizePromotionEntry(merged);
  if (!e) return [...list];
  const next = [...list, e];
  return next.length > PROMOTION_LOG_MAX ? next.slice(next.length - PROMOTION_LOG_MAX) : next;
}

export interface PromotionLogQuery {
  /** 全文关键词（memoryId / preview / reason，大小写不敏感）。 */
  keyword?: string;
  /** 按目标域过滤。 */
  to?: MemoryDomainName | 'all';
  /** 按源域过滤。 */
  from?: MemoryDomainName | 'all';
  /**
   * 只看成功 / 只看被拦截；不传 = 都看。
   * 兼容字符串 'true' / 'false'：渲染层的 <select> value 一定是字符串，
   * 只认布尔会让过滤静默失效（UI 上看着「已切换」但列表没变）。
   */
  ok?: boolean | 'all' | 'true' | 'false';
  /** 返回条数上限（默认 100）。 */
  limit?: number;
}

/** 检索：默认返回**最新的** N 条（审计从后往前看）。关键词空 = 不过滤。 */
export function searchPromotionLog(
  list: readonly PromotionEntry[],
  q: PromotionLogQuery = {},
): PromotionEntry[] {
  const kw = String(q.keyword ?? '').trim().toLowerCase();
  const to = q.to && q.to !== 'all' ? q.to : null;
  const from = q.from && q.from !== 'all' ? q.from : null;
  const okFilter = typeof q.ok === 'boolean' ? q.ok : q.ok === 'true' ? true : q.ok === 'false' ? false : null;
  const limitRaw = Number(q.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 100;

  const out: PromotionEntry[] = [];
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const e = list[i];
    if (!e) continue;
    if (to && e.to !== to) continue;
    if (from && e.from !== from) continue;
    if (okFilter !== null && e.ok !== okFilter) continue;
    if (kw) {
      const hay = `${e.memoryId} ${e.preview} ${e.reason}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    out.push(e);
  }
  return out;
}

export interface PromotionStats {
  total: number;
  promoted: number;
  rejected: number;
  /** 按「from->to」边计数（降序，取前 N）。 */
  byEdge: Array<{ edge: string; count: number }>;
}

export function promotionStats(list: readonly PromotionEntry[], topN = 6): PromotionStats {
  const stats: PromotionStats = { total: list.length, promoted: 0, rejected: 0, byEdge: [] };
  const counter = new Map<string, number>();
  for (const e of list) {
    if (e.ok) stats.promoted++;
    else stats.rejected++;
    const edge = `${e.from}->${e.to}`;
    counter.set(edge, (counter.get(edge) || 0) + 1);
  }
  stats.byEdge = [...counter.entries()]
    .map(([edge, count]) => ({ edge, count }))
    .sort((a, b) => b.count - a.count || a.edge.localeCompare(b.edge))
    .slice(0, topN);
  return stats;
}
