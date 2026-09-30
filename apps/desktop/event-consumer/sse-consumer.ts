/**
 * SSE Consumer — 订阅 Ordexa Canonical Event Envelope
 * ----------------------------------------------------------------------------
 * 使用 fetch + ReadableStream 解析 SSE（支持 Bearer token）。
 * EventSource API 不支持自定义 headers，生产环境必须用此方案。
 */

import type { CanonicalEnvelope } from '../event-emit';

export interface SSEConsumerOptions {
  url: string;
  token: string;
  onEvent: (envelope: CanonicalEnvelope) => void;
  onError: (err: Error) => void;
  reconnectDelayMs?: number;
}

export class SSEConsumer {
  private abortController: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private opts: SSEConsumerOptions) {}

  start(): void {
    this.stop();
    this.abortController = new AbortController();
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${this.opts.token}`);
    headers.set('Accept', 'text/event-stream');

    fetch(this.opts.url, { headers, signal: this.abortController.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response body');
        const decoder = new TextDecoder() as any;
        let buffer = '';
        this.readLoop(reader, decoder, buffer);
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return; // 主动停止
        this.opts.onError(err instanceof Error ? err : new Error(String(err)));
        this.scheduleReconnect();
      });
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: any, buffer: string): Promise<void> {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            if (raw) {
              try {
                const envelope = JSON.parse(raw) as CanonicalEnvelope;
                this.opts.onEvent(envelope);
              } catch (e) {
                this.opts.onError(new Error(`SSE parse error: ${e}`));
              }
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.opts.onError(err instanceof Error ? err : new Error(String(err)));
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.opts.reconnectDelayMs ?? 1000;
    this.reconnectTimer = setTimeout(() => this.start(), delay);
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
