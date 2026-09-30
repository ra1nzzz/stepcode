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
