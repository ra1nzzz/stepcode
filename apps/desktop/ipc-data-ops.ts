/**
 * 数据运维 IPC（T-P6-3）：数据快照 / 更新检查 / 打开项目目录 / 打开日志目录。
 * 从 main.ts 抽出（M2 组合根分离第二轮）。依赖经 registerDataOpsIpc 注入
 * （dataDir / logFilePath 是 main.ts 的模块级函数，快照会拿到过时引用）。
 */
import type { IpcMain } from 'electron';
import { app, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DataOpsIpcDeps {
  dataDir: () => string;
  logFilePath: () => string | null;
}

/** 数据目录快照（排除 snapshots 自身，防递归）。 */
function snapshotData(deps: DataOpsIpcDeps): { ok: boolean; dir?: string; reason?: string } {
  try {
    const root = deps.dataDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const snapshotsDir = path.join(root, 'snapshots');
    const snapDir = path.join(snapshotsDir, stamp);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.cpSync(root, snapDir, { recursive: true, filter: (src) => src === root || !src.startsWith(snapshotsDir) });
    return { ok: true, dir: snapDir };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 更新前必须完成数据快照（PLAN 红线：不要更新后补）。 */
export async function checkForUpdates(deps: DataOpsIpcDeps): Promise<{ snapshot: { ok: boolean; dir?: string }; update?: { available: boolean; version?: string; note?: string }; reason?: string }> {
  const snapshot = snapshotData(deps);
  try {
    const { autoUpdater } = await import('electron-updater');
    // 仅在生产包（asar）中启用自动更新，开发模式跳过
    if (!app.isPackaged) {
      return { snapshot, update: { available: false, note: '开发模式，跳过自动更新检查' } };
    }
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'ra1nzzz',
      repo: 'orchdesk',
    });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const res = await autoUpdater.checkForUpdates();
    return {
      snapshot,
      update: {
        available: !!res?.updateInfo?.version,
        version: res?.updateInfo?.version,
        note: res?.updateInfo?.version
          ? `发现新版本 ${res.updateInfo.version}，正在后台下载…`
          : '已是最新',
      },
    };
  } catch (err) {
    return { snapshot, reason: `更新检查异常：${(err as Error).message}` };
  }
}

export function registerDataOpsIpc(ipc: IpcMain, deps: DataOpsIpcDeps): void {
  ipc.handle('orchdesk:snapshot-data', async () => snapshotData(deps));
  ipc.handle('orchdesk:check-updates', async () => checkForUpdates(deps));

  /**
   * 打开项目绑定的本地文件夹（项目 `··` 菜单）或数据目录（设置页）。
   * 传 `boundPath` → 打开该项目绑定的目录；不传 → 打开数据目录（语义由调用方决定）。
   *
   * BUG-022：此前恒打开 `dataDir()`，**绑定的项目目录形同虚设**——而创建项目弹窗还写着
   * 「绑定后可通过『打开项目目录』快速访问」，等于用假承诺糊住一个死挂点。
   *
   * 关键口径：绑定路径不存在 / 不是目录时**明确报错**，绝不静默回退数据目录。
   * 静默回退会让用户以为打开的是项目目录，与「降级必须可见」冲突，且掩盖数据错配。
   */
  ipc.handle('orchdesk:open-project-dir', async (_e, boundPath?: string) => {
    const raw = typeof boundPath === 'string' ? boundPath.trim() : '';
    const source: 'bound' | 'data' = raw ? 'bound' : 'data';
    try {
      const target = raw ? path.resolve(raw) : deps.dataDir();
      if (source === 'bound') {
        // 目录可能已被删/移动过：渲染层只知道「当初绑的是什么」，真实性由主进程兜底
        const st = fs.statSync(target);
        if (!st.isDirectory()) return { ok: false, source, reason: `绑定的路径不是文件夹：${target}` };
      }
      const openErr = await shell.openPath(target); // 成功返回 ''，失败返回错误描述（旧代码忽略了它 → 失败也报 ok）
      if (openErr) return { ok: false, source, reason: openErr };
      return { ok: true, source, path: target };
    } catch (err) {
      return {
        ok: false,
        source,
        reason: source === 'bound' ? `绑定的目录不可访问：${(err as Error).message}` : (err as Error).message,
      };
    }
  });

  /** 打开日志目录（诊断模型调用 / 插件加载问题）。 */
  ipc.handle('orchdesk:open-log-dir', async () => {
    try {
      const dir = path.join(deps.dataDir(), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const openErr = await shell.openPath(dir); // 与 BUG-022 同款：成功返回 ''，忽略返回值会让失败也报 ok
      if (openErr) return { ok: false, reason: openErr };
      return { ok: true, file: deps.logFilePath() ?? undefined };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });
}
