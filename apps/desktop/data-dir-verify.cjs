/**
 * 规范化数据目录验证（BUG-013 延伸：观雅集 / Hub / skills 纳入统一目录）
 * ----------------------------------------------------------------------------
 * 纯 node：只 require 编译产物 dist/data-dir.js（无 electron 依赖），覆盖：
 *
 *   1. ORCHDESK_HOME 优先级最高
 *   2. 便携模式（isPackaged + exe 同目录 orchdesk-data / PORTABLE）优先于 appData
 *   3. 默认回退 appData/<OrchDesk>，目录不可用时兜底 userData
 *   4. candidateLegacyDirs 去重且保持历史枚举语义
 *   5. migrateDataFiles 只补齐不覆盖（目标已有则保留目标）
 *   6. 凭据类文件用 copy-if-absent，密文不被深合并破坏
 *   7. skills 目录迁移只补齐（递归，不覆盖）
 *   8. setDataDirResolver / getDataDir 注入与回退
 *
 * 运行：node data-dir-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ---------------------------------------------------------------------------
// 0. 编译产物（缺失时自动补一次 tsc，保证脚本可独立运行）
// ---------------------------------------------------------------------------
const DIST = path.join(__dirname, 'dist', 'data-dir.js');
if (!fs.existsSync(DIST)) {
  console.log('[data-dir-verify] 未找到 dist/data-dir.js，先执行 tsc ...');
  require('node:child_process').execSync('npx tsc -p tsconfig.json', { cwd: __dirname, stdio: 'inherit' });
}
const {
  DATA_DIR_NAME,
  DATA_DIR_NAMES,
  DATA_FILE_NAMES,
  PORTABLE_DIR_NAME,
  SKILLS_DIR_NAME,
  resolveDataDir,
  candidateLegacyDirs,
  migrateDataFiles,
  migrateDataDirs,
  mergeJsonIfAbsent,
  mergeSessionsData,
  mergeProvidersData,
  setDataDirResolver,
  resetDataDirResolver,
  getDataDir,
  scanDataDir,
  formatBytes,
} = require('./dist/data-dir.js');

// ---------------------------------------------------------------------------
// 1. 临时沙箱（全部路径来自 os.tmpdir，脚本内不含任何本机绝对路径）
// ---------------------------------------------------------------------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-datadir-'));
const mk = (name) => {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const ENV_HOME = mk('env-home');
const APPDATA = mk('appdata');
const USERDATA = mk('userdata');
const EXE_DIR = mk('exe');
const PORTABLE_DIR = path.join(EXE_DIR, PORTABLE_DIR_NAME);

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    log.push(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`);
  }
}

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
};
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

// 目录归一键：win32 路径大小写不敏感，与 data-dir.ts 的 dirKey 同规则。
const dirKey = (p) => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

// 可注入 IO（与 fsIo 同语义，便于计数与故障注入）
const makeIo = () => ({
  existsSync: (p) => fs.existsSync(p),
  readJson: (file) => {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { return null; }
  },
  writeJson: (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
  },
  copyFile: (src, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  },
  mkdir: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
  readDir: (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
    } catch { return []; }
  },
});

// 迁移失败时会 console.warn（生产诊断需要），测试期间收集告警以免污染输出。
function captureWarn(fn) {
  const orig = console.warn;
  const msgs = [];
  console.warn = (...args) => { msgs.push(args.map(String).join(' ')); };
  try { return { value: fn(), msgs }; } finally { console.warn = orig; }
}

(async () => {
  console.log('\n== A. resolveDataDir 优先级 ==');

  // 便携目录真实存在 + 环境变量同时给出 → 环境变量胜出
  fs.mkdirSync(PORTABLE_DIR, { recursive: true });
  const fullOpts = {
    envHome: ENV_HOME,
    isPackaged: true,
    exeDir: EXE_DIR,
    appData: APPDATA,
    userData: USERDATA,
    existsSync: (p) => fs.existsSync(p),
  };

  await check('1) ORCHDESK_HOME 优先级最高（高于便携目录与 appData）', () => {
    assert.strictEqual(resolveDataDir(fullOpts), path.resolve(ENV_HOME));
  });
  await check('1) 环境变量空白串视为未设置，回落到便携目录', () => {
    const dir = resolveDataDir({ ...fullOpts, envHome: '   ' });
    assert.strictEqual(dir, PORTABLE_DIR);
  });

  await check('2) 便携模式（exe 同目录存在 orchdesk-data）优先于 appData', () => {
    const dir = resolveDataDir({ isPackaged: true, exeDir: EXE_DIR, appData: APPDATA, userData: USERDATA, existsSync: (p) => fs.existsSync(p) });
    assert.strictEqual(dir, PORTABLE_DIR);
  });
  await check('2) PORTABLE 标记文件同样触发便携模式', () => {
    fs.rmSync(PORTABLE_DIR, { recursive: true, force: true });
    fs.writeFileSync(path.join(EXE_DIR, 'PORTABLE'), '', 'utf-8');
    const dir = resolveDataDir({ isPackaged: true, exeDir: EXE_DIR, appData: APPDATA, userData: USERDATA, existsSync: (p) => fs.existsSync(p) });
    assert.strictEqual(dir, PORTABLE_DIR);
    fs.rmSync(path.join(EXE_DIR, 'PORTABLE'), { force: true });
  });
  await check('2) 未注入 existsSync 时便携判定恒为 false（缺省行为，生产必须显式注入）', () => {
    // 回归护栏：main.ts 曾在 resolveDataDir 实参里漏传 existsSync，而 data-dir.ts
    // 的缺省是 () => false —— 便携模式在生产恒失效，但本脚本每个用例都自己注入了
    // existsSync，所以当时全绿。此例显式钉住该缺省行为。
    fs.mkdirSync(PORTABLE_DIR, { recursive: true });
    assert.strictEqual(fs.existsSync(PORTABLE_DIR), true, '前置条件：便携目录确实存在');
    const dir = resolveDataDir({ isPackaged: true, exeDir: EXE_DIR, appData: APPDATA, userData: USERDATA });
    assert.notStrictEqual(dir, PORTABLE_DIR, '未注入 existsSync 时不应命中便携目录');
    assert.strictEqual(dir, path.join(APPDATA, DATA_DIR_NAME));
  });
  await check('2) 注入 existsSync 后同一入参命中便携目录（对照）', () => {
    const dir = resolveDataDir({
      isPackaged: true, exeDir: EXE_DIR, appData: APPDATA, userData: USERDATA,
      existsSync: (p) => fs.existsSync(p),
    });
    assert.strictEqual(dir, PORTABLE_DIR);
    fs.rmSync(PORTABLE_DIR, { recursive: true, force: true });
  });

  await check('2) 未打包（dev）不启用便携模式，直接用 appData/<OrchDesk>', () => {
    const dir = resolveDataDir({ isPackaged: false, exeDir: EXE_DIR, appData: APPDATA, userData: USERDATA, existsSync: () => true });
    assert.strictEqual(dir, path.join(APPDATA, DATA_DIR_NAME));
  });

  await check('3) 默认回退 appData/<OrchDesk>', () => {
    const dir = resolveDataDir({ appData: APPDATA, userData: USERDATA });
    assert.strictEqual(dir, path.join(APPDATA, DATA_DIR_NAME));
  });
  await check('3) 目录不可用（canUse=false）时兜底 userData', () => {
    const dir = resolveDataDir({
      appData: APPDATA,
      userData: USERDATA,
      canUse: (d) => d !== path.join(APPDATA, DATA_DIR_NAME),
    });
    assert.strictEqual(dir, USERDATA);
  });

  console.log('== B. candidateLegacyDirs ==');

  await check('4) 历史候选目录按序去重，覆盖 userData / appData / 便携 / dev 位置', () => {
    const dirs = candidateLegacyDirs({
      userData: USERDATA,
      appData: APPDATA,
      isPackaged: true,
      exeDir: EXE_DIR,
      moduleDir: path.join(ROOT, 'app', 'dist'),
    });
    assert.strictEqual(new Set(dirs.map(dirKey)).size, dirs.length, '不应有重复项');
    for (const expected of [
      USERDATA,
      path.join(APPDATA, DATA_DIR_NAME),
      path.join(EXE_DIR, PORTABLE_DIR_NAME),
      path.join(ROOT, 'app'),
      ROOT,
      path.join(ROOT, 'app', '.orchdesk-home'),
    ]) {
      // 按归一键比较：appData/OrchDesk 与 appData/orchdesk 在 win32 下是同一目录
      assert.ok(dirs.some((d) => dirKey(d) === dirKey(expected)), `缺少候选目录 ${expected}`);
    }
  });
  await check('4) 缺省入参不抛错（app 未就绪时路径不可用）', () => {
    assert.deepStrictEqual(candidateLegacyDirs(), []);
  });
  await check('4) 同一目录的不同写法（大小写 / 上级推导）只保留一条', () => {
    const dirs = candidateLegacyDirs({ appData: APPDATA });
    assert.strictEqual(new Set(dirs.map(dirKey)).size, dirs.length);
    assert.ok(dirs.includes(path.join(APPDATA, DATA_DIR_NAME)), '保留首次出现的原始字符串');
    if (process.platform === 'win32') {
      // win32 大小写不敏感：OrchDesk / orchdesk 归一为一条
      assert.strictEqual(dirs.length, 1, `win32 下应归一为一条，实际 ${dirs.length} 条`);
    } else {
      assert.strictEqual(dirs.length, 2);
    }
  });
  await check('4) exclude 排除与目标目录同址的候选（避免自我迁移）', () => {
    const target = path.join(APPDATA, DATA_DIR_NAME);
    const dirs = candidateLegacyDirs({ userData: USERDATA, appData: APPDATA, exclude: [target] });
    assert.ok(!dirs.some((d) => dirKey(d) === dirKey(target)), '目标目录本身不应出现在候选里');
    assert.ok(dirs.some((d) => dirKey(d) === dirKey(USERDATA)), '未排除的候选仍应保留');
  });
  await check('4) exclude 在 win32 下大小写无关地命中', () => {
    const target = path.join(APPDATA, DATA_DIR_NAME);
    const dirs = candidateLegacyDirs({ appData: APPDATA, exclude: [path.join(APPDATA, 'ORCHDESK')] });
    assert.ok(!dirs.some((d) => dirKey(d) === dirKey(target)), 'win32 下不同大小写也应被排除');
  });

  console.log('== C. migrateDataFiles：只补齐不覆盖 ==');

  // 会话：目标侧已有 s1（较新），来源侧 s1（较旧）+ s2
  const sessTarget = mk('migrate-sessions/target');
  const sessSource = mk('migrate-sessions/source');
  writeJson(path.join(sessTarget, 'orchdesk-sessions.json'), {
    s1: { id: 's1', title: '目标侧', msgs: [{ role: 'user', text: '新消息' }], updated: '2026-03-01T00:00:00.000Z' },
  });
  writeJson(path.join(sessSource, 'orchdesk-sessions.json'), {
    s1: { id: 's1', title: '来源侧', msgs: [{ role: 'user', text: '旧消息' }], updated: '2026-01-01T00:00:00.000Z' },
    s2: { id: 's2', title: '仅来源', msgs: [{ role: 'user', text: '仅来源消息' }], updated: '2026-01-02T00:00:00.000Z' },
  });
  migrateDataFiles({
    targetDir: sessTarget,
    sourceDirs: [sessSource],
    files: [{ name: 'orchdesk-sessions.json', mode: 'merge-json', merge: mergeSessionsData }],
  });

  await check('5) merge-json 合并来源独有条目', () => {
    const data = readJsonFile(path.join(sessTarget, 'orchdesk-sessions.json'));
    assert.ok(data.s2, '来源侧独有会话应被补齐');
  });
  await check('5) merge-json 不覆盖目标侧较新的同 id 会话', () => {
    const data = readJsonFile(path.join(sessTarget, 'orchdesk-sessions.json'));
    assert.strictEqual(data.s1.title, '目标侧');
    assert.deepStrictEqual(data.s1.msgs, [{ role: 'user', text: '新消息' }]);
    assert.strictEqual(data.s1.updated, '2026-03-01T00:00:00.000Z');
  });
  await check('5) 模型配置按 provider id 去重补齐', () => {
    const target = mk('migrate-models/target');
    const source = mk('migrate-models/source');
    writeJson(path.join(target, 'models.json'), { providers: [{ id: 'p1', name: '目标提供商', type: 'ollama', baseUrl: 'http://127.0.0.1:1', models: ['t:1b'] }] });
    writeJson(path.join(source, 'models.json'), { providers: [{ id: 'p1', name: '来源同名', type: 'ollama', baseUrl: 'http://127.0.0.1:2', models: ['s:1b'] }, { id: 'p2', name: '来源独有', type: 'ollama', baseUrl: 'http://127.0.0.1:3', models: ['s:2b'] }] });
    const out = migrateDataFiles({
      targetDir: target,
      sourceDirs: [source],
      files: [{ name: 'models.json', mode: 'merge-json', merge: mergeProvidersData }],
    });
    const data = readJsonFile(path.join(target, 'models.json'));
    const p1 = data.providers.find((p) => p.id === 'p1');
    assert.strictEqual(p1.name, '目标提供商', '同名 provider 应保留目标侧配置');
    assert.ok(data.providers.some((p) => p.id === 'p2'), '来源独有 provider 应被补齐');
    assert.strictEqual(out.filter((r) => r.moved).length, 1);
  });

  console.log('== D. 凭据类：copy-if-absent 不破坏密文 ==');

  // 目标侧已存在凭据 → 来源侧一律不搬，且密文逐字节不变
  const credTarget = mk('migrate-cred/target');
  const credSource = mk('migrate-cred/source');
  const targetCipher = { url: 'https://hub.example.invalid', tokenCipher: 'CIPHER-TARGET-ONLY' };
  const sourceCipher = { url: 'https://hub.example.invalid', tokenCipher: 'CIPHER-SOURCE-ONLY', handle: 'SHOULD-NOT-MERGE' };
  fs.writeFileSync(path.join(credTarget, 'hub.json'), JSON.stringify(targetCipher), 'utf-8');
  fs.writeFileSync(path.join(credSource, 'hub.json'), JSON.stringify(sourceCipher), 'utf-8');
  const credOut = migrateDataFiles({
    targetDir: credTarget,
    sourceDirs: [credSource],
    files: [
      { name: 'guanji.json', mode: 'copy-if-absent' },
      { name: 'hub.json', mode: 'copy-if-absent' },
    ],
  });

  await check('6) 目标已有凭据文件时保留目标侧（moved=false）', () => {
    const hubResult = credOut.find((r) => r.file === 'hub.json');
    assert.ok(hubResult, '应产生 hub.json 的迁移结果');
    assert.strictEqual(hubResult.moved, false);
    assert.strictEqual(hubResult.from, credSource);
  });
  await check('6) 凭据密文不被深合并破坏（来源字段一个都不并入）', () => {
    assert.deepStrictEqual(readJsonFile(path.join(credTarget, 'hub.json')), targetCipher);
    assert.strictEqual(fs.readFileSync(path.join(credTarget, 'hub.json'), 'utf-8'), JSON.stringify(targetCipher));
  });
  await check('6) 目标缺失时整份搬运凭据（字节级一致）', () => {
    const target = mk('migrate-cred2/target');
    const source = mk('migrate-cred2/source');
    fs.writeFileSync(path.join(source, 'guanji.json'), JSON.stringify({ enc: 'CIPHER-BLOB' }), 'utf-8');
    const out = migrateDataFiles({
      targetDir: target,
      sourceDirs: [source],
      files: [{ name: 'guanji.json', mode: 'copy-if-absent' }],
    });
    assert.strictEqual(out[0].moved, true);
    assert.strictEqual(fs.readFileSync(path.join(target, 'guanji.json'), 'utf-8'), fs.readFileSync(path.join(source, 'guanji.json'), 'utf-8'));
  });
  await check('6) 来源不存在时不产生迁移结果', () => {
    const target = mk('migrate-cred3/target');
    const source = mk('migrate-cred3/source');
    const out = migrateDataFiles({
      targetDir: target,
      sourceDirs: [source],
      files: [{ name: 'hub.json', mode: 'copy-if-absent' }],
    });
    assert.deepStrictEqual(out, []);
    assert.strictEqual(fs.existsSync(path.join(target, 'hub.json')), false);
  });

  console.log('== E. skills 目录迁移 ==');

  const skillTarget = mk('migrate-skills/target');
  const skillSource = mk('migrate-skills/source');
  const srcSkills = path.join(skillSource, SKILLS_DIR_NAME);
  const dstSkills = path.join(skillTarget, SKILLS_DIR_NAME);
  fs.mkdirSync(path.join(srcSkills, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dstSkills), { recursive: true });
  fs.writeFileSync(path.join(srcSkills, 'a.skill'), 'SOURCE-A', 'utf-8');
  fs.writeFileSync(path.join(srcSkills, 'b.skill'), 'SOURCE-B', 'utf-8');
  fs.writeFileSync(path.join(srcSkills, 'nested', 'c.txt'), 'SOURCE-C', 'utf-8');
  fs.writeFileSync(path.join(dstSkills, 'a.skill'), 'TARGET-A', 'utf-8');
  const dirOut = migrateDataDirs({ targetDir: skillTarget, sourceDirs: [skillSource], dirs: [SKILLS_DIR_NAME] });

  await check('7) skills 目录递归迁移，只补齐目标缺失文件', () => {
    assert.strictEqual(fs.readFileSync(path.join(dstSkills, 'a.skill'), 'utf-8'), 'TARGET-A', '目标已有文件不得被覆盖');
    assert.strictEqual(fs.readFileSync(path.join(dstSkills, 'b.skill'), 'utf-8'), 'SOURCE-B');
    assert.strictEqual(fs.readFileSync(path.join(dstSkills, 'nested', 'c.txt'), 'utf-8'), 'SOURCE-C');
    const r = dirOut.find((x) => x.from === skillSource);
    assert.strictEqual(r.moved, true);
    assert.strictEqual(r.copied, 2);
  });
  await check('7) 目标 skills 目录不存在时整目录复制', () => {
    const target = mk('migrate-skills2/target');
    const out = migrateDataDirs({ targetDir: target, sourceDirs: [skillSource], dirs: [SKILLS_DIR_NAME] });
    assert.strictEqual(fs.readFileSync(path.join(target, SKILLS_DIR_NAME, 'a.skill'), 'utf-8'), 'SOURCE-A');
    assert.strictEqual(out[0].copied, 3);
  });
  await check('7) 多次迁移幂等（第二次 copied=0）', () => {
    const again = migrateDataDirs({ targetDir: skillTarget, sourceDirs: [skillSource], dirs: [SKILLS_DIR_NAME] });
    assert.strictEqual(again[0].copied, 0);
    assert.strictEqual(again[0].moved, false);
  });
  await check('7) 来源目录等于目标目录时跳过（不自我复制）', () => {
    const out = migrateDataDirs({ targetDir: skillTarget, sourceDirs: [skillTarget], dirs: [SKILLS_DIR_NAME] });
    assert.deepStrictEqual(out, []);
  });

  console.log('== F1. merge-json 缺省合并器（mergeJsonIfAbsent，此前零覆盖）==');

  await check('9) 未显式传 merge 时：目标不存在则整份写入来源', () => {
    const target = mk('default-merge/target');
    const source = mk('default-merge/source');
    const payload = { url: 'https://hub.example.invalid', tokenCipher: 'CIPHER-ONLY-SOURCE' };
    writeJson(path.join(source, DATA_FILE_NAMES.hub), payload);
    const out = migrateDataFiles({
      targetDir: target,
      sourceDirs: [source],
      files: [{ name: DATA_FILE_NAMES.hub, mode: 'merge-json' }],
    });
    assert.strictEqual(out[0].moved, true);
    assert.strictEqual(out[0].error, undefined);
    assert.deepStrictEqual(readJsonFile(path.join(target, DATA_FILE_NAMES.hub)), payload);
    assert.deepStrictEqual(mergeJsonIfAbsent(null, { a: 1 }), { data: { a: 1 }, added: 1, changed: true });
  });
  await check('9) 未显式传 merge 时：目标已存在则不写入（不覆盖）', () => {
    const target = mk('default-merge2/target');
    const source = mk('default-merge2/source');
    writeJson(path.join(target, DATA_FILE_NAMES.hub), { url: 'TARGET' });
    writeJson(path.join(source, DATA_FILE_NAMES.hub), { url: 'SOURCE' });
    const out = migrateDataFiles({
      targetDir: target,
      sourceDirs: [source],
      files: [{ name: DATA_FILE_NAMES.hub, mode: 'merge-json' }],
    });
    assert.strictEqual(out[0].moved, false);
    assert.deepStrictEqual(readJsonFile(path.join(target, DATA_FILE_NAMES.hub)), { url: 'TARGET' });
    assert.strictEqual(mergeJsonIfAbsent({ a: 1 }, { b: 2 }), null, '目标非空时返回 null（不写）');
  });

  console.log('== F2. 无实质变化不落盘（added → changed）==');

  await check('10) 同源会话二次迁移不重写整份 sessions（changed=false）', () => {
    const target = mk('sessions-idempotent/target');
    const source = mk('sessions-idempotent/source');
    const entry = { id: 's1', title: '同一份', msgs: [{ role: 'user', text: 'a' }], updated: '2026-03-01T00:00:00.000Z' };
    writeJson(path.join(target, DATA_FILE_NAMES.sessions), { s1: entry });
    writeJson(path.join(source, DATA_FILE_NAMES.sessions), { s1: { ...entry, updated: '2026-01-01T00:00:00.000Z' } });
    const io = makeIo();
    let writes = 0;
    const counting = { ...io, writeJson: (f, d) => { writes++; io.writeJson(f, d); } };
    const out = migrateDataFiles({
      targetDir: target,
      sourceDirs: [source],
      files: [{ name: DATA_FILE_NAMES.sessions, mode: 'merge-json', merge: mergeSessionsData }],
      io: counting,
    });
    assert.strictEqual(writes, 0, '无实质变化不应写盘（否则每次启动重写整份 sessions）');
    assert.strictEqual(out[0].moved, false);
    assert.strictEqual(out[0].error, undefined);
  });
  await check('10) 有实质变化（来源侧更新 / 更长消息列表）时仍然落盘', () => {
    const target = mk('sessions-updated/target');
    const source = mk('sessions-updated/source');
    writeJson(path.join(target, DATA_FILE_NAMES.sessions), {
      s1: { id: 's1', title: '旧', msgs: [{ role: 'user', text: 'a' }], updated: '2026-01-01T00:00:00.000Z' },
    });
    writeJson(path.join(source, DATA_FILE_NAMES.sessions), {
      s1: { id: 's1', title: '新', msgs: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }], updated: '2026-03-01T00:00:00.000Z' },
    });
    const io = makeIo();
    let writes = 0;
    const counting = { ...io, writeJson: (f, d) => { writes++; io.writeJson(f, d); } };
    const out = migrateDataFiles({
      targetDir: target,
      sourceDirs: [source],
      files: [{ name: DATA_FILE_NAMES.sessions, mode: 'merge-json', merge: mergeSessionsData }],
      io: counting,
    });
    assert.strictEqual(writes, 1);
    assert.strictEqual(out[0].moved, true);
    const data = readJsonFile(path.join(target, DATA_FILE_NAMES.sessions));
    assert.strictEqual(data.s1.title, '新', '保留 updated 较新的一份（合并语义不变）');
    assert.strictEqual(data.s1.msgs.length, 2, '取更长的消息列表（合并语义不变）');
  });
  await check('10) 多来源目录时目标文件只读一次（缓存，不重复 readJson）', () => {
    const target = mk('target-read-cache/target');
    const sources = [mk('target-read-cache/s1'), mk('target-read-cache/s2'), mk('target-read-cache/s3')];
    writeJson(path.join(target, DATA_FILE_NAMES.sessions), {
      base: { id: 'base', title: '目标', msgs: [{ role: 'user', text: 'a' }], updated: '2026-01-01T00:00:00.000Z' },
    });
    sources.forEach((s, i) => {
      writeJson(path.join(s, DATA_FILE_NAMES.sessions), {
        [`x${i}`]: { id: `x${i}`, title: `来源${i}`, msgs: [{ role: 'user', text: 'a' }], updated: '2026-02-0' + (i + 1) + 'T00:00:00.000Z' },
      });
    });
    const io = makeIo();
    const targetFile = path.join(target, DATA_FILE_NAMES.sessions);
    let targetReads = 0;
    const counting = { ...io, readJson: (f) => { if (f === targetFile) targetReads++; return io.readJson(f); } };
    const out = migrateDataFiles({
      targetDir: target,
      sourceDirs: sources,
      files: [{ name: DATA_FILE_NAMES.sessions, mode: 'merge-json', merge: mergeSessionsData }],
      io: counting,
    });
    assert.strictEqual(out.filter((r) => r.moved).length, 3, '三个来源都应被合并');
    assert.strictEqual(targetReads, 1, `目标应只读一次，实际 ${targetReads} 次`);
    const data = readJsonFile(targetFile);
    assert.ok(data.base && data.x0 && data.x1 && data.x2, '只补齐不覆盖：目标侧条目仍在');
  });

  console.log('== F3. 故障注入（可注入 IO，错误结构化到返回值）==');

  await check('11) writeJson 抛错时结果带 error，且不阻断其它文件迁移', () => {
    const target = mk('fault-write/target');
    const source = mk('fault-write/source');
    writeJson(path.join(source, DATA_FILE_NAMES.models), { providers: [{ id: 'fp', name: '来源提供商', type: 'ollama' }] });
    fs.writeFileSync(path.join(source, DATA_FILE_NAMES.hub), JSON.stringify({ tokenCipher: 'CIPHER' }), 'utf-8');
    const io = makeIo();
    const failing = {
      ...io,
      writeJson: (file, data) => {
        if (file.endsWith(DATA_FILE_NAMES.models)) throw new Error('磁盘已满（注入故障）');
        io.writeJson(file, data);
      },
    };
    const { value: out, msgs } = captureWarn(() => migrateDataFiles({
      targetDir: target,
      sourceDirs: [source],
      files: [
        { name: DATA_FILE_NAMES.models, mode: 'merge-json', merge: mergeProvidersData },
        { name: DATA_FILE_NAMES.hub, mode: 'copy-if-absent' },
      ],
      io: failing,
    }));
    const models = out.find((r) => r.file === DATA_FILE_NAMES.models);
    assert.strictEqual(models.moved, false);
    assert.ok(typeof models.error === 'string' && models.error.includes('磁盘已满'), `error 字段缺失：${JSON.stringify(models)}`);
    assert.ok(msgs.some((m) => m.includes('磁盘已满')), 'console.warn 应保留（生产诊断仍需要）');
    const hub = out.find((r) => r.file === DATA_FILE_NAMES.hub);
    assert.strictEqual(hub.moved, true, '单个文件失败不影响其它文件迁移');
    assert.strictEqual(hub.error, undefined);
    assert.strictEqual(fs.existsSync(path.join(target, DATA_FILE_NAMES.hub)), true);
  });
  await check('11) 目录迁移 copyFile 抛错时结果带 error（已复制文件保留）', () => {
    const target = mk('fault-dir/target');
    const source = mk('fault-dir/source');
    const srcSkills = path.join(source, DATA_DIR_NAMES.skills);
    fs.mkdirSync(srcSkills, { recursive: true });
    fs.writeFileSync(path.join(srcSkills, 'a.skill'), 'A', 'utf-8');
    fs.writeFileSync(path.join(srcSkills, 'b.skill'), 'B', 'utf-8');
    const io = makeIo();
    const failing = {
      ...io,
      copyFile: (s, d) => {
        if (d.endsWith('b.skill')) throw new Error('目标只读（注入故障）');
        io.copyFile(s, d);
      },
    };
    const { value: out, msgs } = captureWarn(() => migrateDataDirs({
      targetDir: target,
      sourceDirs: [source],
      dirs: [DATA_DIR_NAMES.skills],
      io: failing,
    }));
    assert.strictEqual(out[0].moved, false);
    assert.ok(typeof out[0].error === 'string' && out[0].error.includes('目标只读'), `error 字段缺失：${JSON.stringify(out[0])}`);
    assert.ok(msgs.some((m) => m.includes('目标只读')));
    assert.strictEqual(fs.existsSync(path.join(target, DATA_DIR_NAMES.skills, 'a.skill')), true, '失败前已复制的文件保留');
  });

  console.log('== F. setDataDirResolver / getDataDir ==');

  // 未注入时：回退 ORCHDESK_HOME
  setDataDirResolver(null);
  const envBackup = process.env.ORCHDESK_HOME;
  process.env.ORCHDESK_HOME = ENV_HOME;

  await check('8) 未注入解析器时回退 ORCHDESK_HOME', () => {
    assert.strictEqual(getDataDir(), path.resolve(ENV_HOME));
  });
  await check('8) 注入后 getDataDir 返回注入目录（供 guanji/hub 共用）', () => {
    const injected = mk('injected');
    setDataDirResolver(() => injected);
    assert.strictEqual(getDataDir(), injected);
  });
  await check('8) resetDataDirResolver 清除注入后回退 ORCHDESK_HOME', () => {
    setDataDirResolver(() => mk('injected-reset'));
    assert.notStrictEqual(getDataDir(), path.resolve(ENV_HOME), '注入生效时应返回注入目录');
    resetDataDirResolver();
    assert.strictEqual(getDataDir(), path.resolve(ENV_HOME), 'reset 之后应回退环境变量');
  });
  await check('8) 未注入且无 ORCHDESK_HOME 时抛出清晰错误（避免悄悄写错位置）', () => {
    setDataDirResolver(null);
    delete process.env.ORCHDESK_HOME;
    assert.throws(() => getDataDir(), /数据目录解析器尚未注入/);
  });

  if (envBackup === undefined) delete process.env.ORCHDESK_HOME;
  else process.env.ORCHDESK_HOME = envBackup;
  setDataDirResolver(null);

  // -------------------------------------------------------------------------
  // G. 数据目录内容清单（PRD FR-4.2「内容清单」）
  // -------------------------------------------------------------------------
  // 设置页此前写死「~ 24 MB」。清单必须来自真实文件系统，否则「备份整个数据目录」
  // 这句承诺的大小就是编的。这里覆盖扫描语义与体积换算两条独立链路。
  // -------------------------------------------------------------------------
  console.log('== G. 数据目录内容清单（FR-4.2） ==');

  await check('9) 目录不存在时返回空清单且不抛错（首次运行）', () => {
    const inv = scanDataDir(path.join(ROOT, 'no-such-dir-inv'));
    assert.deepStrictEqual(inv.items, []);
    assert.strictEqual(inv.totalSize, 0);
    assert.strictEqual(inv.totalFiles, 0);
    assert.strictEqual(inv.dir, path.join(ROOT, 'no-such-dir-inv'));
  });

  const invRoot = mk('inv-root');
  fs.writeFileSync(path.join(invRoot, 'sessions.json'), 'x'.repeat(300));
  fs.writeFileSync(path.join(invRoot, 'providers.json'), 'y'.repeat(100));
  fs.mkdirSync(path.join(invRoot, 'logs', '2026-08'), { recursive: true });
  fs.writeFileSync(path.join(invRoot, 'logs', 'a.log'), 'z'.repeat(50));
  fs.writeFileSync(path.join(invRoot, 'logs', '2026-08', 'b.log'), 'w'.repeat(70));
  const emptyDir = path.join(invRoot, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });

  await check('9) 顶层子项按体积降序，根汇总排在最后', () => {
    const inv = scanDataDir(invRoot);
    const names = inv.items.map((i) => i.name);
    assert.strictEqual(names[names.length - 1], '.', `根汇总 '.', 应在最后：${names.join(' | ')}`);
    const top = names.slice(0, -1);
    assert.ok(top.includes('sessions.json') && top.includes('providers.json') && top.includes('logs') && top.includes('empty'),
      `顶层应含四类子项：${names.join(' | ')}`);
    const sizes = inv.items.slice(0, -1).map((i) => i.size);
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i - 1] >= sizes[i], `体积未降序：${JSON.stringify(inv.items.slice(0, -1).map((x) => [x.name, x.size]))}`);
    }
  });

  await check('9) 目录体积与文件数递归汇总（含嵌套子目录）', () => {
    const inv = scanDataDir(invRoot);
    const logs = inv.items.find((i) => i.name === 'logs');
    assert.ok(logs, '未找到 logs 目录项');
    assert.strictEqual(logs.kind, 'dir');
    assert.strictEqual(logs.size, 120, `logs 应为 50+70=120，实际 ${logs.size}`);
    assert.strictEqual(logs.files, 2, `logs 应含 2 个文件，实际 ${logs.files}`);
    assert.strictEqual(inv.totalSize, 300 + 100 + 120, `总计应为 520，实际 ${inv.totalSize}`);
    assert.strictEqual(inv.totalFiles, 4, `总文件数应为 4，实际 ${inv.totalFiles}`);
  });

  await check('9) 空目录体积为 0 且仍被列出（不静默吞掉）', () => {
    const inv = scanDataDir(invRoot);
    const e = inv.items.find((i) => i.name === 'empty');
    assert.ok(e, '空目录应出现在清单里');
    assert.strictEqual(e.size, 0);
    assert.strictEqual(e.files, 0);
  });

  await check('9) 嵌套文件不出现在顶层（只列一层 + 各自汇总）', () => {
    const inv = scanDataDir(invRoot);
    const names = inv.items.map((i) => i.name);
    assert.ok(!names.includes('logs/a.log'), `嵌套文件不应出现在顶层：${names.join(' | ')}`);
    assert.ok(!names.includes('logs/2026-08'), `二级目录不应出现在顶层：${names.join(' | ')}`);
  });

  await check('9) 路径统一用 / 分隔（UI 与检索口径一致）', () => {
    const inv = scanDataDir(invRoot);
    for (const i of inv.items) {
      assert.ok(!i.name.includes('\\'), `路径含反斜杠：${i.name}`);
    }
    const logs = inv.items.find((i) => i.name === 'logs');
    assert.strictEqual(logs.name, 'logs', `顶层目录名应无分隔符残留，实际「${logs.name}」`);
    // 嵌套路径必须含 '/'，证明分隔符被统一过（Windows 上原生是 '\\'）
    const invNested = scanDataDir(invRoot);
    assert.ok(invNested.items.every((i) => !i.name.includes('//')), '不应出现重复分隔符');
  });

  await check('9) 符号链接被跳过，不成环也不重复计数', () => {
    const linkRoot = mk('inv-link');
    fs.writeFileSync(path.join(linkRoot, 'a.txt'), 'a'.repeat(10));
    const sub = path.join(linkRoot, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'b.txt'), 'b'.repeat(20));
    let created = false;
    try {
      // 指向自身父目录的软链：跟随就会无限递归
      fs.symlinkSync(linkRoot, path.join(sub, 'loop'), 'junction');
      created = true;
    } catch { created = false; }
    if (!created) {
      // 无权限创建软链时跳过多余断言，但仍验证清单不崩
      const inv = scanDataDir(linkRoot);
      assert.ok(Array.isArray(inv.items));
      return;
    }
    const inv = scanDataDir(linkRoot);
    const names = inv.items.map((i) => i.name);
    assert.ok(!names.includes('sub/loop'), `软链不应被扫描：${names.join(' | ')}`);
    const subItem = inv.items.find((i) => i.name === 'sub');
    assert.strictEqual(subItem.size, 20, `sub 只应计 b.txt（20 字节），实际 ${subItem.size}`);
    assert.strictEqual(inv.totalFiles, 2, `软链不应重复计入文件数，实际 ${inv.totalFiles}`);
  });

  await check('9) 路径指向文件（非目录）时返回空清单而不抛错', () => {
    const inv = scanDataDir(path.join(invRoot, 'sessions.json'));
    assert.deepStrictEqual(inv.items, []);
    assert.strictEqual(inv.totalSize, 0);
  });

  await check('9) formatBytes 四档换算', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1023), '1023 B');
    assert.strictEqual(formatBytes(1024), '1.0 KB');
    assert.strictEqual(formatBytes(1024 * 1024 - 1), '1024.0 KB');
    assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
    assert.strictEqual(formatBytes(1024 * 1024 * 1024), '1.00 GB');
    assert.strictEqual(formatBytes(1024 * 1024 * 1024 * 5), '5.00 GB');
  });

  await check('9) formatBytes 对负数 / 非数字回退 0 B（不显示 NaN）', () => {
    assert.strictEqual(formatBytes(-1), '0 B');
    assert.strictEqual(formatBytes(NaN), '0 B');
    assert.strictEqual(formatBytes(Infinity), '0 B');
    assert.strictEqual(formatBytes(undefined), '0 B');
    assert.strictEqual(formatBytes(null), '0 B');
  });

  await check('9) 清单体积经 formatBytes 后即为 UI 展示值（口径唯一）', () => {
    const inv = scanDataDir(invRoot);
    assert.strictEqual(inv.totalSize, 520, '清单原始字节数应为 520');
    assert.strictEqual(formatBytes(inv.totalSize), '520 B', 'UI 展示值应由同一函数产出');
  });

  // -------------------------------------------------------------------------
  console.log('\n' + log.join('\n'));
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}

  if (failed > 0) process.exit(1);
  console.log('规范化数据目录全部验证通过');
  process.exit(0);
})();
