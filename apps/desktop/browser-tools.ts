/**
 * 浏览器工具（Browser Tools）—— 纯逻辑层（零 electron 依赖，可 node 直测）
 * ----------------------------------------------------------------------------
 * 能力来源：Electron 自带的 CDP（webContents.debugger，协议 1.3），不引入
 * playwright / puppeteer 任何额外依赖（ADR-0011）。宿主侧实现见 browser-cdp.ts，
 * 本文件只负责「与运行环境无关」的部分：
 *
 *   1. 工具定义（OpenAI function-calling schema）
 *   2. 参数归一化与校验（URL 协议、选择器、超时钳制、waitUntil 枚举）
 *   3. 页面内 JS 表达式构造（选择器 / 文本一律经 JSON.stringify 转义后注入）
 *   4. browser_eval 的脚本风险扫描（只做提示与留痕，不做静默改写）
 *   5. 截图落盘路径规则（相对 dataDir 的子路径，绝对路径由宿主拼接）
 *   6. 结果裁剪与状态描述
 *
 * 为什么把「表达式构造」放这里：这是本模块唯一容易出现注入的地方
 * （模型给的选择器 / 文本要拼进 JS 源码）。放在纯逻辑层才能单测断言
 * 「引号、反斜杠、换行、</script> 都不会逃逸出字符串字面量」。
 */

import { clampInt, toBool } from './common-tools';
import type { ToolDef } from './agent-runtime';

// ---------------------------------------------------------------------------
// 常量（前置声明：BROWSER_TOOL_DEFS 的描述文案要引用这些默认/上限，
// 必须声明在工具定义之前；钳制函数 clampBrowserTimeout 复用同一组常量）
// ---------------------------------------------------------------------------

/** 导航等待上限（模型乱填 999999 时不至于挂死整个回合）。 */
export const BROWSER_NAV_TIMEOUT_MIN = 1000;
export const BROWSER_NAV_TIMEOUT_MAX = 60_000;
export const BROWSER_NAV_TIMEOUT_DEFAULT = 20_000;

/** 元素等待上限（click 用，比导航短——元素找不到的反馈要快）。 */
export const BROWSER_ACTION_TIMEOUT_MIN = 500;
export const BROWSER_ACTION_TIMEOUT_MAX = 30_000;
export const BROWSER_ACTION_TIMEOUT_DEFAULT = 5000;

/** browser_eval 执行上限。 */
export const BROWSER_EVAL_TIMEOUT_MIN = 500;
export const BROWSER_EVAL_TIMEOUT_MAX = 30_000;
export const BROWSER_EVAL_TIMEOUT_DEFAULT = 10_000;

/**
 * 截图超时（CDP 走合成器取帧，取不到帧时会**永久挂起而不是报错**——
 * 远程桌面 / 锁屏 / 无 GPU 会话下实测必挂）。超时后回退 Electron 原生
 * capturePage：它不依赖合成器，实测 68ms 出图。没有这个兜底，
 * browser_screenshot 会把整个回合卡住直到进程被杀。
 */
export const BROWSER_SHOT_TIMEOUT_MIN = 500;
export const BROWSER_SHOT_TIMEOUT_MAX = 30_000;
export const BROWSER_SHOT_TIMEOUT_DEFAULT = 8000;

/** 缩略图最大宽度（UI 面板用，data URL 不落盘）。 */
export const BROWSER_SHOT_THUMB_WIDTH = 480;

/** 文本返回上限（默认 8000：约 4K token，留出模型回答空间）。 */
export const BROWSER_TEXT_DEFAULT = 8000;
export const BROWSER_TEXT_MAX = 30_000;

export const BROWSER_LINKS_DEFAULT = 30;
export const BROWSER_LINKS_MAX = 100;

/** 选择器长度上限：防御性限制，避免畸形长串拖垮页面求值。 */
export const BROWSER_SELECTOR_MAX = 500;

/** 表达式长度上限（browser_eval）。 */
export const BROWSER_EXPRESSION_MAX = 20_000;

/** 页面内求值缺失元素时的哨兵（宿主据此给出「选择器没命中」而不是空字符串）。 */
export const BROWSER_NO_ELEMENT = '__ORCHDESK_NO_ELEMENT__';

export const BROWSER_WAIT_MODES = ['load', 'dom'] as const;
export type BrowserWaitMode = typeof BROWSER_WAIT_MODES[number];

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export const BROWSER_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: '打开内置浏览器并访问网址（复用同一窗口，保留登录态）；返回页面标题与地址',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) 开头的网址；可省略协议（自动补 https://）' },
          waitUntil: { type: 'string', description: 'load（默认，等页面加载完成）或 dom（仅等 DOM 就绪，更快）' },
          timeout: { type: 'number', description: `等待毫秒数，默认 ${BROWSER_NAV_TIMEOUT_DEFAULT}，上限 ${BROWSER_NAV_TIMEOUT_MAX}` },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_text',
      description: '读取当前页面的可见文本（可指定 CSS 选择器限定区域）',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '可选的 CSS 选择器；省略则取整个 body' },
          maxChars: { type: 'number', description: `返回字符上限，默认 ${BROWSER_TEXT_DEFAULT}，上限 ${BROWSER_TEXT_MAX}` },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_links',
      description: '列出当前页面的链接（文本 + 地址），比读全文更省上下文',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '可选的 CSS 选择器，限定取链接的区域' },
          limit: { type: 'number', description: `最多返回条数，默认 ${BROWSER_LINKS_DEFAULT}，上限 ${BROWSER_LINKS_MAX}` },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击页面中匹配 CSS 选择器的元素（会改变页面状态，需要授权）',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器，如 #submit 或 button.primary' },
          timeout: { type: 'number', description: `等待元素出现的毫秒数，默认 ${BROWSER_ACTION_TIMEOUT_DEFAULT}，上限 ${BROWSER_ACTION_TIMEOUT_MAX}` },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '向输入框填入文本（支持 React/Vue 受控组件；需要授权）',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '目标的 CSS 选择器' },
          text: { type: 'string', description: '要填入的文本' },
          clear: { type: 'boolean', description: '填入前是否清空原有内容，默认 true' },
          pressEnter: { type: 'boolean', description: '填完后是否回车提交，默认 false' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '对当前页面截图并保存到数据目录，返回图片绝对路径（同时可在「浏览器」面板查看缩略图）',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: '是否截取整页（超出视口部分），默认 false' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_eval',
      description: '在页面上下文中执行 JavaScript 表达式并返回值（高危：等价在网页里执行代码，必须经用户授权）',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '要执行的 JS 表达式（不是语句块；用 IIFE 可写多步逻辑）' },
          timeout: { type: 'number', description: `执行超时毫秒数，默认 ${BROWSER_EVAL_TIMEOUT_DEFAULT}，上限 ${BROWSER_EVAL_TIMEOUT_MAX}` },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: '关闭内置浏览器窗口（释放资源；登录态保留在用户数据目录）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

export const BROWSER_TOOL_NAMES: string[] = BROWSER_TOOL_DEFS.map((t) => t.function.name);

/** 各浏览器工具的主参数名（模型把参数写成裸字符串时兜底）。browser_close 无参数，不入表。 */
export const BROWSER_TOOL_PRIMARY_ARG: Record<string, string> = {
  browser_open: 'url',
  browser_text: 'selector',
  browser_links: 'selector',
  browser_click: 'selector',
  browser_type: 'selector',
  browser_screenshot: 'fullPage',
  browser_eval: 'expression',
};

/** 需要过授权门的工具（会改变页面/站内状态，与 file_write 同档）。 */
export const BROWSER_WRITE_TOOLS: string[] = ['browser_click', 'browser_type', 'browser_eval'];

// ④M-3：超时 / 文本 / 链接等默认与上限已前置到文件顶部「常量」区
// （供 BROWSER_TOOL_DEFS 描述文案引用），此处仅剩协议白名单与归一化逻辑。

export const BROWSER_URL_PROTOCOLS = ['http:', 'https:'];

// ---------------------------------------------------------------------------
// 参数归一化
// ---------------------------------------------------------------------------

/** 超时钳制（导航 / 元素等待 / 求值各自上下限不同）。 */
// clampInt 已收敛到 common-tools（原本 browser/terminal/file/pty 各有一份，
// 口径会漂移）；「空串必须回落默认值」的语义见 common-tools.clampInt 注释。
export function clampBrowserTimeout(v: unknown, kind: 'nav' | 'action' | 'eval' | 'shot'): number {
  if (kind === 'nav') return clampInt(v, BROWSER_NAV_TIMEOUT_MIN, BROWSER_NAV_TIMEOUT_MAX, BROWSER_NAV_TIMEOUT_DEFAULT);
  if (kind === 'action') return clampInt(v, BROWSER_ACTION_TIMEOUT_MIN, BROWSER_ACTION_TIMEOUT_MAX, BROWSER_ACTION_TIMEOUT_DEFAULT);
  if (kind === 'shot') return clampInt(v, BROWSER_SHOT_TIMEOUT_MIN, BROWSER_SHOT_TIMEOUT_MAX, BROWSER_SHOT_TIMEOUT_DEFAULT);
  return clampInt(v, BROWSER_EVAL_TIMEOUT_MIN, BROWSER_EVAL_TIMEOUT_MAX, BROWSER_EVAL_TIMEOUT_DEFAULT);
}

/**
 * URL 归一化：补协议、去空白、拒绝非 http(s)。
 * 拒绝 file:// / javascript: / data: —— 浏览器工具的威胁面就是「以用户身份访问网页」，
 * 本地文件与脚本伪协议会把沙箱直接掀翻。
 */
export function normalizeBrowserUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'URL 为空' };
  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withProtocol);
  } catch {
    return { ok: false, error: `URL 无法解析：${s.slice(0, 120)}` };
  }
  if (!BROWSER_URL_PROTOCOLS.includes(u.protocol)) {
    return { ok: false, error: `仅允许 http/https 协议，收到 ${u.protocol}` };
  }
  if (!u.hostname) return { ok: false, error: 'URL 缺少主机名' };
  return { ok: true, url: u.toString() };
}

function cleanSelector(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, BROWSER_SELECTOR_MAX);
}

/** 是否正常化 waitUntil（未知值回落 load，不报错——模型多写了一个词不该让整轮失败）。 */
export function normalizeWaitMode(raw: unknown): BrowserWaitMode {
  const s = String(raw ?? '').trim().toLowerCase();
  return (BROWSER_WAIT_MODES as readonly string[]).includes(s) ? (s as BrowserWaitMode) : 'load';
}

export interface BrowserOpenArgs {
  url: string;
  waitUntil: BrowserWaitMode;
  timeoutMs: number;
}
export interface BrowserTextArgs {
  selector: string;
  maxChars: number;
}
export interface BrowserLinksArgs {
  selector: string;
  limit: number;
}
export interface BrowserClickArgs {
  selector: string;
  timeoutMs: number;
}
export interface BrowserTypeArgs {
  selector: string;
  text: string;
  clear: boolean;
  pressEnter: boolean;
}
export interface BrowserScreenshotArgs {
  fullPage: boolean;
  /** CDP 取不到帧时会永久挂起，超时后回退 capturePage（详见 capturePng 注释）。 */
  timeoutMs: number;
}
export interface BrowserEvalArgs {
  expression: string;
  timeoutMs: number;
}

export type BrowserArgs =
  | ({ name: 'browser_open' } & BrowserOpenArgs)
  | ({ name: 'browser_text' } & BrowserTextArgs)
  | ({ name: 'browser_links' } & BrowserLinksArgs)
  | ({ name: 'browser_click' } & BrowserClickArgs)
  | ({ name: 'browser_type' } & BrowserTypeArgs)
  | ({ name: 'browser_screenshot' } & BrowserScreenshotArgs)
  | ({ name: 'browser_eval' } & BrowserEvalArgs)
  | { name: 'browser_close' };

/**
 * 归一化浏览器工具参数。返回 ok:false 时宿主直接把 error 回给模型，
 * 不做「猜一个值继续跑」——猜错的选择器会静默点错按钮，比报错更危险。
 */
export function normalizeBrowserArgs(
  name: string,
  args: Record<string, unknown>,
): { ok: true; value: BrowserArgs } | { ok: false; error: string } {
  const a = args || {};
  switch (name) {
    case 'browser_open': {
      const u = normalizeBrowserUrl(a.url);
      if (!u.ok) return u;
      return {
        ok: true,
        value: { name, url: u.url, waitUntil: normalizeWaitMode(a.waitUntil), timeoutMs: clampBrowserTimeout(a.timeout, 'nav') },
      };
    }
    case 'browser_text': {
      return {
        ok: true,
        value: { name, selector: cleanSelector(a.selector), maxChars: clampInt(a.maxChars, 200, BROWSER_TEXT_MAX, BROWSER_TEXT_DEFAULT) },
      };
    }
    case 'browser_links': {
      return {
        ok: true,
        value: { name, selector: cleanSelector(a.selector), limit: clampInt(a.limit, 1, BROWSER_LINKS_MAX, BROWSER_LINKS_DEFAULT) },
      };
    }
    case 'browser_click': {
      const sel = cleanSelector(a.selector);
      if (!sel) return { ok: false, error: 'selector 不能为空（browser_click 需要知道点哪个元素）' };
      return { ok: true, value: { name, selector: sel, timeoutMs: clampBrowserTimeout(a.timeout, 'action') } };
    }
    case 'browser_type': {
      const sel = cleanSelector(a.selector);
      if (!sel) return { ok: false, error: 'selector 不能为空（browser_type 需要知道填哪个输入框）' };
      const text = String(a.text ?? '');
      if (!text) return { ok: false, error: 'text 不能为空' };
      return {
        ok: true,
        value: {
          name,
          selector: sel,
          text: text.slice(0, 10_000),
          clear: toBool(a.clear, true), // 缺省清空；显式 "false" 才保留原内容
          pressEnter: toBool(a.pressEnter),
        },
      };
    }
    case 'browser_screenshot': {
      return { ok: true, value: { name, fullPage: toBool(a.fullPage), timeoutMs: clampBrowserTimeout(a.timeout, 'shot') } };
    }
    case 'browser_eval': {
      const expr = String(a.expression ?? '').trim();
      if (!expr) return { ok: false, error: 'expression 不能为空' };
      if (expr.length > BROWSER_EXPRESSION_MAX) {
        return { ok: false, error: `expression 过长（${expr.length} 字符，上限 ${BROWSER_EXPRESSION_MAX}）` };
      }
      return { ok: true, value: { name, expression: expr, timeoutMs: clampBrowserTimeout(a.timeout, 'eval') } };
    }
    case 'browser_close': {
      return { ok: true, value: { name } };
    }
    default:
      return { ok: false, error: `不是浏览器工具：${name}` };
  }
}

// ---------------------------------------------------------------------------
// 页面内 JS 表达式构造（注入面：一律 JSON.stringify 后嵌入）
// ---------------------------------------------------------------------------

/** 选择器 → 求值片段。空选择器表示整个文档。 */
function rootExpr(selector: string): string {
  return selector
    ? `(document.querySelector(${JSON.stringify(selector)}))`
    : '(document.body)';
}

/** 读可见文本。 */
export function buildTextExpression(selector: string, maxChars: number): string {
  const lim = clampInt(maxChars, 200, BROWSER_TEXT_MAX, BROWSER_TEXT_DEFAULT);
  return `(() => { const el = ${rootExpr(selector)}; if (!el) return ${JSON.stringify(BROWSER_NO_ELEMENT)};`
    + ` const t = (el.innerText || el.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();`
    + ` return t.slice(0, ${lim}); })()`;
}

/** 列出链接（文本 + 绝对地址）。 */
export function buildLinksExpression(selector: string, limit: number): string {
  const lim = clampInt(limit, 1, BROWSER_LINKS_MAX, BROWSER_LINKS_DEFAULT);
  return `(() => { const root = ${rootExpr(selector)}; if (!root) return ${JSON.stringify(BROWSER_NO_ELEMENT)};`
    + ` const as = Array.from(root.querySelectorAll('a[href]')).slice(0, ${lim});`
    + ` if (!as.length) return '(页面内没有链接)';`
    + ` return as.map(a => ((a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim() || '(无文本)') + ' -> ' + a.href).join('\\n'); })()`;
}

/** 点击（含滚动到视野内，避免懒加载/遮挡导致点空）。 */
export function buildClickExpression(selector: string): string {
  return `(() => { const el = ${rootExpr(selector)}; if (!el) return ${JSON.stringify(BROWSER_NO_ELEMENT)};`
    + ` if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });`
    + ` el.click();`
    + ` return 'clicked ' + String(el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : ''); })()`;
}

/** 填值：兼容 React/Vue 受控组件（用原型 setter + input 事件，而不是直接赋值）。 */
export function buildTypeExpression(selector: string, text: string, opts: { clear?: boolean; pressEnter?: boolean } = {}): string {
  const clear = opts.clear === undefined ? true : Boolean(opts.clear);
  const enter = Boolean(opts.pressEnter);
  return `(() => { const el = ${rootExpr(selector)}; if (!el) return ${JSON.stringify(BROWSER_NO_ELEMENT)};`
    + ` const tag = String(el.tagName || '').toLowerCase();`
    + ` if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) return '${BROWSER_NO_ELEMENT}:not-input';`
    + ` el.focus();`
    + ` const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;`
    + ` const setter = Object.getOwnPropertyDescriptor(proto, 'value');`
    + (clear ? ` if (setter && setter.set) setter.set.call(el, ''); else el.value = '';` : '')
    + ` const next = ${JSON.stringify(text)};`
    + ` if (setter && setter.set) setter.set.call(el, next); else el.value = next;`
    + ` el.dispatchEvent(new Event('input', { bubbles: true }));`
    + ` el.dispatchEvent(new Event('change', { bubbles: true }));`
    + (enter ? ` el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));` : '')
    + ` return 'typed ' + next.length + ' chars into ' + tag; })()`;
}

/** 等待元素出现（轮询，不用 sleep 死等）。 */
export function buildWaitForSelectorExpression(selector: string, timeoutMs: number): string {
  const t = clampInt(timeoutMs, BROWSER_ACTION_TIMEOUT_MIN, BROWSER_ACTION_TIMEOUT_MAX, BROWSER_ACTION_TIMEOUT_DEFAULT);
  return `(async () => { const sel = ${JSON.stringify(selector)}; const deadline = Date.now() + ${t};`
    + ` while (Date.now() < deadline) { if (document.querySelector(sel)) return 'found';`
    + ` await new Promise(r => setTimeout(r, 100)); }`
    + ` return ${JSON.stringify(BROWSER_NO_ELEMENT)}; })()`;
}

// ---------------------------------------------------------------------------
// browser_eval 风险扫描
// ---------------------------------------------------------------------------

interface RiskRule {
  tag: string;
  re: RegExp;
}

/**
 * 风险特征表。只用于**提示与留痕**：审批弹窗展示、沙箱日志 reason。
 * 不做静默改写或拦截——browser_eval 本身就要过授权门，拦在门里比藏在正则里清楚。
 */
const RISK_RULES: RiskRule[] = [
  { tag: '外发请求', re: /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\s*\(/ },
  { tag: '读取 Cookie', re: /document\s*\.\s*cookie/ },
  { tag: '本地存储', re: /\b(localStorage|sessionStorage|indexedDB)\b/ },
  { tag: '打开新窗口', re: /\b(window\s*\.\s*open|showModalDialog)\s*\(/ },
  { tag: '页面跳转', re: /location\s*\.\s*(href|assign|replace)\s*=|location\s*=/ },
  { tag: '表单提交', re: /\.?\bsubmit\s*\(/ },
  { tag: '动态求值', re: /\b(eval|Function)\s*\(/ },
  { tag: '下载/打印', re: /\b(window\s*\.\s*print|document\s*\.\s*execCommand)\s*\(/ },
];

/**
 * 扫描表达式里的风险特征。
 * 先剥字符串字面量与注释再扫，避免「正文里提到 fetch」就报警（噪声会让人忽略真警报）。
 */
export function scanScriptRisks(expression: string): string[] {
  const src = String(expression ?? '');
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
  const tags: string[] = [];
  for (const r of RISK_RULES) {
    if (r.re.test(stripped) && !tags.includes(r.tag)) tags.push(r.tag);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// 截图落盘路径（纯逻辑只出相对子路径，绝对路径由宿主拼 dataDir）
// ---------------------------------------------------------------------------

/** 截图存放的 dataDir 子目录名。 */
export const BROWSER_SHOT_DIR = 'browser-shots';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 截图文件相对路径：browser-shots/YYYY-MM-DD/shot-HHMMSS-<seq>.png
 * 按天分目录：一次任务可能截几十张，摊平会让「打开目录」变得没法看。
 */
export function browserShotRelativePath(ts: number, seq: number, ext = 'png'): string {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hms = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const safeExt = String(ext || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
  return `${BROWSER_SHOT_DIR}/${day}/shot-${hms}-${seq}.${safeExt}`;
}

// ---------------------------------------------------------------------------
// 结果裁剪与状态描述
// ---------------------------------------------------------------------------

/** 页面文本回传模型前的收尾（统一换行 + 上限裁剪）。超出时明确告知被截断。 */
export function clipBrowserText(text: string, maxChars: number): string {
  const lim = clampInt(maxChars, 200, BROWSER_TEXT_MAX, BROWSER_TEXT_DEFAULT);
  const s = String(text ?? '').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length <= lim) return s || '(页面无可见文本)';
  return `${s.slice(0, lim)}\n…（已截断，页面共 ${s.length} 字符）`;
}

/**
 * 页面快照（UI 重构：侧栏浏览器 TAB 的数据源）。
 * 底层是**单个隐藏 CDP 窗口**——同一时刻只有一个活跃页面，但 Agent 会先后访问多个
 * URL。每次导航登记一张卡片（标题/URL/缩略图），侧栏据此渲染可单关/全关的 TAB 列表。
 * 这里如实表达「访问过的页面快照」，绝不冒充「多个页面同时存在」。
 */
export interface BrowserPageSnapshot {
  id: string;
  url: string;
  title: string;
  /** 缩略图 data URL（该页面截过图才有）。 */
  shot?: string;
  /** 首次访问时间戳（ms）。 */
  at: number;
  /** 是否为窗口当前停留的页面。 */
  active: boolean;
}

/** 页面快照上限：只保留最近访问的若干张，避免长时间会话无界累积。 */
export const BROWSER_PAGES_MAX = 12;

export interface BrowserStateSnapshot {
  open: boolean;
  url?: string;
  title?: string;
  visible?: boolean;
  /** 最近一次截图（绝对路径 + 缩略图 data URL，供 UI 展示）。 */
  lastShot?: { path: string; dataUrl?: string } | null;
  lastError?: string;
  /** 页面快照 TAB（按访问先后登记，最新的在前）。未打开浏览器时为 []。 */
  pages?: BrowserPageSnapshot[];
}

/** 浏览器状态 → 给模型看的一句话（工具结果 / 状态查询共用同一口径）。 */
export function describeBrowserState(st: BrowserStateSnapshot): string {
  if (!st.open) return '浏览器未打开（先用 browser_open 打开网址）';
  const parts: string[] = [];
  parts.push(st.title ? `标题：${st.title}` : '标题：(无)');
  parts.push(st.url ? `地址：${st.url}` : '地址：(无)');
  if (st.visible !== undefined) parts.push(st.visible ? '窗口：已显示' : '窗口：后台隐藏');
  if (st.lastError) parts.push(`最近错误：${st.lastError}`);
  return parts.join('\n');
}

/** 工具结果摘要（步骤条 / 通知用，比完整结果短）。 */
export function summarizeBrowserResult(name: string, result: string): string {
  const one = String(result || '').replace(/\s+/g, ' ').trim();
  if (!one) return `${name} 完成`;
  return one.length <= 120 ? one : `${one.slice(0, 120)}…`;
}
