/**
 * 验证脚本共享脚手架（零依赖）
 * ----------------------------------------------------------------------------
 * ponytail audit 削减项 #1：此前 5 个脚本各带一份 electron stub、10 个脚本各自
 * 实现一份 check()+计分样板 —— 同一份代码复制粘贴 N 遍。这里收口成两件东西：
 *
 *   makeElectronStub(opts)  electron 假实现
 *   createChecker()         check + 计分 + 汇总
 *
 * 设计取舍：
 * 1. stub 取 5 份旧实现的**并集**，不是各取所需。多余桩方法零维护成本（都在这一处），
 *    而缺一个方法就会让某个脚本失败——**桩要宽容，断言要严格**。
 * 2. 不做全参数化工厂（ponytail 反对为几个调用方堆配置项）：只把真正有分歧的两处
 *    （getPath 语义、whenReady 回调）做成 opts，其余差异让调用方直接覆盖属性，
 *     例如 `stub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [F] })`。
 *
 * 用法（CJS）：const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');
 * 用法（ESM）：import { makeElectronStub, createChecker } from './verify-kit.cjs';
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

/**
 * CDP debugger 桩（webContents.debugger，ADR-0011）。
 * 记录所有 sendCommand 供断言「浏览器工具真的向页面发了命令」，并模拟
 * 导航事件——否则 waitForLoad 永远等不到 Page.loadEventFired。
 * evaluateResult 可由调用方覆盖，用来返回不同页面内容。
 */
class DebuggerStub extends EventEmitter {
  constructor(commands) {
    super();
    /** 所有 CDP 命令（[{ method, params }]），与其它窗口共享同一个 sink 便于断言。 */
    this.commands = commands || [];
    this.attached = false;
    /** Runtime.evaluate 的预设返回值（{ result: { value } } 或 { exceptionDetails }）。 */
    this.evaluateResult = { result: { type: 'string', value: 'stub-value' } };
    /** 导航后 webContents.getURL() 的返回值。 */
    this.url = '';
    /**
     * 截图行为：'ok' 正常返回 / 'hang' 永久挂起 / 'reject' 立即失败。
     * 真机上合成器不产帧时 CDP 截图就是 hang —— 这个开关用来验证
     * 「超时后回退 capturePage」的兜底真的存在，而不是只有注释里存在。
     */
    this.screenshotMode = 'ok';
  }
  attach(version) { this.attached = true; this.version = version; }
  detach() { this.attached = false; }
  isAttached() { return this.attached; }
  async sendCommand(method, params) {
    this.commands.push({ method, params });
    if (method === 'Page.navigate') {
      this.url = String((params && params.url) || '');
      // 真实浏览器在导航完成后推 loadEventFired；不模拟它会让每次导航都超时。
      setImmediate(() => this.emit('message', {}, 'Page.loadEventFired', {}));
      return {};
    }
    if (method === 'Page.captureScreenshot') {
      if (this.screenshotMode === 'hang') return new Promise(() => { /* 永不 resolve：模拟合成器不产帧 */ });
      if (this.screenshotMode === 'reject') throw new Error('CDP 截图被拒绝');
      return { data: Buffer.from('stub-shot').toString('base64') };
    }
    if (method === 'Runtime.evaluate') return this.evaluateResult;
    return {};
  }
}

/** 假 nativeImage：够 browser-cdp 用来本地缩放生成缩略图。 */
function makeImageStub(buf) {
  const img = {
    _buf: buf || Buffer.from('stub-png'),
    getSize: () => ({ width: 1280, height: 900 }),
    resize: (o) => {
      const resized = makeImageStub(img._buf);
      const w = (o && o.width) || 1280;
      resized.getSize = () => ({ width: w, height: 900 });
      return resized;
    },
    toJPEG: () => Buffer.from('stub-jpeg'),
    toPNG: () => Buffer.from(img._buf),
  };
  return img;
}

/**
 * electron 假实现。
 * @param {object} [opts]
 * @param {string} [opts.home]         数据根目录，缺省自建临时目录
 * @param {(name:string)=>string} [opts.getPath]  覆盖 app.getPath 语义
 * @param {()=>void} [opts.onReady]    whenReady 时的回调（dsh-runtime 用它 resolve 门控）
 * @param {object} [opts.safeStorage]  覆盖加解密桩（默认 `enc:` 前缀的可逆假加密）
 */
function makeElectronStub(opts = {}) {
  const home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-stub-'));
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  /** 渲染层收到的所有 webContents.send（审批链路端到端测试用）。 */
  const webSent = [];
  /** 系统登录项写入历史（FR-4.2 自启动断言用）：最新一条即当前生效设置。 */
  const loginItems = [];
  /** Tray 实例（FR-4.2：断言托盘开关真的创建/销毁了系统托盘）。 */
  const trayInstances = [];
  /** 所有构造过的 BrowserWindow（FR-4.2：断言悬浮窗真的被创建）。 */
  const windows = [];
  /** 所有窗口发出的 CDP 命令（ADR-0011 浏览器工具断言用）。 */
  const cdpCommands = [];
  /** capturePage 调用记录（ADR-0011：CDP 截图超时后的回退路径断言用）。 */
  const capturePageCalls = [];
  const shortcut = makeGlobalShortcutStub();
  const notifications = [];

  return {
    home,
    ipcHandlers,
    ipcListeners,
    webSent,
    loginItems,
    trayInstances,
    windows,
    /** CDP 命令流水（webContents.debugger.sendCommand 全记录）。 */
    cdpCommands,
    /** capturePage 回退调用记录（截图兜底断言用）。 */
    capturePageCalls,
    /** 已注册的全局加速器（FR-4.2）。 */
    get shortcuts() { return shortcut.registered; },
    /** 已发出的系统通知（FR-4.2）。 */
    get notifications() { return notifications; },
    app: {
      isPackaged: false,
      name: 'OrchDesk',
      getPath: opts.getPath || ((name) => path.join(home, 'stub', String(name))),
      whenReady: () => { if (opts.onReady) setImmediate(opts.onReady); return Promise.resolve(); },
      on: () => {},
      quit: () => {},
      setLoginItemSettings: (s) => { loginItems.push(s); },
      getLoginItemSettings: () => loginItems[loginItems.length - 1] || { openAtLogin: false },
    },
    ipcMain: {
      handle: (ch, fn) => { ipcHandlers.set(ch, fn); },
      on: (ch, fn) => { ipcListeners.set(ch, fn); },
    },
    BrowserWindow: class {
      constructor(opts) {
        this.opts = opts || {};
        const dbg = new DebuggerStub(cdpCommands);
        this.debugger = dbg;
        this.title = '';
        this.visible = false;
        this.webContents = {
          send: (ch, payload) => { webSent.push({ ch, payload }); },
          // 浏览器工具（ADR-0011）依赖的页面信息
          getURL: () => dbg.url || this.loadedURL || '',
          getTitle: () => this.title || '',
          isLoading: () => false,
          debugger: dbg,
          // CDP 截图超时后的回退路径（不依赖合成器）
          capturePage: async () => { capturePageCalls.push(Date.now()); return makeImageStub(Buffer.from('captured-png')); },
          on: () => {},
          once: () => {},
          // 导航防护（ADR：will-navigate 拦截 + 拒绝弹窗）——main.ts createWindow 调它，
          // 桩需提供方法否则加载即崩。返回 deny 语义的空对象即可（main 未消费返回值）。
          setWindowOpenHandler: () => ({ action: 'deny' }),
        };
        this.destroyed = false;
        this.loaded = null;
        windows.push(this);
      }
      isDestroyed() { return this.destroyed; }
      setTitle(t) { this.title = t; }
      once() {}
      on() {}
      loadFile(p) { this.loaded = p; }
      loadURL(u) { this.loaded = u; this.loadedURL = u; }
      // 浏览器窗口（ADR-0011）默认 show:false 创建 —— isVisible 必须如实反映，
      // 否则「后台运行 / 已显示」的状态永远测不出来。
      show() { this.visible = true; }
      hide() { this.visible = false; }
      focus() {}
      close() { this.destroyed = true; this.visible = false; }
      isMinimized() { return false; }
      isVisible() { return this.visible; }
      isFocused() { return false; }
      static getAllWindows() { return []; }
    },
    Tray: class {
      constructor() { trayInstances.push(this); this.destroyed = false; }
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() { this.destroyed = true; }
    },
    /** 桌面集成（FR-4.2）桩：记录系统副作用，供断言「开关真的接到了系统」。 */
    globalShortcut: shortcut,
    Notification: makeNotificationStub(notifications),
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: {
      createEmpty: () => makeImageStub(Buffer.alloc(0)),
      createFromPath: () => makeImageStub(Buffer.alloc(0)),
      createFromBuffer: (buf) => makeImageStub(buf),
    },
    contextBridge: { exposeInMainWorld: () => {} },
    shell: { openPath: async () => '' },
    safeStorage: opts.safeStorage || {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s, 'utf-8'),
      decryptString: (b) => Buffer.from(b).toString('utf-8').replace(/^enc:/, ''),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    },
  };
}

/**
 * globalShortcut 桩：register 返回 true 并记账，isRegistered/unregister/unregisterAll 同步状态。
 * 断言侧通过 stub.shortcuts 读取当前注册集合。
 */
function makeGlobalShortcutStub() {
  const registered = new Map();
  return {
    registered,
    register: (acc, fn) => {
      if (registered.has(acc)) return false;
      registered.set(acc, fn);
      return true;
    },
    isRegistered: (acc) => registered.has(acc),
    unregister: (acc) => registered.delete(acc),
    unregisterAll: () => registered.clear(),
  };
}

/**
 * Notification 桩：记录 {title, body}，isSupported() 恒 true。
 * 断言侧通过 stub.notifications 读取。
 */
function makeNotificationStub(sink) {
  const out = sink || [];
  return class {
    static isSupported() { return true; }
    constructor(opts) { this.opts = opts; }
    show() { out.push(this.opts || {}); }
  };
}

/**
 * check + 计分 + 汇总。各脚本的输出尾缀不同，用 okTitle 传入。
 * @returns {{ check: Function, log: string[], passed: number, failed: number, summary: (okTitle?: string) => boolean }}
 */
function createChecker() {
  const log = [];
  let passed = 0;
  let failed = 0;

  const check = async (name, fn) => {
    try {
      await fn();
      passed++;
      log.push(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      // 失败时附带一行栈帧：断言文案常不足以定位到具体行（吸收自 data-port-verify 的做法）
      const stackLine = err && err.stack ? err.stack.split('\n')[1] : '';
      log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}${stackLine ? '\n        ' + stackLine.trim() : ''}`);
    }
  };

  return {
    check,
    log,
    get passed() { return passed; },
    get failed() { return failed; },
    /** 打印明细与汇总；返回是否全绿（调用方据此决定退出码）。 */
    summary(okTitle) {
      console.log('\n' + log.join('\n'));
      console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
      if (okTitle && failed === 0) console.log(okTitle);
      return failed === 0;
    },
  };
}

module.exports = { makeElectronStub, createChecker };
