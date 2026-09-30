/**
 * TypeScript 直测 loader 验证（ADR-0010）。
 *
 * 背景：现有套件一律 `require('dist/*.js')`，即「先 tsc 再测」——忘了编译就会用
 * 旧产物跑出假通过（2026-08-31 真踩到过）。本套件守护的 loader 让验证套件可以
 * 直接 `import` TS 源码（Node 22 内置 stripTypeScriptTypes，零依赖）。
 *
 * A 组：loader 契约 —— 导出可见 / 无扩展名相对导入 / `.js` 写法映射 / 类型剥离
 *       语义 / 不污染 CJS require 链。
 * B 组：与 dist 产物一致性 —— 同一输入 TS 版与 dist 版输出必须逐字节相等，
 *       否则说明 loader 引入了语义漂移，直测结果不可信。
 * C 组：直测收益证明 + 陈旧产物探针 —— ① 改源码立刻反映到断言（无需 tsc）；
 *       ② dist 产物比源码旧时 FAIL 并给出修复命令。
 *
 * 运行：node ts-loader-verify.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = __dirname;
const { importTs, registerTsLoader } = require(path.join(APP_DIR, 'scripts', 'ts-load.cjs'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 临时 fixture 目录（进程退出时清理）。 */
const FIX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-tsl-'));
function writeFixture(name, code) {
  const p = path.join(FIX_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, code, 'utf-8');
  return p;
}
/** import 临时目录里的 fixture（相对 FIX_DIR）。 */
function importFixture(name) {
  return importTs(path.join(FIX_DIR, name));
}

(async () => {
  /* ===================== A 组：loader 契约 ===================== */
  console.log('== TS 直测 loader：契约（ADR-0010）==');

  await check('能 import TS 源码并拿到具名导出（session-events）', async () => {
    const SE = await importTs('session-events.ts');
    for (const k of ['appendEvents', 'readEvents', 'buildTimeline', 'collectLineageEvents', 'sanitizeSessionId']) {
      assert(typeof SE[k] === 'function', `缺少导出 ${k}`);
    }
  });

  await check('无扩展名相对导入可解析（fixture：`./dep` → dep.ts）', async () => {
    writeFixture('dep.ts', 'export const secret: string = "dep-value";\n');
    writeFixture('main-noext.ts', 'import { secret } from \'./dep\';\nexport const got: string = secret;\n');
    const m = await importFixture('main-noext.ts');
    assert(m.got === 'dep-value', `应解析到 dep.ts，实际 ${m.got}`);
  });

  await check('真实源码跨模块导入可解析（connector-registry → ./credentials）', async () => {
    // connector-registry.ts 第 16 行 `from './credentials'` 无扩展名；能 import
    // 成功即证明解析生效（解析失败会抛 ERR_MODULE_NOT_FOUND）。
    const CR = await importTs('connector-registry.ts');
    assert(Array.isArray(CR.CONNECTOR_CATALOG) && CR.CONNECTOR_CATALOG.length > 0, 'CONNECTOR_CATALOG 应非空');
    const def = CR.getConnectorDef(CR.CONNECTOR_IDS[0]);
    assert(def && def.id === CR.CONNECTOR_IDS[0], 'getConnectorDef 应命中首项');
    assert(typeof CR.maskSecret('abcd1234') === 'string', 'maskSecret 应可用（依赖 credentials 模块）');
  });

  await check('TS 风格 `.js` 写法映射到 `.ts`（磁盘上只有 .ts 也能解析）', async () => {
    writeFixture('sibling.ts', 'export const marker: string = "from-ts-file";\n');
    writeFixture('consumer.ts', 'import { marker } from \'./sibling.js\';\nexport const got: string = marker;\n');
    const m = await importFixture('consumer.ts');
    assert(m.got === 'from-ts-file', `应解析到 sibling.ts，实际 ${m.got}`);
  });

  await check('类型剥离语义：interface / 泛型 / 类型断言 / as const 不影响运行时', async () => {
    writeFixture('types.ts', [
      'interface Box<T> { v: T }',
      'type Alias = { n: number };',
      'const box: Box<string> = { v: "boxed" };',
      'const a: Alias = { n: 42 };',
      'const raw = { k: "x" } as const;',
      'export const out = { box: box.v, n: a.n, k: raw.k };',
    ].join('\n'));
    const m = await importFixture('types.ts');
    assert(m.out.box === 'boxed' && m.out.n === 42 && m.out.k === 'x', JSON.stringify(m.out));
  });

  await check('不污染 CJS require 链：require 未知模块仍走默认行为（抛 MODULE_NOT_FOUND）', async () => {
    await importTs('data-dir.ts'); // 确保 hooks 已注册
    let threw = false;
    try { require(path.join(APP_DIR, 'dist', '__definitely_missing__.js')); }
    catch (e) { threw = e.code === 'MODULE_NOT_FOUND'; }
    assert(threw, 'require 应仍按 CJS 默认语义抛 MODULE_NOT_FOUND');
  });

  await check('幂等注册：重复 registerTsLoader / 重复 importTs 同一模块不报错且同实例', async () => {
    registerTsLoader();
    registerTsLoader();
    const a = await importTs('sandbox-log.ts');
    const b = await importTs('sandbox-log.ts');
    assert(a === b, '同一 URL 二次 import 应命中 ESM 缓存（同一模块实例）');
  });

  /* ===================== B 组：与 dist 产物一致性 ===================== */
  console.log('== TS 直测 loader：与 dist 产物一致性 ==');

  /** 抽样对比：同一输入下 TS 版与 dist 版输出必须逐字节相等。 */
  async function sameAsDist(tsName, distName, probe) {
    const tsMod = await importTs(tsName);
    const distMod = require(path.join(APP_DIR, 'dist', distName));
    const a = JSON.stringify(probe(tsMod));
    const b = JSON.stringify(probe(distMod));
    assert(a === b, `TS 版与 dist 版输出不一致\n        TS  : ${a}\n        dist: ${b}`);
  }

  await check('usage-registry：归一化 + 聚合输出与 dist 一致', async () => {
    await sameAsDist('usage-registry.ts', 'usage-registry.js', (M) => ({
      chat: M.normalizeApiUsage({ usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }),
      resp: M.normalizeApiUsage({ usage: { input_tokens: 50, output_tokens: 20 } }),
      ollama: M.normalizeApiUsage({ prompt_eval_count: 12, eval_count: 30 }),
      nul: M.normalizeApiUsage({}) === null,
      agg: M.aggregateUsage([
        { ts: 't', sessionId: 's1', provider: 'p', model: 'm-a', promptTokens: 1, completionTokens: 1, totalTokens: 2, steps: 1 },
        { ts: 't', sessionId: 's2', provider: 'p', model: 'm-b', promptTokens: 3, completionTokens: 1, totalTokens: 4, steps: 1 },
      ]),
    }));
  });

  await check('session-events：血缘截断时间线与 dist 一致', async () => {
    await sameAsDist('session-events.ts', 'session-events.js', (M) => {
      const logs = {
        p: [
          { seq: 1, ts: 1, kind: 'user', text: 'P1' },
          { seq: 2, ts: 2, kind: 'assistant', text: 'P2', tools: [{ name: 't', phase: 'done', result: 'r' }] },
          { seq: 3, ts: 3, kind: 'user', text: 'P3' },
        ],
        c: [{ seq: 1, ts: 4, kind: 'fork-origin', from: 'p', fromTitle: '父', atIndex: 2 }],
      };
      const load = (sid) => logs[sid] || [];
      return {
        tl: M.buildTimeline(load, 'c'),
        lineage: M.collectLineageEvents(load, 'c').map((e) => e.text || e.kind),
        incomplete: M.hasIncompleteAncestry(load, 'c'),
      };
    });
  });

  await check('data-dir + credentials：路径解析与加解密输出与 dist 一致', async () => {
    await sameAsDist('data-dir.ts', 'data-dir.js', (M) => ({
      names: M.DATA_FILE_NAMES,
      dirs: M.DATA_DIR_NAMES,
    }));
    await sameAsDist('credentials.ts', 'credentials.js', (M) => {
      const c = M.encryptSecret('round-trip-值');
      return { len: c.length > 0, back: M.decryptSecret(c) === 'round-trip-值' };
    });
  });

  /* ===================== C 组：直测收益 + 陈旧探针 ===================== */
  console.log('== TS 直测 loader：收益证明与陈旧产物探针 ==');

  await check('改源码立刻反映到断言（无需 tsc）—— 这是直测相对 dist 测试的核心收益', async () => {
    const file = writeFixture('live.ts', 'export const value: number = 1;\n');
    const modPath = path.relative(APP_DIR, file);
    const v1 = await importTs(modPath);
    assert(v1.value === 1, '初次导入应为 1');
    // 覆写源码（不跑 tsc），用 cache-busting suffix 强制重新加载
    fs.writeFileSync(file, 'export const value: number = 2;\n', 'utf-8');
    const v2 = await importTs(modPath + '?t=2');
    assert(v2.value === 2, `覆写源码后应立刻读到 2，实际 ${v2.value}（说明测的不是源码）`);
  });

  await check('dist 产物不陈旧（.ts 比 dist/*.js 新 → FAIL 并给出修复命令）', () => {
    const stale = [];
    for (const f of fs.readdirSync(APP_DIR)) {
      if (!f.endsWith('.ts')) continue;
      const js = path.join(APP_DIR, 'dist', f.replace(/\.ts$/, '.js'));
      if (!fs.existsSync(js)) continue; // 未参与本次编译的独立脚本，跳过
      if (fs.statSync(path.join(APP_DIR, f)).mtimeMs > fs.statSync(js).mtimeMs) stale.push(f);
    }
    assert(stale.length === 0, `dist 产物陈旧，跑 npx tsc -p tsconfig.json 后重试：${stale.join(', ')}`);
  });

  await check('stub electron 的 Module._load 钩子未被 loader 破坏（CJS 侧仍可 stub）', () => {
    // 现有 IPC 套件依赖「Module._load 钩子替换 electron」驱动 dist/main.js。
    // loader 只接管 ESM dynamic import，不得影响 CJS require 链，这里做回归守护。
    const Module = require('module');
    const orig = Module._load;
    let hit = false;
    Module._load = function (req, parent, isMain) {
      if (req === 'electron') { hit = true; return { stubbed: true }; }
      return orig.apply(this, arguments);
    };
    try {
      /* eslint-disable-next-line @typescript-eslint/no-var-requires */
      const e = require('electron');
      assert(e && e.stubbed === true, '应拿到 stub 而非真 electron');
    } catch (err) {
      assert(hit === true, 'CJS require 未经过 Module._load 钩子：' + err.message);
    } finally {
      Module._load = orig;
    }
  });

  try { fs.rmSync(FIX_DIR, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  console.log(log.join('\n'));
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
