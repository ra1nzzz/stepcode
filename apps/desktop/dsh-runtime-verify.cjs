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

// BUG-046：「重新接 grants 持久化时不得自动回灌历史 authz-grants.json」此前只是
// ipc-authz.ts 里的一句注释。注释不会失败，所以把它钉成三条断言：
// ① 恒返回 0 的 `hydrateGrants` 空壳已经从 dsh-runtime.ts 删除，任何生产源码再出现这个名字即判红；
// ② 没有任何 readFileSync/readFile 的入参提到 grants（无论是字面量还是变量名）；
// ③ data-dir.ts 的文件名表里不许出现 authz-grants.json（登记成受管文件就等于给快照/备份带上它）。
// 扫描是逐行的、且跳过注释行（注释里讨论这条不变量时必须能提这些名字）。
check('旧授权白名单文件没有任何读取路径（BUG-046 已代码化）', () => {
  const files = fs.readdirSync(APP).filter((f) => f.endsWith('.ts'));
  const hits = [];
  for (const f of files) {
    const code = fs.readFileSync(path.join(APP, f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    if (/\bhydrateGrants\b/.test(code)) hits.push(`${f}: 生产代码里又出现了 hydrateGrants`);
    for (const m of code.matchAll(/(?:readFileSync|readFile|openSync)\s*\(([^;]{0,140})/g)) {
      if (/grants/i.test(m[1])) hits.push(`${f}: 读取入参含 grants -> ${m[1].slice(0, 70)}`);
    }
  }
  const dataNames = fs.readFileSync(path.join(APP, 'data-dir.ts'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  if (/authz-grants/i.test(dataNames)) hits.push('data-dir.ts 把 authz-grants.json 登记成了受管数据文件');
  assert.deepEqual(hits, [], `旧 grants 回灌路径重新出现：\n        ${hits.join('\n        ')}`);
});

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
