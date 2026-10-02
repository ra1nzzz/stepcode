/**
 * OrchDesk 桌面壳副作用层：主窗 / 托盘 / 全局快捷键 / 自启动 / 自动更新 / 悬浮窗 / 系统通知。
 * ----------------------------------------------------------------------------
 * 纯数据（归一化 / 落盘 / 悬浮窗 HTML）仍在 desktop-integration.ts（零 electron）。
 * 本模块不 import ./main，避免循环依赖；log / checkForUpdates 经 initBootDesktop 注入。
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, Notification, screen } from 'electron';
import * as path from 'node:path';
import {
  DEFAULT_DESKTOP_CONFIG,
  DESKTOP_LABELS,
  SHORTCUT_ACCELERATOR,
  SHORTCUT_LABEL,
  floatingWindowHtml,
  type DesktopConfig,
  type DesktopKey,
} from './desktop-integration';

export type BootDesktopDeps = {
  log: (level: string, scope: string, msg: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkForUpdates: () => Promise<any>;
};

let bootDeps: BootDesktopDeps | null = null;

export function initBootDesktop(deps: BootDesktopDeps): void {
  bootDeps = deps;
}

function log(level: string, scope: string, msg: string): void {
  bootDeps?.log(level, scope, msg);
}

function checkForUpdates(): Promise<unknown> {
  return bootDeps ? bootDeps.checkForUpdates() : Promise.resolve(undefined);
}

export let mainWindow: BrowserWindow | null = null;
export let tray: Tray | null = null;
export let desktopConfig: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG };
export let floatingWindow: BrowserWindow | null = null;
/** 悬浮窗展示的上下文（由渲染层在切换会话时推送，避免主进程猜「当前会话」）。 */
export let floatingContext: { title: string; sessions: number } = { title: '', sessions: 0 };

/** CJS 命名空间导入下 export let 对 TS 是只读的；经此写入以保持同一 live binding。 */
export function setDesktopConfig(next: DesktopConfig): DesktopConfig {
  desktopConfig = next;
  return desktopConfig;
}

export function setFloatingContext(next: { title: string; sessions: number }): { title: string; sessions: number } {
  floatingContext = next;
  return floatingContext;
}

let recoveringRenderer = false;
const rendererGoneAt: number[] = [];

export function isRecoveringRenderer(): boolean {
  return recoveringRenderer;
}

function allowRendererRecovery(): boolean {
  const now = Date.now();
  while (rendererGoneAt.length && now - rendererGoneAt[0]! > 60_000) rendererGoneAt.shift();
  rendererGoneAt.push(now);
  return rendererGoneAt.length <= 3;
}

function recoverRenderer(win: BrowserWindow, why: string): void {
  if (!allowRendererRecovery()) {
    recoveringRenderer = false;
    log('ERROR', 'desktop', `渲染进程反复退出，停止自动恢复：${why}`);
    return;
  }
  recoveringRenderer = true;
  log('ERROR', 'desktop', `渲染进程异常，准备恢复：${why}`);
  setTimeout(() => {
    try {
      if (!win.isDestroyed()) {
        win.loadFile(path.join(__dirname, '../renderer/index.html'));
        log('INFO', 'desktop', '渲染进程已重新加载');
        return;
      }
    } catch (err) {
      log('WARN', 'desktop', `渲染进程重载失败，重建窗口：${(err as Error).message}`);
    }
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* 已关闭 */ }
    createWindow();
  }, 50);
  setTimeout(() => { recoveringRenderer = false; }, 1500);
}

export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    center: true,
    show: false,
    backgroundColor: '#1E1E1E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // 导航防护（安全纵深）：主窗口永远只载本地 file:// 页面。一旦被导航到远端，
  // preload 暴露的 bridge API 就落进外部内容手里——即使 contextIsolation 也在，
  // 也应在源头堵死。内部浏览器走独立 BrowserWindow（browser-cdp.ts），不在此窗口导航。
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  // 拒绝 window.open / target=_blank 逃逸（无 popup 需求；内部打开走别通道）。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  const win = mainWindow;
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    recoverRenderer(win, `${details.reason} exit=${details.exitCode}`);
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 全局快捷键语义：没有窗口 → 创建；可见且聚焦 → 隐藏；否则 → 唤起。 */
function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showMainWindow();
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(nativeImage.createEmpty());
  const contextMenu = Menu.buildFromTemplate([
    { label: '打开主窗', click: () => showMainWindow() },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setToolTip('OrchDesk');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function destroyTray(): void {
  if (!tray) return;
  try {
    tray.destroy();
  } catch {
    // 已销毁：destroy 抛错不应阻断开关切换
  }
  tray = null;
}

/** 系统托盘：关闭后是否继续常驻。 */
export function applyTray(on: boolean): void {
  if (on) createTray();
  else destroyTray();
}

/** 全局快捷键 Ctrl(Cmd)+Shift+Space：注册/注销唯一加速器。 */
export function applyShortcut(on: boolean): void {
  try {
    if (on) {
      if (globalShortcut.isRegistered(SHORTCUT_ACCELERATOR)) return;
      const ok = globalShortcut.register(SHORTCUT_ACCELERATOR, () => toggleMainWindow());
      if (!ok) log('WARN', 'desktop', `全局快捷键注册失败（${SHORTCUT_LABEL}）：可能被其它应用占用`);
    } else {
      globalShortcut.unregister(SHORTCUT_ACCELERATOR);
    }
  } catch (err) {
    log('WARN', 'desktop', `全局快捷键接线异常：${(err as Error).message}`);
  }
}

/** 读系统登录项真实状态（写入可能被系统拒绝，UI 必须展示实际值而非意愿值）。 */
export function readLoginItemSettings(): { openAtLogin?: boolean } {
  try {
    return app.getLoginItemSettings() as { openAtLogin?: boolean };
  } catch {
    return {};
  }
}

/** 登录自启动：写系统登录项（Windows 注册表 / macOS LaunchAgent）。 */
export function applyAutostart(on: boolean): { ok: boolean; reason?: string } {
  try {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: on });
    return { ok: true };
  } catch (err) {
    const reason = (err as Error).message;
    log('WARN', 'desktop', `登录自启动写入失败：${reason}`);
    return { ok: false, reason };
  }
}

/** 开机提醒：关键事件（启动完成 / 更新可用）发系统通知。 */
export function notifyDesktop(title: string, body: string): boolean {
  if (!desktopConfig.notify) return false;
  try {
    if (Notification.isSupported && !Notification.isSupported()) return false;
    new Notification({ title, body }).show();
    return true;
  } catch (err) {
    log('WARN', 'desktop', `系统通知发送失败：${(err as Error).message}`);
    return false;
  }
}

/** 自动更新：延迟后台检查（不阻塞首屏），有新版时按配置发通知。 */
export function applyAutoUpdate(on: boolean): void {
  if (!on) return;
  const timer = setTimeout(() => {
    void checkForUpdates()
      .then((r) => {
        const rec = r as { update?: { available?: boolean; note?: string; version?: string } } | undefined;
        if (rec?.update?.available) {
          notifyDesktop('StepCode Desktop 有新版本', String(rec.update.note || `v${rec.update.version || ''} 可安装，请在设置里确认`));
        }
      })
      .catch((err) => log('WARN', 'desktop', `自动更新检查异常：${(err as Error).message}`));
  }, 8000);
  timer.unref();
}

function floatingPosition(): { x: number; y: number } {
  try {
    const area = screen.getPrimaryDisplay().workAreaSize;
    return { x: Math.max(0, area.width - 288 - 16), y: Math.max(0, area.height - 120 - 48) };
  } catch {
    return { x: 0, y: 0 };
  }
}

export function renderFloatingWindow(): void {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  const title = floatingContext.title || 'OrchDesk';
  const html = floatingWindowHtml({
    title,
    subtitle: floatingContext.title ? '当前会话' : '未选择会话',
    sessions: floatingContext.sessions,
  });
  void floatingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createFloatingWindow(): void {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    renderFloatingWindow();
    return;
  }
  floatingWindow = new BrowserWindow({
    width: 288,
    height: 96,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    ...floatingPosition(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  floatingWindow.on('closed', () => { floatingWindow = null; });
  // 导航防护与主窗一致（纵深防御）：悬浮窗内容全由主进程 loadURL(data:) 生成，
  // 无渲染层合法导航；禁止渲染层内部任何导航逃逸。
  floatingWindow.webContents.on('will-navigate', (event) => { event.preventDefault(); });
  floatingWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 悬浮窗是沙箱渲染进程，页面内无 ipcRenderer —— 用窗口聚焦事件实现「点击唤起主窗」。
  floatingWindow.on('focus', () => showMainWindow());
  floatingWindow.once('ready-to-show', () => floatingWindow?.show());
  renderFloatingWindow();
}

export function destroyFloatingWindow(): void {
  if (!floatingWindow) return;
  try {
    if (!floatingWindow.isDestroyed()) floatingWindow.close();
  } catch {
    // 已关闭
  }
  floatingWindow = null;
}

export function applyFloating(on: boolean): void {
  if (on) createFloatingWindow();
  else destroyFloatingWindow();
}

function desktopSummary(): string {
  return (Object.keys(desktopConfig) as DesktopKey[])
    .map((k) => `${DESKTOP_LABELS[k]}=${desktopConfig[k] ? '开' : '关'}`)
    .join(' / ');
}

/**
 * 全量重放（启动时）。顺序无关，但自启动写系统项放最后，失败不影响其余。
 * 整体 try/catch：桌面集成为增强项，任一系统能力不可用都不该阻断主窗启动。
 */
export function applyDesktopConfig(): void {
  try {
    applyTray(desktopConfig.tray);
    applyShortcut(desktopConfig.shortcut);
    applyFloating(desktopConfig.floating);
    applyAutoUpdate(desktopConfig.autoupdate);
    const r = applyAutostart(desktopConfig.autostart);
    if (!r.ok) log('WARN', 'desktop', `登录自启动未生效：${r.reason}`);
    log('INFO', 'desktop', `桌面集成已应用：${desktopSummary()}`);
  } catch (err) {
    log('WARN', 'desktop', `桌面集成应用异常：${(err as Error).message}`);
  }
}
