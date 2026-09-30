/**
 * models.dev 目录 + 提供商可用模型实时拉取（设计：方案 A 双源合并）。
 * ----------------------------------------------------------------------------
 * live 优先：填了 KEY 就调提供商自己的 /models（OpenAI 兼容 GET {base}/models +
 * Bearer；Ollama GET {base}/api/tags，404 回退 /v1/models）——拿到的是「这把 KEY
 * 真正可用」的模型；models.dev 静态目录负责两件事： preset 预设（名称/baseUrl
 * 预填）与 live 结果的元数据增强（上下文/定价/能力）。live 失败时回退目录列表，
 * 两者都不可用才 ok:false——渲染层始终保留手动输入兜底，本模块永不阻断保存。
 *
 * 不依赖 electron：缓存目录 / fetch / 时钟均由 initModelCatalog 注入（同
 * model-client 约定）。models.dev 只有 /api.json 一个数据端点（无 KEY 校验类
 * API，已实测），因此「KEY 能拉什么」只能问提供商自己。
 */

export const CATALOG_URL = 'https://models.dev/api.json';
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_FILE = 'models-dev-catalog.json';
const LIVE_TIMEOUT_MS = 8000;
// 目录文件约 4.8MB：慢网（1Mbps≈40s）下 12s 会误判不可用，取 20s 折中
const CATALOG_TIMEOUT_MS = 20000;

export type CatalogModel = {
  /** 目录全 id（provider/model），如 openai/gpt-5 */
  id: string;
  name: string;
  ctx?: number;
  priceIn?: number;
  priceOut?: number;
  caps?: string[];
};

export type CatalogProvider = {
  id: string;
  name: string;
  api?: string;
  doc?: string;
  env?: string[];
  models: CatalogModel[];
};

export type CatalogProviderLite = {
  id: string;
  name: string;
  api?: string;
  modelCount: number;
};

export type AvailableModel = {
  id: string;
  name?: string;
  ctx?: number;
  priceIn?: number;
  priceOut?: number;
  caps?: string[];
  /** true = 元数据来自 models.dev 目录（而非 live 响应自带） */
  enriched?: boolean;
};

export type LiveFailKind =
  | 'auth' | 'network' | 'timeout' | 'no-endpoint'
  | 'rate-limit' | 'server' | 'shape' | 'http';

export type ListModelsInput = {
  type: string;
  baseUrl: string;
  apiKey?: string;
  presetId?: string;
};

export type ListModelsResult =
  | { ok: true; source: 'live' | 'catalog' | 'mixed'; models: AvailableModel[]; matched?: { id: string; name: string; api?: string } }
  | { ok: false; reason: string };

export type FetchImpl = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

type Deps = {
  cacheDir: string;
  fetchImpl?: FetchImpl;
  now?: () => number;
  readFile?: (p: string) => string;
  writeFile?: (p: string, data: string) => void;
};

let deps: Deps = { cacheDir: '' };
let catalogInflight: Promise<CatalogProvider[] | null> | null = null;

export function initModelCatalog(d: Deps): void {
  deps = { fetchImpl: globalThis.fetch as unknown as FetchImpl, now: () => Date.now(), ...d };
}

/* ---------- 目录：拉取 / 缓存 / 解析 ---------- */

function normalizeHost(url: string): string {
  return String(url || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** api.json → 内部结构。只挑渲染层要用的字段，缓存体积约为原文件的 1/3。 */
export function parseCatalog(json: unknown): CatalogProvider[] {
  if (!json || typeof json !== 'object') return [];
  const out: CatalogProvider[] = [];
  for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const modelsRaw = (p.models && typeof p.models === 'object' ? p.models : {}) as Record<string, unknown>;
    const models: CatalogModel[] = [];
    for (const [mid, mraw] of Object.entries(modelsRaw)) {
      if (!mraw || typeof mraw !== 'object') continue;
      const m = mraw as Record<string, unknown>;
      const limit = (m.limit && typeof m.limit === 'object' ? m.limit : {}) as Record<string, unknown>;
      const cost = (m.cost && typeof m.cost === 'object' ? m.cost : {}) as Record<string, unknown>;
      const caps: string[] = [];
      if (m.tool_call === true) caps.push('tool_call');
      if (m.reasoning === true) caps.push('reasoning');
      models.push({
        id: mid,
        name: typeof m.name === 'string' && m.name ? m.name : mid,
        ctx: num(limit.context),
        priceIn: num(cost.input),
        priceOut: num(cost.output),
        caps: caps.length ? caps : undefined,
      });
    }
    out.push({
      id,
      name: typeof p.name === 'string' && p.name ? p.name : id,
      api: typeof p.api === 'string' ? p.api : undefined,
      doc: typeof p.doc === 'string' ? p.doc : undefined,
      env: Array.isArray(p.env) ? p.env.filter((e): e is string => typeof e === 'string') : undefined,
      models,
    });
  }
  return out;
}

function catalogCachePath(): string {
  return deps.cacheDir ? deps.cacheDir.replace(/[\\/]+$/, '') + '/' + CATALOG_FILE : '';
}

function readCache(): CatalogProvider[] | null {
  const p = catalogCachePath();
  if (!p || !deps.readFile) return null;
  try {
    const parsed = JSON.parse(deps.readFile(p)) as { fetchedAt?: number; providers?: CatalogProvider[] };
    if (!parsed || !Array.isArray(parsed.providers) || parsed.providers.length < 10) return null;
    if (typeof parsed.fetchedAt !== 'number') return null;
    if ((deps.now?.() ?? Date.now()) - parsed.fetchedAt > CATALOG_TTL_MS) return null;
    return parsed.providers;
  } catch {
    return null;
  }
}

function writeCache(providers: CatalogProvider[]): void {
  const p = catalogCachePath();
  if (!p || !deps.writeFile) return;
  try {
    deps.writeFile(p, JSON.stringify({ fetchedAt: deps.now?.() ?? Date.now(), providers }));
  } catch {
    /* 缓存写失败不影响本次使用 */
  }
}

async function downloadCatalog(): Promise<CatalogProvider[]> {
  const res = await (deps.fetchImpl as FetchImpl)(CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`catalog http ${res.status}`);
  const providers = parseCatalog(await res.json());
  if (providers.length < 10) throw new Error('catalog payload 异常（提供商不足 10 个）');
  writeCache(providers);
  return providers;
}

/** 取目录（缓存优先，陈旧/无缓存则联网，在途去重）。失败返回 null，不抛。 */
export async function getCatalogProviders(): Promise<CatalogProvider[] | null> {
  const cached = readCache();
  if (cached) return cached;
  if (!catalogInflight) {
    catalogInflight = downloadCatalog()
      .catch(() => null)
      .finally(() => { catalogInflight = null; });
  }
  return catalogInflight;
}

/** 预设下拉数据（名称排序，稳定输出）。目录不可用 → ok:false。 */
export async function getCatalogPresets(): Promise<{ ok: boolean; providers: CatalogProviderLite[]; reason?: string }> {
  const providers = await getCatalogProviders();
  if (!providers) return { ok: false, providers: [], reason: 'models.dev 目录不可用（离线或暂未缓存），可手动填写' };
  return {
    ok: true,
    providers: providers
      .map((p) => ({ id: p.id, name: p.name, api: p.api, modelCount: p.models.length }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function refreshCatalogInBackground(): void {
  void getCatalogProviders();
}

/* ---------- 匹配：preset → URL 主机名 → 名称 ---------- */

function normalizeName(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 三级匹配：presetId 精确 → baseUrl 主机名（对照目录 api 主机）→ 名称归一化。 */
export function matchProvider(
  providers: CatalogProvider[],
  input: { presetId?: string; baseUrl?: string; name?: string },
): CatalogProvider | null {
  if (!providers.length) return null;
  if (input.presetId) {
    const exact = providers.find((p) => p.id === input.presetId);
    if (exact) return exact;
  }
  const host = normalizeHost(input.baseUrl || '');
  if (host) {
    const byHost = providers.find((p) => p.api && normalizeHost(p.api) === host);
    if (byHost) return byHost;
  }
  const nn = normalizeName(input.name || '');
  if (nn) {
    const byName = providers.find((p) => normalizeName(p.name) === nn || normalizeName(p.id) === nn);
    if (byName) return byName;
    // 包含式兜底：用户常把网关命名为「OpenAI 兼容网关」「DeepSeek 代理」之类。
    // 设 4 字符下限，避免 "ai" 这类短名误匹配一片。
    if (nn.length >= 4) {
      const loose = providers.find((p) => {
        const pn = normalizeName(p.name);
        return pn.length >= 4 && (nn.includes(pn) || pn.includes(nn));
      });
      if (loose) return loose;
    }
  }
  return null;
}

/* ---------- live 拉取：URL / 形态 / 错误分类 ---------- */

function modelIdOf(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && o.id) return o.id;
    if (typeof o.name === 'string' && o.name) return o.name;
  }
  return null;
}

/** 三种常见形态：{data:[{id}]} / {models:[{id|name}]} / 纯字符串数组。ollama 优先 {models:[{name}]}。 */
export function extractModelIds(json: unknown, type: string): string[] | null {
  if (Array.isArray(json)) return json.map(modelIdOf).filter((x): x is string => !!x);
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  for (const key of type === 'ollama' ? ['models', 'data'] : ['data', 'models']) {
    const arr = j[key];
    if (Array.isArray(arr)) {
      const ids = arr.map(modelIdOf).filter((x): x is string => !!x);
      if (ids.length) return ids;
    }
  }
  return null;
}

const FAIL_REASON: Record<LiveFailKind, string> = {
  auth: 'KEY 无效或无权访问模型列表（401/403）',
  network: '网络不可达',
  timeout: '获取超时',
  'no-endpoint': '该提供商不提供 /models 列表端点',
  'rate-limit': '触发限流（429），稍后重试',
  server: '提供商服务端错误',
  shape: '模型列表响应形态无法识别',
  http: '请求失败',
};

function classifyHttp(status: number): LiveFailKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'no-endpoint';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  return 'http';
}

async function fetchOnce(url: string, apiKey: string | undefined, fetchImpl: FetchImpl): Promise<{ ok: true; json: unknown } | { ok: false; kind: LiveFailKind; status?: number }> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res: Awaited<ReturnType<FetchImpl>>;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (/abort|timeout/i.test(msg)) return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'network' };
  }
  if (!res.ok) return { ok: false, kind: classifyHttp(res.status), status: res.status };
  try {
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, kind: 'shape' };
  }
}

/** 实时拉取该提供商/baseUrl 下可用模型 id 列表。 */
export async function fetchLiveModels(
  input: { type: string; baseUrl: string; apiKey?: string },
  fetchImpl?: FetchImpl,
): Promise<{ ok: true; ids: string[] } | { ok: false; kind: LiveFailKind; status?: number }> {
  const f = fetchImpl ?? (deps.fetchImpl as FetchImpl);
  const base = String(input.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, kind: 'no-endpoint' };
  const ollama = input.type === 'ollama';
  const first = await fetchOnce(`${base}${ollama ? '/api/tags' : '/models'}`, ollama ? undefined : input.apiKey, f);
  if (first.ok) {
    const ids = extractModelIds(first.json, input.type);
    if (ids && ids.length) return { ok: true, ids };
    return { ok: false, kind: 'shape' };
  }
  // ollama 老版本无 /api/tags：回退 OpenAI 形态 /v1/models
  if (ollama && first.kind === 'no-endpoint') {
    const second = await fetchOnce(`${base}/v1/models`, input.apiKey, f);
    if (second.ok) {
      const ids = extractModelIds(second.json, 'openai-compatible');
      if (ids && ids.length) return { ok: true, ids };
      return { ok: false, kind: 'shape' };
    }
    return second;
  }
  return first;
}

/* ---------- enrich：live id × 目录元数据 ---------- */

function shortId(catalogId: string): string {
  const i = catalogId.indexOf('/');
  return i >= 0 ? catalogId.slice(i + 1) : catalogId;
}

/** 精确 id → provider/model 后缀 → 归一化包含，三级匹配挂元数据；未命中原样保留。 */
export function enrichModels(liveIds: string[], matched: CatalogProvider | null): AvailableModel[] {
  if (!matched) return liveIds.map((id) => ({ id }));
  const used = new Set<CatalogModel>();
  return liveIds.map((id) => {
    const exact = matched.models.find((m) => m.id === id && !used.has(m));
    const suffix = exact ?? matched.models.find((m) => !used.has(m) && shortId(m.id) === id);
    const loose = suffix ?? matched.models.find((m) => !used.has(m) && (m.id.toLowerCase().includes(id.toLowerCase()) || id.toLowerCase().includes(shortId(m.id).toLowerCase())));
    if (!loose) return { id };
    used.add(loose);
    return { id, name: loose.name, ctx: loose.ctx, priceIn: loose.priceIn, priceOut: loose.priceOut, caps: loose.caps, enriched: true };
  });
}

/* ---------- 主编排：live 优先 → 目录回退 ---------- */

export async function listAvailableModels(input: ListModelsInput): Promise<ListModelsResult> {
  const providers = await getCatalogProviders();
  const matched = providers ? matchProvider(providers, input) : null;
  const live = await fetchLiveModels(input);
  if (live.ok) {
    const models = enrichModels(live.ids, matched);
    const enriched = models.some((m) => m.enriched);
    return {
      ok: true,
      source: enriched ? 'mixed' : 'live',
      models,
      matched: matched ? { id: matched.id, name: matched.name, api: matched.api } : undefined,
    };
  }
  // live 失败：目录回退（仅当 preset/host 匹配到了具体提供商）
  if (matched && matched.models.length) {
    return {
      ok: true,
      source: 'catalog',
      models: matched.models.map((m) => ({ id: m.id, name: m.name, ctx: m.ctx, priceIn: m.priceIn, priceOut: m.priceOut, caps: m.caps })),
      matched: { id: matched.id, name: matched.name, api: matched.api },
    };
  }
  return { ok: false, reason: FAIL_REASON[live.kind] };
}
