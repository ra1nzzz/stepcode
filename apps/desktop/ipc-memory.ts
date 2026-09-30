/**
 * 记忆 IPC（PRD FR-10）：分层记忆四域 + 晋升链 + 审计 + 摘要方式可观测。
 * 从 main.ts 抽出（M2 组合根分离）：handler 是业务面，不依赖窗口生命周期。
 * memorySummarizeSeam 标志随之迁入——bootRuntime 注入 LLM 摘要 seam 后调
 * setMemorySummarizeSeam(true)，设置页经 memory-summarize-status 读真实状态。
 */
import type { IpcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shell } from 'electron';
import { log } from './logger';
import { getService } from './dsh-runtime';
import { DATA_FILE_NAMES } from './data-dir';
import {
  normalizePromotionLog,
  appendPromotionLog,
  searchPromotionLog,
  promotionStats,
  PROMOTION_LOG_MAX,
  isMemoryDomain,
  type PromotionEntry,
  type PromotionLogQuery,
} from './memory-promotion';

export interface MemoryServiceLike {
  getStats(): unknown;
  dump(sessionId: string, msgs: unknown[], opts?: unknown): Promise<unknown>;
  /** 语义召回（TF-IDF Top-K 余弦，同步）；插件 provide 的原始形态。 */
  recall?(query: string, opts?: { domain?: string; k?: number }): unknown;
  listDomain?(domain: string): unknown;
  record?(domain: string, text: string, source: { origin: string }): unknown;
  /**
   * 晋升（异步：worker 出域要 await Director 过滤）。
   * 返回 { ok, reason }；reason 形如 `promoted:worker->director` /
   * `director-rejected:<原因>` / `brain-filter-unavailable` / `entry-not-found`。
   */
  promote?(id: string, from: string, to: string): Promise<{ ok: boolean; reason: string }>;
  /** 注入 LLM 摘要实现（FR-10 seam；未注入时插件走抽取式兜底）。 */
  setSummarize?(fn: (messages: unknown[]) => Promise<string>): void;
}

/** FR-10：摘要 seam 是否已由宿主注入（设置页据此显示当前摘要方式）。 */
let memorySummarizeSeam = false;
export function setMemorySummarizeSeam(v: boolean): void {
  memorySummarizeSeam = v;
}

/** 单次批量晋升上限（与 UI 文案/e2e 共用单源；IPC 返回值带 max 供 UI 渲染真实值）。 */
export const PROMOTE_BATCH_MAX = 20;

export interface MemoryIpcDeps {
  dataDir: () => string;
  /** 读模型配置（判断摘要 LLM 是否真的可用——没配模型就显示 extractive，不假装）。 */
  loadModelConfig: () => { providers: Array<{ name?: string; models?: string[] }>; defaultModel?: string };
}

let promotionLog: PromotionEntry[] = [];

function promotionFile(dataDir: () => string): string {
  return path.join(dataDir(), DATA_FILE_NAMES.promotions);
}

/** 启动装载：坏文件 / 缺文件 → 空审计（与沙箱日志同策略，不猜内容）。 */
export function loadPromotionLog(dataDir: () => string): number {
  try {
    promotionLog = normalizePromotionLog(JSON.parse(fs.readFileSync(promotionFile(dataDir), 'utf-8')));
  } catch {
    promotionLog = [];
  }
  // 与其他装载点（sandbox/connector/mcp）对称的启动日志：审计装载条数可见。
  if (promotionLog.length > 0) log('INFO', 'memory', `晋升审计已装载：${promotionLog.length} 条`);
  return promotionLog.length;
}

/** 写穿落盘（与沙箱日志同节奏）。落盘失败只 WARN —— 审计不是安全门，
 *  绝不能因为记不下来就回滚已经完成的晋升（那样 UI 会显示失败但实际已生效）。 */
function persistPromotionLog(dataDir: () => string): boolean {
  try {
    const file = promotionFile(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(promotionLog, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log('WARN', 'memory', `晋升审计落盘失败（不影响晋升结果）: ${(err as Error).message}`);
    return false;
  }
}

/** 取条目正文做审计摘要。取不到留空 —— 预览缺失不该让审计整条丢掉。 */
function promotionPreview(svc: MemoryServiceLike | null, domain: string, id: string): string {
  try {
    const list = (svc?.listDomain?.(domain) as Array<{ id?: string; text?: string }> | undefined) || [];
    const hit = list.find((e) => e && e.id === id);
    return String(hit?.text || '');
  } catch {
    return '';
  }
}

/** 记一条晋升审计（成功与失败都记：被拦下的晋升比成功的更有追溯价值）。 */
function recordPromotion(dataDir: () => string, input: {
  from: string;
  to: string;
  memoryId: string;
  preview: string;
  ok: boolean;
  reason: string;
  actor: 'user' | 'auto';
}): void {
  if (!isMemoryDomain(input.from) || !isMemoryDomain(input.to)) return;
  const before = promotionLog.length;
  promotionLog = appendPromotionLog(promotionLog, { ...input, ts: Date.now() });
  if (promotionLog.length !== before) {
    persistPromotionLog(dataDir);
    log('INFO', 'memory', `记忆晋升${input.ok ? '成功' : '被拦'}：${input.from}→${input.to} · ${input.reason}（${input.actor}）`);
  }
}

export function registerMemoryIpc(ipc: IpcMain, deps: MemoryIpcDeps): void {
  const { dataDir, loadModelConfig } = deps;

  ipc.handle('orchdesk:memory-stats', () => {
    const svc = getService<MemoryServiceLike>('memory');
    return svc ? svc.getStats() : null;
  });
  /**
   * 当前摘要方式（可观测性）：seam 注入了 + 配置了模型才走 LLM，
   * 否则自动转储一律走抽取式兜底 —— 这个值就是判断依据，避免「以为在用
   * LLM 摘要，其实一直在兜底」这种无从发现的降级。
   */
  ipc.handle('orchdesk:memory-summarize-status', () => {
    let providerName = '';
    let model = '';
    try {
      const cfg = loadModelConfig();
      const p = cfg.providers[0];
      providerName = p?.name ? String(p.name) : '';
      // 没有提供商就**不要**拿 cfg.defaultModel 顶上（默认是 'qwen3:14b'）——
      // 那会让「一个模型都没配」显示成「正在用 qwen3:14b 做 LLM 摘要」，
      // 恰恰是这个功能最需要避免的假象（用 mock 网关跑真链路时抓到的）。
      model = p ? String((p.models || [])[0] || cfg.defaultModel || '') : '';
    } catch { /* 配置读取失败按「未配置」处理，不阻断设置页渲染 */ }
    const ready = memorySummarizeSeam && !!model;
    return { seam: memorySummarizeSeam, provider: providerName, model, mode: ready ? 'llm' : 'extractive' };
  });

  // ---------------------------------------------------------------------------
  // PRD FR-10：分层记忆晋升（第十四个死挂点）
  // ---------------------------------------------------------------------------
  // 插件里 promote() 的实现是完整的 —— worker→director 走 brain 过滤、fail-closed、
  // 默认拒绝，全都写好了。但全项目**零调用方**：没有任何代码、没有任何按钮调用它。
  // 后果是 Worker 域的条目进来就出不去，四域实际退化为「global 域 + 三个摆设」，
  // PRD 那句「Worker 输出须经 Director 过滤才能晋升上层」等于没落地。
  //
  // 这里补的是调用链（桥），不是能力本身：
  //   - 单条晋升：用户在设置页点，方向任意，worker 出域必过 Director 过滤。
  //   - 批量晋升：一次性把 worker 域的结论过一遍 Director（见 PROMOTE_BATCH_MAX 注释）。
  //   - 晋升审计：成功与失败都记，写穿落盘（PRD「须显式操作并写审计」）。
  // ---------------------------------------------------------------------------

  /** 列出某域条目（渲染层展示用；正文字段原样透传，截断由 UI 决定）。 */
  ipc.handle('orchdesk:memory-list', async (_e, domain: string) => {
    const svc = getService<MemoryServiceLike>('memory');
    if (!svc?.listDomain) return null;
    if (!isMemoryDomain(domain)) return null;
    try {
      const list = (svc.listDomain(domain) as Array<unknown> | undefined) || [];
      return list.map((e) => {
        const r = e as { id?: string; text?: string; source?: { origin?: string; agent?: string }; createdAt?: number };
        return {
          id: String(r.id || ''),
          text: String(r.text || ''),
          origin: String(r.source?.origin || ''),
          agent: String(r.source?.agent || ''),
          createdAt: Number(r.createdAt) || 0,
        };
      });
    } catch {
      return null;
    }
  });

  /** 单条晋升。domain 非法 / 服务缺失 → 拒绝且不入审计（参数错误不值得留痕）。 */
  ipc.handle('orchdesk:memory-promote', async (_e, input: unknown) => {
    const r = (input || {}) as { id?: string; from?: string; to?: string };
    const svc = getService<MemoryServiceLike>('memory');
    if (!svc?.promote) return { ok: false, reason: 'memory-service-unavailable' };
    if (!isMemoryDomain(r.from) || !isMemoryDomain(r.to)) return { ok: false, reason: 'bad-domain' };
    const id = String(r.id || '').trim();
    if (!id) return { ok: false, reason: 'bad-id' };

    const preview = promotionPreview(svc, r.from, id);
    let result: { ok: boolean; reason: string };
    try {
      result = await svc.promote(id, r.from, r.to);
    } catch (err) {
      result = { ok: false, reason: `error:${(err as Error).message}` };
    }
    recordPromotion(dataDir, {
      from: r.from, to: r.to, memoryId: id, preview,
      ok: result.ok, reason: result.reason, actor: 'user',
    });
    return result;
  });

  /**
   * 批量晋升 worker 域 → director（自动通道：每条都要过 Director 过滤）。
   *
   * 为什么设上限：promote 是异步的，worker 出域要 await brain 过滤（默认 5s 超时）。
   * worker 域理论上限 200 条，不设上限最坏情况是 UI 卡死十几分钟且无法中途取消。
   * 一次处理 PROMOTE_BATCH_MAX 条（按时间正序，先处理最早的），剩下的报 remaining，
   * 用户想继续再点一次 —— 宁可多按几下，也不要一个点不动的按钮。
   */

  ipc.handle('orchdesk:memory-promote-worker', async (_e, input: unknown) => {
    const r = (input || {}) as { to?: string };
    const svc = getService<MemoryServiceLike>('memory');
    if (!svc?.promote || !svc?.listDomain) return { ok: false, reason: 'memory-service-unavailable' };
    const to = isMemoryDomain(r.to) ? r.to : 'director';
    const list = ((svc.listDomain('worker') as Array<{ id?: string; text?: string; createdAt?: number }> | undefined) || [])
      .filter((e) => e && String(e.id || ''))
      .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

    const batch = list.slice(0, PROMOTE_BATCH_MAX);
    const out = { ok: true, total: list.length, attempted: batch.length, max: PROMOTE_BATCH_MAX, promoted: 0, rejected: 0, remaining: Math.max(0, list.length - batch.length), reasons: [] as Array<{ id: string; ok: boolean; reason: string }> };
    for (const item of batch) {
      const id = String(item.id || '');
      let result: { ok: boolean; reason: string };
      try {
        result = await svc.promote(id, 'worker', to);
      } catch (err) {
        result = { ok: false, reason: `error:${(err as Error).message}` };
      }
      if (result.ok) out.promoted++;
      else out.rejected++;
      out.reasons.push({ id, ok: result.ok, reason: result.reason });
      recordPromotion(dataDir, {
        from: 'worker', to, memoryId: id, preview: String(item.text || ''),
        ok: result.ok, reason: result.reason, actor: 'auto',
      });
    }
    return out;
  });

  /** 晋升审计可查（关键词 / 源域 / 目标域 / 成功失败 四维过滤）。 */
  ipc.handle('orchdesk:memory-promotions', async (_e, query: unknown) => {
    const q = (query || {}) as PromotionLogQuery;
    return {
      entries: searchPromotionLog(promotionLog, q),
      stats: promotionStats(promotionLog),
      total: promotionLog.length,
      max: PROMOTION_LOG_MAX,
    };
  });

  ipc.handle('orchdesk:memory-promotions-clear', async () => {
    const cleared = promotionLog.length;
    promotionLog = [];
    persistPromotionLog(dataDir);
    return { ok: true, cleared };
  });

  /** 外链白名单：渲染层 <a href> 会导航整个窗口，必须走 shell.openExternal；且只放行 http/https。 */
  ipc.handle('orchdesk:open-external', async (_e, url: unknown) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return { ok: false, reason: '仅允许 http/https 链接' };
    try { await shell.openExternal(u); return { ok: true }; }
    catch (err) { return { ok: false, reason: (err as Error).message }; }
  });
}
