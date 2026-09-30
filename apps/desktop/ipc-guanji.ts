/**
 * 观雅集技能市场 IPC（PRD FR-3 技能市场分组 / T-P6-1）。
 * 从 main.ts 抽出（M2 组合根分离第二轮）：纯客户端转发，无本地状态。
 * TOKEN 由用户配置（不硬编码），安装前能力审查在 guanjiClient 内。
 */
import type { IpcMain } from 'electron';
import { guanjiClient } from './guanji';

export function registerGuanjiIpc(ipc: IpcMain): void {
  ipc.handle('orchdesk:guanji-token-status', async () => guanjiClient.tokenStatus());
  ipc.handle('orchdesk:guanji-set-token', async (_e, token: string) => guanjiClient.setToken(token));
  ipc.handle('orchdesk:guanji-list', async () => {
    try { return await guanjiClient.listSkills(); } catch { return []; }
  });
  ipc.handle('orchdesk:guanji-install', async (_e, skill: { slug: string; name: string; description: string; caps: string[]; auth: 0 | 1 }, authorized = false) => {
    return guanjiClient.installSkill(skill, authorized === true);
  });
  ipc.handle('orchdesk:guanji-publish', async (_e, input: { slug: string; alias?: string; filePath: string }) => {
    return guanjiClient.publishSkill(input);
  });
  // 本地已安装技能：真实扫描数据目录/skills（此前只存渲染层内存，重启即显示 0 个）。
  // ok=false = 扫描失败，与「已扫描但没装」区分，UI 分别标注「未接入」与「暂无」。
  ipc.handle('orchdesk:skills-installed', () => guanjiClient.listInstalledSkills());
  ipc.handle('orchdesk:skill-uninstall', async (_e, slug: string) => guanjiClient.uninstallSkill(String(slug || '')));
}
