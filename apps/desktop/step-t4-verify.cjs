/**
 * T4 集成验证。不新增产品行为，不改锁定点的裁决函数。
 * 一条不经 dsh 的 tool_call 必须与锁定点 decideStepToolCall 一致。
 * 危险命令必须走到本 GUI 的 confirm，不能靠放行开关跳过。
 * 界面只有默认模式 / 完全信任。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const seam = require('./dist/step-extension.js');
const { registerAuthzIpc } = require('./dist/ipc-authz.js');
const dsh = require('./dist/dsh-runtime.js');

const nativeImport = new Function('specifier', 'return import(specifier)');
const BANNED_UI = ['默认安全', '信任模式', '偏执', 'paranoid', 'trusted', 'full-trust', 'bypassPermissions', 'read-only'];

/**
 * pi 的空壳。只实现 on 与注册类调用，其余一律返回空函数并记下调用名——
 * 静默吞掉会让「扩展是否真的注册过」变得不可观测。
 * 锁定扩展会注册 1 个 provider 与若干 command，这些调用必须落到 calls 里。
 */
function piStub(calls) {
  const handlers = {};
  const pi = {
    handlers,
    on(event, handler) {
      handlers[event] = handler;
    },
  };
  return new Proxy(pi, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => { calls.push(String(prop)); };
    },
  });
}

function assertNoBypassSwitch(options) {
  const encoded = JSON.stringify(options);
  assert.equal(encoded.includes('bypassPermissions'), false);
  assert.equal(Object.hasOwn(options, 'sandbox'), false);
  assert.equal(Object.hasOwn(options.permission, 'nonInteractiveApproval'), false);
  assert.equal(Object.hasOwn(options.permission, 'approvalMode'), false);
  assert.deepStrictEqual(options.permission.env, {});
}

async function drivePreset(preset, real) {
  const seen = [];
  const confirms = [];
  const confirm = async (title, message) => {
    confirms.push({ title, message });
    return false;
  };
  const wired = seam.composeStepExtension({
    preset,
    confirm,
    load: {
      createStepExtensionInline(options) {
        seen.push(options);
        assertNoBypassSwitch(options);
        return real.createStepExtensionInline(options);
      },
    },
  });
  const registered = [];
  const pi = piStub(registered);
  wired.extension.factory(pi);
  assert.equal(typeof pi.handlers.tool_call, 'function');
  // 锁定扩展除 tool_call 外还注册 provider 与 slash command。这些必须被记下，
  // 否则空壳静默吞掉注册，后面所有断言都只覆盖了 tool_call 这一条路径。
  assert.ok(registered.includes('registerProvider'), '扩展未注册 provider');
  assert.ok(registered.filter((n) => n === 'registerCommand').length >= 2, '扩展未注册 slash command');
  assert.equal(registered.includes('registerTools'), false, '扩展意外注册了工具');
  return { wired, seen, confirms, pi, confirm, registered };
}

async function assertToolCallMatches(preset, real, locked) {
  assert.equal(dsh.getRuntime(), null);
  const { seen, confirms, pi, confirm } = await drivePreset(preset, real);
  assert.equal(seen[0].permission.initialPreset, preset);
  const state = locked.resolveInitialStepPermissionState({ initialPreset: preset, env: {} });
  assert.equal(state.preset, preset);
  assert.notEqual(state.defaulted, true);

  const ordinary = { toolName: 'read', input: { path: 'README.md' }, toolCallId: 'ordinary-00000001' };
  const ordinaryDecision = locked.decideStepToolCall(ordinary.toolName, ordinary.input, state);
  assert.equal(ordinaryDecision.action, 'allow', `${preset} 的 read 应允许`);
  const ordinaryResult = await pi.handlers.tool_call(ordinary, { ui: {} });
  assert.equal(ordinaryResult, undefined);
  assert.equal(confirms.length, 0);
  assert.equal(dsh.getRuntime(), null);

  const dangerous = { toolName: 'bash', input: { command: 'git reset --hard' }, toolCallId: 'danger-00000001' };
  const dangerousDecision = locked.decideStepToolCall(dangerous.toolName, dangerous.input, state);
  assert.equal(dangerousDecision.action, 'confirm');
  assert.equal(dangerousDecision.hazardous, true);
  const blocked = await pi.handlers.tool_call(dangerous, { ui: {} });
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].title.startsWith('Dangerous bash ['), true);
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, undefined);
  assert.equal(pi.handlers.tool_call.length, 2);
  const ctx = { ui: {} };
  await pi.handlers.tool_call(dangerous, ctx);
  assert.equal(ctx.ui.confirm, confirm);
  assert.equal(ctx.hasUI, true);
  assert.equal(dsh.getRuntime(), null);
}

async function loadLocked() {
  const root = seam.resolveStepCheckout();
  const real = await seam.loadLockedStepExtension(root);
  const entry = path.join(root, 'packages', 'coding-agent', 'dist', 'index.js');
  const locked = await nativeImport(pathToFileURL(entry).href);
  assert.equal(typeof locked.decideStepToolCall, 'function');
  assert.equal(typeof locked.resolveInitialStepPermissionState, 'function');
  return { real, locked };
}

async function electronToolCall() {
  const { real, locked } = await loadLocked();
  for (const preset of ['bypass', 'autopilot']) {
    await assertToolCallMatches(preset, real, locked);
  }
  const node = process.versions.node;
  const electron = process.versions.electron;
  if (electron !== '36.9.5' || node !== '22.19.0') {
    throw new Error(`Electron 运行时不符: node ${node} electron ${electron}`);
  }
  console.log(`T4_ELECTRON_OK ${node} ${electron}`);
}

async function main() {
  let failed = 0;
  async function check(name, fn) {
    try {
      await fn();
      console.log('ok', name);
    } catch (err) {
      failed += 1;
      console.error('FAIL', name);
      console.error(err);
    }
  }

  await check('界面只有两档', () => {
    const modes = seam.listGuiPermissionModes();
    assert.deepStrictEqual(modes.map((mode) => mode.id), ['bypass', 'autopilot']);
    assert.deepStrictEqual(modes.map((mode) => mode.label), ['默认模式', '完全信任']);
    const app = fs.readFileSync(path.join(__dirname, 'renderer', 'app.js'), 'utf8');
    const stub = fs.readFileSync(path.join(__dirname, 'renderer', 'bridge-stub.js'), 'utf8');
    const settings = fs.readFileSync(path.join(__dirname, 'renderer', 'actions', 'settings.js'), 'utf8');
    assert.match(app, /id: 'bypass', label: '默认模式'/);
    assert.match(app, /id: 'autopilot', label: '完全信任'/);
    assert.match(app, /authMode: ''/);
    assert.match(app, /GUI_PRESET_LABELS\[id\] \|\| '未接入'/);
    assert.match(app, /AUTH_MODE_DOT_COLORS = \{ bypass: 'var\(--ok\)', autopilot: 'var\(--warn\)' \};/);
    for (const mode of modes) {
      assert.equal(app.includes(`id: '${mode.id}', label: '${mode.label}'`), true, mode.id);
      assert.equal(app.includes(mode.blurb), true, mode.blurb);
      assert.equal(stub.includes(`id: '${mode.id}', label: '${mode.label}'`), true, mode.id);
      assert.equal(app.includes(`${mode.id}: '${mode.label}'`), true, mode.label);
    }
    // 兜底表与标签表必须逐字只有两键。多一档就会被抓出来，
    // 而不是等到运行期才看出界面冒出第三行。
    const table = (source, name) => {
      const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
      assert.ok(match, `${name} 不在文件里`);
      const ids = [...match[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
      assert.deepStrictEqual(ids, ['bypass', 'autopilot'], `${name} 的档位列表不符`);
    };
    table(app, 'FALLBACK_AUTH_MODES');
    table(stub, 'AUTH_MODES_STUB');
    for (const file of [app, stub, settings]) {
      for (const banned of BANNED_UI) {
        assert.equal(file.includes(banned), false, banned);
      }
    }
  });

  // BUG-045：BANNED_UI 只扫渲染层源码，看不见「主进程回传的机器标识被直接插进正文」这一形态。
  // 状态栏的沙箱档位就是这种形态——界面口径改由 ipc-sandbox 生产，这里钉两件事：
  // ① 每个机器标识都有中文口径（主进程加档位而渲染侧漏映射 → 判红，不是运行时才看见「未识别档位」）；
  // ② 渲染层不再插原始 mode。
  await check('沙箱档位的界面口径与机器标识白名单同源', async () => {
    const hs = fs.readFileSync(path.join(__dirname, 'host-services.ts'), 'utf-8');
    const sb = fs.readFileSync(path.join(__dirname, 'ipc-sandbox.ts'), 'utf-8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'renderer', 'app.js'), 'utf-8');
    const decl = hs.match(/const SANDBOX_MODES: SandboxMode\[\] = \[([\s\S]*?)\];/);
    assert.ok(decl, 'host-services.ts 里的 SANDBOX_MODES 不见了，本断言要同步');
    const modes = [...decl[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.ok(modes.length >= 1, 'SANDBOX_MODES 解析为空');
    for (const m of modes) {
      assert.ok(sb.includes(`'${m}':`), `ipc-sandbox 缺档位 ${m} 的中文口径`);
    }
    assert.equal(/Windows ACL · \$\{esc\(state\.sandbox\.mode\)}/.test(appSrc), false,
      '状态栏仍在把机器标识直接插进正文');
    assert.ok(appSrc.includes('state.sandbox.modeLabel'), '状态栏没走主进程给的界面口径');
  });

  await check('IPC 不透传已卸下的三档', async () => {
    const { real } = await loadLocked();
    const handlers = new Map();
    registerAuthzIpc({
      handle(name, fn) { handlers.set(name, fn); },
      on() {},
    }, {
      getAuthz: () => ({
        getMode: async () => 'paranoid',
        setMode: async () => { throw new Error('不应调用已卸下的授权服务'); },
        getModes: () => [{ id: 'paranoid', label: '偏执模式', blurb: '第三档' }],
        getLevels: () => [],
        getAuditLog: () => [],
      }),
      sendToRenderer() {},
      listGuiModes: () => seam.listGuiPermissionModes(),
      getGuiPreset: () => seam.currentStepExtension()?.preset ?? null,
      setGuiPreset: (mode) => seam.selectGuiPreset({ preset: mode, confirm: async () => false, load: real }),
    });
    const listed = await handlers.get('orchdesk:authz-get-modes')();
    assert.deepStrictEqual(listed.modes.map((mode) => mode.id), ['bypass', 'autopilot']);
    assert.deepStrictEqual(listed.modes.map((mode) => mode.label), ['默认模式', '完全信任']);
    assert.equal(JSON.stringify(listed).includes('偏执'), false);
    assert.equal(JSON.stringify(listed).includes('bypassPermissions'), false);
    const before = await handlers.get('orchdesk:authz-get-mode')();
    assert.equal(before.unavailable, true);
    const selected = await handlers.get('orchdesk:authz-set-mode')({}, 'autopilot');
    assert.equal(selected.ok, true);
    assert.equal(selected.preset, 'autopilot');
    const after = await handlers.get('orchdesk:authz-get-mode')();
    assert.equal(after.mode, 'autopilot');
    const bare = new Map();
    registerAuthzIpc({
      handle(name, fn) { bare.set(name, fn); },
      on() {},
    }, {
      getAuthz: () => ({
        getMode: async () => 'paranoid',
        setMode: async () => ({ ok: true }),
        getModes: () => [{ id: 'paranoid', label: '偏执模式' }],
      }),
      sendToRenderer() {},
    });
    const bareModes = await bare.get('orchdesk:authz-get-modes')();
    assert.deepStrictEqual(bareModes.modes, []);
    assert.equal(JSON.stringify(bareModes).includes('偏执'), false);
    const bareSet = await bare.get('orchdesk:authz-set-mode')({}, 'paranoid');
    assert.equal(bareSet.ok, false);
    const illegal = await handlers.get('orchdesk:authz-set-mode')({}, 'ask');
    assert.equal(illegal.ok, false);
    assert.equal(seam.currentStepExtension().preset, 'autopilot');
  });

  await check('工具调用符合锁定点裁决，危险命令走本 GUI 确认', async () => {
    const { real, locked } = await loadLocked();
    for (const preset of ['bypass', 'autopilot']) {
      await assertToolCallMatches(preset, real, locked);
    }
    const states = dsh.getPluginStates();
    assert.equal(states.length, 9);
    assert.equal(states.every((state) => state.available === false && state.active === false), true);
    const blocked = await seam.selectGuiPreset({
      preset: seam.currentStepExtension().preset === 'bypass' ? 'autopilot' : 'bypass',
      confirm: async () => false,
      load: real,
    });
    assert.equal(blocked.ok, false);
  });

  await check('Electron 运行时复跑同一条工具调用', () => {
    const electron = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
    assert.equal(fs.existsSync(electron), true, '找不到 Electron 36.9.5');
    const result = spawnSync(electron, [__filename], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCHDESK_ELECTRON_T4: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
    assert.match(result.stdout, /T4_ELECTRON_OK 22\.19\.0 36\.9\.5/);
  });

  console.log(failed === 0 ? 'T4_OK' : `T4_FAIL ${failed}`);
  if (failed > 0) process.exit(1);
}

if (process.env.ORCHDESK_ELECTRON_T4 === '1') {
  electronToolCall().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main();
}
