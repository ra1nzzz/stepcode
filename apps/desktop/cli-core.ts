/**
 * 官方 Step CLI 作为桌面壳的可更新核。纯逻辑，不发网络、不生成子进程。
 *
 * 进程内 `createStepExtensionInline` 仍是没装 CLI 时的兜底。装了独立的
 * `step` / `step.exe` 之后，回合必须走那份二进制，不能再假装包内旧核已更新。
 *
 * 确认不交给 CLI 的跳过审批档。查询选项固定带权限回调，由本 GUI 回答。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const OFFICIAL_RELEASE_BASE = 'https://static-openapi.stepfun.com/stepcode';
export const CLI_PROTOCOL = 'step-agent-sdk';
export const CLI_PROTOCOL_VERSION = 1;

/** 官方 CLI 查询选项。没有跳过审批的字段：危险工具必须回到本 GUI 确认。 */
export const CLI_QUERY_OPTIONS = Object.freeze({
  permissionMode: 'default' as const,
  hasPermissionCallback: true as const,
  includePartialMessages: true as const,
});

export function isStandaloneStepBinary(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name === 'step' || name === 'step.exe';
}

export function officialCliCandidates(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = String(env.ORCHDESK_CLI_CORE_PATH || '').trim();
  const bin = path.join(home, '.stepcode', 'bin');
  return [override, path.join(bin, 'step.exe'), path.join(bin, 'step')].filter(Boolean);
}

export function locateStandaloneCli(
  candidates: string[],
  exists: (filePath: string) => boolean,
): string | null {
  for (const candidate of candidates) {
    if (!candidate || !isStandaloneStepBinary(candidate)) continue;
    if (exists(candidate)) return path.resolve(candidate);
  }
  return null;
}

export function cliCoreDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.ORCHDESK_CLI_CORE || '') === '0';
}

/** 只接受稳定的 MAJOR.MINOR.PATCH。带 v 前缀可以，预发布号不行。 */
export function normalizeReleaseVersion(raw: unknown): string | null {
  const text = String(raw ?? '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+$/.test(text) ? text : null;
}

export function compareReleaseVersions(local: string, remote: string): number {
  const a = normalizeReleaseVersion(local);
  const b = normalizeReleaseVersion(remote);
  if (!a || !b) return 0;
  const pa = a.split('.').map((n) => Number(n));
  const pb = b.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i += 1) {
    const left = pa[i] ?? 0;
    const right = pb[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export interface ReleaseManifest {
  version: string;
  packages: Record<string, string>;
  checksums: Record<string, string>;
}

export function parseLatestManifest(raw: unknown): ReleaseManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { version?: unknown; packages?: unknown; checksums?: unknown };
  const version = normalizeReleaseVersion(body.version);
  if (!version || !body.packages || typeof body.packages !== 'object' || !body.checksums || typeof body.checksums !== 'object') {
    return null;
  }
  const packages: Record<string, string> = {};
  const checksums: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.packages)) {
    if (typeof value === 'string' && value.trim()) packages[key] = value.trim();
  }
  for (const [key, value] of Object.entries(body.checksums)) {
    if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) checksums[key] = value.toLowerCase();
  }
  return { version, packages, checksums };
}

export function releaseTargetId(platform = process.platform, arch = process.arch): string | null {
  const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'x64' || arch === 'arm64' ? arch : null;
  if (!osName || !cpu) return null;
  return `${osName}-${cpu}`;
}

export function assertOfficialReleaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('发布地址不是合法 URL');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'static-openapi.stepfun.com') {
    throw new Error('发布地址不在官方通道');
  }
  return url;
}

export interface ReleaseArtifact {
  version: string;
  targetId: string;
  url: string;
  checksum: string;
  fileName: string;
}

export function officialArtifact(manifest: ReleaseManifest, targetId: string): ReleaseArtifact | { reason: string } {
  const url = manifest.packages[targetId];
  const checksum = manifest.checksums[targetId];
  if (!url || !checksum) return { reason: `官方发布没有 ${targetId} 的安装包` };
  try {
    assertOfficialReleaseUrl(url);
  } catch (err) {
    return { reason: (err as Error).message };
  }
  return {
    version: manifest.version,
    targetId,
    url,
    checksum,
    fileName: path.posix.basename(new URL(url).pathname),
  };
}

export function planCliUpdate(cliPath: string): { ok: true; command: string; args: string[] } | { ok: false; reason: string } {
  if (!cliPath || !isStandaloneStepBinary(cliPath)) {
    return { ok: false, reason: '不是独立的 step 安装，不能自我更新' };
  }
  return { ok: true, command: path.resolve(cliPath), args: ['update'] };
}

export function cliStdioArgs(sessionDir: string, guiSessionId: string): string[] {
  return [
    '--sdk-stdio',
    '--no-update-check',
    '--session-dir',
    sessionDir,
    '--session-id',
    sessionIdForGui(guiSessionId),
  ];
}

/** 把 GUI 会话 id 收成稳定 UUID，避免把任意字符串塞给 `--session-id`。 */
export function sessionIdForGui(guiSessionId: string): string {
  const hex = createHash('sha256').update(`stepcode-gui:${guiSessionId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function desktopInstallDecision(input: {
  packaged: boolean;
  available: boolean;
  confirmed: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.confirmed) return { ok: false, reason: '没有确认，不安装桌面壳' };
  if (!input.packaged) return { ok: false, reason: '开发模式不能替换自身。需要已安装的 NSIS 版，并且 GitHub 上已有本仓库的 release' };
  if (!input.available) return { ok: false, reason: '没有可安装的桌面壳更新' };
  return { ok: true };
}
