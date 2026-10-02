/**
 * 官方 CLI 的长度前缀帧。驱动方回答权限请求，不在这里决定放行。
 */
import { CLI_PROTOCOL, CLI_PROTOCOL_VERSION, CLI_QUERY_OPTIONS } from './cli-core';

export const CLI_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface StepFrame {
  protocol?: string;
  version?: number;
  kind?: string;
  id?: string;
  method?: string;
  replyTo?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface CliByteStream {
  write(buf: Buffer): void;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
}

export interface CliProcessLike {
  stdin: CliByteStream;
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  kill(): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
}

export function encodeStepFrame(frame: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  if (body.length > CLI_MAX_FRAME_BYTES) throw new Error('帧超过协议上限');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export function createFrameDecoder(onFrame: (frame: StepFrame) => void): (chunk: Buffer) => void {
  let rest = Buffer.alloc(0);
  return (chunk) => {
    rest = Buffer.concat([rest, chunk]);
    while (rest.length >= 4) {
      const len = rest.readUInt32BE(0);
      if (len > CLI_MAX_FRAME_BYTES) throw new Error('对端帧超过协议上限');
      if (rest.length < 4 + len) break;
      const json = rest.subarray(4, 4 + len).toString('utf8');
      rest = rest.subarray(4 + len);
      onFrame(JSON.parse(json) as StepFrame);
    }
  };
}

export function requestFrame(id: string, method: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: CLI_PROTOCOL,
    version: CLI_PROTOCOL_VERSION,
    kind: 'request',
    id,
    method,
    payload,
  };
}

export function responseFrame(replyTo: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: CLI_PROTOCOL,
    version: CLI_PROTOCOL_VERSION,
    kind: 'response',
    id: `res_${replyTo}`,
    replyTo,
    payload,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function textDeltaFromMessage(message: Record<string, unknown>): string {
  if (message.type !== 'stream_event') return '';
  const event = asRecord(message.event);
  if (event.type !== 'content_block_delta') return '';
  const delta = asRecord(event.delta);
  return delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : '';
}

export interface ToolStepNote {
  n: string;
  ph: 'running' | 'done' | 'error';
  result?: string;
  args?: unknown;
}

export function toolNotesFromMessage(message: Record<string, unknown>): ToolStepNote[] {
  const notes: ToolStepNote[] = [];
  if (message.type === 'assistant') {
    const content = asRecord(message.message).content;
    if (!Array.isArray(content)) return notes;
    for (const block of content) {
      const item = asRecord(block);
      if (item.type === 'tool_use' && typeof item.name === 'string' && item.name) {
        notes.push({ n: item.name, ph: 'running', args: item.input });
      }
    }
    return notes;
  }
  if (message.type === 'user') {
    const content = asRecord(message.message).content;
    if (!Array.isArray(content)) return notes;
    for (const block of content) {
      const item = asRecord(block);
      if (item.type !== 'tool_result') continue;
      const text = typeof item.content === 'string' ? item.content : '';
      notes.push({ n: '', ph: item.is_error === true ? 'error' : 'done', result: text });
    }
  }
  return notes;
}

export interface CliTurnHooks {
  confirm: (title: string, detail: string) => Promise<boolean>;
  onDelta?: (text: string) => void;
  onTool?: (name: string, ph: 'running' | 'done' | 'error', result?: string, args?: unknown) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function driveCliTurn(child: CliProcessLike, prompt: string, hooks: CliTurnHooks): Promise<{
  text: string;
  intent: 'ACT' | 'ERROR' | 'CONFIRM';
  aborted?: boolean;
  tools: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }>;
  steps: number;
}> {
  const tools: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }> = [];
  const pendingTools: Array<{ n: string; args?: unknown }> = [];
  let stderr = '';
  let settled = false;
  let queryId = '';
  const timeoutMs = hooks.timeoutMs ?? 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (reason: string) => finish(() => {
      try { child.kill(); } catch { /* 进程可能已经退出 */ }
      reject(new Error(reason));
    });
    const timer = setTimeout(() => fail('官方 CLI 回合超时'), timeoutMs);

    const write = (frame: Record<string, unknown>) => {
      child.stdin.write(encodeStepFrame(frame));
    };
    const reply = (frame: StepFrame, payload: Record<string, unknown>) => {
      if (!frame.id) return;
      write(responseFrame(frame.id, payload));
    };

    const onAbort = () => {
      if (queryId) {
        try { write(requestFrame('stop', 'query.interrupt', { queryId })); } catch { /* 管道可能已关 */ }
      }
      finish(() => {
        try { child.kill(); } catch { /* 已退出 */ }
        resolve({ text: '（已停止）', intent: 'CONFIRM', aborted: true, tools, steps: tools.length });
      });
    };
    if (hooks.signal?.aborted) {
      onAbort();
      return;
    }
    hooks.signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('exit', (code) => {
      if (settled) return;
      fail(`官方 CLI 在回合结束前退出（${code ?? '无退出码'}）${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''}`);
    });

    let push: (chunk: Buffer) => void;
    try {
      push = createFrameDecoder((frame) => {
        void handle(frame).catch((err) => fail((err as Error).message || String(err)));
      });
    } catch (err) {
      fail((err as Error).message);
      return;
    }
    child.stdout.on('data', (chunk) => {
      try { push(chunk); } catch (err) { fail((err as Error).message); }
    });

    async function handle(frame: StepFrame): Promise<void> {
      if (settled) return;
      if (frame.kind === 'request') {
        await answerHost(frame);
        return;
      }
      if (frame.kind === 'response' && frame.replyTo === 'init') {
        const payload = asRecord(frame.payload);
        if (payload.error || payload.ok === false) {
          fail(`官方 CLI 拒绝初始化：${JSON.stringify(payload).slice(0, 240)}`);
          return;
        }
        write(requestFrame('q1', 'query.start', { prompt, options: { ...CLI_QUERY_OPTIONS } }));
        return;
      }
      if (frame.kind === 'response' && frame.replyTo === 'q1') {
        const payload = asRecord(frame.payload);
        if (typeof payload.queryId === 'string') queryId = payload.queryId;
        if (payload.error) fail(`官方 CLI 拒绝开回合：${JSON.stringify(payload).slice(0, 240)}`);
        return;
      }
      if (frame.kind !== 'event' || frame.method !== 'query.message') return;
      const message = asRecord(asRecord(frame.payload).message);
      const delta = textDeltaFromMessage(message);
      if (delta) hooks.onDelta?.(delta);
      for (const note of toolNotesFromMessage(message)) {
        if (note.ph === 'running' && note.n) {
          pendingTools.push({ n: note.n, args: note.args });
          tools.push({ n: note.n, ph: 'running' });
          hooks.onTool?.(note.n, 'running', undefined, note.args);
        } else if (note.ph !== 'running') {
          const started = pendingTools.shift();
          const name = started?.n || 'tool';
          const result = (note.result || '').slice(0, 8000);
          tools.push({ n: name, ph: note.ph, result });
          hooks.onTool?.(name, note.ph, result, started?.args);
        }
      }
      if (message.type !== 'result') return;
      const errors = Array.isArray(message.errors) ? message.errors.map((item) => String(item)).join('\n') : '';
      const text = typeof message.result === 'string' ? message.result : errors;
      const intent = message.subtype === 'error_during_execution' || message.is_error === true ? 'ERROR' : 'ACT';
      try { write(requestFrame('bye', 'runtime.shutdown', {})); } catch { /* 结束帧写失败不影响结果 */ }
      finish(() => {
        resolve({ text: text || errors || '', intent, tools, steps: tools.length });
        setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 1500);
      });
    }

    async function answerHost(frame: StepFrame): Promise<void> {
      const payload = asRecord(frame.payload);
      if (frame.method === 'permission.request') {
        const name = typeof payload.toolName === 'string' ? payload.toolName : 'tool';
        const detail = JSON.stringify(payload.input ?? {}).slice(0, 2000);
        let allowed = false;
        try {
          allowed = await hooks.confirm(name, detail);
        } catch {
          allowed = false;
        }
        reply(frame, allowed ? { behavior: 'allow' } : { behavior: 'deny', message: '界面拒绝了这个操作' });
        return;
      }
      if (frame.method === 'user_dialog.request' && payload.kind === 'confirm') {
        const title = typeof payload.title === 'string' ? payload.title : '确认';
        const detail = typeof payload.message === 'string' ? payload.message : '';
        let allowed = false;
        try {
          allowed = await hooks.confirm(title, detail);
        } catch {
          allowed = false;
        }
        reply(frame, { confirmed: allowed });
        return;
      }
      reply(frame, {});
    }

    write(requestFrame('init', 'initialize', { protocolRange: { min: 1, max: 1 } }));
  });
}
