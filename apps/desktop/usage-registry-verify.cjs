/**
 * 模型用量追踪验证（PRD FR-5）。
 *
 * A 组：纯逻辑（require dist/usage-registry.js）—— 三家 API 的 usage 形态归一化
 *      （chat / responses / Ollama / 缺字段）/ 追加与环形 / 聚合 / 文件 roundtrip。
 * B 组：stub electron 驱动真实 IPC —— 种子 usage.json → orchdesk:usage 聚合视图
 *      → usage-clear 归零。「回合产生条目」的线级验证在 model-loop-verify.cjs
 *      （那里有真 HTTP mock 的完整 agent 回合）。
 *
 * 运行：node usage-registry-verify.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_DIR = __dirname;
const REG = require(path.join(APP_DIR, 'dist', 'usage-registry.js'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  /* ============================== A 组：纯逻辑 ============================== */
  console.log('== 用量追踪：归一化与聚合（FR-5）==');

  await check('归一化：OpenAI chat 形态（prompt_tokens / completion_tokens / total_tokens）', () => {
    const u = REG.normalizeApiUsage({ usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
    assert(u && u.promptTokens === 100 && u.completionTokens === 40 && u.totalTokens === 140, JSON.stringify(u));
  });

  await check('归一化：OpenAI responses 形态（input_tokens / output_tokens）', () => {
    const u = REG.normalizeApiUsage({ usage: { input_tokens: 50, output_tokens: 20 } });
    assert(u && u.promptTokens === 50 && u.completionTokens === 20 && u.totalTokens === 70, '无 total 时应求和：' + JSON.stringify(u));
  });

  await check('归一化：Ollama 形态（顶层 prompt_eval_count / eval_count，无 usage 包裹）', () => {
    const u = REG.normalizeApiUsage({ message: { content: 'x' }, prompt_eval_count: 12, eval_count: 30 });
    assert(u && u.promptTokens === 12 && u.completionTokens === 30 && u.totalTokens === 42, JSON.stringify(u));
  });

  await check('归一化：缺 usage / 空对象 / 非数值 → null（「没上报」≠「0 token」）', () => {
    assert(REG.normalizeApiUsage({}) === null, '空对象应为 null');
    assert(REG.normalizeApiUsage({ choices: [] }) === null, '无 usage 应为 null');
    assert(REG.normalizeApiUsage({ usage: { prompt_tokens: 'abc' } }) === null, '非数值应为 null');
    assert(REG.normalizeApiUsage({ usage: { prompt_tokens: -5 } }) === null, '负数应为 null');
    assert(REG.normalizeApiUsage(null) === null, 'null 应为 null');
  });

  await check('追加与环形：超上限淘汰最旧（FIFO）', () => {
    let f = REG.defaultUsageFile();
    const N = REG.USAGE_MAX_ENTRIES + 3;
    for (let i = 0; i < N; i++) {
      f = REG.appendUsageTurn(f, { ts: 't' + i, sessionId: 's', provider: 'p', model: 'm', promptTokens: i, completionTokens: 0, totalTokens: i, steps: 0 });
    }
    assert(f.entries.length === REG.USAGE_MAX_ENTRIES, `应保持上限 ${REG.USAGE_MAX_ENTRIES}，实际 ${f.entries.length}`);
    assert(f.entries[0].ts === 't3', '最旧 3 条应被淘汰，实际最旧是 ' + f.entries[0].ts);
    assert(f.entries[f.entries.length - 1].ts === 't' + (N - 1), '最新条目应在尾部');
  });

  await check('聚合：total / byModel 降序 / bySession Top10', () => {
    const entries = [
      { ts: '1', sessionId: 'a', provider: 'p', model: 'big', promptTokens: 100, completionTokens: 50, totalTokens: 150, steps: 0 },
      { ts: '2', sessionId: 'a', provider: 'p', model: 'small', promptTokens: 10, completionTokens: 5, totalTokens: 15, steps: 0 },
      { ts: '3', sessionId: 'b', provider: 'p', model: 'big', promptTokens: 1, completionTokens: 2, totalTokens: 3, steps: 0 },
    ];
    const agg = REG.aggregateUsage(entries);
    assert(agg.total.totalTokens === 168 && agg.total.turns === 3, JSON.stringify(agg.total));
    assert(agg.byModel[0].model === 'big' && agg.byModel[0].totalTokens === 153, 'big 应排前：' + JSON.stringify(agg.byModel));
    assert(agg.bySession[0].sessionId === 'a' && agg.bySession[0].totalTokens === 165, JSON.stringify(agg.bySession));
  });

  await check('聚合：坏条目（非数值）按 0 处理不崩', () => {
    const agg = REG.aggregateUsage([{ ts: 'x', sessionId: 's', provider: 'p', model: 'm', promptTokens: NaN, completionTokens: undefined, totalTokens: 7, steps: 0 }]);
    assert(agg.total.totalTokens === 7, JSON.stringify(agg.total));
  });

  await check('文件 roundtrip：写入后读回一致；坏 JSON 回落空表', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-usage-'));
    const file = path.join(dir, 'usage.json');
    const w = REG.writeUsageFile(file, { entries: [{ ts: 't', sessionId: 's', provider: 'p', model: 'm', promptTokens: 1, completionTokens: 2, totalTokens: 3, steps: 0 }] });
    assert(w.ok === true, '写入失败: ' + w.reason);
    const r = REG.readUsageFile(file);
    assert(r.entries.length === 1 && r.entries[0].totalTokens === 3, JSON.stringify(r));
    fs.writeFileSync(file, '{broken', 'utf-8');
    assert(REG.readUsageFile(file).entries.length === 0, '坏 JSON 应回落空表');
    assert(REG.readUsageFile(path.join(dir, 'nope.json')).entries.length === 0, '缺文件应回落空表');
  });

  /* ============================== B 组：真实 IPC ============================== */
  console.log('\n== 用量追踪：IPC 桥接 ==');

  const probe = runProbe();

  await check('orchdesk:usage 聚合视图：种子条目按模型聚合正确', () => {
    assert(probe.usageOk === true, 'usage IPC 应 ok');
    assert(probe.totalTurns === 3 && probe.totalTokens === 168, `应聚合 3 回合 168 tokens，实际 ${JSON.stringify(probe.total)}`);
    assert(probe.byModelTop === 'big' && probe.byModelTopTokens === 153, 'byModel 应 big 在前');
  });

  await check('落盘随迁移文件名：usage.json 在 ORCHDESK_HOME 下', () => {
    assert(probe.fileExists === true, 'usage.json 应已落盘');
  });

  await check('usage-clear → 记账归零且文件仍在', () => {
    assert(probe.clearOk === true && probe.afterClearTurns === 0, '清空后应 0 回合');
    assert(probe.fileExistsAfterClear === true, '清空后文件应仍存在（内容为空表）');
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();

/** 子进程跑真实主进程：stub electron，种子 usage.json 后走 IPC。 */
function runProbe() {
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    // probe 脚本落在系统临时目录，__dirname 指向那里 —— 所有路径必须以 APP_DIR 为基准。
    const APP_DIR = ${JSON.stringify(APP_DIR)};
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-usage-'));
    process.env.ORCHDESK_HOME = HOME;

    const { makeElectronStub } = require(${JSON.stringify(path.join(APP_DIR, '..', '..', 'scripts', 'verify-kit.cjs'))});
    const stub = makeElectronStub({
      home: HOME,
      getPath: (n) => n === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', n),
    });
    const ipc = stub.ipcHandlers;
    const orig = Module._load;
    Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };

    const out = {};
    (async () => {
      const REG = require(path.join(APP_DIR, 'dist', 'usage-registry.js'));
      // 先种子 usage.json（3 回合：big×2 + small×1）
      const file = path.join(HOME, 'usage.json');
      let f = REG.defaultUsageFile();
      f = REG.appendUsageTurn(f, { ts: '1', sessionId: 'a', provider: 'p', model: 'big', promptTokens: 100, completionTokens: 50, totalTokens: 150, steps: 1 });
      f = REG.appendUsageTurn(f, { ts: '2', sessionId: 'a', provider: 'p', model: 'small', promptTokens: 10, completionTokens: 5, totalTokens: 15, steps: 0 });
      f = REG.appendUsageTurn(f, { ts: '3', sessionId: 'b', provider: 'p', model: 'big', promptTokens: 1, completionTokens: 2, totalTokens: 3, steps: 2 });
      REG.writeUsageFile(file, f);

      require(path.join(APP_DIR, 'dist', 'main.js'));
      for (let i = 0; i < 200; i++) {
        if (ipc.get('orchdesk:usage')) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const r = await ipc.get('orchdesk:usage')(null);
      out.usageOk = r.ok === true;
      out.total = r.total;
      out.totalTurns = r.total.turns;
      out.totalTokens = r.total.totalTokens;
      out.byModelTop = r.byModel[0] && r.byModel[0].model;
      out.byModelTopTokens = r.byModel[0] && r.byModel[0].totalTokens;
      out.fileExists = fs.existsSync(file);

      const c = await ipc.get('orchdesk:usage-clear')(null);
      out.clearOk = c.ok === true;
      const r2 = await ipc.get('orchdesk:usage')(null);
      out.afterClearTurns = r2.total.turns;
      out.fileExistsAfterClear = fs.existsSync(file);

      console.log('RESULT_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + ((e && e.stack) || e)); process.exit(1); });
  `;
  return execProbe(script, 'usage');
}

/** 共享 probe 执行器（与 connector-registry-verify 同套路）。 */
function execProbe(script, tag) {
  const tmp = path.join(os.tmpdir(), `${tag}-probe-${Date.now()}.cjs`);
  fs.writeFileSync(tmp, script, 'utf-8');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [tmp], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (err) {
    const so = String((err && err.stdout) || '');
    const m = so.match(/ERR:([\s\S]*)/);
    throw new Error(`probe 执行失败: ${m ? m[1].slice(0, 500) : (err && err.message) || err}`);
  }
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT_JSON:'));
  if (!line) throw new Error('probe 无 RESULT_JSON 输出: ' + stdout.slice(0, 300));
  return JSON.parse(line.slice('RESULT_JSON:'.length));
}
