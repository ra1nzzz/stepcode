/**
 * 提示词库 IPC（PRD FR-11，prompt 插件）。
 * 从 main.ts 抽出（M2 组合根分离）。服务不可用时返回 { unavailable: true }——
 * 渲染层据此显示「未接入」，不塞假数据（项目铁律：不伪造、不静默）。
 */
import type { IpcMain } from 'electron';
import { getService } from './dsh-runtime';
import { log } from './logger';

interface PromptServiceLike {
  list(): unknown;
  get(id: string): unknown;
  create(input: unknown): unknown;
  update(id: string, patch: unknown): unknown;
  remove(id: string): unknown;
  mergeForAgent(agentId: string): unknown;
}

function unavailable(reason: string): { ok: false; unavailable: true; reason: string } {
  return { ok: false, unavailable: true, reason };
}

export function registerPromptIpc(ipc: IpcMain): void {
  ipc.handle('orchdesk:prompt-list', () => {
    const svc = getService<PromptServiceLike>('promptLib');
    return svc ? svc.list() : unavailable('dsh 已卸下，提示词库未迁移');
  });
  ipc.handle('orchdesk:prompt-merge', (_e, agentId: string) => {
    const svc = getService<PromptServiceLike>('promptLib');
    return svc ? svc.mergeForAgent(String(agentId || '')) : unavailable('dsh 已卸下，提示词库未迁移');
  });
  ipc.handle('orchdesk:prompt-save', (_e, input: unknown) => {
    const svc = getService<PromptServiceLike>('promptLib');
    if (!svc) { log('WARN', 'prompt', '提示词库插件未接入，保存被拒'); return unavailable('提示词库插件未接入'); }
    try {
      const doc = input as { id?: string } & Record<string, unknown>;
      return doc.id ? svc.update(String(doc.id), doc) : svc.create(doc);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });
  ipc.handle('orchdesk:prompt-delete', (_e, id: string) => {
    const svc = getService<PromptServiceLike>('promptLib');
    if (!svc) { log('WARN', 'prompt', '提示词库插件未接入，删除被拒'); return unavailable('提示词库插件未接入'); }
    return svc.remove(String(id || ''));
  });
}
