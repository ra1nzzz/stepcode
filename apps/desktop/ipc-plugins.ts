/**
 * 插件能力 IPC：边界外补偿层（FR-12）/ 自进化（FR-13）/ 编排目录（FR-7b）。
 * 从 main.ts 抽出（M2 组合根分离）。服务不可用时返回 { unavailable: true }
 * 或明确的 false——渲染层显示「未接入」，不塞假数据（项目铁律）。
 */
import type { IpcMain } from 'electron';
import { getService, getRuntime, getPluginStates } from './dsh-runtime';
import { log } from './logger';

export interface CompensationServiceLike {
  classify(text: string): unknown;
  requiresWithhold(category: string): unknown;
  withhold(text: string): Promise<unknown> | unknown;
  compensate(text: string, note?: string): unknown;
  getAudit(): unknown;
}

interface EvolutionServiceLike {
  createTempPlugin(spec: unknown, opts?: unknown): Promise<unknown>;
  list(): unknown;
  disposeTempPlugin(id: string): Promise<unknown>;
  getAudit(): unknown;
}

interface OrchestrationServiceLike {
  getCatalog(): unknown;
  getDelegationTree(rootId?: string): unknown;
  /** CEO→Director→Worker 三层编排（后台经 agentRunner 跑真实 LLM，耗时较长）。 */
  composeTeam?(teamId: string, task: string): Promise<unknown>;
}

function unavailable(reason: string): { ok: false; unavailable: true; reason: string } {
  return { ok: false, unavailable: true, reason };
}

export function registerPluginCapabilityIpc(ipc: IpcMain): void {
  // ---- 边界外补偿层（compensation 插件）----
  ipc.handle('orchdesk:comp-withhold', async (_e, text: string) => {
    const svc = getService<CompensationServiceLike>('compensation');
    if (!svc) { log('WARN', 'compensation', '补偿层插件未接入，外发预判不可用'); return unavailable('补偿层插件未接入'); }
    // 契约修正（第九死挂点）：插件 withhold(text: string)，此前主进程包成 { text }
    // 传给正则匹配 → 恒为 'other' →「不可撤销」警示条与二次确认从未触发。
    return svc.withhold(String(text || ''));
  });
  ipc.handle('orchdesk:comp-compensate', (_e, text: string, note?: string) => {
    const svc = getService<CompensationServiceLike>('compensation');
    if (!svc) { log('WARN', 'compensation', '补偿层插件未接入，补偿动作不可用'); return unavailable('补偿层插件未接入'); }
    // 契约修正：插件 compensate(text, note)，此前只收首参，note 被丢弃。
    return svc.compensate(String(text || ''), note ? String(note) : undefined);
  });
  ipc.handle('orchdesk:comp-audit', () => {
    const svc = getService<CompensationServiceLike>('compensation');
    return svc ? svc.getAudit() : unavailable('dsh 已卸下，补偿层未迁移');
  });

  // ---- 自进化（evolution 插件）----
  ipc.handle('orchdesk:evol-create', async (_e, spec: unknown, opts: unknown) => {
    const svc = getService<EvolutionServiceLike>('evolution');
    if (!svc) { log('WARN', 'evolution', '自进化插件未接入，创建被拒'); return unavailable('自进化插件未接入'); }
    // BUG（全盘死挂点扫描）：原实现透传 opts（无 agent 字段）→ evolution 插件的
    // requireConfirm=true 授权门（默认值）在「缺 agent 句柄」时恒返「授权门控未通过」，
    // 设置页「新建临时插件」按钮恒失败，UI 却写着「创建后在此列出」。桌面宿主无 dsh
    // Agent 句柄，但审批实际走 UI 弹窗（approval.request 不读 agent 字段，见 host-services
    // 的 uiAnswerer 通道）——补最小占位即可让用户点击 → 真实审批弹窗 → 放行后创建。
    const base = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
    const merged = { ...base, agent: base.agent ?? { id: 'orchdesk-desktop', meta: { origin: 'ui' } } };
    return svc.createTempPlugin(spec, merged);
  });
  ipc.handle('orchdesk:evol-list', () => {
    const svc = getService<EvolutionServiceLike>('evolution');
    return svc ? svc.list() : unavailable('dsh 已卸下，自进化未迁移');
  });
  ipc.handle('orchdesk:evol-dispose', async (_e, id: string) => {
    const svc = getService<EvolutionServiceLike>('evolution');
    if (!svc) return unavailable('dsh 已卸下，自进化未迁移');
    return svc.disposeTempPlugin(String(id || ''));
  });

  // ---- 编排目录（multi 插件）：替换渲染层硬编码的 8 专家 + 3 团 ----
  ipc.handle('orchdesk:orchestration-catalog', () => {
    const svc = getService<OrchestrationServiceLike>('orchestration');
    return svc ? svc.getCatalog() : null;
  });
  ipc.handle('orchdesk:compose-team', async (_e, teamId: string, task: string) => {
    const svc = getService<OrchestrationServiceLike>('orchestration');
    if (!svc?.composeTeam) return { error: '编排服务未就绪（multi 插件未激活）' };
    try {
      return await svc.composeTeam(String(teamId || 'team-custom'), String(task || ''));
    } catch (err) {
      log('WARN', 'orchestration', `编排失败: ${(err as Error).message}`);
      return { error: `编排失败: ${(err as Error).message}` };
    }
  });

  // ---- 插件运行时状态（供设置页状态条与插件页展示真实数据，替代硬编码常量）----
  ipc.handle('orchdesk:plugin-runtime', () => {
    const rt = getRuntime();
    return {
      ready: !!rt,
      activeCount: rt?.activeCount ?? 0,
      total: rt?.plugins.length ?? 0,
      plugins: getPluginStates(),
    };
  });
}
