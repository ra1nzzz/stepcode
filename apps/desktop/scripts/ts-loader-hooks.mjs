/**
 * 零依赖 TypeScript ESM loader hooks（ADR-0010：TS 直测）。
 *
 * 为什么需要它：OrchDesk 的纯逻辑模块（usage-registry / session-events /
 * data-dir / memory-* / connector-registry / plugin-market / sandbox-log /
 * credentials / agent-runtime）全部是 TypeScript，而验证套件是 CommonJS。
 * 现状必须先 `tsc` 再 require dist/*.js —— 一旦忘了编译，套件会用旧产物跑出
 * 「假通过」（2026-08-31 踩到过：rec.chunks undefined）。
 *
 * 为什么不装 esbuild/ts-node：Node 22.13+ 内置 `module.stripTypeScriptTypes()`
 *（amaro/swc），配合 ESM hooks 就够用，零依赖即零安装失败风险、零供应链面。
 *
 * 设计约束：
 * - 只接管 `.ts`；`.js/.json/.node` 一律交回默认 nextResolve/nextLoad，
 *   因此现有 CJS require 链路（含 stub electron 的 Module._load 钩子）不受影响。
 * - 源码是 TS 风格无扩展名相对导入（`./credentials`），也兼容 tsc 输出的
 *   `.js` 写法（`./credentials.js` → 映射到 credentials.ts）。
 * - 输出 format='module'：源码本身是 ESM 语法，只剥类型、不转模块系统。
 *
 * 注意：hooks 在独立线程执行，不能用父进程的任何闭包变量。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

/** 无扩展名导入时的探测顺序（TS 优先：我们要测的是源码）。 */
const PROBE_EXTS = ['.ts', '.mts', '.tsx', '.js', '.mjs', '.json'];

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
}

/**
 * 把 TS 风格的 specifier 解析到磁盘真实文件。
 * 规则：`./x` → x.ts（优先）/x.js/…；`./x.js` → 若 x.ts 存在则改指 x.ts。
 */
function resolveToDisk(specifier, parentURL) {
  const parentPath = parentURL ? fileURLToPath(parentURL) : path.join(process.cwd(), '_.js');
  const base = path.resolve(path.dirname(parentPath), specifier);
  const ext = path.extname(base);

  if (ext) {
    // './x.js' 是 TS 社区对 ESM 的兼容写法，磁盘上真实文件是 x.ts
    if (ext === '.js' || ext === '.mjs') {
      const tsSibling = base.replace(/\.(js|mjs)$/, '.ts');
      if (existsSync(tsSibling) && !existsSync(base)) return tsSibling;
    }
    return existsSync(base) ? base : null;
  }

  for (const probe of PROBE_EXTS) {
    const candidate = base + probe;
    if (existsSync(candidate)) return candidate;
  }
  // 目录导入 → index 探测
  for (const probe of PROBE_EXTS) {
    const candidate = path.join(base, 'index' + probe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (isRelative(specifier)) {
    // 剥掉 `?query#hash` 再探磁盘，命中后原样拼回（支持 cache-busting suffix）
    const cut = specifier.search(/[?#]/);
    const clean = cut === -1 ? specifier : specifier.slice(0, cut);
    const suffix = cut === -1 ? '' : specifier.slice(cut);
    const hit = resolveToDisk(clean, context.parentURL);
    if (hit) {
      return {
        url: pathToFileURL(hit).href + suffix,
        shortCircuit: true,
        format: suffix ? 'module' : (hit.endsWith('.ts') ? 'module' : undefined),
      };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // 用 pathname 判断而非 url.endsWith：允许 `./x.ts?v=2` 这类 cache-busting 后缀
  //（验证套件靠它证明「测的是源码实时内容，不是编译快照」）。
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  if (pathname.endsWith('.ts')) {
    const filePath = fileURLToPath(url);
    const source = readFileSync(filePath, 'utf-8');
    // mode='transform' 兼带 enum/namespace 等需降级语法（当前源码未用，留作保险）
    const code = stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
