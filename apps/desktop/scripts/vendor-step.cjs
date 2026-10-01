/**
 * 把官方运行时打进桌面壳。
 *
 * 不能直接拷 packages/*\/dist：那些文件里有 82 种裸导入
 * （@step-harness/*、chalk、typebox…），打包后没有 node_modules 可解析，
 * 加载会在 ERR_MODULE_NOT_FOUND 上失败。
 *
 * 这里用官方同一个 esbuild 把 coding-agent 的库入口打成单文件 index.js。
 * 打不进去的两个依赖（photon-node 的 wasm、jiti 的按需加载器）放在 runtime/ 下，
 * 用相对路径引入 —— 不叫 node_modules，因为 electron-builder 会把那个目录名滤掉。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const CHECKOUT = process.env.ORCHDESK_STEP_CODE?.trim()
  || path.resolve(APP_DIR, '..', '..', '..', 'Step-Code-93ebc5be');
const CODING_AGENT = path.join(CHECKOUT, 'packages', 'coding-agent');
const DEST = path.join(APP_DIR, 'vendor', 'step');

/**
 * 留在包外的依赖，以及它们在产物里的相对落点。
 * 两个包都没有自己的运行时依赖，jiti 只用内建模块，photon-node 从同级读 wasm。
 */
const EXTERNALS = [
  { specifier: '@silvia-odwyer/photon-node', from: '@silvia-odwyer/photon-node', to: 'runtime/photon-node', entry: 'photon_rs.js' },
  { specifier: 'jiti', from: 'jiti', to: 'runtime/jiti', entry: 'lib/jiti.mjs' },
  { specifier: 'jiti/static', from: 'jiti', to: 'runtime/jiti', entry: 'lib/jiti-static.mjs' },
];

const relativize = () => ({
  name: 'step-externals',
  setup(build) {
    for (const ext of EXTERNALS) {
      build.onResolve({ filter: new RegExp(`^${ext.specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => ({
        path: `./${ext.to}/${ext.entry}`,
        external: true,
      }));
    }
  },
});

function bundle() {
  const entry = path.join(CODING_AGENT, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error(`[vendor-step] 官方运行时尚未构建：${entry}`);
    process.exit(1);
  }
  const esbuild = require(path.join(CHECKOUT, 'node_modules', 'esbuild'));
  return esbuild.build({
    entryPoints: [entry],
    outfile: path.join(DEST, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.19',
    splitting: false,
    minifySyntax: true,
    minifyWhitespace: true,
    legalComments: 'none',
    logLevel: 'warning',
    absWorkingDir: CHECKOUT,
    plugins: [relativize()],
    banner: { js: 'import { createRequire as __scRequire } from "node:module"; const require = __scRequire(import.meta.url);' },
  });
}

function copyExternals() {
  const source = path.join(CODING_AGENT, 'node_modules');
  for (const ext of EXTERNALS) {
    const from = path.join(source, ext.from);
    if (!fs.existsSync(from)) {
      console.error(`[vendor-step] 外部依赖不在检出里：${ext.from}`);
      process.exit(1);
    }
    const to = path.join(DEST, ext.to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(fs.realpathSync(from), to, { recursive: true, dereference: true });
  }
}

function main() {
  if (!fs.existsSync(path.join(CHECKOUT, '.git'))) {
    console.error(`[vendor-step] 找不到官方检出：${CHECKOUT}`);
    process.exit(1);
  }
  const text = execFileSync('git', ['-C', CHECKOUT, 'log', '-1', '--format=%H%n%T'], { encoding: 'utf8' });
  const [commit, tree] = text.trim().split(/\r?\n/);
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });

  return bundle().then(() => {
    copyExternals();
    // 让 Node 按 ESM 解析，省掉每次启动的语法重解析。
    fs.writeFileSync(path.join(DEST, 'package.json'), JSON.stringify({ name: 'stepcode-runtime', private: true, type: 'module' }, null, 2));
    fs.writeFileSync(path.join(DEST, 'step-origin.json'), JSON.stringify({ source: 'stepfun-ai/Step-Code', commit, tree }, null, 2));
    fs.writeFileSync(path.join(DEST, 'step-lock.json'), JSON.stringify({ commit, tree }, null, 2));
    const size = fs.statSync(path.join(DEST, 'index.js')).size / 1024 / 1024;
    console.log(`[vendor-step] 打包 ${commit.slice(0, 8)}，外部依赖 ${EXTERNALS.map((e) => e.specifier).join(', ')}，${size.toFixed(1)} MiB`);
  });
}

main().catch((err) => {
  console.error(`[vendor-step] ${err.message}`);
  process.exit(1);
});
