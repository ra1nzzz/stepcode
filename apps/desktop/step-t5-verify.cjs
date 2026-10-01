/**
 * T5：用户会话接上 Step。
 *
 * 核对的是「作曲栏发送的文本由 Step 会话执行」这条接线本身，并且要让回合
 * 真的打到模型层：用一个本地假提供端把用户消息发出去、把模型回复取回来。
 * 没有这一条，其余断言都可能在「没配模型提前返回」上变成空转。
 *
 *   1. run-agent-turn 这个 IPC 通道由 step-session.ts 驱动，主进程真的把宿主交出去
 *   2. 驱动入口 runStepSessionTurn 拒绝在组合未接上时放行（fail-closed）
 *   3. 真实回合：发出去的消息变成一次模型请求，回复落到旧契约形状
 *   4. 同一条 GUI 会话复用历史；换会话不带别人的历史
 *   5. 会话与凭据落在 Step 自己的存储根，OrchDesk 数据目录不落文件
 *   6. 会话按绑定的工作目录取，不会静默落到用户主目录
 *   7. 权限值仍只有 bypass / autopilot，界面仍只有两档
 *   8. 危险命令确认仍走本 GUI 的 confirm（通道 orchdesk:authz-approval-request）
 *
 * 手法：stub electron + require dist/main.js，捕获 ipcMain handler 驱动。
 * 假提供端起在 127.0.0.1 随机端口，模型目录与凭据写在临时 Step agent 根里，
 * 不碰用户真的 ~/.stepcode。
 *
 * 锁定包 dist/index.js 的 ESM 顶层副作用会留下常驻句柄，导入后不自行
 * process.exit 就永远不会退出（表现为挂起而非失败）。核对完成即显式退出。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

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
    // 原先是 `class {}`：真实 createWindow 要读 webContents.on / setWindowOpenHandler，
    // 空类让启动路径每次都以 TypeError 收尾，被 main.ts 的 unhandledRejection 处理器
    // 打成一行 ERROR 混进日志。产品里 webContents 一定存在，所以这是桩的缺陷，
    // 但它同时把「启动有没有逃逸的 rejection」这条信号吃掉了——补成最小可用面。
    BrowserWindow: class {
      constructor() {
        this.webContents = {
          on: () => {},
          once: () => {},
          setWindowOpenHandler: () => {},
          getTitle: () => '',
          getURL: () => 'file:///stub/index.html',
          isDestroyed: () => false,
          send: () => true,
        };
      }
      on() {}
      once() {}
      loadFile() { return Promise.resolve(); }
      loadURL() { return Promise.resolve(); }
      show() {}
      hide() {}
      focus() {}
      close() {}
      destroy() {}
      isDestroyed() { return false; }
      static getAllWindows() { return []; }
    },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    shell: { openExternal: () => Promise.resolve() },
    dialog: {},
    screen: {},
    nativeTheme: { on() {} },
    powerSaveBlocker: { start: () => 1, stop: () => {} },
  };
}

const electronStub = makeElectronStub();

/**
 * 启动路径逃逸出去的 rejection 一律收集，最后一条用例断言它为空。
 * main.ts 装了 unhandledRejection 处理器（只打日志不退出），所以这类缺陷过去
 * 只会变成一行没人看的 ERROR；本套件把它变成会红的判据。
 */
const bootRejections = [];
process.on('unhandledRejection', (reason) => {
  bootRejections.push(String((reason && reason.stack) || reason));
});

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

/** 供「重新绑定工作目录」用例写入可变 cwd。 */
const boundCwd = { value: HOME };

const REPLY = '行星计划已经排到 Q3';
/** 一份合法的 OpenAI 流：必须有 finish_reason，否则锁定包判「流提前结束」并重试。 */
const SSE_BODY = (() => {
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const chunk = (delta) => sse({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] });
  return [
    chunk({ role: 'assistant' }),
    chunk({ content: REPLY }),
    sse({
      id: 'c1', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    'data: [DONE]\n\n',
  ].join('');
})();

/**
 * 起一个本地假 OpenAI 端点，并把「GUI 模型页的配置」交给会话。
 *
 * 关键区别：本函数不再直接写 Step 格式的 auth.json / models.json——那样等于把
 * 投影逻辑抽掉，套件会绿而生产桥接坏了也看不出来。这里只给 GUI 侧形状的配置
 * （带明文 key），落盘由 step-session → step-model-bridge 自己完成，套件再去验
 * 落到了哪、写成什么形状。
 *
 * 存储根与 agent 根都指向临时目录，不碰用户真的 ~/.stepcode。
 */
async function startFakeProvider() {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-storage-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-stepagent-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-turncwd-'));
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, body, auth: req.headers.authorization || '' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(SSE_BODY);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 哨兵：用户在 step CLI 里配的凭据。桥接不得动它。
  const cliAuthPath = path.join(agentDir, 'auth.json');
  const CLI_SENTINEL = JSON.stringify({ 'cli-only-provider': { type: 'api_key', key: 'cli-sentinel' } });
  fs.writeFileSync(cliAuthPath, CLI_SENTINEL);

  const prev = {
    agentDir: process.env.STEP_CODING_AGENT_DIR,
    storage: process.env.STEPCODE_STORAGE_ROOT_DIR,
  };
  // 重定向 Step 的两个根：不重定向就会写进用户真实的 ~/.stepcode/gui。
  process.env.STEP_CODING_AGENT_DIR = agentDir;
  process.env.STEPCODE_STORAGE_ROOT_DIR = storageRoot;

  const rt = {
    agentDir,
    storageRoot,
    cwd,
    hits,
    cliAuthPath,
    cliSentinel: CLI_SENTINEL,
    /** GUI 侧形状（renderer 的 saveModelConfig 入参 + 已解密的 key）。 */
    modelConfig: {
      providers: [{
        id: 'localmock', name: '本地 Mock', type: 'openai-compatible', apiMode: 'chat',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'probe-key', models: ['probe-model'],
      }],
      defaultProvider: 'localmock',
      defaultModel: 'probe-model',
    },
    guiDir: () => path.join(storageRoot, 'gui'),
    close() {
      if (activeProvider === rt) activeProvider = null;
      server.close();
      if (prev.agentDir === undefined) delete process.env.STEP_CODING_AGENT_DIR;
      else process.env.STEP_CODING_AGENT_DIR = prev.agentDir;
      if (prev.storage === undefined) delete process.env.STEPCODE_STORAGE_ROOT_DIR;
      else process.env.STEPCODE_STORAGE_ROOT_DIR = prev.storage;
      fs.rmSync(storageRoot, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
  activeProvider = rt;
  return rt;
}

/** 当前用例的假端点；未起时给一份空配置（会话不碰模型）。 */
let activeProvider = null;

function hostFor(confirm, cwd, onDelta) {
  return {
    composed: () => wired,
    preset: () => wired.preset,
    sessionCwd: () => cwd,
    notifyAgentDelta: (_sid, text) => { if (onDelta) onDelta(text); },
    notifyToolStep: () => {},
    uiContext: () => buildUiContext(confirm),
    modelConfig: () => (activeProvider ? activeProvider.modelConfig : { providers: [] }),
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
    // 不碰模块内 current，只让这一调宿主交不出组合：必须报错而不是悄悄换一条路。
    const p = t5.runStepSessionTurn('s-fail', 'hi', {
      composed: () => undefined,
      preset: () => 'bypass',
      sessionCwd: () => HOME,
      notifyAgentDelta: () => {},
      notifyToolStep: () => {},
      uiContext: () => buildUiContext(async () => false),
      root: () => root,
    });
    await assert.rejects(() => p, /进程内组合未接上/);
    t5.resetStepSessionCache();
  });

  await check('真实回合：用户发送真的走通并返回模型回复', async () => {
    const rt = await startFakeProvider();
    try {
      const deltas = [];
      const res = await t5.runStepSessionTurn('s-turn', '帮我写个一句话介绍', hostFor(
        async () => false,
        rt.cwd,
        (text) => deltas.push(text),
      ));
      assert.equal(res.intent, 'ACT');
      assert.equal(res.text.trim(), REPLY,
        '最终回复应取会话里最后一条 assistant 消息');
      assert.ok(deltas.length >= 1, '流式增量应经 agent-delta 转发');
      assert.equal(deltas.join('').trim(), REPLY,
        '转发出去的增量拼起来就是回复正文');
      assert.equal(rt.hits.length, 1, '只应发一次模型请求');
      assert.ok(rt.hits[0].url.startsWith('/v1/chat/completions'),
        '模型请求应由锁定包自己发起，不经旧 OpenAI 循环');
      // 证明这回合真的用了「GUI 设置页里那把 key」，而不是环境里碰巧别的凭据。
      assert.equal(rt.hits[0].auth, 'Bearer probe-key',
        '请求应带 GUI 模型页里配的 key，实际 ' + rt.hits[0].auth);
    } finally {
      rt.close();
    }
  });

  await check('GUI 模型配置经桥接落到 Step 存储根，且不动 CLI 自己的凭据', async () => {
    const rt = await startFakeProvider();
    try {
      await t5.runStepSessionTurn('s-bridge', '随便说点什么', hostFor(async () => false, rt.cwd));

      // 1) 投影产物必须真的存在于 Step 存储根下的 gui/ 子目录。
      const modelsPath = path.join(rt.guiDir(), 'models.json');
      const authPath = path.join(rt.guiDir(), 'auth.json');
      assert.ok(fs.existsSync(modelsPath), 'Step 存储根下应出现 gui/models.json');
      assert.ok(fs.existsSync(authPath), 'Step 存储根下应出现 gui/auth.json');

      // 2) 形状必须是 Step 认的那种（providers 是对象、凭据在 auth.json）。
      const models = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
      assert.equal(Array.isArray(models.providers), false, 'providers 必须是对象而非数组');
      assert.equal(models.providers.localmock.api, 'openai-completions');
      assert.deepStrictEqual(models.providers.localmock.models, [{ id: 'probe-model' }]);
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      assert.deepStrictEqual(auth.localmock, { type: 'api_key', key: 'probe-key' });
      assert.equal(JSON.stringify(models).includes('probe-key'), false,
        'models.json 不应出现明文 key');

      // 3) 用户在 step CLI 里配的凭据必须原封不动。
      assert.equal(fs.readFileSync(rt.cliAuthPath, 'utf-8'), rt.cliSentinel,
        '桥接不得改写 CLI 自己的 auth.json');

      // 4) 锁定包自己必须能从这份文件里取出模型。只断言「我们写了文件」不够：
      // schema 校验失败时 Step 静默丢掉整份配置，文件仍在，回合却报 No API key。
      const locked = await import(pathToFileURL(path.join(root, 'packages', 'coding-agent', 'dist', 'index.js')).href);
      const runtime = await locked.ModelRuntime.create({ authPath, modelsPath });
      const model = runtime.getModel('localmock', 'probe-model');
      assert.ok(model, 'Step 应从 gui/models.json 取出 probe-model；取不到说明 schema 被静默丢弃');
      assert.equal(model.api, 'openai-completions');
      assert.equal(runtime.hasConfiguredAuth('localmock'), true,
        'Step 应从 gui/auth.json 认出这把 key');
    } finally {
      rt.close();
    }
  });

  await check('改模型配置后下个回合用新提供商（不会闷用缓存的旧凭据）', async () => {
    const rt = await startFakeProvider();
    try {
      await t5.runStepSessionTurn('s-swap', '第一回合', hostFor(async () => false, rt.cwd));
      assert.equal(rt.hits.length, 1);

      // 用户在设置页换了 key：会话缓存必须失效，否则下一回合仍用旧凭据。
      rt.modelConfig.providers[0].apiKey = 'rotated-key';
      await t5.runStepSessionTurn('s-swap', '第二回合', hostFor(async () => false, rt.cwd));
      assert.equal(rt.hits.length, 2, '换配置后应再来一次请求');
      assert.equal(rt.hits[1].auth, 'Bearer rotated-key',
        '第二回合应用新 key，实际 ' + rt.hits[1].auth);
      const auth = JSON.parse(fs.readFileSync(path.join(rt.guiDir(), 'auth.json'), 'utf-8'));
      assert.equal(auth.localmock.key, 'rotated-key', 'gui/auth.json 应已跟上新 key');
    } finally {
      rt.close();
    }
  });

  await check('没配任何可用提供商时，回合给出可读失败而不是静默', async () => {
    const rt = await startFakeProvider();
    try {
      rt.modelConfig.providers = [];
      t5.resetStepSessionCache();
      await assert.rejects(
        () => t5.runStepSessionTurn('s-empty', '有人吗', hostFor(async () => false, rt.cwd)),
        /No API key found|No model selected|selected model/i,
      );
      assert.equal(rt.hits.length, 0, '没配提供商时不应发出模型请求');
    } finally {
      rt.close();
    }
  });

  await check('同一条 GUI 会话复用历史，换会话不带别人历史', async () => {
    const rt = await startFakeProvider();
    try {
      await t5.runStepSessionTurn('s-a', '第一轮问题', hostFor(async () => false, rt.cwd));
      const beforeSecond = rt.hits.length;
      await t5.runStepSessionTurn('s-a', '第二轮问题', hostFor(async () => false, rt.cwd));
      const secondBody = rt.hits[beforeSecond].body;
      assert.ok(secondBody.includes('第一轮问题'),
        '同会话第二轮应带上首轮历史（会话是按 sessionId 缓存的）');

      const beforeOther = rt.hits.length;
      t5.resetStepSessionCache();
      await t5.runStepSessionTurn('s-b', '另一条会话', hostFor(async () => false, rt.cwd));
      const otherBody = rt.hits[beforeOther].body;
      assert.equal(
        otherBody.includes('第一轮问题') || otherBody.includes('第二轮问题'),
        false,
        '换 sessionId 不得读到上一条会话的历史',
      );
    } finally {
      rt.close();
    }
  });

  await check('切走再切回：A→B→A 不丢 A 的上下文（缓存不是单槽）', async () => {
    // 旧实现只有一个缓存槽：建 B 时把 A dispose 掉，切回 A 只能重建，
    // A 的上下文就此消失，而界面上从没说过「切走会丢」。上一条用例只测了
    // A→A→reset→B，看不见这个方向，所以缺陷在 12 项全绿的情况下活着。
    const rt = await startFakeProvider();
    try {
      await t5.runStepSessionTurn('s-keep-a', '甲会话的首轮', hostFor(async () => false, rt.cwd));
      await t5.runStepSessionTurn('s-keep-b', '乙会话的首轮', hostFor(async () => false, rt.cwd));

      const before = rt.hits.length;
      await t5.runStepSessionTurn('s-keep-a', '甲会话的第二轮', hostFor(async () => false, rt.cwd));
      const body = rt.hits[before].body;
      assert.ok(body.includes('甲会话的首轮'),
        '切回甲会话必须带着它自己的历史（不 reset，靠缓存按 sessionId 各自留着）');
      assert.equal(body.includes('乙会话的首轮'), false,
        '切回甲会话不得夹带乙会话的历史');
    } finally {
      rt.close();
    }
  });

  await check('会话与凭据落在 Step 自己的存储根（ADR 0005 第 5 条）', async () => {
    const rt = await startFakeProvider();
    try {
      await t5.runStepSessionTurn('s-store', '写点什么', hostFor(async () => false, rt.cwd));
      // 会话文件必须出现在 Step 的 agentDir 下，而不是 OrchDesk 的数据目录。
      const stepSessions = path.join(rt.agentDir, 'sessions');
      assert.ok(fs.existsSync(stepSessions), 'Step 会话目录应存在');
      const files = fs.readdirSync(stepSessions);
      assert.ok(files.length > 0, '回合应在 Step 会话目录下留下会话文件');
      const guiLeak = fs.readdirSync(HOME);
      assert.deepStrictEqual(guiLeak, ['logs'],
        'OrchDesk 数据目录不得出现本 GUI 自己的会话/凭据文件');
    } finally {
      rt.close();
    }
  });

  await check('会话按绑定工作目录取，不会静默落到用户主目录', async () => {
    const rt = await startFakeProvider();
    const asPosix = (p) => p.split(path.sep).join('/');
    try {
      const boundCwds = [];
      const host = hostFor(async () => false, rt.cwd);
      // 模拟渲染层给这条会话绑定的项目目录（set-session-cwd → setSessionCwd）。
      const bound = Object.create(host, {
        sessionCwd: { value: () => boundCwd.value },
      });
      boundCwd.value = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-cwd1-'));
      boundCwds.push(boundCwd.value);
      await t5.runStepSessionTurn('s-cwd', '第一条', bound);
      const firstBody = rt.hits[rt.hits.length - 1].body;
      assert.ok(firstBody.includes(asPosix(boundCwd.value)),
        '系统提示应包含会话绑定的工作目录，而不是用户主目录');

      // 重新绑定到另一个目录：会话必须跟着换。
      t5.resetStepSessionCache();
      boundCwd.value = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-cwd2-'));
      await t5.runStepSessionTurn('s-cwd', '第二条', bound);
      const secondBody = rt.hits[rt.hits.length - 1].body;
      assert.ok(secondBody.includes(asPosix(boundCwd.value)),
        '重新绑定后应取新目录');
      assert.equal(secondBody.includes(asPosix(boundCwds[0])), false,
        '旧目录不应继续作为工作目录');
    } finally {
      rt.close();
    }
  });

  await check('权限值仍只有 bypass / autopilot（两档）', async () => {
    const modes = seam.listGuiPermissionModes().map((m) => m.id);
    assert.deepStrictEqual(modes, ['bypass', 'autopilot']);
    for (const v of ['bypassPermissions', 'ask', 'read-only', 'default', 'full-trust']) {
      assert.throws(() => seam.assertStepPreset(v), null, `权限值 ${v} 必须被拒绝`);
    }
  });

  await check('危险命令确认走本 GUI 的 confirm（同一审批入口）', async () => {
    const asked = await wired.confirm('Dangerous bash', 'Call: git reset --hard');
    assert.equal(asked, false);
    assert.equal(seam.GUI_CONFIRM_CHANNEL, 'orchdesk:authz-approval-request');
    assert.equal(typeof wired.ui.confirm, 'function');
    // 深度断言放在 step-session-verify.cjs：它直接驱动会话的 beforeToolCall。
  });

  await check('启动路径不逃逸 unhandledRejection（桩必须撑得住真实 createWindow）', async () => {
    // whenReady 是 Promise.resolve()，启动链在后续 tick 才走到 createWindow；
    // 让宏任务排空一次再判定，否则这条会假绿。
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(
      bootRejections.length,
      0,
      `启动过程逃逸 ${bootRejections.length} 条 rejection：\n${bootRejections.join('\n---\n')}`,
    );
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
