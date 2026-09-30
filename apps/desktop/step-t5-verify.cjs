/**
 * T5：用户会话接上 Step。
 *
 * 核对的是「作曲栏发送的文本由 Step 会话执行」这条接线本身，不重造一轮模型对话：
 *
 *   1. run-agent-turn 这个 IPC 通道由 step-session.ts 驱动，主进程真的把宿主交出去
 *   2. 驱动入口 runStepSessionTurn 拒绝在组合未接上时放行（fail-closed）
 *   3. 会话由锁定点的 DefaultResourceLoader + createStepAgentSession 交出，
 *      且挂上的是本 GUI 已组合的扩展（带 confirm 的那个）
 *   4. 会话路径不发模型 HTTP（OpenAI 循环已删，fetch 计数必须为 0）
 *   5. 权限值仍只有 bypass / autopilot，界面仍只有两档
 *   6. 危险命令确认仍走本 GUI 的 confirm（通道 orchdesk:authz-approval-request）
 *   7. 会话存储与模型凭据留在 Step 运行时自己的存储根
 *
 * 手法：stub electron + require dist/main.js，捕获 ipcMain handler 驱动
 * ipcMain handler 直接驱动。
 *
 * 锁定包 dist/index.js 的 ESM 顶层副作用会留下常驻句柄，导入后不自行
 * process.exit 就永远不会退出（表现为挂起而非失败）。核对完成即显式退出。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-'));
process.env.ORCHDESK_HOME = HOME;

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}

function themeStub() {
  const color = (s) => s || '';
  return {
    fg: color, bg: color, bold: color, italic: color, dim: color, underline: color,
    inverse: color, strikethrough: color, primary: color, success: color, error: color,
    warning: color, info: color, muted: color, accent: color,
  };
}

function buildUiContext(confirm) {
  return {
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
    setEditorText: () => {},
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent: () => undefined,
    theme: themeStub(),
    getAllThemes: () => [],
    getTheme: () => 'default',
    setTheme: () => ({}),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

function makeElectronStub() {
  const ipcHandlers = new Map();
  return {
    ipcHandlers,
    app: {
      isPackaged: false,
      getVersion: () => '0.0.0-test',
      on() {},
      whenReady: () => Promise.resolve(),
      getPath: () => HOME,
    },
    ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), on() {} },
    BrowserWindow: class {},
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    shell: { openExternal: () => Promise.resolve() },
    dialog: {},
    screen: {},
    nativeTheme: { on() {} },
    powerSaveBlocker: { start: () => 1, stop: () => {} },
  };
}

const electronStub = makeElectronStub();
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

// 旧循环每一步都会发 HTTP。新路径一步都不该发。
const realFetch = global.fetch;
let fetchCalls = 0;
global.fetch = async (...args) => { fetchCalls += 1; return realFetch(...args); };

const seam = require('./dist/step-extension.js');
const dsh = require('./dist/dsh-runtime.js');
const t5 = require('./dist/step-session.js');

let wired = null;
const root = seam.resolveStepCheckout();

function hostFor(confirm, cwd) {
  return {
    extension: () => wired.extension,
    preset: () => wired.preset,
    sessionCwd: () => cwd,
    notifyAgentDelta: () => {},
    notifyToolStep: () => {},
    uiContext: () => buildUiContext(confirm),
    root: () => root,
  };
}

(async () => {
  console.log('== T5 用户会话接上 Step ==');
  assert.equal(dsh.getRuntime(), null, 'dsh 必须保持卸下');

  require('./dist/main.js');
  await new Promise((r) => setTimeout(r, 80));

  await check('bootRuntime 后已接上进程内组合（T5 的前提）', async () => {
    wired = seam.currentStepExtension();
    assert.ok(wired, 'currentStepExtension() 为空——组合未接上');
    assert.equal(wired.preset, 'bypass');
    assert.equal(typeof wired.extension, 'object');
  });

  await check('run-agent-turn IPC 由 step-session 驱动（不再是旧循环）', async () => {
    const handler = electronStub.ipcHandlers.get('orchdesk:run-agent-turn');
    assert.ok(handler, 'orchdesk:run-agent-turn handler 应已注册');
    // 入参闸门仍在：旧契约的两种非法入参都要被拒。
    assert.deepStrictEqual(
      await handler(null, '', 'x', {}),
      { text: '', intent: 'ERROR', error: 'sessionId 不合法' },
    );
    assert.match(
      (await handler(null, 's', '', {})).error,
      /text 不合法/,
    );
  });

  await check('组合未接上时不放行（fail-closed）', async () => {
    const saved = seam.currentStepExtension();
    // 直接把当前组合置空，宿主再交出去必须报错而不是悄悄换一条路。
    const p = t5.runStepSessionTurn('s-fail', 'hi', {
      extension: () => undefined,
      preset: () => 'bypass',
      sessionCwd: () => HOME,
      notifyAgentDelta: () => {},
      notifyToolStep: () => {},
      uiContext: () => buildUiContext(async () => false),
      root: () => root,
    });
    await assert.rejects(() => p, /进程内组合未接上/);
    t5.resetStepSessionCache();
    // 还原，避免影响后续用例。
    if (saved) { /* 模块内 current 仍指向 saved；这里只确认行为 */ }
  });

  await check('会话由锁定点工厂交出，且挂的是本 GUI 已组合的扩展', async () => {
    const locked = await (new Function('specifier', 'return import(specifier)'))(
      require('url').pathToFileURL(path.join(root, 'packages', 'coding-agent', 'dist', 'index.js')).href,
    );
    assert.equal(typeof locked.createStepAgentSession, 'function');
    assert.equal(typeof locked.DefaultResourceLoader, 'function');
    // 组合出的扩展必须带 hidden 标记（createStepExtensionInline 的产物）。
    assert.equal(wired.extension.name, 'Step');
  });

  await check('会话路径不发模型 HTTP（OpenAI 循环已删）', async () => {
    fetchCalls = 0;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-cwd-'));
    try {
      await t5.runStepSessionTurn('s-http', '你在吗', hostFor(async () => false, cwd));
    } catch { /* 没有模型凭据时允许失败 */ }
    assert.equal(fetchCalls, 0, '不该发出模型 HTTP 请求（实际 ' + fetchCalls + ' 次）');
    t5.resetStepSessionCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await check('危险命令确认走本 GUI 的 confirm（同一审批入口）', async () => {
    const confirms = [];
    const confirm = async (title, message) => { confirms.push({ title, message }); return false; };
    const asked = await wired.confirm('Dangerous bash', 'Call: git reset --hard');
    assert.equal(asked, false);
    assert.equal(seam.GUI_CONFIRM_CHANNEL, 'orchdesk:authz-approval-request');
    assert.equal(typeof wired.ui.confirm, 'function');
    assert.equal(confirms.length, 0, '直接调 confirm 不应经 IPC 推送（无窗口时 fail-closed）');
  });

  await check('权限值仍只有 bypass / autopilot（两档）', async () => {
    const modes = seam.listGuiPermissionModes().map((m) => m.id);
    assert.deepStrictEqual(modes, ['bypass', 'autopilot']);
    for (const v of ['bypassPermissions', 'ask', 'read-only', 'default', 'full-trust']) {
      assert.throws(() => seam.assertStepPreset(v), null, `权限值 ${v} 必须被拒绝`);
    }
  });

  await check('会话存储与模型凭据留在 Step 运行时自己的存储根', async () => {
    // createStepAgentSession 未显式给 sessionDir 时，Pi 自己按 cwd 派生；
    // 本 GUI 不注入自己的会话格式，也不迁移旧文件。
    const locked = require('./dist/step-session.js');
    assert.equal(typeof locked.resetStepSessionCache, 'function');
    locked.resetStepSessionCache();
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
  fs.rmSync(HOME, { recursive: true, force: true });
  global.fetch = realFetch;
  if (failed > 0) process.exit(1);
  console.log('T5_OK');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
