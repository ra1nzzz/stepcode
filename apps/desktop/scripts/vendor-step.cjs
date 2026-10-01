/**
 * 把锁定包打进桌面壳。
 *
 * 壳在开发态从旁边的 git 检出加载，打包后没有那份检出，也没有 git。
 * 这里把锁定点的 coding-agent 及其四个同级依赖复制到 vendor/step，
 * 并写一份 step-lock.json。electron-builder 把它放进 resources/step，
 * resolveStepCheckout 先读这份清单，不再跑 git。
 *
 * 只复制 dist 和 package.json。源码、测试、docs 不进包。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const CHECKOUT = path.resolve(APP_DIR, '..', '..', '..', 'Step-Code-93ebc5be');
const DEST = path.join(APP_DIR, 'vendor', 'step');
const PACKAGES = ['coding-agent', 'agent-core', 'providers', 'tui', 'config'];

function copyDist(name) {
  const src = path.join(CHECKOUT, 'packages', name);
  const entry = path.join(src, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error(`[vendor-step] ${name} 没有 dist/index.js，先在锁定点检出里构建`);
    process.exit(1);
  }
  const dst = path.join(DEST, 'packages', name);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'));
  console.log(`[vendor-step] ${name}`);
}

function main() {
  if (!fs.existsSync(path.join(CHECKOUT, '.git'))) {
    console.error(`[vendor-step] 找不到锁定点检出：${CHECKOUT}`);
    process.exit(1);
  }
  const text = execFileSync('git', ['-C', CHECKOUT, 'log', '-1', '--format=%H%n%T'], { encoding: 'utf8' });
  const [commit, tree] = text.trim().split(/\r?\n/);
  fs.rmSync(DEST, { recursive: true, force: true });
  for (const name of PACKAGES) copyDist(name);
  fs.writeFileSync(path.join(DEST, 'step-lock.json'), JSON.stringify({ commit, tree }, null, 2));
  console.log(`[vendor-step] 清单 ${commit.slice(0, 8)} / ${tree.slice(0, 8)}`);
}

main();
