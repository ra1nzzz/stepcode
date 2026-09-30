/**
 * T3 接缝验证。
 * 非法权限值到不了 createStepExtensionInline。
 * confirm 是本 GUI 回调。没有确认界面时不得改写成允许。
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const seam = require('./dist/step-extension.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => {
          passed += 1;
          console.log('  PASS  ' + name);
        },
        (err) => {
          failed += 1;
          console.log('  FAIL  ' + name);
          console.log('        ' + (err && err.message ? err.message : err));
        },
      );
    }
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.message ? err.message : err));
  }
  return Promise.resolve();
}

function spyLoad() {
  const calls = [];
  return {
    calls,
    createStepExtensionInline(options) {
      calls.push(options);
      return {
        name: 'Step',
        hidden: true,
        factory(pi) {
          pi.on('tool_call', async (_event, ctx) => ctx.ui.confirm('标题', '说明'));
        },
      };
    },
  };
}

const illegal = ['ask', 'read-only', 'default', 'full-trust', 'bypassPermissions', 'auto', 'strict', '', null];

async function main() {
  await check('非法权限值不会进入 createStepExtensionInline', async () => {
    const load = spyLoad();
    for (const preset of illegal) {
      await assert.rejects(
        () => seam.connectStepExtension({ preset, confirm: async () => false, load }),
        /bypass 或 autopilot/,
      );
    }
    assert.equal(load.calls.length, 0);
  });

  await check('没有 confirm 时不调用函数，也不放行', async () => {
    const load = spyLoad();
    await assert.rejects(
      () => seam.connectStepExtension({ preset: 'bypass', confirm: null, load }),
      /不得放行/,
    );
    assert.throws(
      () => seam.composeStepExtension({ preset: 'autopilot', confirm: undefined, hasConfirmUi: false, load }),
      /不得放行/,
    );
    assert.equal(load.calls.length, 0);
  });

  await check('只把 bypass 或 autopilot 和空环境交给函数', async () => {
    const previous = process.env.STEP_NON_INTERACTIVE_APPROVAL;
    process.env.STEP_NON_INTERACTIVE_APPROVAL = 'allow';
    try {
      for (const preset of ['bypass', 'autopilot']) {
        const load = spyLoad();
        const confirm = async () => false;
        const wired = seam.composeStepExtension({ preset, confirm, load });
        assert.equal(load.calls.length, 1);
        assert.deepStrictEqual(load.calls[0], { permission: { initialPreset: preset, env: {} } });
        assert.equal(load.calls[0].permission.nonInteractiveApproval, undefined);
        assert.equal(load.calls[0].permission.approvalMode, undefined);
        assert.equal(wired.preset, preset);
        assert.equal(wired.ui.confirm, confirm);
        assert.equal(wired.confirm, confirm);
      }
    } finally {
      if (previous === undefined) delete process.env.STEP_NON_INTERACTIVE_APPROVAL;
      else process.env.STEP_NON_INTERACTIVE_APPROVAL = previous;
    }
  });

  await check('工具钩子使用本 GUI 的 confirm', async () => {
    const load = spyLoad();
    let seen = 0;
    const confirm = async () => {
      seen += 1;
      return false;
    };
    const wired = seam.composeStepExtension({ preset: 'bypass', confirm, load });
    const handlers = {};
    wired.extension.factory({
      on(event, handler) {
        handlers[event] = handler;
      },
    });
    const ctx = { hasUI: false, ui: {} };
    const approved = await handlers.tool_call({}, ctx);
    assert.equal(seen, 1);
    assert.equal(ctx.ui.confirm, confirm);
    assert.equal(ctx.hasUI, true);
    assert.equal(approved, false);
    const guarded = {};
    Object.defineProperty(guarded, 'hasUI', { get() { return true; } });
    Object.defineProperty(guarded, 'ui', { get() { return { confirm }; } });
    const again = await handlers.tool_call({}, guarded);
    assert.equal(again, false);
    assert.equal(seen, 2);
  });

  await check('没有确认窗口时 confirm 返回 false，且不发送放行', async () => {
    let sent = 0;
    const confirm = seam.createGuiStepConfirm({
      hasWindow: () => false,
      send: () => { sent += 1; },
      nextId: () => 'apr-1',
      wait: async () => 'allowed-once',
    });
    assert.equal(await confirm('危险命令', 'rm -rf', { overlay: true }), false);
    assert.equal(sent, 0);
  });

  await check('确认文案原样送到本 GUI，不截断后放行', async () => {
    const message = 'x'.repeat(4000);
    let sent = null;
    const confirm = seam.createGuiStepConfirm({
      hasWindow: () => true,
      send: (_channel, payload) => { sent = payload; },
      nextId: () => 'apr-3',
      wait: async () => 'rejected',
    });
    assert.equal(await confirm('Dangerous bash', message), false);
    assert.equal(sent.reason, message);
    assert.equal(sent.toolName, 'Dangerous bash');
  });

  await check('只有本 GUI 的 allowed-once 才是允许', async () => {
    const outcomes = ['allowed-once', 'rejected', 'cancelled', 'unavailable', 'allow'];
    for (const outcome of outcomes) {
      const confirm = seam.createGuiStepConfirm({
        hasWindow: () => true,
        send: () => {},
        nextId: () => 'apr-2',
        wait: async () => outcome,
      });
      assert.equal(await confirm('标题', '说明'), outcome === 'allowed-once');
    }
  });

  await check('Node 低于 22.19.0 时不导入锁定包', async () => {
    let imported = 0;
    await assert.rejects(
      () => seam.loadLockedStepExtension('D:\\unused', {
        nodeVersion: '22.18.0',
        readLock: () => ({ commit: seam.STEP_LOCK_COMMIT, tree: seam.STEP_LOCK_TREE }),
        entryExists: () => true,
        importModule: async () => { imported += 1; return { createStepExtensionInline() {} }; },
      }),
      /低于 22\.19\.0/,
    );
    assert.equal(imported, 0);
  });

  await check('锁定点不符时不导入', async () => {
    let imported = 0;
    await assert.rejects(
      () => seam.loadLockedStepExtension('D:\\unused', {
        nodeVersion: '22.19.0',
        readLock: () => ({ commit: '0'.repeat(40), tree: '1'.repeat(40) }),
        entryExists: () => true,
        importModule: async () => { imported += 1; return { createStepExtensionInline() {} }; },
      }),
      /锁定点不符/,
    );
    assert.equal(imported, 0);
  });

  await check('源码不把其它入口或放行开关当成接缝', () => {
    const src = fs.readFileSync(path.join(__dirname, 'step-extension.ts'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    for (const banned of ['createStepCode', 'createStepAgentSession', 'decideStepToolCall', 'sandbox.enabled', 'bypassPermissions', 'sdk-stdio', 'nonInteractiveApproval']) {
      assert.equal(src.includes(banned), false, 'step-extension.ts 含有 ' + banned);
    }
    assert.equal(main.includes('connectStepExtension'), true, '主进程没有调用接缝');
    assert.equal(main.includes('authzService = null'), true, '卸下标记被改掉');
  });

  await check('锁定包的 createStepExtensionInline 只收到两档', async () => {
    const root = seam.resolveStepCheckout();
    const real = await seam.loadLockedStepExtension(root);
    for (const preset of ['bypass', 'autopilot']) {
      const seen = [];
      const confirm = async () => false;
      const wired = seam.composeStepExtension({
        preset,
        confirm,
        load: {
          createStepExtensionInline(options) {
            seen.push(options);
            return real.createStepExtensionInline(options);
          },
        },
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].permission.initialPreset, preset);
      assert.deepStrictEqual(seen[0].permission.env, {});
      assert.equal(Object.hasOwn(seen[0].permission, 'nonInteractiveApproval'), false);
      assert.equal(Object.hasOwn(seen[0].permission, 'approvalMode'), false);
      assert.equal(wired.extension.name, 'Step');
      assert.equal(wired.extension.hidden, true);
      assert.equal(typeof wired.extension.factory, 'function');
      assert.equal(wired.ui.confirm, confirm);
    }
  });

  await check('Electron 主进程运行时能调用锁定函数', () => {
    const electron = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
    assert.equal(fs.existsSync(electron), true, '找不到 Electron 36.9.5');
    const result = spawnSync(electron, [__filename], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCHDESK_ELECTRON_SEAM: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
    assert.match(result.stdout, /ELECTRON_SEAM_OK 22\.19\.0 36\.9\.5/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

async function electronSeam() {
  assert.equal(process.versions.electron, '36.9.5');
  assert.equal(process.versions.node, '22.19.0');
  const root = seam.resolveStepCheckout();
  const real = await seam.loadLockedStepExtension(root);
  const seen = [];
  const confirm = async () => false;
  const wired = seam.composeStepExtension({
    preset: 'bypass',
    confirm,
    load: {
      createStepExtensionInline(options) {
        seen.push(options);
        return real.createStepExtensionInline(options);
      },
    },
  });
  assert.deepStrictEqual(seen[0], { permission: { initialPreset: 'bypass', env: {} } });
  assert.equal(wired.extension.name, 'Step');
  assert.equal(wired.ui.confirm, confirm);
  console.log('ELECTRON_SEAM_OK', process.versions.node, process.versions.electron);
}

if (process.env.ORCHDESK_ELECTRON_SEAM === '1') {
  electronSeam().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
