/**
 * 模型用量追踪（PRD FR-5「用量追踪（可选）」）。
 *
 * 纯逻辑、零 electron 依赖，可在 node 直测（usage-registry-verify.cjs）。
 *
 * 职责：
 *   1. 归一化三家 API 的 usage 形态（OpenAI chat / OpenAI responses / Ollama）
 *      ——同一个 `normalizeApiUsage` 入口，主进程两个调用通道共用；
 *   2. 回合级用量条目的追加与聚合（按模型 / 按会话 / 合计）；
 *   3. usage.json 读写（随数据目录迁移，见 main.ts DATA_FILES）。
 *
 * 诚实边界：
 *   - 网关不回 usage 字段（部分网关如此）→ 该回合不记条目，不伪造 0；
 *   - 「没记录」≠「0 token」——聚合只统计真实上报过的回合。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 一次模型调用的 token 用量（归一化后）。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 一个 agent 回合的用量条目（一回合可能含多次模型调用，取累计值）。 */
export interface UsageEntry {
  ts: string;
  sessionId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 本回合工具步数（上下文参照，不参与聚合求和以外语义）。 */
  steps: number;
}

export interface UsageFile {
  entries: UsageEntry[];
}

/** 环形上限：超过后淘汰最旧条目。全量聚合在 5000 条内无性能压力。 */
export const USAGE_MAX_ENTRIES = 5000;

export function defaultUsageFile(): UsageFile {
  return { entries: [] };
}

/* ---------------------------------------------------------------------------
 * usage 形态归一化（三家 API）
 * ------------------------------------------------------------------------- */

/**
 * 从模型 API 原始响应体提取 usage。
 *
 * - OpenAI chat:      data.usage = { prompt_tokens, completion_tokens, total_tokens }
 * - OpenAI responses: data.usage = { input_tokens, output_tokens, total_tokens }
 * - Ollama /api/chat: data.prompt_eval_count / data.eval_count（无总数）
 *
 * 缺字段 / 非数值 → 返回 null（该调用不计入），绝不把 undefined 当 0 记账。
 */
export function normalizeApiUsage(data: unknown): TokenUsage | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as Record<string, unknown>;
  const u = body.usage as Record<string, unknown> | undefined;

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

  if (u) {
    // OpenAI chat 形态
    const p = num(u.prompt_tokens);
    const c = num(u.completion_tokens);
    if (p !== null || c !== null) {
      const total = num(u.total_tokens) ?? (p ?? 0) + (c ?? 0);
      return { promptTokens: p ?? 0, completionTokens: c ?? 0, totalTokens: total };
    }
    // OpenAI responses 形态
    const ri = num(u.input_tokens);
    const ro = num(u.output_tokens);
    if (ri !== null || ro !== null) {
      const total = num(u.total_tokens) ?? (ri ?? 0) + (ro ?? 0);
      return { promptTokens: ri ?? 0, completionTokens: ro ?? 0, totalTokens: total };
    }
    return null;
  }

  // Ollama 形态：usage 在顶层，无 usage 包裹
  const op = num(body.prompt_eval_count);
  const oc = num(body.eval_count);
  if (op !== null || oc !== null) {
    return { promptTokens: op ?? 0, completionTokens: oc ?? 0, totalTokens: (op ?? 0) + (oc ?? 0) };
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 条目追加与聚合
 * ------------------------------------------------------------------------- */

/**
 * 追加一回合用量。全部为 0 的条目照记（真实上报过 0 也是事实），
 * 但调用方在「网关完全没回 usage」时应直接不调用本函数。
 */
export function appendUsageTurn(file: UsageFile, entry: UsageEntry): UsageFile {
  const entries = file.entries.slice();
  entries.push(entry);
  // 环形淘汰最旧（淘汰语义与连接器审计一致：上限 = 保留条数）
  const overflow = entries.length - USAGE_MAX_ENTRIES;
  return { entries: overflow > 0 ? entries.slice(overflow) : entries };
}

export interface UsageAggregates {
  total: { promptTokens: number; completionTokens: number; totalTokens: number; turns: number };
  /** 按模型聚合，totalTokens 降序。 */
  byModel: Array<{ model: string; promptTokens: number; completionTokens: number; totalTokens: number; turns: number }>;
  /** 按会话聚合（Top 10，totalTokens 降序）。 */
  bySession: Array<{ sessionId: string; totalTokens: number; turns: number }>;
}

export function aggregateUsage(entries: UsageEntry[]): UsageAggregates {
  const total = { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 };
  const models = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number; turns: number }>();
  const sessions = new Map<string, { totalTokens: number; turns: number }>();
  for (const e of entries) {
    const p = Number.isFinite(e.promptTokens) ? e.promptTokens : 0;
    const c = Number.isFinite(e.completionTokens) ? e.completionTokens : 0;
    const t = Number.isFinite(e.totalTokens) ? e.totalTokens : p + c;
    total.promptTokens += p;
    total.completionTokens += c;
    total.totalTokens += t;
    total.turns += 1;
    const m = models.get(e.model) || { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 };
    m.promptTokens += p; m.completionTokens += c; m.totalTokens += t; m.turns += 1;
    models.set(e.model, m);
    const s = sessions.get(e.sessionId) || { totalTokens: 0, turns: 0 };
    s.totalTokens += t; s.turns += 1;
    sessions.set(e.sessionId, s);
  }
  const byModel = Array.from(models.entries())
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const bySession = Array.from(sessions.entries())
    .map(([sessionId, v]) => ({ sessionId, ...v }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10);
  return { total, byModel, bySession };
}

/* ---------------------------------------------------------------------------
 * 落盘（随数据目录迁移，main.ts DATA_FILES 以 copy-if-absent 登记）
 * ------------------------------------------------------------------------- */

export function readUsageFile(file: string): UsageFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<UsageFile>;
    const entries = Array.isArray(raw.entries)
      ? raw.entries.filter((e) => e && typeof e === 'object' && typeof e.model === 'string')
      : [];
    return { entries };
  } catch {
    return defaultUsageFile();
  }
}

export function writeUsageFile(file: string, data: UsageFile): { ok: boolean; reason?: string } {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
