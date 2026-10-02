/**
 * 观雅集能力审查验证（纯逻辑，不触网）。
 *
 * 守的是这条红线：安装前能力审查不得被调用方自报的字段绕过。
 * `orchdesk:guanji-install` 的 skill 整个对象来自渲染层，原先 `capabilityReview`
 * 直接读 `skill.auth`，于是自报 auth=0 就等于跳过 L3/L4 的显式授权确认。
 * 现在 auth 只由 `caps` 推导，与本文件解析列表时的推导同一口径。
 *
 * 约定：本套件的 assert 是两参形态（cond, msg），与 connector-registry 那批一致。
 * 运行：node guanji-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */
const path = require('path');

const { GuanjiClient } = require(path.join(__dirname, 'dist', 'guanji.js'));

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${(e && e.message) || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function is(actual, expected, what) {
  assert(actual === expected, `${what}：期望 ${expected}，实际 ${actual}`);
}

// baseUrl 指向一个不会连的端口：本套件只测审查逻辑。
const client = new GuanjiClient('http://127.0.0.1:9');
const skill = (caps, auth) => ({ slug: 's1', name: 'S1', description: '', caps, auth });

(async () => {
  console.log('\n== 观雅集能力审查 ==');

  await check('低风险能力 → allowed（不打扰用户）', () => {
    is(client.capabilityReview(skill(['fs.read', 'chart.render'], 0)), 'allowed', '低风险');
  });

  await check('高危能力 + 未授权 → needs-auth', () => {
    is(client.capabilityReview(skill(['mail.send'], 1)), 'needs-auth', '发信');
    is(client.capabilityReview(skill(['fs.write'], 1)), 'needs-auth', '写文件');
  });

  await check('高危能力 + 已显式授权 → allowed', () => {
    is(client.capabilityReview(skill(['mail.send'], 1), true), 'allowed', '授权后放行');
  });

  await check('自报 auth=0 挡不住高危 caps（守卫反证）', () => {
    // 这就是被修掉的那条：渲染层把 auth 写成 0 就能翻过 PLAN 红线。
    is(client.capabilityReview(skill(['browser.navigate', 'fs.write'], 0)), 'needs-auth',
      'caps 含高危时，自报 auth=0 不得让审查放行');
  });

  await check('自报 auth=1 也不能把低风险清单升级成弹窗', () => {
    // 反方向同样不许：auth 不由调用方说了算，否则 UI 可以拿它制造假警告。
    is(client.capabilityReview(skill(['fs.read'], 1)), 'allowed', '低风险不得被自报升级');
  });

  await check('caps 缺失 / 非数组 / 混入非字符串 → 不崩，按可判定的部分审', () => {
    is(client.capabilityReview(skill(undefined, 0)), 'allowed', 'caps 缺失');
    is(client.capabilityReview(skill('mail.send', 0)), 'allowed', 'caps 非数组');
    is(client.capabilityReview(skill([3, null, 'mail.send'], 0)), 'needs-auth', '混入非字符串仍审得出高危');
    is(client.capabilityReview({}, 0), 'allowed', '整个 skill 形状不对也不崩');
  });

  await check('installSkill 在审查未过时先拒，不触网（守卫装在入口上）', async () => {
    // baseUrl 是 127.0.0.1:9（discard 端口，没人应答）：能拿到 needs-auth 结论
    // 就说明拒绝发生在 fetch 之前，而不是下载完再补一句警告。
    const r = await client.installSkill(skill(['mail.send'], 0));
    assert(r && r.ok === false, `未授权的高危技能必须被拒，实际 ${JSON.stringify(r)}`);
    assert(r.review === 'needs-auth', `拒绝理由必须是 needs-auth，实际 ${r.review}`);
    assert(!/下载失败/.test(String(r.reason || '')), `不该走到下载那一步：${r.reason}`);
  });

  await check('发布路径白名单按 realpath 判定：软链指向 skills 外必须被拒（守卫反证）', async () => {
    // setToken 走 safeStorage 加密，必须在 electron 桩下跑，所以这条用子进程探针
    // （与 credentials-verify 的 B2 组同一手法）。断言仍在本文件里。
    const fsx = require('node:fs');
    const oss = require('node:os');
    const { execFileSync } = require('node:child_process');
    const root = fsx.mkdtempSync(path.join(oss.tmpdir(), 'orchdesk-guanji-'));
    const probe = `
      const Module = require('module');
      const path = require('path'), fs = require('fs');
      const ROOT = ${JSON.stringify(root)};
      const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
      const stub = makeElectronStub({ home: ROOT, getPath: (n) => path.join(ROOT, 'stub', String(n)) });
      const orig = Module._load;
      Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
      const { GuanjiClient } = require(${JSON.stringify(path.join(__dirname, 'dist', 'guanji.js'))});
      const dd = require(${JSON.stringify(path.join(__dirname, 'dist', 'data-dir.js'))});
      (async () => {
        const skills = path.join(ROOT, 'skills');
        fs.mkdirSync(skills, { recursive: true });
        const outside = path.join(ROOT, 'id_rsa.copy');
        fs.writeFileSync(outside, 'SECRET-MUST-NOT-LEAVE');
        const link = path.join(skills, 'evil.skill');
        let canLink = true;
        try { fs.symlinkSync(outside, link); } catch { canLink = false; }
        dd.setDataDirResolver(() => ROOT);
        const c = new GuanjiClient('http://127.0.0.1:9');
        const tok = c.setToken('probe-token');
        const out = { tokenOk: tok && tok.ok !== false, canLink };
        if (out.tokenOk && canLink) {
          const r = await c.publishSkill({ slug: 'evil', filePath: link });
          out.linkReason = String((r && r.reason) || '');
          out.linkOk = !!(r && r.ok);
        }
        // 反向保护：真身在 skills 内的普通 .skill 不得被路径门误杀。
        const realPkg = path.join(skills, 'ok.skill');
        fs.writeFileSync(realPkg, 'PK');
        const ok = await c.publishSkill({ slug: 'ok', filePath: realPkg });
        out.realReason = String((ok && ok.reason) || '');
        dd.resetDataDirResolver();
        console.log('PROBE_JSON:' + JSON.stringify(out));
        process.exit(0);
      })().catch((e) => { console.log('ERR:' + (e && e.stack || e)); process.exit(1); });
    `;
    const probeFile = path.join(oss.tmpdir(), `guanji-publish-probe-${Date.now()}.cjs`);
    fsx.writeFileSync(probeFile, probe, 'utf-8');
    let outText = '';
    try {
      outText = execFileSync(process.execPath, [probeFile], { encoding: 'utf-8', timeout: 60000 });
    } catch (err) {
      outText = String((err && err.stdout) || '') + String((err && err.stderr) || '');
    } finally {
      try { fsx.unlinkSync(probeFile); } catch { /* 临时探针 */ }
      try { fsx.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录 */ }
    }
    const m = outText.match(/PROBE_JSON:(\{.*\})/);
    assert(m, `探针未产出结果：\n${outText.slice(0, 400)}`);
    const p = JSON.parse(m[1]);
    assert(p.tokenOk, '探针没能配置 TOKEN（桩的 safeStorage 不可用？）');
    if (p.canLink) {
      assert(!p.linkOk, '软链发布必须被拒');
      assert(/skills 目录内|不可解析/.test(p.linkReason),
        `拒绝必须发生在路径判定而不是上传之后，实际原因：${p.linkReason}`);
      assert(!/上传|凭证|fetch|ECONNREFUSED/i.test(p.linkReason),
        `旧实现（path.resolve 不解析软链）会一路放行到网络层：${p.linkReason}`);
    } else {
      console.log('  NOTE  本机无法创建符号链接，软链那条断言未跑');
    }
    assert(!/必须位于 skills 目录内/.test(p.realReason),
      `合法包被路径门误杀：${p.realReason}`);
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();
