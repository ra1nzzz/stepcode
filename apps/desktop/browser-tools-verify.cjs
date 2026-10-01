/**
 * 浏览器工具验证（ADR-0011：Electron 自带 CDP，零额外依赖）
 * ----------------------------------------------------------------------------
 * 两部分，缺一不可（历史上「单测全绿但用户侧没生效」的教训）：
 *
 *   A. 纯逻辑（TS 直测，ADR-0010）：参数校验、超时钳制、**页面内表达式构造**、
 *      风险扫描、截图路径、状态描述。表达式是本模块唯一的注入面
 *      （模型给的选择器 / 文本要拼进 JS 源码），所以在假 DOM 里**真跑一遍**。
 *   B. 接线（stub electron 驱动真实 dist/main.js）：断言 CDP 命令真的发出去、
 *      截图真的落盘、写操作真的过授权门（无 GUI 应答方 → 不开门）。
 *
 * 运行：node browser-tools-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const APP_DIR = __dirname;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-browser-'));
process.env.ORCHDESK_HOME = HOME;

const { importTs } = require('./scripts/ts-load.cjs');
const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');

const { check, summary } = createChecker();

// ---------------------------------------------------------------------------
// 假 DOM：把生成的表达式真跑一遍（只断言「注入是否安全 + 语义是否正确」）
// ---------------------------------------------------------------------------

function makeFakeDom(opts = {}) {
  const calls = { querySelector: [], focus: 0, click: 0, events: [] };
  const el = {
    tagName: (opts.tag || 'INPUT').toUpperCase(),
    id: opts.id || 'q',
    innerText: opts.innerText || 'hello page',
    textContent: opts.textContent || opts.innerText || 'hello page',
    value: opts.value || '',
    isContentEditable: !!opts.contentEditable,
    focus() { calls.focus += 1; },
    click() { calls.click += 1; },
    scrollIntoView() {},
    dispatchEvent(e) { calls.events.push(e && e.type); return true; },
    querySelectorAll(sel) {
      return (opts.links || []).map((l) => ({
        href: l.href,
        innerText: l.text,
        textContent: l.text,
      }));
    },
  };
  const doc = {
    body: el,
    querySelector(sel) {
      calls.querySelector.push(sel);
      return opts.missing ? null : el;
    },
  };
  return { doc, el, calls };
}

/** 在假 DOM 中执行表达式（参数即表达式里可能引用到的全局）。 */
function runExpr(expr, dom, extra = {}) {
  const { doc, el } = dom;
  const proto = { value: el.value };
  const FakeInput = function () {};
  FakeInput.prototype = proto;
  const FakeEvent = function (type, init) { this.type = type; this.init = init; };
  const FakeKeyboard = function (type, init) { this.type = type; this.init = init; };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'KeyboardEvent',
    `return (${expr});`,
  );
  return fn(doc, FakeInput, FakeInput, FakeEvent, FakeKeyboard, extra);
}

// ---------------------------------------------------------------------------

(async () => {
  console.log('== A. 纯逻辑：参数校验与钳制 ==');

  const bt = await importTs('browser-tools.ts');
  const rt = await importTs('agent-runtime.ts');

  await check('URL 归一化：无协议自动补 https', () => {
    const r = bt.normalizeBrowserUrl('example.com/a?b=1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, 'https://example.com/a?b=1');
  });

  await check('URL 归一化：显式 http 不被强制升级（内网站点常用）', () => {
    const r = bt.normalizeBrowserUrl('http://127.0.0.1:8080/x');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, 'http://127.0.0.1:8080/x');
  });

  await check('URL 归一化：拒绝 file:// / javascript: / data:（否则沙箱直接被掀翻）', () => {
    for (const bad of ['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,<script>1</script>']) {
      const r = bt.normalizeBrowserUrl(bad);
      assert.strictEqual(r.ok, false, `${bad} 应被拒绝`);
      assert.ok(/仅允许 http\/https/.test(r.error), `错误文案应说明原因，实际：${r.error}`);
    }
  });

  await check('URL 归一化：空串与不可解析输入报错（不猜一个默认值继续跑）', () => {
    assert.strictEqual(bt.normalizeBrowserUrl('').ok, false);
    assert.strictEqual(bt.normalizeBrowserUrl('   ').ok, false);
    assert.strictEqual(bt.normalizeBrowserUrl('http://').ok, false, '缺主机名应拒绝');
  });

  await check('超时钳制：上下限生效，缺省/非法值回落默认（不得退化成下限）', () => {
    assert.strictEqual(bt.clampBrowserTimeout(999999, 'nav'), bt.BROWSER_NAV_TIMEOUT_MAX);
    assert.strictEqual(bt.clampBrowserTimeout(1, 'nav'), bt.BROWSER_NAV_TIMEOUT_MIN);
    assert.strictEqual(bt.clampBrowserTimeout('abc', 'nav'), bt.BROWSER_NAV_TIMEOUT_DEFAULT);
    // 「没传」必须等于「用默认值」：Number('') = 0 会被下限钳成 500ms，等于每次必超时
    assert.strictEqual(bt.clampBrowserTimeout(undefined, 'eval'), bt.BROWSER_EVAL_TIMEOUT_DEFAULT);
    assert.strictEqual(bt.clampBrowserTimeout(null, 'eval'), bt.BROWSER_EVAL_TIMEOUT_DEFAULT);
    assert.strictEqual(bt.clampBrowserTimeout('', 'action'), bt.BROWSER_ACTION_TIMEOUT_DEFAULT);
    assert.strictEqual(bt.clampBrowserTimeout(99999, 'action'), bt.BROWSER_ACTION_TIMEOUT_MAX);
    // 截图超时是「防卡死」的最后一道：默认 8s，缺省不得退化成下限 500ms
    assert.strictEqual(bt.clampBrowserTimeout(999999, 'shot'), bt.BROWSER_SHOT_TIMEOUT_MAX);
    assert.strictEqual(bt.clampBrowserTimeout(undefined, 'shot'), bt.BROWSER_SHOT_TIMEOUT_DEFAULT);
    assert.strictEqual(bt.clampBrowserTimeout('', 'shot'), bt.BROWSER_SHOT_TIMEOUT_DEFAULT);
    assert.strictEqual(bt.clampBrowserTimeout(300, 'shot'), bt.BROWSER_SHOT_TIMEOUT_MIN, '低于下限应钳到下限');
    assert.strictEqual(bt.clampBrowserTimeout(1500, 'shot'), 1500);
  });

  await check('参数归一化：browser_screenshot 带出截图超时（给回退兜底用）', () => {
    const r = bt.normalizeBrowserArgs('browser_screenshot', { fullPage: true });
    assert.strictEqual(r.value.fullPage, true);
    assert.strictEqual(r.value.timeoutMs, bt.BROWSER_SHOT_TIMEOUT_DEFAULT, '缺省应是默认超时，不是 undefined');
    const r2 = bt.normalizeBrowserArgs('browser_screenshot', { timeout: 1200 });
    assert.strictEqual(r2.value.timeoutMs, 1200);
  });

  await check('参数归一化：显式字符串 "false" 不被当 true（Boolean("false")===true 陷阱回归）', () => {
    // 模型文本兜底常把开关写成字符串 "false"；Boolean("false")===true 曾让
    // fullPage/clear/pressEnter 在用户显式关掉时仍被当成开。用 toBool 后必须为 false。
    const shot = bt.normalizeBrowserArgs('browser_screenshot', { fullPage: 'false' });
    assert.strictEqual(shot.value.fullPage, false, '字符串 "false" 应解析为 false');
    const shotT = bt.normalizeBrowserArgs('browser_screenshot', { fullPage: 'true' });
    assert.strictEqual(shotT.value.fullPage, true, '字符串 "true" 应解析为 true');
    const type = bt.normalizeBrowserArgs('browser_type', { selector: '#q', text: 'hi', clear: 'false', pressEnter: 'false' });
    assert.strictEqual(type.value.clear, false, 'clear 显式 "false" 不应清空');
    assert.strictEqual(type.value.pressEnter, false, 'pressEnter 显式 "false" 不应回车');
    const typeClearDefault = bt.normalizeBrowserArgs('browser_type', { selector: '#q', text: 'hi' });
    assert.strictEqual(typeClearDefault.value.clear, true, 'clear 缺省仍应清空（保持原语义）');
  });

  await check('参数归一化：browser_text 缺省参数回落默认字数（不是下限 200）', () => {
    const r = bt.normalizeBrowserArgs('browser_text', {});
    assert.strictEqual(r.value.maxChars, bt.BROWSER_TEXT_DEFAULT);
    assert.strictEqual(r.value.selector, '');
    const l = bt.normalizeBrowserArgs('browser_links', {});
    assert.strictEqual(l.value.limit, bt.BROWSER_LINKS_DEFAULT);
  });

  await check('参数归一化：browser_open 正常路径', () => {
    const r = bt.normalizeBrowserArgs('browser_open', { url: 'example.com', waitUntil: 'dom', timeout: 5000 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.url, 'https://example.com/');
    assert.strictEqual(r.value.waitUntil, 'dom');
    assert.strictEqual(r.value.timeoutMs, 5000);
  });

  await check('参数归一化：未知 waitUntil 回落 load（模型多写一个词不该整轮失败）', () => {
    const r = bt.normalizeBrowserArgs('browser_open', { url: 'https://a.com', waitUntil: 'networkidle' });
    assert.strictEqual(r.value.waitUntil, 'load');
  });

  await check('参数归一化：browser_click / browser_type 缺 selector 直接报错（猜错会静默点错按钮）', () => {
    assert.strictEqual(bt.normalizeBrowserArgs('browser_click', {}).ok, false);
    assert.strictEqual(bt.normalizeBrowserArgs('browser_type', { selector: '#q' }).ok, false, '缺 text 应报错');
    assert.strictEqual(bt.normalizeBrowserArgs('browser_eval', { expression: '   ' }).ok, false);
  });

  await check('参数归一化：selector 超长被截断、text 超长被截断（不把 10MB 塞进页面）', () => {
    const r = bt.normalizeBrowserArgs('browser_click', { selector: 'a'.repeat(2000) });
    assert.strictEqual(r.value.selector.length, bt.BROWSER_SELECTOR_MAX);
    const t = bt.normalizeBrowserArgs('browser_type', { selector: '#q', text: 'x'.repeat(50000) });
    assert.strictEqual(t.value.text.length, 10000);
  });

  // -------------------------------------------------------------------------
  console.log('== A2. 表达式构造（注入面：在假 DOM 里真跑） ==');

  await check('text 表达式：选择器带引号/反斜杠/换行也不会逃逸出字符串字面量', () => {
    const nasty = 'a[title="he said \\"hi\\"\\n"]';
    const expr = bt.buildTextExpression(nasty, 100);
    const dom = makeFakeDom({ innerText: 'ok' });
    const out = runExpr(expr, dom);
    assert.strictEqual(out, 'ok', `表达式语义应正确，实际：${out}`);
    assert.strictEqual(dom.calls.querySelector[0], nasty, '选择器必须原样传到 querySelector');
  });

  await check('text 表达式：空选择器取 document.body，元素缺失返回哨兵', () => {
    const dom = makeFakeDom({ innerText: 'body text' });
    assert.strictEqual(runExpr(bt.buildTextExpression('', 100), dom), 'body text');
    const missing = makeFakeDom({ missing: true });
    assert.strictEqual(runExpr(bt.buildTextExpression('#nope', 100), missing), bt.BROWSER_NO_ELEMENT);
  });

  await check('text 表达式：maxChars 真的进入 slice（页面很长时不刷爆上下文）', () => {
    const dom = makeFakeDom({ innerText: 'y'.repeat(1000) });
    const out = runExpr(bt.buildTextExpression('', 300), dom);
    assert.strictEqual(out.length, 300, '应按 maxChars 截断');
    // 下限 200：模型传 maxChars=10 只会得到一段没用的碎片，按 200 兜住
    const tiny = makeFakeDom({ innerText: 'y'.repeat(1000) });
    assert.strictEqual(runExpr(bt.buildTextExpression('', 5), tiny).length, 200);
  });

  await check('links 表达式：输出「文本 -> href」且条数受限', () => {
    const dom = makeFakeDom({ links: [{ text: '一', href: 'https://a/1' }, { text: '二', href: 'https://a/2' }] });
    const out = runExpr(bt.buildLinksExpression('', 1), dom);
    assert.strictEqual(out, '一 -> https://a/1', `实际：${out}`);
    const none = makeFakeDom({ links: [] });
    assert.ok(/没有链接/.test(runExpr(bt.buildLinksExpression('', 5), none)));
  });

  await check('click 表达式：点击命中元素并回报标签', () => {
    const dom = makeFakeDom({ tag: 'button', id: 'go' });
    const out = runExpr(bt.buildClickExpression('#go'), dom);
    assert.strictEqual(dom.calls.click, 1, '应触发 click');
    assert.strictEqual(out, 'clicked button#go', `实际：${out}`);
    const missing = makeFakeDom({ missing: true });
    assert.strictEqual(runExpr(bt.buildClickExpression('#nope'), missing), bt.BROWSER_NO_ELEMENT);
  });

  await check('type 表达式：文本原样写入（含引号/换行/反斜杠）+ 触发 input 事件', () => {
    const text = 'he said "hi"\\\n\tend';
    const dom = makeFakeDom({ tag: 'input', value: 'old' });
    const out = runExpr(bt.buildTypeExpression('#q', text, { clear: true, pressEnter: false }), dom);
    assert.ok(/typed \d+ chars into input/.test(out), `实际：${out}`);
    assert.ok(dom.calls.events.includes('input'), '必须派发 input 事件，否则 React 受控组件收不到值');
    assert.strictEqual(dom.calls.focus, 1, '应先聚焦');
    // 值经原型 setter 写入（受控组件兼容路径），落在假元素上即 dom.el.value
    assert.strictEqual(dom.el.value, text, '写入的文本必须原样（不做转义替换）');
  });

  await check('type 表达式：pressEnter 会补一次 keydown，非输入元素返回哨兵', () => {
    const dom = makeFakeDom({ tag: 'input' });
    runExpr(bt.buildTypeExpression('#q', 'hi', { pressEnter: true }), dom);
    assert.ok(dom.calls.events.includes('keydown'), 'pressEnter 应派发 keydown');
    const div = makeFakeDom({ tag: 'div' });
    assert.ok(String(runExpr(bt.buildTypeExpression('#d', 'hi'), div)).includes('not-input'));
  });

  await check('waitForSelector 表达式：含轮询与超时，命中即返回 found', async () => {
    const expr = bt.buildWaitForSelectorExpression('#x', 1000);
    assert.ok(expr.includes('1000'), '超时应注入');
    assert.ok(expr.includes('setTimeout'), '应轮询而不是死等');
    const dom = makeFakeDom();
    const out = await runExpr(expr, dom);
    assert.strictEqual(out, 'found');
  });

  // -------------------------------------------------------------------------
  console.log('== A3. 风险扫描 / 截图 / 状态 ==');

  await check('风险扫描：字符串字面量与注释里的 fetch 不误报（噪声会让人忽略真警报）', () => {
    assert.deepStrictEqual(bt.scanScriptRisks('const s = "fetch(1)"; // XMLHttpRequest'), []);
  });

  await check('风险扫描：真实外发 / Cookie / 本地存储 / 跳转命中并去重', () => {
    assert.deepStrictEqual(bt.scanScriptRisks("fetch('/api')"), ['外发请求']);
    assert.ok(bt.scanScriptRisks('document.cookie').includes('读取 Cookie'));
    assert.ok(bt.scanScriptRisks('localStorage.setItem("a",1)').includes('本地存储'));
    assert.ok(bt.scanScriptRisks('location.href = "https://x"').includes('页面跳转'));
    const many = bt.scanScriptRisks("fetch(a); fetch(b); document.cookie");
    assert.strictEqual(many.length, 2, '同类风险只记一次，实际：' + JSON.stringify(many));
  });

  await check('截图路径：按天分目录 + 扩展名消毒 + 序号可区分', () => {
    const ts = new Date('2026-09-01T13:05:09').getTime();
    const p1 = bt.browserShotRelativePath(ts, 1, 'png');
    const p2 = bt.browserShotRelativePath(ts, 2, 'png');
    assert.strictEqual(p1, 'browser-shots/2026-09-01/shot-130509-1.png');
    assert.notStrictEqual(p1, p2);
    assert.ok(bt.browserShotRelativePath(ts, 3, '../../etc/passwd').startsWith('browser-shots/'), '扩展名必须消毒');
  });

  await check('文本裁剪：超长标注总长度，空页面给明确占位', () => {
    const long = 'z'.repeat(500);
    const out = bt.clipBrowserText(long, 100);
    assert.ok(out.includes('已截断') && out.includes('500'), out);
    assert.strictEqual(bt.clipBrowserText('   ', 100), '(页面无可见文本)');
  });

  await check('状态描述：未打开时不显示地址/标题（不冒充「空白页」）', () => {
    const s = bt.describeBrowserState({ open: false });
    assert.ok(s.includes('未打开'), s);
    assert.ok(!s.includes('地址'), '未打开就不该有地址行，实际：' + s);
  });

  await check('状态描述：打开时给出标题/地址/窗口可见性', () => {
    const s = bt.describeBrowserState({ open: true, url: 'https://a.com', title: 'A', visible: false });
    assert.ok(s.includes('https://a.com') && s.includes('A') && s.includes('后台隐藏'), s);
  });

  // -------------------------------------------------------------------------
  console.log('== A4. 工具表合并（模型侧只有一张清单） ==');

  await check('8 个浏览器工具并入 TOOL_DEFS，提示词全部覆盖', () => {
    assert.strictEqual(bt.BROWSER_TOOL_DEFS.length, 8);
    for (const t of bt.BROWSER_TOOL_DEFS) {
      assert.ok(rt.TOOL_NAMES.includes(t.function.name), `TOOL_DEFS 缺少 ${t.function.name}`);
    }
    const p = rt.buildSystemPrompt();
    for (const n of bt.BROWSER_TOOL_NAMES) assert.ok(p.includes(n), `提示词缺少 ${n}`);
    assert.ok(p.includes('browser_open'), '提示词应给出浏览器工具使用顺序');
  });

  await check('写操作集合 = click / type / eval（这三个会真实改变页面）', () => {
    assert.deepStrictEqual(bt.BROWSER_WRITE_TOOLS, ['browser_click', 'browser_type', 'browser_eval']);
    for (const n of bt.BROWSER_WRITE_TOOLS) assert.ok(bt.BROWSER_TOOL_NAMES.includes(n));
  });

  await check('裸字符串参数兜底到主参数（browser_open 直接跟网址）', () => {
    assert.deepStrictEqual(rt.parseToolArgs('browser_open', 'example.com'), { url: 'example.com' });
    assert.deepStrictEqual(rt.parseToolArgs('browser_click', '#submit'), { selector: '#submit' });
  });

  // -------------------------------------------------------------------------
  // B. 接线：stub electron 驱动真实主进程
  // -------------------------------------------------------------------------
  console.log('== B. 接线：stub electron 驱动 dist/main.js ==');

  const electronStub = makeElectronStub({ home: HOME });
  const ipcHandlers = electronStub.ipcHandlers;
  const ready = new Promise((r) => { electronStub.app.whenReady = () => { setImmediate(r); return Promise.resolve(); }; });

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electronStub;
    return origLoad.apply(this, arguments);
  };
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) });

  require('./dist/main.js');
  await ready;
  // 等 bootRuntime 完成（授权服务就绪后写操作的拒绝原因才准确）
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (ipcHandlers.has('orchdesk:plugin-runtime')) {
      const st = await ipcHandlers.get('orchdesk:plugin-runtime')(null);
      if (st && st.ready === false) break;
    }
  }
  // 域名白名单放开：本套件测的是浏览器链路，不是网络策略。
  await ipcHandlers.get('orchdesk:sandbox-set-network-allow')(null, ['*']);

  const runTool = async (name, args) => ipcHandlers.get('orchdesk:tool-execute')(null, { name, arguments: args });
  const browserStatus = async () => ipcHandlers.get('orchdesk:browser-status')(null);

  await check('未打开时 browser-status 如实返回 open:false（不带假 url / 假标题）', async () => {
    const st = await browserStatus();
    assert.strictEqual(st.open, false, '未打开必须是 false，实际 ' + JSON.stringify(st));
    assert.ok(!st.url, '未打开不应有 url，实际 ' + st.url);
    assert.ok(st.shotsDir.includes('browser-shots'), '应给出截图目录，实际 ' + st.shotsDir);
  });

  await check('未打开时 browser_text 报错而不是自动开空白页（fail-closed）', async () => {
    const r = await runTool('browser_text', {});
    assert.ok(r.error && r.error.includes('浏览器未打开'), '实际：' + JSON.stringify(r));
  });

  await check('browser_open：真的向 CDP 发 Page.navigate，状态随之变为已打开', async () => {
    const denied = await runTool('browser_open', { url: 'https://example.com/hello' });
    assert.ok(denied.error && denied.error.includes('沙箱服务已停止'), '工具路径必须拒绝：' + JSON.stringify(denied));
    const cdp = require('./dist/browser-cdp.js');
    await cdp.openBrowser('https://example.com/hello', { waitUntil: 'load', timeoutMs: 5000 });
    const nav = electronStub.cdpCommands.filter((c) => c.method === 'Page.navigate');
    assert.strictEqual(nav.length, 1, '应恰好导航一次，实际 ' + JSON.stringify(electronStub.cdpCommands.map((c) => c.method)));
    assert.strictEqual(nav[0].params.url, 'https://example.com/hello');
    const st = await browserStatus();
    assert.strictEqual(st.open, true, '打开后状态应为 true');
    assert.strictEqual(st.url, 'https://example.com/hello');
  });

  await check('browser_open：非法协议在宿主之前就被拦下（javascript: 不会进 CDP）', async () => {
    const r = await runTool('browser_open', { url: 'javascript:alert(1)' });
    assert.ok(r.error && r.error.includes('http'), '实际：' + JSON.stringify(r));
    const navs = electronStub.cdpCommands.filter((c) => c.method === 'Page.navigate');
    assert.strictEqual(navs.length, 1, '不应新增导航命令');
  });

  await check('browser_text：走 Runtime.evaluate 并把页面文本回传模型', async () => {
    const win = electronStub.windows[electronStub.windows.length - 1];
    win.webContents.debugger.evaluateResult = { result: { type: 'string', value: '页面正文 123' } };
    const r = await runTool('browser_text', {});
    assert.ok(!r.error, '实际：' + r.error);
    assert.strictEqual(r.result, '页面正文 123');
    const evals = electronStub.cdpCommands.filter((c) => c.method === 'Runtime.evaluate');
    assert.ok(evals.length >= 1, '应发出 Runtime.evaluate');
    assert.ok(String(evals[evals.length - 1].params.expression).includes('innerText'), '应是读文本的表达式');
  });

  await check('browser_text：选择器进入表达式（且被 JSON 转义）', async () => {
    const win = electronStub.windows[electronStub.windows.length - 1];
    win.webContents.debugger.evaluateResult = { result: { type: 'string', value: '区域文本' } };
    await runTool('browser_text', { selector: 'div[title="a"]' });
    const last = electronStub.cdpCommands.filter((c) => c.method === 'Runtime.evaluate').pop();
    const expr = String(last.params.expression);
    assert.ok(expr.includes('div[title=\\"a\\"]') || expr.includes('div[title="a"]'), '选择器应进入表达式：' + expr);
  });

  await check('browser_screenshot：PNG 真的落到数据目录的 browser-shots 下', async () => {
    const r = await runTool('browser_screenshot', {});
    assert.ok(!r.error, '实际：' + r.error);
    const m = r.result.match(/截图已保存：(.*)$/);
    assert.ok(m, '结果应给出路径：' + r.result);
    assert.ok(fs.existsSync(m[1]), '截图文件应存在：' + m[1]);
    assert.ok(m[1].replace(/\\/g, '/').includes('browser-shots/'), '应落在 browser-shots 目录：' + m[1]);
    assert.ok(m[1].toLowerCase().endsWith('.png'));
    const shot = electronStub.cdpCommands.filter((c) => c.method === 'Page.captureScreenshot');
    assert.ok(shot.length >= 1, '应发出截图命令');
  });

  // 真机教训（2026-09-01）：合成器不产帧时 CDP 的 Page.captureScreenshot 会**永久挂起**
  // 而不是报错——远程桌面 / 锁屏 / 无 GPU 会话下必挂，整个回合卡死。
  // 因此必须有超时 + capturePage 回退，且这两件事都要有回归断言（不能只写在注释里）。
  await check('browser_screenshot：CDP 截图挂起时超时回退 capturePage，仍然出图', async () => {
    const win = electronStub.windows[electronStub.windows.length - 1];
    win.webContents.debugger.screenshotMode = 'hang';
    const before = electronStub.capturePageCalls.length;
    const r = await runTool('browser_screenshot', { timeout: 500 });
    const m = r.result && r.result.match(/截图已保存：(.*?)（视口截图/);
    assert.ok(!r.error, '挂起也应回退出图，实际：' + JSON.stringify(r));
    assert.ok(m, '结果应给出路径并说明是回退：' + r.result);
    assert.ok(fs.existsSync(m[1]), '回退截图应落盘：' + m[1]);
    assert.strictEqual(electronStub.capturePageCalls.length, before + 1, '应真的调用 capturePage 回退');
    assert.ok(r.result.includes('视口截图'), '回退必须如实告知只截到视口：' + r.result);
  });

  await check('browser_screenshot：CDP 报错时同样走回退，而不是把错误抛给模型', async () => {
    const win = electronStub.windows[electronStub.windows.length - 1];
    win.webContents.debugger.screenshotMode = 'reject';
    const r = await runTool('browser_screenshot', { timeout: 500 });
    assert.ok(!r.error, 'CDP 失败应回退，实际：' + JSON.stringify(r));
    assert.ok(/截图已保存：/.test(r.result), '应仍给出路径：' + r.result);
    win.webContents.debugger.screenshotMode = 'ok';
  });

  await check('browser_screenshot：两条路都不通时如实报错（不假装成功）', async () => {
    const win = electronStub.windows[electronStub.windows.length - 1];
    win.webContents.debugger.screenshotMode = 'hang';
    const origCapture = win.webContents.capturePage;
    win.webContents.capturePage = async () => { throw new Error('capturePage 也失败'); };
    try {
      const r = await runTool('browser_screenshot', { timeout: 500 });
      assert.ok(r.error, '应如实报错，实际：' + JSON.stringify(r));
    } finally {
      win.webContents.capturePage = origCapture;
      win.webContents.debugger.screenshotMode = 'ok';
    }
  });

  await check('browser_click：无 GUI 应答方时不开门（fail-closed），且沙箱日志记 denied', async () => {
    const r = await runTool('browser_click', { selector: '#buy' });
    assert.ok(r.error, '被拒绝时应返回 error，实际：' + JSON.stringify(r));
    assert.ok(/未获批准|不可用|拒绝/.test(r.error), '拒绝原因应可读，实际：' + r.error);
    const log = await ipcHandlers.get('orchdesk:sandbox-log')(null, { kind: 'browser', decision: 'denied' });
    assert.ok(log.entries.some((e) => e.tool === 'browser_click'), '沙箱日志应记录被拒的点击：' + JSON.stringify(log.entries));
  });

  await check('browser_eval：无 GUI 应答方时不开门，且不把表达式下发到页面', async () => {
    const before = electronStub.cdpCommands.filter((c) => c.method === 'Runtime.evaluate').length;
    const r = await runTool('browser_eval', { expression: "fetch('https://evil')" });
    assert.ok(r.error, '应被拒绝，实际：' + JSON.stringify(r));
    const after = electronStub.cdpCommands.filter((c) => c.method === 'Runtime.evaluate').length;
    assert.strictEqual(after, before, '被拒绝的脚本绝不能下发执行');
  });

  await check('沙箱日志：放行的导航与读取也留痕（kind=browser 可检索）', async () => {
    const all = await ipcHandlers.get('orchdesk:sandbox-log')(null, { kind: 'browser' });
    const tools = all.entries.map((e) => e.tool);
    for (const t of ['browser_open', 'browser_text', 'browser_screenshot']) {
      assert.ok(tools.includes(t), `应记录 ${t}，实际：${JSON.stringify(tools)}`);
    }
  });

  await check('browser_close：detach + 窗口关闭，状态回到 open:false', async () => {
    const r = await runTool('browser_close', {});
    assert.ok(!r.error, r.error);
    const st = await browserStatus();
    assert.strictEqual(st.open, false, '关闭后应为 false');
    assert.strictEqual(st.lastShot, null, '关闭后不应保留上一张截图');
  });

  await check('IPC：显示/隐藏窗口真的作用到 BrowserWindow（面板按钮不是空壳）', async () => {
    const deniedVis = await runTool('browser_open', { url: 'https://example.com/vis' });
    assert.ok(deniedVis.error && deniedVis.error.includes('沙箱服务已停止'), JSON.stringify(deniedVis));
    await require('./dist/browser-cdp.js').openBrowser('https://example.com/vis', { waitUntil: 'load', timeoutMs: 5000 });
    const shown = await ipcHandlers.get('orchdesk:browser-toggle-visible')(null, true);
    assert.strictEqual(shown.ok, true);
    assert.strictEqual(shown.state.visible, true, '显示后 visible 应为 true');
    const hidden = await ipcHandlers.get('orchdesk:browser-toggle-visible')(null, false);
    assert.strictEqual(hidden.state.visible, false);
    await ipcHandlers.get('orchdesk:browser-close')(null);
    assert.strictEqual((await browserStatus()).open, false);
  });

  await check('跳转拦截：will-redirect / will-navigate 命中内网目标即 preventDefault，公网放行', async () => {
    // ipc-browser.ts 只挡初始 URL；302 到 169.254.169.254 会绕过一切，正文还能经
    // browser_text / 截图取回。browser-cdp 现在给窗口挂了两道复检。
    const cdp = require('./dist/browser-cdp.js');
    await cdp.openBrowser('https://example.com/gate', { waitUntil: 'load', timeoutMs: 5000 }).catch(() => {});
    const win = electronStub.windows.find((w) => w.opts && w.opts.title === 'OrchDesk 浏览器');
    assert.ok(win, '浏览器窗未创建，拿不到 webContents 订阅');
    for (const ev of ['will-redirect', 'will-navigate']) {
      const handlers = win.wcHandlers[ev] || [];
      assert.ok(handlers.length >= 1, `${ev} 没有注册拦截器（守卫没挂上）`);
      let blocked = false;
      const evt = { preventDefault: () => { blocked = true; } };
      for (const fn of handlers) fn(evt, 'http://169.254.169.254/latest/meta-data/');
      assert.strictEqual(blocked, true, `${ev} 必须拦住元数据地址`);

      let allowed = false;
      const evt2 = { preventDefault: () => { allowed = true; } };
      for (const fn of handlers) fn(evt2, 'https://api.github.com/zen');
      assert.strictEqual(allowed, false, `${ev} 不该拦公网地址（门不能宽到把功能关掉）`);

      let empty = false;
      const evt3 = { preventDefault: () => { empty = true; } };
      for (const fn of handlers) fn(evt3, '');
      assert.strictEqual(empty, true, `${ev} 对空/非法地址要 fail-closed（isBlockedHost 判 true）`);
    }
    const state = JSON.stringify(cdp.getBrowserState());
    assert.ok(/跳转被拦/.test(state), `拦截要留下可见记录，实际状态 ${state.slice(0, 200)}`);
  });

  const ok = summary('浏览器工具全部验证通过');
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 临时目录清理失败无碍 */ }
  process.exit(ok ? 0 : 1);
})();
