/**
 * OrchDesk 桌面集成（PRD FR-4.2）
 * ----------------------------------------------------------------------------
 * 纯逻辑层：配置归一化 / 落盘 / 键位校验 / 悬浮窗内容生成。**零 electron 依赖**，
 * 可 node 直测（与 data-dir.ts、agent-runtime.ts 同一约定）。
 *
 * 所有 electron 副作用（Tray / globalShortcut / loginItem / autoUpdater /
 * BrowserWindow 悬浮窗 / Notification）一律留在 main.ts，本模块只管「数据形状」。
 * 这样 FR-4.2 的 6 个开关在 dsh-runtime-verify 里不需要 stub 任何 GUI 就能验证。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataDir } from './data-dir';

// ---------------------------------------------------------------------------
// 配置形状
// ---------------------------------------------------------------------------

export const DESKTOP_KEYS = ['tray', 'shortcut', 'autostart', 'autoupdate', 'floating', 'notify'] as const;

export type DesktopKey = (typeof DESKTOP_KEYS)[number];

export interface DesktopConfig {
  /** 系统托盘：关闭窗口后继续运行（托盘常驻）。 */
  tray: boolean;
  /** 全局快捷键：唤起 / 隐藏主窗。 */
  shortcut: boolean;
  /** 登录自启动：写入系统登录项。 */
  autostart: boolean;
  /** 自动更新：启动时后台检查更新（electron-updater）。 */
  autoupdate: boolean;
  /** 悬浮窗：桌面常驻小窗（无边框 + alwaysOnTop）。 */
  floating: boolean;
  /** 开机提醒：关键事件（启动完成 / 审批等待 / 更新可用）发系统通知。 */
  notify: boolean;
}

/** Electron accelerator 写法（跨平台：Win/Linux = Ctrl，macOS = Cmd）。 */
export const SHORTCUT_ACCELERATOR = 'CommandOrControl+Shift+Space';
/** 展示给用户的读法（渲染层与文档统一用这个）。 */
export const SHORTCUT_LABEL = 'Ctrl+Shift+Space';

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  tray: true,
  shortcut: true,
  // fail-safe 取向：默认不写系统登录项（改注册表/启动目录属边界外副作用），
  // 自动更新默认开（只做后台下载 + 退出时安装，不静默替换正在运行的实例）。
  autostart: false,
  autoupdate: true,
  floating: false,
  notify: true,
};

export const DESKTOP_LABELS: Record<DesktopKey, string> = {
  tray: '系统托盘',
  shortcut: '全局快捷键',
  autostart: '登录自启动',
  autoupdate: '自动更新',
  floating: '悬浮窗',
  notify: '开机提醒',
};

export function isDesktopKey(key: unknown): key is DesktopKey {
  return typeof key === 'string' && (DESKTOP_KEYS as readonly string[]).includes(key);
}

/**
 * 归一化配置：未知键丢弃，非布尔值按 truthy 转布尔（字符串 "false" 视为 false，
 * 避免 JSON 手改后把开关恒开——这是设置项最常见的静默失效来源）。
 */
export function normalizeDesktopConfig(raw: unknown): DesktopConfig {
  const out: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of DESKTOP_KEYS) {
    const v = src[key];
    if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.trim().toLowerCase() === 'true';
    else if (typeof v === 'number') out[key] = v !== 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 落盘（desktop.json，随数据目录迁移）
// ---------------------------------------------------------------------------

export const DESKTOP_FILE_NAME = 'desktop.json';

export function desktopConfigFile(dir?: string): string {
  // M3：统一走 getDataDir() 单源（不再回退 '.' 进程 cwd）。
  return path.join(dir || getDataDir(), DESKTOP_FILE_NAME);
}

export function loadDesktopConfig(dir?: string): DesktopConfig {
  try {
    const f = desktopConfigFile(dir);
    if (!fs.existsSync(f)) return { ...DEFAULT_DESKTOP_CONFIG };
    return normalizeDesktopConfig(JSON.parse(fs.readFileSync(f, 'utf-8')));
  } catch {
    return { ...DEFAULT_DESKTOP_CONFIG };
  }
}

export function saveDesktopConfig(config: DesktopConfig, dir?: string): DesktopConfig {
  const next = normalizeDesktopConfig(config);
  try {
    const f = desktopConfigFile(dir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    // 落盘失败不阻断 UI：内存态仍然生效（与 sandbox.json 同一 fail-soft 约定）
  }
  return next;
}

/**
 * 单键写入：拒绝未知键（拼写错误静默丢弃比拒绝更难查）。
 * @returns changed=false 表示值未变（调用方可跳过副作用重放）
 */
export function setDesktopKey(
  config: DesktopConfig,
  key: unknown,
  value: unknown,
): { ok: boolean; key?: DesktopKey; config: DesktopConfig; changed: boolean; reason?: string } {
  if (!isDesktopKey(key)) {
    return { ok: false, config: normalizeDesktopConfig(config), changed: false, reason: `未知的桌面集成配置项：${String(key)}` };
  }
  const next = String(value === true || value === 'true' || value === 1 || value === '1');
  const wanted = next === 'true';
  const merged: DesktopConfig = { ...normalizeDesktopConfig(config), [key]: wanted };
  return { ok: true, key, config: merged, changed: config[key] !== wanted };
}

// ---------------------------------------------------------------------------
// 悬浮窗内容（纯函数：便于断言「状态真的渲染进去了」而不是静态壳子）
// ---------------------------------------------------------------------------

export function floatingWindowHtml(opts: { title: string; subtitle: string; sessions: number }): string {
  const title = String(opts?.title || 'OrchDesk');
  const subtitle = String(opts?.subtitle || '');
  const sessions = Number.isFinite(opts?.sessions) ? Number(opts.sessions) : 0;
  // 交互说明：悬浮窗是沙箱化的 data: URL 渲染进程，页面脚本拿不到 require / ipcRenderer。
  // 因此「点击唤起主窗」由主进程监听 BrowserWindow 'focus' 事件实现，页面内不发 IPC。
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #1E1E1E; color: #E6E6E6; -webkit-app-region: drag; user-select: none; overflow: hidden; cursor: pointer; }
  .wrap { height: 100vh; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
  .t { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { font-size: 11px; color: #9A9A9A; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row { margin-top: auto; display: flex; align-items: center; }
  .hint { font-size: 10.5px; color: #6E6E6E; }
</style></head><body>
<div class="wrap">
  <div class="t">${escapeHtml(title)}</div>
  <div class="s">${escapeHtml(subtitle)}</div>
  <div class="row"><span class="hint">${sessions} 个会话 · 点击唤起主窗</span></div>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
