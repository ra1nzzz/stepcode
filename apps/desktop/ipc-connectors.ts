/**
 * 连接器 IPC（PRD FR-3）。
 * 目录 / 探测构造 / 审计缓冲在 connector-registry.ts（纯逻辑）；
 * 本模块管文件读写、真实 HTTP 探测、以及 IPC 挂载。
 * 注册须在 main.ts patch ipcMain.handle 之后调用，才能走 sender 门。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IpcMain } from 'electron';
import {
  CONNECTOR_CATALOG,
  CONNECTOR_PROBE_TIMEOUT_MS,
  appendAudit as appendConnectorAudit,
  auditStats as connectorAuditStats,
  buildProbeRequest,
  clearCreds,
  emptyConnectorFile,
  getConnectorDef,
  interpretProbeResult,
  isConnectorId,
  normalizeConnectorFile,
  readCreds,
  redactCreds,
  searchAudit as searchConnectorAudit,
  writeCreds,
  type ConnectorAuditAction,
  type ConnectorAuditEntry,
  type ConnectorFile,
} from './connector-registry';
import { discoverConnector } from './connector-discover';
import { DATA_FILE_NAMES } from './data-dir';
import { log } from './logger';

export type ConnectorIpcHost = {
  dataDir: () => string;
};

let host: ConnectorIpcHost | undefined;
let connectorFile: ConnectorFile = emptyConnectorFile();

export function initConnectors(deps: ConnectorIpcHost): void {
  host = deps;
}

function requireHost(): ConnectorIpcHost {
  if (!host) throw new Error('initConnectors 未调用');
  return host;
}

export function connectorsFilePath(): string {
  return path.join(requireHost().dataDir(), DATA_FILE_NAMES.connectors);
}

/** 启动装载：坏文件 / 缺文件 → 空注册表（凭证丢了可以重录，不该阻断启动）。 */
export function loadConnectors(): number {
  try {
    connectorFile = normalizeConnectorFile(JSON.parse(fs.readFileSync(connectorsFilePath(), 'utf-8')));
  } catch {
    connectorFile = emptyConnectorFile();
  }
  return Object.values(connectorFile.creds).length;
}

/**
 * 写穿落盘（与沙箱日志 / 晋升审计同节奏）。
 * 失败只 WARN：凭证已经写进内存里的注册表，UI 上就是可用的状态；因为落盘失败就
 * 回滚，会让用户刚填完的凭证凭空消失且没有任何提示。
 */
function persistConnectors(): boolean {
  try {
    const file = connectorsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(connectorFile, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log('WARN', 'connector', `连接器注册表落盘失败（内存态仍生效）: ${(err as Error).message}`);
    return false;
  }
}

function recordConnectorAudit(id: string, action: ConnectorAuditAction, message: string): void {
  const entry: ConnectorAuditEntry = {
    id,
    ts: Date.now(),
    action,
    message: String(message || '').slice(0, 240),
  };
  connectorFile.audit = appendConnectorAudit(connectorFile.audit, entry);
  persistConnectors();
}

/** 执行一次真实探测（只发请求，不落状态；状态更新由调用方决定）。 */
async function probeConnector(id: string): Promise<{ ok: boolean; message: string; manual?: boolean }> {
  const def = getConnectorDef(id);
  if (!def) return { ok: false, message: `未知连接器: ${id}` };
  if (def.probe.kind !== 'http') {
    return { ok: false, manual: true, message: def.probe.manualReason || '该连接器不支持自动探测' };
  }
  const creds = readCreds(connectorFile, id);
  const built = buildProbeRequest(def, creds);
  if (!built.ok) return { ok: false, message: built.error };

  try {
    const req = built.request;
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body ? { body: req.body } : {}),
      signal: AbortSignal.timeout(CONNECTOR_PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return interpretProbeResult(def, { status: res.status, body });
  } catch (err) {
    const e = err as Error;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { ok: false, message: `探测超时（${CONNECTOR_PROBE_TIMEOUT_MS / 1000}s）：网络不可达或被拦截` };
    }
    return { ok: false, message: `网络请求失败：${e?.message || String(err)}` };
  }
}

/** 探测并把结论写进状态表（成功与失败都要记 —— 失败记录才是排查凭证问题的依据）。 */
async function testConnector(id: string): Promise<{ ok: boolean; message: string; manual?: boolean }> {
  const result = await probeConnector(id);
  const st = connectorFile.states[id];
  if (st) {
    if (!result.manual) {
      st.lastTestAt = Date.now();
      st.lastTestOk = result.ok;
      st.lastTestMessage = result.message;
    } else {
      st.lastTestAt = null;
      st.lastTestOk = null;
      st.lastTestMessage = '';
    }
  }
  if (!result.manual) {
    recordConnectorAudit(id, result.ok ? 'test' : 'test-fail', result.message);
  } else {
    persistConnectors();
  }
  return result;
}

/** 供渲染层列表用的一条连接器视图（凭证已脱敏，密文绝不出主进程）。 */
function connectorView(id: string) {
  const def = getConnectorDef(id)!;
  const creds = readCreds(connectorFile, id);
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    desc: def.desc,
    caps: def.caps,
    docsUrl: def.docsUrl,
    manual: def.probe.kind !== 'manual' ? false : true,
    manualReason: def.probe.manualReason || '',
    manualHint: def.probe.manualHint || '',
    fields: def.fields.map((f) => ({
      key: f.key, label: f.label, type: f.type,
      placeholder: f.placeholder || '', hint: f.hint || '', required: f.required !== false,
    })),
    values: redactCreds(def, creds),
    state: connectorFile.states[id] || null,
  };
}

export function registerConnectorIpc(ipc: IpcMain): void {
  ipc.handle('orchdesk:connectors', async () => {
    const items = CONNECTOR_CATALOG.map((c) => connectorView(c.id));
    const states = Object.values(connectorFile.states);
    return {
      items,
      stats: {
        total: items.length,
        configured: states.filter((s) => s.configured).length,
        tested: states.filter((s) => s.lastTestOk !== null).length,
        ok: states.filter((s) => s.lastTestOk === true).length,
      },
    };
  });

  ipc.handle('orchdesk:connector-save', async (_e, id: unknown, creds: unknown) => {
    if (!isConnectorId(id)) return { ok: false, reason: `未知连接器: ${String(id)}` };
    const def = getConnectorDef(id)!;
    const prev = readCreds(connectorFile, id);
    const src = (creds && typeof creds === 'object' ? creds as Record<string, unknown> : {});
    const clean: Record<string, string> = {};
    for (const f of def.fields) {
      const raw = typeof src[f.key] === 'string' ? String(src[f.key]).trim() : '';
      clean[f.key] = /^••••/.test(raw) ? String(prev[f.key] || '') : raw;
    }
    writeCreds(connectorFile, id, clean);
    const missing = def.fields.filter((f) => f.required !== false && !clean[f.key]).map((f) => f.key);
    recordConnectorAudit(id, 'save', missing.length ? `凭证已保存（不完整：缺少 ${missing.join(', ')}）` : '凭证已保存');

    if (missing.length) {
      return { ok: true, configured: false, state: connectorFile.states[id] || null, probe: null };
    }
    const probe = await testConnector(id);
    return { ok: true, configured: true, state: connectorFile.states[id] || null, probe };
  });

  ipc.handle('orchdesk:connector-clear', async (_e, id: unknown) => {
    if (!isConnectorId(id)) return { ok: false, reason: `未知连接器: ${String(id)}` };
    clearCreds(connectorFile, id);
    recordConnectorAudit(id, 'clear', '凭证已清除');
    return { ok: true, state: connectorFile.states[id] || null };
  });

  ipc.handle('orchdesk:connector-test', async (_e, id: unknown) => {
    if (!isConnectorId(id)) return { ok: false, reason: `未知连接器: ${String(id)}` };
    const probe = await testConnector(id);
    return { ok: probe.ok, message: probe.message, manual: probe.manual, state: connectorFile.states[id] || null };
  });

  ipc.handle('orchdesk:connector-discover', async (_e, id: unknown) => {
    if (!isConnectorId(id)) return { ok: false, reason: `未知连接器: ${String(id)}` };
    let home = '';
    try { home = os.homedir(); } catch { /* ignore */ }
    if (!home) return { ok: false, reason: '无法定位用户主目录' };
    return discoverConnector(String(id), { home });
  });

  ipc.handle('orchdesk:connector-audit', async (_e, query: unknown) => {
    const q = (query || {}) as Parameters<typeof searchConnectorAudit>[1];
    return {
      entries: searchConnectorAudit(connectorFile.audit, q || {}),
      stats: connectorAuditStats(connectorFile.audit),
      total: connectorFile.audit.length,
      max: 200,
    };
  });

  ipc.handle('orchdesk:connector-audit-clear', async () => {
    const cleared = connectorFile.audit.length;
    connectorFile.audit = [];
    persistConnectors();
    return { ok: true, cleared };
  });
}
