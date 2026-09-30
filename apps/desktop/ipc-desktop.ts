/**
 * 桌面集成 IPC（PRD FR-4.2）：设置页 6 个开关（托盘/快捷键/自启动/自动更新/悬浮窗/
 * 开机提醒）+ 悬浮窗上下文推送。
 * 从 main.ts 抽出（M2 组合根分离第二轮）。bootDesktop 与 desktop-integration
 * 都是无 electron 之外副作用的模块，直接 import；dataDir 经 deps 注入。
 */
import type { IpcMain } from 'electron';
import * as bootDesktop from './boot-desktop';
import {
  DESKTOP_LABELS,
  SHORTCUT_LABEL,
  loadDesktopConfig,
  saveDesktopConfig,
  setDesktopKey,
} from './desktop-integration';
import { log } from './logger';

export interface DesktopIpcDeps {
  dataDir: () => string;
}

export function registerDesktopIpc(ipc: IpcMain, deps: DesktopIpcDeps): void {
  ipc.handle('orchdesk:desktop-get', async () => {
    bootDesktop.setDesktopConfig(loadDesktopConfig(deps.dataDir()));
    return {
      config: { ...bootDesktop.desktopConfig },
      shortcutLabel: SHORTCUT_LABEL,
      labels: { ...DESKTOP_LABELS },
      /** 自启动真实生效状态（系统可能拒绝写入，UI 需如实展示）。 */
      autostartEffective: bootDesktop.readLoginItemSettings().openAtLogin === true,
    };
  });

  ipc.handle('orchdesk:desktop-set', async (_e, key: unknown, value: unknown) => {
    const res = setDesktopKey(bootDesktop.desktopConfig, key, value);
    if (!res.ok || !res.key) return { ok: false, config: { ...bootDesktop.desktopConfig }, reason: res.reason };
    bootDesktop.setDesktopConfig(saveDesktopConfig(res.config, deps.dataDir()));
    // 只重放受影响的那一项：切换「自动更新」不该去动系统登录项。
    switch (res.key) {
      case 'tray': bootDesktop.applyTray(bootDesktop.desktopConfig.tray); break;
      case 'shortcut': bootDesktop.applyShortcut(bootDesktop.desktopConfig.shortcut); break;
      case 'autostart': {
        const r = bootDesktop.applyAutostart(bootDesktop.desktopConfig.autostart);
        if (!r.ok) return { ok: true, config: { ...bootDesktop.desktopConfig }, warning: `系统未接受自启动设置：${r.reason}` };
        break;
      }
      case 'autoupdate': if (bootDesktop.desktopConfig.autoupdate) bootDesktop.applyAutoUpdate(true); break;
      case 'floating': bootDesktop.applyFloating(bootDesktop.desktopConfig.floating); break;
      case 'notify': if (bootDesktop.desktopConfig.notify) bootDesktop.notifyDesktop('OrchDesk', '系统通知已开启'); break;
    }
    log('INFO', 'desktop', `桌面集成开关变更：${DESKTOP_LABELS[res.key]} → ${bootDesktop.desktopConfig[res.key] ? '开' : '关'}`);
    return {
      ok: true,
      config: { ...bootDesktop.desktopConfig },
      changed: res.changed,
      autostartEffective: bootDesktop.readLoginItemSettings().openAtLogin === true,
    };
  });

  /** 悬浮窗上下文：渲染层切换会话时推送（主进程不猜「当前会话」）。 */
  ipc.handle('orchdesk:desktop-floating-context', async (_e, ctx: { title?: string; sessions?: number }) => {
    const safeTitle = String(ctx?.title || '').trim().slice(0, 80);
    const safeSessions = Number.isFinite(ctx?.sessions) ? Math.max(0, Math.trunc(Number(ctx.sessions))) : 0;
    bootDesktop.setFloatingContext({ title: safeTitle, sessions: safeSessions });
    if (bootDesktop.floatingWindow && !bootDesktop.floatingWindow.isDestroyed()) bootDesktop.renderFloatingWindow();
    return { ok: true, context: { ...bootDesktop.floatingContext } };
  });
}
