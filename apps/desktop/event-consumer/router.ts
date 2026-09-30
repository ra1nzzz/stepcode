/**
 * Canonical Event Router — 事件分发
 * ----------------------------------------------------------------------------
 * 将 Canonical Event Envelope 按 type 分发给注册的 handler。
 * 消费端（SSE/WS）只负责收，路由由本模块负责分。
 */

import type { CanonicalEnvelope } from '../event-emit';

/** 事件处理器。 */
export type EventHandler = (envelope: CanonicalEnvelope) => void;

/** 路由表（type → handler[]）。 */
const handlers = new Map<string, EventHandler[]>([
  ['task.created', [onTaskCreated]],
  ['task.completed', [onTaskCompleted]],
  ['task.updated', [onTaskUpdated]],
  ['session.user_message', [onSessionUserMessage]],
  ['session.assistant_turn', [onSessionAssistantTurn]],
  ['session.forked', [onSessionForked]],
  ['tool.result', [onToolResult]],
  ['approval.created', [onApprovalCreated]],
  ['agent.spawned', [onAgentSpawned]],
  ['agent.disposed', [onAgentDisposed]],
]);

/** 注册自定义 handler（追加式；同 type 可多个）。 */
export function on(type: string, fn: EventHandler): () => void {
  const list = handlers.get(type) || [];
  list.push(fn);
  handlers.set(type, list);
  return () => {
    const next = handlers.get(type) || [];
    handlers.set(type, next.filter((f) => f !== fn));
  };
}

/** 路由一条事件。 */
export function routeEvent(envelope: CanonicalEnvelope): void {
  const list = handlers.get(envelope.type) || [];
  for (const fn of list) {
    try { fn(envelope); } catch (e) { console.error('[orchdesk] event handler error:', e); }
  }
}

// ---- 内置 handler（占位：Phase 8 实现具体逻辑）----

function onTaskCreated(_e: CanonicalEnvelope): void {
  // TODO Phase 8: UI 新增任务卡片
}
function onTaskCompleted(_e: CanonicalEnvelope): void {
  // TODO Phase 8: 记忆晋升候选
}
function onTaskUpdated(_e: CanonicalEnvelope): void {
  // TODO Phase 8: UI 刷新任务状态
}
function onSessionUserMessage(_e: CanonicalEnvelope): void {
  // TODO Phase 8: 会话列表高亮
}
function onSessionAssistantTurn(_e: CanonicalEnvelope): void {
  // TODO Phase 8: 时间线更新
}
function onSessionForked(_e: CanonicalEnvelope): void {
  // TODO Phase 8: 血缘树展开
}
function onToolResult(_e: CanonicalEnvelope): void {
  // TODO Phase 8: 工具结果审计
}
function onApprovalCreated(_e: CanonicalEnvelope): void {
  // TODO Phase 8: 授权弹窗
}
function onAgentSpawned(_e: CanonicalEnvelope): void {
  // TODO Phase 8: SubAgent 芯片新增
}
function onAgentDisposed(_e: CanonicalEnvelope): void {
  // TODO Phase 8: SubAgent 芯片移除
}
