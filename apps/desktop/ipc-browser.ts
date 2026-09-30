/**
 * 浏览器（CDP）面板 IPC。
 * 注册须在 main.ts patch ipcMain.handle 之后调用，才能走 sender 门。
 */
import * as fs from 'node:fs';
import { shell, type IpcMain } from 'electron';
import type { BrowserStateSnapshot } from './browser-tools';
import { isBlockedHost } from './host-services';
import { recordSandbox } from './ipc-sandbox';
import {
  browserShotDir,
  clearBrowserPages,
  closeBrowser as cdpCloseBrowser,
  closeBrowserPage,
  getBrowserState,
  onBrowserStateChange,
  openBrowser as cdpOpenBrowser,
  setBrowserVisible,
} from './browser-cdp';

export type IpcNotify = (channel: string, payload: unknown) => void;

export type BrowserIpcHost = {
  dataDir: () => string;
  notify: IpcNotify;
};

export function registerBrowserIpc(ipc: IpcMain, host: BrowserIpcHost): void {
  function pushBrowserState(st?: BrowserStateSnapshot): void {
    const snapshot = st || getBrowserState();
    host.notify('orchdesk:browser-state', snapshot);
  }

  onBrowserStateChange((st) => pushBrowserState(st));

  ipc.handle('orchdesk:browser-status', async () => {
    const st = getBrowserState();
    return { ...st, shotsDir: browserShotDir(host.dataDir()) };
  });

  ipc.handle('orchdesk:browser-toggle-visible', async (_e, visible: unknown) => {
    const st = setBrowserVisible(Boolean(visible));
    return { ok: st.open, state: st };
  });

  ipc.handle('orchdesk:browser-close', async () => {
    const closed = cdpCloseBrowser();
    return { ok: true, closed, state: getBrowserState() };
  });

  ipc.handle('orchdesk:browser-close-page', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, reason: '缺少页面 id', state: getBrowserState() };
    return { ok: true, state: closeBrowserPage(id) };
  });

  ipc.handle('orchdesk:browser-clear-pages', async () => {
    return { ok: true, state: clearBrowserPages() };
  });

  ipc.handle('orchdesk:browser-goto', async (_e, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, reason: 'URL 不合法（仅支持 http/https）', state: getBrowserState() };
    }
    // R4-1：Agent 侧 browser_open 在 tool-exec 里同时过域名白名单 + isBlockedHost
    // （fail-closed），而这条渲染层可达的通道原来只校验 http(s) 协议——被 XSS/供应链
    // 攻陷的渲染层可把隐藏内部浏览器导航到内网/云元数据端点，页面标题与截图又经
    // browser-status 回传，形成「内网读数 → 渲染层」的 SSRF 通道，且不记沙箱日志、
    // 事后不可追溯。按 Agent 路径同规格补两道：主机黑名单 + 沙箱留痕。
    if (isBlockedHost(url)) {
      recordSandbox({ tool: 'browser.goto', kind: 'network', target: url, decision: 'denied', reason: 'SSRF 防护：目标为内网/回环/元数据地址' });
      return { ok: false, reason: '目标为内网/回环/元数据地址，已被 SSRF 防护拒绝', state: getBrowserState() };
    }
    try {
      await cdpOpenBrowser(url, { timeoutMs: 20_000 });
      recordSandbox({ tool: 'browser.goto', kind: 'network', target: url, decision: 'allowed' });
      return { ok: true, state: getBrowserState() };
    } catch (err) {
      recordSandbox({ tool: 'browser.goto', kind: 'network', target: url, decision: 'error', reason: (err as Error).message });
      return { ok: false, reason: (err as Error).message, state: getBrowserState() };
    }
  });

  ipc.handle('orchdesk:browser-open-shot-dir', async () => {
    const dir = browserShotDir(host.dataDir());
    try {
      fs.mkdirSync(dir, { recursive: true });
      const opened = await shell.openPath(dir);
      return { ok: opened === '', dir, reason: opened || undefined };
    } catch (err) {
      return { ok: false, dir, reason: (err as Error).message };
    }
  });
}
