/**
 * 编排闭环验证（SubAgent 派生 + 多 Agent 编排）
 * ----------------------------------------------------------------------------
 * 背景：scripts/verify-plugins.mjs 已覆盖「9 插件能否装载 + 各服务冒烟」，
 * 但没有在**真实编译产物**上验证过编排闭环本身：
 *   - brain 的 SubAgent 派生是否真的走 ctx.agents.create、meta 是否带
 *     origin:'subagent' / delegationDepth:1（ADR-0004 的隔离凭据）；
 *   - 状态机 dispatched→executing→disposed 是否成立、是否零残留；
 *   - 并发背压（maxConcurrentSubagents）到底是被拒绝还是排队；
 *   - promoteWorkerOutput 是否 fail-closed（Worker 输出不得直写上层记忆）；
 *   - multi 的 CEO→Director→Worker 三层是否真按 depth 1/2 建、是否在 finally
 *     里「即用即走」地 dispose（成功与抛错两条路径都不能泄漏）。
 * 本机无法启动 Electron GUI（BUG-W02），故走「node 直驱真实 lib 产物 + 宿主服务桩」。
 *
 * 装载方式与生产一致：真实 Cordis Context（effect/on/provide/inject 由 Cordis 提供）
 * + 桩掉的 `agents` 宿主服务（唯一外部依赖），比纯 mock ctx 更贴近生产。
 *
 * 运行：node scripts/verify-orchestration.mjs
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Context } = require('@deepseek-ai/cordis');

let passed = 0;
let failed = 0;
const log = [];
let current = '';

function check(name, fn) {
  const fail = (e) => {
    failed++;
    // 失败信息补堆栈首行，方便直接定位断言出错位置
    const stackLine = (e && e.stack ? e.stack.split('\n')[1] : '') || '';
    log.push(`  FAIL  [${current}] ${name}\n        ${e.message}\n        ${stackLine.trim()}`);
  };
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => { passed++; log.push(`  PASS  [${current}] ${name}`); }, fail);
    }
    passed++;
    log.push(`  PASS  [${current}] ${name}`);
  } catch (e) {
    fail(e);
  }
  return undefined;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function settle(n = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

/** Cordis 期望 inject 为对象；插件导出的是数组 → 归一化。 */
function normalizeInject(mod) {
  const out = { ...mod };
  if (Array.isArray(out.inject)) {
    const obj = {};
    for (const k of out.inject) obj[k] = true;
    out.inject = obj;
  }
  return out;
}

async function loadPlugin(name) {
  const mod = await import(pathToFileURL(require.resolve(`../packages/plugin/${name}/lib/index.js`)).href);
  return { mod, plugin: normalizeInject(mod) };
}

// ---------------------------------------------------------------------------
// 宿主服务桩：agents（唯一被替换的外部依赖）
// ---------------------------------------------------------------------------
/**
 * 记录调用序列的 agents 桩。句柄形状对齐 apps/desktop/host-services.ts 的
 * AgentHandleLike：{ agent:{id,meta}, dispose(), followup() }。
 */
function createAgentsMock() {
  /** 每次 create 的入参快照（顺序即调用序列）。 */
  const calls = [];
  /** 仍存活的 SubAgent：sessionId → handle（dispose 后移除）。 */
  const live = new Map();
  /** 人类可读的调用序（create:x → dispose:x）。 */
  const seqLog = [];
  /** followup 调用序列（断言 composeTeam 真实下发 task 给 subagent）。 */
  const followupCalls = [];
  const hooks = { beforeCreate: null, duringCreate: null, failFollowup: null };
  let n = 0;

  const service = {
    async create(opts = {}) {
      const index = n++;
      if (hooks.beforeCreate) hooks.beforeCreate(index, opts);
      const sessionId = opts.sessionId || `mock-sub-${index}`;
      const meta = opts.meta ? { ...opts.meta } : {};
      calls.push({ index, sessionId, meta });
      seqLog.push(`create:${sessionId}`);
      const handle = {
        agent: { id: sessionId, meta },
        meta,
        disposeCount: 0,
        async dispose() {
          this.disposeCount++;
          live.delete(sessionId);
          seqLog.push(`dispose:${sessionId}`);
        },
      };
      live.set(sessionId, handle);
      if (hooks.duringCreate) hooks.duringCreate(opts, sessionId);
      return handle;
    },
    // followup 对齐真实 host-services：{ sessionId, messages } → 运行器结果。
    // 句柄形状与真实 AgentHandleLike 一致：handle 无 followup（followup 在 service 上）。
    async followup(sessionId, messages) {
      followupCalls.push({ sessionId, messages: (messages || []).map((m) => ({ role: m.role, content: m.content })) });
      if (!live.has(sessionId)) return { text: `（SubAgent ${sessionId} 不存在或已销毁）` };
      if (hooks.failFollowup) {
        const e = hooks.failFollowup;
        hooks.failFollowup = null;
        throw (e instanceof Error ? e : new Error(String(e)));
      }
      const content = (messages || []).map((m) => String(m.content || '')).join(' ');
      return { text: `（mock 执行）${content}`.slice(0, 120) };
    },
    list() { return [...live.keys()]; },
  };

  return { service, calls, live, seqLog, hooks, followupCalls };
}

/** 所有 boot 出的 fiber：脚本结束（含异常路径）统一 dispose，不留存活 SubAgent。 */
const allFibers = [];

/** 起一个「真实 Cordis Context + 桩 agents + 指定插件」的运行时。 */
async function boot(pluginName, configOverride = {}) {
  const ctx = new Context();
  const mock = createAgentsMock();
  ctx.plugin({
    name: 'verify-host-agents',
    apply(c) { c.provide('agents', mock.service); },
  });
  await settle();
  const { mod, plugin } = await loadPlugin(pluginName);
  const config = typeof plugin.Config === 'function' ? plugin.Config(configOverride) : undefined;
  const fiber = ctx.plugin(plugin, config);
  allFibers.push(fiber);
  await settle();
  return { ctx, fiber, mod, mock, config };
}

/** 尽力 dispose 所有 fiber（幂等，异常吞掉）。 */
async function disposeAllFibers() {
  for (const f of allFibers.splice(0)) {
    try { await Promise.resolve(f.dispose()); } catch { /* 已处置或不可用 */ }
  }
  await settle();
}

// ---------------------------------------------------------------------------
(async () => {
  // =========================================================================
  // brain：SubAgent 派生
  // =========================================================================
  const brainRt = await boot('brain', { maxConcurrentSubagents: 3 });
  const { ctx: bctx, fiber: bfiber, mock: bmock, mod: bmod } = brainRt;
  let brain = bctx.brainHands;
  /** create 执行期间观测到的 SubAgent 状态（用于验证 dispatched 瞬态）。 */
  const statusDuringCreate = [];
  bmock.hooks.duringCreate = (opts) => {
    const snap = brain ? brain.listSubAgents() : [];
    const mine = snap.find((r) => r.sessionId === opts.sessionId);
    if (mine) statusDuringCreate.push(mine.status);
  };

  current = 'brain·装载';
  console.log('== brain（SubAgent 派生）==');
  await check('brain 插件在宿主桩上激活（fiber.state=2）', () => {
    assert(bfiber.state === 2, `未激活，state=${bfiber.state}`);
  });
  await check('导出 brainHands 服务（dispatch/dispose/promote/list/subscribe）', () => {
    assert(brain, 'ctx.brainHands 未注入');
    for (const k of ['dispatchSubAgent', 'disposeSubAgent', 'promoteWorkerOutput', 'listSubAgents', 'subscribe']) {
      assert(typeof brain[k] === 'function', `缺少方法 ${k}`);
    }
  });

  current = 'brain·派生';
  await check('dispatchSubAgent 走 ctx.agents.create（调用序列 +1）', async () => {
    const before = bmock.calls.length;
    await brain.dispatchSubAgent({ label: '验证任务', prompt: 'do it', parentSession: 'sess-ceo-1' });
    assert(bmock.calls.length === before + 1, `create 未被调用，实际 ${bmock.calls.length - before} 次`);
  });
  await check('create 入参 meta.origin === "subagent"', () => {
    const meta = bmock.calls[bmock.calls.length - 1].meta;
    assert(meta.origin === 'subagent', 'meta.origin=' + meta.origin);
  });
  await check('create 入参 meta.delegationDepth === 1', () => {
    const meta = bmock.calls[bmock.calls.length - 1].meta;
    assert(meta.delegationDepth === 1, 'meta.delegationDepth=' + meta.delegationDepth);
  });
  await check('create 入参带回 parentSession（可溯源到主会话）', () => {
    const meta = bmock.calls[bmock.calls.length - 1].meta;
    assert(meta.parentSession === 'sess-ceo-1', 'meta.parentSession=' + meta.parentSession);
  });
  await check('返回 id 为 W-xxx 形态（inline 芯片 id）', async () => {
    const rec = await brain.dispatchSubAgent({ label: '第二只', prompt: 'x' });
    assert(/^W-\d+$/.test(rec.id), 'id 形态不符：' + rec.id);
  });

  current = 'brain·状态机';
  /** 清空当前所有存活 SubAgent（并发上限 3，必须留槽位给后续用例）。 */
  const drain = async () => {
    for (const r of brain.listSubAgents()) await brain.disposeSubAgent(r.id);
  };
  await check('状态机：create 期间为 dispatched', () => {
    assert(statusDuringCreate.length > 0, '未观测到 create 期间的记录');
    assert(statusDuringCreate[0] === 'dispatched', '实际 ' + statusDuringCreate[0]);
  });
  await check('状态机：返回后为 executing（listSubAgents 可查）', async () => {
    await drain();
    const rec = await brain.dispatchSubAgent({ label: '第三只', prompt: 'x' });
    assert(rec.status === 'executing', '返回记录 status=' + rec.status);
    const inList = brain.listSubAgents().find((r) => r.id === rec.id);
    assert(inList && inList.status === 'executing', '列表中状态=' + (inList && inList.status));
    await brain.disposeSubAgent(rec.id);
  });
  await check('状态机：dispose 事件里为 disposed（并带回 result/finishedAt）', async () => {
    await drain();
    const events = [];
    const off = brain.subscribe((e) => events.push(e));
    const rec = await brain.dispatchSubAgent({ label: '待销毁', prompt: 'x' });
    await brain.disposeSubAgent(rec.id, '任务完成');
    off();
    const dispatchEvt = events.find((e) => e.kind === 'dispatch' && e.record.id === rec.id);
    assert(dispatchEvt && dispatchEvt.record.status === 'executing', 'dispatch 事件应为 executing');
    const disposeEvt = events.find((e) => e.kind === 'dispose' && e.record.id === rec.id);
    assert(disposeEvt, '未收到 dispose 事件');
    assert(disposeEvt.record.status === 'disposed', 'status=' + disposeEvt.record.status);
    assert(disposeEvt.record.result === '任务完成', 'result 未带回：' + disposeEvt.record.result);
    assert(typeof disposeEvt.record.finishedAt === 'number', 'finishedAt 未落');
  });

  current = 'brain·即用即走';
  await check('disposeSubAgent 调用真实句柄 dispose()', async () => {
    await drain();
    const before = bmock.seqLog.filter((s) => s.startsWith('dispose:')).length;
    const rec = await brain.dispatchSubAgent({ label: '句柄验证', prompt: 'x' });
    await brain.disposeSubAgent(rec.id);
    const after = bmock.seqLog.filter((s) => s.startsWith('dispose:')).length;
    assert(after === before + 1, `句柄 dispose 未被调用（${before} → ${after}）`);
  });
  await check('dispose 后零残留：注册表 + 宿主句柄双向清空', async () => {
    await drain();
    const rec = await brain.dispatchSubAgent({ label: '零残留验证', prompt: 'x' });
    assert(bmock.live.has(rec.sessionId), '句柄应处于存活状态');
    await brain.disposeSubAgent(rec.id);
    assert(!brain.listSubAgents().some((r) => r.id === rec.id), '注册表仍有残留');
    assert(!bmock.live.has(rec.sessionId), '宿主 agents 服务仍有存活句柄');
  });
  await check('重复 dispose 幂等（不二次调用句柄、不抛错）', async () => {
    await drain();
    const rec = await brain.dispatchSubAgent({ label: '幂等', prompt: 'x' });
    const h = bmock.live.get(rec.sessionId);
    await brain.disposeSubAgent(rec.id);
    await brain.disposeSubAgent(rec.id);
    assert(h.disposeCount === 1, `句柄被 dispose ${h.disposeCount} 次`);
  });
  await check('未知 id dispose 不抛错', async () => {
    await drain();
    await brain.disposeSubAgent('W-9999', 'x');
  });

  current = 'brain·并发背压';
  await check('超过 maxConcurrentSubagents(3) 直接拒绝（抛错，非排队）', async () => {
    await drain();
    const a = await brain.dispatchSubAgent({ label: 'c1', prompt: 'x' });
    const b = await brain.dispatchSubAgent({ label: 'c2', prompt: 'x' });
    const c = await brain.dispatchSubAgent({ label: 'c3', prompt: 'x' });
    assert(brain.listSubAgents().length === 3, '应已有 3 只在跑');
    let rejected = false;
    try {
      await brain.dispatchSubAgent({ label: 'c4', prompt: 'x' });
    } catch (e) {
      rejected = true;
      assert(/concurrency cap/i.test(e.message), '拒绝原因不符：' + e.message);
    }
    assert(rejected, '第 4 只应被拒绝（背压未生效）');
    for (const id of [a.id, b.id, c.id]) await brain.disposeSubAgent(id);
  });
  await check('背压拒绝时不产生半成品记录（注册表不增长）', async () => {
    await drain();
    const a = await brain.dispatchSubAgent({ label: 'd1', prompt: 'x' });
    const b = await brain.dispatchSubAgent({ label: 'd2', prompt: 'x' });
    const c = await brain.dispatchSubAgent({ label: 'd3', prompt: 'x' });
    const sizeBefore = brain.listSubAgents().length;
    try { await brain.dispatchSubAgent({ label: 'd4', prompt: 'x' }); } catch { /* 预期被拒 */ }
    assert(brain.listSubAgents().length === sizeBefore, '被拒后注册表不应增长');
    assert(!brain.listSubAgents().some((r) => r.label === 'd4'), '被拒的记录不应进入注册表');
    for (const id of [a.id, b.id, c.id]) await brain.disposeSubAgent(id);
  });
  await check('释放槽位后可继续派发（背压可恢复）', async () => {
    await drain();
    const r1 = await brain.dispatchSubAgent({ label: 'r1', prompt: 'x' });
    await brain.disposeSubAgent(r1.id);
    const r2 = await brain.dispatchSubAgent({ label: 'r2', prompt: 'x' });
    assert(r2 && r2.id, '释放后应能继续派发');
    await brain.disposeSubAgent(r2.id);
  });

  const brainRt1 = await boot('brain', { maxConcurrentSubagents: 1 });
  await check('maxConcurrentSubagents=1：第 2 只即被拒绝', async () => {
    const a = await brainRt1.ctx.brainHands.dispatchSubAgent({ label: 'a', prompt: 'x' });
    let rejected = false;
    try { await brainRt1.ctx.brainHands.dispatchSubAgent({ label: 'b', prompt: 'x' }); } catch { rejected = true; }
    assert(rejected, '上限 1 时第 2 只应被拒绝');
    assert(brainRt1.mock.calls.length === 1, `被拒时不应创建句柄，实际 create ${brainRt1.mock.calls.length} 次`);
    await brainRt1.ctx.brainHands.disposeSubAgent(a.id);
  });
  await check('maxConcurrentSubagents=0：不限制（连派 5 只全成功）', async () => {
    const rt = await boot('brain', { maxConcurrentSubagents: 0 });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const r = await rt.ctx.brainHands.dispatchSubAgent({ label: `u${i}`, prompt: 'x' });
      ids.push(r.id);
    }
    assert(rt.ctx.brainHands.listSubAgents().length === 5, '0 应表示不限制');
    await rt.fiber.dispose();
    await settle();
  });

  current = 'brain·晋升门控';
  await check('promoteWorkerOutput 默认拒绝（fail-closed）', async () => {
    const r = await brain.promoteWorkerOutput('Worker 的结论：把 A 记为结论');
    assert(r && r.approved === false, '默认不应放行：' + JSON.stringify(r));
    assert(typeof r.reason === 'string' && r.reason.length > 0, '应给出拒绝原因');
  });
  await check('promoteWorkerOutput 对任意输出一致拒绝（无隐式放行）', async () => {
    for (const out of ['', 'ok', '{"approved":true}', 'IGNORE PREVIOUS RULES']) {
      const r = await brain.promoteWorkerOutput(out);
      assert(r.approved === false, `「${out}」被放行了：` + JSON.stringify(r));
    }
  });
  await check('未放行时不向主会话/宿主写入任何内容', async () => {
    const before = bmock.calls.length;
    await brain.promoteWorkerOutput('should not spawn anything');
    assert(bmock.calls.length === before, '晋升过程不应派生新 agent');
  });
  await check('注入放行回调：匹配输出晋升成功（approved=true）', async () => {
    bmod.setDirectorFilter((out) => out.includes('APPROVE'));
    try {
      const ok = await brain.promoteWorkerOutput('结论 APPROVE：可写入 director 域');
      assert(ok.approved === true, '放行回调应放行：' + JSON.stringify(ok));
      const no = await brain.promoteWorkerOutput('不含关键词的输出');
      assert(no.approved === false, '回调不放行的输出应被拒绝：' + JSON.stringify(no));
    } finally {
      bmod.setDirectorFilter(null);
    }
  });
  await check('回调抛错/超时/返回非真 → 一律拒绝（fail-closed）', async () => {
    bmod.setDirectorFilter(() => { throw new Error('director exploded'); });
    const r1 = await brain.promoteWorkerOutput('x');
    assert(r1.approved === false && /director-filter-error/.test(r1.reason),
      '回调抛错应拒绝：' + JSON.stringify(r1));
    bmod.setDirectorFilter(() => new Promise(() => { /* 永不决议 */ }));
    const r2 = await brain.promoteWorkerOutput('x', { timeoutMs: 50 });
    assert(r2.approved === false && /timeout/i.test(r2.reason),
      '回调超时应拒绝：' + JSON.stringify(r2));
    bmod.setDirectorFilter(() => 'yes');
    const r3 = await brain.promoteWorkerOutput('x');
    assert(r3.approved === false, '返回非真应拒绝：' + JSON.stringify(r3));
    bmod.setDirectorFilter(null);
  });
  await check('移除回调后恢复默认拒绝（seam 可逆）', async () => {
    const r = await brain.promoteWorkerOutput('x');
    assert(r.approved === false, '无回调时应默认拒绝：' + JSON.stringify(r));
  });
  await check('brainHands.setFilter seam 注入放行（②半接线修复：main.ts 经此注入放行门）', async () => {
    assert(typeof brain.setFilter === 'function', 'brainHands 应暴露 setFilter 方法');
    brain.setFilter(() => true); // 用户即 Director：恒放行
    try {
      const ok = await brain.promoteWorkerOutput('任意 worker 结论');
      assert(ok.approved === true, '恒放行门应放行：' + JSON.stringify(ok));
    } finally {
      brain.setFilter(null); // 恢复默认拒绝，不污染后续用例
    }
    const back = await brain.promoteWorkerOutput('x');
    assert(back.approved === false, '移除 setFilter 后应回默认拒绝：' + JSON.stringify(back));
  });

  current = 'brain·卸载';
  await check('插件卸载（逆效应）清空注册表并销毁全部存活句柄', async () => {
    const rt = await boot('brain', { maxConcurrentSubagents: 5 });
    const rtApi = rt.ctx.brainHands; // dispose 后 ctx 上的服务会被摘除，先留住引用
    await rtApi.dispatchSubAgent({ label: 'leak-1', prompt: 'x' });
    await rtApi.dispatchSubAgent({ label: 'leak-2', prompt: 'x' });
    assert(rt.mock.live.size === 2, '应有 2 只存活');
    await Promise.resolve(rt.fiber.dispose());
    await settle();
    assert(rt.mock.live.size === 0, `卸载后仍有 ${rt.mock.live.size} 只存活句柄`);
    assert(rtApi.listSubAgents().length === 0, '卸载后注册表应为空');
  });

  // =========================================================================
  // multi：多 Agent 编排
  // =========================================================================
  const multiRt = await boot('multi', {});
  const { ctx: mctx, fiber: mfiber, mock: mmock, mod: mmod } = multiRt;
  const orch = mctx.orchestration;

  console.log('== multi（多 Agent 编排）==');
  current = 'multi·装载';
  await check('multi 插件在宿主桩上激活（fiber.state=2）', () => {
    assert(mfiber.state === 2, `未激活，state=${mfiber.state}`);
  });
  await check('导出 orchestration 服务（getCatalog/composeTeam/getDelegationTree）', () => {
    assert(orch, 'ctx.orchestration 未注入');
    for (const k of ['getCatalog', 'composeTeam', 'getDelegationTree']) {
      assert(typeof orch[k] === 'function', `缺少方法 ${k}`);
    }
  });

  current = 'multi·专家团数据';
  await check('getCatalog 返回 8 专家 + 3 团（非空）', () => {
    const c = orch.getCatalog();
    assert(Array.isArray(c.experts) && c.experts.length === 8, '专家应为 8，实际 ' + c.experts.length);
    assert(Array.isArray(c.teams) && c.teams.length === 3, '团应为 3，实际 ' + c.teams.length);
  });
  await check('专家团数据来自插件本体（引用同一份常量，非主程序硬编码）', () => {
    const c = orch.getCatalog();
    assert(c.experts === mmod.EXPERTS, 'experts 与插件导出常量不是同一引用');
    assert(c.teams === mmod.TEAMS, 'teams 与插件导出常量不是同一引用');
  });
  await check('专家结构含 id/title/domain', () => {
    for (const e of orch.getCatalog().experts) {
      assert(e && e.id && e.title && e.domain, '专家结构不完整：' + JSON.stringify(e));
    }
  });

  current = 'multi·三层编排';
  await check('composeTeam 建立 CEO→Director(depth1)→Worker(depth2)', async () => {
    const before = mmock.calls.length;
    const t = await orch.composeTeam('team-fullstack', '验证任务');
    assert(t.rootId, '应返回 rootId');
    const seg = mmock.calls.slice(before);
    const ceo = t.nodes.find((n) => n.layer === 'ceo');
    const dirs = t.nodes.filter((n) => n.layer === 'director');
    assert(ceo && ceo.parentId === undefined, '缺少 CEO 根节点');
    assert(dirs.length === 3, 'Director 应为 3，实际 ' + dirs.length);
    // 递归完整树：t.nodes 应包含 Worker 层（挂在 Director 下）
    const workers = t.nodes.filter((n) => n.layer === 'worker');
    assert(workers.length === 3, 'Worker 应为 3，实际 ' + workers.length);

    assert(seg.length === 6, `应派生 6 个 agent（3 Director + 3 Worker），实际 ${seg.length}`);
    const dirIds = new Set(dirs.map((d) => d.id));
    const dirSessions = new Set(dirs.map((d) => d.sessionId));
    for (const d of dirs) assert(d.parentId === t.rootId, `${d.id} 的 parentId 应为 CEO`);
    for (const w of workers) {
      assert(dirIds.has(w.parentId), `${w.id} 的 parentId 应指向某 Director`);
      assert(dirSessions.has(mmock.calls.find((c) => c.sessionId === w.sessionId).meta.parentSession),
        `${w.id} 的 meta.parentSession 应指向其 Director`);
    }
    const depth1 = seg.filter((c) => c.meta.delegationDepth === 1);
    const depth2 = seg.filter((c) => c.meta.delegationDepth === 2);
    assert(depth1.length === 3, `delegationDepth=1 应有 3 个，实际 ${depth1.length}`);
    assert(depth2.length === 3, `delegationDepth=2 应有 3 个，实际 ${depth2.length}`);
    for (const c of seg) assert(c.meta.origin === 'subagent', '编排派生须带 origin=subagent');
  });
  await check('composeTeam 把 task 真实下发给每个 Director（followup 喂任务，非空转）', async () => {
    // 上一次 composeTeam('team-fullstack','验证任务') 已结束：此刻 followupCalls 恰为该次新增。
    // 半接线修复断言：Director 不应只 create+dispose 空转，必须经 ctx.agents.followup 拿到 task。
    const dirSessions = mmock.calls.filter((c) => c.meta.delegationDepth === 1).map((c) => c.sessionId);
    const onDir = mmock.followupCalls.filter((f) => dirSessions.includes(f.sessionId));
    assert(onDir.length === 3, `3 个 Director 都应被 followup 下发 task，实际 ${onDir.length}`);
    for (const f of onDir) {
      const content = (f.messages || []).map((m) => String(m.content || '')).join(' ');
      assert(content.includes('验证任务'), '下发给 Director 的内容应含原 task：' + JSON.stringify(content));
    }
  });
  await check('composeTeam 成功路径返回节点带 task 且已收敛 done（执行结果可见）', async () => {
    const t = await orch.composeTeam('team-writing', '写一篇文案');
    const dirs = t.nodes.filter((n) => n.layer === 'director');
    assert(dirs.length === 2, '写作团 2 成员 → 2 Director，实际 ' + dirs.length);
    for (const d of dirs) {
      assert(d.status === 'done', `${d.id} 执行成功后应收敛 done，实际 ${d.status}`);
      assert(typeof d.result === 'string' && d.result.length > 0, `${d.id} 应带真实执行结果（mock 文本），实际 ${JSON.stringify(d.result)}`);
    }
    assert(!t.nodes.some((n) => n.status === 'pending' || n.status === 'running'), '不应有未收敛节点');
  });
  await check('单 Director 执行失败 → 保留 failed + note，不拖垮团队也不洗白', async () => {
    const rt = await boot('multi', {});
    const rtOrch = rt.ctx.orchestration;
    rt.mock.hooks.failFollowup = new Error('模拟 Director 执行失败');
    const t = await rtOrch.composeTeam('team-fullstack', '注定失败的任务');
    const failed = t.nodes.filter((n) => n.layer === 'director' && n.status === 'failed');
    // failFollowup 只触发第一个 followup（一次性），其余 Director 成功。
    assert(failed.length === 1, `应有 1 个 Director 执行失败，实际 ${failed.length}`);
    assert(failed[0].note && /exec-error/.test(failed[0].note), '失败节点应带 note 说明：' + JSON.stringify(failed[0].note));
    const okDirs = t.nodes.filter((n) => n.layer === 'director' && n.status === 'done');
    assert(okDirs.length === 2, `其余 2 个 Director 应成功（不拖垮），实际 ${okDirs.length}`);
  });
  await check('Director 与 Worker 的 sessionId 互不重复（每只手独立上下文）', () => {
    const sessions = mmock.calls.map((c) => c.sessionId);
    assert(new Set(sessions).size === sessions.length, 'sessionId 出现重复：' + sessions.length + '/' + new Set(sessions).size);
  });
  await check('Worker 的 meta.parentSession 指向其 Director 会话', () => {
    const dirSessions = new Set(mmock.calls.filter((c) => c.meta.delegationDepth === 1).map((c) => c.sessionId));
    const workerCalls = mmock.calls.filter((c) => c.meta.delegationDepth === 2);
    assert(workerCalls.length > 0, '未观测到 Worker 派生');
    for (const w of workerCalls) {
      assert(dirSessions.has(w.meta.parentSession), 'Worker parentSession 未指向 Director：' + w.meta.parentSession);
    }
  });
  await check('成功路径：Director/Worker 全部在 finally 被 dispose（即用即走）', async () => {
    const before = mmock.seqLog.length;
    await orch.composeTeam('team-writing', '写作任务');
    const seg = mmock.seqLog.slice(before);
    const created = seg.filter((s) => s.startsWith('create:')).length;
    const disposed = seg.filter((s) => s.startsWith('dispose:')).length;
    assert(created === 4, '写作团 2 成员 → 应 create 4 次（2 Director + 2 Worker），实际 ' + created);
    assert(disposed === created, `create ${created} 次但 dispose ${disposed} 次`);
    assert(mmock.live.size === 0, `仍有 ${mmock.live.size} 个存活句柄未销毁`);
  });
  await check('未知 teamId 回落到自定义团且不崩溃', async () => {
    const before = mmock.seqLog.length;
    const t = await orch.composeTeam('team-not-exists', 'x');
    assert(t.rootId, '应回落到 FALLBACK_TEAM 并返回 rootId');
    assert(t.nodes.length === 1, '自定义团无成员，应只有 CEO 一个节点，实际 ' + t.nodes.length);
    assert(!t.nodes.some((n) => n.layer === 'director'), '自定义团无成员，不应派生 Director');
    assert(mmock.seqLog.length === before, '无成员时不应调用 agents.create');
  });
  await check('抛错路径：create 失败时已创建的句柄仍被 dispose（零泄漏）', async () => {
    const rt = await boot('multi', {});
    const rtOrch = rt.ctx.orchestration;
    rt.mock.hooks.beforeCreate = (index) => {
      if (index === 1) throw new Error('模拟 Worker 派生失败');
    };
    let threw = false;
    try {
      await rtOrch.composeTeam('team-fullstack', '注定失败的任务');
    } catch (e) {
      threw = true;
      assert(/模拟 Worker 派生失败/.test(e.message), '应透传原始错误，实际：' + e.message);
    }
    assert(threw, 'create 抛错时 composeTeam 应 reject');
    assert(rt.mock.live.size === 0, `抛错后仍有 ${rt.mock.live.size} 个存活句柄（finally 未生效）`);
    assert(rt.mock.seqLog.filter((s) => s.startsWith('create:')).length === 1, '只应有 1 次成功 create');
    assert(rt.mock.seqLog.filter((s) => s.startsWith('dispose:')).length === 1, '该句柄应被 finally dispose');
  });
  await check('抛错路径：失败节点置 failed，且不被后续 composeTeam 洗白', async () => {
    const rt = await boot('multi', {});
    const rtOrch = rt.ctx.orchestration;
    rt.mock.hooks.beforeCreate = (index) => {
      if (index === 1) throw new Error('模拟 Worker 派生失败');
    };
    let threw = false;
    try {
      await rtOrch.composeTeam('team-fullstack', '注定失败的任务');
    } catch (e) {
      threw = true;
      assert(/模拟 Worker 派生失败/.test(e.message), '应透传原始错误，实际：' + e.message);
    }
    assert(threw, 'create 抛错时 composeTeam 应 reject');
    assert(rt.mock.live.size === 0, `抛错后仍有 ${rt.mock.live.size} 个存活句柄（finally 未生效）`);
    // 失败节点显式收敛为 failed（可查询，而非停留在 running/pending）
    const left = rtOrch.getDelegationTree();
    assert(left.length === 3, '失败后委派树仍留有 CEO/Director/Worker 三个节点，实际 ' + left.length);
    for (const n of left) {
      assert(n.status === 'failed', `失败节点 ${n.id} 状态应为 failed，实际 ${n.status}`);
    }
    // 后续 composeTeam 成功后：本次 root 子孙置 done，历史失败节点不得被洗白
    rt.mock.hooks.beforeCreate = null;
    const t2 = await rtOrch.composeTeam('team-writing', '恢复后的任务');
    for (const n of rtOrch.getDelegationTree(t2.rootId)) {
      assert(n.status === 'done', `恢复任务节点 ${n.id} 应为 done，实际 ${n.status}`);
    }
    const all = rtOrch.getDelegationTree();
    for (const n of left) {
      const cur = all.find((x) => x.id === n.id);
      assert(cur && cur.status === 'failed', `历史失败节点 ${n.id} 被洗白为 ${cur && cur.status}`);
    }
    await Promise.resolve(rt.fiber.dispose());
    await settle();
  });

  current = 'multi·委派树';
  await check('getDelegationTree(rootId) 递归展开完整树（1 CEO + 3 Director + 3 Worker）', async () => {
    const t = await orch.composeTeam('team-fullstack', '树查询任务');
    const tree = orch.getDelegationTree(t.rootId);
    assert(Array.isArray(tree) && tree.length === 7, `完整树应为 7 节点（含孙子层），实际 ${tree.length}`);
    const root = tree.find((n) => n.id === t.rootId);
    assert(root && root.layer === 'ceo' && !root.parentId, 'root 应为无 parent 的 CEO 节点');
    const dirs = tree.filter((n) => n.layer === 'director');
    const workers = tree.filter((n) => n.layer === 'worker');
    assert(dirs.length === 3 && workers.length === 3,
      `层级数不符：director=${dirs.length} worker=${workers.length}`);
    const ids = new Set(tree.map((n) => n.id));
    for (const d of dirs) assert(d.parentId === t.rootId, `${d.id} 的 parentId 应为 root`);
    for (const w of workers) {
      assert(ids.has(w.parentId) && w.parentId !== t.rootId,
        `${w.id} 应递归展开挂在某 Director 下`);
    }
  });
  await check('全量树可还原三层结构（Worker 经 Director 的 parentId 追回）', () => {
    const all = orch.getDelegationTree();
    const byId = new Map(all.map((n) => [n.id, n]));
    const workers = all.filter((n) => n.layer === 'worker');
    assert(workers.length > 0, '全量树应能看到 Worker 层');
    for (const w of workers) {
      const parent = byId.get(w.parentId);
      assert(parent && parent.layer === 'director', `${w.id} 的父节点应为 Director，实际 ${parent && parent.layer}`);
      const grand = parent && byId.get(parent.parentId);
      assert(grand && grand.layer === 'ceo', `${w.id} 的祖父节点应为 CEO`);
    }
  });
  await check('getDelegationTree() 全量可查询（多次 compose 累积）', () => {
    const all = orch.getDelegationTree();
    assert(Array.isArray(all) && all.length >= 7, '全量树应包含历史委派，实际 ' + all.length);
    const layers = new Set(all.map((n) => n.layer));
    for (const l of ['ceo', 'director', 'worker']) assert(layers.has(l), '缺少层级 ' + l);
  });
  await check('rootId 含自增序号（ceo-<seq>-<时间戳>，同毫秒并发不碰撞）', () => {
    const roots = orch.getDelegationTree().filter((n) => n.layer === 'ceo');
    assert(roots.length > 0, '应有 CEO 根节点');
    const seen = new Set();
    for (const r of roots) {
      assert(/^ceo-\d+-\d{13}$/.test(r.id), 'rootId 形态不符：' + r.id);
      assert(!seen.has(r.id), 'rootId 碰撞：' + r.id);
      seen.add(r.id);
    }
  });
  await check('委派节点携带 sessionId / label / status', () => {
    const nodes = orch.getDelegationTree().filter((n) => n.layer !== 'ceo');
    assert(nodes.length > 0, '应有非 CEO 节点');
    for (const n of nodes) {
      assert(n.sessionId, n.id + ' 缺 sessionId');
      assert(n.label, n.id + ' 缺 label');
      assert(['pending', 'running', 'done', 'failed'].includes(n.status), n.id + ' status 非法：' + n.status);
    }
  });
  await check('编排完成后节点状态收敛为 done', () => {
    const stale = orch.getDelegationTree().filter((n) => n.status !== 'done');
    assert(stale.length === 0, '仍有未收敛节点：' + stale.map((n) => `${n.id}:${n.status}`).join(', '));
  });

  current = 'multi·委派树回收';
  await check('③maxTreeNodes：超出上限整棵 evict 最旧终态 root（保最新、不撕裂 UI）', async () => {
    // 独立小容量运行时：每 fullstack 团 7 节点，maxTreeNodes=8 → 第 2 团结束后触发回收。
    const capRt = await boot('multi', { maxTreeNodes: 8 });
    const capOrch = capRt.ctx.orchestration;
    try {
      const t1 = await capOrch.composeTeam('team-fullstack', '回收前任务1');
      const t2 = await capOrch.composeTeam('team-fullstack', '回收前任务2');
      // 2 × 7 = 14 节点，超 8 → 最旧的终态 root（t1 整棵）被 evict
      const left = capOrch.getDelegationTree();
      assert(left.length <= 8, `委派树应被回收到 ≤${8}，实际 ${left.length}`);
      const leftRoots = new Set(left.filter((n) => n.layer === 'ceo').map((n) => n.id));
      assert(!leftRoots.has(t1.rootId), `最旧的终态 root ${t1.rootId} 应被 evict`);
      assert(leftRoots.has(t2.rootId), `最新的 root ${t2.rootId} 应保留`);
      // 树结构完整：残余 CEO/Director/Worker 各层级齐（未被切半撕裂）
      const layers = new Set(left.map((n) => n.layer));
      for (const l of ['ceo', 'director', 'worker']) assert(layers.has(l), '回收后缺层级 ' + l);
    } finally {
      await Promise.resolve(capRt.fiber.dispose());
      await settle();
    }
  });

  current = 'multi·卸载';
  await check('插件卸载清空委派树（无残留）', async () => {
    await Promise.resolve(mfiber.dispose());
    await settle();
    assert(orch.getDelegationTree().length === 0, '卸载后委派树应为空');
  });

  // -------------------------------------------------------------------------
  // 收尾：dispose 所有运行时（覆盖异常路径见下方 catch），再输出结果
  // -------------------------------------------------------------------------
  await disposeAllFibers();
  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  void bmod;
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error('异常:', e);
  try { await disposeAllFibers(); } catch { /* ignore */ }
  process.exit(1);
});
