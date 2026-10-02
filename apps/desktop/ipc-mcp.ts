/**
 * MCP IPC（Model Context Protocol 真接入）。
 * 客户端协议 / 配置归一化 / stdio 子进程管理全在 mcp-client.ts（纯逻辑、零 electron）。
 * 本模块管文件读写、env 值加密落盘 / 解密回显、把结论挂到 IPC、以及真实探测。
 * 注册须在 main.ts patch ipcMain.handle 之后调用，才能走 sender 门。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcMain } from 'electron';
import { encryptSecret, decryptSecret, isV1Cipher } from './credentials';
import { DATA_FILE_NAMES } from './data-dir';
import { getHostServices } from './host-services';
import { log } from './logger';
import {
  callMcpTool,
  connectMcpServer,
  emptyMcpStore,
  isMcpId,
  normalizeMcpConfig,
  parseMcpStore,
  serializeMcpStore,
  type McpCallResult,
  type McpConnState,
  type McpConnectionState,
  type McpListResult,
  type McpServerConfig,
  type McpStore,
} from './mcp-client';

export type McpIpcHost = {
  dataDir: () => string;
};

let host: McpIpcHost | undefined;
let mcpStore: McpStore = emptyMcpStore();

export function initMcp(deps: McpIpcHost): void {
  host = deps;
}

function requireHost(): McpIpcHost {
  if (!host) throw new Error('initMcp 未调用');
  return host;
}

export function mcpFilePath(): string {
  return path.join(requireHost().dataDir(), DATA_FILE_NAMES.mcp);
}

/** 启动装载：坏文件 / 缺文件 → 空表（配置丢了可以重配，不该阻断启动）。 */
export function loadMcp(): number {
  try {
    const raw = fs.readFileSync(mcpFilePath(), 'utf-8');
    const parsed = parseMcpStore(raw);
    if (!parsed.ok) {
      log('WARN', 'mcp', `MCP 配置解析失败，按空表启动: ${parsed.reason}`);
      mcpStore = emptyMcpStore();
      return 0;
    }
    mcpStore = parsed.store;
    if (parsed.dropped > 0) log('WARN', 'mcp', `MCP 配置有 ${parsed.dropped} 条非法条目已丢弃`);
    return Object.keys(mcpStore.servers).length;
  } catch {
    mcpStore = emptyMcpStore();
    return 0;
  }
}

/**
 * 写穿落盘。env 里的密钥值在落盘前加密（同凭据纪律），读回时解密。
 * 失败只 WARN：配置已在内存态生效，落盘失败不该让用户刚填的 MCP 凭空消失。
 */
function persistMcp(): boolean {
  try {
    const file = mcpFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const toWrite: McpStore = {
      servers: {},
      states: {},
    };
    for (const [id, cfg] of Object.entries(mcpStore.servers)) {
      const envEnc: Record<string, string> = {};
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          envEnc[k] = isV1Cipher(v) ? v : encryptSecret(v);
        }
      }
      toWrite.servers[id] = { ...cfg, env: Object.keys(envEnc).length ? envEnc : undefined };
    }
    fs.writeFileSync(file, serializeMcpStore(toWrite), 'utf-8');
    return true;
  } catch (err) {
    log('WARN', 'mcp', `MCP 配置落盘失败（内存态仍生效）: ${(err as Error).message}`);
    return false;
  }
}

/** 解密 env 值，得到可直接用于 spawn 的配置副本。 */
function decryptMcpConfig(cfg: McpServerConfig): McpServerConfig {
  if (!cfg.env) return cfg;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.env)) env[k] = isV1Cipher(v) ? decryptSecret(v) : v;
  return { ...cfg, env };
}

/** 组装单条 MCP 的展示态（脱敏：env 值永不回显明文）。 */
function mcpState(id: string): McpConnectionState {
  const cfg = mcpStore.servers[id];
  const st: McpConnState = mcpStore.states[id] || { lastConnectOk: null, lastMessage: '', lastConnectAt: null, tools: [] };
  return {
    id,
    configured: !!cfg,
    enabled: cfg ? cfg.enabled !== false : false,
    lastConnectOk: st.lastConnectOk,
    lastMessage: st.lastMessage,
    lastConnectAt: st.lastConnectAt,
    tools: st.tools,
  };
}

/** 全量列表 + 统计。 */
function mcpListResult(): McpListResult {
  const ids = Object.keys(mcpStore.servers);
  const servers = ids.map((id) => mcpState(id));
  return {
    ok: true,
    servers,
    stats: {
      total: ids.length,
      configured: ids.length,
      connected: servers.filter((s) => s.lastConnectOk === true).length,
      tools: servers.reduce((n, s) => n + s.tools.length, 0),
    },
  };
}

export function registerMcpIpc(ipc: IpcMain): void {
  /** MCP 列表（含连接状态 + 工具清单）。 */
  ipc.handle('orchdesk:mcp-list', () => mcpListResult());

  /** 保存一条 MCP 配置并立即探测一次（同连接器「保存即探测」纪律）。 */
  ipc.handle('orchdesk:mcp-save', async (_e, raw: unknown) => {
    const norm = normalizeMcpConfig(raw);
    if (!norm.ok) return { ok: false, reason: norm.reason };
    const cfg = norm.config;
    // env 值先加密再入内存表，避免明文常驻。
    if (cfg.env) {
      const envEnc: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.env)) envEnc[k] = isV1Cipher(v) ? v : encryptSecret(v);
      cfg.env = envEnc;
    }
    mcpStore.servers[cfg.id] = cfg;
    persistMcp();

    if (cfg.enabled === false) {
      mcpStore.states[cfg.id] = { lastConnectOk: null, lastMessage: '已停用（未主动连接）', lastConnectAt: Date.now(), tools: [] };
      return { ok: true, configured: true, state: mcpState(cfg.id), probe: null };
    }

    const probe = await connectMcpServer(decryptMcpConfig(cfg));
    if (probe.connected) {
      mcpStore.states[cfg.id] = {
        lastConnectOk: true,
        lastMessage: `已连接 · ${(probe.tools || []).length} 个工具`,
        lastConnectAt: Date.now(),
        tools: (probe.tools || []).map((t) => t.name),
      };
    } else {
      mcpStore.states[cfg.id] = {
        lastConnectOk: false,
        lastMessage: probe.reason || '连接失败',
        lastConnectAt: Date.now(),
        tools: [],
      };
    }
    return { ok: true, configured: true, state: mcpState(cfg.id), probe };
  });

  /** 删除一条 MCP 配置（连同连接结论一起清掉）。 */
  ipc.handle('orchdesk:mcp-delete', (_e, id: unknown) => {
    if (!isMcpId(id)) return { ok: false, reason: `非法 id: ${String(id)}` };
    if (!mcpStore.servers[id]) return { ok: false, reason: '配置不存在' };
    delete mcpStore.servers[id];
    delete mcpStore.states[id];
    persistMcp();
    return { ok: true };
  });

  /** 启用 / 停用（停用不删配置，下次启用仍可连）。 */
  ipc.handle('orchdesk:mcp-set-enabled', (_e, id: unknown, enabled: unknown) => {
    if (!isMcpId(id)) return { ok: false, reason: `非法 id: ${String(id)}` };
    const cfg = mcpStore.servers[id];
    if (!cfg) return { ok: false, reason: '配置不存在' };
    cfg.enabled = enabled !== false;
    persistMcp();
    return { ok: true, state: mcpState(id) };
  });

  /** 用已存配置重新探测（拿最新工具清单）。 */
  ipc.handle('orchdesk:mcp-probe', async (_e, id: unknown) => {
    if (!isMcpId(id)) return { ok: false, reason: `非法 id: ${String(id)}` };
    const cfg = mcpStore.servers[id];
    if (!cfg) return { ok: false, reason: '配置不存在' };
    const probe = await connectMcpServer(decryptMcpConfig(cfg));
    if (probe.connected) {
      mcpStore.states[id] = {
        lastConnectOk: true,
        lastMessage: `已连接 · ${(probe.tools || []).length} 个工具`,
        lastConnectAt: Date.now(),
        tools: (probe.tools || []).map((t) => t.name),
      };
    } else {
      mcpStore.states[id] = { lastConnectOk: false, lastMessage: probe.reason || '连接失败', lastConnectAt: Date.now(), tools: [] };
    }
    return { ok: true, state: mcpState(id), probe };
  });

  /** 调用 MCP 工具（供主会话 / Agent 运行时复用）。 */
  ipc.handle('orchdesk:mcp-call-tool', async (_e, id: unknown, toolName: unknown, args: unknown): Promise<McpCallResult> => {
    if (!isMcpId(id)) return { ok: false, reason: `非法 id: ${String(id)}` };
    const cfg = mcpStore.servers[id];
    if (!cfg) return { ok: false, reason: '配置不存在' };
    if (typeof toolName !== 'string' || !toolName.trim()) return { ok: false, reason: 'toolName 为空' };
    // M4 一致性（审查 P1）：MCP 工具必然有副作用（建 issue/发消息/写文件——MCP 的价值
    // 就在「做事」），read-only 沙箱模式下不得经 IPC 触发远端变更。
    // 它不经 executeTool（TOOL_DEFS 无 mcp-* 定义），denyIfReadOnly 管不到，故在此设门。
    try {
      const policy = getHostServices()?.sandboxPolicy;
      if (!policy) return { ok: false, reason: '沙箱服务已停止，MCP 工具调用被拒绝' };
      const mode = policy.resolve?.()?.mode;
      if (mode === 'read-only') {
        return { ok: false, reason: '沙箱为只读模式（read-only），MCP 工具调用被拒绝（可先用 mcp-probe 查看工具清单）' };
      }
    } catch {
        return { ok: false, reason: '沙箱服务已停止，MCP 工具调用被拒绝' };
      }
    return callMcpTool(decryptMcpConfig(cfg), toolName.trim(), args);
  });
}
