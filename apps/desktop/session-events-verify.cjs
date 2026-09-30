/**
 * SessionEvent append-only 事件日志验证（PRD FR-6，ADR-0009）。
 *
 * A 组：纯逻辑（require dist/session-events.js）—— 会话 id 防线 / 追加与 seq /
 *       坏行韧性 / seq 回收 / 分叉前缀 / 血缘时间线（含环防护）/ 上下文重建 /
 *       祖先完整性 / 单次收集一致性。
 * B 组：stub electron 驱动真实 IPC —— fork-event 落血缘 → session-events 沿
 *       父子链拼接时间线 → 无日志会话回 legacy → legacy 父被分叉整体回落。
 *
 * 运行：node session-events-verify.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_DIR = __dirname;
const SE = require(path.join(APP_DIR, 'dist', 'session-events.js'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  /* ============================== A 组：纯逻辑 ============================== */
  console.log('== SessionEvent：append-only 与血缘重建（FR-6 / ADR-0009）==');

  await check('会话 id 防线：穿越 / 隐藏目录 / 空串 / 超长全部拒绝', () => {
    assert(SE.sanitizeSessionId('../etc') === null, '穿越应拒绝');
    assert(SE.sanitizeSessionId('a\\..\\b') === null, '反斜杠应拒绝');
    assert(SE.sanitizeSessionId('.hidden') === null, '点开头应拒绝');
    assert(SE.sanitizeSessionId('') === null, '空串应拒绝');
    assert(SE.sanitizeSessionId(null) === null, 'null 应拒绝');
    assert(SE.sanitizeSessionId('x'.repeat(200)) === null, '超长应拒绝');
    assert(SE.sanitizeSessionId('sAbc_123-xyz') === 'sAbc_123-xyz', '合法 id 应放行');
  });

  await check('追加：seq 自动递增（空文件从 1 起，续写接着最大值）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's1.ndjson');
    const w1 = SE.appendEvents(file, [{ ts: 1, kind: 'user', text: 'a' }]);
    assert(w1.ok && w1.written[0].seq === 1, JSON.stringify(w1));
    const w2 = SE.appendEvents(file, [{ ts: 2, kind: 'assistant', text: 'b', model: 'm' }]);
    assert(w2.written[0].seq === 2, '续写应接 seq=2，实际 ' + w2.written[0].seq);
    const evs = SE.readEvents(file);
    assert(evs.length === 2 && evs[1].kind === 'assistant', JSON.stringify(evs));
  });

  await check('append-only 韧性：坏行跳过不中断读取', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's2.ndjson');
    SE.appendEvents(file, [{ ts: 1, kind: 'user', text: 'a' }, { ts: 2, kind: 'assistant', text: 'b' }]);
    fs.appendFileSync(file, '{broken json\n', 'utf-8');
    SE.appendEvents(file, [{ ts: 3, kind: 'user', text: 'c' }]);
    const evs = SE.readEvents(file);
    assert(evs.length === 3 && evs[2].text === 'c', '坏行后应继续追加可读，实际 ' + JSON.stringify(evs.map((e) => e.text)));
  });

  await check('seq 回收：坏行占用的序号位不重号（审阅回归）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's2b.ndjson');
    SE.appendEvents(file, [{ ts: 1, kind: 'user', text: 'a' }]);
    // 模拟半截写入的坏行（JSON 解析失败但 seq 可辨识）
    fs.appendFileSync(file, '{"seq":9,"ts":2,"kind":"user","text":"brok\n', 'utf-8');
    const w = SE.appendEvents(file, [{ ts: 3, kind: 'user', text: 'c' }]);
    assert(w.ok && w.written[0].seq === 10, '坏行 seq=9 后新事件应从 10 起，实际 ' + (w.written || [])[0]?.seq);
  });

  await check('分叉前缀：只取第 atIndex 条消息（含）之前，fork-origin 不占消息位', () => {
    const evs = [
      { seq: 1, ts: 1, kind: 'user', text: 'm1' },
      { seq: 2, ts: 2, kind: 'assistant', text: 'm2' },
      { seq: 3, ts: 3, kind: 'user', text: 'm3' },
      { seq: 4, ts: 4, kind: 'assistant', text: 'm4' },
    ];
    const p1 = SE.forkPrefixEvents(evs, 2);
    assert(p1.length === 2 && p1[1].text === 'm2', 'atIndex=2 应取前 2 条消息，实际 ' + JSON.stringify(p1.map((e) => e.text)));
    const p2 = SE.forkPrefixEvents(evs, 99);
    assert(p2.length === 4, '超界按全量处理');
    const withFork = [{ seq: 0, ts: 0, kind: 'fork-origin', from: 'x', atIndex: 1 }, ...evs];
    assert(SE.forkPrefixEvents(withFork, 2).length === 3, 'fork-origin 不占消息位（血缘 + 前 2 条消息 = 3）');
  });

  await check('时间线：沿血缘链拼接且按 atIndex 截断父事件，祖先 seq 带前缀', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const logs = {
      parent: [
        { seq: 1, ts: 1, kind: 'user', text: 'P1' },
        { seq: 2, ts: 2, kind: 'assistant', text: 'P2', model: 'm', tools: [{ name: 'file_read', phase: 'done', result: 'ok' }] },
        { seq: 3, ts: 3, kind: 'user', text: 'P3' },
      ],
      child: [
        { seq: 1, ts: 4, kind: 'fork-origin', from: 'parent', fromTitle: '父', atIndex: 2 },
        { seq: 2, ts: 5, kind: 'user', text: 'C1' },
      ],
    };
    const load = (sid) => logs[sid] || SE.readEvents(SE.eventFileFor(dir, sid));
    const tl = SE.buildTimeline(load, 'child');
    // atIndex=2 → 父只取 P1 + P2（P2 拆 tool + agent 两条）+ fork 起点 + C1 = 5；
    // P3 是分叉点之后父会话的独立写入，不得漏进子分支回放。
    assert(tl.length === 5, `应为 5 项，实际 ${tl.length}: ${JSON.stringify(tl)}`);
    assert(tl[0].detail === 'P1' && tl[0].seq === 'p1#1', '父事件 seq 应带 p1 前缀');
    assert(tl[3].kind === 'fork-origin' && /父/.test(tl[3].detail), '第 4 项应是分叉起点');
    assert(tl[4].detail === 'C1' && tl[4].seq === '#2', '子事件 seq 不带前缀');
    assert(!tl.some((x) => x.detail === 'P3'), '分叉点之后的父写入 P3 不得出现');
    // 全量血缘上下文同样按截断取（含 fork-origin 血缘事件本身）
    const ctx = SE.collectLineageEvents(load, 'child');
    assert(ctx.length === 4 && ctx[0].text === 'P1' && ctx[1].text === 'P2'
      && ctx[2].kind === 'fork-origin' && ctx[3].text === 'C1',
      '血缘事件 = 父前缀 2 条 + 血缘 + 子 1 条，实际 ' + JSON.stringify(ctx.map((e) => e.text || e.kind)));
  });

  await check('环防护：自引用血缘不超过深度上限', () => {
    const logs = { a: [{ seq: 1, ts: 1, kind: 'fork-origin', from: 'a', atIndex: 0 }] };
    const load = (sid) => logs[sid] || [];
    const tl = SE.buildTimeline(load, 'a');
    assert(tl.length <= SE.FORK_DEPTH_MAX + 2, '不应无限递归，实际 ' + tl.length);
  });

  await check('上下文重建：只出 user/assistant 正文（工具步骤不回灌）', () => {
    const ctx = SE.rebuildContext([
      { seq: 1, ts: 1, kind: 'user', text: 'hi' },
      { seq: 2, ts: 2, kind: 'assistant', text: 'hello', tools: [{ name: 'x', phase: 'done' }] },
      { seq: 3, ts: 3, kind: 'fork-origin', from: 'p', atIndex: 1 },
    ]);
    assert(ctx.length === 2 && ctx[0].role === 'user' && ctx[1].role === 'assistant', JSON.stringify(ctx));
  });

  await check('祖先完整性：父日志为空的血缘链必须判残缺（审阅回归）', () => {
    // 场景：legacy 父会话（从未入事件流）先被分叉 → 子日志只有 fork-origin
    const logs = {
      orphan: [{ seq: 1, ts: 1, kind: 'fork-origin', from: 'ghost', fromTitle: '幽灵父', atIndex: 3 }],
      child: [{ seq: 1, ts: 1, kind: 'fork-origin', from: 'parent', atIndex: 1 }, { seq: 2, ts: 2, kind: 'user', text: 'C1' }],
      parent: [{ seq: 1, ts: 1, kind: 'user', text: 'P1' }],
    };
    const load = (sid) => logs[sid] || [];
    assert(SE.hasIncompleteAncestry(load, 'orphan') === true, '父日志为空应判残缺');
    assert(SE.hasIncompleteAncestry(load, 'child') === false, '父日志有事件应完整');
    assert(SE.hasIncompleteAncestry(load, 'parent') === false, '无 fork-origin 应完整');
    // 残缺链的时间线确实缺继承前缀——证明回落 legacy 是必要的
    const tl = SE.buildTimeline(load, 'orphan');
    assert(tl.length === 1 && tl[0].kind === 'fork-origin', '残缺链回放只有分叉标记，实际 ' + JSON.stringify(tl));
  });

  await check('单次收集：timelineFromLabeled(collectLabeled) 与 buildTimeline 输出一致', () => {
    const logs = {
      parent: [{ seq: 1, ts: 1, kind: 'user', text: 'P1' }],
      child: [{ seq: 1, ts: 2, kind: 'fork-origin', from: 'parent', atIndex: 1 }, { seq: 2, ts: 3, kind: 'user', text: 'C1' }],
    };
    const load = (sid) => logs[sid] || [];
    const a = SE.timelineFromLabeled(SE.collectLabeled(load, 'child'));
    const b = SE.buildTimeline(load, 'child');
    assert(JSON.stringify(a) === JSON.stringify(b), '两条路径输出必须一致');
    // 上下文从同一份派生
    const ctx = SE.rebuildContext(SE.collectLabeled(load, 'child').map((x) => x.ev));
    assert(ctx.length === 2 && ctx[0].text === 'P1', JSON.stringify(ctx));
  });

  /* ============================== B 组：真实 IPC ============================== */
  console.log('\n== SessionEvent：IPC 桥接 ==');

  const probe = runProbe();

  await check('fork-event：子日志落一条 fork-origin 血缘', () => {
    assert(probe.forkOk === true, 'fork-event 应 ok: ' + (probe.forkReason || ''));
    assert(probe.forkCount === 1, '应写 1 条血缘');
  });

  await check('session-events：沿父子链拼接时间线（event-log 源，父前缀按 atIndex 截断）', () => {
    assert(probe.source === 'event-log', 'source 应为 event-log，实际 ' + probe.source);
    assert(probe.count === 1, '子日志本身 1 条事件（fork-origin 血缘），实际 ' + probe.count);
    assert(probe.timelineLen === 2, `父 1 条（atIndex=1 截断）+ fork 起点 = 2，实际 ${probe.timelineLen}`);
    assert(probe.firstIsParent === true, '时间线第 1 项应是父事件');
    assert(/p1#/.test(probe.parentSeqSample), '父事件 seq 应带 p1 前缀，实际 ' + probe.parentSeqSample);
  });

  await check('回放上下文：context 只含 user/assistant 正文', () => {
    assert(probe.ctxLen === 1 && probe.ctxRole0 === 'user' && probe.ctxText0 === '来自父亲的消息', JSON.stringify(probe.ctx));
  });

  await check('无事件日志的会话 → source=legacy（渲染层回退消息数组重建）', () => {
    assert(probe.legacySource === 'legacy' && probe.legacyCount === 0, JSON.stringify({ s: probe.legacySource, c: probe.legacyCount }));
  });

  await check('legacy 父会话被分叉 → 整体回落 legacy（不拿残缺事件流冒充完整回放）', () => {
    assert(probe.orphanForkOk === true, 'fork-event 应 ok');
    assert(probe.orphanSource === 'legacy', '残缺血缘应回落 legacy，实际 ' + probe.orphanSource);
  });

  await check('防线：穿越 id 的 fork-event 被拒绝', () => {
    assert(probe.traverseRejected === true, '路径穿越应被拒绝');
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();

/** 子进程跑真实主进程：stub electron。 */
function runProbe() {
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    // probe 脚本落在系统临时目录，__dirname 指向那里 —— 所有路径必须以 APP_DIR 为基准。
    const APP_DIR = ${JSON.stringify(APP_DIR)};
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
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
      const SE = require(path.join(APP_DIR, 'dist', 'session-events.js'));
      // 父日志种子：1 条 user 事件
      SE.appendEvents(SE.eventFileFor(HOME, 'parent'), [{ ts: 1, kind: 'user', text: '来自父亲的消息' }]);

      require(path.join(APP_DIR, 'dist', 'main.js'));
      for (let i = 0; i < 200; i++) {
        if (ipc.get('orchdesk:session-events')) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // 1. 分叉落血缘
      const f = await ipc.get('orchdesk:fork-event')(null, { newId: 'child', from: 'parent', fromTitle: '父', atIndex: 1, at: 12345 });
      out.forkOk = f.ok === true; out.forkCount = f.count; out.forkReason = f.reason;

      // 2. 子会话回放：沿链拼接
      const r = await ipc.get('orchdesk:session-events')(null, 'child');
      out.source = r.source; out.count = r.count; out.timelineLen = (r.timeline || []).length;
      out.firstIsParent = (r.timeline || [])[0] && (r.timeline || [])[0].detail === '来自父亲的消息';
      out.parentSeqSample = ((r.timeline || [])[0] || {}).seq || '';
      out.ctx = r.context || [];
      out.ctxLen = out.ctx.length;
      out.ctxRole0 = out.ctx[0] && out.ctx[0].role;
      out.ctxText0 = out.ctx[0] && out.ctx[0].text;

      // 3. legacy 回退
      const r2 = await ipc.get('orchdesk:session-events')(null, 'no-log-session');
      out.legacySource = r2.source; out.legacyCount = r2.count;

      // 4. legacy 父会话被分叉 → 血缘链残缺，整体回落 legacy（审阅回归：不拿残缺事件流冒充 event-log）
      const f3 = await ipc.get('orchdesk:fork-event')(null, { newId: 'orphan', from: 'ghost', fromTitle: '幽灵父', atIndex: 2, at: 12346 });
      out.orphanForkOk = f3.ok === true;
      const r3 = await ipc.get('orchdesk:session-events')(null, 'orphan');
      out.orphanSource = r3.source; out.orphanCount = r3.count;

      // 5. 穿越拒绝
      const f2 = await ipc.get('orchdesk:fork-event')(null, { newId: '../evil', from: 'parent', atIndex: 1 });
      out.traverseRejected = f2.ok !== true;

      console.log('RESULT_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + ((e && e.stack) || e)); process.exit(1); });
  `;
  const tmp = path.join(os.tmpdir(), `ev-probe-${Date.now()}.cjs`);
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
