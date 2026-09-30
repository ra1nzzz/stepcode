/**
 * OrchClaw Hub IPC（T-P6-2）：配对远程 Agent 并经主会话控制。
 * 从 main.ts 抽出（M2 组合根分离第二轮）：纯客户端转发；配对凭据的
 * safeStorage 加密在 hubClient 内。
 */
import type { IpcMain } from 'electron';
import { hubClient } from './hub';

export function registerHubIpc(ipc: IpcMain): void {
  ipc.handle('orchdesk:hub-status', async () => hubClient.status());
  ipc.handle('orchdesk:hub-pair', async (_e, url: string, token: string) => hubClient.pair(url, token));
  ipc.handle('orchdesk:hub-send', async (_e, text: string) => hubClient.sendTask(text));
  ipc.handle('orchdesk:hub-result', async (_e, taskId: string) => hubClient.getResult(taskId));
}
