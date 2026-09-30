/**
 * CommonJS 桥：让 .cjs 验证套件能够直接 import TypeScript 源码（ADR-0010）。
 *
 * 用法（套件里）：
 *   const { importTs } = require('./scripts/ts-load.cjs');
 *   const SE = await importTs('session-events.ts');   // 相对 apps/desktop/
 *
 * 只影响 dynamic import()，不动 require() —— 因此现有「stub electron +
 * require dist/main.js」的 IPC 驱动套件完全不受牵连。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');

let registered = false;

/** 幂等注册 TS loader hooks。重复调用无副作用。 */
function registerTsLoader() {
  if (registered) return;
  register(pathToFileURL(path.join(__dirname, 'ts-loader-hooks.mjs')).href);
  registered = true;
}

/**
 * 以 ESM 方式载入一份 TS 源码（路径相对 apps/desktop/，或传绝对路径）。
 * 返回模块命名空间对象（与 await import() 同形）。
 */
async function importTs(relOrAbs) {
  registerTsLoader();
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(__dirname, '..', relOrAbs);
  // 允许 `x.ts?t=2` 这类 cache-busting 后缀（ESM 对带 query 的 URL 不走缓存）
  const cut = abs.search(/[?#]/);
  const clean = cut === -1 ? abs : abs.slice(0, cut);
  const suffix = cut === -1 ? '' : abs.slice(cut);
  return import(pathToFileURL(clean).href + suffix);
}

module.exports = { registerTsLoader, importTs };
