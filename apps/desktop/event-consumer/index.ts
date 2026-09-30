/**
 * Event Consumer  barrel export
 * ----------------------------------------------------------------------------
 * 使用方式：
 *   import { SSEConsumer, WSConsumer, routeEvent, on } from './event-consumer';
 */

export { SSEConsumer, type SSEConsumerOptions } from './sse-consumer';
export { WSConsumer, type WSConsumerOptions } from './ws-consumer';
export { routeEvent, on, type EventHandler } from './router';
