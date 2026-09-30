/**
 * 会话分叉与回放验证（PRD FR-6）
 * ----------------------------------------------------------------------------
 * 被测对象就是渲染层加载的那一份：apps/desktop/renderer/session-fork.js
 * （UMD-lite，Node 与浏览器共用，无构建步骤 → 不存在「源码与产物漂移」）。
 *
 * 覆盖：
 *   A. 装载契约：index.html 在 app.js 之前加载；app.js 确实读 window.OrchDeskFork
 *   B. 血缘归一化 normalizeFork（坏数据 → null，不造假血缘）
 *   C. forkMessages 边界（非法 atIndex → 全继承；超长 → 夹到末尾；不改原数组）
 *   D. makeForkLineage 与 forkMessages 一致性（血缘记的分叉点 == 实际继承条数）
 *   E. canFork
 *   F. buildReplayTimeline（事件顺序、摘要截断、空会话、无血缘不造事件）
 *
 * 运行：node session-fork-verify.cjs
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

let passed = 0;
let failed = 0;
const log = [];
function check(name, fn) {
  try { fn(); passed++; log.push(`  PASS  ${name}`); }
  catch (err) { failed++; log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`); }
}

const RENDERER = path.join(__dirname, 'renderer');
const fork = require('./renderer/session-fork.js');

const msg = (r, x, extra) => Object.assign({ r, x, t: '10:00' }, extra || {});

// ---------------------------------------------------------------------------
console.log('\n== A. 装载契约（防死挂点）==');

check('index.html 在 app.js 之前加载 session-fork.js', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf-8');
  const iFork = html.indexOf('session-fork.js');
  const iApp = html.indexOf('src="app.js"');
  assert.ok(iFork > 0, 'index.html 未加载 session-fork.js');
  assert.ok(iApp > 0, 'index.html 未加载 app.js');
  assert.ok(iFork < iApp, `session-fork.js(${iFork}) 必须在 app.js(${iApp}) 之前`);
});

check('session-fork.js 是普通 script（无 type=module，file:// 下可直接跑）', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf-8');
  const line = html.split('\n').find((l) => l.includes('session-fork.js'));
  assert.ok(line && /<script\s+src="session-fork\.js">/.test(line), '实际: ' + line);
});

check('app.js 通过 window.OrchDeskFork 取用（不是凭空调用全局函数）', () => {
  const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf-8');
  assert.ok(app.includes('window.OrchDeskFork'), 'app.js 未引用 window.OrchDeskFork');
  // 分叉 / 回放 / 血缘三个入口都必须走 FORK，不能各写一套
  for (const fn of ['makeForkLineage', 'forkMessages', 'normalizeFork', 'buildReplayTimeline']) {
    assert.ok(app.includes('FORK.' + fn), `app.js 未调用 FORK.${fn}`);
  }
});

check('UMD：Node require 与浏览器 window 挂载都可用', () => {
  assert.strictEqual(typeof fork.makeForkLineage, 'function');
  // 模拟浏览器环境重新求值一次
  const src = fs.readFileSync(path.join(RENDERER, 'session-fork.js'), 'utf-8');
  const sandbox = { module: undefined, exports: undefined };
  const fakeWindow = {};
  const fn = new Function('window', 'globalThis', src + '\n;return (typeof module!=="undefined"&&module.exports)||window.OrchDeskFork;');
  const api = fn(fakeWindow, fakeWindow);
  assert.strictEqual(typeof api.canFork, 'function', '浏览器路径未挂上 OrchDeskFork');
  assert.strictEqual(typeof fakeWindow.OrchDeskFork, 'object', '应挂到 window.OrchDeskFork');
  void sandbox;
});

// ---------------------------------------------------------------------------
console.log('\n== B. 血缘归一化 ==');

check('完整血缘可归一化', () => {
  const f = fork.normalizeFork({ from: 's1', atIndex: 3, at: 1700000000000, fromTitle: '主干' });
  assert.deepStrictEqual(f, { from: 's1', atIndex: 3, at: 1700000000000, fromTitle: '主干' });
});

check('缺 from → null（无源不成血缘）', () => {
  assert.strictEqual(fork.normalizeFork({ atIndex: 3, at: 1 }), null);
  assert.strictEqual(fork.normalizeFork({ from: '   ', atIndex: 0, at: 1 }), null);
});

check('atIndex 非法 → null（负数 / 非数字 / 缺失）', () => {
  for (const bad of [{ from: 's1', atIndex: -1 }, { from: 's1', atIndex: 'abc' }, { from: 's1' }, { from: 's1', atIndex: NaN }]) {
    assert.strictEqual(fork.normalizeFork(bad), null, '应拒绝: ' + JSON.stringify(bad));
  }
});

check('atIndex 小数截断；at 缺失/非法补当前时间', () => {
  const f = fork.normalizeFork({ from: 's1', atIndex: 3.9 });
  assert.strictEqual(f.atIndex, 3);
  assert.ok(f.at > 0 && Number.isFinite(f.at), 'at 应补成时间戳');
});

check('非对象 / null → null', () => {
  for (const bad of [null, undefined, 42, 's1', []]) {
    assert.strictEqual(fork.normalizeFork(bad), null, '应拒绝: ' + String(bad));
  }
});

check('空标题不写入 fromTitle（避免 UI 出现空引号）', () => {
  const f = fork.normalizeFork({ from: 's1', atIndex: 0, at: 1, fromTitle: '  ' });
  assert.ok(!('fromTitle' in f), '不应有 fromTitle 字段');
});

// ---------------------------------------------------------------------------
console.log('\n== C. forkMessages 边界 ==');

const SRC = [msg('user', 'a'), msg('agent', 'b'), msg('user', 'c')];

check('正常切前 N 条', () => {
  assert.deepStrictEqual(fork.forkMessages(SRC, 2), [SRC[0], SRC[1]]);
  assert.deepStrictEqual(fork.forkMessages(SRC, 0), []);
  assert.deepStrictEqual(fork.forkMessages(SRC, 3), SRC);
});

check('atIndex 超长 → 夹到末尾（不抛错、不补空洞）', () => {
  assert.strictEqual(fork.forkMessages(SRC, 99).length, 3);
});

check('atIndex 非法（负数 / 非数字 / undefined）→ 全继承', () => {
  for (const bad of [-1, 'abc', undefined, NaN, null]) {
    assert.strictEqual(fork.forkMessages(SRC, bad).length, 3, '应全继承: ' + String(bad));
  }
});

check('非数组入参 → 空数组（不抛错）', () => {
  for (const bad of [null, undefined, {}, 'abc', 42]) {
    assert.deepStrictEqual(fork.forkMessages(bad, 2), []);
  }
});

check('不修改原数组', () => {
  const src = [msg('user', 'a'), msg('agent', 'b')];
  fork.forkMessages(src, 1);
  assert.strictEqual(src.length, 2, '原数组被改动');
});

// ---------------------------------------------------------------------------
console.log('\n== D. 血缘与继承条数一致 ==');

check('任意分叉点：fork.atIndex === forkMessages(...).length', () => {
  const src = { id: 's1', title: '主干', msgs: SRC };
  for (const at of [0, 1, 2, 3, 4, -5, 'x', undefined]) {
    const l = fork.makeForkLineage(src, at);
    assert.strictEqual(fork.forkMessages(SRC, l.atIndex).length, l.atIndex,
      `atIndex=${l.atIndex} 但继承了 ${fork.forkMessages(SRC, l.atIndex).length} 条（入参 ${String(at)}）`);
    assert.ok(l.atIndex >= 0 && l.atIndex <= SRC.length, '越界: ' + l.atIndex);
  }
});

check('源会话无 msgs → 分叉点为 0（不会读崩）', () => {
  assert.strictEqual(fork.makeForkLineage({ id: 's1' }, 5).atIndex, 0);
  assert.strictEqual(fork.makeForkLineage(null, 2).atIndex, 0);
});

check('血缘带源标题快照 + id', () => {
  const l = fork.makeForkLineage({ id: 's9', title: '主干会话', msgs: SRC }, 2, 1700000000000);
  assert.deepStrictEqual(l, { from: 's9', atIndex: 2, at: 1700000000000, fromTitle: '主干会话' });
});

check('canFork：有消息才可分叉', () => {
  assert.strictEqual(fork.canFork({ msgs: [1] }), true);
  assert.strictEqual(fork.canFork({ msgs: [] }), false);
  assert.strictEqual(fork.canFork({}), false);
  assert.strictEqual(fork.canFork(null), false);
});

// ---------------------------------------------------------------------------
console.log('\n== E. 回放时间线 ==');

check('事件顺序：消息 → 工具 → SubAgent → 反馈', () => {
  const s = {
    msgs: [
      msg('user', '你好'),
      msg('agent', '已处理', { tools: [{ n: 'file_read', ph: 'done', result: 'ok' }], sub: { name: 'reviewer', state: 'done' }, feedback: '很有帮助' }),
    ],
  };
  const tl = fork.buildReplayTimeline(s);
  assert.deepStrictEqual(tl.map((e) => e.kind), ['user', 'agent', 'tool', 'subagent', 'feedback']);
  assert.deepStrictEqual(tl.map((e) => e.seq), [1, 2, 3, 4, 5]);
});

check('有血缘时首事件是 fork-origin，且带源会话信息', () => {
  const tl = fork.buildReplayTimeline({ fork: { from: 's1', atIndex: 2, at: 1700000000000, fromTitle: '主干' }, msgs: [msg('user', 'x')] });
  assert.strictEqual(tl[0].kind, 'fork-origin');
  assert.ok(tl[0].detail.includes('主干'), '摘要应带源标题');
  assert.ok(tl[0].detail.includes('第 2 条'), '摘要应带分叉点');
});

check('坏血缘不产生 fork-origin（宁缺勿滥）', () => {
  const tl = fork.buildReplayTimeline({ fork: { atIndex: 1 }, msgs: [msg('user', 'x')] });
  assert.ok(!tl.some((e) => e.kind === 'fork-origin'));
});

check('摘要截断到 DETAIL_MAX 且加省略号', () => {
  const long = 'x'.repeat(500);
  const tl = fork.buildReplayTimeline({ msgs: [msg('user', long)] });
  assert.strictEqual(tl[0].detail.length, fork.DETAIL_MAX + 1, '应为 120 字 + 省略号');
  assert.ok(tl[0].detail.endsWith('…'));
});

check('空白折叠：换行/多空格压成单空格', () => {
  const tl = fork.buildReplayTimeline({ msgs: [msg('user', 'a\n\n  b   c')] });
  assert.strictEqual(tl[0].detail, 'a b c');
});

check('tool 无 result → 按状态给「执行中 / 完成」兜底', () => {
  const tl = fork.buildReplayTimeline({ msgs: [msg('agent', '', { tools: [{ n: 'shell', ph: 'running' }, { n: 'read', ph: 'done' }] })] });
  const tools = tl.filter((e) => e.kind === 'tool');
  assert.strictEqual(tools[0].detail, '执行中');
  assert.strictEqual(tools[0].status, 'running');
  assert.strictEqual(tools[1].detail, '完成');
  assert.strictEqual(tools[1].status, 'done');
});

check('typing 中的消息 status=running', () => {
  const tl = fork.buildReplayTimeline({ msgs: [msg('agent', '', { typing: true })] });
  assert.strictEqual(tl[0].status, 'running');
});

check('空会话 / null → 空时间线（不抛错）', () => {
  assert.deepStrictEqual(fork.buildReplayTimeline(null), []);
  assert.deepStrictEqual(fork.buildReplayTimeline({}), []);
  assert.deepStrictEqual(fork.buildReplayTimeline({ msgs: 'not-array' }), []);
});

check('每条事件都有 label（UI 直接展示，不留空）', () => {
  const tl = fork.buildReplayTimeline({
    fork: { from: 's1', atIndex: 0, at: 1 },
    msgs: [msg('user', 'a'), msg('agent', 'b', { tools: [{ n: 't' }], sub: { name: 'x' }, feedback: 'f' })],
  });
  for (const e of tl) {
    assert.ok(e.label && String(e.label).trim(), '事件缺少 label: ' + JSON.stringify(e));
    assert.ok(e.ts !== undefined, '事件缺少 ts 字段');
  }
});

check('REPLAY_KIND_LABELS 覆盖全部 6 种事件类型', () => {
  const kinds = ['fork-origin', 'user', 'agent', 'tool', 'subagent', 'feedback'];
  for (const k of kinds) assert.ok(fork.REPLAY_KIND_LABELS[k], '缺中文名: ' + k);
});

// ---------------------------------------------------------------------------
console.log('\n' + log.join('\n'));
console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
if (failed > 0) process.exit(1);
console.log('会话分叉与回放全部验证通过');
process.exit(0);
