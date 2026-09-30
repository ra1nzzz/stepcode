/**
 * 连接器注册表（PRD FR-3：连接器 8+）
 * ----------------------------------------------------------------------------
 * 纯逻辑、零 electron 依赖 —— 目录定义 / 凭证脱敏 / 探测请求构造 / 探测结果判定 /
 * 状态归一化 / 审计环形缓冲，全部可 node 直测（见 connector-registry-verify.cjs）。
 *
 * 为什么把「探测请求构造」和「判定」拆成纯函数而不是一次 fetch 了事：
 * 连接器最容易出现的死挂点就是「测试连通性按钮点了永远转圈或永远失败」——
 * 端点写错、鉴权头格式写错（Linear 个人密钥不带 Bearer）、成功判定只看 HTTP 200
 * 而忽略了业务码（飞书 code!==0、企微 errcode!==0 都是 200）。把这两步做成纯函数
 * 后，断言能直接对着「发出去的请求」和「判定结论」写，不需要真的打通外网。
 *
 * 端点均以各平台官方文档为准（2026-08 核实）；腾讯文档无公开的无副作用只读探测
 * 端点，显式标 manual —— 宁可诚实地说「不支持自动探测」，也不放一个必失败的探测。
 */
import { encryptSecret, decryptSecret } from './credentials';

// ============================================================================
// 类型
// ============================================================================

export type ConnectorFieldType = 'secret' | 'text';

export interface ConnectorField {
  key: string;
  label: string;
  /** secret = 输入掩码 + UI 不回显明文；text = 可回显（如 AppID / 企业ID）。 */
  type: ConnectorFieldType;
  placeholder?: string;
  hint?: string;
  /** 默认 true；false 表示选填。 */
  required?: boolean;
}

/** 成功判定规则。多条同时生效（与关系）。 */
export interface ProbeExpect {
  /** 可接受的状态码，默认 [200]。 */
  status?: number[];
  /** 响应体某路径必须等于某值（飞书 code===0 / 企微 errcode===0 / TAPD status===1）。 */
  fieldEquals?: { path: string; value: string | number | boolean };
  /** 响应体某路径必须存在且非空（GitHub login / 钉钉 accessToken）。 */
  fieldExists?: string[];
  /** 响应体某路径必须不存在或为空（GraphQL 的 errors 数组）。 */
  fieldAbsent?: string[];
}

export interface ProbeSpec {
  kind: 'http' | 'manual';
  method?: 'GET' | 'POST';
  /** URL 模板：${field} 占位符的值会做 encodeURIComponent。 */
  url?: string;
  /** 请求头模板：${field} 原样替换（不编码，令牌里可能有特殊字符但编码会破坏语义）。 */
  headers?: Record<string, string>;
  /** POST body 结构模板：字符串值里的 ${field} 占位符替换后 JSON.stringify 生成。 */
  bodyTemplate?: Record<string, unknown>;
  /** HTTP Basic 鉴权（TAPD）：{user} / {pass} 均为模板。 */
  basicAuth?: { user: string; pass: string };
  expect?: ProbeExpect;
  /** 成功后从响应体取身份串，如 GitHub 的 login（展示「已连接：@octocat」）。 */
  identityPath?: string;
  /** kind='manual' 时给用户的说明（为什么没有自动探测）。 */
  manualReason?: string;
  /** 命中 manual 的兜底提示语（成功保存凭证后展示）。 */
  manualHint?: string;
}

export interface ConnectorDef {
  id: string;
  name: string;
  /** 类别：code 代码托管 / im 企业通讯 / doc 文档 / pm 项目管理。 */
  kind: 'code' | 'im' | 'doc' | 'pm';
  desc: string;
  caps: string[];
  fields: ConnectorField[];
  probe: ProbeSpec;
  /** 官方文档地址（凭证怎么拿）。 */
  docsUrl: string;
}

export interface ConnectorState {
  id: string;
  /** 必填凭证字段均已填写。 */
  configured: boolean;
  /** 凭证保存时间（未保存为 null）。 */
  savedAt: number | null;
  /** 最近一次探测（未探测过为 null）。 */
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestMessage: string;
}

export type ConnectorAuditAction = 'save' | 'clear' | 'test' | 'test-fail';

export interface ConnectorAuditEntry {
  id: string;
  ts: number;
  action: ConnectorAuditAction;
  message: string;
}

/** 探测请求（buildProbeRequest 的产物，可直接喂给 fetch）。 */
export interface ProbeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ProbeResult {
  ok: boolean;
  /** 展示给用户的结论；失败时含可行动的原因。 */
  message: string;
}

// ============================================================================
// 目录（8 个，PRD FR-3 要求 8+）
// ============================================================================

export const CONNECTOR_CATALOG: readonly ConnectorDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    kind: 'code',
    desc: '代码托管 · Issue / PR / 仓库读写',
    caps: ['git.read', 'git.write', 'issue.write'],
    fields: [
      { key: 'token', label: '个人访问令牌 (PAT)', type: 'secret', placeholder: 'ghp_… / github_pat_…',
        hint: 'Settings → Developer settings → Personal access tokens；需 repo 与 read:user' },
    ],
    probe: {
      kind: 'http', method: 'GET', url: 'https://api.github.com/user',
      headers: { Authorization: 'Bearer ${token}', Accept: 'application/vnd.github+json', 'User-Agent': 'OrchDesk' },
      expect: { status: [200], fieldExists: ['login'] },
      identityPath: 'login',
    },
    docsUrl: 'https://docs.github.com/rest/users/users#get-the-authenticated-user',
  },
  {
    id: 'linear',
    name: 'Linear',
    kind: 'pm',
    desc: '项目管理 · Issue / Cycle / Project',
    caps: ['issue.read', 'issue.write'],
    fields: [
      { key: 'apiKey', label: '个人 API 密钥', type: 'secret', placeholder: 'lin_api_…',
        hint: 'Settings → Security & access → Personal API keys。注意：个人密钥的 Authorization 头不加 Bearer' },
    ],
    probe: {
      kind: 'http', method: 'POST', url: 'https://api.linear.app/graphql',
      headers: { Authorization: '${apiKey}', 'Content-Type': 'application/json' },
      bodyTemplate: { query: '{ viewer { id name email } }' },
      // GraphQL 的坑：鉴权失败也可能返 200 + errors 数组，只看状态码会误判为成功。
      expect: { status: [200], fieldAbsent: ['errors'] },
      identityPath: 'data.viewer.name',
    },
    docsUrl: 'https://linear.app/developers/graphql',
  },
  {
    id: 'notion',
    name: 'Notion',
    kind: 'doc',
    desc: '知识管理 · 页面 / 数据库',
    caps: ['doc.read', 'doc.write'],
    fields: [
      { key: 'token', label: '集成令牌', type: 'secret', placeholder: 'ntn_… / secret_…',
        hint: 'Notion 开发者后台 → Internal connection → Configuration 取 installation access token' },
    ],
    probe: {
      kind: 'http', method: 'GET', url: 'https://api.notion.com/v1/users/me',
      headers: { Authorization: 'Bearer ${token}', 'Notion-Version': '2022-06-28' },
      expect: { status: [200], fieldExists: ['id'] },
      identityPath: 'name',
    },
    docsUrl: 'https://developers.notion.com/docs/authorization',
  },
  {
    id: 'feishu',
    name: '飞书',
    kind: 'im',
    desc: '协作平台 · 消息 / 多维表格',
    caps: ['im.send', 'doc.read'],
    fields: [
      { key: 'appId', label: 'App ID', type: 'text', placeholder: 'cli_…', hint: '开放平台 → 凭证与基础信息' },
      { key: 'appSecret', label: 'App Secret', type: 'secret', placeholder: '…', hint: '仅自建应用' },
    ],
    probe: {
      kind: 'http', method: 'POST', url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      bodyTemplate: { app_id: '${appId}', app_secret: '${appSecret}' },
      expect: { status: [200], fieldEquals: { path: 'code', value: 0 }, fieldExists: ['tenant_access_token'] },
    },
    docsUrl: 'https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal',
  },
  {
    id: 'wecom',
    name: '企业微信',
    kind: 'im',
    desc: '企业通讯 · 应用消息 / 通讯录',
    caps: ['im.send', 'contact.read'],
    fields: [
      { key: 'corpid', label: '企业 ID (corpid)', type: 'text', placeholder: 'ww…', hint: '管理后台 → 我的企业 → 企业 ID' },
      { key: 'corpsecret', label: '应用 Secret', type: 'secret', placeholder: '…', hint: '应用详情 → API 接口栏' },
    ],
    probe: {
      kind: 'http', method: 'GET',
      url: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpid}&corpsecret=${corpsecret}',
      expect: { status: [200], fieldEquals: { path: 'errcode', value: 0 }, fieldExists: ['access_token'] },
    },
    docsUrl: 'https://developer.work.weixin.qq.com/document/15074',
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    kind: 'im',
    desc: '企业通讯 · 工作通知 / 审批',
    caps: ['im.send', 'approval.read'],
    fields: [
      { key: 'appKey', label: 'AppKey (Client ID)', type: 'text', placeholder: 'ding…' },
      { key: 'appSecret', label: 'AppSecret (Client Secret)', type: 'secret', placeholder: '…' },
    ],
    probe: {
      kind: 'http', method: 'POST', url: 'https://api.dingtalk.com/v1.0/oauth2/accessToken',
      headers: { 'Content-Type': 'application/json' },
      bodyTemplate: { appKey: '${appKey}', appSecret: '${appSecret}' },
      expect: { status: [200], fieldExists: ['accessToken'] },
    },
    docsUrl: 'https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app',
  },
  {
    id: 'tapd',
    name: 'TAPD',
    kind: 'pm',
    desc: '项目管理 · 需求 / 缺陷 / 迭代',
    caps: ['story.read', 'bug.read'],
    fields: [
      { key: 'apiUser', label: 'API 账号', type: 'text', placeholder: 'api_user' },
      { key: 'apiPassword', label: 'API 密码', type: 'secret', placeholder: '…', hint: '与公司成员昵称、公司 ID 一起用于 Basic 鉴权' },
      { key: 'nick', label: '成员昵称', type: 'text', placeholder: '如 anyechen' },
      { key: 'companyId', label: '公司 ID', type: 'text', placeholder: '数字' },
    ],
    probe: {
      kind: 'http', method: 'GET',
      url: 'https://api.tapd.cn/workspaces/user_participant_projects?nick=${nick}&company_id=${companyId}',
      basicAuth: { user: '${apiUser}', pass: '${apiPassword}' },
      expect: { status: [200], fieldEquals: { path: 'status', value: 1 } },
    },
    docsUrl: 'https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/workspace/user_participant_projects.html',
  },
  {
    id: 'tencent-docs',
    name: '腾讯文档',
    kind: 'doc',
    desc: '在线文档 · 目前无公开探测端点',
    caps: ['doc.read', 'doc.write'],
    fields: [
      { key: 'token', label: '访问令牌', type: 'secret', placeholder: '…', hint: '腾讯文档开放 API 需企业版授权，个人版无可用令牌' },
    ],
    probe: {
      kind: 'manual',
      manualReason: '腾讯文档开放 API 仅面向企业版授权，且未提供无副作用的只读探测端点。凭证仅本地加密保存，由调用方插件自行校验。',
      manualHint: '已保存凭证（无自动探测，状态不可验证）',
    },
    docsUrl: 'https://docs.qq.com/openapi',
  },
];

export const CONNECTOR_IDS: readonly string[] = CONNECTOR_CATALOG.map((c) => c.id);

export function getConnectorDef(id: string): ConnectorDef | null {
  return CONNECTOR_CATALOG.find((c) => c.id === id) || null;
}

export function isConnectorId(id: unknown): id is string {
  return typeof id === 'string' && CONNECTOR_IDS.includes(id);
}

// ============================================================================
// 凭证：脱敏与必填校验
// ============================================================================

export type CredMap = Record<string, string>;

/** 缺失的必填字段 key（不含值，避免把凭证写进报错信息）。 */
export function missingRequired(def: ConnectorDef, creds: CredMap): string[] {
  return def.fields
    .filter((f) => f.required !== false)
    .filter((f) => !String(creds[f.key] || '').trim())
    .map((f) => f.key);
}

/**
 * 凭证脱敏：secret 字段只留末 4 位，text 字段原样回显（AppID / 企业ID 这类回显才有排查价值）。
 * 未填写的字段一律空串 —— 不能用「未设置」之类的文案冒充，否则 UI 分不清「没填」和「填了但很短」。
 */
export function redactCreds(def: ConnectorDef, creds: CredMap): CredMap {
  const out: CredMap = {};
  for (const f of def.fields) {
    const raw = String(creds[f.key] || '');
    if (!raw) { out[f.key] = ''; continue; }
    out[f.key] = f.type === 'secret' ? maskSecret(raw) : raw;
  }
  return out;
}

export function maskSecret(raw: string): string {
  const s = String(raw || '');
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

// ============================================================================
// 模板替换
// ============================================================================

const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g;

/** 原样替换（请求头 / Basic 凭据用）。 */
function fillTemplate(tpl: string, creds: CredMap): string {
  return tpl.replace(PLACEHOLDER, (_m, key: string) => String(creds[key] ?? ''));
}

/** 替换 + URL 编码（URL 查询值用：昵称、公司ID 这类可能含特殊字符）。 */
function fillTemplateEncoded(tpl: string, creds: CredMap): string {
  return tpl.replace(PLACEHOLDER, (_m, key: string) => encodeURIComponent(String(creds[key] ?? '')));
}

function fillTemplateDeep(value: unknown, creds: CredMap): unknown {
  if (typeof value === 'string') return fillTemplate(value, creds);
  if (Array.isArray(value)) return value.map((v) => fillTemplateDeep(v, creds));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fillTemplateDeep(v, creds);
    return out;
  }
  return value;
}

// ============================================================================
// 探测请求构造（纯函数，不发网络）
// ============================================================================

/**
 * 构造探测请求。
 * 失败一律返回 { error } 而不是抛错：探测是用户手动触发的交互路径，
 * 抛错只会变成 IPC 层的「未知错误」，用户看不出是「少填了字段」还是「端点坏了」。
 */
export function buildProbeRequest(
  def: ConnectorDef,
  creds: CredMap,
): { ok: true; request: ProbeRequest } | { ok: false; error: string } {
  const p = def.probe;
  if (p.kind !== 'http') return { ok: false, error: '该连接器不支持自动探测' };

  const missing = missingRequired(def, creds);
  if (missing.length) return { ok: false, error: `缺少必填凭证字段：${missing.join(', ')}` };
  if (!p.url) return { ok: false, error: '探测端点未定义' };

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.headers || {})) headers[k] = fillTemplate(v, creds);

  if (p.basicAuth) {
    const user = fillTemplate(p.basicAuth.user, creds);
    const pass = fillTemplate(p.basicAuth.pass, creds);
    // Electron 主进程与 Node 都有 Buffer；这里只在主进程侧被调用。
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }

  let body: string | undefined;
  if (p.bodyTemplate) {
    // 走结构化模板再 JSON.stringify，避免密钥里的引号/反斜杠拼出非法 JSON。
    body = JSON.stringify(fillTemplateDeep(p.bodyTemplate, creds));
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  return {
    ok: true,
    request: {
      url: fillTemplateEncoded(p.url, creds),
      method: p.method || (body ? 'POST' : 'GET'),
      headers,
      ...(body ? { body } : {}),
    },
  };
}

// ============================================================================
// 探测结果判定（纯函数）
// ============================================================================

/** 按点路径取值：'data.viewer.name' → obj.data.viewer.name。 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  return Array.isArray(v) && v.length === 0;
}

/**
 * 判定探测结果。
 * 关键：只认 HTTP 状态码会把「飞书 200 + code=99991663」「企微 200 + errcode=40001」
 * 这种业务层鉴权失败判成成功 —— 连接状态会撒谎。故业务码必须一起判。
 */
export function interpretProbeResult(
  def: ConnectorDef,
  res: { status: number; body: unknown },
): ProbeResult {
  const p = def.probe;
  if (p.kind !== 'http') {
    return { ok: false, message: p.manualReason || '该连接器不支持自动探测' };
  }
  const expect = p.expect || {};
  const allow = expect.status && expect.status.length ? expect.status : [200];
  if (!allow.includes(res.status)) {
    return { ok: false, message: `HTTP ${res.status}${describeBodyError(res.body)}` };
  }
  if (expect.fieldEquals) {
    const actual = getByPath(res.body, expect.fieldEquals.path);
    const want = expect.fieldEquals.value;
    // 用宽松相等比较：TAPD 的 status 可能是 1（数字）或 "1"（字符串）。
    // eslint-disable-next-line eqeqeq
    if (actual != want) {
      return { ok: false, message: `业务码校验失败：${expect.fieldEquals.path}=${JSON.stringify(actual)}（期望 ${JSON.stringify(want)}）${describeBodyError(res.body)}` };
    }
  }
  if (expect.fieldExists) {
    for (const path of expect.fieldExists) {
      if (isEmptyValue(getByPath(res.body, path))) {
        return { ok: false, message: `响应缺少字段 ${path}${describeBodyError(res.body)}` };
      }
    }
  }
  if (expect.fieldAbsent) {
    for (const path of expect.fieldAbsent) {
      if (!isEmptyValue(getByPath(res.body, path))) {
        return { ok: false, message: `响应含错误段 ${path}：${summarize(getByPath(res.body, path))}` };
      }
    }
  }
  const identity = p.identityPath ? getByPath(res.body, p.identityPath) : null;
  return {
    ok: true,
    message: !isEmptyValue(identity) ? `已连接：${String(identity)}` : '连通性正常',
  };
}

/** 从常见错误响应体里摘一句人话（各平台字段名都不一样，逐个试）。 */
function describeBodyError(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  for (const key of ['message', 'msg', 'errmsg', 'error_description', 'info']) {
    const v = b[key];
    if (typeof v === 'string' && v && v !== 'success' && v !== 'ok') return ` · ${v}`;
  }
  const errs = b.errors;
  if (Array.isArray(errs) && errs.length) {
    const first = errs[0] as Record<string, unknown>;
    if (first && typeof first.message === 'string') return ` · ${first.message}`;
  }
  return '';
}

function summarize(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

// ============================================================================
// 状态归一化
// ============================================================================

export function emptyConnectorState(id: string): ConnectorState {
  return { id, configured: false, savedAt: null, lastTestAt: null, lastTestOk: null, lastTestMessage: '' };
}

export function normalizeConnectorState(raw: unknown): ConnectorState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && isConnectorId(r.id) ? r.id : null;
  if (!id) return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  return {
    id,
    configured: r.configured === true,
    savedAt: num(r.savedAt),
    lastTestAt: num(r.lastTestAt),
    lastTestOk: bool(r.lastTestOk),
    lastTestMessage: typeof r.lastTestMessage === 'string' ? r.lastTestMessage : '',
  };
}

/** 归一化整个状态表：未知 id、脏数据一律丢弃，缺失的用空状态补齐。 */
export function normalizeConnectorStates(raw: unknown): Record<string, ConnectorState> {
  const out: Record<string, ConnectorState> = {};
  for (const id of CONNECTOR_IDS) out[id] = emptyConnectorState(id);
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const st = normalizeConnectorState({ ...(v && typeof v === 'object' ? v as object : {}), id: k });
    if (st) out[k] = st;
  }
  return out;
}

// ============================================================================
// 审计（环形缓冲；写穿落盘由主进程负责）
// ============================================================================

export const CONNECTOR_AUDIT_MAX = 200;
/** 审计消息上限：只存结论不存凭证，长响应体截断避免文件膨胀。 */
export const CONNECTOR_AUDIT_MSG_MAX = 240;

/**
 * 探测超时（ms）。
 * 定 10s 的理由：探测是用户点按钮触发的同步等待最长路径，企业微信 / 钉钉这类
 * 国内接口通常 1s 内返回，但跨境到 GitHub / Linear 偶发 3-5s；给到 10s 足够
 * 覆盖正常抖动，又不至于让「测试连通性」按钮转圈到用户以为卡死。
 */
export const CONNECTOR_PROBE_TIMEOUT_MS = 10_000;

const AUDIT_ACTIONS: readonly ConnectorAuditAction[] = ['save', 'clear', 'test', 'test-fail'];

export function normalizeAuditEntry(raw: unknown): ConnectorAuditEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const action = AUDIT_ACTIONS.includes(r.action as ConnectorAuditAction) ? r.action as ConnectorAuditAction : null;
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : null;
  if (!id || !action || ts === null) return null;
  return { id, ts, action, message: typeof r.message === 'string' ? r.message.slice(0, CONNECTOR_AUDIT_MSG_MAX) : '' };
}

export function normalizeAuditLog(raw: unknown): ConnectorAuditEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAuditEntry).filter((e): e is ConnectorAuditEntry => e !== null);
}

/** 追加一条审计（不改原数组；越界淘汰最旧的）。 */
export function appendAudit(
  log: readonly ConnectorAuditEntry[],
  entry: ConnectorAuditEntry,
  max = CONNECTOR_AUDIT_MAX,
): ConnectorAuditEntry[] {
  const next = [...log, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

export interface AuditQuery {
  id?: string;
  action?: string;
  /** 关键词（匹配 id / message）。 */
  q?: string;
  limit?: number;
}

export function searchAudit(log: readonly ConnectorAuditEntry[], query: AuditQuery = {}): ConnectorAuditEntry[] {
  const kw = String(query.q || '').trim().toLowerCase();
  let out = log.filter((e) => {
    if (query.id && e.id !== query.id) return false;
    if (query.action && e.action !== query.action) return false;
    if (kw && !(`${e.id} ${e.message}`.toLowerCase().includes(kw))) return false;
    return true;
  });
  // 审计按时间倒序看才有意义（最近的在最上面）。
  out = out.slice().sort((a, b) => b.ts - a.ts);
  const limit = typeof query.limit === 'number' && query.limit > 0 ? query.limit : 0;
  return limit ? out.slice(0, limit) : out;
}

export function auditStats(log: readonly ConnectorAuditEntry[]): { total: number; saves: number; clears: number; tests: number; fails: number } {
  let saves = 0; let clears = 0; let tests = 0; let fails = 0;
  for (const e of log) {
    if (e.action === 'save') saves += 1;
    else if (e.action === 'clear') clears += 1;
    else if (e.action === 'test') tests += 1;
    else if (e.action === 'test-fail') fails += 1;
  }
  return { total: log.length, saves, clears, tests, fails };
}

// ============================================================================
// 持久化编解码（凭证逐字段加密；文件结构闭合，不依赖 electron）
// ============================================================================

export interface ConnectorFile {
  /** connectorId → { fieldKey → 密文 }。 */
  creds: Record<string, Record<string, string>>;
  states: Record<string, ConnectorState>;
  audit: ConnectorAuditEntry[];
}

export function emptyConnectorFile(): ConnectorFile {
  return { creds: {}, states: normalizeConnectorStates(null), audit: [] };
}

export function normalizeConnectorFile(raw: unknown): ConnectorFile {
  const r = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
  const credsRaw = (r.creds && typeof r.creds === 'object' ? r.creds as Record<string, unknown> : {});
  const creds: Record<string, Record<string, string>> = {};
  for (const [id, v] of Object.entries(credsRaw)) {
    if (!isConnectorId(id) || !v || typeof v !== 'object') continue;
    const fields: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') fields[k] = val;
    }
    creds[id] = fields;
  }
  return {
    creds,
    states: normalizeConnectorStates(r.states),
    audit: normalizeAuditLog(r.audit),
  };
}

/**
 * 取出并解密某连接器的凭证。
 * 解密失败（换机器 / 数据被篡改）返回空串 —— 调用方按「该字段未填写」处理，
 * 绝不能回落到明文，也不能拿解密失败的空值去探测（那只会得到一个必然失败的 401）。
 */
export function readCreds(file: ConnectorFile, id: string): CredMap {
  const def = getConnectorDef(id);
  if (!def) return {};
  const enc = file.creds[id] || {};
  const out: CredMap = {};
  for (const f of def.fields) {
    const cipher = enc[f.key];
    if (typeof cipher !== 'string' || !cipher) { out[f.key] = ''; continue; }
    out[f.key] = decryptSecret(cipher);
  }
  return out;
}

/** 加密写入凭证（原地修改 file.states 的 configured/savedAt；审计由调用方追加）。 */
export function writeCreds(file: ConnectorFile, id: string, creds: CredMap, now = Date.now()): void {
  const def = getConnectorDef(id);
  if (!def) return;
  const enc: Record<string, string> = {};
  for (const f of def.fields) {
    const raw = String(creds[f.key] || '');
    enc[f.key] = raw ? encryptSecret(raw) : '';
  }
  file.creds[id] = enc;
  const st = file.states[id] || emptyConnectorState(id);
  st.configured = missingRequired(def, creds).length === 0;
  st.savedAt = now;
  // 凭证变了，旧的探测结论立即作废 —— 否则会拿着 A 账号的「已连接」显示给 B 账号。
  st.lastTestAt = null;
  st.lastTestOk = null;
  st.lastTestMessage = '';
  file.states[id] = st;
}

/** 删除凭证（保留探测历史？不：凭证都没了，旧结论同样失效）。 */
export function clearCreds(file: ConnectorFile, id: string): void {
  delete file.creds[id];
  file.states[id] = emptyConnectorState(id);
}
