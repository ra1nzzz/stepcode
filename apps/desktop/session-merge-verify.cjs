/**
 * session-merge 纯逻辑核对（原 session-merge-verify.cjs 的 A 组）。
 *
 * 原套件被删是因为它的 B 组驱动 agent-turn 的 IPC；但 A 组覆盖的
 * `session-merge.ts` 仍在 `persist-sessions` 生产路径上（main.ts 调 mergeStores），
 * 不该跟着一起失去覆盖。这里把 A 组单独搬回来。
 *
 * 只核对纯函数：require dist/session-merge.js，不起 electron、不建会话。
 */
const assert = require('node:assert');
const path = require('node:path');

const sm = require('./dist/session-merge.js');

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}

function msg(role, text) { return { role, text }; }

async function main() {
  console.log('== session-merge 纯逻辑核对 ==');

  await check('合并后 stored 的回合产物不被旧快照抹掉', () => {
    const stored = {
      a: { id: 'a', msgs: [msg('user', '问题'), msg('model', '回复')] },
    };
    const snapshot = [
      { id: 'a', msgs: [msg('user', '问题')] },
    ];
    const out = sm.mergeStores(stored, snapshot);
    const texts = out.merged.a.msgs.map((m) => (m.text || m.x || m.t)).join('|');
    assert.ok(texts.includes('回复'), 'agent 回复应存活，实际 ' + texts);
    // 同一句话去重后仍是「问题 + 回复」两条，不会因为旧快照把回复抹掉。
    assert.equal(out.merged.a.msgs.length, 2, '应有一条用户消息加一条回复，实际 ' + out.merged.a.msgs.length);
  });

  await check('同 schema 内按去重键合并，不会重复同一条', () => {
    // 渲染层快照用 {r,t}，主进程写 {role,text}；同一种 schema 内的同一条不去重才会重复。
    const stored = { a: { id: 'a', msgs: [{ r: 'user', t: '问题' }] } };
    const snapshot = [{ id: 'a', msgs: [{ r: 'user', t: '问题' }] }];
    const out = sm.mergeStores(stored, snapshot);
    assert.equal(out.merged.a.msgs.length, 1, '同一 schema 的同一条应去重，实际 ' + out.merged.a.msgs.length);
  });

  await check('incoming 缺失且 stored 存在：计入删除', () => {
    const stored = { a: { id: 'a', msgs: [] } };
    const out = sm.mergeStores(stored, []);
    assert.ok(out.deleted && out.deleted.includes('a'), '未出现的会话应计入删除');
  });

  await check('isActive 为真的会话不删（回合进行中的保护）', () => {
    const stored = { a: { id: 'a', msgs: [] } };
    const out = sm.mergeStores(stored, [], { isActive: (id) => id === 'a' });
    assert.equal(out.deleted.includes('a'), false, '进行中的会话不得删除');
  });

  await check('元数据合并不丢 created，且 title 可由快照覆盖', () => {
    const stored = {
      a: { id: 'a', created: '2026-01-01T00:00:00Z', msgs: [] },
    };
    const snapshot = [
      { id: 'a', created: '2026-02-01T00:00:00Z', title: '新标题', msgs: [] },
    ];
    const out = sm.mergeStores(stored, snapshot);
    assert.ok(out.merged.a.created, 'created 不应被抹成 undefined');
    assert.equal(out.merged.a.title, '新标题', 'title 应取快照（UI 操作的事实源）');
  });

  await check('空入参不炸', () => {
    const out = sm.mergeStores({}, []);
    assert.equal(Object.keys(out.merged).length, 0, '空入参应得空 merged');
    assert.equal(out.deleted.includes('anything'), false, '空输入不应报删除');
  });

  await check('原型键防护：会话 id 为 toString 时不写穿原型', () => {
    const stored = { toString: { id: 'toString', msgs: [msg('user', 'hi')] } };
    const out = sm.mergeStores(stored, []);
    assert.equal(Object.getPrototypeOf(out.merged), null, 'merged 应为 null 原型对象');
  });

  await check('mergeSession 可用且合并两个会话', () => {
    assert.equal(typeof sm.mergeSession, 'function');
    const out = sm.mergeSession(
      { id: 'a', msgs: [msg('user', '问题')] },
      { id: 'a', msgs: [msg('user', '问题'), msg('model', '回复')] },
    );
    assert.equal(out.msgs.length, 2, '同一句话去重，回复保留，实际 ' + out.msgs.length);
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
  if (failed > 0) process.exit(1);
  console.log('SESSION_MERGE_OK');
  process.exit(0);
}

main();
