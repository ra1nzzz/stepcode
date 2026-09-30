/**
 * OrchDesk 主进程日志（零依赖，写文件 + 控制台镜像）
 * ----------------------------------------------------------------------------
 * 问题：打包版里 console.log 全部进虚空 —— 模型调用失败、插件加载异常都无从诊断。
 * 方案：
 *   - initLogger(dataDir)：日志落 `<dataDir>/logs/main-YYYYMMDD.log`，按天滚动，
 *     单文件超 2MB 截断重开；保留最近 7 天，启动时清理更早的。
 *   - mirrorConsole()：把主进程 console.log/warn/error 全量镜像进日志
 *     （含插件与依赖库的输出），error 级别附时间戳前缀。
 *   - logModel()：模型调用专用结构化埋点（url/status/耗时/正文长度，绝不记密钥）。
 * 红线：任何 API Key / token 不得进入日志；写入失败静默（日志不可拖垮主进程）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

let logDir: string | null = null;
let mirroring = false;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEEP_DAYS = 7;

/** 初始化：确定日志目录并清理过期文件。 */
export function initLogger(dataDir: string): void {
  try {
    logDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    // 清理 KEEP_DAYS 天前的旧日志（尽力而为）
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      const m = /^main-(\d{4})(\d{2})(\d{2})\.log$/.exec(f);
      if (!m) continue;
      const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (t < cutoff) { try { fs.rmSync(path.join(logDir, f), { force: true }); } catch { /* 尽力 */ } }
    }
  } catch { logDir = null; }
}

function dayStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function timeStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 当前日志文件路径（未初始化时返回 null）。 */
export function logFilePath(): string | null {
  return logDir ? path.join(logDir, `main-${dayStamp()}.log`) : null;
}

/** 追加一条日志（自动按天滚动 + 单文件超限重开）。 */
export function log(level: LogLevel, tag: string, message: string): void {
  const line = `[${dayStamp()} ${timeStamp()}] [${level}] [${tag}] ${message}\n`;
  // 控制台始终输出（开发模式可见）
  const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  fn(line.trimEnd());
  if (!logDir) return;
  try {
    const file = logFilePath()!;
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) {
      // 超限：重命名留档，本次重开新文件
      try { fs.rmSync(file, { force: true }); } catch { /* 尽力 */ }
    }
    fs.appendFileSync(file, line, 'utf-8');
  } catch { /* 日志写入失败不拖垮主进程 */ }
}

/** 把 console.log/warn/error 镜像进日志文件（幂等，只装一次）。 */
export function mirrorConsole(): void {
  if (mirroring) return;
  mirroring = true;
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const fmt = (args: unknown[]): string =>
    args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
  const write = (level: LogLevel, args: unknown[]): void => {
    const line = fmt(args);
    if (!logDir) { orig[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](...args); return; }
    try {
      const file = logFilePath()!;
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) {
        try { fs.rmSync(file, { force: true }); } catch { /* 尽力 */ }
      }
      fs.appendFileSync(file, `[${dayStamp()} ${timeStamp()}] [${level}] [console] ${line}\n`, 'utf-8');
    } catch { /* 尽力 */ }
    // 控制台仍输出原始内容（不带双时间戳）
    orig[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](...args);
  };
  console.log = (...args: unknown[]) => write('INFO', args);
  console.warn = (...args: unknown[]) => write('WARN', args);
  console.error = (...args: unknown[]) => write('ERROR', args);
}

/** 模型调用结构化埋点（脱敏：URL 不含 key，错误正文截断）。 */
export function logModel(event: 'request' | 'response' | 'error', detail: {
  provider: string;
  model: string;
  apiMode?: string;
  url?: string;
  status?: number;
  ms?: number;
  contentLen?: number;
  toolCalls?: number;
  error?: string;
}): void {
  const parts = [
    detail.provider,
    detail.model,
    detail.apiMode,
    detail.url,
    detail.status !== undefined ? `HTTP ${detail.status}` : undefined,
    detail.ms !== undefined ? `${detail.ms}ms` : undefined,
    detail.contentLen !== undefined ? `content ${detail.contentLen} chars` : undefined,
    detail.toolCalls !== undefined ? `${detail.toolCalls} tool_calls` : undefined,
    detail.error ? `ERROR: ${String(detail.error).slice(0, 300)}` : undefined,
  ].filter(Boolean);
  log(event === 'error' ? 'ERROR' : 'INFO', 'model', parts.join(' · '));
}
