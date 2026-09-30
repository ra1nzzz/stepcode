/**
 * 终端（PTY）—— 纯逻辑层（零 electron 依赖，可 node 直测）
 * ----------------------------------------------------------------------------
 * 产品定位（Minke 对照 P2）：给用户一个看得见 Agent 在干什么的交互式终端 Tab，
 * 也让「长驻进程 / REPL」类任务有落点。宿主侧实现见 terminal-pty.ts，本文件只
 * 负责「与运行环境无关」的部分：
 *
 *   1. 会话参数归一化（cols / rows / cwd 形状校验、钳制）
 *   2. 环境变量净化（继承 WorkBuddy/宿主环境时会带进致命的 shim 变量）
 *   3. node-pty 加载候选路径（packaged 与 dev 同一策略：显式 env > app vendor
 *      > dsh profile > 降级管道模式），降级必须可见（via: 'pty' | 'pipe'）
 *   4. 数据流限速缓冲参数（渲染层 xterm 消化不了洪峰时的主进程侧节流）
 *
 * 安全口径：终端是「用户亲手操作」的入口，不走 Agent 授权门（与浏览器工具
 * 相反——浏览器是 Agent 越权访问外部世界，终端是用户自己敲命令）。
 * 但环境净化仍然必须：宿主继承的 NODE_OPTIONS 会劫持任何子进程里的 node。
 */

import { clampInt, isAbsoluteLike } from './common-tools';

// ---------------------------------------------------------------------------
// 常量与钳制
// ---------------------------------------------------------------------------

/** 终端列数钳制。 */
export const TERMINAL_COLS_MIN = 10;
export const TERMINAL_COLS_MAX = 500;
export const TERMINAL_COLS_DEFAULT = 80;

/** 终端行数钳制。 */
export const TERMINAL_ROWS_MIN = 2;
export const TERMINAL_ROWS_MAX = 300;
export const TERMINAL_ROWS_DEFAULT = 24;

/**
 * 会话上限：终端是长驻资源（每个会话一个 OS 进程），不设上限会被
 * 「反复开 Tab」耗光句柄。达到上限时 createTerminal 返回明确错误。
 */
export const TERMINAL_MAX_SESSIONS = 6;

/**
 * 数据推送节流窗口（ms）：PTY 洪峰（如 cat 大文件）会以数万行/秒的速度
 * 产生 onData，逐条 IPC 会把渲染层打挂。主进程按窗口攒批推送。
 */
export const TERMINAL_FLUSH_MS = 16;

/** 单次推送字节上限：超出截断并标记（防单条 IPC 撑爆结构化克隆）。 */
export const TERMINAL_CHUNK_MAX = 256 * 1024;

/** 单会话回放缓冲上限（新接入的观察者能补看的历史行）。 */
export const TERMINAL_REPLAY_MAX = 64 * 1024;

/** 环境净化清单：这些变量会改变子进程 node 行为或把宿主调试态泄进终端。 */
export const TERMINAL_ENV_STRIP = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ORCHDESK_PTY_MODULE',
  'ORCHDESK_BROWSER_NO_SANDBOX',
  'ORCHDESK_SMOKE_CI',
  'PORT',
];

// ---------------------------------------------------------------------------
// 参数归一化
// ---------------------------------------------------------------------------

export type TerminalCreateArgs = {
  cwd?: string;
  cols?: number | string;
  rows?: number | string;
};

export type NormalizedTerminalCreate = {
  ok: true;
  cwd: string;
  cols: number;
  rows: number;
};

export type RejectedTerminalCreate = { ok: false; reason: string };

/**
 * 归一化 createTerminal 参数。
 * 注意 `''` 与 undefined 都走默认值——`Number('') === 0` 的坑在浏览器工具
 * 超时钳制上踩过一次（CHECKPOINT ⑦），这里从入口就挡掉。
 */
export function normalizeTerminalCreate(
  input: TerminalCreateArgs | undefined,
  fallbackCwd: string,
): NormalizedTerminalCreate | RejectedTerminalCreate {
  const src = input && typeof input === 'object' ? input : {};
  const cwdRaw = typeof src.cwd === 'string' ? src.cwd.trim() : '';
  const cwd = cwdRaw !== '' ? cwdRaw : fallbackCwd;
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { ok: false, reason: '缺少 cwd（未提供且宿主无默认目录）' };
  }
  if (cwd.length > 1024) {
    return { ok: false, reason: 'cwd 过长（>1024 字符）' };
  }
  // 形状校验：必须像绝对路径。真正的存在性检查由宿主做（纯逻辑不碰 fs）。
  if (!isAbsoluteLike(cwd)) {
    return { ok: false, reason: 'cwd 必须是绝对路径：' + cwd.slice(0, 80) };
  }
  return {
    ok: true,
    cwd,
    cols: clampInt(src.cols, TERMINAL_COLS_MIN, TERMINAL_COLS_MAX, TERMINAL_COLS_DEFAULT),
    rows: clampInt(src.rows, TERMINAL_ROWS_MIN, TERMINAL_ROWS_MAX, TERMINAL_ROWS_DEFAULT),
  };
}

// ---------------------------------------------------------------------------
// 环境净化
// ---------------------------------------------------------------------------

/** 返回净化后的环境副本（不改原对象）；命中清单的 key 一律剔除。 */
export function sanitizeTerminalEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (TERMINAL_ENV_STRIP.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// node-pty 加载候选（降级可见）
// ---------------------------------------------------------------------------

export type PtyMode = 'pty' | 'pipe';

/**
 * 优先级顺序的 node-pty require 候选：
 *   1. ORCHDESK_PTY_MODULE —— 显式覆盖（调试 / 用户自备构建）
 *   2. <appDir>/vendor/node-pty —— vendor-dsh.cjs 物化（dev 与 packaged 同路径）
 *   3. <appDir>/node_modules/node-pty —— 用户手动安装
 *   4. <candidates> —— dsh 运行时自建的 profile node_modules（dev 环境常有）
 * 全部落空 → 宿主降级 child_process 管道模式，且结果必须带 via='pipe'。
 */
export function ptyRequireCandidates(
  appDir: string,
  extraDirs: string[] = [],
): string[] {
  const envOverride =
    typeof process !== 'undefined' && process.env && process.env.ORCHDESK_PTY_MODULE
      ? String(process.env.ORCHDESK_PTY_MODULE ?? '').trim()
      : '';
  const list = [
    envOverride,
    joinPath(appDir, 'vendor', 'node-pty'),
    joinPath(appDir, 'node_modules', 'node-pty'),
    ...extraDirs.map((d) => joinPath(d, 'node-pty')),
  ];
  return list.filter((p) => p !== '');
}

/** POSIX 风格 path.join（纯逻辑不依赖 node:path，避免打包差异）。 */
export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\\/g, '/');
  // 折叠 a/b/../c 与 //（保留开头的协议或盘符）
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' && out.length > 0) continue;
    if (seg === '.' ) continue;
    const last = out.length > 0 ? out[out.length - 1] ?? '' : '';
    if (seg === '..') {
      if (/^[a-zA-Z]:$/.test(last)) continue; // 盘符根不允许被 .. 顶掉
      if (last !== '' && last !== '..') {
        out.pop();
        continue;
      }
    }
    out.push(seg);
  }
  return out.join('/') || '/';
}

// ---------------------------------------------------------------------------
// 状态描述
// ---------------------------------------------------------------------------

export type TerminalSessionInfo = {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
  via: PtyMode;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
};

/**
 * 组装渲染层终端面板的状态快照。
 * 「未接入 vs 为空」铁律：ptyAvailable=false 时渲染层显示「管道模式」而不是
 * 假装一切正常；sessions 为空数组就是「没有打开的终端」。
 */
export function describeTerminalState(
  sessions: TerminalSessionInfo[],
  ptyAvailable: boolean,
): {
  ptyAvailable: boolean;
  via: PtyMode;
  count: number;
  sessions: TerminalSessionInfo[];
} {
  return {
    ptyAvailable,
    via: ptyAvailable ? 'pty' : 'pipe',
    count: sessions.length,
    sessions,
  };
}
