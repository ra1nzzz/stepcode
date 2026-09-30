/**
 * 会话合并验证（复审项⑤：persist-sessions 读-改-写竞态）。
 * 进程内直驱纯函数 + 经 stub electron + 假网关驱动**真实 runAgentTurn**：
 * 主进程写入 assistant 回复后，渲染层旧快照 persist 不得将其抹掉。
 */
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('node:module');
const sm = require('./dist/session-merge.js');
const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');

const { check, summary } = createChecker();

/* ---------- 纯函数层 ---------- */
check('msgs 合并：stored 的 agent 回复不被旧快照抹掉', () => {
  const stored = { id: 's1', title: 't', msgs: [
    { role: 'user', t: '10:00:00', text: 'hi' },
    { role: 'assistant', t: '10:00:01', text: 'reply' },
  ] };
  const incoming = { id: 's1', title: 't', msgs: [ { r: 'user', t: '10:00:00', x: 'hi' } ] };
  const out = sm.mergeSession(stored, incoming);
  assert.strictEqual(out.msgs.length, 2, '应保留 agent 回复，实际 ' + out.msgs.length);
  assert.strictEqual(out.msgs[1].text, 'reply');
});

check('msgs 合并：incoming 有新消息时追加', () => {
  const stored = { id: 's1', msgs: [ { role: 'user', t: '10:00:00', text: 'a' } ] };
  const incoming = { id: 's1', msgs: [ { role: 'user', t: '10:00:00', text: 'a' }, { r: 'user', t: '10:00:05', x: 'b' } ] };
  const out = sm.mergeSession(stored, incoming);
  assert.strictEqual(out.msgs.length, 2, '应追加 incoming 新消息');
  assert.strictEqual(out.msgs[1].x, 'b');
});

check('mergeStores：删除语义 + 进行中回合保护 + 采纳新建', () => {
  const store = {
    keep: { id: 'keep', title: 't', msgs: [{ role: 'assistant', t: '1', text: 'x' }] },
    del: { id: 'del', msgs: [{ role: 'user', t: '1', text: 'y' }] },
    busy: { id: 'busy', msgs: [{ role: 'user', t: '1', text: 'z' }] },
  };
  const snapshot = [ { id: 'keep', msgs: [] } ];
  const r = sm.mergeStores(store, snapshot, { isActive: (id) => id === 'busy' });
  assert.deepStrictEqual(r.deleted, ['del'], '未在快照中且无活动回合 → 删除');
  assert.ok(r.merged.busy, '进行中回合的会话不得被旧快照删除');
  assert.strictEqual(r.merged.keep.msgs.length, 1, '合并保留 stored 消息');
  const r2 = sm.mergeStores({}, [ { id: 'new', msgs: [{ r: 'user', t: '1', x: 'n' }] } ]);
  assert.deepStrictEqual(r2.adopted, ['new'], 'renderer 新建会话应被采纳');
});

/* 复审轮 1 P0 复测：两个写入方 schema 不同（主进程 role:'assistant' vs 渲染层 r:'agent'），
 * 去重键不归一会让同一 assistant 回复每回合在 store 重复一条、且被
 * normalizeHistory 全量送进模型（上下文污染）。 */
check('mergeSession：agent/assistant 双 schema 同回复不得重复', () => {
  const stored = { id: 's1', msgs: [
    { role: 'user', t: '10:00:00', text: 'hi' },
    { role: 'assistant', t: '10:00:01', text: '回复' },
  ] };
  // 渲染层对同一 assistant 消息的形态（r:'agent'）+ 情境化标题字段缺失
  const incoming = { id: 's1', msgs: [
    { r: 'user', t: '10:00:00', x: 'hi' },
    { r: 'agent', t: '10:00:01', x: '回复' },
  ] };
  const out = sm.mergeSession(stored, incoming);
  assert.strictEqual(out.msgs.length, 2, '不得重复追加，实际 ' + out.msgs.length);
  assert.strictEqual(out.msgs.filter((m) => (m.text || m.x) === '回复').length, 1, '回复气泡必须恰一条');
});

check('mergeSession：元数据字段级合并（incoming 缺字段不得抹掉 stored）', () => {
  const stored = { id: 's1', title: '重要会话', pid: 'p1', created: '2026-09-01', msgs: [{ role: 'user', t: '1', text: 'a' }] };
  const incoming = { id: 's1', msgs: [{ r: 'user', t: '1', x: 'a' }, { r: 'user', t: '2', x: 'b' }] };
  const out = sm.mergeSession(stored, incoming);
  assert.strictEqual(out.title, '重要会话', 'title 不得被抹成 undefined');
  assert.strictEqual(out.pid, 'p1', 'pid 不得丢失');
  assert.strictEqual(out.created, '2026-09-01', 'created 不得丢失');
  assert.strictEqual(out.msgs.length, 2, 'msgs 仍应合并');
});

check('mergeSession：空数组边界', () => {
  assert.strictEqual(sm.mergeSession({ id: 'a', msgs: [] }, { id: 'a', msgs: [{ t: '1', x: 'x' }] }).msgs.length, 1);
  assert.strictEqual(sm.mergeSession({ id: 'a', msgs: [{ t: '1', x: 'x' }] }, { id: 'a', msgs: [] }).msgs.length, 1);
});

/* ---------- IPC 层：真实 agent 回合 + 旧快照 persist ---------- */
(async () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-merge-'));
  process.env.ORCHDESK_HOME = HOME;
  const electronStub = makeElectronStub({ home: HOME, getPath: () => HOME });
  const ipc = electronStub.ipcHandlers;
  const origLoad = Module._load;
  Module._load = function (req) { if (req === 'electron') return electronStub; return origLoad.apply(this, arguments); };
  require('./dist/main.js');
  await new Promise((r) => setTimeout(r, 300));

  const persist = ipc.get('orchdesk:persist-sessions');
  const load = ipc.get('orchdesk:load-sessions');
  const runTurn = ipc.get('orchdesk:run-agent-turn');
  assert.ok(persist && load && runTurn, 'persist/load/run-agent-turn handlers 应存在');

  // 写入可用模型配置（否则 runAgentTurn 在「未配置模型」早退，根本不会写回 msgs）
  fs.writeFileSync(path.join(HOME, 'models.json'), JSON.stringify({
    providers: [{ id: 'p1', name: '测试网关', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnc: Buffer.from('enc:k').toString('base64'), models: ['test-model'] }],
    defaultProvider: 'p1', defaultModel: 'test-model', maxToolIterations: 5,
  }), 'utf-8');

  // 假网关：直接返回文本（无工具调用）
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '主进程侧回复' }, finish_reason: 'stop' }] }),
    json: async () => ({ choices: [{ message: { content: '主进程侧回复' }, finish_reason: 'stop' }] }),
  });

  await check('IPC：渲染层先建会话并发起真实回合', async () => {
    await persist(null, [ { id: 'm1', pid: 'p1', msgs: [ { r: 'user', t: '10:00:00', x: '问题' } ] } ]);
    const res = await runTurn(null, 'm1', '问题', {});
    assert.ok(res && !res.text.includes('失败'), '回合应成功: ' + JSON.stringify(res).slice(0, 120));
  });

  await check('IPC：旧快照 persist 后，主进程侧 assistant 回复仍在（合并生效）', async () => {
    // 渲染层快照 = 回合开始前的状态（只有 user 消息，缺 assistant 回复）
    await persist(null, [ { id: 'm1', pid: 'p1', msgs: [ { r: 'user', t: '10:00:00', x: '问题' } ] } ]);
    const all = await load(null);
    const s1 = all.find((s) => s.id === 'm1');
    assert.ok(s1, 'm1 应存在');
    const texts = (s1.msgs || []).map((m) => m.text || m.x || '').join('|');
    assert.ok(texts.includes('主进程侧回复'), 'assistant 回复应保留: ' + texts);
  });

  await check('IPC：渲染层真正删除的会话会从 store 移除', async () => {
    await persist(null, [ { id: 'm1', pid: 'p1', msgs: [ { r: 'user', t: '10:00:00', x: '问题' } ] } ]);
    await persist(null, []); // 渲染层删除所有会话
    const all = await load(null);
    assert.strictEqual(all.length, 0, 'store 应被清空，实际 ' + all.length);
  });

  const ok = summary('会话合并 ');
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  if (!ok) process.exit(1);
  console.log('会话合并全部验证通过');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
