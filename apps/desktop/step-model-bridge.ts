/**
 * GUI 模型配置 → Step 原生模型目录与凭据（纯函数：零 electron、零 fs、零网络）。
 * ----------------------------------------------------------------------------
 * 本 GUI 的模型页把提供商存在 OrchDesk 自己的 `models.json`（key 用 safeStorage
 * 加密）；Step 会话读的是 Step 自己的 `auth.json` / `models.json`。两边格式不同，
 * 这里只做投影，落盘由 `step-session.ts` 负责，写到 `<Step 存储根>/gui/`。
 *
 * 明文 key 由宿主（main.ts）用 safeStorage 解好再传进来；本模块不落盘、不打日志，
 * 也不持有任何全局状态。
 *
 * 与 ADR 0005 第 5 条的关系：凭据以 Step 自己的格式落在 Step 存储根内；本 GUI 不
 * 另造会话格式，只是把用户在本 GUI 里填的提供商写成 Step 认的形状。
 */

import { createHash } from 'node:crypto';

/** GUI 侧提供商（形状与 `renderer/app.js` 的 saveModelConfig 入参一致）。 */
export type GuiProvider = {
  id: string;
  name?: string;
  type?: string;
  baseUrl?: string;
  apiMode?: string;
  /** 已解密的明文 key。缺失表示用户没配（本地服务不需要）。 */
  apiKey?: string;
  models?: string[];
};

export type GuiModelConfig = {
  providers?: GuiProvider[];
  defaultProvider?: string;
  defaultModel?: string;
};

/** Step `models.json` 的形状（providers 是对象，不是数组）。 */
export type StepModelsJson = {
  providers: Record<string, { baseUrl: string; api: string; models: Array<{ id: string }> }>;
};

/** Step `auth.json` 的形状。 */
export type StepAuthJson = Record<string, { type: 'api_key'; key: string }>;

/** Ollama 不校验 key，但 Step 把「无凭据」的提供商标记为不可用（docs/models.md）。 */
export const OLLAMA_PLACEHOLDER_KEY = 'ollama';

/** GUI 的 apiMode / type → Step 的 `api` 名（docs/models.md 的四种之一）。 */
export function toStepApi(provider: GuiProvider): string {
  if (provider.type === 'ollama') return 'openai-completions';
  return provider.apiMode === 'responses' ? 'openai-responses' : 'openai-completions';
}

/**
 * GUI 的 baseUrl → Step 的 baseUrl。
 * 本 GUI 的 Ollama 走 `{base}/api/chat`，所以 baseUrl 不带 `/v1`；Step 的
 * `openai-completions` 需要 OpenAI 兼容根，故补 `/v1`。其它类型原样透传。
 */
export function toStepBaseUrl(provider: GuiProvider): string {
  const base = String(provider.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (provider.type === 'ollama' && base && !/\/v1$/.test(base)) return `${base}/v1`;
  return base;
}

/** 只保留能用（有 id、有至少一个模型）的提供商，避免把空壳写进 Step 目录。 */
function usableProviders(cfg: GuiModelConfig): Array<GuiProvider & { id: string; models: string[] }> {
  const out: Array<GuiProvider & { id: string; models: string[] }> = [];
  for (const p of cfg.providers ?? []) {
    if (!p || typeof p.id !== 'string' || !p.id) continue;
    const models = (p.models ?? []).filter((m) => typeof m === 'string' && m.trim());
    if (models.length === 0) continue;
    out.push({ ...p, id: p.id, models });
  }
  return out;
}

export function toStepModelsJson(cfg: GuiModelConfig): StepModelsJson {
  const providers: StepModelsJson['providers'] = {};
  for (const p of usableProviders(cfg)) {
    const baseUrl = toStepBaseUrl(p);
    if (!baseUrl) continue;
    providers[p.id] = {
      baseUrl,
      api: toStepApi(p),
      models: p.models.map((id) => ({ id })),
    };
  }
  return { providers };
}

export function toStepAuthJson(cfg: GuiModelConfig): StepAuthJson {
  const auth: StepAuthJson = {};
  for (const p of usableProviders(cfg)) {
    const key = String(p.apiKey ?? '').trim();
    if (key) {
      auth[p.id] = { type: 'api_key', key };
    } else if (p.type === 'ollama') {
      auth[p.id] = { type: 'api_key', key: OLLAMA_PLACEHOLDER_KEY };
    }
  }
  return auth;
}

/**
 * 选出本回合该用的模型：GUI 指定的默认提供商/模型优先，缺省退到第一个可用提供商
 * 的第一个模型；一个可用提供商都没有时返回 undefined（由调用方决定怎么报错）。
 */
export function pickDefaultModel(cfg: GuiModelConfig): { provider: string; modelId: string } | undefined {
  const list = usableProviders(cfg);
  const fallback = list[0];
  if (!fallback) return undefined;
  const wanted = cfg.defaultProvider ? list.find((p) => p.id === cfg.defaultProvider) : undefined;
  const provider = wanted ?? fallback;
  const modelId = cfg.defaultModel && provider.models.includes(cfg.defaultModel)
    ? cfg.defaultModel
    : provider.models[0];
  if (!modelId) return undefined;
  return { provider: provider.id, modelId };
}

/**
 * 会话缓存指纹：只覆盖「本回合真正用到的东西」——选中的模型，以及该提供商的目录
 * 条目与凭据。改别的提供商不会打断正在进行的对话。
 *
 * 载荷含明文 key，所以只回哈希，绝不把原文交给调用方或日志。
 */
export function configFingerprint(cfg: GuiModelConfig): string {
  const picked = pickDefaultModel(cfg);
  if (!picked) return 'none';
  const models = toStepModelsJson(cfg).providers[picked.provider];
  const auth = toStepAuthJson(cfg)[picked.provider];
  const payload = JSON.stringify({ picked, models, auth });
  return createHash('sha256').update(payload).digest('hex');
}
