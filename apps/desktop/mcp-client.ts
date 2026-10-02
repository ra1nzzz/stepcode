/**
 * MCP（Model Context Protocol）客户端 —— 真接入，零第三方依赖。
 * ----------------------------------------------------------------------------
 * 纯逻辑模块：**不 import electron**，可 node 直测（见 mcp-client-verify.cjs）。
 *
 * 为什么手写客户端不引 @modelcontextprotocol/sdk：
 *   MCP 的核心就是 JSON-RPC 2.0 over stdio（initialize → tools/list → tools/call），
 *   协议面很薄。引 SDK 会带进一整套 zod/transport 依赖树，与项目「零依赖、纯逻辑
 *   可直测」的纪律冲突。这里只实现三个 method + 通知，足够支撑「能力」TAB 展示
 *   真实 MCP 连接与工具清单，以及主会话调用 MCP 工具。
 *
 * 纪律（与 connector-registry.ts 同款）：
 *   - 「未配置」≠「配置了连不上」≠「连接成功但无工具」三态分离，不混淆、不伪造。
 *   - 配置落盘 数据目录/mcp.json（DATA_FILE_NAMES.mcp），随数据目录迁移。
 *   - 子进程 env 剔除 NODE_OPTIONS/NODE_PATH/ELECTRON_RUN_AS_NODE（同 terminal-pty 铁律），
 *     否则本机 WorkBuddy 的 safe-delete shim 会注入子进程，MCP server 直接崩或行为异常。
 *   - stdio 子进程必须带超时；握手/列工具/调工具各自独立超时，卡住不得挂起主会话。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { CHILD_ENV_STRIP } from './terminal-tools';

// ============================================================================
// 类型
// ============================================================================

/** MCP server 传输方式。当前实现 stdio；http/sse 属能力外延，先诚实标注。 */
export type McpTransport = 'stdio';

export interface McpServerConfig {
  /** 唯一 id（目录名白名单约束，防路径注入）。 */
  id: string;
  name: string;
  /** 启动命令，如 `npx` / `uvx` / `node` / 本地可执行文件绝对路径。 */
  command: string;
  /** 命令参数，如 `["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]`。 */
  args: string[];
  /** 环境变量（可含密钥；落盘时 value 用 credentials 加密，回显脱敏）。 */
  env?: Record<string, string>;
  /** 是否启用（false = 已配置但不主动连接）。 */
  enabled: boolean;
  transport: McpTransport;
}

/** 单个 MCP 工具的元数据（来自 tools/list 结果）。 */
export interface McpToolDef {
  name: string;
  description?: string;
  /** 输入 JSON Schema（原始，不展开）。 */
  inputSchema?: unknown;
}

/** 连接/握手结论（状态归一化后，供 UI 展示）。 */
export interface McpConnectionState {
  id: string;
  /** 是否已配置（有 command 即视为已配置）。 */
  configured: boolean;
  /** 是否启用。 */
  enabled: boolean;
  /** 最近一次连接结论：null = 从未尝试；true/false = 上轮成功/失败。 */
  lastConnectOk: boolean | null;
  /** 上轮结论的说明（错误信息 / 成功时的身份串）。 */
  lastMessage: string;
  /** 最近一次握手时间（ms）。 */
  lastConnectAt: number | null;
  /** 上轮成功拿到的工具名清单（失败/未连为空数组，不等于「无工具」——须看 lastConnectOk）。 */
  tools: string[];
}

export interface McpListResult {
  ok: boolean;
  servers: McpConnectionState[];
  /** 统计：已配置 / 连接成功 / 工具总数。 */
  stats: { total: number; configured: number; connected: number; tools: number };
  reason?: string;
}

export interface McpProbeResult {
  ok: boolean;
  /** 连接成功且握手完成。 */
  connected: boolean;
  /** 工具清单（成功时）。 */
  tools?: McpToolDef[];
  reason?: string;
  /** 握手耗时（ms）。 */
  latencyMs?: number;
}

export interface McpCallResult {
  ok: boolean;
  /** tools/call 的业务结果（isError=true 时也返回 ok:true，语义靠 isError 区分）。 */
  result?: unknown;
  /** MCP 工具是否报告错误。 */
  isError?: boolean;
  reason?: string;
}

// ============================================================================
// 常量与校验
// ============================================================================

/** 单个 MCP 配置上限（防失控：一个配置夹带海量 env 或参数）。 */
const MAX_ARGS = 64;
const MAX_ENV_KEYS = 32;
const MAX_ID_LEN = 64;

/** 握手 / 列工具 / 调工具各自的超时（ms）。 */
const INIT_TIMEOUT_MS = 15000;
const LIST_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 120000;

/**
 * BUG-049：子进程 env 一律走 `terminal-tools` 那份唯一的剔除清单。
 * 这里原本自带一张只有三个键的私有清单，与终端侧各自漂移，且都不剥数据目录定位变量——
 * 于是任何被配置的 MCP server 进程都能从 env 里读到 ORCHDESK_DATA_DIR / ORCHDESK_HOME。
 * `config.env` 仍然最后覆盖：用户显式给某个变量赋值是他的决定，不是我们的泄漏。
 */
export function buildChildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === null || v === undefined) continue;
    if (CHILD_ENV_STRIP.includes(k)) continue;
    env[k] = v;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

/** MCP id 白名单：与 plugin-market.isMarketDirName 同纪律，防路径穿越。 */
export function isMcpId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN
    && !id.startsWith('.') && !id.includes('/') && !id.includes('\\') && id !== '..';
}

/** 校验并归一化一条 MCP 配置；非法返回 reason。 */
export function normalizeMcpConfig(raw: unknown): { ok: true; config: McpServerConfig } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '配置不是对象' };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!isMcpId(id)) return { ok: false, reason: 'id 非法（须为 1-64 位、无 / 与 .. 的目录名）' };
  const command = typeof r.command === 'string' ? r.command.trim() : '';
  if (!command) return { ok: false, reason: 'command 为空' };
  const argsRaw = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [];
  // 先判上限再截断。原实现先 `.slice(0, MAX_ARGS)` 再 `if (args.length > MAX_ARGS)`，
  // 那个条件恒为假：超限配置被静默截断并连错误 reason 一起丢掉，用户看到「保存成功」。
  if (argsRaw.length > MAX_ARGS) return { ok: false, reason: `参数过多（上限 ${MAX_ARGS}）` };
  const args = argsRaw;
  const envRaw = (r.env && typeof r.env === 'object' ? r.env as Record<string, unknown> : {});
  const envKeys = Object.keys(envRaw).filter((k) => typeof envRaw[k] === 'string');
  if (envKeys.length > MAX_ENV_KEYS) return { ok: false, reason: `环境变量过多（上限 ${MAX_ENV_KEYS}）` };
  const env: Record<string, string> = {};
  for (const k of envKeys) env[k] = String(envRaw[k]);
  return {
    ok: true,
    config: {
      id,
      name: (typeof r.name === 'string' && r.name.trim()) || id,
      command,
      args,
      env: envKeys.length ? env : undefined,
      enabled: r.enabled !== false,
      transport: 'stdio',
    },
  };
}

// ============================================================================
// 存储（配置 CRUD；纯逻辑，文件路径由调用方注入）
// ============================================================================

/** 单个 MCP 的连接结论（不含 id/configured/enabled —— 那些由配置本身决定）。 */
export interface McpConnState {
  lastConnectOk: boolean | null;
  lastMessage: string;
  lastConnectAt: number | null;
  tools: string[];
}

export interface McpStore {
  /** 全部配置（按 id）。 */
  servers: Record<string, McpServerConfig>;
  /** 每 server 的最近连接结论（内存态，重启后清空为「未探测」——符合「未探测≠失败」）。 */
  states: Record<string, McpConnState>;
}

export function emptyMcpStore(): McpStore {
  return { servers: {}, states: {} };
}

/** 序列化配置到磁盘（env 值在此由调用方先加密）。 */
export function serializeMcpStore(store: McpStore): string {
  return JSON.stringify({ servers: store.servers }, null, 2);
}

/**
 * 解析磁盘上的 mcp.json。容错：文件损坏/字段缺失 → 逐条归一化，坏条目丢弃并计数，
 * 不因一条坏配置让整个 MCP 面板「未接入」（同 guanji/connector 的容错纪律）。
 */
export function parseMcpStore(text: string): { ok: boolean; store: McpStore; dropped: number; reason?: string } {
  const store = emptyMcpStore();
  if (!text || !text.trim()) return { ok: true, store, dropped: 0 };
  try {
    const data = JSON.parse(text) as { servers?: Record<string, unknown> };
    const servers = (data && typeof data === 'object' && data.servers && typeof data.servers === 'object')
      ? data.servers as Record<string, unknown>
      : {};
    let dropped = 0;
    for (const [id, raw] of Object.entries(servers)) {
      const norm = normalizeMcpConfig({ ...(raw as object), id });
      if (norm.ok) store.servers[id] = norm.config;
      else dropped++;
    }
    return { ok: true, store, dropped };
  } catch (err) {
    return { ok: false, store, dropped: 0, reason: `mcp.json 解析失败：${(err as Error).message}` };
  }
}

// ============================================================================
// stdio 子进程客户端（JSON-RPC 2.0）
// ============================================================================

/** 启动 MCP server 子进程并完成 initialize 握手。返回 client 句柄 + tools。 */
export function connectMcpServer(
  config: McpServerConfig,
  opts: { initTimeoutMs?: number } = {},
): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    const initTimeout = opts.initTimeoutMs ?? INIT_TIMEOUT_MS;
    let settled = false;
    const finish = (r: McpProbeResult) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(r);
    };

    const env = buildChildEnv(config.env);

    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      finish({ ok: false, connected: false, reason: `启动失败：${(err as Error).message}` });
      return;
    }

    const startedAt = Date.now();
    let buf = '';
    const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let stderrTail = '';

    const send = (method: string, params?: unknown): Promise<unknown> => {
      return new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        const msg = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
        try { child.stdin!.write(msg + '\n'); } catch (err) { pending.delete(id); rej(err as Error); }
      });
    };

    // stdin 写失败是**异步** 'error' 事件（子进程已退出后的 EPIPE），try/catch 抓不到。
    // 没有监听器时 Node 把它抛成 uncaughtException，打包态 main.ts:1330 直接 process.exit(1)
    // ——整只应用在回合中途死掉。terminal-pty.ts:321 记的是同一条规矩。
    child.stdin!.on('error', () => { /* 由 child.on('exit'/'error') 统一收尾 */ });

    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number | string; result?: unknown; error?: { code: number; message: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
          else p.resolve(msg.result);
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500);
    });
    child.on('error', (err) => finish({ ok: false, connected: false, reason: `进程错误：${err.message}` }));
    child.on('exit', (code, signal) => {
      if (settled) return;
      finish({
        ok: false,
        connected: false,
        reason: `进程提前退出（code=${code ?? '?'}${signal ? ` signal=${signal}` : ''}）${stderrTail ? ' · stderr: ' + stderrTail.trim() : ''}`,
      });
    });

    const timer = setTimeout(() => {
      finish({ ok: false, connected: false, reason: `握手超时（>${initTimeout}ms）` });
    }, initTimeout);

    (async () => {
      try {
        const initResult = await send('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'orchdesk', version: '0.0.0' },
        });
        // 发 initialized 通知（2024-11-05 规范要求握手后必须发）
        try { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch { /* 忽略 */ }
        const listResult = await send('tools/list');
        const tools = (Array.isArray(listResult) ? listResult : (listResult as { tools?: unknown[] })?.tools ?? [])
          .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map((t) => ({
            name: String(t.name ?? ''),
            description: typeof t.description === 'string' ? t.description : undefined,
            inputSchema: t.inputSchema,
          }));
        clearTimeout(timer);
        finish({ ok: true, connected: true, tools, latencyMs: Date.now() - startedAt });
      } catch (err) {
        clearTimeout(timer);
        finish({ ok: false, connected: false, reason: `握手失败：${(err as Error).message}` });
      }
    })();
  });
}

/** 调用 MCP 工具（长任务，独立超时）。 */
export function callMcpTool(
  config: McpServerConfig,
  toolName: string,
  args: unknown,
  opts: { callTimeoutMs?: number } = {},
): Promise<McpCallResult> {
  return new Promise((resolve) => {
    const callTimeout = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
    let settled = false;
    const finish = (r: McpCallResult) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(r);
    };

    const env = buildChildEnv(config.env);

    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (err) {
      finish({ ok: false, reason: `启动失败：${(err as Error).message}` });
      return;
    }

    let buf = '';
    let stderrTail = '';
    const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    const send = (method: string, params?: unknown): Promise<unknown> => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      try { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n'); } catch (err) { pending.delete(id); rej(err as Error); }
    });

    // 同 connectMcpServer：子进程退出后的 EPIPE 是异步 'error'，无监听即 uncaughtException。
    child.stdin!.on('error', () => { /* 由 child.on('exit'/'error') 统一收尾 */ });

    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number | string; result?: unknown; error?: { code: number; message: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
          else p.resolve(msg.result);
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500); });
    child.on('error', (err) => finish({ ok: false, reason: `进程错误：${err.message}` }));
    child.on('exit', (code, signal) => {
      if (settled) return;
      finish({ ok: false, reason: `进程提前退出（code=${code ?? '?'}${signal ? ` signal=${signal}` : ''}）${stderrTail ? ' · stderr: ' + stderrTail.trim() : ''}` });
    });
    const timer = setTimeout(() => finish({ ok: false, reason: `调用超时（>${callTimeout}ms）` }), callTimeout);

    (async () => {
      try {
        await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'orchdesk', version: '0.0.0' } });
        try { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch { /* 忽略 */ }
        const result = await send('tools/call', { name: toolName, arguments: args ?? {} });
        clearTimeout(timer);
        // tools/call 业务错误：content 里 isError=true。协议上仍是成功响应。
        const isError = !!(result && typeof result === 'object' && (result as Record<string, unknown>).isError === true);
        finish({ ok: true, result, isError });
      } catch (err) {
        clearTimeout(timer);
        finish({ ok: false, reason: `调用失败：${(err as Error).message}` });
      }
    })();
  });
}
