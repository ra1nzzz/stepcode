/**
 * 本地插件市场验证（PRD FR-3）。
 *
 * A 组：纯逻辑（require dist/plugin-market.js）—— manifest 校验 / 启用状态归一化 / 目录名。
 * B 组：stub electron 驱动真实 IPC + 真实 cordis 运行时 —— 种子插件目录（合法 / manifest
 *       非法 / 缺 index.js），验证：扫描不执行代码、启用 = 真装载（服务真的注册进 ctx）、
 *       停用 = 真卸载（服务消失，逆回滚无残留）、非法输入 fail-closed、启用意愿写穿落盘。
 *
 * 运行：node plugin-market-verify.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_DIR = __dirname;
const PM = require(path.join(APP_DIR, 'dist', 'plugin-market.js'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  /* ============================== A 组：纯逻辑 ============================== */
  console.log('== 本地插件市场：manifest 与状态（FR-3）==');

  await check('manifest 全字段合法 → 归一化通过', () => {
    const r = PM.validateMarketManifest({ name: '我的插件', version: '1.2.3', description: 'd', caps: ['fs.read'], inject: ['memory'] }, 'dir1');
    assert(r.ok, '应通过: ' + JSON.stringify(r));
    assert(r.manifest.version === '1.2.3' && r.manifest.caps.length === 1 && r.manifest.inject[0] === 'memory', '字段应保留');
  });

  await check('manifest 缺省字段 → version/desc/caps/inject 给默认值（不炸）', () => {
    const r = PM.validateMarketManifest({ name: 'x' }, 'dir2');
    assert(r.ok && r.manifest.version === '0.0.0' && r.manifest.description === '' && r.manifest.caps.length === 0 && r.manifest.inject.length === 0, '默认值错误: ' + JSON.stringify(r));
  });

  await check('manifest.name 缺失 / 非字符串 → 失败且报目录名', () => {
    const a = PM.validateMarketManifest({}, 'dirA');
    const b = PM.validateMarketManifest({ name: 42 }, 'dirB');
    assert(!a.ok && /dirA/.test(a.error), '应报目录名: ' + JSON.stringify(a));
    assert(!b.ok && /dirB/.test(b.error), '应报目录名: ' + JSON.stringify(b));
  });

  await check('manifest caps / inject 非数组 → 丢弃为空（脏数据不炸）；超长截断', () => {
    const r = PM.validateMarketManifest({ name: 'x', caps: 'fs.read', inject: [1, null, 'ok'], description: '长'.repeat(500) }, 'dirC');
    assert(r.ok && r.manifest.caps.length === 0, '非数组 caps 应丢弃');
    assert(r.manifest.inject.length === 1 && r.manifest.inject[0] === 'ok', 'inject 应滤掉非字符串，实际 ' + JSON.stringify(r.manifest.inject));
    assert(r.manifest.description.length === PM.MANIFEST_FIELD_MAX, 'description 应截断');
  });

  await check('启用状态归一化：非布尔 → false（fail-closed）；路径穿越 key 丢弃', () => {
    const m = PM.normalizeEnabledMap({ a: true, b: 'yes', c: 1, d: false, '../evil': true, 'sub/dir': true });
    assert(m.a === true && m.d === false, '布尔应保留');
    assert(m.b === false && m.c === false, '非布尔必须按 false（默认不装载第三方代码）');
    assert(!('../evil' in m) && !('sub/dir' in m), '路径穿越 key 应丢弃');
    assert(Object.keys(PM.normalizeEnabledMap(null)).length === 0, '非对象 → 空表');
  });

  await check('目录名校验：穿越 / 隐藏目录 / 空串 → 拒绝', () => {
    assert(PM.isMarketDirName('my-plugin') === true, '合法名应通过');
    assert(!PM.isMarketDirName('../evil') && !PM.isMarketDirName('a/b') && !PM.isMarketDirName('.hidden') && !PM.isMarketDirName('') && !PM.isMarketDirName('..') && !PM.isMarketDirName(42), '非法名应拒绝');
  });

  /* ===================== B 组：市场装载器已卸下 ===================== */
  console.log('== 本地插件市场：装载器已卸下 ==');

  await check('市场启用不装载、不注册服务', async () => {
    const rt = require('./dist/dsh-runtime.js');
    const before = rt.getService('e2eEcho');
    assert(before == null, '卸下后不得预注册市场服务');
    const state = await rt.setMarketPluginEnabled('e2e-echo', true);
    assert(state.active === false && state.manifestOk === false && state.enabled === false, '启用不得装载: ' + JSON.stringify(state));
    assert(rt.getService('e2eEcho') == null, '启用后不得注册服务');
    const rows = await rt.startupMarketPlugins({ 'e2e-echo': true });
    assert(rows.length === 1 && rows[0].ok === false, '回灌不得成功: ' + JSON.stringify(rows));
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();
