/**
 * 浏览器工具「真机冒烟」——必须在真实 Electron 桌面会话里跑，不属于 npm run verify。
 *
 * 为什么不进 verify 链：
 *   browser-tools-verify.cjs 用 stub electron 驱动真实 dist/main.js，能证明「命令发出去了、
 *   门没开时不下发、截图落盘路径对」，但证明不了真机上 debugger.attach / Page.navigate /
 *   Runtime.evaluate / Page.captureScreenshot 真能跑通。这一步只有真 Chromium 能回答，
 *   而真 Chromium 需要可用的 GPU/渲染进程 —— CI 与非交互会话里没有，硬塞进 verify
 *   只会得到一个环境噪音导致的假红。
 *
 * 跑法（在桌面会话的终端里，从 apps/desktop 目录）：
 *   pnpm run smoke:browser
 *   # 等价：./node_modules/.bin/electron scripts/browser-smoke.cjs
 *
 * 三个必踩的坑（前两个都写成了启动期的显式报错，别再浪费第三次）：
 *   1. ELECTRON_RUN_AS_NODE=1（从 Electron 宿主应用继承而来时很常见）会让 electron.exe
 *      退化成纯 Node，require('electron') 返回一个路径字符串，app 为 undefined。
 *   2. 脚本必须放在 apps/desktop 下，否则 require('electron') 解析不到 node_modules。
 *   3. 非交互桌面 / CI 会话里 Chromium 的 sandbox 与 GPU 进程起不来，表现为进程退出码
 *      127 且 stdout 全空 —— 极像代码 bug，其实是环境。本脚本会自动降级：关 sandbox +
 *      关硬件加速，代价是这一轮跑的不是产品的默认配置（会明确打印出来，不静默）。
 *
 * 退出码：0 全绿 / 1 有 FAIL / 2 环境不对（不是 Electron 主进程）/ 3 整体超时。
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

if (process.type !== 'browser') {
  console.error(
    '[browser-smoke] 当前不是 Electron 主进程（process.type=' + String(process.type) + '）。\n'
    + '多半是环境变量 ELECTRON_RUN_AS_NODE 把 electron.exe 变成了纯 Node。\n'
    + '请用：env -u ELECTRON_RUN_AS_NODE electron scripts/browser-smoke.cjs\n'
    + '或（PowerShell）：Remove-Item Env:ELECTRON_RUN_AS_NODE; pnpm run smoke:browser'
  );
  process.exit(2);
}

const { app, BrowserWindow } = require('electron');

// 受限会话降级（见头注释坑 3）：必须在 require browser-cdp 之前设，它在模块加载期读。
// 判定：显式环境变量优先；否则看有没有 explorer.exe —— 没有就是非交互桌面 / CI。
function detectCi() {
  const forced = process.env.ORCHDESK_SMOKE_CI;
  if (forced === '1') return { ci: true, why: 'ORCHDESK_SMOKE_CI=1' };
  if (forced === '0') return { ci: false, why: 'ORCHDESK_SMOKE_CI=0（强制桌面配置）' };
  if (process.platform !== 'win32') return { ci: false, why: '非 Windows，按桌面会话处理' };
  try {
    const out = require('node:child_process').execSync('tasklist /FI "IMAGENAME eq explorer.exe" /NH', { encoding: 'utf8', windowsHide: true });
    const hasExplorer = /explorer\.exe/i.test(out);
    return hasExplorer ? { ci: false, why: '检测到桌面会话（explorer.exe 在跑）' } : { ci: true, why: '未检测到桌面会话，按 CI 降级' };
  } catch (_) {
    return { ci: true, why: '无法探测桌面会话，保守降级' };
  }
}

const { ci: CI_MODE, why: CI_WHY } = detectCi();
if (CI_MODE) {
  process.env.ORCHDESK_BROWSER_NO_SANDBOX = '1';
  app.disableHardwareAcceleration();
  for (const s of ['disable-gpu', 'no-sandbox']) app.commandLine.appendSwitch(s);
}

// 这些 require 必须发生在确认是 Electron 主进程之后
const APP_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(APP_DIR, 'dist', 'browser-cdp.js'));
const bt = require(path.join(APP_DIR, 'dist', 'browser-tools.js'));

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>OrchDesk 冒烟页</title></head>'
  + '<body><h1 id="h">hello orchdesk</h1>'
  + '<input id="q" value="">'
  + '<a href="https://example.com/1">链接一</a>'
  + '<a href="https://example.com/2">链接二</a></body></html>';

const HARD_TIMEOUT_MS = 90000;
const T0 = Date.now();
let server = null;
const out = [];
const el = () => '+' + ((Date.now() - T0) / 1000).toFixed(1) + 's';
// 每一步都立刻打到 stdout：真机上最常见的是「某一步永久挂起，最后被硬杀，什么都没留下」，
// 只有实时日志才知道卡在第几步。
const step = (name, ok, extra) => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`;
  out.push(line);
  console.log(`[${el()}] ${line}`);
};

const hardTimer = setTimeout(() => {
  out.push('FAIL 冒烟整体超时（90s）——真机上通常是导航卡住或 GPU 进程崩溃');
  finish(3);
}, HARD_TIMEOUT_MS);

function finish(code) {
  clearTimeout(hardTimer);
  try { if (server) server.close(); } catch (_) { /* ignore */ }
  const failed = out.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n=== BROWSER SMOKE ===\n模式：${CI_MODE ? 'CI 降级（' + CI_WHY + '）' : '桌面会话（' + CI_WHY + '）'}\n`
    + out.join('\n') + `\n结果：${out.length - failed}/${out.length}\n`);
  app.exit(code !== undefined ? code : (failed ? 1 : 0));
}

// 冒烟进程没有主窗口：所有窗口一关，Electron 默认就 quit（表现为「跑一半静默退出，
// rc=0 且没打印结果」，极易误判）。必须显式拦住。
app.on('window-all-closed', (e) => e && e.preventDefault && e.preventDefault());

// 子进程崩溃在真机上是最常见的失败形态；不打印就只剩一个退出码，无法归因。
app.on('child-process-gone', (_e, details) => console.log(`[${el()}] CHILD-GONE type=${details.type} reason=${details.reason} exit=${details.exitCode}`));
app.on('render-process-gone', (_e, _c, details) => console.log(`[${el()}] RENDER-GONE reason=${details.reason} exit=${details.exitCode}`));
process.on('uncaughtException', (e) => console.log(`[${el()}] UNCAUGHT ${e && e.stack}`));
process.on('SIGTERM', () => { console.log(`[${el()}] SIGTERM`); app.exit(7); });

app.whenReady().then(async () => {
  console.log(`[${el()}] BOOT 模式=${CI_MODE ? 'CI' : '桌面'}（${CI_WHY}）`);
  let url = '';
  try {
    // 0) 本地测试页：不依赖外网，结果可复现
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}/`;

    // 0.5) 环境自检：先绕开产品代码手动开一个窗口。
    //     真机上失败时最常见的问题是「分不清环境不行还是代码不行」——
    //     这一步成功就说明 Electron/Chromium 本身可用，失败则是环境问题，别去改代码。
    console.log(`[${el()}] 环境自检：NO_SANDBOX=${process.env.ORCHDESK_BROWSER_NO_SANDBOX || '(未设)'}`);
    const probeWin = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { offscreen: false, sandbox: false, contextIsolation: true } });
    await probeWin.loadURL(url);
    step('环境自检：Electron 能开窗口并加载页面', /127\.0\.0\.1/.test(probeWin.webContents.getURL()), probeWin.webContents.getURL());
    // 自检窗口**留着不关**：真机上「关掉一个窗口后再新建窗口并 attach」会让主进程
    // 直接消失（退出码 127、stdout 无任何后续日志）。冒烟脚本中途不要开关窗口。
    void probeWin;

    // 1) 导航：真发 Page.navigate 并等 load
    const st = await cdp.openBrowser(url, { waitUntil: 'load', timeoutMs: 20000 });
    step('browser_open 导航到本地测试页', st.open && st.url === url, JSON.stringify(st));

    // 2) 读正文（Runtime.evaluate + returnByValue）
    const text = await cdp.evalInPage(bt.buildTextExpression('', 500));
    step('browser_text 取到正文', text.ok && /hello orchdesk/.test(String(text.value)),
      `${String(text.value).slice(0, 120)} [via=${text.via || 'cdp'}]`);

    // 3) 取链接
    const links = await cdp.evalInPage(bt.buildLinksExpression('', 10));
    step('browser_links 取到两个链接', links.ok && /example\.com\/1/.test(String(links.value)) && /example\.com\/2/.test(String(links.value)), String(links.value).slice(0, 160));

    // 4) 填值 + 回读：验证 JSON.stringify 注入没有把引号/反斜杠弄坏
    const typed = await cdp.evalInPage(bt.buildTypeExpression('#q', 'he said "hi" \\ ok', { clear: true, pressEnter: false }));
    step('browser_type 填值返回成功', typed.ok, JSON.stringify(typed).slice(0, 160));
    const readBack = await cdp.evalInPage('document.querySelector("#q").value');
    step('browser_type 值回读（引号/反斜杠不逃逸）', String(readBack.value) === 'he said "hi" \\ ok', JSON.stringify(readBack.value));

    // 5) 点击：命中要成功，缺失元素必须报错而不是静默成功
    const clicked = await cdp.evalInPage(bt.buildClickExpression('#h'));
    step('browser_click 命中元素', clicked.ok, JSON.stringify(clicked).slice(0, 160));
    const missing = await cdp.evalInPage(bt.buildClickExpression('#nope'));
    step('browser_click 缺失元素报错（不静默成功）', !missing.ok, JSON.stringify(missing).slice(0, 160));

    // 6) 截图：PNG 真落盘 + 缩略图 dataUrl
    const shot = await cdp.screenshotBrowser({}, app.getPath('userData'));
    const size = shot.ok && fs.existsSync(shot.path) ? fs.statSync(shot.path).size : 0;
    // via 必须可见：CDP 挂起时靠 capturePage 兜底，不打印的话「跑通了」会掩盖降级事实
    step('browser_screenshot PNG 落盘', shot.ok && size > 1000, `${shot.path} size=${size} thumb=${!!shot.dataUrl} via=${shot.via}`);

    // 7) 状态里带 lastShot；关闭后归零
    const st2 = cdp.getBrowserState();
    step('状态带 lastShot', !!(st2.open && st2.lastShot && st2.lastShot.path), JSON.stringify({ open: st2.open, shot: st2.lastShot && st2.lastShot.path }));
    cdp.closeBrowser();
    const st3 = cdp.getBrowserState();
    step('browser_close 后 open=false 且 lastShot=null', st3.open === false && st3.lastShot === null, JSON.stringify(st3));
  } catch (err) {
    step('冒烟过程抛异常', false, (err && err.stack) || String(err));
  }
  finish();
}).catch((err) => {
  step('whenReady 失败', false, (err && err.stack) || String(err));
  finish();
});
