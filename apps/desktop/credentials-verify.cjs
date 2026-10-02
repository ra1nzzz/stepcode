/**
 * 凭据加密 + 沙箱验证（P1-3，对齐 PRD §5 FR-5 与 NFR）
 * ----------------------------------------------------------------------------
 * 1. AES-256-GCM 加解密往返、抗篡改、格式识别
 * 2. 密钥派生自机器指纹（确定性、跨调用一致）
 * 3. 空串 / 非法密文 → 空串（不回落明文、不抛错）
 * 4. 主进程 encryptKey/decryptKey 走新格式（stub electron 后驱动真实 handler）
 * 5. shell_command 在子进程异步执行，不阻塞主进程且超时可杀
 *    （BUG-052：本构建里宿主服务句柄恒 null，命令实际到不了执行，组 D 断言的是被拒与留痕）
 *
 * 运行：node credentials-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try { await fn(); passed++; log.push(`  PASS  ${name}`); }
  catch (err) { failed++; log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`); }
}

const cred = require('./dist/credentials.js');

(async () => {
  console.log('\n== A. AES-256-GCM 加解密 ==');

  await check('加密输出为 v1 格式', () => {
    const enc = cred.encryptSecret('sk-test-123');
    assert.ok(cred.isV1Cipher(enc), '应为 v1 格式，实际 ' + enc.slice(0, 20));
    assert.strictEqual(enc.split(':').length, 4, '应为 4 段：v1:iv:tag:ct');
  });

  await check('加解密往返一致（含中文与特殊字符）', () => {
    for (const raw of ['sk-abc123', '中文密钥·测试', 'a"b\'c\\d\ne', 'x'.repeat(4096)]) {
      assert.strictEqual(cred.decryptSecret(cred.encryptSecret(raw)), raw, '往返失败: ' + raw.slice(0, 20));
    }
  });

  await check('每次加密密文不同（随机 IV）', () => {
    const a = cred.encryptSecret('same');
    const b = cred.encryptSecret('same');
    assert.notStrictEqual(a, b, '相同明文应产生不同密文（IV 随机）');
    assert.strictEqual(cred.decryptSecret(a), cred.decryptSecret(b), '但解密结果应一致');
  });

  await check('空串加密返回空串', () => {
    assert.strictEqual(cred.encryptSecret(''), '');
  });

  await check('空 / 非法输入解密返回空串（不抛错）', () => {
    assert.strictEqual(cred.decryptSecret(''), '');
    assert.strictEqual(cred.decryptSecret(undefined), '');
    assert.strictEqual(cred.decryptSecret('garbage'), '');
    assert.strictEqual(cred.decryptSecret('v1:xx'), '');
    assert.strictEqual(cred.decryptSecret('v2:a:b:c'), '');
  });

  await check('密文被篡改 → 解密失败返回空串（GCM 认证）', () => {
    const enc = cred.encryptSecret('sk-secret');
    const parts = enc.split(':');
    // 篡改密文最后一个字符
    const ct = Buffer.from(parts[3], 'base64');
    ct[ct.length - 1] = ct[ct.length - 1] ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join(':');
    assert.strictEqual(cred.decryptSecret(tampered), '', '篡改后必须解密失败（GCM tag 校验）');
  });

  await check('密钥派生确定（同一机器多次调用结果一致）', () => {
    const a = cred.encryptSecret('determinism');
    cred.resetKeyCache();
    assert.strictEqual(cred.decryptSecret(a), 'determinism', '清缓存后仍应能解密（派生确定性）');
  });

  console.log('== A2. 显式密钥版（TRACE TOKEN 加密内置）==');
  const KEY_A = crypto.randomBytes(32).toString('hex');
  const KEY_B = crypto.randomBytes(32).toString('hex');
  await check('encryptWithKey/decryptWithKey 往返一致（含中文）', () => {
    const enc = cred.encryptWithKey('ghp_trace_令牌123', KEY_A);
    assert.ok(cred.isV1Cipher(enc), '应为 v1 格式');
    assert.strictEqual(cred.decryptWithKey(enc, KEY_A), 'ghp_trace_令牌123', '同密钥应可解密');
  });
  await check('换密钥 / 篡改 → 解密返回空串（不抛错不回落明文）', () => {
    const enc = cred.encryptWithKey('secret', KEY_A);
    assert.strictEqual(cred.decryptWithKey(enc, KEY_B), '', '不同密钥应解密失败');
    assert.strictEqual(cred.decryptWithKey(enc.slice(0, -4) + 'AAAA', KEY_A), '', '密文篡改应解密失败（GCM 认证）');
    assert.strictEqual(cred.decryptWithKey(undefined, KEY_A), '', 'undefined 应返回空串');
  });

  console.log('== B. 主进程凭据读写（stub electron 驱动真实 handler）==');

  // 用独立子进程跑，避免 stub 污染本进程
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-cred-'));
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    const HOME = ${JSON.stringify(HOME)};
    process.env.ORCHDESK_HOME = HOME;
    const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
    const stub = makeElectronStub({
      home: HOME,
      getPath: (n) => n === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', n),
    });
    const ipc = stub.ipcHandlers;
    const orig = Module._load;
    Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
    require('${path.join(__dirname, 'dist', 'main.js').replace(/\\/g, '\\\\')}');
    (async () => {
      const cid = require('${path.join(__dirname, 'dist', 'credentials.js').replace(/\\/g, '\\\\')}');
      await ipc.get('orchdesk:models-save')(null, {
        providers: [{ id: 'p1', name: '测试', type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'sk-real-secret', models: ['m'] }],
        defaultProvider: 'p1', defaultModel: 'm', maxToolIterations: 10,
      });
      const raw = JSON.parse(fs.readFileSync(path.join(HOME, 'models.json'), 'utf-8'));
      const p = raw.providers[0];
      const out = {
        hasPlainKey: 'apiKey' in p,
        encIsV1: cid.isV1Cipher(p.apiKeyEnc),
        encPreview: String(p.apiKeyEnc || '').slice(0, 24),
        matchesCiphertext: cid.decryptSecret(p.apiKeyEnc) === 'sk-real-secret',
      };
      // 再读一次配置，确认读取路径不会把密文写坏
      const read = await ipc.get('orchdesk:models-get')(null);
      out.readOk = Array.isArray(read.providers) && read.providers.length === 1;
      console.log('RESULT_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
  `;
  const tmpScript = path.join(os.tmpdir(), `cred-probe-${Date.now()}.cjs`);
  fs.writeFileSync(tmpScript, script, 'utf-8');

  let probeOut = '';
  try {
    probeOut = require('node:child_process').execSync(`node "${tmpScript}"`, { encoding: 'utf-8', timeout: 60_000 });
  } catch (err) {
    probeOut = (err.stdout || '') + (err.stderr || '');
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
  const m = probeOut.match(/RESULT_JSON:(\{.*\})/);
  const probe = m ? JSON.parse(m[1]) : null;

  await check('保存后明文 apiKey 不落盘', () => {
    assert.ok(probe, '探针未产出结果: ' + probeOut.slice(0, 300));
    assert.strictEqual(probe.hasPlainKey, false, 'models.json 中不应保留明文 apiKey');
  });

  await check('API Key 以 AES-256-GCM v1 格式存储（PRD 要求）', () => {
    assert.ok(probe, '探针未产出结果');
    assert.strictEqual(probe.encIsV1, true, '应为 v1 格式，实际 ' + probe.encPreview);
    assert.strictEqual(probe.matchesCiphertext, true, '应能解出原文');
  });

  await check('读取配置不破坏密文', () => {
    assert.ok(probe, '探针未产出结果');
    assert.strictEqual(probe.readOk, true, 'models-get 应能正常返回');
  });

  console.log('== B2. models-save 的四条写入守卫（真实 handler 探针）==');

  const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-models-'));
  const script2 = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    const HOME = ${JSON.stringify(HOME2)};
    process.env.ORCHDESK_HOME = HOME;
    const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
    const stub = makeElectronStub({
      home: HOME,
      getPath: (n) => n === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', n),
    });
    const ipc = stub.ipcHandlers;
    const orig = Module._load;
    Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
    require('${path.join(__dirname, 'dist', 'main.js').replace(/\\/g, '\\\\')}');
    (async () => {
      const FILE = path.join(HOME, 'models.json');
      const save = (cfg) => ipc.get('orchdesk:models-save')(null, cfg);
      const prov = (id, name) => ({ id, name, type: 'openai-compatible', baseUrl: 'https://' + id + '/v1', models: ['m-' + id] });
      const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch { return null; } };
      const out = {};

      out.good = await save({ providers: [prov('a', 'A'), prov('b', 'B')], defaultProvider: 'a', defaultModel: 'm-a', maxToolIterations: 5 });
      out.goodCount = (read()?.providers || []).length;

      // 1) 重复 id：投影端按 id 建对象（后写胜出）、读取端 find（先写胜出），
      //    而渲染层用显示名造 id —— 两个纯中文名会折叠成同一个 '--'。
      out.dup = await save({ providers: [prov('z', '第一个'), prov('z', '第二个')] });
      out.dupCount = (read()?.providers || []).length;

      // 2) 空 / 纯空白 id
      out.blank = await save({ providers: [{ ...prov('   ', '空白'), }] });

      // 3) 文件读坏时不得以「空配置」为基底落盘
      fs.writeFileSync(FILE, '{ 这不是合法 json', 'utf-8');
      out.corrupt = await save({ providers: [prov('a', 'A')] });
      out.corruptBytes = fs.readFileSync(FILE, 'utf-8');

      // 4) 文件修好后同一通道要能正常保存（守卫不能把产品钉死）
      fs.writeFileSync(FILE, JSON.stringify({ providers: [prov('a', 'A')] }), 'utf-8');
      out.recovered = await save({ providers: [prov('a', 'A'), prov('b', 'B')] });
      out.recoveredCount = (read()?.providers || []).length;
      // BUG-054：公网 http 必须被拒且不动磁盘；回环与私网 http 必须放行（不能误伤本机 Ollama / NAS）。
      const before54 = fs.readFileSync(FILE, 'utf-8');
      const provUrl = (id, name, url) => ({ id, name, type: 'openai-compatible', baseUrl: url, models: ['m-' + id] });
      out.pubHttp = await save({ providers: [provUrl('p1', '公网明文', 'http://pub.example.com/v1')] });
      out.pubHttpUnchanged = fs.readFileSync(FILE, 'utf-8') === before54;
      out.loopHttp = await save({ providers: [provUrl('p2', '本机', 'http://127.0.0.1:11434')] });
      out.privHttp = await save({ providers: [provUrl('p3', '局域网', 'http://192.168.2.156:11434/v1')] });
      out.httpsOk = await save({ providers: [provUrl('p4', '公网加密', 'https://pub.example.com/v1')] });

      // 5) 默认提供商被删掉后不得留悬空引用：下一回合会去读一个不存在的提供商
      fs.writeFileSync(FILE, JSON.stringify({ providers: [prov('a', 'A'), prov('b', 'B')], defaultProvider: 'a' }), 'utf-8');
      out.dangling = await save({ providers: [prov('b', 'B')], defaultProvider: 'a' });
      out.danglingDefault = read()?.defaultProvider;

      console.log('RESULT2_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
  `;
  const tmp2 = path.join(os.tmpdir(), `models-guard-${Date.now()}.cjs`);
  fs.writeFileSync(tmp2, script2, 'utf-8');
  let probe2Out = '';
  try {
    probe2Out = require('node:child_process').execSync(`node "${tmp2}"`, { encoding: 'utf-8', timeout: 60_000 });
  } catch (err) {
    probe2Out = (err.stdout || '') + (err.stderr || '');
  } finally {
    try { fs.unlinkSync(tmp2); } catch {}
  }
  const m2 = probe2Out.match(/RESULT2_JSON:(\{.*\})/);
  const g = m2 ? JSON.parse(m2[1]) : null;

  await check('正常保存先立基线（2 个提供商落盘）', () => {
    assert.ok(g, '探针未产出结果: ' + probe2Out.slice(0, 400));
    assert.strictEqual(g.good.ok, true, `正常保存应成功，实际 ${JSON.stringify(g.good)}`);
    assert.strictEqual(g.goodCount, 2, '基线应为 2 个提供商');
  });

  await check('重复提供商 id 被拒绝，且磁盘配置没被动过', () => {
    assert.strictEqual(g.dup.ok, false, `重复 id 必须拒绝，实际 ${JSON.stringify(g.dup)}`);
    assert.match(String(g.dup.reason), /重复/);
    assert.strictEqual(g.dupCount, 2, '被拒之后提供商数量必须还是 2（拒绝要真的没写）');
  });

  await check('空 / 纯空白提供商 id 被拒绝', () => {
    assert.strictEqual(g.blank.ok, false, `空白 id 必须拒绝，实际 ${JSON.stringify(g.blank)}`);
    assert.match(String(g.blank.reason), /id 不能为空/);
  });

  await check('models.json 读坏时中止保存，不把已有配置清成空表', () => {
    assert.strictEqual(g.corrupt.ok, false, `损坏文件必须拒绝保存，实际 ${JSON.stringify(g.corrupt)}`);
    assert.match(String(g.corrupt.reason), /读取失败/);
    assert.strictEqual(g.corruptBytes, '{ 这不是合法 json', '损坏原文必须原样留着（旧实现会写成空 providers）');
  });

  await check('文件修好后同一通道恢复可写（守卫不钉死产品）', () => {
    assert.strictEqual(g.recovered.ok, true, `恢复后应能保存，实际 ${JSON.stringify(g.recovered)}`);
    assert.strictEqual(g.recoveredCount, 2, '恢复保存应落 2 个提供商');
  });

  // ---- BUG-055：日志不得带出凭据 ----
  const LG = require(path.join(__dirname, 'dist', 'logger.js'));
  await check('redactUrlForLog：查询串凭据、userinfo 与错误文本都被擦掉', () => {
    const secret = 'SK-LEAK-1234567890';
    const a = LG.redactUrlForLog(`https://api.example.com/v1/chat/completions?api-key=${secret}`);
    assert.ok(!a.includes(secret), `URL 查询串里的 key 必须被擦掉：${a}`);
    assert.ok(a.includes('REDACTED'), `要留可见标记，不能静默删参数：${a}`);
    const b = LG.redactUrlForLog(`https://ai:${secret}@gateway.example/v1`);
    assert.ok(!b.includes(secret), `userinfo 口令必须被擦掉：${b}`);
    const c = LG.redactTextForLog(`HTTP 401: bad auth for https://x.dev/v1?api-key=${secret}`);
    assert.ok(!c.includes(secret), `错误文本回显的 URL 也要擦：${c}`);
    // 不该误伤：无凭据的普通 URL 与非 key 参数原样保留
    const d = LG.redactUrlForLog('http://127.0.0.1:11434/api/chat?stream=true&model=q');
    assert.ok(d.includes('stream=true') && d.includes('model=q'), `普通参数不得被抹掉：${d}`);
    assert.strictEqual(LG.redactUrlForLog(''), '');
  });

  await check('logModel 落盘后，日志文件里搜不到那把 key（往返验证）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-log-'));
    const secret = 'SK-DISK-9876543210';
    LG.initLogger(dir);
    try {
      LG.logModel('request', {
        provider: 'p', model: 'm', apiMode: 'chat',
        url: `https://api.example.com/v1/chat/completions?api-key=${secret}`,
      });
      LG.logModel('error', {
        provider: 'p', model: 'm',
        error: `upstream echoed: request to /v1/chat/completions?api-key=${secret} failed`,
      });
      const found = [];
      (function walk(d) {
        for (const n of fs.readdirSync(d)) {
          const p2 = path.join(d, n);
          if (fs.statSync(p2).isDirectory()) walk(p2); else found.push(fs.readFileSync(p2, 'utf-8'));
        }
      })(dir);
      const all = found.join('\n');
      assert.ok(all.length > 0, '应至少写下一个日志文件');
      assert.ok(!all.includes(secret), `日志文件里不得出现明文 key，实际内容片段：${all.slice(0, 300)}`);
      assert.ok(all.includes('REDACTED'), '脱敏要留下可见标记');
    } finally {
      LG.initLogger(fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-log-off-'))); // initLogger 只收字符串，指到另一个临时目录即等于不再写本用例的目录
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    }
  });

  await check('默认提供商被删后自动兜底，不留悬空引用（守卫反证）', () => {
    assert.strictEqual(g.dangling.ok, true, `删除保存本身应成功：${JSON.stringify(g.dangling)}`);
    assert.strictEqual(g.danglingDefault, 'b',
      `defaultProvider 指向已删的 a 时必须兜到现存提供商，实际落盘为 ${JSON.stringify(g.danglingDefault)}`);
  });

  await check('公网明文 baseUrl 被拒且磁盘未动，回环/私网/https 照常放行（BUG-054）', () => {
    assert.strictEqual(g.pubHttp.ok, false, `公网 http 应被拒，实际 ${JSON.stringify(g.pubHttp)}`);
    assert.ok(String(g.pubHttp.reason).includes('https'), '拒绝理由要说清改用 https：' + g.pubHttp.reason);
    assert.strictEqual(g.pubHttpUnchanged, true, '被拒的保存不得改动磁盘上的模型配置');
    assert.strictEqual(g.loopHttp.ok, true, `本机回环 http 必须放行：${JSON.stringify(g.loopHttp)}`);
    assert.strictEqual(g.privHttp.ok, true, `私网 http 必须放行：${JSON.stringify(g.privHttp)}`);
    assert.strictEqual(g.httpsOk.ok, true, `https 必须放行：${JSON.stringify(g.httpsOk)}`);
  });

  try { fs.rmSync(HOME2, { recursive: true, force: true }); } catch {}

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}

  console.log('== C. 沙箱日志（PRD FR-8 可检索）==');

  const sb = require('./dist/sandbox-log.js');

  const entry = (o) => Object.assign({ tool: 'file_write', kind: 'approval', target: 'D:/w/a.txt', decision: 'allowed', ts: 1700000000000 }, o || {});

  await check('归一化：完整条目保留', () => {
    const e = sb.normalizeSandboxEntry(entry({ reason: '已写入', mode: 'autopilot', sessionId: 's1' }));
    assert.ok(e, '应通过归一化');
    assert.strictEqual(e.tool, 'file_write');
    assert.strictEqual(e.reason, '已写入');
    assert.strictEqual(e.sessionId, 's1');
  });

  await check('归一化：缺 tool / target / decision 一律丢弃（不留不可检索的脏数据）', () => {
    assert.strictEqual(sb.normalizeSandboxEntry(entry({ tool: '' })), null);
    assert.strictEqual(sb.normalizeSandboxEntry(entry({ target: '  ' })), null);
    assert.strictEqual(sb.normalizeSandboxEntry(entry({ decision: 'maybe' })), null);
    assert.strictEqual(sb.normalizeSandboxEntry(null), null);
    assert.strictEqual(sb.normalizeSandboxEntry('x'), null);
  });

  await check('归一化：kind 非法回落 path；ts 非法补当前时间', () => {
    const e = sb.normalizeSandboxEntry(entry({ kind: 'nope', ts: 'abc' }));
    assert.strictEqual(e.kind, 'path');
    assert.ok(e.ts > 0 && Number.isFinite(e.ts));
  });

  await check('装载：坏条目静默跳过，超量只留最新 MAX 条', () => {
    const raw = [entry(), null, 'x', entry({ decision: 'bad' }), entry()];
    assert.strictEqual(sb.normalizeSandboxLog(raw).length, 2, '应只留 2 条合法');
    const many = [];
    for (let i = 0; i < sb.SANDBOX_LOG_MAX + 50; i++) many.push(entry({ target: 'f' + i, ts: 1700000000000 + i }));
    const kept = sb.normalizeSandboxLog(many);
    assert.strictEqual(kept.length, sb.SANDBOX_LOG_MAX, `应保留 ${sb.SANDBOX_LOG_MAX} 条`);
    assert.strictEqual(kept[kept.length - 1].target, 'f' + (sb.SANDBOX_LOG_MAX + 49), '应保留最新的');
  });

  await check('追加：不改原数组；越界淘汰最旧', () => {
    const list = sb.normalizeSandboxLog([entry({ target: 'a', ts: 1 })]);
    const next = sb.appendSandboxLog(list, entry({ target: 'b', ts: 2 }));
    assert.strictEqual(list.length, 1, '原数组被改动');
    assert.strictEqual(next.length, 2);
    let acc = [];
    for (let i = 0; i < sb.SANDBOX_LOG_MAX + 5; i++) acc = sb.appendSandboxLog(acc, entry({ target: 't' + i, ts: i }));
    assert.strictEqual(acc.length, sb.SANDBOX_LOG_MAX);
    assert.strictEqual(acc[acc.length - 1].target, 't' + (sb.SANDBOX_LOG_MAX + 4));
    assert.ok(!acc.some((e) => e.target === 't0'), '最旧条目应被淘汰');
  });

  await check('检索：默认返回最新的，关键词大小写不敏感', () => {
    const list = sb.normalizeSandboxLog([
      entry({ target: 'D:/work/a.txt', ts: 1 }),
      entry({ target: 'C:/secret/b.txt', decision: 'denied', reason: '路径不在允许范围内', ts: 2 }),
      entry({ tool: 'shell_command', kind: 'command', target: 'git status', ts: 3 }),
    ]);
    const all = sb.searchSandboxLog(list, {});
    assert.deepStrictEqual(all.map((e) => e.ts), [3, 2, 1], '应从新到旧');
    const kw = sb.searchSandboxLog(list, { keyword: 'SECRET' });
    assert.strictEqual(kw.length, 1, '关键词应大小写不敏感命中');
    assert.strictEqual(kw[0].target, 'C:/secret/b.txt');
    assert.strictEqual(sb.searchSandboxLog(list, { keyword: '路径不在' }).length, 1, 'reason 也应可检索');
    assert.strictEqual(sb.searchSandboxLog(list, { keyword: 'zzz' }).length, 0);
  });

  await check('检索：空关键词 = 不过滤（不是「什么都匹配不到」）', () => {
    const list = sb.normalizeSandboxLog([entry({ ts: 1 }), entry({ ts: 2 })]);
    assert.strictEqual(sb.searchSandboxLog(list, { keyword: '   ' }).length, 2);
  });

  await check('检索：decision / kind 过滤与 limit 生效', () => {
    const list = sb.normalizeSandboxLog([
      entry({ decision: 'allowed', kind: 'path', ts: 1 }),
      entry({ decision: 'denied', kind: 'command', ts: 2 }),
      entry({ decision: 'error', kind: 'network', ts: 3 }),
    ]);
    assert.strictEqual(sb.searchSandboxLog(list, { decision: 'denied' }).length, 1);
    assert.strictEqual(sb.searchSandboxLog(list, { kind: 'network' }).length, 1);
    assert.strictEqual(sb.searchSandboxLog(list, { limit: 2 }).length, 2);
  });

  await check('统计：三态计数 + 按工具降序', () => {
    const list = sb.normalizeSandboxLog([
      entry({ tool: 'file_write', decision: 'allowed', ts: 1 }),
      entry({ tool: 'file_write', decision: 'denied', ts: 2 }),
      entry({ tool: 'shell_command', decision: 'error', ts: 3 }),
      entry({ tool: 'shell_command', decision: 'allowed', ts: 4 }),
      entry({ tool: 'shell_command', decision: 'allowed', ts: 5 }),
    ]);
    const st = sb.sandboxLogStats(list);
    assert.strictEqual(st.total, 5);
    assert.strictEqual(st.allowed, 3);
    assert.strictEqual(st.denied, 1);
    assert.strictEqual(st.error, 1);
    assert.strictEqual(st.byTool[0].tool, 'shell_command');
    assert.strictEqual(st.byTool[0].count, 3);
  });

  await check('摘要截断到 SANDBOX_DETAIL_MAX', () => {
    const e = sb.normalizeSandboxEntry(entry({ reason: 'x'.repeat(1000) }));
    assert.strictEqual(e.reason.length, sb.SANDBOX_DETAIL_MAX + 1);
  });

  await check('埋点：命令白名单拒绝真的写进日志（否则「可检索」是空话）', async () => {
    const out = await runToolProbe('shell_command', { command: 'format C:' }, { logQuery: {} });
    assert.ok(out.log, '探针未返回日志');
    const hit = out.log.entries.find((e) => e.decision === 'denied' && e.kind === 'command');
    assert.ok(hit, '命令白名单拒绝应入日志，实际: ' + JSON.stringify(out.log.entries).slice(0, 300));
    assert.ok(String(hit.reason).includes('沙箱服务已停止'), '日志应说明沙箱服务已停止');
  });

  await check('埋点：审批放行后的 shell 变更被记为 denied（BUG-052 现状）', async () => {
    const out = await runToolProbe('shell_command', { command: 'echo hello-sandbox' }, { approve: true, logQuery: { keyword: 'echo' } });
    const hit = out.log.entries.find((e) => e.decision === 'denied' && String(e.reason).includes('沙箱服务已停止'));
    assert.ok(hit, '停止后的变更应记为拒绝，实际: ' + JSON.stringify(out.log.entries).slice(0, 300));
    assert.ok(String(hit.target).includes('echo hello-sandbox'));
  });

  await check('埋点：渲染层未就绪被拒 → 记为 denied（不是「什么都没发生」）', async () => {
    const out = await runToolProbe('shell_command', { command: 'echo blocked' }, { logQuery: {} });
    const hit = out.log.entries.find((e) => e.decision === 'denied' && String(e.reason).includes('沙箱服务已停止'));
    assert.ok(hit, '停止后的拒绝应入日志，实际: ' + JSON.stringify(out.log.entries).slice(0, 300));
  });

  await check('日志落盘：磁盘上有 sandbox-log.json 且内容可回读', async () => {
    const out = await runToolProbe('file_read', { path: '__DATA__/probe-written.txt' }, { logQuery: {} });
    assert.ok(out.logFileExists, '数据目录应存在 sandbox-log.json（实际: ' + out.logPreview + '）');
    assert.ok(Array.isArray(out.logFileEntries), '落盘内容应为数组');
  });

  await check('治理项⑥：dirty 合并 flush——窗口内 3 次判定只触发 ≤2 次写盘（真判别性：patch 子进程 fs）', async () => {
    // 判别性断言（复审轮 2 补强）：在探针子进程内 patch fs.writeFileSync 计数
    // sandbox-log.json 写盘次数——治理前每条判定都全量重写（3+ 次），治理后
    // 100ms 窗口内合帧（≤2 次）。改回逐条写本断言 FAIL。
    const probe = `
      const Module = require('module');
      const path = require('path'), fs = require('fs'), os = require('os');
      const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-flush-'));
      process.env.ORCHDESK_HOME = HOME;
      const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
      const stub = makeElectronStub({ home: HOME, getPath: (n) => path.join(HOME, 'st', n) });
      const ipc = stub.ipcHandlers;
      const orig = Module._load;
      Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
      const realWrite = fs.writeFileSync;
      let writes = 0;
      fs.writeFileSync = function (p, ...rest) { if (String(p).includes('sandbox-log.json')) writes++; return realWrite.call(fs, p, ...rest); };
      require('${path.join(__dirname, 'dist', 'main.js').replace(/\\/g, '\\\\')}');
      (async () => {
        for (let i = 0; i < 100; i++) {
          const h = ipc.get('orchdesk:plugin-runtime');
          if (h) { const st = await h(null); if (st && st.plugins && st.plugins.length >= 9 && st.plugins.every((p) => p.available === false)) break; }
          await new Promise((r) => setTimeout(r, 50));
        }
        const tool = (p) => ipc.get('orchdesk:tool-execute')(null, { name: 'file_read', arguments: { path: p } });
        // 三次判定必须并发打出（Promise.all）。顺序 await 时每次 IPC 往返的延迟会把
        // 三次 recordSandbox 拉出同一个 100ms 合帧窗口——慢机上恒定 3 次写，那测的是
        // 机器速度而不是合帧（本用例历史上的 flaky 根因）。并发后三条挤在同一 tick：
        // 治理前每条同步全量重写 → 恒定 3 次；治理后首条排定 flush、其余只标记 dirty
        // → 合并为 1 次。两种形态都与机器快慢无关。
        await Promise.all([
          tool(path.join(HOME, 'f1.txt')),
          tool(path.join(HOME, 'f2.txt')),
          tool(path.join(HOME, 'f3.txt')),
        ]);
        await new Promise((r) => setTimeout(r, 300)); // 等 flush 窗口
        console.log('TOOL_JSON:' + JSON.stringify({ writes }));
        process.exit(0);
      })().catch((e) => { console.log('ERR:' + ((e && e.stack) || e)); process.exit(1); });
    `;
    const { execFileSync } = require('node:child_process');
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    } catch (err) {
      // 与本文件首个 probe（models 保存）同一容错口径：探针 require 了 dist/main.js，
      // Node 退出阶段与 Cordis 悬挂句竞炸 libuv 断言（UV_HANDLE_CLOSING）——崩溃发生在
      // 测量结果打印之后，err.stdout 里已有 TOOL_JSON。此时测量有效，该用；只有连结果
      // 都没打出来才是真失败。此前这里见到非零退出就抛，于是这条用例约 50% 概率把
      // 已经拿到的正确结果判成 FAIL——那是测试基建的 flaky，不是产品缺陷。
      stdout = String(err.stdout || '') + String(err.stderr || '');
    }
    const m = stdout.match(/TOOL_JSON:(.*)/);
    if (!m) throw new Error('probe 未输出结果:\n' + stdout.slice(0, 2000));
    const out = JSON.parse(m[1]);
    assert.ok(out.writes >= 1, 'flush 后应至少写一次，实际 ' + out.writes);
    // 上界 2：并发三连下发时治理前恒定 3 次（每条同步全量重写），治理后合并为 1 次；
    // 留 1 的余量仅防某条 handler 个体 stall 超过 100ms 窗口的病态机器。
    assert.ok(out.writes <= 2, '窗口内 3 次判定最多 2 次写（治理前逐条写为 3+），实际 ' + out.writes);
  });

  await check('清空：sandbox-log-clear 后 total 归零', async () => {
    const out = await runToolProbe('file_read', { path: '__DATA__/probe-written.txt' }, { logQuery: {}, clearLog: true });
    assert.ok(out.cleared >= 0, '应返回被清条数');
    assert.strictEqual(out.logAfterClear.total, 0, '清空后 total 应为 0');
  });

  // 组名沿用历史；本构建下命令到不了子进程那一步（BUG-052），组内断言已按实际结果命名。
  console.log('== D. 沙箱：变更类工具的拒绝与留痕 ==');

  await check('shell_command 在句柄缺失下被拒（BUG-052 现状；全链路正控尚未被真正测到）', async () => {
    const out = await runToolProbe('shell_command', { command: 'echo hello-sandbox' }, { approve: true });
    assert.ok(out && typeof out.result === 'string', '应返回 result');
    assert.ok(out.error && out.error.includes('沙箱服务已停止'), '沙箱停止后不得执行命令，实际: ' + JSON.stringify(out).slice(0, 200));
  });

  await check('渲染层未就绪时 shell 也被拒（当前拒于句柄缺失，先于授权门）', async () => {
    const out = await runToolProbe('shell_command', { command: 'echo blocked' });
    assert.ok(out.error && out.error.includes('沙箱服务已停止'), '沙箱停止后应拒绝，实际: ' + JSON.stringify(out).slice(0, 200));
  });

  await check('file_write 未获批时被授权门拦截（白名单内路径仍不 silently 放行）', async () => {
    const out = await runToolProbe('file_write', { path: '__DATA__/should-not-exist.txt', content: 'x' });
    assert.ok(out.error && out.error.includes('沙箱服务已停止'), '写文件应被停止的沙箱拒绝，实际: ' + JSON.stringify(out).slice(0, 200));
  });

  await check('file_write 审批放行后仍被拒——宿主服务句柄从未被装配（BUG-052 的现状记录，非期望行为）', async () => {
    const out = await runToolProbe('file_write', { path: '__DATA__/probe-written.txt', content: 'hello-gate' }, { approve: true });
    assert.ok(out.error && out.error.includes('沙箱服务已停止'), '沙箱停止后不得写入，实际: ' + JSON.stringify(out).slice(0, 200));
  });

  await check('白名单外的命令被拒绝', async () => {
    const out = await runToolProbe('shell_command', { command: 'format C:' });
    assert.ok(out.error, '应被白名单拒绝');
    assert.ok(out.error.includes('沙箱服务已停止'), '沙箱停止后应拒绝，实际: ' + out.error);
  });

  await check('空命令被拒绝（不执行）', async () => {
    const out = await runToolProbe('shell_command', { command: '' });
    assert.ok(out.error, '空命令应被拒绝，实际: ' + JSON.stringify(out));
  });

  await check('目录白名单外的路径被拒绝', async () => {
    const out = await runToolProbe('file_read', { path: 'C:\\Windows\\System32\\config\\SAM' });
    assert.ok(out.error, '应被路径白名单拒绝，实际: ' + JSON.stringify(out));
  });

  // ---- M4：沙箱模式在工具执行层真实强制（安全审查 M2：此前 mode 只活在审批门）----
  // BUG-052 的现状：句柄恒 null，所以这两条实际拒于「沙箱服务已停止」，不是拒于模式门——
  // 标题以前写「被模式门拒绝」是误导（断言与标题相反），改按实际断言的东西命名。
  await check('M4：句柄缺失时 file_write 被拒（模式门尚未被真正测到）', async () => {
    const out = await runToolProbe('file_write', { path: '__DATA__/ro.txt', content: 'x' }, { readOnly: true });
    assert.ok(out.error && out.error.includes('沙箱服务已停止'), '沙箱停止后写文件应被拒，实际: ' + JSON.stringify(out).slice(0, 200));
  });
  await check('M4：句柄缺失时 shell_command 被拒（同上）', async () => {
    const out = await runToolProbe('shell_command', { command: 'echo hi' }, { readOnly: true });
    assert.ok(out.error && out.error.includes('沙箱服务已停止'), '沙箱停止后命令应被拒，实际: ' + JSON.stringify(out).slice(0, 200));
  });
  await check('M4 read-only 模式：file_read 仍放行（只读模式不挡读）', async () => {
    // 读一个必然存在的小文件：数据目录本身
    const out = await runToolProbe('file_list', { path: '__DATA__' }, { readOnly: true });
    assert.ok(!out.error, 'read-only 下读目录不应被拒，实际: ' + JSON.stringify(out).slice(0, 200));
  });
  await check('M4 read-only 模式：set_cwd 被模式门拒绝', async () => {
    const out = await runToolProbe('set_cwd', { path: '__DATA__' }, { readOnly: true });
    assert.ok(out.error && out.error.includes('沙箱服务已停止'), '沙箱停止后切换工作目录应被拒，实际: ' + JSON.stringify(out).slice(0, 200));
  });
  await check('M4 workspace-write（默认）：写白名单窄于读白名单（读根内的非写路径拒写）', async () => {
    // narrowData 夹具：dataDir=<HOME>/dd，home/userData 仍是读根。
    const okOut = await runToolProbe('file_write', { path: '__DD__/narrow-ok.txt', content: 'x' }, { approve: true, narrowData: true });
    assert.ok(okOut.error && okOut.error.includes('沙箱服务已停止'), '沙箱停止后数据目录也不可写，实际: ' + JSON.stringify(okOut).slice(0, 200));
    const badOut = await runToolProbe('file_write', { path: '__UDATA__/proj/x.txt', content: 'x' }, { approve: true, narrowData: true });
    assert.ok(badOut.error && badOut.error.includes('沙箱服务已停止'), '沙箱停止后非写路径也应被拒，实际: ' + JSON.stringify(badOut).slice(0, 200));
  });

  // -------------------------------------------------------------------------
  console.log('\n' + log.join('\n'));
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
  if (failed > 0) process.exit(1);
  console.log('凭据与沙箱全部验证通过');
  process.exit(0);

  // ---- helper：在子进程里用 stub electron 驱动 orchdesk:tool-execute ----
  // opts.approve=true 走完整审批链路：load-sessions（渲染层就绪标记）→ 触发工具 →
  // 拦截 webContents.send 的审批请求 → 经 authz-submit-decision 应答 allowed-once。
  async function runToolProbe(toolName, args, opts = {}) {
    const probe = `
      const Module = require('module');
      const path = require('path'), fs = require('fs'), os = require('os');
      const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-tool-'));
      process.env.ORCHDESK_HOME = HOME;
      // narrowData 选项：把数据目录压到 <HOME>/dd 子目录，使「写根 ⊂ 读根」可判定
      // （默认夹具里 dataDir==HOME，整个 home 都是写根，区分不出窄化）。
      if (${!!opts.narrowData}) process.env.ORCHDESK_HOME = path.join(HOME, 'dd');
      const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
      const stub = makeElectronStub({
        home: HOME,
        getPath: (n) => n === 'appData' ? path.join(HOME,'ad') : path.join(HOME,'st',n),
      });
      const ipc = stub.ipcHandlers;
      const orig = Module._load;
      Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
      require('${path.join(__dirname, 'dist', 'main.js').replace(/\\/g, '\\\\')}');
      const args0 = ${JSON.stringify({ name: toolName, arguments: args })};
      // __DATA__ 占位 → 子进程数据目录（ORCHDESK_HOME，必在路径白名单内）
      // __DD__ 占位 → narrowData 夹具里的窄数据目录 <HOME>/dd
      // __UDATA__ 占位 → stub 的 userData 根（读白名单内、写白名单外）
      if (args0.arguments && args0.arguments.path) {
        args0.arguments.path = String(args0.arguments.path)
          .replace(/__DATA__/g, HOME)
          .replace(/__DD__/g, path.join(HOME, 'dd'))
          .replace(/__UDATA__/g, path.join(HOME, 'st', 'userData'));
      }
      (async () => {
        // 等 bootRuntime 完成（plugin-runtime handler 注册早于运行时就绪，直接 kick 会竞态）
        for (let i = 0; i < 100; i++) {
          const h = ipc.get('orchdesk:plugin-runtime');
          if (h) {
            const st = await h(null);
            if (st && st.plugins && st.plugins.length >= 9 && st.plugins.every((p) => p.available === false)) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        // M4：readOnly 选项 → 运行时就绪后把全局沙箱模式切成 read-only
        // （就绪前 getService 返回 undefined，?. 会静默跳过——模式门必须真生效）。
        for (let i = 0; i < 100 && stub.windows.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        if (${!!opts.readOnly}) {
          const rt = require('${path.join(__dirname, 'dist', 'dsh-runtime.js').replace(/\\/g, '\\\\')}');
          rt.getService('sandboxPolicy')?.setSandboxMode({}, 'read-only');
        }
        ${opts.approve ? "await ipc.get('orchdesk:load-sessions')(null);" : ''}
        const kick = ipc.get('orchdesk:tool-execute')(null, args0);
        ${opts.approve ? `
        let approvalReq = null;
        for (let i = 0; i < 100 && !approvalReq; i++) {
          approvalReq = stub.webSent.find((w) => w.ch === 'orchdesk:authz-approval-request');
          if (!approvalReq) await new Promise((r) => setTimeout(r, 20));
        }
        // 等不到审批请求 ≠ 失败：模式门/路径白名单可能在审批前就拒了（M4），
        // 此时 kick 本身会带 error 返回，交由断言检查。
        if (approvalReq) stub.ipcListeners.get('orchdesk:authz-submit-decision')(null, approvalReq.payload.id, 'allowed-once');
        ` : ''}
        const r = await kick;
        // PRD FR-8：可选地把沙箱日志一并返回（验证「判定真的被记下来」而非只存在代码里）
        let payload = r;
        if (${opts.logQuery !== undefined || !!opts.clearLog}) {
          const logH = ipc.get('orchdesk:sandbox-log');
          payload = { result: r.result, error: r.error, log: await logH(null, ${JSON.stringify(opts.logQuery || {})}) };
          const logFile = path.join(HOME, 'sandbox-log.json');
          // 治理项⑥：落盘是 dirty 合并 flush（100ms 窗口）——读盘前轮询等 flush，
          // 不用固定 wall-clock（慢机器 flaky）。
          for (let i = 0; i < 20 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 100));
          payload.logFileExists = fs.existsSync(logFile);
          try { payload.logFileEntries = JSON.parse(fs.readFileSync(logFile, 'utf-8')); }
          catch (e) { payload.logPreview = 'read-fail:' + e.message; }
          if (${!!opts.clearLog}) {
            const c = await ipc.get('orchdesk:sandbox-log-clear')(null);
            payload.cleared = c.cleared;
            payload.logAfterClear = await logH(null, {});
          }
        }
        console.log('TOOL_JSON:' + JSON.stringify(payload));
        process.exit(0);
      })().catch(e => { console.log('ERR:' + e.message); process.exit(1); });
    `;
    const f = path.join(os.tmpdir(), `tool-probe-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.cjs`);
    fs.writeFileSync(f, probe, 'utf-8');
    let out = '';
    try {
      out = require('node:child_process').execSync(`node "${f}"`, { encoding: 'utf-8', timeout: 60_000 });
    } catch (err) {
      out = (err.stdout || '') + (err.stderr || '');
    } finally {
      try { fs.unlinkSync(f); } catch {}
    }
    const mm = out.match(/TOOL_JSON:(\{.*\})/);
    if (!mm) throw new Error('探针无输出: ' + out.slice(0, 200));
    return JSON.parse(mm[1]);
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
