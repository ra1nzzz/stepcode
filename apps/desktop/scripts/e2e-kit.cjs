/**
 * E2E Harness 工具库（与 scripts/verify-kit.cjs 对偶：一个服务 node 直驱套件，
 * 一个服务 Playwright 套件）。收敛四类原语，避免每个浏览器套件重抄一遍：
 *   1. pageerror fail-fast：渲染层未捕获异常立即置退出码（固定 sleep 模式会让
 *      JS 报错只在对应断言失败时间接可见，CI 上表现为「慢机器 flaky」）
 *   2. 条件等待：waitForVisible / waitForCount，替代固定 sleep
 *   3. 断言收集：check / assert + 汇总（退出码 = failed>0 || failFast）
 *   4. page 构造：chromium.launch + newPage 一把完成
 */
const { chromium } = require('playwright');

async function makeE2EHarness(opts = {}) {
  const browser = await chromium.launch({ headless: opts.headless !== false });
  const page = await browser.newPage();
  const state = { passed: 0, failed: 0, failFast: false, lines: [] };

  page.on('pageerror', (err) => {
    console.error('  ❌ [pageerror]', err.message);
    state.failFast = true;
    process.exitCode = 1;
  });

  async function waitForCount(sel, n, timeout = 6000) {
    await page.waitForFunction(([a, b]) => document.querySelectorAll(a).length >= b, [sel, n], { timeout });
  }
  async function waitForVisible(sel, timeout = 6000) {
    await page.waitForFunction((a) => !!document.querySelector(a), sel, { timeout });
  }
  async function waitForHidden(sel, timeout = 6000) {
    await page.waitForFunction((a) => !document.querySelector(a), sel, { timeout });
  }

  /** 布尔断言（同步条件）。 */
  function assert(condition, name) {
    if (condition) { state.passed++; state.lines.push(`  ✅ PASS: ${name}`); }
    else { state.failed++; state.lines.push(`  ❌ FAIL: ${name}`); }
  }
  /** 异步断言：fn 抛错即失败（错误消息进 FAIL 行）。 */
  async function check(name, fn) {
    try { await fn(); state.passed++; state.lines.push(`  ✅ PASS: ${name}`); }
    catch (err) { state.failed++; state.lines.push(`  ❌ FAIL: ${name} (${(err && err.message || err).toString().slice(0, 120)})`); }
  }
  function summary(label = 'E2E') {
    console.log('\n' + state.lines.join('\n'));
    console.log(`\n📊 结果: ${state.passed} 通过, ${state.failed} 失败, 共 ${state.passed + state.failed} 项\n`);
    const bad = state.failed > 0 || state.failFast;
    console.log(bad ? '❌ 有验证失败，请检查上述 FAIL 项。' : `✅ ${label}全部验证通过！`);
    return !bad;
  }

  return { browser, page, state, waitForCount, waitForVisible, waitForHidden, assert, check, summary };
}

module.exports = { makeE2EHarness };
