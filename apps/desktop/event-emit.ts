/**
 * Canonical Event Emission — 双写层（本地 SessionEvent NDJSON + Canonical Envelope）
 * ----------------------------------------------------------------------------
 * Phase 8 核心：runAgentTurn / executeTool 通过本模块 emit 事件，实现：
 *   1. 本地 SessionEvent NDJSON 追加（保留现有 append-only 不变量）
 *   2. Canonical Event Envelope 产出（供 SSE/WS 消费者推送）
 *
 * 设计约束：
 *   - 不破坏现有 SessionEvent 流（双写，不替换）
 *   - emit 失败不阻塞调用方（fail-open：本地事件流仍是权威源）
 *   - 外部消费者通过 onEnvelope 回调接入（解耦，不强制依赖 SSE/WS）
 */

import { appendEvents, type SessionEvent, type SessionEventKind } from './session-events';

/** Canonical Event Envelope（D-005）。 */
export interface CanonicalEnvelope {
  id: string;
  type: string;
  actor: { type: 'user' | 'agent' | 'system'; id: string };
  subject: { type: string; id: string };
  timestamp: string;
  context: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/** 外部消费者回调（SSE/WS 推送入口）。 */
export type EnvelopeConsumer = (envelope: CanonicalEnvelope) => void;

let consumer: EnvelopeConsumer | null = null;

/** 注册全局 envelope 消费者（仅一个；替换式）。 */
export function setEnvelopeConsumer(fn: EnvelopeConsumer | null): void {
  consumer = fn;
}

/** UUID v4（最小实现，不依赖 crypto 以兼容旧 Node）。 */
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** epoch ms → ISO-8601。 */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 构造最小 Canonical Envelope。 */
function envelope(
  type: string,
  actor: { type: CanonicalEnvelope['actor']['type']; id: string },
  subject: { type: string; id: string },
  context: Record<string, unknown>,
  payload: Record<string, unknown>,
  ts = Date.now(),
): CanonicalEnvelope {
  return { id: uuid(), type, actor, subject, timestamp: toIso(ts), context, payload };
}

// ---- 本地 SessionEvent 映射（双写的一半）----

function toSessionEventKind(type: string, actorType: string): SessionEventKind {
  if (type.startsWith('session.user_message')) return 'user';
  if (type.startsWith('session.assistant_turn')) return 'assistant';
  if (type.startsWith('session.forked')) return 'fork-origin';
  // 兜底（正常走不到：非消息事件已由 isMessageEvent 挡在本地流之外）
  return actorType === 'user' ? 'user' : 'assistant';
}

/**
 * 是否落本地 SessionEvent 消息流。
 *
 * SessionEvent NDJSON 是**消息事件流**，分叉点计数与回放时间线都建立在
 * 「只含 user / assistant / fork-origin」这个前提上。task.created、tool.result
 * 这类非消息事件若也双写进来，会在流里多出一条 kind 相同的记录，把后续事件
 * 整体挤位 —— 分叉点与回放的输入就不再可信（model-loop R4 实测回归）。
 *
 * 故：非消息事件只走 Canonical 通道（SSE/WS 消费者照常收到），不污染本地消息流。
 */
function isMessageEvent(type: string): boolean {
  return type.startsWith('session.user_message')
    || type.startsWith('session.assistant_turn')
    || type.startsWith('session.forked');
}

function sessionEventFromEnvelope(ev: CanonicalEnvelope): SessionEvent {
  const kind = toSessionEventKind(ev.type, ev.actor.type);
  const text = typeof ev.payload.text === 'string' ? ev.payload.text : undefined;
  const model = typeof ev.payload.model === 'string' ? ev.payload.model : undefined;
  const tools = Array.isArray(ev.payload.tools)
    ? ev.payload.tools.map((t: Record<string, unknown>) => ({
        name: String(t.name || ''),
        phase: (t.phase === 'error' ? 'error' : t.phase === 'running' ? 'running' : 'done') as 'running' | 'done' | 'error',
        result: typeof t.result === 'string' ? t.result : undefined,
      }))
    : undefined;
  const tok = ev.payload.tok && typeof ev.payload.tok === 'object'
    ? { p: Number((ev.payload.tok as Record<string, unknown>).p || 0), c: Number((ev.payload.tok as Record<string, unknown>).c || 0) }
    : undefined;
  return { seq: 0, ts: Date.now(), kind, text, model, tools, tok };
}

// ---- 公共 API ----

/**
 * 发射 Canonical Event（双写）。
 *
 * 1. 追加本地 SessionEvent NDJSON —— **仅消息类事件**（见 isMessageEvent）；
 *    非消息事件写进去会破坏分叉/回放依赖的消息流前提
 * 2. 产出 CanonicalEnvelope 并推送给注册的消费者（SSE/WS）—— 所有事件都推
 *
 * @param type   canonical 事件类型（如 `task.created`、`tool.result`）
 * @param actor  触发者
 * @param subject 主体
 * @param payload 结构化载荷
 * @param opts   附加选项
 */
export async function emitCanonicalEvent(
  type: string,
  actor: { type: CanonicalEnvelope['actor']['type']; id: string },
  subject: { type: string; id: string },
  payload: Record<string, unknown>,
  opts?: { file?: string; context?: Record<string, unknown> },
): Promise<void> {
  const ev = envelope(type, actor, subject, opts?.context || {}, payload);

  // 1) 本地双写（失败仅 warn，不抛错）—— 只写消息类事件
  try {
    if (opts?.file && isMessageEvent(type)) {
      const se = sessionEventFromEnvelope(ev);
      const w = await appendEvents(opts.file, [se]);
      if (!w.ok) console.warn(`[orchdesk] canonical event 本地写入失败: ${w.reason}`);
    }
  } catch (err) {
    console.warn(`[orchdesk] canonical event 本地写入异常: ${(err as Error).message}`);
  }

  // 2) 推送给外部消费者（SSE/WS）
  try {
    if (consumer) consumer(ev);
  } catch (err) {
    console.warn(`[orchdesk] canonical event 推送异常: ${(err as Error).message}`);
  }
}
