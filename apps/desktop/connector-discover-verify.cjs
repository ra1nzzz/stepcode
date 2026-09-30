/**
 * 连接器自动发现验证（connector-discover）。
 *
 * A 组：纯解析（parseGitCredentials / findGithubFromGitCredentials / parseGhHosts）。
 * B 组：discoverConnector 用临时 home 目录（注入存在性/读取回调）驱动真实文件 IO 形状。
 *
 * 运行：node connector-discover-verify.cjs（需先 npx tsc -p tsconfig.json）
 */
const path = require('path');
const APP_DIR = __dirname;
const CD = require(path.join(APP_DIR, 'dist', 'connector-discover.js'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  console.log('== 连接器自动发现（本地 CLI 登录态）==');

  /* ============================== A 组：纯解析 ============================== */

  await check('parseGitCredentials：正常行解析 host/user/pass', () => {
    const r = CD.parseGitCredentials('https://octocat:ghp_abc123def456@github.com\nhttps://x:t@gitlab.com\n');
    assert(r.length === 2, `应有 2 条，实际 ${r.length}`);
    const gh = r.find((e) => e.host === 'github.com');
    assert(gh && gh.user === 'octocat' && gh.password === 'ghp_abc123def456', 'github 凭据解析正确');
  });

  await check('parseGitCredentials：空行/注释/坏行跳过，不抛', () => {
    const r = CD.parseGitCredentials('# comment\n\nnot-a-url\nhttps://u:p@github.com\n');
    assert(r.length === 1 && r[0].host === 'github.com', `只留合法行（实际 ${r.length}）`);
  });

  await check('parseGitCredentials：token 含特殊字符（@ :）不被截断到错误位置', () => {
    // token 若含 @ 会被当分隔符，属真实限制；这里验证常见 token（无 @）正确。
    const r = CD.parseGitCredentials('https://u:github_pat_ABC_1234567890abcdef@github.com\n');
    assert(r.length === 1 && r[0].password === 'github_pat_ABC_1234567890abcdef', 'token 完整');
  });

  await check('findGithubFromGitCredentials：命中 github.com 返回可用的 git-credentials 源', () => {
    const entries = CD.parseGitCredentials('https://octocat:ghp_real@github.com\n');
    const cred = CD.findGithubFromGitCredentials(entries);
    assert(!!cred, '应命中');
    assert(cred.connectorId === 'github' && cred.secret === 'ghp_real' && cred.usable === true, 'secret/usable 正确');
    assert(/git-credentials/.test(cred.source), '来源标注');
  });

  await check('findGithubFromGitCredentials：只有 gitlab 时返回 null', () => {
    const entries = CD.parseGitCredentials('https://x:t@gitlab.com\n');
    assert(CD.findGithubFromGitCredentials(entries) === null, '不应命中 github');
  });

  await check('parseGhHosts：读 gh hosts.yml 的 oauth 账户', () => {
    const yml = 'github.com:\n    oauth_token: gho_xxx\n    user: octocat\n    git_protocol: https\n';
    const r = CD.parseGhHosts(yml);
    assert(r.length === 1 && r[0].host === 'github.com' && r[0].user === 'octocat', 'gh hosts 解析正确');
  });

  /* ============================== B 组：discover ============================== */

  await check('discoverConnector(github)：git-credentials 源优先命中且可用', () => {
    const fake = {
      existsSync: (p) => p.endsWith('.git-credentials'),
      readFileSync: (p) => 'https://octocat:ghp_gitcreds@github.com\n',
    };
    const r = CD.discoverConnector('github', { home: 'C:/Users/t', existsSync: fake.existsSync, readFileSync: fake.readFileSync });
    assert(r.found === true && r.cred.usable === true && r.cred.secret === 'ghp_gitcreds', 'git-credentials 命中');
  });

  await check('discoverConnector(github)：无 git-credentials 但有 gh hosts → 已登录但 token 不可用', () => {
    const fake = {
      existsSync: (p) => p.includes('.config') && p.includes('gh') && p.endsWith('hosts.yml'),
      readFileSync: () => 'github.com:\n    oauth_token: gho_x\n    user: bob\n',
    };
    const r = CD.discoverConnector('github', { home: 'C:/Users/t', existsSync: fake.existsSync, readFileSync: fake.readFileSync });
    assert(r.found === true && r.cred.usable === false && r.cred.identity === 'bob', 'gh 已登录但 token 不可读明文');
    assert(/gh auth token/.test(r.cred.note || ''), '提示用户用 gh auth token');
  });

  await check('discoverConnector(github)：两个源都没有 → found=false + 诚实 reason', () => {
    const r = CD.discoverConnector('github', { home: 'C:/Users/t', existsSync: () => false, readFileSync: () => '' });
    assert(r.found === false && !!r.reason, '诚实说不存在');
  });

  await check('discoverConnector(linear)：无标准 CLI 登录态 → 诚实返回（不硬凑）', () => {
    const r = CD.discoverConnector('linear', { home: 'C:/Users/t', existsSync: () => false, readFileSync: () => '' });
    assert(r.found === false && /手动/.test(r.reason), 'linear 无本地源，提示手动填写');
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();
