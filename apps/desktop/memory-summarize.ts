/**
 * FR-10 记忆摘要 seam 的宿主侧实现（纯逻辑，零 electron 依赖）
 * ----------------------------------------------------------------------------
 * 背景：memory 插件早就声明了 `setSummarize()` 摘要 seam，但全项目**零调用方**
 * —— 自动转储（上下文达 80%）永远走 `summarizeExtractiveTexts` 抽取式兜底
 * （首尾各 3 条截断 200 字），PRD FR-10 要求的「LLM 摘要」从未真正发生。
 * 这是第十五个死挂点：** seam 在、实现在，就是没人来接线**。
 *
 * 本文件放**纯逻辑**（提示词构造 / 消息文本抽取 / 超时 / 摘要裁剪），
 * 真正的模型调用 `callModel` 留在 main.ts（那里才有 electron 与 provider 配置）。
 * 这样本文件的全部行为都可以脱离 electron 直接测。
 *
 * 设计取舍：LLM 摘要要不要改写成自己的话？
 * —— **不要**。召回端是本地 TF-IDF，纯词面匹配：模型把「PostgreSQL 连接池」
 *    润色成「数据库连接管理」，用户下次问「postgresql」就再也命中不了。
 *    所以提示词明确要求**保留原文关键名词 / 专有名词 / 数字 / 路径**，
 *    只做压缩不做改写（见 SUMMARIZE_SYSTEM）。
 */

/** 摘要模型的系统提示词。 */
export const SUMMARIZE_SYSTEM = [
  '你是记忆压缩器。把一段对话压缩成可供日后检索的简短记忆。',
  '硬性要求：',
  '1. 只压缩，不改写：保留原文的关键名词、专有名词、文件名、路径、数字、结论；',
  '   同义替换会让日后按原词检索时检索不到。',
  '2. 第三人称陈述句，不要「用户说」「助手回答」这类对话壳。',
  '3. 只输出摘要正文，不要前缀、不要解释、不要 markdown 标题。',
  '4. 控制在 200 字以内。',
].join('\n');

/** 送进模型的原文上限（字符）。超长先截断，避免一次转储吃掉大量 token。 */
export const SUMMARIZE_MAX_INPUT = 8_000;

/** 摘要超时（毫秒）。转储是 fire-and-forget 的后台动作，绝不能拖住对话。 */
export const SUMMARIZE_TIMEOUT_MS = 20_000;

/** 摘要正文上限（字符）。超出截断——记忆条目太长会稀释 TF-IDF。 */
export const SUMMARIZE_MAX_OUTPUT = 400;

export interface SummarizeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 从消息里取纯文本。
 *
 * 与 memory 插件的 messageText 同形：dsh UserMessage.content 原生形状是
 * ContentBlock[]（{ type:'text', text }），但 host 侧也可能拿到已经拍平的字符串
 * （分块路径就是字符串）。两种都要吃，其它形状一律 '' —— 宁可少摘一句，
 * 也不能让 .match/.slice 抛错把整个转储打断。
 */
export function extractSummarizeText(msg: unknown): string {
  const content = (msg as { content?: unknown } | null | undefined)?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      const t = (b as { text?: unknown } | null | undefined)?.text;
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
    return parts.join('\n');
  }
  return '';
}

/** 把待摘要文本拼成模型输入（超长截断，保留尾部——最近的内容通常最关键）。 */
export function joinSummarizeInput(texts: readonly string[], maxChars = SUMMARIZE_MAX_INPUT): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : SUMMARIZE_MAX_INPUT;
  const body = texts.filter((t) => typeof t === 'string' && t.trim()).join('\n');
  if (body.length <= limit) return body;
  return `（前文已省略）\n${body.slice(body.length - limit)}`;
}

/** 构造摘要请求的消息数组（system + user）。 */
export function buildSummarizeMessages(texts: readonly string[], maxChars = SUMMARIZE_MAX_INPUT): SummarizeMessage[] {
  return [
    { role: 'system', content: SUMMARIZE_SYSTEM },
    { role: 'user', content: `请把以下对话片段压缩成一段记忆：\n\n${joinSummarizeInput(texts, maxChars)}` },
  ];
}

/** 裁剪摘要：去空白、限长。空结果返回 ''（调用方据此回落抽取式兜底）。 */
export function clampSummary(text: string, max = SUMMARIZE_MAX_OUTPUT): string {
  const limit = Number.isFinite(max) && max > 0 ? Math.trunc(max) : SUMMARIZE_MAX_OUTPUT;
  const s = String(text ?? '').trim();
  return s.length <= limit ? s : s.slice(0, limit);
}

/**
 * 给任意 Promise 套超时。
 *
 * 为什么不用 AbortSignal：摘要走的是 callModel（HTTP fetch），中断 signal 只能
 * 掐断本进程侧的等待，服务端仍会跑完；而转储是后台动作，我们只关心「别占用
 * 转储循环太久」。Promise.race 后原 Promise 不再被 await —— 其 rejection 必须
 * 自己吃掉，否则会变成 unhandledRejection 把主进程拖死。
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const limit = Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : SUMMARIZE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`summarize-timeout:${limit}ms`)), limit);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    // 超时情况下原 Promise 的 rejection 无人接管 → 显式吞掉。
    void Promise.resolve(p).catch(() => undefined);
  }
}
