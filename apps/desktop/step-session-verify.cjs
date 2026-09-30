/**
 * 会话对象验证。不改作曲栏，不把会话工厂当成已接好的运行时。
 * 一条 Step 会话装上已组合的扩展后，tool_call 必须与锁定点 decideStepToolCall 一致。
 * 危险命令必须走到本 GUI 的 confirm。
 *
 * 锁定包 dist/index.js 的 ESM 顶层副作用会留下常驻句柄，导入后不自行
 * process.exit 就永远不会退出（表现为挂起而非失败）。核对完成即显式退出。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const seam = require('./dist/step-extension.js');
const dsh = require('./dist/dsh-runtime.js');
const nativeImport = new Function('specifier', 'return import(specifier)');

function assertNoBypassSwitch(options) {
  const encoded = JSON.stringify(options);
  assert.equal(encoded.includes('bypassPermissions'), false);
  assert.equal(Object.hasOwn(options, 'sandbox'), false);
  assert.equal(Object.hasOwn(options.permission, 'nonInteractiveApproval'), false);
  assert.equal(Object.hasOwn(options.permission, 'approvalMode'), false);
  assert.deepStrictEqual(options.permission.env, {});
}

/**
 * 界面上下文里的 theme 空壳。锁定包的界面上下文带一组 theme 访问器
 * （features/step-plan.ts 直接读 ctx.ui.theme.fg(...)），缺字段要到
 * 调用点才抛 TypeError，所以在这里补全。
 */
function themeStub() {
  const color = (s) => s || '';
  return {
    fg: color,
    bg: color,
    bold: color,
    italic: color,
    dim: color,
    underline: color,
    inverse: color,
    strikethrough: color,
    primary: color,
    success: color,
    error: color,
    warning: color,
    info: color,
    muted: color,
    accent: color,
  };
}

async function loadLocked() {
  const root = seam.resolveStepCheckout();
  const real = await seam.loadLockedStepExtension(root);
  const entry = path.join(root, 'packages', 'coding-agent', 'dist', 'index.js');
  const locked = await nativeImport(pathToFileURL(entry).href);
  assert.equal(typeof locked.decideStepToolCall, 'function');
  assert.equal(typeof locked.createStepAgentSession, 'function');
  assert.equal(typeof locked.DefaultResourceLoader, 'function');
  return { real, locked };
}

async function assertSessionToolCall(preset, real, locked) {
  assert.equal(dsh.getRuntime(), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-step-session-'));
  const cwd = path.join(root, 'cwd');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  fs.mkdirSync(sessionDir);
  const confirms = [];
  const seen = [];
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
  let session;
  try {
    const loader = new locked.DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [wired.extension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
    assert.equal(loaded.extensions.length > 0, true);
    const created = await locked.createStepAgentSession({
      cwd,
      agentDir,
      sessionDir,
      resourceLoader: loader,
      tools: ['read', 'bash'],
    });
    session = created.session;
    assert.equal(typeof session.agent.beforeToolCall, 'function');
    await session.bindExtensions({
      uiContext: {
        select: async () => undefined,
        confirm,
        input: async () => undefined,
        notify() {},
        onTerminalInput: () => () => {},
        setStatus() {},
        setWorkingMessage() {},
        setWorkingVisible() {},
        setWorkingIndicator() {},
        setHiddenThinkingLabel() {},
        setWidget() {},
        setFooter() {},
        setHeader() {},
        setTitle() {},
        custom: async () => undefined,
        pasteToEditor() {},
        setEditorText() {},
        getEditorText: () => '',
        editor: async () => undefined,
        addAutocompleteProvider() {},
        setEditorComponent() {},
        getEditorComponent: () => undefined,
        // theme 与 toolsExpanded：锁定包的界面上下文有这两组字段
        // （features/step-plan.ts 直接读 ctx.ui.theme.fg），缺了到调用点才抛错。
        theme: themeStub(),
        getAllThemes: () => [],
        getTheme: () => 'default',
        setTheme: () => ({}),
        getToolsExpanded: () => false,
        setToolsExpanded: () => {},
      },
    });
    assert.equal(seen[0].permission.initialPreset, preset);
    const state = locked.resolveInitialStepPermissionState({ initialPreset: preset, env: {} });
    assert.equal(state.preset, preset);
    assert.notEqual(state.defaulted, true);

    const ordinary = { name: 'read', id: 'ordinary-00000001' };
    const ordinaryArgs = { path: 'README.md' };
    const ordinaryDecision = locked.decideStepToolCall('read', ordinaryArgs, state);
    assert.equal(ordinaryDecision.action, 'allow');
    const ordinaryResult = await session.agent.beforeToolCall({
      toolCall: ordinary,
      args: ordinaryArgs,
    });
    assert.equal(ordinaryResult, undefined);
    assert.equal(confirms.length, 0);

    const dangerous = { name: 'bash', id: 'danger-00000001' };
    const dangerousArgs = { command: 'git reset --hard' };
    const dangerousDecision = locked.decideStepToolCall('bash', dangerousArgs, state);
    assert.equal(dangerousDecision.action, 'confirm');
    assert.equal(dangerousDecision.hazardous, true);
    const blocked = await session.agent.beforeToolCall({
      toolCall: dangerous,
      args: dangerousArgs,
    });
    assert.equal(confirms.length, 1);
    // BeforeToolCallResult 的阻断形是 { block: true, reason }，没有 terminate 键。
    // 用严格 undefined 断言，{ terminate: false } 之类也要算不符。
    assert.equal(blocked.block, true);
    assert.equal(blocked.terminate, undefined);
    assert.equal(JSON.stringify(seen[0]).includes('bypassPermissions'), false);
  } finally {
    if (session) session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function sessionToolCall() {
  const { real, locked } = await loadLocked();
  for (const preset of ['bypass', 'autopilot']) {
    await assertSessionToolCall(preset, real, locked);
  }
}

async function main() {
  await sessionToolCall();
  const electron = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
  assert.equal(fs.existsSync(electron), true, '找不到 Electron 36.9.5');
  const result = spawnSync(electron, [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCHDESK_ELECTRON_SESSION: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
  assert.match(result.stdout, /SESSION_ELECTRON_OK 22\.19\.0 36\.9\.5/);
  console.log('SESSION_OK');
  process.exit(0);
}

if (process.env.ORCHDESK_ELECTRON_SESSION === '1') {
  sessionToolCall()
    .then(() => {
      const node = process.versions.node;
      const electron = process.versions.electron;
      if (electron !== '36.9.5' || node !== '22.19.0') {
        throw new Error(`Electron 运行时不符: node ${node} electron ${electron}`);
      }
      console.log(`SESSION_ELECTRON_OK ${node} ${electron}`);
      // 锁定包留下常驻句柄。打印成功标记后立即退出，靠 exit code 判定，不靠自然退出。
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
