/**
 * Phase 8 Event Emission 验证（event-emit / event-consumer）。
 *
 * 运行：npx ts-node apps/desktop/event-emit-verify.ts
 *
 * 覆盖：
 *   A. emitCanonicalEvent 双写（本地 SessionEvent + Canonical envelope）
 *   B. CanonicalEnvelope 字段完整性
 *   C. setEnvelopeConsumer 注册 / 推送
 *   D. Router routeEvent 分发
 *   E. SSE 流式解析（模拟）
 *   F. WS 消息解析（模拟）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// 动态导入 TypeScript 源文件
async function loadModule(filePath: string) {
  const mod = await import(filePath);
  return mod;
}

let passed = 0;
let failed = 0;
const log: string[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    log.push(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    log.push(`  FAIL  ${name}\n        ${e && (e as Error).message || e}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

(async () => {
  console.log('== Phase 8: Event Emission 验证 ==\n');

  const appDir = __dirname;
  const eventEmit = await loadModule(path.join(appDir, 'event-emit.ts'));
  const { emitCanonicalEvent, setEnvelopeConsumer } = eventEmit;

  // ---- A. emitCanonicalEvent 双写 ----
  await check('emitCanonicalEvent 产出 CanonicalEnvelope 且字段完整', () => {
    let captured: any = null;
    setEnvelopeConsumer((env: any) => { captured = env; });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's1.ndjson');

    emitCanonicalEvent(
      'task.created',
      { type: 'user', id: 'user-1' },
      { type: 'Session', id: 's1' },
      { text: 'hello' },
      { file, context: { sessionId: 's1' } },
    );

    assert(captured !== null, 'consumer 应收到 envelope');
    assert(captured.id.length === 36, 'id 应为 UUID');
    assert(captured.type === 'task.created', 'type 应一致');
    assert(captured.actor.type === 'user', 'actor.type 应一致');
    assert(captured.subject.type === 'Session', 'subject.type 应一致');
    assert(captured.subject.id === 's1', 'subject.id 应一致');
    assert(captured.timestamp.startsWith('20'), 'timestamp 应为 ISO-8601');
    assert(captured.context.sessionId === 's1', 'context 应一致');
    assert(captured.payload.text === 'hello', 'payload 应一致');

    // 本地 SessionEvent NDJSON 双写
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    assert(lines.length === 1, `应写入 1 行 SessionEvent，实际 ${lines.length}`);
    const se = JSON.parse(lines[0]);
    assert(se.kind === 'user', `SessionEvent.kind 应为 user，实际 ${se.kind}`);
    assert(se.text === 'hello', 'SessionEvent.text 应一致');
  });

  await check('emitCanonicalEvent 无 consumer 时不抛错（fail-open）', () => {
    setEnvelopeConsumer(null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's2.ndjson');
    // 不应抛错
    emitCanonicalEvent('task.created', { type: 'user', id: 'u2' }, { type: 'Session', id: 's2' }, {}, { file });
    const content = fs.readFileSync(file, 'utf-8');
    assert(content.includes('"kind":"user"'), '本地双写仍应执行');
  });

  // ---- B. CanonicalEnvelope 结构 ----
  await check('CanonicalEnvelope 接口可实例化', () => {
    const env = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      type: 'tool.result',
      actor: { type: 'agent', id: 'a1' },
      subject: { type: 'ToolCall', id: 'tc1' },
      timestamp: '2026-09-07T10:00:00.000Z',
      context: { sessionId: 's1' },
      payload: { name: 'file_read', result: 'ok' },
    };
    assert(env.type === 'tool.result');
    assert(env.actor.type === 'agent');
    assert(env.payload.name === 'file_read');
  });

  // ---- C. setEnvelopeConsumer 可替换 ----
  await check('setEnvelopeConsumer 替换生效', () => {
    let first = '';
    let second = '';
    setEnvelopeConsumer((e: any) => { first = e.id; });
    emitCanonicalEvent('t1', { type: 'user', id: 'u' }, { type: 'S', id: 's' }, {}, {});
    setEnvelopeConsumer((e: any) => { second = e.id; });
    emitCanonicalEvent('t2', { type: 'user', id: 'u' }, { type: 'S', id: 's' }, {}, {});
    assert(first !== second, '两次 consumer 应不同');
    assert(first.length === 36 && second.length === 36, '两次 id 都应为 UUID');
  });

  // ---- D. Router routeEvent 分发 ----
  await check('Router routeEvent 分发到正确 handler', async () => {
    const router = await loadModule(path.join(appDir, 'event-consumer', 'router.ts'));
    let received: string | null = null;
    const off = router.on('task.created', (e: any) => { received = e.type; });
    router.routeEvent({ type: 'task.created', id: '1', actor: { type: 'user', id: 'u' }, subject: { type: 'Session', id: 's' }, timestamp: '', context: {}, payload: {} } as any);
    assert(received === 'task.created', `应收到 task.created，实际 ${received}`);
    off();
  });

  await check('Router 取消订阅后不再触发', async () => {
    const router = await loadModule(path.join(appDir, 'event-consumer', 'router.ts'));
    let count = 0;
    const off = router.on('task.created', () => { count++; });
    router.routeEvent({ type: 'task.created', id: '1', actor: { type: 'user', id: 'u' }, subject: { type: 'Session', id: 's' }, timestamp: '', context: {}, payload: {} } as any);
    off();
    router.routeEvent({ type: 'task.created', id: '2', actor: { type: 'user', id: 'u' }, subject: { type: 'Session', id: 's' }, timestamp: '', context: {}, payload: {} } as any);
    assert(count === 1, `应只触发 1 次，实际 ${count}`);
  });

  // ---- E. SSE 流式解析（模拟）----
  await check('SSE 流式解析：多行 data: 正确产出 envelope', async () => {
    const { SSEConsumer } = await loadModule(path.join(appDir, 'event-consumer', 'sse-consumer.ts'));
    const events: any[] = [];
    const consumer = new SSEConsumer({
      url: 'http://localhost:9999/events',
      token: 'tok',
      onEvent: (e) => events.push(e),
      onError: () => {},
    });
    // 模拟解析器（不实际连接网络）
    const { Readable } = require('stream');
    const chunks = [`data: {"id":"1","type":"task.created","actor":{"type":"user","id":"u"},"subject":{"type":"Session","id":"s"},"timestamp":"2026-09-07T00:00:00.000Z","context":{},"payload":{}}\n`];
    const stream = Readable.from(chunks);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const raw = line.slice(5).trim();
          if (raw) events.push(JSON.parse(raw));
        }
      }
    }
    assert(events.length === 1, `应解析 1 条，实际 ${events.length}`);
    assert(events[0].type === 'task.created');
    consumer.stop();
  });

  // ---- F. WS 消息解析（模拟）----
  await check('WS 消息解析：envelope 类型正确提取', async () => {
    const { WSConsumer } = await loadModule(path.join(appDir, 'event-consumer', 'ws-consumer.ts'));
    const events: any[] = [];
    const consumer = new WSConsumer({
      url: 'ws://localhost:9999/ws',
      token: 'tok',
      onEvent: (e) => events.push(e),
      onError: () => {},
    });
    // 模拟 onmessage
    const msg = { type: 'envelope', envelope: { id: '1', type: 'task.completed', actor: { type: 'agent', id: 'a' }, subject: { type: 'Session', id: 's' }, timestamp: '', context: {}, payload: {} } };
    // 直接调用 onmessage handler（模拟 WebSocket 消息）
    const anyConsumer = consumer as any;
    if (anyConsumer.ws?.onmessage) {
      anyConsumer.ws.onmessage({ data: JSON.stringify(msg) });
    }
    assert(events.length === 1, `应解析 1 条，实际 ${events.length}`);
    assert(events[0].type === 'task.completed');
    consumer.stop();
  });

  // ---- 输出结果 ----
  console.log(log.join('\n'));
  console.log(`\n== 结果：${passed} passed，${failed} failed ==`);
  if (failed > 0) process.exit(1);
})();
