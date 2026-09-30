/// <reference types="electron" />
import * as path from 'node:path';
import * as fs from 'node:fs';
import { safeStorage } from 'electron';
import { DATA_FILE_NAMES, SKILLS_DIR_NAME, getDataDir } from './data-dir';
import { isMarketDirName } from './plugin-market';
// ============================================================================
// 观雅集技能市场客户端（T-P6-1）
// ----------------------------------------------------------------------------
// 严格复用 guanji SKILL（v2.0.0）的 API 约定，不另起接口：
//   BASE_URL = https://skill.ytaiv.com
//   GET  /api/skills/recommend/latest          最近上新
//   GET  /api/skills/recommend/<featured|trending|top>  精品推送
//   GET  /api/skills/<slug>/download           下载 .skill 包
//   GET  /api/skills/<slug>/related            同类/关联推荐
//   GET  /api/auth/token                       登录 Cookie → 持久化 TOKEN
//   POST /api/upload/prepare                   x-upload-source: agent
//   POST /api/skills/upload                     multipart，publishMode=lingbi
//   POST /api/skills/<slug>/alias               body { alias }
//
// 红线（PLAN T-P6-1 防漂移）：
//   - TOKEN 由用户配置（规范化数据目录/guanji.json），绝不硬编码。
//   - 安装前必须能力审查（capabilityReview），不得跳过；L3/L4 强制授权。
//   - 仅做下载/安装编排，不代替用户判断是否安装第三方 SKILL。
// ============================================================================

export const GUANJI_BASE_URL = 'https://skill.ytaiv.com';

export type SkillCapability =
  | 'prompt.read' | 'intent.classify' | 'flow.gate'
  | 'event.read' | 'pii.mask' | 'github.write'
  | 'agent.spawn' | 'agent.dispose' | 'memory.commit'
  | 'expert.load' | 'team.compose' | 'role.bind'
  | 'skill.fetch' | 'skill.install'
  | 'fs.read' | 'fs.write' | 'doc.review'
  | 'web.fetch' | 'cron.schedule'
  | 'browser.navigate' | 'browser.screenshot'
  | 'git.read' | 'git.write'
  | 'pdf.read' | 'pdf.write'
  | 'mail.send' | 'mail.read'
  | 'chart.render';

export interface GuanjiSkill {
  slug: string;
  name: string;
  description: string;
  caps: string[];
  /** 是否需要用户授权（L3+ 网络 / L4 Shell 或显式标注）。 */
  auth: 0 | 1;
  installed?: 0 | 1;
}

export interface TokenStatus {
  configured: boolean;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  /** 能力审查结论：allowed（已授权/无需授权）/ needs-auth（需先授权）/ denied（被拒）。 */
  review: 'allowed' | 'needs-auth' | 'denied';
  path?: string;
}

export interface PublishInput {
  slug: string;
  alias?: string;
  /** 已打包的 .skill 文件路径（ZIP，根含 SKILL.md）。 */
  filePath: string;
}

export interface PublishResult {
  ok: boolean;
  reason?: string;
}

/** 本地已安装技能包（数据目录/skills/<slug>.skill）。 */
export interface InstalledSkill {
  slug: string;
  /** 包体积（字节）。 */
  bytes: number;
  /** 落盘时间（ms，取自 mtime）。 */
  installedAt: number;
}

export interface InstalledSkillList {
  ok: boolean;
  items: InstalledSkill[];
  reason?: string;
}

// L3（网络）/ L4（Shell/进程）/ 系统级能力 → 安装前必须授权。
// 默认 deny：未列入白名单的能力一律视为高危，需用户显式授权。
const LOW_RISK_CAPS = new Set<string>([
  'fs.read', 'doc.read', 'web.read', 'memory.read',
  'chart.render', 'role.bind',
]);

/** 单个 .skill 包体积上限（64 MB）：防恶意/失控远端把主进程内存打爆。 */
const MAX_SKILL_BYTES = 64 * 1024 * 1024;

/** 配置文件：统一落在规范化数据目录（非 userData，避免跨安装形态丢失 TOKEN）。 */
function configFile(): string {
  return path.join(getDataDir(), DATA_FILE_NAMES.guanji);
}

function readToken(): string | null {
  try {
    const file = configFile();
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as { enc?: string; token?: string };
      if (typeof cfg.enc === 'string' && cfg.enc) {
        // 加密格式（safeStorage）：无加密后端时无法解密，视为未配置（不降级明文）。
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(Buffer.from(cfg.enc, 'base64'));
      }
      if (typeof cfg.token === 'string' && cfg.token) return cfg.token; // 旧明文格式兼容（首启迁移后不再写）
    }
  } catch {
    /* 配置损坏视为未配置 */
  }
  return null;
}

/** 写 TOKEN：一律经 safeStorage 加密（与 hub 凭据同策略）；无加密后端拒绝明文落盘。 */
function writeToken(token: string): { ok: boolean; reason?: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: '系统加密后端不可用（safeStorage），拒绝明文存储 TOKEN' };
  }
  try {
    const file = configFile();
    const enc = safeStorage.encryptString(token).toString('base64');
    fs.writeFileSync(file, JSON.stringify({ enc }), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `TOKEN 加密写入失败：${(err as Error).message}` };
  }
}

export class GuanjiClient {
  private baseUrl: string;

  constructor(baseUrl: string = GUANJI_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /** 仅以 slug/name/desc/caps 构造最小技能对象（能力审查用）。 */
  private makeSkill(raw: { slug?: string; name?: string; description?: string; caps?: string[] }): GuanjiSkill {
    const caps = (raw.caps || []).filter((c): c is string => typeof c === 'string');
    const auth = caps.some((c) => !LOW_RISK_CAPS.has(c)) ? 1 : 0;
    return {
      slug: raw.slug || raw.name || 'unknown',
      name: raw.name || raw.slug || 'unknown',
      description: raw.description || '',
      caps,
      auth: auth as 0 | 1,
    };
  }

  /** TOKEN 配置状态（不返回 token 明文）。 */
  tokenStatus(): TokenStatus {
    return { configured: readToken() !== null };
  }

  /** 用户配置 TOKEN（来自登录后 GET /api/auth/token 的结果；不硬编码）。 */
  setToken(token: string): { ok: boolean; reason?: string } {
    if (!token || !token.trim()) return { ok: false, reason: 'TOKEN 为空' };
    return writeToken(token.trim());
  }

  /** 拉取观雅集真实技能列表（最近上新 + 精品推送合并去重）。 */
  async listSkills(): Promise<GuanjiSkill[]> {
    const token = readToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const seen = new Map<string, GuanjiSkill>();
    const endpoints = [
      `${this.baseUrl}/api/skills/recommend/latest`,
      `${this.baseUrl}/api/skills/recommend/featured`,
      `${this.baseUrl}/api/skills/recommend/top`,
    ];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const data = (await res.json()) as { items?: Array<Record<string, unknown>>; skills?: Array<Record<string, unknown>> };
        const items = (data.items || data.skills || []) as Array<{ slug?: string; name?: string; description?: string; caps?: string[] }>;
        for (const it of items) {
          const s = this.makeSkill(it);
          if (!seen.has(s.slug)) seen.set(s.slug, s);
        }
      } catch {
        // 单端点失败不影响其余；最终若全失败则由调用方回落静态样本。
      }
    }
    return [...seen.values()];
  }

  /**
   * 安装前能力审查（PLAN 红线：不得跳过）。
   * - 无高危能力（auth=0）→ allowed
   * - 高危能力（auth=1）：必须**用户显式授权**（authorized=true，渲染层确认弹窗）；
   *   配置了 TOKEN 不等于已授权——L3/L4 强制授权不可凭 token 绕过。
   */
  capabilityReview(skill: GuanjiSkill, authorized = false): 'allowed' | 'needs-auth' | 'denied' {
    if (skill.auth === 1 && !authorized) return 'needs-auth';
    return 'allowed';
  }

  /** 下载 .skill 包到本地 skills 目录（数据目录/skills/<slug>.skill）。 */
  async installSkill(skill: GuanjiSkill, authorized = false): Promise<InstallResult> {
    const review = this.capabilityReview(skill, authorized);
    if (review === 'needs-auth') {
      return { ok: false, review, reason: '该技能含 L3/L4 高危能力，需在确认弹窗中显式授权后安装' };
    }
    if (review === 'denied') {
      return { ok: false, review, reason: '能力审查未通过，拒绝安装' };
    }
    const token = readToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(skill.slug)}/download`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        return { ok: false, review, reason: `下载失败 HTTP ${res.status}` };
      }
      // slug 是来自远端/渲染层的不可信字符串：落盘前必须过目录名白名单，
      // 防 `../../evil` 之类穿越 skills 目录任意写文件（与插件市场 isMarketDirName 同纪律）。
      if (!isMarketDirName(skill.slug)) {
        return { ok: false, review, reason: `技能标识「${String(skill.slug).slice(0, 64)}」非法，拒绝落盘` };
      }
      const contentLength = Number(res.headers.get('content-length') || '0');
      if (contentLength > MAX_SKILL_BYTES) {
        return { ok: false, review, reason: `下载包超过 ${MAX_SKILL_BYTES} 字节上限，拒绝落盘` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // 体积双保险：content-length 可能缺失/伪造，以实际读到的字节为准。
      if (buf.length > MAX_SKILL_BYTES) {
        return { ok: false, review, reason: `下载包实际 ${buf.length} 字节超上限，拒绝落盘` };
      }
      const dir = path.join(getDataDir(), SKILLS_DIR_NAME);
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `${skill.slug}.skill`);
      fs.writeFileSync(out, buf);
      return { ok: true, review, path: out };
    } catch (err) {
      return { ok: false, review, reason: `下载异常：${(err as Error).message}` };
    }
  }

  /**
   * 列出本地已安装技能（真实扫描 数据目录/skills/*.skill）。
   *
   * 此前「已安装」只存在渲染层内存（installedSkills 数组），重启即清零 ——
   * 磁盘上明明有包，UI 却显示 0 个。按本项目纪律，「读不到」与「没装」必须分开：
   * ok=false 表示扫描失败（UI 标注未接入），ok=true 且 items=[] 才是真没装。
   */
  listInstalledSkills(): InstalledSkillList {
    const dir = path.join(getDataDir(), SKILLS_DIR_NAME);
    try {
      if (!fs.existsSync(dir)) return { ok: true, items: [] };
      const items: InstalledSkill[] = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.skill')) continue;
        const slug = f.slice(0, -'.skill'.length);
        // slug 落盘时已过白名单；扫描侧再过一次，脏文件名不得进 UI。
        if (!isMarketDirName(slug)) continue;
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) items.push({ slug, bytes: st.size, installedAt: st.mtimeMs });
      }
      items.sort((a, b) => a.slug.localeCompare(b.slug));
      return { ok: true, items };
    } catch (err) {
      return { ok: false, items: [], reason: `扫描技能目录失败：${(err as Error).message}` };
    }
  }

  /** 卸载本地技能包（真删文件）。此前只从渲染层数组里移除，磁盘上的包还在。 */
  uninstallSkill(slug: string): PublishResult {
    // slug 来自渲染层，属不可信输入：先过目录名白名单，防 `../../x` 穿越删任意文件。
    if (!isMarketDirName(slug)) {
      return { ok: false, reason: `技能标识「${String(slug).slice(0, 64)}」非法，拒绝操作` };
    }
    const target = path.join(getDataDir(), SKILLS_DIR_NAME, `${slug}.skill`);
    try {
      if (!fs.existsSync(target)) return { ok: false, reason: '本地不存在该技能包' };
      fs.unlinkSync(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `删除失败：${(err as Error).message}` };
    }
  }

  /** 发布技能到观雅集（用户登录后；灵璧 Skill 走 publishMode=lingbi）。 */
  async publishSkill(input: PublishInput): Promise<PublishResult> {
    const token = readToken();
    if (!token) return { ok: false, reason: '请先登录观雅集并配置 TOKEN' };
    // 路径白名单：仅允许发布数据目录 skills 内的 .skill 包（防任意文件外传）。
    const skillsDir = path.resolve(getDataDir(), SKILLS_DIR_NAME);
    const resolved = path.resolve(input.filePath);
    if (!resolved.startsWith(skillsDir + path.sep) || !resolved.endsWith('.skill')) {
      return { ok: false, reason: '发布文件必须位于 skills 目录内且为 .skill 包' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, reason: '发布文件不存在' };
    try {
      // 1) 获取上传凭证
      const prep = await fetch(`${this.baseUrl}/api/upload/prepare`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-upload-source': 'agent' },
        body: JSON.stringify({ turnstile_token: 'agent' }),
        signal: AbortSignal.timeout(8000),
      });
      if (!prep.ok) return { ok: false, reason: `获取上传凭证失败 HTTP ${prep.status}` };
      const prepData = (await prep.json()) as { upload_token?: string };
      const uploadToken = prepData.upload_token;
      if (!uploadToken) return { ok: false, reason: '上传凭证缺失' };

      // 2) 上传并预发布（multipart/form-data）
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(input.filePath)], { type: 'application/zip' }), `${input.slug}.skill`);
      form.append('publishMode', 'lingbi');
      const up = await fetch(`${this.baseUrl}/api/skills/upload`, {
        method: 'POST',
        headers: { 'X-Upload-Token': uploadToken },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!up.ok) return { ok: false, reason: `上传失败 HTTP ${up.status}` };

      // 3) 设置雅称（可选）
      if (input.alias) {
        await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(input.slug)}/alias`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ alias: input.alias }),
          signal: AbortSignal.timeout(8000),
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `发布异常：${(err as Error).message}` };
    }
  }
}

export const guanjiClient = new GuanjiClient();
