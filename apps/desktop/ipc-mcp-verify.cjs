/**
 * MCP IPC 行为层验证（审查缺口补齐：此前 mcp-client-verify 只覆盖客户端协议，
 * 「配置→保存→启用→调用→错误回显」这条 IPC 面零覆盖）。
 * 进程内驱动真实 handler（stub electron + 真实主进程装载，与 agent-loop-verify 同手法）。
 */
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('node:module');

const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-mcp-'));
process.env.ORCHDESK_HOME = HOME;

const electronStub = makeElectronStub({
  home: HOME,
  getPath: (name) => (name === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', name)),
});
const ipcHandlers = electronStub.ipcHandlers;

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

require('./dist/main.js');

const { check, summary } = createChecker();

(async () => {
  // 等 bootRuntime 完成（handler 注册早于运行时就绪）
  for (let i = 0; i < 200; i++) {
    const h = ipcHandlers.get('orchdesk:plugin-runtime');
    if (h) {
      const st = await h(null);
      if (st && st.plugins && st.plugins.length >= 9 && st.plugins.every((p) => p.available === false)) break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const save = ipcHandlers.get('orchdesk:mcp-save');
  const list = ipcHandlers.get('orchdesk:mcp-list');
  const setEnabled = ipcHandlers.get('orchdesk:mcp-set-enabled');
  const del = ipcHandlers.get('orchdesk:mcp-delete');
  const probe = ipcHandlers.get('orchdesk:mcp-probe');
  const callTool = ipcHandlers.get('orchdesk:mcp-call-tool');
  assert.ok(save && list && setEnabled && del && probe && callTool, '六个 MCP handler 应全部注册');

  // 1) 非法配置被拒（缺 command）且不落盘
  await check('mcp-save 缺 command 被归一化拒绝', async () => {
    const r = await save(null, { id: 'm1', name: '坏配置' });
    assert.strictEqual(r.ok, false, '应拒绝: ' + JSON.stringify(r));
    assert.ok(r.reason, '应给出 reason');
    const l = await list(null);
    assert.strictEqual(l.stats.total, 0, '被拒配置不应落盘，实际 total=' + l.stats.total);
  });

  // 2) 合法配置：保存即探测（命令不存在 → 探测失败但保存成功，state 如实记录）
  await check('mcp-save 合法配置：保存成功 + 保存即探测（探测失败如实记录）', async () => {
    const r = await save(null, {
      id: 'm1', name: '测试 MCP', command: 'node',
      args: [path.join(HOME, 'no-such-mcp-server.js')],
      env: { API_TOKEN: 'sk-plaintext-secret-value' },
    });
    assert.strictEqual(r.ok, true, '应保存成功: ' + JSON.stringify(r));
    assert.strictEqual(r.configured, true);
    assert.strictEqual(r.state.lastConnectOk, false, '命令不存在应探测失败');
    assert.ok(r.state.lastMessage, '探测失败应有原因');
  });

  // 3) env 明文不落盘、列表不回显
  await check('env 值加密落盘且列表不回显明文', async () => {
    const file = path.join(HOME, 'mcp.json');
    assert.ok(fs.existsSync(file), 'mcp.json 应已落盘');
    const raw = fs.readFileSync(file, 'utf-8');
    assert.ok(!raw.includes('sk-plaintext-secret-value'), '落盘文件不得含 env 明文');
    assert.ok(!raw.includes('API_TOKEN') || !raw.includes('sk-plaintext'), '文件中 env 值应为密文');
    const l = await list(null);
    assert.ok(!JSON.stringify(l).includes('sk-plaintext-secret-value'), '列表回显不得含 env 明文');
    assert.strictEqual(l.stats.total, 1);
    assert.strictEqual(l.servers[0].enabled, true);
  });

  // 4) 停用 / 启用
  await check('mcp-set-enabled 停用后列表反映状态且不删配置', async () => {
    const r = await setEnabled(null, 'm1', false);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.state.enabled, false, '应反映停用');
    const l = await list(null);
    assert.strictEqual(l.stats.total, 1, '停用不删配置');
    assert.strictEqual(l.servers[0].enabled, false);
  });

  // 5) 重新探测 + 删除
  await check('mcp-probe 重新探测不崩溃（明确返回探测结论）', async () => {
    const r = await probe(null, 'm1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.state.lastConnectOk, false, '命令仍不存在，探测应仍失败');
  });
  await check('mcp-delete 删除后列表为空', async () => {
    const r = await del(null, 'm1');
    assert.strictEqual(r.ok, true);
    const l = await list(null);
    assert.strictEqual(l.stats.total, 0);
  });

  // 6) 错误路径：不存在 id / 非法 id / 空 toolName / 未连接调用
  await check('mcp-probe / mcp-delete / mcp-call-tool 对不存在 id 明确报错', async () => {
    assert.strictEqual((await probe(null, 'nope')).ok, false);
    assert.strictEqual((await del(null, 'nope')).ok, false);
    assert.strictEqual((await callTool(null, 'nope', 't', {})).ok, false);
  });
  await check('mcp-call-tool 非法 id / 空 toolName 被拒', async () => {
    assert.strictEqual((await callTool(null, { bad: true }, 't', {})).ok, false, '非法 id 应拒');
    assert.strictEqual((await callTool(null, 'm2', '  ', {})).ok, false, '空 toolName 应拒');
  });

  await check('沙箱服务停止后 mcp-call-tool 失败关闭，不能靠缺省模式放行', async () => {
    const r = await save(null, { id: 'm-ro', name: 'RO 网关', command: 'node', args: [path.join(HOME, 'nope.js')], enabled: false });
    assert.strictEqual(r.ok, true);
    const rt = require('./dist/dsh-runtime.js');
    assert.equal(rt.getService('sandboxPolicy'), null);
    const out = await callTool(null, 'm-ro', 'any-tool', { x: 1 });
    assert.strictEqual(out.ok, false, '停止后应被拒: ' + JSON.stringify(out));
    assert.ok(String(out.reason).includes('沙箱服务已停止'), '拒绝原因应说明服务已停止，实际: ' + JSON.stringify(out));
  });

  const ok = summary();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  if (!ok) process.exit(1);
  console.log('MCP IPC 行为层全部验证通过');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
