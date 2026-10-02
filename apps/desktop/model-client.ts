/**
 * 模型 HTTP 客户端（OpenAI 兼容 + Ollama）。
 * 不依赖 electron：解密钥匙由宿主注入。可传入 AbortSignal 中止进行中的 fetch。
 */
import { normalizeNativeToolCalls, type ApiMessage, type ModelReply, type NativeToolCall, TOOL_DEFS } from './agent-runtime';
import { normalizeApiUsage } from './usage-registry';
import { logModel } from './logger';
import { isProviderBaseUrlAllowed } from './common-tools';

export type ModelProviderLike = {
  name: string;
  type: string;
  baseUrl: string;
  apiKeyEnc?: string;
  apiMode?: 'chat' | 'responses' | 'completions';
};

export type CallModelOpts = {
  signal?: AbortSignal;
  /** 增量文本（SSE/NDJSON 按 chunk；JSON 整包一次）。失败不影响回合。 */
  onDelta?: (chunk: string) => void;
};

type DecryptKey = (encB64?: string) => string;

let decryptKeyFn: DecryptKey = () => '';

export function initModelClient(deps: { decryptKey: DecryptKey }): void {
  decryptKeyFn = deps.decryptKey;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  return e.name === 'AbortError' || e.name === 'TimeoutError' || /aborted|AbortError|TimeoutError/i.test(String(e.message || ''));
}

/**
 * 单次模型 HTTP 的空闲上限。长思考会先沉默再吐字，固定 120s 硬切会把仍在生成的请求判死。
 */
export const MODEL_IDLE_MS = 300_000;
/** 单次 HTTP 绝对上限。持续有字节时不被空闲计时切断，但仍不能无限挂住。 */
export const MODEL_MAX_MS = 600_000;

/**
 * completions（旧版 /v1/completions 文本补全）模式的输出上限。
 * R1-9：原先内联 1024 且无法从调用方覆盖，长摘要场景会被静默截断。
 * 注意 chat/responses 模式不设该字段（由服务端默认值决定），保持原状。
 */
export const COMPLETIONS_MAX_TOKENS = 2048;

export type ModelAbortHandle = {
  signal: AbortSignal;
  /** 收到响应头或任意正文字节时调用，重置空闲计时。不重置绝对上限。 */
  touch: () => void;
  dispose: () => void;
};

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const t = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
  t.unref?.();
}

/**
 * 用户中止 ∪ 空闲超时 ∪ 绝对上限。
 * 超时原因的 name 固定为 AbortError，便于与网络错误区分，且不误标成用户「已停止」。
 */
export function openModelAbort(
  user?: AbortSignal,
  idleMs = MODEL_IDLE_MS,
  maxMs = MODEL_MAX_MS,
): ModelAbortHandle {
  const ac = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    idleTimer = undefined;
    maxTimer = undefined;
  };
  const abortTimeout = (why: string): void => {
    if (ac.signal.aborted) return;
    const err = new Error(why);
    err.name = 'AbortError';
    ac.abort(err);
  };
  const armIdle = (): void => {
    if (disposed || ac.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortTimeout(`idle-timeout ${idleMs}ms`), idleMs);
    unrefTimer(idleTimer);
  };
  const onUser = (): void => {
    if (!ac.signal.aborted) ac.abort(user?.reason);
  };

  if (user?.aborted) {
    ac.abort(user.reason);
  } else if (user) {
    user.addEventListener('abort', onUser, { once: true });
  }
  if (!ac.signal.aborted) {
    armIdle();
    maxTimer = setTimeout(() => abortTimeout(`max-timeout ${maxMs}ms`), maxMs);
    unrefTimer(maxTimer);
  }

  return {
    signal: ac.signal,
    touch: armIdle,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      user?.removeEventListener('abort', onUser);
    },
  };
}

/** 超时文案。秒数与 MODEL_IDLE_MS 同源，避免再写死 120s。 */
export function modelTimeoutText(hadSteps: boolean): string {
  const idleSec = Math.round(MODEL_IDLE_MS / 1000);
  if (hadSteps) {
    return `（模型调用失败）已完成的步骤已保留，但下一步 ${idleSec}s 内没有数据。可发「继续」或降低输入长度。`;
  }
  return `（模型调用失败）请求超时或连接中断（${idleSec}s 内没有数据）。可重试或降低输入长度。`;
}

function emitDelta(opts: CallModelOpts, chunk: string): void {
  if (!chunk || typeof opts.onDelta !== 'function') return;
  try { opts.onDelta(chunk); } catch { /* 渲染层失败不影响回合 */ }
}

export function looksLikeSse(raw: string): boolean {
  const t = raw.trimStart();
  return t.startsWith('data:') || t.startsWith('event:');
}

const STREAM_DROP_STATUSES = [400, 415, 422];

/** stream:true 被拒时同轮改 stream:false。含 tool 的 400 仍走工具降级，不抢先卸流。 */
export function shouldRetryWithoutStream(status: number, bodyText: string, streaming: boolean): boolean {
  if (!streaming) return false;
  if (!STREAM_DROP_STATUSES.includes(status)) return false;
  if (/stream/i.test(bodyText)) return true;
  if (/tool|function/i.test(bodyText)) return false;
  return true;
}

type SseToolAcc = { id?: string; type?: string; function?: { name?: string; arguments?: string } };

/** 行缓冲 OpenAI SSE。可多次 push，end() 冲掉最后半行。 */
export class OpenAiSseParser {
  content = '';
  finish?: unknown;
  usage?: unknown;
  /** R1-3：见过流终止标记（[DONE] 或任一 finish_reason）。连接被中途切断时为 false。 */
  sawTerminator = false;
  private buf = '';
  private toolsByIndex = new Map<number, SseToolAcc>();
  private onDelta?: (chunk: string) => void;
  constructor(onDelta?: (chunk: string) => void) {
    // R1-7：onDelta 的契约是「失败不影响回合」（同 emitDelta）。解析器内裸调时，
    // 调用方回调一抛错就穿破 readStreamingText 把整回合炸掉——这里包一层兜底。
    this.onDelta = typeof onDelta === 'function'
      ? (chunk: string) => { try { onDelta(chunk); } catch { /* 渲染层失败不影响回合 */ } }
      : undefined;
  }
  push(text: string): void {
    this.buf += text;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() || '';
    for (const line of lines) this.consumeLine(line);
  }
  end(): { content: string; toolCalls: unknown; finish?: unknown; usage?: unknown; sawTerminator: boolean } {
    if (this.buf.trim()) this.consumeLine(this.buf);
    this.buf = '';
    return { content: this.content, toolCalls: [...this.toolsByIndex.values()], finish: this.finish, usage: this.usage, sawTerminator: this.sawTerminator };
  }
  private consumeLine(line: string): void {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { this.sawTerminator = true; return; }
    let json: Record<string, unknown>;
    try { json = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
    if (json.usage) this.usage = json.usage;
    const choice = (json.choices as Array<{
      delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
      finish_reason?: unknown;
    }> | undefined)?.[0];
    if (!choice) return;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) { this.finish = choice.finish_reason; this.sawTerminator = true; }
    const delta = choice.delta;
    if (delta?.content) {
      this.content += delta.content;
      this.onDelta?.(delta.content);
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = this.toolsByIndex.get(idx) || { type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function!.name = (acc.function!.name || '') + tc.function.name;
        if (tc.function?.arguments) acc.function!.arguments = (acc.function!.arguments || '') + tc.function.arguments;
        this.toolsByIndex.set(idx, acc);
      }
    }
  }
}

export function consumeOpenAiSse(
  raw: string,
  onDelta?: (chunk: string) => void,
): { content: string; toolCalls: unknown; finish?: unknown; usage?: unknown; sawTerminator: boolean } {
  const p = new OpenAiSseParser(onDelta);
  p.push(raw);
  return p.end();
}

export class OllamaNdjsonParser {
  content = '';
  toolCalls: unknown = [];
  done_reason?: unknown;
  /** R1-3：见过流终止标记（done:true 或 done_reason）。连接被中途切断时为 false。 */
  sawTerminator = false;
  private buf = '';
  private onDelta?: (chunk: string) => void;
  constructor(onDelta?: (chunk: string) => void) {
    // R1-7：同 OpenAiSseParser——渲染层回调抛错不穿破解析器、不炸整回合。
    this.onDelta = typeof onDelta === 'function'
      ? (chunk: string) => { try { onDelta(chunk); } catch { /* 渲染层失败不影响回合 */ } }
      : undefined;
  }
  push(text: string): void {
    this.buf += text;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() || '';
    for (const line of lines) this.consumeLine(line);
  }
  end(): { content: string; toolCalls: unknown; done_reason?: unknown; sawTerminator: boolean } {
    if (this.buf.trim()) this.consumeLine(this.buf);
    this.buf = '';
    return { content: this.content, toolCalls: this.toolCalls, done_reason: this.done_reason, sawTerminator: this.sawTerminator };
  }
  private consumeLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let obj: { message?: { content?: string; tool_calls?: unknown }; done?: unknown; done_reason?: unknown };
    try { obj = JSON.parse(t) as typeof obj; } catch { return; }
    const piece = obj.message?.content || '';
    if (piece) {
      this.content += piece;
      this.onDelta?.(piece);
    }
    if (obj.message?.tool_calls) this.toolCalls = obj.message.tool_calls;
    if (obj.done === true) this.sawTerminator = true;
    if (obj.done_reason != null) { this.done_reason = obj.done_reason; this.sawTerminator = true; }
  }
}

export function consumeOllamaNdjson(
  raw: string,
  onDelta?: (chunk: string) => void,
): { content: string; toolCalls: unknown; done_reason?: unknown; sawTerminator: boolean } {
  const p = new OllamaNdjsonParser(onDelta);
  p.push(raw);
  return p.end();
}

/** 有 ReadableStream 则逐块读（真流式）；否则 res.text()。 */
export async function readStreamingText(
  res: Response,
  onPiece?: (piece: string) => void,
): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    return res.text();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      if (piece) {
        raw += piece;
        onPiece?.(piece);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      raw += tail;
      onPiece?.(tail);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return raw;
}

type BodyDetectKind = 'unknown' | 'sse' | 'ndjson';

function createBodyDetector(onDelta?: (chunk: string) => void) {
  let kind: BodyDetectKind = 'unknown';
  let buf = '';
  let sse: OpenAiSseParser | undefined;
  let nd: OllamaNdjsonParser | undefined;
  return {
    push(piece: string): void {
      if (kind === 'sse') { sse!.push(piece); return; }
      if (kind === 'ndjson') { nd!.push(piece); return; }
      buf += piece;
      const t = buf.trimStart();
      if (t.startsWith('data:') || t.startsWith('event:')) {
        kind = 'sse';
        sse = new OpenAiSseParser(onDelta);
        sse.push(buf);
        buf = '';
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const first = buf.slice(0, nl).trim();
      if (!first.startsWith('{')) return;
      try {
        const obj = JSON.parse(first) as { message?: unknown; done?: unknown };
        if (obj && (obj.message !== undefined || obj.done !== undefined)) {
          kind = 'ndjson';
          nd = new OllamaNdjsonParser(onDelta);
          nd.push(buf);
          buf = '';
        }
      } catch { /* 首行还不是完整 JSON */ }
    },
    kind(): BodyDetectKind { return kind; },
    endSse() { return sse ? sse.end() : null; },
    endNdjson() { return nd ? nd.end() : null; },
  };
}

export async function callModel(
  provider: ModelProviderLike,
  model: string,
  messages: ApiMessage[],
  toolDefs: typeof TOOL_DEFS = [],
  opts: CallModelOpts = {},
): Promise<ModelReply> {
  if (provider.type === 'ollama') {
    return callOllama(provider, model, messages, toolDefs, opts);
  }
  return callOpenAICompatible(provider, model, messages, toolDefs, opts);
}

export async function callOllama(
  provider: ModelProviderLike,
  model: string,
  messages: ApiMessage[],
  toolDefs: typeof TOOL_DEFS = [],
  opts: CallModelOpts = {},
): Promise<ModelReply> {
  const url = provider.baseUrl.replace(/\/$/, '') + '/api/chat';
  const t0 = Date.now();
  let abort: ModelAbortHandle | undefined;
  const disposeAbort = (): void => { abort?.dispose(); abort = undefined; };
  const post = async (stream: boolean): Promise<Response> => {
    disposeAbort();
    abort = openModelAbort(opts.signal);
    const body: Record<string, unknown> = { model, messages, stream };
    if (toolDefs.length) body.tools = toolDefs;
    logModel('request', { provider: provider.name, model, apiMode: 'ollama', url, toolCalls: toolDefs.length });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      abort.touch();
      return res;
    } catch (err) {
      logModel('error', { provider: provider.name, model, apiMode: 'ollama', url, ms: Date.now() - t0, error: (err as Error).message });
      throw err;
    }
  };
  let res: Response;
  try {
  res = await post(true);
  if (!res.ok) {
    const txt = await res.text();
    if (shouldRetryWithoutStream(res.status, txt, true)) {
      logModel('error', { provider: provider.name, model, apiMode: 'ollama', url, status: res.status, error: `stream 降级：${txt.slice(0, 120)}` });
      res = await post(false);
    } else {
      throw new Error(`Ollama 返回 HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }
  }
  if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const detector = createBodyDetector(opts.onDelta);
  let rawBody: string;
  try {
    rawBody = await readStreamingText(res, (piece) => {
      abort?.touch();
      detector.push(piece);
    });
  } catch (err) {
    logModel('error', { provider: provider.name, model, apiMode: 'ollama', url, ms: Date.now() - t0, error: (err as Error).message });
    throw err;
  }
  let data: {
    message?: { content?: string; tool_calls?: unknown };
    error?: string;
    done_reason?: string;
  };
  const nd = detector.kind() === 'ndjson' ? detector.endNdjson() : null;
  if (nd && (nd.content || (Array.isArray(nd.toolCalls) && nd.toolCalls.length))) {
    const toolCalls = normalizeNativeToolCalls(nd.toolCalls);
    logModel('response', {
      provider: provider.name, model, apiMode: 'ollama', url,
      status: res.status, ms: Date.now() - t0,
      contentLen: nd.content.length, toolCalls: toolCalls.length,
    });
    return {
      content: nd.content,
      toolCalls,
      source: toolCalls.length ? 'native' : 'none',
      // R1-3：流未见到终止标记（done:true/done_reason）就结束 = 连接可能被中途切断，
      // content 只是部分内容。非流式整包 JSON 不置此位。
      truncated: !nd.sawTerminator && nd.content ? true : undefined,
      emptyReason: (!nd.content && !toolCalls.length)
        ? emptyContentReason({
            provider: provider.name, model, mode: 'ollama', status: res.status,
            finish: nd.done_reason, bodySnippet: rawBody.slice(0, 200),
          })
        : undefined,
    };
  }
  try {
    data = JSON.parse(rawBody) as typeof data;
  } catch {
    const streamed = consumeOllamaNdjson(rawBody, opts.onDelta);
    if (streamed.content || (Array.isArray(streamed.toolCalls) && streamed.toolCalls.length)) {
      const toolCalls = normalizeNativeToolCalls(streamed.toolCalls);
      logModel('response', {
        provider: provider.name, model, apiMode: 'ollama', url,
        status: res.status, ms: Date.now() - t0,
        contentLen: streamed.content.length, toolCalls: toolCalls.length,
      });
      return {
        content: streamed.content,
        toolCalls,
        source: toolCalls.length ? 'native' : 'none',
        // R1-3：同 nd 路径——回退解析同样可能拿到被切断的流。
        truncated: !streamed.sawTerminator && streamed.content ? true : undefined,
        emptyReason: (!streamed.content && !toolCalls.length)
          ? emptyContentReason({
              provider: provider.name, model, mode: 'ollama', status: res.status,
              finish: streamed.done_reason, bodySnippet: rawBody.slice(0, 200),
            })
          : undefined,
      };
    }
    // R1-2：能按 JSON/NDJSON 解析但零内容时，返回空内容诊断而不是抛「非 JSON 响应」。
    // 原文案在「合法 JSON、模型就是没说话」时也报「返回非 JSON 响应」并附 body 片段——
    // 事实错误，且丢掉了 OpenAI 路径同款的 emptyContentReason 诊断（provider/model/
    // apiMode/finish_reason），用户分不清「模型空回复」与「网关故障」。
    if (/^\s*\{/.test(rawBody)) {
      logModel('response', {
        provider: provider.name, model, apiMode: 'ollama', url,
        status: res.status, ms: Date.now() - t0, contentLen: 0, toolCalls: 0,
      });
      return {
        content: '',
        toolCalls: [],
        source: 'none',
        emptyReason: emptyContentReason({
          provider: provider.name, model, mode: 'ollama', status: res.status,
          finish: streamed.done_reason, bodySnippet: rawBody.slice(0, 200),
        }),
      };
    }
    throw new Error(`Ollama 返回非 JSON 响应（HTTP ${res.status}）: ${rawBody.slice(0, 200)}`);
  }
  if (data.error) throw new Error(data.error);

  const toolCalls = normalizeNativeToolCalls(data.message?.tool_calls);
  const content = data.message?.content || '';
  emitDelta(opts, content);
  logModel('response', {
    provider: provider.name, model, apiMode: 'ollama', url,
    status: res.status, ms: Date.now() - t0,
    contentLen: content.length, toolCalls: toolCalls.length,
  });
  return {
    content,
    toolCalls,
    source: toolCalls.length ? 'native' : 'none',
    usage: normalizeApiUsage(data) || undefined,
    emptyReason: (!content && !toolCalls.length)
      ? emptyContentReason({
          provider: provider.name,
          model,
          mode: 'ollama',
          status: res.status,
          finish: data.done_reason,
          bodySnippet: rawBody.slice(0, 200),
        })
      : undefined,
  };
  } finally {
    disposeAbort();
  }
}

export function buildRequest(base: string, mode: 'chat' | 'responses' | 'completions', model: string, messages: ApiMessage[], stream = false): { url: string; body: Record<string, unknown> } {
  const isFullEndpoint = /\/chat\/completions|\/responses|\/completions/.test(base);
  const clean = base.replace(/\/v1\/?$/, '');

  if (mode === 'responses') {
    const input = messages.map(m => ({
      role: m.role === 'system' ? 'developer' as const : m.role,
      content: m.content || '',
    }));
    return {
      url: isFullEndpoint ? base : clean + '/v1/responses',
      body: { model, input },
    };
  }
  if (mode === 'completions') {
    return {
      url: isFullEndpoint ? base : clean + '/v1/completions',
      body: { model, prompt: messages.map(m => `${m.role}: ${m.content || ''}`).join('\n'), max_tokens: COMPLETIONS_MAX_TOKENS },
    };
  }
  return {
    url: isFullEndpoint ? base : clean + '/v1/chat/completions',
    body: { model, messages, stream },
  };
}

export function pickOpenAIContent(data: Record<string, unknown>, mode: 'chat' | 'responses' | 'completions'): string {
  if (mode === 'responses') {
    const direct = (data as { output_text?: string }).output_text;
    if (typeof direct === 'string' && direct) return direct;
    const out = (data as { output?: Array<{ type?: string; content?: Array<{ text?: string }> }> }).output;
    if (Array.isArray(out)) {
      const parts: string[] = [];
      for (const item of out) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
      if (parts.length) return parts.join('\n');
    }
    return '';
  }
  if (mode === 'completions') {
    return ((data as { choices?: Array<{ text?: string }> }).choices?.[0]?.text || '');
  }
  const raw = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
      ? (c as { text: string }).text
      : '')).join('');
  }
  return '';
}

export function emptyContentReason(opts: { provider: string; model: string; mode: string; status: number; finish?: unknown; bodySnippet: string }): string {
  const parts = [
    '模型返回空内容',
    `provider=${opts.provider}`,
    `model=${opts.model}`,
    `apiMode=${opts.mode}`,
    `HTTP ${opts.status}`,
  ];
  if (opts.finish !== undefined) parts.push(`finish_reason=${String(opts.finish)}`);
  if (opts.bodySnippet) parts.push(`响应片段: ${opts.bodySnippet}`);
  return `（${parts.join(' · ')}）`;
}

export async function callOpenAICompatible(
  provider: ModelProviderLike,
  model: string,
  messages: ApiMessage[],
  toolDefs: typeof TOOL_DEFS = [],
  opts: CallModelOpts = {},
): Promise<ModelReply> {
  const apiKey = decryptKeyFn(provider.apiKeyEnc);
  if (!apiKey) throw new Error(`提供商「${provider.name}」未配置 API Key，请先在设置页配置`);
  const mode = provider.apiMode || 'chat';
  // BUG-054：这里就是密钥出门的地方——先把「发往哪里」校验掉，不合法就拒发（fail-closed），
  // 而不是先把 Bearer 头组好再祈祷用户没填 http。
  const baseGate = isProviderBaseUrlAllowed(provider.baseUrl);
  if (!baseGate.ok) throw new Error(`提供商「${provider.name}」的 baseUrl 被拒绝：${baseGate.reason}`);
  const base = provider.baseUrl.replace(/\/+$/, '');

  const canUseTools = mode === 'chat' && toolDefs.length > 0;
  const attempts: Array<{ tools: boolean; toolChoice: boolean }> = canUseTools
    ? [{ tools: true, toolChoice: true }, { tools: true, toolChoice: false }, { tools: false, toolChoice: false }]
    : [{ tools: false, toolChoice: false }];

  let lastErr = '';
  let preferStream = mode === 'chat';
  // M-1：只有「明确指向工具协议」的拒绝才允许把 provider 标记为不吃工具。
  // 空 content / finish=length / 内容过滤 / 网关抖动 → 继续按普通失败爬梯，绝不毒化。
  // 特征用严匹配：网关 400 文案偶然含 "function"（如 JS 异常堆栈）不应误判（二审收口）。
  const TOOL_PROTOCOL_REJECT_RE = /tool|function\s*call|function calling/i;
  let toolProtocolRejected = false;
  // 轮内软降级计数：带 tools 的尝试失败次数（去掉 tools 才成功 → softToolsFallback）。
  let toolsAttemptFailed = 0;
  let modelAbort: ModelAbortHandle | undefined;
  const disposeModelAbort = (): void => { modelAbort?.dispose(); modelAbort = undefined; };
  try {
  attLoop: for (const att of attempts) {
    const streamTries = preferStream ? [true, false] : [false];
    for (const useStream of streamTries) {
    const { url, body } = buildRequest(base, mode, model, messages, useStream);
    if (att.tools) {
      body.tools = toolDefs;
      if (att.toolChoice) body.tool_choice = 'auto';
    }
    const t0 = Date.now();
    logModel('request', {
      provider: provider.name, model, apiMode: mode, url,
      toolCalls: att.tools ? toolDefs.length : 0,
      ...(att.tools ? {} : { error: canUseTools ? `tools 降级（att.tools=${att.tools}）` : undefined }),
    });

    disposeModelAbort();
    modelAbort = openModelAbort(opts.signal);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: modelAbort.signal,
      });
      modelAbort.touch();
    } catch (err) {
      logModel('error', { provider: provider.name, model, apiMode: mode, url, ms: Date.now() - t0, error: (err as Error).message });
      // R1-1：abort 原样 rethrow。原来一律包成普通 Error，isAbortError 匹配不到
      // （message 是 'idle-timeout 300000ms'），用户看到 cryptic 文案而非
      // modelTimeoutText 的可读提示；且与 Ollama 路径、流式中断路径行为不一致——
      // openModelAbort 的注释本就承诺「超时原因的 name 固定为 AbortError 便于区分」。
      if (isAbortError(err)) throw err;
      throw new Error(`请求模型接口失败：${(err as Error).message}`);
    }

    if (!res.ok) {
      const txt = await res.text();
      lastErr = `模型 API 返回 HTTP ${res.status}: ${txt.slice(0, 300)}`;
      logModel('error', { provider: provider.name, model, apiMode: mode, url, status: res.status, ms: Date.now() - t0, error: txt.slice(0, 200) });
      if (shouldRetryWithoutStream(res.status, txt, useStream)) {
        preferStream = false;
        continue;
      }
      // 工具相关参数被拒绝 → 降级重试；其余错误直接抛出。
      // M-1：仅当错误体明确提及 tool/function 时才记为「工具协议拒绝」；
      // 上下文超长等无关 400 不该把原生工具能力毒化掉。
      if (att.tools && [400, 404, 415, 422].includes(res.status)) {
        if (TOOL_PROTOCOL_REJECT_RE.test(txt)) toolProtocolRejected = true;
        toolsAttemptFailed++;
        continue attLoop;
      }
      throw new Error(lastErr);
    }

    const detector = createBodyDetector(opts.onDelta);
    let rawBody: string;
    try {
      rawBody = await readStreamingText(res, (piece) => {
        modelAbort?.touch();
        detector.push(piece);
      });
    } catch (err) {
      logModel('error', { provider: provider.name, model, apiMode: mode, url, ms: Date.now() - t0, error: (err as Error).message });
      throw err;
    }
    let data: Record<string, unknown>;
    const sseHit = detector.kind() === 'sse' ? detector.endSse() : (looksLikeSse(rawBody) ? consumeOpenAiSse(rawBody, opts.onDelta) : null);
    if (sseHit) {
      const streamed = sseHit;
      const toolCalls = normalizeNativeToolCalls(streamed.toolCalls);
      if (!streamed.content && !toolCalls.length && att.tools) {
        lastErr = emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish: streamed.finish, bodySnippet: rawBody.slice(0, 200) });
        toolsAttemptFailed++;
        continue attLoop;
      }
      logModel('response', {
        provider: provider.name, model, apiMode: mode, url,
        status: res.status, ms: Date.now() - t0,
        contentLen: streamed.content.length, toolCalls: toolCalls.length,
      });
      return {
        content: streamed.content,
        toolCalls,
        source: toolCalls.length ? 'native' : 'none',
        // R1-3：SSE 未见到 [DONE]/finish_reason 就结束 = 流被中途切断，content 可能不完整。
        truncated: !streamed.sawTerminator && streamed.content ? true : undefined,
        usage: normalizeApiUsage({ usage: streamed.usage }) || undefined,
        toolsRejected: canUseTools && !att.tools && streamed.content && toolProtocolRejected ? true : undefined,
        softToolsFallback: canUseTools && !att.tools && streamed.content && !toolProtocolRejected && toolsAttemptFailed > 0 ? true : undefined,
        emptyReason: (!streamed.content && !toolCalls.length)
          ? emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish: streamed.finish, bodySnippet: rawBody.slice(0, 200) })
          : undefined,
      };
    }
    try {
      data = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      if (looksLikeSse(rawBody)) {
        const streamed = consumeOpenAiSse(rawBody, opts.onDelta);
        const toolCalls = normalizeNativeToolCalls(streamed.toolCalls);
        if (!streamed.content && !toolCalls.length && att.tools) {
          lastErr = emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish: streamed.finish, bodySnippet: rawBody.slice(0, 200) });
        toolsAttemptFailed++;
          continue attLoop;
        }
        logModel('response', {
          provider: provider.name, model, apiMode: mode, url,
          status: res.status, ms: Date.now() - t0,
          contentLen: streamed.content.length, toolCalls: toolCalls.length,
        });
        return {
          content: streamed.content,
          toolCalls,
          source: toolCalls.length ? 'native' : 'none',
          // R1-3：同 detector 路径——整包回退解析同样可能拿到被切断的流。
          truncated: !streamed.sawTerminator && streamed.content ? true : undefined,
          usage: normalizeApiUsage({ usage: streamed.usage }) || undefined,
        toolsRejected: canUseTools && !att.tools && streamed.content && toolProtocolRejected ? true : undefined,
        softToolsFallback: canUseTools && !att.tools && streamed.content && !toolProtocolRejected && toolsAttemptFailed > 0 ? true : undefined,
          emptyReason: (!streamed.content && !toolCalls.length)
            ? emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish: streamed.finish, bodySnippet: rawBody.slice(0, 200) })
            : undefined,
        };
      }
      throw new Error(`模型 API 返回非 JSON 响应（HTTP ${res.status} · apiMode=${mode}）: ${rawBody.slice(0, 200)}`);
    }
    const errMsg = (data as { error?: { message?: string } }).error?.message;
    if (errMsg) {
      lastErr = errMsg;
      if (useStream && /stream/i.test(errMsg)) {
        preferStream = false;
        continue;
      }
      if (att.tools && TOOL_PROTOCOL_REJECT_RE.test(errMsg)) {
        toolProtocolRejected = true;
        toolsAttemptFailed++;
        continue attLoop;
      }
      throw new Error(errMsg);
    }

    const choice = (data as { choices?: Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: unknown }> }).choices?.[0];
    const toolCalls = normalizeNativeToolCalls(choice?.message?.tool_calls);
    const content = pickOpenAIContent(data, mode) || (typeof choice?.message?.content === 'string' ? choice.message.content : '');
    const finish = choice?.finish_reason;

    if (!content && !toolCalls.length && att.tools) {
      lastErr = emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish, bodySnippet: rawBody.slice(0, 200) });
      logModel('error', { provider: provider.name, model, apiMode: mode, url, status: res.status, ms: Date.now() - t0, error: `[softReject] ${lastErr}` });
      toolsAttemptFailed++;
      continue attLoop;
    }

    emitDelta(opts, content);
    logModel('response', {
      provider: provider.name, model, apiMode: mode, url,
      status: res.status, ms: Date.now() - t0,
      contentLen: content.length, toolCalls: toolCalls.length,
    });
    return {
      content,
      toolCalls,
      source: toolCalls.length ? 'native' : 'none',
      usage: normalizeApiUsage(data) || undefined,
      // 本次是靠「确认了工具协议拒绝 + 去掉 tools」才成功的 → 告知上层别再下发工具定义。
      // 空 content 爬梯成功（toolProtocolRejected=false）不算数——只记轮内软降级。
      toolsRejected: canUseTools && !att.tools && content && toolProtocolRejected ? true : undefined,
      softToolsFallback: canUseTools && !att.tools && content && !toolProtocolRejected && toolsAttemptFailed > 0 ? true : undefined,
      emptyReason: (!content && !toolCalls.length)
        ? emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish, bodySnippet: rawBody.slice(0, 200) })
        : undefined,
    };
    }
  }
  throw new Error(lastErr || '模型调用失败（未知原因）');
  } finally {
    disposeModelAbort();
  }
}

export type { NativeToolCall };
