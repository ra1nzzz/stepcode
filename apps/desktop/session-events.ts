/**
 * SessionEvent append-only 事件日志（PRD FR-6，ADR-0009）。
 *
 * 纯逻辑、零 electron 依赖，可在 node 直测（session-events-verify.cjs）。
 *
 * 职责：
 *   1. 每会话一个 NDJSON 事件日志（`dataDir()/events/<sessionId>.ndjson`），
 *      一行一个事件，只追加不改写（append-only 不变量：写过的行绝不修改）；
 *   2. 事件种类：`user` / `assistant`（模型可见必入日志，含工具步骤与 token 用量）/
 *      `fork-origin`（分叉血缘——子日志不拷贝父事件，只记一条血缘）;
 *   3. 回放时间线重建（沿血缘链递归拼接父事件前缀，深度上限防环）；
 *   4. 上下文重建（从事件流产出 [{role, text}]，分叉子分支的模型上下文不依赖消息数组）。
 *
 * 与 sessions.json 的关系（ADR-0009）：
 *   - sessions.json = 运行态存储（渲染层消息流的事实源）；
 *   - 事件流 = 回放 / 分叉上下文重建的权威源；同源双写，不互相同步。
 *   - 历史会话没有事件日志 → 调用方回退消息数组重建并显式标注 legacy，不假装达成。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 事件种类。user/assistant 是「消息事件」（计入分叉点计数），fork-origin 是血缘标记。
 * @canonical SessionEventKind — 与 Canonical SessionEvent.kind 对齐（user/assistant/fork-origin）。
 */
export type SessionEventKind = 'user' | 'assistant' | 'fork-origin';

/** 单条工具步骤（assistant 事件内的工具调用子条目）。
 * @canonical SessionToolStep — 映射到 Canonical ToolCall + ToolResult（phase/result 对应 execution status）。
 */
export interface SessionToolStep {
  name: string;
  phase: 'running' | 'done' | 'error';
  result?: string;
}

/** 会话事件（append-only NDJSON 单行）。
 * @canonical SessionEvent — 投影 DSH Session 事件日志（seq=单调序号，kind=事件类型，text=内容，tools=工具链，tok=用量）。
 */
export interface SessionEvent {
  /** 会话内单调递增序号（从 1 起）。 */
  seq: number;
  /** epoch ms。 */
  ts: number;
  kind: SessionEventKind;
  /** user / assistant 正文（模型可见必入日志）。 */
  text?: string;
  /** assistant：模型名。 */
  model?: string;
  /** assistant：本轮工具步骤。 */
  tools?: SessionToolStep[];
  /** assistant：本回合 token 用量（FR-5 顺带入事件；网关未上报则缺省）。 */
  tok?: { p: number; c: number };
  /** fork-origin：源会话 id / 标题快照 / 分叉点（继承前 atIndex 条消息）。 */
  from?: string;
  fromTitle?: string;
  atIndex?: number;
}

/** 血缘链递归深度上限（防环 / 防超长链拖垮回放）。 */
export const FORK_DEPTH_MAX = 8;

/* ---------------------------------------------------------------------------
 * 会话 id 防线（路径穿越拒绝）
 * ------------------------------------------------------------------------- */

/**
 * 会话 id 只允许 `[A-Za-z0-9_-]`。渲染层生成的 id 形如 `s<base36 时间戳>`；
 * 任何含 `/`、`\`、`..` 的 key 都不落 `events/` 目录。
 */
export function sanitizeSessionId(sid: unknown): string | null {
  if (typeof sid !== 'string') return null;
  if (!sid.length || sid.length > 128) return null;
  return /^[A-Za-z0-9_-]+$/.test(sid) ? sid : null;
}

export function eventsDir(dataDir: string): string {
  return path.join(dataDir, 'events');
}

export function eventFileFor(dataDir: string, sid: string): string {
  const clean = sanitizeSessionId(sid);
  if (!clean) throw new Error(`非法会话 id：${String(sid)}`);
  return path.join(eventsDir(dataDir), `${clean}.ndjson`);
}

/* ---------------------------------------------------------------------------
 * 读取与追加（append-only）
 * ------------------------------------------------------------------------- */

/** 读一个会话的事件日志。文件不存在 / 单行坏 JSON → 跳过坏行（append-only 日志的常规韧性）。 */
export function readEvents(file: string): SessionEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: SessionEvent[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s) as SessionEvent;
      if (ev && typeof ev === 'object' && typeof ev.kind === 'string') out.push(ev);
    } catch { /* 坏行跳过，不中断回放 */ }
  }
  return out;
}

/**
 * 追加事件（写穿）。seq 在现有最大 seq 上递增，调用方无需自己算。
 * 返回实际写入的事件（含分配好的 seq）；file 参数非法 sid 抛错由调用方兜。
 */
export function appendEvents(file: string, events: Array<Omit<SessionEvent, 'seq'>>): { ok: boolean; written?: SessionEvent[]; reason?: string } {
  if (!events.length) return { ok: true, written: [] };
  const existing = readEvents(file);
  let seq = existing.length ? Math.max(...existing.map((e) => Number(e.seq) || 0)) : 0;
  // 坏行被 readEvents 跳过，但其 seq 仍占用序号位——扫原始行回收最大 seq，避免重号
  // （审阅裁决：append-only 日志 seq 重号会让「按 seq 定位分叉点」失真）。
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    for (const m of raw.matchAll(/"seq"\s*:\s*(\d+)/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > seq) seq = n;
    }
  } catch { /* 文件尚不存在，无需回收 */ }
  const written: SessionEvent[] = events.map((ev) => ({ seq: ++seq, ...ev }));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, written.map((ev) => JSON.stringify(ev)).join('\n') + '\n', 'utf-8');
    return { ok: true, written };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/* ---------------------------------------------------------------------------
 * 分叉前缀与上下文重建
 * ------------------------------------------------------------------------- */

/** 消息事件（计入分叉点计数的是 user/assistant；fork-origin 不占消息位）。 */
export function isMessageEvent(ev: SessionEvent): boolean {
  return ev.kind === 'user' || ev.kind === 'assistant';
}

/**
 * 「按消息位计数、atIndex 截断」的唯一实现——单会话前缀（forkPrefixEvents）与
 * 跨块拼接（prefixLabeled）共用同一份截断语义（审阅裁决：血缘截断是 ADR-0009
 * 最易错的语义，两份拷贝有发散风险）。
 */
function prefixByMessageCount<T>(list: T[], atIndex: number, evOf: (item: T) => SessionEvent): T[] {
  let count = 0;
  const out: T[] = [];
  for (const item of list) {
    if (isMessageEvent(evOf(item))) {
      if (count >= atIndex) break;
      count += 1;
    }
    out.push(item);
  }
  return out;
}

/**
 * 取父事件日志中「第 atIndex 条消息（含）之前」的事件前缀。
 * atIndex 超界按全量处理；atIndex 不是真数字按 0 处理由调用方保证——
 * 这里与 session-fork.js forkMessages 同一语义：null/undefined 已在血缘层夹紧。
 */
export function forkPrefixEvents(events: SessionEvent[], atIndex: number): SessionEvent[] {
  return prefixByMessageCount(events, atIndex, (ev) => ev);
}

/**
 * 回放时间线：沿血缘链递归拼接。
 *
 * 截断语义：每个 fork-origin 的 atIndex 作用于「它之前的全部祖先事件」（跨层
 * 计数消息事件），祖先链按此逐级截断 —— 分叉点之后父会话的独立写入不得漏进
 * 子分支回放。祖先事件 seq 带深度前缀（p1#/p2#…），与子会话各自独立计数的
 * seq 区分开。
 *
 * 输出与渲染层回放视图同形：[{ seq, kind, label, detail, ts }]。
 * kind 用 user/agent/tool/fork-origin——与 session-fork.js REPLAY_KIND_LABELS 对齐。
 */

interface TimelineBlock {
  events: SessionEvent[];
  prefix: string;
  /** 本块fork-origin 的 atIndex（祖先块为 null = 不截断）。 */
  atIndex: number | null;
}

/** 深度优先收集血缘块（祖先在前，本会话在最后）。 */
function collectBlocks(loadLog: (sid: string) => SessionEvent[], sid: string, depth: number, out: TimelineBlock[]): void {
  if (depth > FORK_DEPTH_MAX) return;
  const events = loadLog(sid);
  const forkEv = events.find((ev) => ev.kind === 'fork-origin');
  if (forkEv && forkEv.from) collectBlocks(loadLog, String(forkEv.from), depth + 1, out);
  out.push({
    events,
    prefix: depth > 0 ? `p${depth}` : '',
    atIndex: forkEv ? (Number.isFinite(forkEv.atIndex) ? Number(forkEv.atIndex) : 0) : null,
  });
}

/** 带 seq 前缀标注的事件项。 */
export interface LabeledEvent { ev: SessionEvent; prefix: string }

/** forkPrefixEvents 的标注版（与单块版本共用 prefixByMessageCount 截断语义）。 */
function prefixLabeled(list: LabeledEvent[], atIndex: number): LabeledEvent[] {
  return prefixByMessageCount(list, atIndex, (it) => it.ev);
}

/** 沿血缘链收集（祖先前缀截断后拼接）。导出供 IPC 一次读盘同时派生时间线与上下文——审阅修复：此前 loadLog 链在一次请求里被重复读 3 遍。 */
export function collectLabeled(loadLog: (sid: string) => SessionEvent[], sid: string, depth = 0): LabeledEvent[] {
  const blocks: TimelineBlock[] = [];
  collectBlocks(loadLog, sid, 0, blocks);
  let combined: LabeledEvent[] = [];
  for (const b of blocks) {
    const part: LabeledEvent[] = b.events.map((ev) => ({ ev, prefix: b.prefix }));
    combined = (b.atIndex == null ? part : prefixLabeled(combined, b.atIndex).concat(part));
  }
  return combined;
}

/**
 * 祖先链完整性检查：任一 fork-origin 指向的父日志为空（父从未入事件流——典型是
 * legacy 历史会话先被分叉）→ 血缘时间线必然缺失继承前缀。调用方必须整体回落
 * 消息数组重建并标注 legacy，不能拿残缺事件流冒充完整回放（审阅抓出的真 bug：
 * 此种子会话回放只剩分叉标记 + 新回合，继承消息全部消失）。
 */
export function hasIncompleteAncestry(loadLog: (sid: string) => SessionEvent[], sid: string, depth = 0): boolean {
  if (depth > FORK_DEPTH_MAX) return false;
  const events = loadLog(sid);
  const forkEv = events.find((ev) => ev.kind === 'fork-origin');
  if (!forkEv || !forkEv.from) return false;
  const from = String(forkEv.from);
  if (!loadLog(from).length) return true;
  return hasIncompleteAncestry(loadLog, from, depth + 1);
}

/** 全量血缘事件（含截断）——上下文重建用。 */
export function collectLineageEvents(loadLog: (sid: string) => SessionEvent[], sid: string, depth = 0): SessionEvent[] {
  return collectLabeled(loadLog, sid, depth).map((x) => x.ev);
}

/** 时间线条目（与渲染层回放视图同形）。 */
export interface TimelineItem { seq: string; kind: string; label: string; detail: string; ts: string }

/**
 * 从已收集的标注事件构建时间线——与 collectLabeled 配套，调用方可一次读盘
 * 同时派生时间线与上下文（不必让 loadLog 链重复执行）。
 */
export function timelineFromLabeled(labeled: LabeledEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];

  const push = (ev: SessionEvent, seqLabel: string) => {
    const when = new Date(ev.ts).toLocaleString('zh-CN');
    if (ev.kind === 'fork-origin') {
      items.push({
        seq: seqLabel, kind: 'fork-origin', label: '分叉起点',
        detail: `继承自「${ev.fromTitle || ev.from || '?'}」第 ${ev.atIndex ?? 0} 条消息之后`,
        ts: when,
      });
      return;
    }
    if (ev.kind === 'user') {
      items.push({ seq: seqLabel, kind: 'user', label: '你', detail: ev.text || '', ts: when });
      return;
    }
    // assistant：主条目 + 工具步骤子条目（与消息内先 tool 后正文的消息顺序对齐）
    for (const t of ev.tools || []) {
      items.push({
        seq: seqLabel, kind: 'tool', label: `工具 · ${t.name}`,
        detail: (t.result || '').slice(0, 160) + (t.phase === 'error' ? '（出错）' : ''),
        ts: when,
      });
    }
    items.push({ seq: seqLabel, kind: 'agent', label: ev.model ? `模型 · ${ev.model}` : '模型', detail: ev.text || '', ts: when });
  };

  for (const item of labeled) {
    push(item.ev, `${item.prefix}#${item.ev.seq}`);
  }
  return items;
}

export function buildTimeline(
  loadLog: (sid: string) => SessionEvent[],
  sid: string,
  depth = 0,
): TimelineItem[] {
  return timelineFromLabeled(collectLabeled(loadLog, sid, depth));
}

/**
 * 上下文重建：从事件流产出模型可回灌的 [{role, text}]。
 * 工具步骤不回灌（与 runAgentTurn「tool 步骤不回灌模型」同一约定）。
 */
export function rebuildContext(events: SessionEvent[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const ev of events) {
    if (ev.kind === 'user' && ev.text) out.push({ role: 'user', text: ev.text });
    if (ev.kind === 'assistant' && ev.text) out.push({ role: 'assistant', text: ev.text });
  }
  return out;
}
