/**
 * 连接器注册表验证（PRD FR-3）。
 *
 * A 组：纯逻辑（require dist/connector-registry.js）—— 目录完备性 / 脱敏 /
 *       探测请求构造（Linear 无 Bearer、企微 URL 编码、TAPD Basic、飞书结构化 body）/
 *       结果判定（业务码陷阱）/ 状态与审计。
 * B 组：stub electron 驱动真实 IPC —— 保存（含脱敏回显写回保护）/ 清除 / 审计 /
 *       落盘加密。全程不发真实网络：http 连接器只在「缺必填字段 → 快速失败」
 *       和 manual 连接器（无探测）两条不触网路径上做端到端。
 *
 * 运行：node connector-registry-verify.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_DIR = __dirname;
const REG = require(path.join(APP_DIR, 'dist', 'connector-registry.js'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
// 本套件沿用 verify-plugins.mjs 的两参 assert 约定（没有 strictEqual）。
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  /* ============================== A 组：纯逻辑 ============================== */
  console.log('== 连接器：目录与凭证（FR-3）==');

  await check('目录：8 个连接器，id 唯一，定义完备（fields/probe/docsUrl）', () => {
    assert(REG.CONNECTOR_CATALOG.length >= 8, `应有 8+ 连接器，实际 ${REG.CONNECTOR_CATALOG.length}`);
    const ids = REG.CONNECTOR_CATALOG.map((c) => c.id);
    assert(new Set(ids).size === ids.length, 'id 有重复');
    for (const c of REG.CONNECTOR_CATALOG) {
      assert(c.name && c.desc && c.docsUrl && Array.isArray(c.fields) && c.fields.length > 0 && c.probe,
        `${c.id} 定义不完整`);
      for (const f of c.fields) assert(f.key && f.label && f.type, `${c.id} 字段 ${f.key} 不完整`);
    }
  });

  await check('脱敏：secret 留末 4 位、text 原样回显、未填为空串', () => {
    const def = REG.getConnectorDef('feishu');
    const out = REG.redactCreds(def, { appId: 'cli_abc123', appSecret: 's3cr3t-key-9999', appSecret2: undefined });
    assert(out.appId === 'cli_abc123', 'text 字段应原样回显，实际 ' + JSON.stringify(out));
    assert(out.appSecret === '••••9999', 'secret 应只留末 4 位，实际 ' + out.appSecret);
    const gh = REG.redactCreds(REG.getConnectorDef('github'), { token: '' });
    assert(gh.token === '', '未填应为空串，实际 ' + JSON.stringify(gh.token));
  });

  await check('必填校验：只报字段名不报值（凭证不进日志）', () => {
    const def = REG.getConnectorDef('feishu');
    const missing = REG.missingRequired(def, { appId: 'cli_x' });
    assert(missing.includes('appSecret') && !missing.includes('appId'), '应只缺 appSecret，实际 ' + JSON.stringify(missing));
  });

  await check('Linear 请求构造：Authorization 不带 Bearer + GraphQL body', () => {
    const def = REG.getConnectorDef('linear');
    const r = REG.buildProbeRequest(def, { apiKey: 'lin_api_abc' });
    assert(r.ok, '构造失败: ' + (r.ok ? '' : r.error));
    assert(r.request.headers.Authorization === 'lin_api_abc',
      '个人密钥的 Authorization 不应带 Bearer，实际 ' + r.request.headers.Authorization);
    assert(r.request.method === 'POST' && r.request.url === 'https://api.linear.app/graphql', '端点错误');
    const body = JSON.parse(r.request.body);
    assert(/viewer/.test(body.query), 'body 应含 viewer 查询');
  });

  await check('GitHub 请求构造：Bearer 头 + User-Agent + GET 无 body', () => {
    const def = REG.getConnectorDef('github');
    const r = REG.buildProbeRequest(def, { token: 'ghp_x' });
    assert(r.ok, '构造失败');
    assert(r.request.headers.Authorization === 'Bearer ghp_x', 'Bearer 头错误');
    assert(r.request.headers['User-Agent'] === 'OrchDesk', 'GitHub API 必须带 UA');
    assert(r.request.method === 'GET' && !r.request.body, '应为 GET 无 body');
  });

  await check('企微请求构造：URL 查询值经 encodeURIComponent（特殊字符不破坏 URL）', () => {
    const def = REG.getConnectorDef('wecom');
    const r = REG.buildProbeRequest(def, { corpid: 'ww1', corpsecret: 'a&b=c d' });
    assert(r.ok, '构造失败');
    assert(r.request.url.includes('corpsecret=a%26b%3Dc%20d'), '查询值应被编码，实际 ' + r.request.url);
  });

  await check('TAPD 请求构造：Basic 鉴权 = base64(user:pass)', () => {
    const def = REG.getConnectorDef('tapd');
    const r = REG.buildProbeRequest(def, { apiUser: 'u1', apiPassword: 'p1', nick: 'n1', companyId: '1' });
    assert(r.ok, '构造失败');
    const want = 'Basic ' + Buffer.from('u1:p1').toString('base64');
    assert(r.request.headers.Authorization === want, 'Basic 头错误，实际 ' + r.request.headers.Authorization);
  });

  await check('飞书请求构造：结构化 body（secret 含引号也生成合法 JSON）', () => {
    const def = REG.getConnectorDef('feishu');
    const r = REG.buildProbeRequest(def, { appId: 'cli_x', appSecret: 'se"cr\\et' });
    assert(r.ok, '构造失败');
    let body; try { body = JSON.parse(r.request.body); } catch (e) { throw new Error('body 不是合法 JSON: ' + r.request.body); }
    assert(body.app_id === 'cli_x' && body.app_secret === 'se"cr\\et', '占位符替换后值应原样保留');
  });

  await check('缺必填字段 → 构造失败且报字段名（不触网）', () => {
    const def = REG.getConnectorDef('feishu');
    const r = REG.buildProbeRequest(def, { appId: 'cli_x' });
    assert(!r.ok && /appSecret/.test(r.error), '应报缺少 appSecret，实际 ' + JSON.stringify(r));
  });

  await check('腾讯文档 manual → 明确不支持自动探测（不伪造成功）', () => {
    const def = REG.getConnectorDef('tencent-docs');
    const r = REG.buildProbeRequest(def, { token: 'x' });
    assert(!r.ok && /不支持自动探测/.test(r.error), '应拒绝构造，实际 ' + JSON.stringify(r));
  });

  console.log('== 连接器：探测结果判定 ==');

  await check('企微 200 + errcode=40001 → 判失败（只看状态码会把鉴权失败当成功）', () => {
    const def = REG.getConnectorDef('wecom');
    const r = REG.interpretProbeResult(def, { status: 200, body: { errcode: 40001, errmsg: 'invalid credential' } });
    assert(!r.ok, '业务码非 0 必须判失败');
    assert(/invalid credential/.test(r.message), '失败消息应带原因，实际 ' + r.message);
  });

  await check('飞书 200 + code=0 + tenant_access_token → 判成功', () => {
    const def = REG.getConnectorDef('feishu');
    const r = REG.interpretProbeResult(def, { status: 200, body: { code: 0, tenant_access_token: 't-1' } });
    assert(r.ok, '应判成功，实际 ' + r.message);
  });

  await check('Linear 200 + errors 数组 → 判失败（GraphQL 鉴权失败也返 200）', () => {
    const def = REG.getConnectorDef('linear');
    const r = REG.interpretProbeResult(def, { status: 200, body: { errors: [{ message: 'Invalid API key' }] } });
    assert(!r.ok && /Invalid API key/.test(r.message), 'errors 数组必须判失败，实际 ' + JSON.stringify(r));
  });

  await check('GitHub 200 + login → 判成功且带身份（已连接：@xxx）', () => {
    const def = REG.getConnectorDef('github');
    const r = REG.interpretProbeResult(def, { status: 200, body: { login: 'octocat', id: 1 } });
    assert(r.ok && /octocat/.test(r.message), '应判成功并带身份，实际 ' + r.message);
  });

  await check('HTTP 401 → 判失败并带响应体原因', () => {
    const def = REG.getConnectorDef('github');
    const r = REG.interpretProbeResult(def, { status: 401, body: { message: 'Bad credentials' } });
    assert(!r.ok && /401/.test(r.message) && /Bad credentials/.test(r.message), '应带状态码与原因，实际 ' + r.message);
  });

  console.log('== 连接器：状态 / 审计 / 持久化编解码 ==');

  await check('writeCreds：改凭证后旧探测结论作废（不能拿 A 账号的「已连接」显示给 B 账号）', () => {
    const file = REG.emptyConnectorFile();
    REG.writeCreds(file, 'github', { token: 'tok-a' }, 1000);
    file.states.github.lastTestOk = true;
    file.states.github.lastTestMessage = '已连接：a';
    REG.writeCreds(file, 'github', { token: 'tok-b' }, 2000);
    assert(file.states.github.lastTestOk === null && file.states.github.lastTestMessage === '',
      '换凭证后旧结论必须作废');
    assert(file.states.github.configured === true && file.states.github.savedAt === 2000, 'configured/savedAt 应更新');
  });

  await check('clearCreds：凭证与状态一并归零', () => {
    const file = REG.emptyConnectorFile();
    REG.writeCreds(file, 'github', { token: 'tok-a' });
    REG.clearCreds(file, 'github');
    assert(file.states.github.configured === false && !file.creds.github, '清除后状态应为空');
  });

  await check('审计环形缓冲：越界淘汰最旧；查询倒序 + 过滤；统计分类正确', () => {
    let lg = [];
    for (let i = 0; i < REG.CONNECTOR_AUDIT_MAX + 5; i++) {
      lg = REG.appendAudit(lg, { id: 'github', ts: i, action: 'save', message: 'm' + i });
    }
    assert(lg.length === REG.CONNECTOR_AUDIT_MAX, '应淘汰到上限，实际 ' + lg.length);
    assert(lg[0].message === 'm5' && lg[lg.length - 1].message === `m${REG.CONNECTOR_AUDIT_MAX + 4}`, '应淘汰最旧的 5 条');
    lg = REG.appendAudit(lg, { id: 'wecom', ts: 999, action: 'test-fail', message: 'HTTP 401 · Bad credentials' });
    const hits = REG.searchAudit(lg, { id: 'wecom' });
    assert(hits.length === 1 && hits[0].action === 'test-fail', '按 id 过滤失败');
    assert(REG.searchAudit(lg, { q: 'bad credentials' }).length === 1, '关键词（大小写不敏感）应命中');
    assert(REG.searchAudit(lg, { action: 'test-fail' })[0].ts === 999, '过滤后应存在');
    const s = REG.auditStats(lg);
    // 环形上限 200：205 条 save + 1 条 fail，最旧的 6 条被淘汰 → 199 save + 1 fail。
    assert(s.total === REG.CONNECTOR_AUDIT_MAX && s.saves === REG.CONNECTOR_AUDIT_MAX - 1 && s.fails === 1, '统计错误: ' + JSON.stringify(s));
  });

  await check('文件编解码 roundtrip：合法数据保留，未知 id 丢弃，脏数据不炸', () => {
    const file = REG.emptyConnectorFile();
    REG.writeCreds(file, 'github', { token: 'tok-abc' }, 1234);
    file.states.github.lastTestOk = true;
    const plain = JSON.parse(JSON.stringify({ ...file, junk: { github: { configured: 'yes' } }, creds: { ...file.creds, 'not-a-connector': { token: 'zzz' } } }));
    const back = REG.normalizeConnectorFile(plain);
    assert(back.creds.github && back.creds.github.token, '合法凭证应保留');
    assert(!back.creds['not-a-connector'], '未知连接器 id 应丢弃');
    assert(back.states.github.configured === true && back.states.github.lastTestOk === true, '状态应保留');
    const creds = REG.readCreds(back, 'github');
    assert(creds.token === 'tok-abc', '解密 roundtrip 应还原原值，实际 ' + JSON.stringify(creds));
  });

  await check('坏密文解密 → 空串（按未填写处理，绝不回落明文或拿去探测）', () => {
    const file = REG.emptyConnectorFile();
    file.creds.github = { token: 'not-a-valid-cipher' };
    const creds = REG.readCreds(file, 'github');
    assert(creds.token === '', '坏密文应解出空串，实际 ' + JSON.stringify(creds));
  });

  /* ===================== B 组：stub electron 驱动真实 IPC ===================== */
  console.log('== 连接器：真 IPC 链路（stub electron，不触真实网络）==');

  const probe = runProbe();
  await check('IPC connectors：8 个连接器 + 统计', () => {
    assert(probe.items.length === 8, `应返回 8 个，实际 ${probe.items.length}`);
    assert(probe.stats && probe.stats.total === 8, '统计 total 应为 8，实际 ' + JSON.stringify(probe.stats));
  });

  await check('保存 manual 连接器凭证 → configured 且 probe.manual（诚实说不可验证，不伪造已连接）', () => {
    const r = probe.saveManual;
    assert(r.ok === true && r.configured === true, '保存应成功，实际 ' + JSON.stringify(r));
    assert(r.probe && r.probe.manual === true, '腾讯文档应返回 manual 探测');
    assert(r.state.lastTestOk === null, 'manual 不应伪造探测结论');
  });

  await check('列表回显脱敏：secret 只留末 4 位', () => {
    const td = probe.items.find((c) => c.id === 'tencent-docs');
    assert(td.values.token === '••••6789', '应脱敏为 ••••6789，实际 ' + JSON.stringify(td.values));
  });

  await check('脱敏回显值写回 → 原凭证保留（不被圆点覆盖成空）', () => {
    assert(probe.maskedRewriteKept === true, '用 ••••6789 回写后文件里的真凭证应原样保留');
  });

  await check('http 连接器缺必填保存 → configured=false 且不触网（probe=null）', () => {
    const r = probe.saveGithubEmpty;
    assert(r.ok === true && r.configured === false && r.probe === null, '缺字段应只保存不探测，实际 ' + JSON.stringify(r));
  });

  await check('未配置就点测试 → 快速失败并报缺哪个字段（审计记 test-fail）', () => {
    const r = probe.testGithubUnconfigured;
    assert(r.ok === false && /缺少必填凭证字段/.test(r.message), '应报缺字段，实际 ' + JSON.stringify(r));
    assert(probe.auditHasTestFail === true, '审计应有 test-fail 记录');
  });

  await check('manual 连接器点测试 → 返回 manual 原因（ok=false 但 manual=true）', () => {
    const r = probe.testManual;
    assert(r.ok === false && r.manual === true && /腾讯文档/.test(r.message), '应诚实返回 manual 原因，实际 ' + JSON.stringify(r));
  });

  await check('清除凭证 → 状态归零 + 审计记 clear', () => {
    assert(probe.clearOk === true && probe.afterClearConfigured === false, '清除后应为未配置');
    assert(probe.auditHasClear === true, '审计应有 clear 记录');
  });

  await check('落盘加密：connectors.json 存在、不含明文凭证、重新解码可还原', () => {
    assert(probe.fileExists === true, 'connectors.json 应已落盘');
    assert(probe.plaintextLeaked === false, `文件里不得出现明文凭证（发现：${probe.leakSample}）`);
    assert(probe.roundtripToken === 'td-token-123456789', '重新解码 + 解密应还原原值，实际 ' + probe.roundtripToken);
  });

  await check('审计清空 IPC → cleared 数正确', () => {
    assert(probe.auditCleared >= 2, `应清掉 >=2 条审计，实际 ${probe.auditCleared}`);
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();

/**
 * 子进程跑真实主进程：stub electron。
 * 不触真实网络的取巧：http 连接器只走「缺必填字段 → buildProbeRequest 快速失败」
 * 路径（构造层是纯函数，已在 A 组覆盖完整请求构造），manual 连接器天然不触网。
 * 请求构造与结果判定的「线级正确性」由 A 组纯函数断言 + （可选）真实环境人工验证兜底。
 */
function runProbe() {
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    // probe 脚本落在系统临时目录，__dirname 指向那里 —— 所有路径必须以 APP_DIR 为基准。
    const APP_DIR = ${JSON.stringify(APP_DIR)};
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-conn-'));
    process.env.ORCHDESK_HOME = HOME;

    const { makeElectronStub } = require(${JSON.stringify(path.join(APP_DIR, '..', '..', 'scripts', 'verify-kit.cjs'))});
    const stub = makeElectronStub({
      home: HOME,
      getPath: (n) => n === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', n),
    });
    const ipc = stub.ipcHandlers;
    const orig = Module._load;
    Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };

    const out = {};
    (async () => {
      require(path.join(APP_DIR, 'dist', 'main.js'));
      // 启动装载在 bootRuntime 之后；连接器装载只依赖 dataDir，等 file IPC 出现即可。
      for (let i = 0; i < 200; i++) {
        if (ipc.get('orchdesk:connectors')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const list = () => ipc.get('orchdesk:connectors')(null);
      const save = (id, creds) => ipc.get('orchdesk:connector-save')(null, id, creds);
      const test = (id) => ipc.get('orchdesk:connector-test')(null, id);
      const clear = (id) => ipc.get('orchdesk:connector-clear')(null, id);
      const audit = () => ipc.get('orchdesk:connector-audit')(null, {});

      // --- 1. 目录 ---
      const l0 = await list();
      out.items = l0.items;
      out.stats = l0.stats;

      // --- 2. manual 连接器保存（不触网）---
      out.saveManual = await save('tencent-docs', { token: 'td-token-123456789' });

      // --- 3. 脱敏回显（保存后的列表）---
      const l1 = await list();
      out.items = l1.items;
      const td = l1.items.find((c) => c.id === 'tencent-docs');
      out.maskedValue = td && td.values ? td.values.token : '';

      // --- 4. 落盘加密（必须在 clear 之前：凭证还在文件里时才能验 roundtrip）---
      const file = path.join(HOME, 'connectors.json');
      out.fileExists = fs.existsSync(file);
      const raw = out.fileExists ? fs.readFileSync(file, 'utf-8') : '';
      out.plaintextLeaked = raw.includes('td-token-123456789');
      out.leakSample = out.plaintextLeaked ? raw.slice(0, 80) : '';
      const reg = require(path.join(APP_DIR, 'dist', 'connector-registry.js'));
      const re1 = reg.normalizeConnectorFile(JSON.parse(raw));
      out.roundtripToken = reg.readCreds(re1, 'tencent-docs').token || '';

      // --- 5. 回显值原样写回：真凭证应保留（不被圆点覆盖成空）---
      const masked = await save('tencent-docs', { token: out.maskedValue });
      const re2 = reg.normalizeConnectorFile(JSON.parse(fs.readFileSync(file, 'utf-8')));
      out.maskedRewriteKept = masked.ok === true &&
        reg.readCreds(re2, 'tencent-docs').token === 'td-token-123456789';

      // --- 6. http 连接器缺必填保存（不触网）---
      out.saveGithubEmpty = await save('github', {});

      // --- 7. 未配置点测试（快速失败，不触网）---
      out.testGithubUnconfigured = await test('github');

      // --- 8. manual 点测试 ---
      out.testManual = await test('tencent-docs');

      // --- 9. 清除 ---
      const c = await clear('tencent-docs');
      out.clearOk = c.ok === true;
      const l2 = await list();
      const td2 = l2.items.find((x) => x.id === 'tencent-docs');
      out.afterClearConfigured = !!(td2 && td2.state && td2.state.configured);

      // --- 10. 审计 ---
      const a1 = await audit();
      out.auditEntries = a1.entries.map((e) => e.action);
      out.auditHasTestFail = out.auditEntries.includes('test-fail');
      out.auditHasClear = out.auditEntries.includes('clear');

      // --- 11. 审计清空 ---
      const ca = await ipc.get('orchdesk:connector-audit-clear')(null);
      out.auditCleared = ca.cleared;

      console.log('RESULT_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + ((e && e.stack) || e)); process.exit(1); });
  `;
  const tmp = path.join(os.tmpdir(), `conn-probe-${Date.now()}.cjs`);
  fs.writeFileSync(tmp, script, 'utf-8');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [tmp], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (err) {
    const so = String((err && err.stdout) || '');
    const se = String((err && err.stderr) || '');
    throw new Error(`probe 失败：${err.message}\n${so}\n${se}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响结果 */ }
  }
  const m = stdout.match(/RESULT_JSON:(.*)/);
  if (!m) throw new Error('probe 未输出结果：\n' + stdout);
  return JSON.parse(m[1]);
}
