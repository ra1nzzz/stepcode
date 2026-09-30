/// <reference types="electron" />
/**
 * 浏览器工具宿主层（CDP）
 * ----------------------------------------------------------------------------
 * 用 Electron 自带的 `webContents.debugger`（Chrome DevTools Protocol 1.3）
 * 驱动一个内置 BrowserWindow，**不引入 playwright / puppeteer**（ADR-0011）。
 *
 * 为什么走 CDP 而不是 `webContents.executeJavaScript`：
 *   1. Runtime.evaluate 支持 awaitPromise / returnByValue / userGesture / 超时，
 *      executeJavaScript 全都没有（填表后等异步校验只能靠 sleep）；
 *   2. 不受页面 CSP 与 `window.` 上下文污染影响；
 *   3. 截图 / 整页截图 / 导航等待是同一套协议，不必混用两套机制。
 *
 * 为什么是**共享登录态**的普通 session：浏览京东后台、内部系统等真实场景
 * 依赖用户已有的登录态；用独立 session 会让工具「能开网页但没有权限」，
 * 直接把能力砍掉一半。代价是 Agent 能看到用户已登录的页面 —— 因此所有
 * 会改变页面状态的操作（点击 / 输入 / 执行脚本）都必须过授权门（门在 main.ts）。
 *
 * 本模块只做「怎么驱动浏览器」，参数校验与表达式构造在 browser-tools.ts（纯逻辑）。
 */

import { BrowserWindow, nativeImage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BROWSER_NO_ELEMENT,
  BROWSER_PAGES_MAX,
  BROWSER_SHOT_DIR,
  BROWSER_SHOT_THUMB_WIDTH,
  browserShotRelativePath,
  clampBrowserTimeout,
  type BrowserPageSnapshot,
  type BrowserStateSnapshot,
  type BrowserWaitMode,
} from './browser-tools';

/** CDP 协议版本：Electron 全系支持 1.3。 */
const CDP_VERSION = '1.3';

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 900;

/**
 * 受限会话逃生口：非交互桌面 / CI 下 Chromium sandbox 与 GPU 进程起不来。
 * 仅 real-browser 冒烟脚本（scripts/browser-smoke.cjs）设置；产品运行不带。
 */
const NO_SANDBOX = process.env.ORCHDESK_BROWSER_NO_SANDBOX === '1';

let win: BrowserWindow | null = null;
let attached = false;
/**
 * CDP 命令在本窗口已被证实不可用（挂起，既不返回也不报错）。
 * 置位后不再对每个命令傻等超时，直接走原生回退。新开窗口时复位。
 */
let cdpBroken = false;
let shotSeq = 0;
let lastShot: { path: string; dataUrl?: string } | null = null;
let lastError = '';
let stateListener: ((st: BrowserStateSnapshot) => void) | null = null;
/**
 * 页面快照 TAB（UI 重构）：单窗口模型下的「访问过的页面」登记簿。
 * 最新访问的排在最前；超过 BROWSER_PAGES_MAX 丢最旧（与 trace pending 同一个道理，
 * 遥测级数据不许无界）。
 */
let pages: BrowserPageSnapshot[] = [];
let activePageId: string | null = null;
let pageSeq = 0;

export function onBrowserStateChange(cb: ((st: BrowserStateSnapshot) => void) | null): void {
  stateListener = cb;
}

export function isBrowserOpen(): boolean {
  return !!win && !win.isDestroyed();
}

/**
 * 登记一次页面访问（导航成功后调用）：同 URL 复用已有卡片，否则新建一张并置为活跃。
 * 单窗口模型下「同一时刻只有一个活跃页面」是硬事实，卡片列表表达的是
 * 「Agent 先后访问过哪些页面」，不是「多个页面并存」。
 */
function registerPage(url: string, title?: string): void {
  const u = url || '';
  if (!u) return;
  const existing = pages.find((p) => p.url === u);
  if (existing) {
    if (title) existing.title = title;
    activePageId = existing.id;
    pages.forEach((p) => { p.active = p.id === existing.id; });
    return;
  }
  pageSeq += 1;
  const page: BrowserPageSnapshot = { id: `pg${pageSeq}`, url: u, title: title || '', at: Date.now(), active: true };
  pages = [page, ...pages.map((p) => ({ ...p, active: false }))];
  activePageId = page.id;
  // 上限：丢最旧（活跃页永远在最前，不会被丢）
  if (pages.length > BROWSER_PAGES_MAX) pages = pages.slice(0, BROWSER_PAGES_MAX);
}

/** 当前活跃页面快照（没有则 null）。 */
function activePage(): BrowserPageSnapshot | null {
  return pages.find((p) => p.id === activePageId) || pages[0] || null;
}

/** 截图完成后把缩略图回填到活跃页面卡上。 */
function stampActiveShot(dataUrl: string | undefined): void {
  if (!dataUrl) return;
  const ap = activePage();
  if (ap) ap.shot = dataUrl;
}

export function getBrowserState(): BrowserStateSnapshot {
  // 未打开时也要给出 lastShot: null / pages: [] —— 状态对象形状必须稳定，
  // 否则渲染层要用 `st.lastShot || null` 之类的兜底才能不显示上一张截图。
  if (!isBrowserOpen() || !win) return { open: false, lastShot: null, lastError: lastError || undefined, pages: [] };
  return {
    open: true,
    url: win.webContents.getURL() || '',
    title: win.webContents.getTitle() || '',
    visible: win.isVisible(),
    lastShot,
    lastError: lastError || undefined,
    pages: pages.map((p) => ({ ...p })),
  };
}

/**
 * 关闭单个页面快照 TAB（UI 侧栏「×」）。
 * 关的是**卡片**，不是窗口：底层只有一个窗口，关掉活跃卡时窗口同时收起，
 * 关掉非活跃卡只从列表移除（那个页面早已不在窗口里了）。
 */
export function closeBrowserPage(id: string): BrowserStateSnapshot {
  const target = pages.find((p) => p.id === id);
  if (target) {
    pages = pages.filter((p) => p.id !== id);
    if (activePageId === id) {
      // 活跃卡被关：让出窗口 —— 还有其它卡则切到最新一张，否则关窗口
      const next = pages[0];
      if (next) {
        next.active = true;
        activePageId = next.id;
        if (isBrowserOpen()) void navigateTo(next.url, 15_000).catch(() => { /* 导航失败保留卡片 */ });
      } else {
        activePageId = null;
        closeBrowser();
        return getBrowserState();
      }
    }
  }
  emit();
  return getBrowserState();
}

/** 关闭全部页面快照 TAB（UI 侧栏「全部关闭」）：清空登记簿并收起窗口。 */
export function clearBrowserPages(): BrowserStateSnapshot {
  pages = [];
  activePageId = null;
  lastShot = null;
  closeBrowser();
  emit();
  return getBrowserState();
}

function emit(): void {
  // 标题在 did-finish-load 后才稳定：每次推送顺带把活跃页卡片的标题同步一遍，
  // 否则侧栏 TAB 会一直停在导航那一刻的旧标题（甚至是空标题）。
  if (win && !win.isDestroyed()) {
    const t = win.webContents.getTitle() || '';
    const u = win.webContents.getURL() || '';
    const ap = activePage();
    if (ap && u && ap.url === u && t) ap.title = t;
  }
  if (stateListener) {
    try { stateListener(getBrowserState()); } catch { /* 推送失败不影响工具执行 */ }
  }
}

/** 取 debugger（调用前必须确认窗口存在）。 */
function dbg(): Electron.Debugger {
  return win!.webContents.debugger;
}

async function cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
  if (!isBrowserOpen()) throw new Error('浏览器未打开');
  const d = dbg();
  if (!attached) {
    try {
      d.attach(CDP_VERSION);
      attached = true;
      // 视口固定：截图尺寸与元素可见范围才可预期。窗口本身已是 1280×900，
      // 这条只是把设备像素比与视口对齐，失败不阻断任何功能。
      //
      // 受限会话（无合成器）下发它会让**整个主进程直接消失**（退出码 127、无日志），
      // 连 try/catch 都来不及 —— 所以 CI 模式直接跳过：为一条可选命令赌上进程不值得。
      if (!NO_SANDBOX) {
        await withTimeout(
          d.sendCommand('Emulation.setDeviceMetricsOverride', {
            width: WINDOW_WIDTH, height: WINDOW_HEIGHT, deviceScaleFactor: 1, mobile: false,
          }),
          2000,
          'Emulation.setDeviceMetricsOverride',
        ).catch(() => undefined);
      }
    } catch (err) {
      throw new Error(`CDP 连接失败：${(err as Error).message}`);
    }
  }
  return (await d.sendCommand(method, params)) as T;
}

/** 创建（或复用）浏览器窗口。默认后台隐藏，用户可从「浏览器」面板显示它。 */
function ensureWindow(): BrowserWindow {
  if (isBrowserOpen()) return win!;
  attached = false;
  cdpBroken = false;
  lastShot = null;
  lastError = '';
  const w = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    title: 'OrchDesk 浏览器',
    backgroundColor: '#FFFFFF',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 沙箱承载的是任意外部网页，默认开启。
      // NO_SANDBOX 是受限会话的逃生口：非交互桌面 / CI 下 Chromium 的 sandbox 与 GPU 进程
      // 起不来，渲染进程直接 fatal（表现为进程退出码 127、stdout 全空，极易误判成代码问题）。
      // 只有 scripts/browser-smoke.cjs 会设它，产品运行不带这个变量。
      sandbox: !NO_SANDBOX,
      // 不启用 offscreen：OSR 下截图与渲染在部分显卡驱动上有兼容问题，
      // 隐藏窗口（show:false）已足够，且可随时 show() 给用户看。
      offscreen: false,
    },
  });
  w.on('closed', () => {
    if (win === w) { win = null; attached = false; }
    emit();
  });
  win = w;
  return w;
}

/** 给 promise 加超时：CDP 在 target 不可用时既不返回也不报错，只有超时能救。 */
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${tag} 超时（${ms}ms）`)), ms);
    }),
  ]) as Promise<T>;
}

/**
 * 可选 CDP 调用：失败或超时都只记一句诊断，不阻断。
 * Page.enable / Runtime.enable 属于「锦上添花」——前者只为收 loadEventFired
 * （丢了还有 readyState 轮询），后者对 Runtime.evaluate 并非必需。真机上
 * 它们在 target 不可用时**永久挂起**，所以必须带超时。
 */
async function cdpOptional(method: string, ms: number): Promise<void> {
  try {
    await withTimeout(cdp(method), ms, method);
  } catch (err) {
    lastError = `${method} 不可用（${(err as Error).message}），已降级`;
  }
}

/**
 * 等待页面加载。
 * 事件（Page.loadEventFired / Page.domContentEventFired）为主，
 * readyState 轮询为兜底：页面在 attach 之前就已加载完时，事件不会再发一次。
 */
async function waitForLoad(timeoutMs: number, mode: BrowserWaitMode): Promise<void> {
  const events = mode === 'dom'
    ? ['Page.domContentEventFired', 'Page.loadEventFired']
    : ['Page.loadEventFired'];
  const wantReady = mode === 'dom' ? ['interactive', 'complete'] : ['complete'];

  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let resolveOuter: () => void = () => undefined;

  const msgHandler = (_e: unknown, method: string): void => {
    if (settled) return;
    if (events.includes(method)) { settled = true; cleanup(); resolveOuter(); }
  };

  // cleanup 里引用的三个句柄都在下面赋值；实际调用只发生在赋值之后（定时器 / 事件回调）。
  function cleanup(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (poll) { clearInterval(poll); poll = null; }
    try {
      (dbg() as unknown as { removeListener: (e: string, fn: unknown) => void }).removeListener('message', msgHandler);
    } catch { /* 窗口已关闭 */ }
  }

  const result = new Promise<void>((resolve, reject) => {
    resolveOuter = resolve;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`页面加载超时（${timeoutMs}ms）；可加大 timeout 或改用 waitUntil:"dom"`));
    }, timeoutMs);
  });

  // debugger 的所有 CDP 事件都走同一个 'message'，method 在第二个参数里。
  dbg().on('message', msgHandler);

  // 兜底轮询：evaluate 在导航期间可能抛错（执行上下文销毁），忽略即可。
  // 单次请求也带超时：CDP 挂起时轮询会一个接一个堆积，最后所有回调都等不到。
  poll = setInterval(() => {
    if (settled) return;
    withTimeout(cdp<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: 'document.readyState', returnByValue: true,
    }), 1500, 'readyState 轮询').then((r) => {
      if (settled) return;
      const rs = String(r?.result?.value ?? '');
      if (wantReady.includes(rs)) { settled = true; cleanup(); resolveOuter(); }
    }).catch(() => undefined);
  }, 250);

  return result;
}

/**
 * 导航：CDP Page.navigate 优先，挂起/失败则回退 Electron 原生 loadURL。
 *
 * 为什么需要回退：真机上 attach 之后 CDP 命令可能既不返回也不报错（target 不可用 /
 * 合成器缺失时实测必现），此时只有 loadURL 还能把页面打开。没有这段代码，
 * browser_open 会一直卡到整体超时，用户看到的是「工具没反应」。
 *
 * @returns 'cdp' 走协议（可继续等 loadEventFired）；'loadurl' 走原生（loadURL 自身
 *          在 did-finish-load 时 resolve，无需再等事件）
 */
async function navigateTo(url: string, timeoutMs: number): Promise<'cdp' | 'loadurl'> {
  try {
    await withTimeout(cdp('Page.navigate', { url }), Math.min(timeoutMs, 5000), 'Page.navigate');
    return 'cdp';
  } catch (err) {
    cdpBroken = true;
    lastError = `CDP 导航失败（${(err as Error).message}），已回退 loadURL`;
  }
  const w = win!;
  await withTimeout(w.loadURL(url), timeoutMs, 'loadURL');
  return 'loadurl';
}

/** 打开（或导航到）网址。 */
export async function openBrowser(
  url: string,
  opts: { waitUntil?: BrowserWaitMode; timeoutMs?: number } = {},
): Promise<BrowserStateSnapshot> {
  const timeoutMs = opts.timeoutMs || 20_000;
  const mode = opts.waitUntil || 'load';
  ensureWindow();
  // 两者都不是导航的必要条件，挂起时降级而不是卡死（详见 cdpOptional 注释）。
  await cdpOptional('Page.enable', 2000);
  await cdpOptional('Runtime.enable', 2000);

  let via: 'cdp' | 'loadurl';
  try {
    via = await navigateTo(url, timeoutMs);
  } catch (err) {
    lastError = (err as Error).message;
    emit();
    throw err;
  }

  if (via === 'cdp') {
    try {
      await waitForLoad(timeoutMs, mode);
    } catch (err) {
      // loadEventFired 超时但 navigate 本身成功时，页面其实是可用的：
      // 不把「等太久」当成「打不开」——保留窗口，把超时如实报给模型。
      lastError = (err as Error).message;
      emit();
      throw err;
    }
  } else {
    // loadURL 已在 did-finish-load 时 resolve，这里只是把状态同步出去
    lastError = '';
  }
  // 导航成功 = 一次页面访问：登记进侧栏的页面快照 TAB（同 URL 复用卡片）。
  // 标题在 did-finish-load 后才稳定，这里取的是当前值，后续状态推送会带着新标题。
  registerPage(url, win!.webContents.getTitle() || '');
  emit();
  return getBrowserState();
}

/** 在页面上下文求值。返回 { ok, value, error }。 */
export async function evalInPage(
  expression: string,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; value?: string; error?: string; via?: 'cdp' | 'executeJavaScript' }> {
  if (!isBrowserOpen()) return { ok: false, error: '浏览器未打开（先用 browser_open 打开网址）' };
  try {
    // 外层超时防的是「命令挂起」，内层 timeout 防的是「页面里跑太久」——两回事。
    // CDP 挂起时 sendCommand 永不 settle，只有外层超时能让它返回。
    const r = await withTimeout(cdp<{
      result?: { value?: unknown; type?: string; subtype?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: timeoutMs,
    }), timeoutMs + 1000, 'Runtime.evaluate');
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面内执行异常';
      return { ok: false, error: String(msg).slice(0, 1000) };
    }
    const v = r.result?.value;
    const text = v === undefined || v === null
      ? (r.result?.type === 'undefined' ? '(undefined)' : '(null)')
      : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    if (String(text).startsWith(BROWSER_NO_ELEMENT)) {
      return { ok: false, error: '选择器没有匹配到任何元素（可用 browser_text 先看页面结构，或换一个选择器）' };
    }
    cdpBroken = false;
    return { ok: true, value: String(text) };
  } catch (err) {
    const msg = (err as Error).message;
    // CDP 整条路都挂了时，页面本身往往还是好的 —— 退回 executeJavaScript 至少能读能写。
    // 它缺 awaitPromise / userGesture / CSP 豁免，所以只在 CDP 不可用时使用。
    if (/超时|挂起|not connected|Target closed/i.test(msg)) {
      cdpBroken = true;
      try {
        const v = await withTimeout(win!.webContents.executeJavaScript(expression, true), timeoutMs, 'executeJavaScript');
        const text = v === undefined || v === null ? '(null)' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        if (String(text).startsWith(BROWSER_NO_ELEMENT)) {
          return { ok: false, error: '选择器没有匹配到任何元素（可用 browser_text 先看页面结构，或换一个选择器）' };
        }
        return { ok: true, value: String(text), via: 'executeJavaScript' as const };
      } catch (e2) {
        return { ok: false, error: `CDP 与 executeJavaScript 都不可用：${msg} / ${(e2 as Error).message}`.slice(0, 1000) };
      }
    }
    return { ok: false, error: msg.slice(0, 1000) };
  }
}

/**
 * 取一帧 PNG。两条路：
 *   1. CDP Page.captureScreenshot —— 支持整页，但在合成器不产帧的环境（远程桌面 / 锁屏 /
 *      无 GPU 会话）会永久挂起，所以必须带超时；
 *   2. Electron webContents.capturePage —— 不走合成器，实测 68ms 出图，但只能取视口。
 * 失败要有明确原因，绝不静默挂死。
 */
async function capturePng(opts: { fullPage?: boolean; timeoutMs: number }): Promise<{ buf: Buffer; via: 'cdp' | 'capturePage'; note?: string }> {
  if (!cdpBroken) {
    try {
      const shot = await withTimeout(
        cdp<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: Boolean(opts.fullPage),
        }),
        opts.timeoutMs,
        'CDP 截图',
      );
      if (shot?.data) return { buf: Buffer.from(shot.data, 'base64'), via: 'cdp' };
    } catch (err) {
      // 落到回退路径
      cdpBroken = true;
      lastError = `CDP 截图失败（${(err as Error).message}），改用 capturePage`;
    }
  }
  const w = win!;
  const img = await withTimeout(w.webContents.capturePage(), opts.timeoutMs, 'capturePage 截图');
  const buf = img.toPNG();
  if (!buf.length) throw new Error('capturePage 返回空图');
  return {
    buf,
    via: 'capturePage',
    note: opts.fullPage ? '回退路径只能截取视口范围，整页截图不可用' : undefined,
  };
}

/**
 * 截图：PNG 落盘（给模型绝对路径）+ 一张 JPEG 缩略图（给 UI 面板，data URL 不落盘）。
 * @param dataDir 数据根目录（screenshot 只在其中写 browser-shots 子目录）
 */
export async function screenshotBrowser(
  opts: { fullPage?: boolean; timeoutMs?: number } = {},
  dataDir?: string,
): Promise<{ ok: boolean; path?: string; dataUrl?: string; via?: 'cdp' | 'capturePage'; note?: string; error?: string }> {
  if (!isBrowserOpen()) return { ok: false, error: '浏览器未打开（先用 browser_open 打开网址）' };
  if (!dataDir) return { ok: false, error: '数据目录未就绪' };
  try {
    const timeoutMs = clampBrowserTimeout(opts.timeoutMs, 'shot');
    const { buf, via, note } = await capturePng({ fullPage: opts.fullPage, timeoutMs });
    const ts = Date.now();
    shotSeq += 1;
    const rel = browserShotRelativePath(ts, shotSeq, 'png');
    const abs = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);

    // 缩略图从已得图像本地缩放，不再发起第二次截图请求：
    // CDP 取不到帧时第二次请求同样会挂，那时连主结果都拿不到。
    let dataUrl: string | undefined;
    try {
      const img = nativeImage.createFromBuffer(buf);
      const w = img.getSize().width || BROWSER_SHOT_THUMB_WIDTH;
      if (w > BROWSER_SHOT_THUMB_WIDTH) {
        const resized = img.resize({ width: BROWSER_SHOT_THUMB_WIDTH });
        dataUrl = `data:image/jpeg;base64,${resized.toJPEG(45).toString('base64')}`;
      } else {
        dataUrl = `data:image/jpeg;base64,${img.toJPEG(45).toString('base64')}`;
      }
    } catch { /* 缩略图失败不影响主结果 */ }

    lastShot = { path: abs, dataUrl };
    // 缩略图回填到活跃页面卡上——侧栏 TAB 显示的就是这张（没有截过图的页面显示占位）
    stampActiveShot(dataUrl);
    lastError = '';
    emit();
    return { ok: true, path: abs, dataUrl, via, note };
  } catch (err) {
    const msg = (err as Error).message;
    lastError = msg;
    emit();
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/** 显示 / 隐藏浏览器窗口（用户想看 Agent 在干什么时用）。 */
export function setBrowserVisible(visible: boolean): BrowserStateSnapshot {
  if (!isBrowserOpen() || !win) return getBrowserState();
  if (visible) {
    win.show();
    win.focus();
  } else {
    win.hide();
  }
  emit();
  return getBrowserState();
}

/** 关闭浏览器窗口（detach + 关闭；登录态保留在用户数据目录）。 */
export function closeBrowser(): boolean {
  if (!isBrowserOpen() || !win) return false;
  try {
    if (attached) {
      try { dbg().detach(); } catch { /* 可能已被页面侧断开 */ }
    }
  } finally {
    attached = false;
    const w = win;
    win = null;
    lastShot = null;
    // 窗口关了 = 一次浏览会话结束：页面快照 TAB 一并清空，
    // 否则下次打开浏览器会看到上一轮的陈旧卡片（且它们的 URL 已不在窗口里）。
    pages = [];
    activePageId = null;
    try { w.close(); } catch { /* 已关闭 */ }
  }
  emit();
  return true;
}

/** 截图目录（数据目录 + browser-shots），供「打开截图目录」用。 */
export function browserShotDir(dataDir: string): string {
  return path.join(dataDir, BROWSER_SHOT_DIR);
}
