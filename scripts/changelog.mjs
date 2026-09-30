#!/usr/bin/env node
/**
 * 最小 changelog 生成器（零依赖，git pretty 直出）
 * ----------------------------------------------------------------------------
 * 为什么不用 conventional-changelog：
 *   其 git-raw-commits@5 不再输出 `-hash-` 分隔符，而 conventional-commits-parser@6
 *   仍靠 `-hash-` 切分提交 —— 契约断裂导致整段历史被吞成**一条** `chore:` 提交、
 *   被 angular preset 过滤 → 静默空输出（BUG-W04 真实根因，非 Node/历史问题）。
 *   锁死上游版本很脆弱，不如用 git 自带的 pretty 格式自己切分：可控、零依赖。
 *
 * 用法：
 *   node scripts/changelog.mjs                  # 最新 tag 之后 → 打印待发布条目
 *   node scripts/changelog.mjs --from v0.4.0    # 指定起点（重放某一版）
 *   node scripts/changelog.mjs --from v0.4.0 --version 0.4.1   # 重放并指定版本号
 *   node scripts/changelog.mjs --write          # 插入 apps/desktop/CHANGELOG.md
 *   node scripts/changelog.mjs --selftest       # 解析逻辑自检
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PKG_JSON = path.join(ROOT, 'apps', 'desktop', 'package.json');
const CHANGELOG = path.join(ROOT, 'apps', 'desktop', 'CHANGELOG.md');

/** Keep a Changelog 分组；未列出的 type（chore/docs/test/style/ci/build）不进 changelog。 */
const GROUP = { feat: 'Added', fix: 'Fixed', perf: 'Changed', refactor: 'Changed', revert: 'Removed' };

const US = '\x1f'; // 字段分隔（不会出现在正常提交文本里）
const RS = '\x1e'; // 记录分隔

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 << 20 });

/** 解析 conventional commit 头；非规范格式返回 null。 */
export function parseHeader(subject) {
  const m = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:[ ](.+)$/.exec((subject || '').trim());
  if (!m) return null;
  return { type: m[1].toLowerCase(), scope: m[2] || '', breaking: m[3] === '!', subject: m[4] };
}

/** 拉取 [from, to] 区间的提交。from 为空表示从头。 */
export function collectCommits(from, to = 'HEAD') {
  const raw = git(['log', from ? `${from}..${to}` : to, `--pretty=format:%H${US}%s${US}%b${RS}`]);
  return raw.split(RS).map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [hash, subject, body = ''] = rec.split(US);
    // BREAKING CHANGE 既可用 `!` 标记，也可写在正文 footer。
    const header = parseHeader(subject);
    if (header && /^BREAKING[ -]CHANGE:/m.test(body)) header.breaking = true;
    return { hash, subject, body, header };
  });
}

/** 按分组聚合；同时算出应有的版本增量。 */
export function aggregate(commits) {
  const groups = new Map();
  let bump = '';
  // `''` 必须有 0 值：否则 rank[bump] 初始为 undefined，任何比较都是 false，bump 永远算不出来。
  const rank = { '': 0, patch: 1, minor: 2, major: 3 };
  const raise = (b) => { if (rank[b] > rank[bump]) bump = b; };

  for (const c of commits) {
    const h = c.header;
    if (!h) continue;
    if (h.breaking) { push('Breaking', `${h.scope ? `**${h.scope}**: ` : ''}${h.subject}`); raise('major'); continue; }
    const group = GROUP[h.type];
    if (!group) continue; // chore/docs/test 等不进 changelog
    push(group, `${h.scope ? `**${h.scope}**: ` : ''}${h.subject}`);
    if (h.type === 'feat') raise('minor'); else raise('patch');
  }
  function push(g, line) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(line); }
  return { groups, bump };
}

/** 按 SemVer 递增；无实质提交时返回 null（不产生条目）。 */
export function nextVersion(current, bump) {
  if (!bump) return null;
  const [ma, mi, pa] = current.split('.').map(Number);
  if (bump === 'major') return `${ma + 1}.0.0`;
  if (bump === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/** 本地日期 YYYY-MM-DD（不能用 toISOString：那是 UTC，东八区会整整差一天）。 */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 渲染成 Keep a Changelog 条目（不含尾部空行）。 */
export function render(version, groups) {
  const order = ['Breaking', 'Added', 'Changed', 'Fixed', 'Removed'];
  const out = [`## [${version}] - ${today()}`];
  for (const g of order) {
    const lines = groups.get(g);
    if (!lines?.length) continue;
    out.push('', `### ${g}`, ...lines.map((l) => `- ${l}`));
  }
  return out.join('\n');
}

/** 插到 CHANGELOG.md 的 [Unreleased] 之后；同版本已存在则跳过（幂等）。 */
export function writeChangelog(version, entry) {
  const src = fs.readFileSync(CHANGELOG, 'utf-8');
  if (src.includes(`## [${version}]`)) return { skipped: true };
  const marker = '## [Unreleased]';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('CHANGELOG.md 缺少 ## [Unreleased] 锚点');
  const cut = at + marker.length;
  fs.writeFileSync(CHANGELOG, `${src.slice(0, cut)}\n\n${entry}\n${src.slice(cut)}`, 'utf-8');
  return { skipped: false };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
function selftest() {
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  eq(parseHeader('feat(model): 空内容诊断'), { type: 'feat', scope: 'model', breaking: false, subject: '空内容诊断' }, 'scope 解析');
  eq(parseHeader('fix: 修复'), { type: 'fix', scope: '', breaking: false, subject: '修复' }, '无 scope');
  eq(parseHeader('feat(api)!: 破坏性'), { type: 'feat', scope: 'api', breaking: true, subject: '破坏性' }, '! 破坏性');
  eq(parseHeader('整理代码'), null, '非规范格式返回 null');
  eq(nextVersion('0.4.1', 'patch'), '0.4.2', 'patch');
  eq(nextVersion('0.4.1', 'minor'), '0.5.0', 'minor');
  eq(nextVersion('0.4.1', 'major'), '1.0.0', 'major');
  eq(nextVersion('0.4.1', ''), null, '无增量不产出版本');
  const agg = aggregate([
    { header: { type: 'feat', scope: 'ui', breaking: false, subject: 'A' } },
    { header: { type: 'fix', scope: '', breaking: false, subject: 'B' } },
    { header: { type: 'chore', scope: '', breaking: false, subject: 'C' } },
  ]);
  eq([...agg.groups.keys()], ['Added', 'Fixed'], 'chore 不进分组');
  eq(agg.bump, 'minor', 'feat 触发 minor');
  console.log('selftest: OK');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const fromIdx = argv.indexOf('--from');
  let from = fromIdx >= 0 ? argv[fromIdx + 1] : null;
  if (!from) {
    const tags = git(['tag', '--sort=-v:refname']).trim().split('\n').filter(Boolean);
    from = tags[0] || null; // 无 tag → 从头
  }

  const commits = collectCommits(from);
  const { groups, bump } = aggregate(commits);
  const current = JSON.parse(fs.readFileSync(PKG_JSON, 'utf-8')).version;
  // 默认语义 =「基于当前 package.json 的下一个版本」（发版前调用，package.json 尚未 bump）。
  // 重放历史版本时用 --version 覆盖，避免把已发布的版本号再推高一档。
  const verIdx = argv.indexOf('--version');
  const version = (verIdx >= 0 ? argv[verIdx + 1] : null) || nextVersion(current, bump);
  if (!version) {
    console.log(`（${from || '初始'}..HEAD 无 feat/fix/perf/refactor 提交，无需 changelog 条目）`);
    return;
  }
  const entry = render(version, groups);

  if (argv.includes('--write')) {
    const { skipped } = writeChangelog(version, entry);
    console.log(skipped ? `跳过：CHANGELOG.md 已含 [${version}]` : `已写入 CHANGELOG.md：[${version}]`);
  } else {
    console.log(entry);
  }
}

main();
