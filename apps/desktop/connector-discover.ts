/**
 * 连接器自动发现 —— 从本机已有 CLI 登录态识别「哪个连接器其实已经可用」。
 * ----------------------------------------------------------------------------
 * 纯逻辑模块：**不 import electron**，可 node 直测（见 connector-discover-verify.cjs）。
 *
 * 设计诚实性（与 connector-registry 同纪律）：
 *   - 自动发现 ≠ 自动写入。它只「找到」本机已有的登录凭据并提示用户，是否保存进
 *     连接器仍由用户点「保存并测试」决定 —— 避免把用户没授权存的 token 悄悄写盘，
 *     也避免「发现一个 token 就标已连接」这种假成功。
 *   - 找不到 = 诚实说没有，不编造「已检测到登录态」。
 *
 * 目前实现的来源（2026-09-06，按「本机确有真实登录态」选型，不硬凑）：
 *   1. GitHub：
 *      - `~/.git-credentials`（git 的 HTTP 凭据：`https://user:token@github.com`）
 *      - GitHub CLI `gh` 的 hosts.yml（含 obfuscated token，不能直接用，仅作为
 *        「检测到 gh 已登录」的信号 + oauth 账户名）
 * 其它连接器（linear/notion/飞书/企微/钉钉/TAPD/腾讯文档）在本机没有标准本地 CLI
 * 登录态，诚实返回「无本地 CLI 登录态可发现」，不伪造。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// 类型
// ============================================================================

export interface DiscoveredCredential {
  /** 连接器 id（github 等）。 */
  connectorId: string;
  /** 发现来源描述（git-credentials / gh CLI…）。 */
  source: string;
  /** 找到的密钥明文（secret 字段，仅用于回填预览，不落盘）。 */
  secret: string;
  /** 关联的账户/身份串（如 GitHub 用户名），可能为空。 */
  identity?: string;
  /** 该源是否需要额外授权才能读（gh obfuscated token 不可用时会提示）。 */
  usable: boolean;
  note?: string;
}

// ============================================================================
// 纯解析（可单测）
// ============================================================================

/**
 * 解析 `~/.git-credentials`（每行 `https://user:token@host` 或带 scheme）。
 * 返回 [{ host, user, password }]。容错：坏行跳过。
 */
export function parseGitCredentials(text: string): Array<{ host: string; user: string; password: string }> {
  const out: Array<{ host: string; user: string; password: string }> = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // 格式：scheme://user:pass@host  (host 可能含端口 /path)
    try {
      const m = line.match(/^([a-z+]+):\/\/([^:]+):([^@]*)@([^/]+)/i);
      if (!m) continue;
      const user = m[2]; const password = m[3]; const host = m[4];
      if (!user || !password || !host) continue;
      // user:pass 可能经百分号编码（罕见），这里按字面取，够用于凭据回填
      out.push({ host: host.toLowerCase(), user, password });
    } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 从 git-credentials 行里挑出 github.com（或 api.github.com）那条的 token。 */
export function findGithubFromGitCredentials(entries: Array<{ host: string; user: string; password: string }>): DiscoveredCredential | null {
  const gh = entries.find((e) => e.host === 'github.com' || e.host === 'api.github.com');
  if (!gh || !gh.password) return null;
  return {
    connectorId: 'github',
    source: '~/.git-credentials',
    secret: gh.password,
    identity: gh.user || undefined,
    usable: true,
    note: '从 git HTTP 凭据发现（https://github.com），可直接回填并测试',
  };
}

/**
 * 探测 GitHub CLI `gh` 是否已登录（读 hosts.yml 的 oauth 账户段）。
 * gh 的 token 是 obfuscated（加盐不可逆），读不到明文 —— 只能当「已登录」信号，
 * 提示用户运行 `gh auth token` 获取或改用 git-credentials。这比伪造明文诚实。
 */
export function parseGhHosts(hostsYmlText: string): Array<{ host: string; user: string }> {
  const out: Array<{ host: string; user: string }> = [];
  // hosts.yml 形如：
  //   github.com:
  //     oauth_token: xxxxxxxxxx
  //     user: octocat
  // 按 host 块切分：把每个 "host:" 之后到下一个 host 的文本当一块。
  // split 结果：隔一项是 host，隔一项是 body（索引 1,3,5…）。
  const blocks = String(hostsYmlText || '').split(/^\s*([a-z0-9.-]+):\s*$/m);
  for (let i = 1; i < blocks.length; i += 2) {
    const host = (blocks[i] || '').trim();
    const body = blocks[i + 1] || '';
    if (!host) continue;
    const userMatch = body.match(/^\s*user:\s*(\S+)/m);
    if (userMatch && userMatch[1]) out.push({ host, user: userMatch[1] });
  }
  return out;
}

// ============================================================================
// 发现入口（宿主调用：给定 home 目录做文件 IO；纯逻辑可注入真实路径）
// ============================================================================

export interface DiscoveryContext {
  /** 用户的 home 目录（~）。 */
  home: string;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
}

const defFs: { existsSync: (p: string) => boolean; readFileSync: (p: string) => string } = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
};

/**
 * 发现指定连接器在本机的登录态。
 * @param connectorId 目标连接器 id（目前仅 github 有真实源；其余返回「无本地可发现」）。
 * @param home 用户主目录（用于定位 ~/.git-credentials 等）。
 */
export function discoverConnector(connectorId: string, ctx: DiscoveryContext): { found: boolean; cred?: DiscoveredCredential; reason?: string } {
  const io = ctx.existsSync && ctx.readFileSync ? { existsSync: ctx.existsSync, readFileSync: ctx.readFileSync } : defFs;

  if (connectorId === 'github') {
    // 1) ~/.git-credentials —— 最可靠的明文 token 源
    const gitCreds = path.join(ctx.home, '.git-credentials');
    if (io.existsSync(gitCreds)) {
      try {
        const entries = parseGitCredentials(io.readFileSync(gitCreds));
        const gh = findGithubFromGitCredentials(entries);
        if (gh) return { found: true, cred: gh };
      } catch { /* 读失败走 gh 探测 */ }
    }
    // 2) gh CLI hosts.yml —— 只能确认「已登录」，token 不可读明文
    const ghHosts = path.join(ctx.home, '.config', 'gh', 'hosts.yml');
    if (io.existsSync(ghHosts)) {
      try {
        const parsed = parseGhHosts(io.readFileSync(ghHosts));
        const gh = parsed.find((h) => h.host === 'github.com');
        if (gh) {
          return {
            found: true,
            cred: {
              connectorId: 'github',
              source: 'GitHub CLI (gh)',
              secret: '',
              identity: gh.user,
              usable: false,
              note: '检测到 gh 已登录为 ' + gh.user + '，但 gh 的 token 是混淆存储读不出明文。请运行 `gh auth token` 复制后粘贴，或走 git-credentials 源',
            },
          };
        }
      } catch { /* ignore */ }
    }
    return { found: false, reason: '未在本机发现 GitHub 登录态（~/.git-credentials 或 gh 均无）' };
  }

  // 其余连接器本机无标准本地 CLI 登录态 —— 诚实返回，不硬凑
  return { found: false, reason: '该连接器在本机没有标准 CLI 登录态可自动发现，请手动填写凭证' };
}
