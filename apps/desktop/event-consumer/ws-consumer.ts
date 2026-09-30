/**
 * WS Consumer — 订阅 OrchClaw Canonical Event Envelope
 * ----------------------------------------------------------------------------
 * 使用原生 WebSocket 连接 OrchClaw WS endpoint。
 * OrchClaw WS 协议已支持 Canonical envelope（Phase 3/5 双写），消息格式：
 *   { "type": "envelope", "envelope": <CanonicalEventEnvelope> }
 */

import type { CanonicalEnvelope } from '../event-emit';

export interface WSConsumerOptions {
  url: string;
  token: string;
  onEvent: (envelope: CanonicalEnvelope) => void;
  onError: (err: Error) => void;
  reconnectMs?: number;
}

export class WSConsumer {
  private ws: WebSocket | null = null;
  private reconnectMs: number;

  constructor(private opts: WSConsumerOptions) {
    this.reconnectMs = opts.reconnectMs ?? 1000;
  }

  start(): void {
    this.stop();
    const url = new URL(this.opts.url);
    url.searchParams.set('token', this.opts.token);
    try {
      this.ws = new WebSocket(url.toString());
    } catch (e) {
      this.opts.onError(e instanceof Error ? e : new Error(String(e)));
      this.scheduleReconnect();
      return;
    }

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'envelope' && msg.envelope) {
          this.opts.onEvent(msg.envelope as CanonicalEnvelope);
        }
      } catch (e) {
        this.opts.onError(new Error(`WS parse error: ${e}`));
      }
    };

    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => {
      this.opts.onError(new Error('WS connection error'));
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    setTimeout(() => this.start(), this.reconnectMs);
  }

  stop(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
