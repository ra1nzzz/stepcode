/**
 * 终端宿主层 —— PTY 会话管理（只依赖 node 内置模块，不依赖 electron）
 * ----------------------------------------------------------------------------
 * 与 browser-cdp.ts 同一分层：main.ts 只做 IPC 接线，本文件管全部终端状态。
 * 能力来源（吸收计划 P2-10，Minke 借鉴）：
 *
 *   1. 正路：node-pty（ConPTY）——按 terminal-tools.ptyRequireCandidates 的
 *      优先级加载；1.2.0-beta 的 win32-x64 预编译走 N-API，Electron / Node 通用。
 *   2. 降级：全部候选加载失败 → child_process 管道模式（无 TTY 语义，交互式
 *      程序受限），**via='pipe' 必须如实上报**，不许冒充 PTY。
 *
 * 数据流：onData 洪峰在主进程按 TERMINAL_FLUSH_MS 攒批 + 单条
 * TERMINAL_CHUNK_MAX 截断，防止一条 IPC 拖垮渲染层；新接入的观察者可补读
 * 最近 TERMINAL_REPLAY_MAX 的回放缓冲。
 */

import { spawn as cpSpawn, type ChildProcess } from 'child_process';
import { clampInt } from './common-tools';
import {
  TERMINAL_CHUNK_MAX,
  TERMINAL_COLS_DEFAULT,
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_FLUSH_MS,
  TERMINAL_MAX_SESSIONS,
  TERMINAL_REPLAY_MAX,
  TERMINAL_ROWS_DEFAULT,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
  describeTerminalState,
  normalizeTerminalCreate,
  ptyRequireCandidates,
  sanitizeTerminalEnv,
  type PtyMode,
  type TerminalSessionInfo,
} from './terminal-tools';

// ---------------------------------------------------------------------------
// node-pty 加载（缓存 + 失败不再重试，避免每次 create 都走一遍候选）
// ---------------------------------------------------------------------------

type PtySpawn = ((
  file: string,
  args: string[],
  opts: Record<string, unknown>,
) => {
  pid: number;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  kill: () => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
});

let ptyCache: PtySpawn | null | undefined;

function loadPty(appDir: string, extraDirs: string[]): PtySpawn | null {
  if (ptyCache !== undefined) return ptyCache;
  // 摘掉 NODE_OPTIONS：require 原生模块本身也可能被 shim 劫持（用户环境教训）。
  for (const cand of ptyRequireCandidates(appDir, extraDirs)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(cand) as { spawn?: PtySpawn };
      if (mod && typeof mod.spawn === 'function') {
        ptyCache = mod.spawn;
        return ptyCache;
      }
    } catch {
      /* 下一个候选 */
    }
  }
  ptyCache = null;
  return null;
}

/** 测试注入口：verify 套件用它整体替换 pty.spawn。 */
export function setPtyForTest(spawn: PtySpawn | null): void {
  ptyCache = spawn;
}

/**
 * 启动期探测：main 进程 ready 后调用一次，让 getTerminalState 的
 * ptyAvailable 从一开始就是确定值（而不是「还没探测」的 undefined）。
 */
export function ensurePtyLoaded(appDir: string, extraDirs: string[] = []): boolean {
  return loadPty(appDir, extraDirs) !== null;
}

function pickShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

// ---------------------------------------------------------------------------
// 会话模型
// ---------------------------------------------------------------------------

type Session = TerminalSessionInfo & {
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  kill: () => void;
};

const sessions = new Map<string, Session>();
let seq = 0;

let dataListener: ((ev: { id: string; data: string }) => void) | null = null;
let exitListener: ((ev: { id: string; code: number }) => void) | null = null;

/** 注册数据/退出推送回调（main.ts 用它把事件转发给渲染层）。 */
export function onTerminalData(
  cb: (ev: { id: string; data: string }) => void,
): () => void {
  dataListener = cb;
  return () => {
    if (dataListener === cb) dataListener = null;
  };
}

export function onTerminalExit(
  cb: (ev: { id: string; code: number }) => void,
): () => void {
  exitListener = cb;
  return () => {
    if (exitListener === cb) exitListener = null;
  };
}

// ---------------------------------------------------------------------------
// 攒批推送（洪峰节流）
// ---------------------------------------------------------------------------

type PendingFlush = { timer: ReturnType<typeof setTimeout> | null; buf: string; truncated: boolean };

const pending = new Map<string, PendingFlush>();

/** 回放缓冲：新接入的观察者（或重开的 Tab）能补看最近的历史输出。 */
const replayBuf = new Map<string, string>();

function pushData(id: string, chunk: string): void {
  const replay = (replayBuf.get(id) || '') + chunk;
  replayBuf.set(id, replay.length > TERMINAL_REPLAY_MAX ? replay.slice(-TERMINAL_REPLAY_MAX) : replay);
  let p = pending.get(id);
  if (!p) {
    p = { timer: null, buf: '', truncated: false };
    pending.set(id, p);
  }
  if (p.buf.length + chunk.length > TERMINAL_CHUNK_MAX) {
    // 超限截断：留 1/4 余量接后续，并打截断标记（可见，不静默丢）。
    // 两处 slice 缺一不可：先截 chunk（单块本身就可能超过上限），再对拼接
    // 结果封顶——否则「64KB 尾巴 + 1MB chunk」会绕过上限直接推给渲染层。
    const keep = Math.floor(TERMINAL_CHUNK_MAX / 4);
    const head = p.buf.slice(-keep);
    p.buf = (head + chunk).slice(-TERMINAL_CHUNK_MAX);
    p.truncated = true;
  } else {
    p.buf += chunk;
  }
  if (p.timer) return;
  p.timer = setTimeout(() => {
    const cur = pending.get(id);
    pending.delete(id);
    if (!cur || cur.buf === '') return;
    const out = cur.truncated ? '…[orchdesk: 数据洪峰已截断]…\r\n' + cur.buf : cur.buf;
    try {
      dataListener && dataListener({ id, data: out });
    } catch { /* 渲染层不在了，回放缓冲仍保留 */ }
  }, TERMINAL_FLUSH_MS);
}

function pushExit(id: string, code: number): void {
  const p = pending.get(id);
  if (p) {
    if (p.timer) clearTimeout(p.timer);
    if (p.buf !== '') {
      // 冲刷时保留 truncated 标记：退出前的最后一批若是被截断过的，渲染层
      // 必须看得见「中间丢过数据」，否则「跑完了但输出不全」会被当成完整结果。
      const out = p.truncated ? '…[orchdesk: 数据洪峰已截断]…\r\n' + p.buf : p.buf;
      try { dataListener && dataListener({ id, data: out }); } catch { /* 同上 */ }
    }
    pending.delete(id);
  }
  // 会话已结束：回放缓冲是给「重开 Tab 补看」用的，进程都没了就没有保留价值，
  // 不清会在反复开关终端时按 64KB/会话 常驻（实测 1000 会话 +115MB）。
  replayBuf.delete(id);
  try { exitListener && exitListener({ id, code }); } catch { /* 推送失败不影响状态 */ }
}

// ---------------------------------------------------------------------------
// 创建 / 写 / 缩放 / 关闭
// ---------------------------------------------------------------------------

export type CreateTerminalInput = {
  cwd?: string;
  cols?: number | string;
  rows?: number | string;
};

export type CreateTerminalOptions = {
  appDir: string;
  extraPtyDirs?: string[];
  fallbackCwd: string;
  env?: Record<string, string | undefined>;
};

export type CreateTerminalResult =
  | { ok: true; session: TerminalSessionInfo }
  | { ok: false; reason: string };

export function createTerminal(
  input: CreateTerminalInput | undefined,
  opts: CreateTerminalOptions,
): CreateTerminalResult {
  const norm = normalizeTerminalCreate(input, opts.fallbackCwd);
  if (!norm.ok) return norm;

  // 上限只统计「活着」的会话：已退出的会话只是留着给用户看最后一眼输出，
  // 不该占名额——否则连开 6 个短命令后就再也开不了新终端（只有手动关 Tab
  // 才释放）。顺带回收已退出条目，避免 sessions 无限增长。
  const activeCount = () => [...sessions.values()].filter((s) => !s.exited).length;
  if (activeCount() >= TERMINAL_MAX_SESSIONS) {
    for (const s of [...sessions.values()]) {
      if (s.exited) killTerminal(s.id);
    }
    if (activeCount() >= TERMINAL_MAX_SESSIONS) {
      return {
        ok: false,
        reason: `终端会话已达上限（${TERMINAL_MAX_SESSIONS}），请先关闭不用的 Tab`,
      };
    }
  }

  const env = sanitizeTerminalEnv(opts.env || process.env);
  // 删掉父进程继承的 PORT 等歧义变量之后，显式声明终端是 UTF-8。
  env['LANG'] = env['LANG'] || 'zh_CN.UTF-8';

  const cols = norm.cols;
  const rows = norm.rows;
  const shell = pickShell();
  const id = `t${++seq}-${Date.now().toString(36)}`;
  const ptySpawn = loadPty(opts.appDir, opts.extraPtyDirs || []);

  let session: Session;

  if (ptySpawn) {
    try {
      const p = ptySpawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: norm.cwd,
        env,
      });
      session = {
        id,
        pid: p.pid,
        shell,
        cwd: norm.cwd,
        via: 'pty',
        createdAt: Date.now(),
        exited: false,
        write: (d) => {
          try { p.write(d); } catch { /* 进程已退出 */ }
        },
        resize: (c, r) => {
          try { p.resize(c, r); } catch { /* 进程已退出 */ }
        },
        kill: () => {
          try { p.kill(); } catch { /* 幂等 */ }
        },
      };
      p.onData((d) => pushData(id, d));
      p.onExit((e) => {
        session.exited = true;
        session.exitCode = e.exitCode;
        pushExit(id, e.exitCode);
      });
    } catch (err) {
      return { ok: false, reason: 'PTY 启动失败：' + (err as Error).message };
    }
  } else {
    // ---- 显式降级：管道模式（无 TTY；交互式程序受限，但命令执行/输出可见）----
    let child: ChildProcess;
    try {
      child = cpSpawn(shell, [], {
        cwd: norm.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      return { ok: false, reason: '终端启动失败（管道降级）：' + (err as Error).message };
    }
    session = {
      id,
      pid: child.pid || 0,
      shell,
      cwd: norm.cwd,
      via: 'pipe',
      createdAt: Date.now(),
      exited: false,
      write: (d) => {
        try {
          child.stdin && child.stdin.write(d);
        } catch { /* 进程已退出 */ }
      },
      resize: () => { /* 管道模式无 TTY 尺寸语义 */ },
      kill: () => {
        try { child.kill(); } catch { /* 幂等 */ }
      },
    };
    const pipeChunk = (d: unknown) => {
      if (d) pushData(id, String(d));
    };
    child.stdout && child.stdout.on('data', pipeChunk);
    child.stderr && child.stderr.on('data', pipeChunk);
    // stdin 必须有 error 监听：进程退出后渲染层仍在敲键会触发 EPIPE，
    // 没有监听就是主进程 uncaughtException（整个应用跟着一起崩）。
    if (child.stdin) {
      child.stdin.on('error', () => { /* 进程已退出，忽略写入失败 */ });
    }
    child.on('exit', (code) => {
      session.exited = true;
      session.exitCode = code === null ? -1 : code;
      pushExit(id, session.exitCode);
    });
    child.on('error', (err) => {
      pushData(id, `\r\n[orchdesk: 终端进程错误：${err.message}]\r\n`);
    });
  }

  sessions.set(id, session);
  const info: TerminalSessionInfo = {
    id: session.id, pid: session.pid, shell: session.shell, cwd: session.cwd,
    via: session.via, createdAt: session.createdAt, exited: session.exited,
  };
  return { ok: true, session: info };
}

/** 向会话写输入（键盘敲入）。未知 id 返回 false（渲染层应刷新状态）。 */
export function writeTerminal(id: string, data: string): boolean {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  s.write(String(data).slice(0, TERMINAL_CHUNK_MAX));
  return true;
}

/** 调整尺寸（管道模式是 no-op，不报错）。 */
export function resizeTerminal(id: string, cols: unknown, rows: unknown): boolean {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  const c = clampInt(cols, TERMINAL_COLS_MIN, TERMINAL_COLS_MAX, TERMINAL_COLS_DEFAULT);
  const r = clampInt(rows, TERMINAL_ROWS_MIN, TERMINAL_ROWS_MAX, TERMINAL_ROWS_DEFAULT);
  s.resize(c, r);
  return true;
}

/** 关闭会话（幂等；已退出也清理条目）。 */
export function killTerminal(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  try { s.kill(); } catch { /* 幂等 */ }
  const p = pending.get(id);
  if (p && p.timer) clearTimeout(p.timer);
  pending.delete(id);
  replayBuf.delete(id);
  sessions.delete(id);
  return true;
}

/** 全量状态（渲染层 Tab 栏渲染数据源；含回放缓冲）。 */
export function getTerminalState(): {
  ptyAvailable: boolean;
  via: PtyMode;
  count: number;
  sessions: Array<TerminalSessionInfo & { replay: string }>;
} {
  const list = [...sessions.values()].map((s) => ({
    id: s.id,
    pid: s.pid,
    shell: s.shell,
    cwd: s.cwd,
    via: s.via,
    createdAt: s.createdAt,
    exited: s.exited,
    exitCode: s.exitCode,
    replay: replayBuf.get(s.id) || '',
  }));
  // 注意 `!!ptyCache` 而不是 `ptyCache !== null`：ptyCache 有三态——
  // undefined（尚未探测，如 ensurePtyLoaded 抛错被吞）、null（探测过，不可用）、
  // 函数（可用）。`undefined !== null` 为真，写成不等号会让「未探测」冒充
  // 「可用」，恰好和 via='pipe' 自相矛盾（降级必须可见，不许自相矛盾）。
  const base = describeTerminalState(list, !!ptyCache);
  return { ...base, sessions: list };
}
