/**
 * 通用标量工具 —— 纯逻辑层（零 electron 依赖，可 node 直测）
 * ----------------------------------------------------------------------------
 * 存在的唯一理由：把散落在各工具模块里的「同一份小逻辑」收敛成唯一真源。
 * 审计时发现 clamp 助手与绝对路径正则各有 3~4 份复制（browser-tools /
 * terminal-tools / file-panel / terminal-pty），改漏一处就会出现「同一参数在
 * 不同入口钳制口径不同」的隐性漂移——这是本项目的老毛病（见 CHECKPOINT ⑦）。
 *
 * 收录标准（宁缺毋滥）：
 *   1. 与业务无关，任何工具模块都可能用到；
 *   2. 曾经出现过 ≥2 份实现；
 *   3. 逻辑小到不值得单开一个模块，但错一处就会出事。
 * 不符合这三条的不要往这里塞，否则这里会变成杂物抽屉。
 */

/**
 * 数值钳制：`''` / undefined / NaN / 非数字一律返回默认值。
 * 注意不能写成 `Number(v) || dflt`——`Number('') === 0` 会把「没传」当成 0，
 * 浏览器工具超时钳制上踩过一次（CHECKPOINT ⑦），这里从入口挡掉。
 */
export function clampInt(
  v: unknown,
  min: number,
  max: number,
  dflt: number,
): number {
  const n = typeof v === 'number'
    ? v
    : typeof v === 'string' && v.trim() !== ''
      ? Number(v)
      : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 形状校验：是否像绝对路径（Win 盘符 / POSIX 根）。
 * 只做形状判断，不碰 fs——存在性检查永远由宿主负责。
 */
export function isAbsoluteLike(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
}

/** 取 basename（同时认 `/` 与 `\`；无分隔符时原样返回）。 */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * 取小写扩展名（不含点）；无扩展名或以点开头（.gitignore）返回 ''。
 *
 * 关键：先切 basename 再找点。直接对整个路径 `lastIndexOf('.')` 会被路径中
 * 带点的目录名击穿（`D:/proj/com.example/src/app.ts` → ext 变成
 * `example/src/app.ts`），导致语言探测返回 null、二进制扩展名快通道失效——
 * 这类 bug 只在特定目录结构下出现，属于最难发现的那一种。
 */
export function extOfName(name: string): string {
  const base = baseName(name);
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

/**
 * 宽容布尔解析：真布尔直接返回；字符串按 'false'/'0'/'no'/'' 等判否，其余判真；
 * 数字 0/NaN → false，非零 → true；undefined 用默认值。
 *
 * 不能写成 `Boolean(v)`——`Boolean('false') === true`，上游模型文本兜底常传
 * JSON 字符串 "false"，会让 `fullPage/clear/pressEnter` 这类开关在用户显式给
 * "false" 时仍被当成 true（browser-tools 踩过的坑）。
 */
export function toBool(v: unknown, dflt = false): boolean {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '' || s === 'false' || s === '0' || s === 'no' || s === 'off' || s === 'null') return false;
    return true;
  }
  if (typeof v === 'number') return v !== 0 && Number.isFinite(v);
  return Boolean(v);
}

/**
 * BUG-054：`baseUrl` 决定「解密后的 API Key 发到哪里」，而这条链上原本什么都不校验：
 * `model-client.ts` 把 key 放进 `Authorization: Bearer`，`model-catalog.ts` 的探测同样带 key，
 * 于是 `http://` 的兼容端点会让凭据在链路里裸奔。浏览器侧早有 `isBlockedHost`（SSRF），模型侧一处没用。
 *
 * 规则不能一刀切要 https：本壳的零配置入口就是 `http://127.0.0.1:11434`（Ollama 本机默认），
 * 局域网自建模型服务也是常见合法场景，所以：
 *   · `https:` 一律放行（主机不限，SSRF 面由各自的出网守卫管）；
 *   · `http:` 只放行回环（localhost / *.localhost / 127/8 / ::1 及其 IPv4-mapped 形态）与 RFC1918 私网
 *     （局域网自建模型服务是真实场景；公网 http 才是会穿越不可信链路的那一段）；
 *   · 其它协议（含无协议、`file:`、`ws:` 等）与解析失败一律拒——fail-closed，不猜用户意图。
 */
export function isProviderBaseUrlAllowed(url: unknown): { ok: true } | { ok: false; reason: string } {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return { ok: false, reason: '缺少 baseUrl' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `baseUrl 无法解析：${raw}` };
  }
  const proto = u.protocol.toLowerCase();
  if (proto === 'https:') return { ok: true };
  if (proto !== 'http:') {
    return { ok: false, reason: `只允许 https 或本机回环的 http，当前协议是 ${proto || '（无）'}` };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: true };
  // 必须是完整四段、每段 ≤255 的 127/8 点分十进制；用 `^127\.` 前缀匹配会把
  // `127.0.0.1.evil.test` 这种攻击者域名当成回环放行（本轮自己写的用例抓到）。
  // WHATWG 会把 http://2130706433 归一成 127.0.0.1，所以整数写法也一并覆盖。
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const octets = v4 && v4.slice(1).every((o) => Number(o) <= 255) ? v4.slice(1).map(Number) : null;
  // 127/8 回环
  const o0 = octets ? octets[0] ?? -1 : -1;
  const o1 = octets ? octets[1] ?? -1 : -1;
  if (octets && o0 === 127) return { ok: true };
  // RFC1918 私网（10/8、172.16-31、192.168/16）：局域网自建模型服务是真实场景（本机 NAS 就是 192.168.2.x），
  // 明文凭据只在同一二层网内流转；公网 http 仍然一律拒——那才是会穿越不可信链路的那一段。
  if (octets && (o0 === 10 || (o0 === 172 && o1 >= 16 && o1 <= 31) || (o0 === 192 && o1 === 168))) return { ok: true };
  if (host === '::1') return { ok: true };
  if (/^fe80:/.test(host)) return { ok: false, reason: '链路本地地址不允许明文 http（IPv6 fe80::/10）' };
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    if ((hi >> 8) === 127) return { ok: true };
  }
  return { ok: false, reason: '明文 http 只允许本机回环或私网地址；公网端点请改用 https' };
}
