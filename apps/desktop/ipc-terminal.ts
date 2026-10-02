/**
 * 终端（PTY）面板 IPC。
 * 注册须在 main.ts patch ipcMain.handle 之后调用，才能走 sender 门。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcMain } from 'electron';
import { recordSandbox } from './ipc-sandbox';
import {
  createTerminal,
  ensurePtyLoaded,
  getTerminalState,
  killTerminal,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  writeTerminal,
} from './terminal-pty';

/** 终端应用目录：dev = apps/desktop，packaged = app.asar（asarUnpack 透明重定向）。 */
const TERMINAL_APP_DIR = path.resolve(__dirname, '..');

/** dsh 运行时自建的 profile node_modules（dev 环境常有 node-pty，作最后候选）。 */
function terminalExtraPtyDirs(): string[] {
  const cands = [
    path.join(TERMINAL_APP_DIR, '..', '.dsh-home', 'profiles', 'node_modules'),
    path.join(process.cwd(), '.dsh-home', 'profiles', 'node_modules'),
  ];
  return [...new Set(cands)];
}

export function preloadTerminalPty(): boolean {
  return ensurePtyLoaded(TERMINAL_APP_DIR, terminalExtraPtyDirs());
}

export function registerTerminalIpc(ipc: IpcMain, host: { notify: (channel: string, payload: unknown) => void }): void {
  onTerminalData((ev) => {
    host.notify('orchdesk:terminal-data', ev);
  });
  onTerminalExit((ev) => {
    host.notify('orchdesk:terminal-exit', ev);
  });

  ipc.handle('orchdesk:terminal-create', async (_e, input: unknown) => {
    const req = (input && typeof input === 'object' ? input : {}) as { cwd?: string; cols?: number | string; rows?: number | string };
    if (typeof req.cwd === 'string' && req.cwd.trim()) {
      let dirOk = false;
      try { dirOk = fs.statSync(req.cwd.trim()).isDirectory(); } catch { /* 不存在 */ }
      if (!dirOk) delete req.cwd;
    }
    const r = createTerminal(
      req,
      {
        appDir: TERMINAL_APP_DIR,
        extraPtyDirs: terminalExtraPtyDirs(),
        fallbackCwd: process.cwd(),
      },
    );
    // BUG-067：渲染层可达的「任意 shell」能力必须可追溯——PTY 没有门，留痕是唯一证据。
    // 用处理器自己算出的生效目录（无效 req.cwd 在上面已被删除并回落到宿主 cwd），这样 target 与真正落地的 shell 目录一致，也不依赖 CreateTerminalResult 的可选字段。顺带记一条契约漂移：类型里查无 `session`，而实现返回的对象带着 `session.{id,pid,via,cwd}` 且被用例读着——runtime 有、类型上没有，等于这层的形状没被编译期看住。
    const cwd = String(req.cwd || process.cwd());
    if (r.ok) {
      recordSandbox({ tool: 'terminal.create', kind: 'command', target: cwd, decision: 'allowed', reason: '渲染层发起的 PTY 创建（任意 shell 能力）' });
    } else {
      recordSandbox({ tool: 'terminal.create', kind: 'command', target: cwd, decision: 'error', reason: String(r.reason || 'PTY 创建失败') });
    }
    return r;
  });

  ipc.handle('orchdesk:terminal-write', async (_e, id: unknown, data: unknown) => {
    if (typeof id !== 'string' || typeof data !== 'string') {
      return { ok: false, reason: '参数不合法' };
    }
    return { ok: writeTerminal(id, data) };
  });

  ipc.handle('orchdesk:terminal-resize', async (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id !== 'string') return { ok: false, reason: '参数不合法' };
    return { ok: resizeTerminal(id, cols, rows) };
  });

  ipc.handle('orchdesk:terminal-kill', async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, reason: '参数不合法' };
    return { ok: killTerminal(id) };
  });

  ipc.handle('orchdesk:terminal-status', async () => getTerminalState());
}
