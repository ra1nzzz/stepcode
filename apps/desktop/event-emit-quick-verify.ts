/**
 * Phase 8 Event Emission 快速验证
 *
 * 运行：npx tsx apps/desktop/event-emit-quick-verify.ts
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitCanonicalEvent, setEnvelopeConsumer } from './event-emit';

let passed = 0;
let failed = 0;
const log: string[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log('== Phase 8: Event Emission 快速验证 ==\n');

(async () => {
  await check('emitCanonicalEvent 产出 CanonicalEnvelope 且字段完整', async () => {
    let captured: any = null;
    setEnvelopeConsumer((env) => { captured = env; });

    const dir = mkdtempSync(`${tmpdir()}${path.sep}orchdesk-ev-`);
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

    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    assert(lines.length === 1, `应写入 1 行 SessionEvent，实际 ${lines.length}`);
    const se = JSON.parse(lines[0]);
    assert(se.kind === 'user', `SessionEvent.kind 应为 user，实际 ${se.kind}`);
    assert(se.text === 'hello', 'SessionEvent.text 应一致');
  });

  await check('emitCanonicalEvent 无 consumer 时不抛错', async () => {
    setEnvelopeConsumer(null);
    const dir = mkdtempSync(`${tmpdir()}${path.sep}orchdesk-ev-`);
    const file = path.join(dir, 's2.ndjson');
    await emitCanonicalEvent('task.created', { type: 'user', id: 'u2' }, { type: 'Session', id: 's2' }, {}, { file });
    const content = readFileSync(file, 'utf-8');
    assert(content.includes('"kind":"user"'), '本地双写仍应执行');
  });

  await check('setEnvelopeConsumer 替换生效', async () => {
    let first = '', second = '';
    setEnvelopeConsumer((e) => { first = e.id; });
    await emitCanonicalEvent('t1', { type: 'user', id: 'u' }, { type: 'S', id: 's' }, {}, {});
    setEnvelopeConsumer((e) => { second = e.id; });
    await emitCanonicalEvent('t2', { type: 'user', id: 'u' }, { type: 'S', id: 's' }, {}, {});
    assert(first !== second, '两次 consumer 应不同');
    assert(first.length === 36 && second.length === 36, '两次 id 都应为 UUID');
  });

  console.log(log.join('\n'));
  console.log(`\n== 结果：${passed} passed，${failed} failed ==`);
  if (failed > 0) process.exit(1);
})();
