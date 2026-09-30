/**
 * 意图门决策矩阵验证（A1 风控简化）
 * ----------------------------------------------------------------------------
 * 背景：A1 前 4-gate 任一失败一律 BLOCK（fail-closed），导致「用 pnpm 安装这个
 * skill」这类提到命令词的 prompt 被意图门当场枪毙——关键词漏斗分不清「提到」
 * 与「要做」。A1 后：门失败降级 CONFIRM（放行+审计标记），BLOCK 仅保留给
 * 漏斗判定的真危险模式（不可逆 + 系统/外部半径）。强制点下沉到执行层
 * （authz L3/L4 + 补偿层 + 沙箱）。
 *
 * 为什么单独建套件而不进 e2e：e2e 是 Chromium + bridge 桩，回合在桥桩就返回，
 * 到不了主进程的 pre-step waterfall——在 e2e 里断言「不被拦截」会是假通过
 * （有 bug 也绿）。本套件用真实 Cordis waterfall + 真实 intent 插件，是唯一
 * 能覆盖该行为的层。
 *
 * 覆盖（决策矩阵）：
 *   1. g3 失败（exec-command 不在 allowedStages）→ CONFIRM → enter（A1 核心）
 *   2. g4 失败（外发主机不在 externalAllowlist）→ CONFIRM → enter
 *   3. destructive（不可逆 + system 半径，score ≥ 阈值）→ BLOCK → reject（底线保留）
 *   4. destructive 且同时门失败 → 仍 BLOCK（destructive 必须先于门失败判定）
 *   5. 低风险 query → enter
 *   6. 无本地模型 → defaultFallback=CONFIRM → enter（不静默放行也不枪毙）
 *
 * 审计出口（修复 1）：intent 审计走 ctx.logger('orchdesk-intent')，Cordis 无 exporter
 * 时消息只进内存缓冲——runtime 启动（dsh-runtime buildRuntime）现注册 exporter 转发到
 * 应用文件日志；本套件在 root ctx 注册捕获型 exporter 直接验证该链路。
 *
 * 运行：node intent-gate-verify.cjs   （需先构建 packages/plugin/intent/lib）
 */

const assert = require('node:assert');
const { pathToFileURL } = require('node:url');
const { Context } = require('@deepseek-ai/cordis');

let pass = 0, fail = 0;
function check(name, fn) {
  return fn().then(
    () => { pass++; console.log(`  PASS  ${name}`); },
    (err) => { fail++; console.log(`  FAIL  ${name}\n        ${(err && err.stack || err).toString().split('\n').slice(0, 3).join('\n        ')}`); },
  );
}

(async () => {
  const ctx = new Context();
  // C1 档位假服务（纯意图层隔离测试；全插件集的交互在 verify-plugins）。
  let fakeMode = 'default';
  // 最小宿主：sandboxPolicy + approval + authz 档位假服务（本套件不触达补偿层）。
  ctx.plugin({
    name: 'gate-test-host',
    apply(c) {
      c.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }), setSandboxMode: () => {} });
      c.provide('approval', { request: async () => 'unavailable', setPolicy: () => {} });
      c.provide('authz', { getMode: async () => fakeMode });
    },
  });

  const mod = await import(pathToFileURL(require.resolve('../packages/plugin/intent/lib/index.js')).href);
  const cfg = typeof mod.Config === 'function' ? mod.Config({}) : undefined;
  ctx.plugin(mod, cfg);
  await new Promise((r) => setTimeout(r, 50));

  // 修复 1 验证：在 root ctx 注册 exporter（模拟 runtime 启动时的审计出口），
  // 断言插件审计行真的到达 sink——而不是只进内存缓冲。
  const exported = [];
  const loggerService = ctx.logger;
  loggerService?.exporter?.({ export(m) { exported.push(m); } });

  const fire = (text) => ctx.waterfall('agent/pre-step', {
    agent: { session: { id: 's1' }, meta: { id: 'a1' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    turn: 0, step: 0,
  }, async () => ({ kind: 'enter', messages: [] }));

  await check('g3 失败（命令词 → exec-command 不在 allowlist）→ CONFIRM 放行', async () => {
    const d = await fire('用 pnpm 安装这个 skill');
    assert.strictEqual(d && d.kind, 'enter', 'A1 核心：命令词 prompt 必须放行，实际 ' + JSON.stringify(d));
  });

  await check('g4 失败（外发主机不在 externalAllowlist）→ CONFIRM 放行', async () => {
    const d = await fire('调用 https://unknown-host.example.com/v1 的接口拉数据');
    assert.strictEqual(d && d.kind, 'enter', 'g4 失败应降级放行，实际 ' + JSON.stringify(d));
  });

  await check('destructive（不可逆 + system 半径）→ BLOCK 拒绝', async () => {
    const d = await fire('把所有日志文件全部删除');
    assert.strictEqual(d && d.kind, 'reject', '真危险模式必须拦截，实际 ' + JSON.stringify(d));
  });

  await check('修复1：审计行经 exporter 到达 sink（不再只进缓冲）', async () => {
    const before = exported.length;
    await fire('把所有日志文件全部删除');
    const fresh = exported.slice(before);
    const text = fresh.map((m) => (m.args || []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n');
    assert.ok(fresh.length >= 2, 'BLOCK 应产生 ≥2 条日志（决策行 + 结构化审计行），实际 ' + fresh.length);
    assert.ok(text.includes('[orchdesk-intent]'), '应含意图门审计前缀：' + text.slice(0, 200));
    assert.ok(text.includes('BLOCK'), '应含 BLOCK 决策');
    // 级别：Cordis 默认过滤 warn/debug，BLOCK 决策行必须走 error 才可见
    assert.ok(fresh.some((m) => m.type === 'error'), 'BLOCK 决策行应为 error 级别（warn 会被默认级别过滤）');
    assert.ok(fresh.some((m) => (m.args || []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').includes('[orchdesk-intent:audit]')), '应有结构化审计行');
  });

  await check('destructive 且门失败 → 仍 BLOCK（destructive 先于门失败判定）', async () => {
    // 「删除」既命中 F1/F2（exec-command，g3 失败）又是 destructive——
    // 顺序错了就会从门失败分支漏成 CONFIRM，这是 A1 最大的回归风险点。
    const d = await fire('清空整个项目目录的所有文件');
    assert.strictEqual(d && d.kind, 'reject', 'destructive+门失败必须仍拦截，实际 ' + JSON.stringify(d));
  });

  await check('低风险 query → enter', async () => {
    const d = await fire('今天天气怎么样');
    assert.strictEqual(d && d.kind, 'enter');
  });

  await check('无本地模型 → defaultFallback=CONFIRM → enter（不枪毙）', async () => {
    // 测试宿主无 Ollama：modelUsed=false，走 defaultFallback（默认 CONFIRM）。
    // 一条不命中任何规则的中性 prompt：score=0 但无模型 → fallback 而非 ACT。
    const d = await fire('帮我看看这个文件里写了什么');
    assert.strictEqual(d && d.kind, 'enter', '无模型时应走保守回退但放行，实际 ' + JSON.stringify(d));
  });

  /* ================= C1 档位（意图层隔离） ================= */
  await check('C1：trusted → destructive 也纯审计放行', async () => {
    fakeMode = 'trusted';
    const d = await fire('把所有日志文件全部删除');
    assert.strictEqual(d && d.kind, 'enter', 'trusted 应纯审计放行，实际 ' + JSON.stringify(d));
    fakeMode = 'default';
  });
  await check('C1：paranoid → 无模型回退升为 BLOCK', async () => {
    fakeMode = 'paranoid';
    const d = await fire('帮我看看这个文件里写了什么');
    assert.strictEqual(d && d.kind, 'reject', 'paranoid 无模型应保守拒绝，实际 ' + JSON.stringify(d));
    fakeMode = 'default';
  });
  await check('C1：档位服务不可用 → 按 default 执行（不误升信任）', async () => {
    // 摘掉 authz 服务不可行（已注册）——用未知 mode 值模拟服务异常回落。
    fakeMode = 'bogus';
    const d = await fire('用 pnpm 安装这个 skill');
    assert.strictEqual(d && d.kind, 'enter', '未知档位应按 default 的 A1 形态放行，实际 ' + JSON.stringify(d));
    fakeMode = 'default';
  });

  // 收尾：意图门每次触发都会 fetch Ollama（本机无服务 → ECONNREFUSED），
  // socket 拆除与 process.exit 在 Windows 上竞态会炸 libuv 断言
  // （UV_HANDLE_CLOSING）。先让事件循环排空再销毁 context，最后才退出。
  await new Promise((r) => setTimeout(r, 200));
  try { await ctx.dispose(); } catch { /* 销毁失败不掩盖测试结果 */ }
  await new Promise((r) => setTimeout(r, 100));
  console.log(`\n结果: ${pass} 通过, ${fail} 失败, 共 ${pass + fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('套件崩溃：', err); process.exit(1); });

