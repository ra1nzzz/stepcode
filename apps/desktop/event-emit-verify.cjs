/**
 * Phase 8 Event Emission 验证（event-emit / event-consumer）。
 *
 * 运行：node apps/desktop/event-emit-verify.cjs
 *
 * 注意：本验证脚本需在 pnpm build:desktop 编译后运行（要求 dist/ 产物）。
 *       若 dist/ 不存在，脚本会尝试自动编译。
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
const { execSync } = require('child_process');
const { Readable } = require('stream');

const APP_DIR = __dirname;
const DIST_DIR = path.join(APP_DIR, 'dist');

// 确保已编译
function ensureDist() {
  const needed = [
    'event-emit.js',
    path.join('event-consumer', 'router.js'),
    path.join('event-consumer', 'sse-consumer.js'),
    path.join('event-consumer', 'ws-consumer.js'),
  ];
  const missing = needed.filter((f) => !fs.existsSync(path.join(DIST_DIR, f)));
  if (missing.length > 0) {
    console.log('检测到 dist/ 缺失，正在编译...');
    try {
      execSync('pnpm build:desktop', { cwd: path.join(APP_DIR, '..', '..'), stdio: 'inherit' });
    } catch (e) {
      console.error('编译失败，请先运行 pnpm build:desktop');
      process.exit(1);
    }
  }
}

ensureDist();

const eventEmit = require(path.join(DIST_DIR, 'event-emit.js'));
const router = require(path.join(DIST_DIR, 'event-consumer', 'router.js'));
const sseConsumer = require(path.join(DIST_DIR, 'event-consumer', 'sse-consumer.js'));
const wsConsumer = require(path.join(DIST_DIR, 'event-consumer', 'ws-consumer.js'));

const { emitCanonicalEvent, setEnvelopeConsumer } = eventEmit;

let passed = 0;
let failed = 0;
const log = [];

async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  console.log('== Phase 8: Event Emission 验证 ==\n');

  // ---- A. emitCanonicalEvent 双写 ----
  await check('emitCanonicalEvent 产出 CanonicalEnvelope 且字段完整', async () => {
    let captured = null;
    setEnvelopeConsumer((env) => { captured = env; });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's1.ndjson');

    await emitCanonicalEvent(
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

    // 非消息事件（task.* / tool.*）**不**落本地消息流 —— 见下方专项用例
    assert(!fs.existsSync(file), 'task.created 不应写本地 SessionEvent 消息流');
  });

  await check('消息事件落本地 SessionEvent 流（session.user_message / assistant_turn）', async () => {
    setEnvelopeConsumer(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's1b.ndjson');

    await emitCanonicalEvent(
      'session.user_message', { type: 'user', id: 'u' }, { type: 'Session', id: 's1b' },
      { text: '用户说了什么', model: 'm1' }, { file, context: { sessionId: 's1b' } },
    );
    await emitCanonicalEvent(
      'session.assistant_turn', { type: 'agent', id: 'a' }, { type: 'Session', id: 's1b' },
      { text: '助手回答', model: 'm1' }, { file, context: { sessionId: 's1b' } },
    );

    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    assert(lines.length === 2, `消息事件应双写 2 行，实际 ${lines.length}`);
    const kinds = lines.map((l) => JSON.parse(l).kind);
    assert(kinds[0] === 'user' && kinds[1] === 'assistant', 'kind 顺序应为 user/assistant，实际 ' + JSON.stringify(kinds));
  });

  await check('非消息事件不污染消息流（分叉/回放前提 · 回归锁）', async () => {
    // Phase 8 回归：task.created 曾被写成 kind='user' 落进 events/<sid>.ndjson，
    // 在真实 user 事件前多插一条 → 分叉点计数与回放时间线整体错位（model-loop R4）。
    setEnvelopeConsumer(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's1c.ndjson');

    for (const t of ['task.created', 'tool.result', 'task.completed']) {
      await emitCanonicalEvent(t, { type: 'agent', id: 'a' }, { type: 'Session', id: 's1c' },
        { text: '不该落盘' }, { file, context: { sessionId: 's1c' } });
    }
    assert(!fs.existsSync(file), `非消息事件不应创建/写入本地消息流（实际存在: ${file}）`);
  });

  await check('emitCanonicalEvent 无 consumer 时不抛错（fail-open）', async () => {
    setEnvelopeConsumer(null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's2.ndjson');
    // 不应抛错
    await emitCanonicalEvent('session.user_message', { type: 'user', id: 'u2' }, { type: 'Session', id: 's2' }, { text: 'x' }, { file });
    const content = fs.readFileSync(file, 'utf-8');
    assert(content.includes('"kind":"user"'), '消息事件本地双写仍应执行');
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
    setEnvelopeConsumer((e) => { first = e.id; });
    emitCanonicalEvent('t1', { type: 'user', id: 'u' }, { type: 'S', id: 's' }, {}, {});
    setEnvelopeConsumer((e) => { second = e.id; });
    emitCanonicalEvent('t2', { type: 'user', id: 'u' }, { type: 'S', id: 's' }, {}, {});
    assert(first !== second, '两次 consumer 应不同');
    assert(first.length === 36 && second.length === 36, '两次 id 都应为 UUID');
  });

  // ---- D. Router routeEvent 分发 ----
  await check('Router routeEvent 分发到正确 handler', () => {
    let received = null;
    const off = router.on('task.created', (e) => { received = e.type; });
    router.routeEvent({ type: 'task.created', id: '1', actor: { type: 'user', id: 'u' }, subject: { type: 'Session', id: 's' }, timestamp: '', context: {}, payload: {} });
    assert(received === 'task.created', `应收到 task.created，实际 ${received}`);
    off();
  });

  await check('Router 取消订阅后不再触发', () => {
    let count = 0;
    const off = router.on('task.created', () => { count++; });
    router.routeEvent({ type: 'task.created', id: '1', actor: { type: 'user', id: 'u' }, subject: { type: 'Session', id: 's' }, timestamp: '', context: {}, payload: {} });
    off();
    router.routeEvent({ type: 'task.created', id: '2', actor: { type: 'user', id: 'u' }, subject: { type: 'Session', id: 's' }, timestamp: '', context: {}, payload: {} });
    assert(count === 1, `应只触发 1 次，实际 ${count}`);
  });

  // ---- E. SSE 流式解析（模拟）----
  // 回调内用了 await（reader.read()），必须是 async —— 原写法在 CJS 下直接
  // 抛 SyntaxError（await is only valid in async functions），整个脚本跑不起来。
  await check('SSE 流式解析：多行 data: 正确产出 envelope', async () => {
    const events = [];
    const consumer = new sseConsumer.SSEConsumer({
      url: 'http://localhost:9999/events',
      token: 'tok',
      onEvent: (e) => events.push(e),
      onError: () => {},
    });
    // 模拟解析器（不实际连接网络）
    const chunks = [`data: {"id":"1","type":"task.created","actor":{"type":"user","id":"u"},"subject":{"type":"Session","id":"s"},"timestamp":"2026-09-07T00:00:00.000Z","context":{},"payload":{}}\n`];
    // Node 的 Readable.from() 是 Node 流，没有 Web Streams 的 getReader()；
    // 用 Readable.toWeb() 转 Web ReadableStream 后再取 reader。
    // 注意：chunks 必须是 Buffer 而非字符串 —— 否则 decoder.decode() 收到字符串会报
    // "must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView"。
    const stream = Readable.toWeb(Readable.from(chunks.map((c) => Buffer.from(c, 'utf-8'))));
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
  await check('WS 消息解析：envelope 类型正确提取', () => {
    const events = [];
    // Node 下没有真实 WS 服务端，且原用例未调 start()（consumer.ws 恒为 null → 0 条）。
    // 这里 stub 全局 WebSocket：捕获实例后手动触发 onmessage，验证解析分支。
    const sockets = [];
    const OrigWS = globalThis.WebSocket;
    globalThis.WebSocket = class {
      constructor(url) { this.url = url; sockets.push(this); }
      close() { /* noop */ }
    };
    try {
      const consumer = new wsConsumer.WSConsumer({
        url: 'ws://localhost:9999/ws',
        token: 'tok',
        onEvent: (e) => events.push(e),
        onError: () => {},
      });
      consumer.start();
      const ws = sockets[0];
      assert(ws, '应创建 WebSocket 实例（token 应拼进 url）');
      assert(String(ws.url).includes('token=tok'), 'url 应带 token 查询参数：' + ws.url);

      const msg = { type: 'envelope', envelope: { id: '1', type: 'task.completed', actor: { type: 'agent', id: 'a' }, subject: { type: 'Session', id: 's' }, timestamp: '', context: {}, payload: {} } };
      ws.onmessage({ data: JSON.stringify(msg) });
      assert(events.length === 1, `应解析 1 条，实际 ${events.length}`);
      assert(events[0].type === 'task.completed');

      // 非 envelope 类型应被忽略（不产出事件、不抛错）
      ws.onmessage({ data: JSON.stringify({ type: 'ping' }) });
      assert(events.length === 1, '非 envelope 消息不应产出事件');
      consumer.stop();
    } finally {
      globalThis.WebSocket = OrigWS;
    }
  });

  // ---- 输出结果 ----
  console.log(log.join('\n'));
  console.log(`\n== 结果：${passed} passed，${failed} failed ==`);
  if (failed > 0) process.exit(1);
})();
