/**
 * dsh 卸下验证。
 * 断言装载器不再创建运行时，九个插件已删除，宿主服务不启动，市场装载器不注册服务。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = __dirname;
const ROOT = path.resolve(APP, '..', '..');
const NAMES = ['intent', 'trace', 'authz', 'brain', 'multi', 'memory', 'prompt', 'compensation', 'evolution'];

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.message ? err.message : err));
  }
}

check('九个插件目录已删除', () => {
  const present = NAMES.filter((name) => fs.existsSync(path.join(ROOT, 'packages', 'plugin', name)));
  assert.deepStrictEqual(present, [], '仍在的插件: ' + present.join(', '));
});

check('vendor 插件副本已删除', () => {
  const present = NAMES.filter((name) => fs.existsSync(path.join(APP, 'vendor', 'plugins', name, 'index.js')));
  assert.deepStrictEqual(present, [], '仍在的 vendor 副本: ' + present.join(', '));
});

check('dsh-runtime 源码不再装载 cordis 或宿主服务', () => {
  const src = fs.readFileSync(path.join(APP, 'dsh-runtime.ts'), 'utf8');
  assert.equal(src.includes('@deepseek-ai/cordis'), false, '仍引用 cordis');
  assert.equal(src.includes('host-services'), false, '仍引用宿主服务');
  assert.equal(src.includes('ctx.plugin'), false, '仍有 ctx.plugin');
  assert.equal(src.includes('dynamicImport'), false, '仍有动态装载');
});

check('宿主服务 apply 在注册前返回', () => {
  const src = fs.readFileSync(path.join(APP, 'host-services.ts'), 'utf8');
  const applyAt = src.indexOf('apply(ctx: Context): void {');
  const provideAt = src.indexOf("ctx.provide('sandboxPolicy'");
  const returnAt = src.indexOf('currentHandle = null;', applyAt);
  assert.ok(applyAt > 0 && returnAt > applyAt, 'apply 没有先清空句柄');
  assert.ok(provideAt < 0 || returnAt < provideAt, 'apply 在返回前注册了 sandboxPolicy');
});

async function checkRuntime() {
  const rt = require(path.join(APP, 'dist', 'dsh-runtime.js'));
  const host = require(path.join(APP, 'dist', 'host-services.js'));
  host.hostServices.apply({});
  assert.equal(host.getHostServices(), null, '宿主服务被启动了');
  assert.equal(rt.getRuntime(), null, '运行时句柄不应存在');
  assert.equal(rt.getService('authz'), null, 'authz 不应可取');
  assert.equal(rt.getService('sandboxPolicy'), null, 'sandboxPolicy 不应可取');
  const states = rt.getPluginStates();
  assert.equal(states.length, 9, '应标明九个插件不可用');
  assert.ok(states.every((s) => s.active === false && s.available === false), '插件不得显示为已装载');
  const started = await rt.startRuntime();
  assert.equal(started.ctx, null, 'startRuntime 不得创建 Context');
  assert.equal(started.activeCount, 0, '不得有激活插件');
  assert.equal(started.host, null, '不得接上宿主服务');
  const toggled = await rt.setPluginEnabled('intent', true);
  assert.equal(toggled.active, false, '热插拔不得装载');
  const market = await rt.setMarketPluginEnabled('e2e-echo', true);
  assert.equal(market.active, false, '市场插件不得装载');
  assert.equal(rt.getService('e2eEcho'), null, '市场服务不得注册');
  const rows = await rt.startupMarketPlugins({ 'e2e-echo': true });
  assert.equal(rows.length, 1, '应回传被拒绝的启用项');
  assert.equal(rows[0].ok, false, '回灌不得成功');
}

checkRuntime()
  .then(() => {
    passed += 1;
    console.log('  PASS  编译产物不装载服务，市场启用不注册');
  })
  .catch((err) => {
    failed += 1;
    console.log('  FAIL  编译产物不装载服务，市场启用不注册');
    console.log('        ' + (err && err.message ? err.message : err));
  })
  .then(() => {
    console.log('\n结果：通过 ' + passed + ' / 失败 ' + failed);
    process.exit(failed ? 1 : 0);
  });
