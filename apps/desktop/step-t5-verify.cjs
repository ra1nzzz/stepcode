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
 * 起一个本地假 OpenAI 端点，并把模型目录与凭据写进一个临时 Step agent 根。
 * 这样回合能真的打到模型层——而不是在「没配模型」时提前返回、让断言变成空转。
 * 凭据与模型目录都落在临时根里，不碰用户真的 ~/.stepcode。
 */
async function startFakeProvider() {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-stepagent-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-t5-turncwd-'));
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(SSE_BODY);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // 凭据与模型目录都写进临时根；用锁定包读的形状（agents 读 auth.json，models 读 models.json）。
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({
    localmock: { type: 'api_key', key: 'probe-key' },
  }));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      localmock: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        apiKey: 'probe-key',
        models: [{ id: 'probe-model', name: 'Probe Model', input: ['text'] }],
      },
    },
  }));
  // 告诉锁定包用这个临时根；测完还原，别影响同进程里别的套件。
  const prevAgentDir = process.env.STEP_CODING_AGENT_DIR;
  const prevAuth = process.env.STEPCODE_AUTH_PATH;
  process.env.STEP_CODING_AGENT_DIR = agentDir;
  process.env.STEPCODE_AUTH_PATH = path.join(agentDir, 'auth.json');
  return {
    agentDir,
    cwd,
    hits,
    close() {
      server.close();
      if (prevAgentDir === undefined) delete process.env.STEP_CODING_AGENT_DIR;
      else process.env.STEP_CODING_AGENT_DIR = prevAgentDir;
      if (prevAuth === undefined) delete process.env.STEPCODE_AUTH_PATH;
      else process.env.STEPCODE_AUTH_PATH = prevAuth;
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function hostFor(confirm, cwd, onDelta) {
  return {
    composed: () => wired,
    preset: () => wired.preset,
    sessionCwd: () => cwd,
    notifyAgentDelta: (_sid, text) => { if (onDelta) onDelta(text); },
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
