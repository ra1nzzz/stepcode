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
/** 快照保留份数。此前一次都不删，而且过去的复制根本没成功过（见 snapshotData）。 */
const SNAPSHOT_KEEP = 3;

function snapshotData(deps: DataOpsIpcDeps): { ok: boolean; dir?: string; reason?: string } {
  try {
    const root = deps.dataDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const snapshotsDir = path.join(root, 'snapshots');
    const snapDir = path.join(snapshotsDir, stamp);
    fs.mkdirSync(snapDir, { recursive: true });
    // 不能用 fs.cpSync(root, snapDir)：目标就在源里面，Node 直接抛
    // 「Cannot copy ... to a subdirectory of self」，filter 挡不住这个前置判断。
    // 过去没有用例碰过这里，于是「更新前自动备份」每次启动都静默失败。
    copyTree(root, snapDir, snapshotsDir);
    pruneSnapshots(snapshotsDir);
    return { ok: true, dir: snapDir };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 逐条递归复制，跳过快照目录自身；符号链接不跟随（防环）。 */
function copyTree(src: string, dst: string, skip: string): void {
  const resolvedSkip = path.resolve(skip);
  const walk = (from: string, to: string): void => {
    for (const name of fs.readdirSync(from)) {
      const fromPath = path.join(from, name);
      const toPath = path.join(to, name);
      if (path.resolve(fromPath) === resolvedSkip) continue;
      const st = fs.lstatSync(fromPath);
      if (st.isDirectory()) {
        fs.mkdirSync(toPath, { recursive: true });
        walk(fromPath, toPath);
      } else if (st.isFile()) {
        fs.copyFileSync(fromPath, toPath);
      }
    }
  };
  fs.mkdirSync(dst, { recursive: true });
  walk(src, dst);
}

/**
 * 目录名是 ISO 戳（`2026-10-01T07-00-00`），字典序即时间序，所以按名字排序就够，
 * 不必读 mtime（复制会把 mtime 带成源文件的时刻，不可信）。
 * 删除失败不影响本次快照已经成立。
 */
function pruneSnapshots(snapshotsDir: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return 0;
  }
  const stale = entries.sort().reverse().slice(SNAPSHOT_KEEP);
  for (const name of stale) {
    try {
      fs.rmSync(path.join(snapshotsDir, name), { recursive: true, force: true });
    } catch { /* 删不掉就留给下一次，不能因此把快照报成失败 */ }
  }
  return stale.length;
}

/** 更新前必须完成数据快照（PLAN 红线：不要更新后补）。 */
export async function checkForUpdates(deps: DataOpsIpcDeps): Promise<{ snapshot: { ok: boolean; dir?: string }; update?: { available: boolean; version?: string; note?: string }; reason?: string }> {
  const snapshot = snapshotData(deps);
  // 自动更新通道未启用：本仓库没有发布通道（docs/50-发布/发布状态.md）。
  // 这里原先指向 ra1nzzz/orchdesk 的 GitHub release，并开着 autoDownload +
  // autoInstallOnAppQuit —— 打包后会下载并安装另一个产品的二进制。
  // 要重新启用，先按 SPEC「本阶段不写：发布通道」记一条 ADR，再把 feed 指向本仓库。
  return { snapshot, update: { available: false, note: '本仓库无发布通道，自动更新未启用' } };
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
