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

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();
