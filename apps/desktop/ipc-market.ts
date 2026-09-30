/**
 * 本地插件市场 IPC（PRD FR-3）。
 * 扫描 / 装载 / 启停在 dsh-runtime.ts；目录名与 enabled 表校验在 plugin-market.ts（纯逻辑）。
 * 本模块管启用意愿的文件读写，以及 IPC 挂载。
 * 注册须在 main.ts patch ipcMain.handle 之后调用，才能走 sender 门。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcMain } from 'electron';
import { shell } from 'electron';
import { DATA_FILE_NAMES } from './data-dir';
import { marketDir, DSH_UNLOAD_REASON } from './dsh-runtime';
import { log } from './logger';
import { normalizeEnabledMap } from './plugin-market';

export type MarketIpcHost = {
  dataDir: () => string;
};

let host: MarketIpcHost | undefined;
let marketEnabledMap: Record<string, boolean> = {};

export function initMarket(deps: MarketIpcHost): void {
  host = deps;
}

function requireHost(): MarketIpcHost {
  if (!host) throw new Error('initMarket 未调用');
  return host;
}

function marketStateFile(): string {
  return path.join(requireHost().dataDir(), DATA_FILE_NAMES.market);
}

/**
 * 直接读文件（不碰模块变量）。
 * bootRuntime 早于启动序列里的状态装载，用模块变量会拿到空表。
 */
export function loadMarketEnabled(): Record<string, boolean> {
  try {
    const raw = JSON.parse(fs.readFileSync(marketStateFile(), 'utf-8'));
    return normalizeEnabledMap(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).enabled : null);
  } catch {
    return {};
  }
}

/** 启动序列：把磁盘上的启用意愿灌进内存表（IPC 列表读的就是这份）。 */
export function hydrateMarketEnabled(): Record<string, boolean> {
  marketEnabledMap = loadMarketEnabled();
  return marketEnabledMap;
}

/** 写穿：启停是用户的授权决定，「重启后丢了」比落盘失败严重得多。 */
function persistMarketEnabled(): void {
  try {
    fs.mkdirSync(path.dirname(marketStateFile()), { recursive: true });
    fs.writeFileSync(marketStateFile(), JSON.stringify({ enabled: marketEnabledMap }, null, 2), 'utf-8');
  } catch (err) {
    log('WARN', 'market', `插件市场状态落盘失败: ${(err as Error).message}`);
  }
}

export function registerMarketIpc(ipc: IpcMain): void {
  ipc.handle('orchdesk:market-plugins', async () => {
    return { unavailable: true, reason: DSH_UNLOAD_REASON, items: [], dir: '', count: 0 };
  });

  ipc.handle('orchdesk:market-toggle', async (_e, dir: unknown, enabled: unknown) => {
    if (typeof dir !== 'string' || typeof enabled !== 'boolean') {
      return { ok: false, reason: '参数非法' };
    }
    return { ok: false, unavailable: true, reason: DSH_UNLOAD_REASON };
  });

  ipc.handle('orchdesk:market-open-dir', async () => {
    const dir = marketDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      return err ? { ok: false, reason: err } : { ok: true, dir };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  });
}
