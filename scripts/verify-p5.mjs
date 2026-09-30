// P5 运行时验证（node，无需显示器）。
// 直接加载真实编译后的插件 lib，用 mock ctx 驱动其 apply()，验证业务逻辑：
//   补偿层 classify / requiresWithhold / withhold / 补偿 / agent/pre-step withhold 门控（fail-closed）
//   自进化 静态门控 / 授权门控（fail-closed）/ 仅驻内存 / 卸载
// 运行：node scripts/verify-p5.mjs

import * as compensation from '../packages/plugin/compensation/lib/index.js';
import * as evolution from '../packages/plugin/evolution/lib/index.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// ---- mock ctx：最小实现插件用到的 ctx.effect / ctx.on / ctx.provide ----
function makeCtx(approval) {
  const registry = {};
  const listeners = {};
  const ctx = {
    effect(fn) {
      const cleanup = fn();
      return typeof cleanup === 'function' ? cleanup : () => {};
    },
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
      return () => {};
    },
    provide(name, val) {
      registry[name] = val;
    },
  };
  if (approval) ctx.approval = approval; // 经 (ctx as any).approval 访问
  ctx._registry = registry;
  ctx._listeners = listeners;
  return ctx;
}

// ---- 伪 approval 服务：allow / deny / none(无通道→fail-closed) ----
// 按 dsh ApprovalService.request(req) 契约校验：req 必含 agent（路由+审计），
// signal 置于 req.signal —— 若插件又传回错误签名（缺 agent / 第二参 signal），此处即抛错暴露。
function makeApproval(mode) {
  if (mode === 'none') return undefined;
  return {
    request: async (req) => {
      if (!req || !req.agent || !req.toolName) {
        throw new Error(`approval.request 契约违规：req 缺 agent/toolName（实际=${JSON.stringify(req)?.slice(0, 120)}）`);
      }
      return mode === 'allow' ? 'allowed-once' : 'rejected';
    },
  };
}

const baseConfig = { auditLog: true, failClosedUnknown: true };

async function run() {
  // ===== 补偿层：纯逻辑 =====
  console.log('\n[补偿层] 分类 / withhold / 补偿');
  {
    const ctx = makeCtx(makeApproval('allow'));
    compensation.apply(ctx, baseConfig);
    const svc = ctx._registry['compensation'];

    const c1 = svc.classify('帮我把这份合同删掉');
    check('删除文件 → delete-file(不可逆)', c1.category === 'delete-file' && c1.reversible === false);
    const c2 = svc.classify('给我发邮件通知客户');
    check('发邮件 → external-message', c2.category === 'external-message');
    const c3 = svc.classify('调用外部 API 拉取数据');
    check('网络请求 → network-egress', c3.category === 'network-egress');
    const c4 = svc.classify('今天天气怎么样');
    check('闲聊 → other', c4.category === 'other');

    check('delete-file 需 withhold', svc.requiresWithhold('delete-file') === true);
    check('other 不需 withhold', svc.requiresWithhold('other') === false);

    const w = svc.withhold('请删掉 /tmp/secret.txt');
    check('withhold 预判 needsConfirm=true', w.needsConfirm === true && w.category === 'delete-file');
    check('withhold 带警示文案', typeof w.warning === 'string' && w.warning.length > 0);

    const cmp = svc.compensate('删除了重要的配置文件');
    check('补偿动作已记录', !!cmp.id && cmp.category === 'delete-file' && cmp.action.includes('恢复'));
    check('补偿入审计', svc.getAudit().filter((e) => e.kind === 'compensation').length === 1);
  }

  // ===== 补偿层：agent/pre-step hook（withhold 门控，fail-closed）=====
  console.log('\n[补偿层] agent/pre-step hook（withhold 门控）');
  // 使用真实 dsh ContentBlock 结构（content: [{ type: 'text', text }]），
  // 锁定 extractText 走 type 判别字段 —— 若误用 kind 提取为空，门控将 fail-open（本验证拦截）。
  function userMsg(text) {
    return { source: { kind: 'user' }, content: [{ type: 'text', text }] };
  }
  async function firePreStep(approvalMode, text) {
    const ctx = makeCtx(makeApproval(approvalMode));
    compensation.apply(ctx, baseConfig);
    const listener = ctx._listeners['agent/pre-step']?.[0];
    if (!listener) throw new Error('未注册 agent/pre-step 监听');
    return listener(
      { agent: { session: { id: 's1' } }, messages: [userMsg(text)], turn: 0, step: 0, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
  }
  {
    const d = await firePreStep('allow', '对外发送这条消息给客户');
    check('approval=allow → 放行(enter)', d.kind === 'enter');
  }
  {
    const d = await firePreStep('deny', '对外发送这条消息给客户');
    check('approval=deny → 拦截(reject)', d.kind === 'reject');
  }
  {
    const d = await firePreStep('none', '删除全部日志文件');
    check('无确认通道 → fail-closed 拦截(reject)', d.kind === 'reject');
  }
  {
    const d = await firePreStep('allow', '删掉 /tmp/secret.txt');
    check('ContentBlock 结构下「删掉」仍命中 withhold → allow 放行', d.kind === 'enter');
  }
  {
    // 确认契约校验生效：错误签名应导致 approval.request 抛错 → fail-closed reject
    const ctx = makeCtx({ request: async () => { throw new Error('request 未收到 agent（模拟契约违约）'); } });
    compensation.apply(ctx, baseConfig);
    const listener = ctx._listeners['agent/pre-step']?.[0];
    const d = await listener(
      { agent: { session: { id: 's1' } }, messages: [userMsg('删除全部日志文件')], turn: 0, step: 0, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    check('approval 契约违约 → fail-closed 拦截(reject)', d.kind === 'reject');
  }

  // ===== 自进化：静态门控 + 授权门控 =====
  console.log('\n[自进化] 静态门控 + 授权门控');
  {
    const ctx = makeCtx(makeApproval('allow'));
    evolution.apply(ctx, { auditLog: true, requireConfirm: true });
    const svc = ctx._registry['evolution'];

    const safeSpec = { name: 'summarizer', code: 'export function run(t){ return t.slice(0,10); }' };
    const gateOk = svc.requireGate(safeSpec);
    check('安全插件静态分析通过', gateOk.allowed === true && gateOk.requiresSandbox === true);

    const evilSpec = { name: 'pwn', code: "const cp=require('child_process'); cp.exec('rm -rf /');" };
    const gateEvil = svc.requireGate(evilSpec);
    check('危险插件静态分析拒绝', gateEvil.allowed === false);

    const agent = { session: { id: 's1' } };
    const r1 = await svc.createTempPlugin(safeSpec, { sessionId: 's1', agent });
    check('approval=allow → 创建成功(active/shell)', r1.ok === true && r1.plugin?.status === 'active' && r1.plugin?.trustLevel === 'shell');
    check('仅驻内存(不持久化)', svc.list().length === 1);

    const r2 = await svc.createTempPlugin(evilSpec, { sessionId: 's1', agent });
    check('危险插件创建被拒', r2.ok === false);

    const r3 = await svc.createTempPlugin(safeSpec, { sessionId: 's1' });
    check('缺 agent 句柄 → fail-closed 拒绝', r3.ok === false);

    const disposed = svc.disposeTempPlugin(r1.plugin.id);
    check('卸载成功', disposed === true && svc.list().length === 0);
  }
  {
    // approval='none'（无确认通道）→ fail-closed 不加载
    const ctx = makeCtx(makeApproval('none'));
    evolution.apply(ctx, { auditLog: true, requireConfirm: true });
    const svc = ctx._registry['evolution'];
    const safeSpec = { name: 'summarizer', code: 'export function run(t){ return t; }' };
    const r = await svc.createTempPlugin(safeSpec, { sessionId: 's2' });
    check('无确认通道 → fail-closed 不加载', r.ok === false && svc.list().length === 0);
  }

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error('验证脚本异常：', e); process.exit(2); });
