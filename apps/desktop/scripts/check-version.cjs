/**
 * 版本守卫（SemVer 治理的机器执行）
 * ----------------------------------------------------------------------------
 * 规则：打包产物的版本号必须与最新 git tag 不同 —— 禁止在已发布版本号上重复打包。
 *   - dist / dist:win / dist:portable 前置调用（严格模式）：version == 最新 tag → 阻断，
 *     提示先 `npm run version:bump`
 *   - release 流程传 --allow-tagged：仅当最新 tag 恰好指向当前 HEAD（bumpp 刚打的
 *     正式发布 tag）时放行；tag 指向别的提交仍然阻断
 * 仓库无任何 tag（首次构建）放行。
 *
 * 文档同步：README.md / CHECKPOINT.md 必须与 apps/desktop/package.json 的 version 对齐。
 *   - 参数含 `docs`：只跑文档检查（verify 链用，避免已发布版本被 tag 守卫误红）
 *   - 其它模式：先跑文档检查，再跑 tag 守卫
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');
const allowTagged = process.argv.includes('--allow-tagged');
const pkg = require(path.join(APP_DIR, 'package.json'));

function checkDocsSynced() {
  const version = String(pkg.version);
  const readmePath = path.join(REPO_ROOT, 'README.md');
  const checkpointPath = path.join(REPO_ROOT, 'docs', '00-项目', 'CHECKPOINT.md');

  let readme;
  try {
    readme = fs.readFileSync(readmePath, 'utf8');
  } catch (err) {
    console.error('[version-guard] 无法读取仓库根 README.md:', (err && err.message) || err);
    process.exit(1);
  }
  const readmeNeedle = `当前版本：v${version}`;
  if (!readme.includes(readmeNeedle)) {
    console.error(`[version-guard] README.md 未同步：必须含「${readmeNeedle}」`);
    process.exit(1);
  }

  let checkpoint;
  try {
    checkpoint = fs.readFileSync(checkpointPath, 'utf8');
  } catch (err) {
    console.error('[version-guard] 无法读取 CHECKPOINT.md:', (err && err.message) || err);
    process.exit(1);
  }
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cellRe = new RegExp('\\|\\s*\\*\\*当前版本\\*\\*\\s*\\|\\s*`' + escaped + '`');
  if (!cellRe.test(checkpoint)) {
    console.error(
      `[version-guard] CHECKPOINT.md 未同步：当前版本单元格必须以 \`${version}\` 开头` +
        `（| **当前版本** | \`${version}\`）`,
    );
    process.exit(1);
  }

  console.log(`[version-guard] docs OK：README/CHECKPOINT 与 package.json ${version} 一致`);
}

function git(cmd) {
  return execSync(cmd, { cwd: APP_DIR }).toString().trim();
}

checkDocsSynced();

if (process.argv.includes('docs')) {
  process.exit(0);
}

let latest = '';
try {
  latest = git('git describe --tags --abbrev=0');
} catch {
  console.log('[version-guard] 仓库尚无 tag，放行（首次构建）');
  process.exit(0);
}

if (latest !== `v${pkg.version}`) {
  console.log(`[version-guard] OK：package.json ${pkg.version} ≠ 最新 tag ${latest}`);
  process.exit(0);
}

// version == 最新 tag：检查是否为「刚打完 tag 的正式发布」场景
if (allowTagged) {
  try {
    const tagHead = git(`git rev-list -1 ${latest}`);
    const head = git('git rev-parse HEAD');
    if (tagHead === head) {
      console.log(`[version-guard] OK（release）：${latest} 指向当前 HEAD，允许正式发布构建`);
      process.exit(0);
    }
    console.error(`[version-guard] ${latest} 指向 ${tagHead.slice(0, 8)}，而 HEAD 是 ${head.slice(0, 8)} —— 请先 version:bump`);
    process.exit(1);
  } catch (err) {
    console.error('[version-guard] 解析 tag 指向失败:', (err && err.message) || err);
    process.exit(1);
  }
}

console.error(
  `[version-guard] 禁止在同一版本号上重复打包：package.json=${pkg.version} 与最新 tag ${latest} 相同。\n` +
  '  请先递增版本（SemVer：feat→minor / fix→patch）：npm run version:bump',
);
process.exit(1);
