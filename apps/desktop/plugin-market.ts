/**
 * 插件市场 · 本地目录注册表（PRD FR-3）
 * ----------------------------------------------------------------------------
 * 纯逻辑、零 electron 依赖：manifest 校验 / 启用状态归一化 / 市场目录名。
 * 目录扫描与热插拔在 dsh-runtime.ts（需要 ctx 与 dynamicImport），持久化在 main.ts。
 *
 * 安全模型（fail-closed）：
 *  - 第三方插件是**可执行代码**，装载即获得与内置插件同等的能力（注入宿主服务、
 *    挂事件）。因此：扫描 ≠ 装载 —— 只有用户在 UI 上显式启用（enabled=true 且
 *    持久化）才会装载；manifest 非法或缺 index.js 的目录永远不可启用。
 *  - 「规划中」的远程市场（观雅集 / OrchClaw Hub）不在此层：远程装东西必须先有
 *    签名与来源校验，那是 P2 的事，不能拿「从网上下载并执行」冒充能力。
 */

/** 第三方插件清单（dataDir()/plugins/<目录>/manifest.json）。 */
export interface MarketManifest {
  /** 展示名（非目录名）；目录名才是稳定 id。 */
  name: string;
  version: string;
  description: string;
  /** 声明的能力（展示用；真正的能力边界由 Cordis inject 与授权层把守）。 */
  caps: string[];
  /** 声明要注入的宿主服务（展示用 + 供授权审查）。 */
  inject: string[];
}

export type ManifestCheck =
  | { ok: true; manifest: MarketManifest }
  | { ok: false; error: string };

/** market 插件目录名（挂在 dataDir() 下）。 */
export const MARKET_DIR_NAME = 'plugins';

/** manifest 字段上限：防一个 10 MB 的 description 把设置页卡死。 */
export const MANIFEST_FIELD_MAX = 200;
const CAPS_MAX = 24;

/**
 * 校验并归一化 manifest。任何字段不合法都给出**具体原因** —— 用户自己写的
 * manifest 加载失败却只看到「格式错误」时，是没法自查的。
 */
export function validateMarketManifest(raw: unknown, dir: string): ManifestCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${dir}: manifest.json 不是对象` };
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === 'string' ? r.name.trim().slice(0, MANIFEST_FIELD_MAX) : '';
  if (!name) return { ok: false, error: `${dir}: manifest.name 缺失或非字符串` };

  const version = typeof r.version === 'string' && r.version.trim()
    ? r.version.trim().slice(0, 32) : '0.0.0';
  const description = typeof r.description === 'string'
    ? r.description.slice(0, MANIFEST_FIELD_MAX) : '';
  const caps = Array.isArray(r.caps)
    ? r.caps.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, CAPS_MAX)
    : [];
  const inject = Array.isArray(r.inject)
    ? r.inject.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, CAPS_MAX)
    : [];

  return { ok: true, manifest: { name, version, description, caps, inject } };
}

/**
 * 归一化启用状态表（plugin-market.json 的 enabled 字段）。
 * 未知目录的记录保留（目录可能被临时移走，删记录会让「重命名目录再移回来」
 * 丢失用户的启用意愿）；但值只认布尔，其余一律按 false（fail-closed）。
 */
export function normalizeEnabledMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || k.includes('/') || k.includes('\\') || k.includes('..')) continue; // 路径穿越
    out[k] = v === true;
  }
  return out;
}

/** 目录名合法性：单个路径段，禁止穿越与隐藏目录。 */
export function isMarketDirName(dir: unknown): dir is string {
  return typeof dir === 'string' && dir.length > 0 && dir.length <= 64
    && !dir.startsWith('.') && !dir.includes('/') && !dir.includes('\\') && dir !== '..';
}
