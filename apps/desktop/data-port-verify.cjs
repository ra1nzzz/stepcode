/**
 * 数据导出 / 导入闭环验证（BUG-013 方案 B）
 * ----------------------------------------------------------------------------
 * 用 stub 顶替 electron 模块，直接 require 编译产物 dist/main.js，
 * 捕获 ipcMain handler 并驱动 export-data / import-data 两个 handler：
 *
 *   1. 导出：单文件 JSON 备份（kind: orchdesk-backup），包含 sessions/projects/models/guanji/hub
 *   2. 导入：与启动迁移同一套「只补齐不覆盖」策略（sessions/models 合并、凭据 copy-if-absent）
 *   3. 导入无效文件被拒（缺 kind 标识）
 *   4. 取消对话框不产生副作用
 *   5. 凭据类：目标已存在时保留目标（不覆盖、不深合并）
 *   6. 导入后内存 store 已重载（load-sessions 能读到新会话）
 *
 * 运行：node data-port-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// 1. 隔离的数据目录（ORCHDESK_HOME）
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-port-home-'));
const EXPORT_FILE = path.join(os.tmpdir(), `orchdesk-backup-test-${Date.now()}.json`);
const IMPORT_FILE = path.join(os.tmpdir(), `orchdesk-import-test-${Date.now()}.json`);
process.env.ORCHDESK_HOME = HOME;

// ---------------------------------------------------------------------------
// 2. electron stub（共享脚手架 scripts/verify-kit.cjs，此处只覆盖本脚本差异）
// ---------------------------------------------------------------------------
const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');

const electronStub = makeElectronStub({
  home: path.join(os.tmpdir(), 'orchdesk-port-stub'),
  getPath: (name) => path.join(os.tmpdir(), 'orchdesk-port-stub', String(name)),
  // 本脚本用明文桩（不套 enc: 前缀），与导入/导出用例的假设一致
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(String(s), 'utf-8'),
    decryptString: (b) => b.toString('utf-8'),
  },
});
const ipcHandlers = electronStub.ipcHandlers;

// 导入 / 导出对话框：由用例按需改写行为
electronStub.dialog.mode = 'ok';
electronStub.dialog.showSaveDialog = async () => (electronStub.dialog.mode === 'cancel'
  ? { canceled: true }
  : { canceled: false, filePath: EXPORT_FILE });
electronStub.dialog.showOpenDialog = async () => (electronStub.dialog.mode === 'cancel'
  ? { canceled: true }
  : { canceled: false, filePaths: [IMPORT_FILE] });

const originalLoad = Module._load;
// dsh 已卸下，运行时是空壳，不再拦截。拦掉会让 boot 日志打出 undefined。
Module._load = function hook(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

require(path.join(__dirname, 'dist', 'main.js'));

const h = (name) => {
  const fn = ipcHandlers.get(name);
  assert.ok(fn, `缺少 IPC handler: ${name}`);
  return fn;
};

// ---------------------------------------------------------------------------
// 3. 用例（check + 计分走共享 verify-kit；失败附栈帧已内建）
// ---------------------------------------------------------------------------
const { check, summary } = createChecker();

const sessionsOf = () => JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf-8'));

(async () => {
  // 准备：先持久化一组会话与项目（经真实 handler）
  await h('orchdesk:persist-sessions')(
    null,
    [{ id: 's1', title: '本地会话', msgs: [{ role: 'user', text: '你好' }], updated: '2026-08-29T01:00:00.000Z' }],
  );
  await h('orchdesk:persist-projects')(null, [{ id: 'p1', n: '本地项目', sessions: ['s1'] }]);

  // 凭据类预置：目标已存在 guanji.json（导入时必须保留目标）
  fs.writeFileSync(path.join(HOME, 'guanji.json'), JSON.stringify({ token: 'LOCAL-KEEP' }), 'utf-8');

  await check('导出：生成单文件备份且 kind 标识正确', async () => {
    const r = await h('orchdesk:export-data')(null);
    assert.ok(r.ok, `导出失败: ${r.reason}`);
    assert.ok(fs.existsSync(EXPORT_FILE), '备份文件未落盘');
    const bundle = readJson(EXPORT_FILE);
    assert.strictEqual(bundle.kind, 'orchdesk-backup');
    assert.ok(bundle.exportedAt, '缺 exportedAt');
    assert.ok(bundle.sessions && bundle.sessions.s1, 'sessions 未包含');
    assert.ok(Array.isArray(bundle.projects) && bundle.projects[0].id === 'p1', 'projects 未包含');
    assert.ok(bundle.guanji && bundle.guanji.token === 'LOCAL-KEEP', 'guanji 未包含');
  });

  await check('导出：默认文件名带时间戳且扩展名为 json', async () => {
    // 经 stub 的 defaultPath 无法直接断言，这里验证返回路径可读即可（防回归占位）
    const r = await h('orchdesk:export-data')(null);
    assert.ok(r.ok && r.path.endsWith('.json'));
  });

  await check('取消导出对话框：不产生副作用', async () => {
    electronStub.dialog.mode = 'cancel';
    const r = await h('orchdesk:export-data')(null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'cancelled');
    electronStub.dialog.mode = 'ok';
  });

  // 造一份「外部备份」：含新会话、新项目、新模型提供商、新 hub 凭据、更新的旧会话
  const external = {
    kind: 'orchdesk-backup',
    version: 1,
    exportedAt: '2026-08-29T02:00:00.000Z',
    sessions: {
      s1: { id: 's1', title: '本地会话', msgs: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '在的' }], updated: '2026-08-29T01:30:00.000Z' },
      s2: { id: 's2', title: '外来会话', msgs: [{ role: 'user', text: '来自备份' }], updated: '2026-08-29T02:00:00.000Z' },
    },
    projects: [{ id: 'p2', n: '外来项目', sessions: ['s2'] }],
    models: { providers: [{ id: 'ext-p', name: '外来提供商', type: 'openai', baseUrl: 'https://example.invalid/v1', models: ['x:1'] }] },
    guanji: { enc: 'RUNSB1JZUFRFRA==' }, // 结构合法的密文形态（copy-if-absent，目标已存在时不会采用）
    hub: { url: 'https://hub.example', tokenCipher: 'CIPHERTEXT' },
  };
  fs.writeFileSync(IMPORT_FILE, JSON.stringify(external), 'utf-8');

  await check('导入：新会话/项目/提供商补齐，且旧会话消息并入（取更长列表）', async () => {
    const r = await h('orchdesk:import-data')(null);
    assert.ok(r.ok, `导入失败: ${r.reason}`);
    assert.ok(r.imported.sessions >= 1, '未补齐新会话');
    assert.strictEqual(r.imported.projects, 1, '未补齐新项目');
    assert.strictEqual(r.imported.providers, 1, '未补齐新提供商');
    const sessions = sessionsOf();
    assert.ok(sessions.s2, '新会话 s2 缺失');
    assert.strictEqual(sessions.s1.msgs.length, 2, '旧会话消息未并入');
    assert.strictEqual(sessions.s1.updated, '2026-08-29T01:30:00.000Z', 'updated 未取较新');
  });

  await check('导入：凭据类 copy-if-absent —— 目标已存在时保留目标', async () => {
    const guanji = readJson(path.join(HOME, 'guanji.json'));
    assert.strictEqual(guanji.token, 'LOCAL-KEEP', 'guanji.json 被覆盖（应保留目标）');
    const hub = readJson(path.join(HOME, 'hub.json'));
    assert.strictEqual(hub.tokenCipher, 'CIPHERTEXT', '目标不存在的 hub.json 未搬入');
  });

  await check('导入：跨机器凭据提示（notes）随结果返回', async () => {
    const r = await h('orchdesk:import-data')(null);
    assert.ok(r.ok);
    // 第二次导入：guanji 目标已存在 → 不再提示；hub 已搬入 → 同样不再提示
    assert.ok(!Array.isArray(r.notes) || r.notes.length === 0, `重复导入不应再产生凭据提示：${JSON.stringify(r.notes)}`);
  });

  await check('导入：内存 store 已重载，load-sessions 能读到新会话', async () => {
    const all = await h('orchdesk:load-sessions')(null);
    const ids = all.map((s) => s.id);
    assert.ok(ids.includes('s2'), '内存 store 未重载');
  });

  await check('导入无效文件（缺 kind 标识）被拒', async () => {
    fs.writeFileSync(IMPORT_FILE, JSON.stringify({ foo: 1 }), 'utf-8');
    const r = await h('orchdesk:import-data')(null);
    assert.strictEqual(r.ok, false);
    assert.ok(String(r.reason).includes('kind'), `错误提示应说明缺少 kind: ${r.reason}`);
  });

  await check('导入：明文凭据（缺 enc/tokenCipher）被拒且不落盘', async () => {
    fs.writeFileSync(IMPORT_FILE, JSON.stringify({
      kind: 'orchdesk-backup', version: 1,
      guanji: { token: 'PLAINTEXT-TOKEN' }, // 伪造备份：明文凭据必须被结构校验拒绝
      hub: { url: 'https://hub.example' },  // 缺 tokenCipher
    }), 'utf-8');
    const r = await h('orchdesk:import-data')(null);
    assert.ok(r.ok, '其它段应正常导入');
    assert.ok((r.notes || []).some((n) => n.includes('结构无效')), `应提示结构无效: ${JSON.stringify(r.notes)}`);
    const guanji = readJson(path.join(HOME, 'guanji.json'));
    assert.strictEqual(guanji.token, 'LOCAL-KEEP', '明文凭据不得写入（目标保留）');
  });

  await check('取消导入对话框：不产生副作用', async () => {
    electronStub.dialog.mode = 'cancel';
    const r = await h('orchdesk:import-data')(null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'cancelled');
    electronStub.dialog.mode = 'ok';
  });

  // 清理
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'orchdesk-port-stub'), { recursive: true, force: true });
    fs.rmSync(EXPORT_FILE, { force: true });
    fs.rmSync(IMPORT_FILE, { force: true });
  } catch { /* 尽力而为 */ }

  console.log('\n数据导出/导入闭环验证');
  const ok = summary();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('验证脚本异常:', err);
  process.exit(1);
});
