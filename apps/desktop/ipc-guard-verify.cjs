/**
 * IPC sender 校验（遗留项① · 纵深防御）验证
 * ----------------------------------------------------------------------------
 * 全仓唯一带 preload 的窗口是主窗（悬浮窗 / 浏览器窗均无 ipcRenderer，发不出
 * invoke），故唯一可信 IPC 调用方 = mainWindow.webContents。main.ts 顶层 patch
 * ipcMain.handle，使 92 个 handler 统一过 sender 门：
 *   - sender == null（进程内直调 / verify stub）        → 放行
 *   - sender === mainWindow.webContents（唯一合法窗）   → 放行
 *   - 其它真实 webContents（第三方 / 未来不可信窗）      → fail-closed 抛错
 *
 * 本套件 stub dist/main.js 驱动真实 handler，逐条验证门的三态 + 「拒绝不静默回
 * 假数据」。
 *
 * 运行：node ipc-guard-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try { await fn(); passed++; log.push(`  PASS  ${name}`); }
  catch (err) { failed++; log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`); }
}

(async () => {
  console.log('\n== IPC sender 校验 ==');

  const probe = runProbe();

  await check('主窗 webContents 调 handler → 放行（返回真实数据）', () => {
    assert.ok(probe.goodOk === true, `主窗 sender 应放行，实际 ${JSON.stringify(probe.goodErr)}`);
    assert.ok(probe.goodValue !== undefined, '主窗 sender 应拿到真实返回值');
  });

  await check('第三方 webContents 调 handler → 拒绝（抛 untrusted-sender，不静默回数据）', () => {
    assert.strictEqual(probe.badOk, false, '非主窗 sender 应被拒绝');
    assert.ok(/untrusted-sender/.test(String(probe.badErr)), `拒绝原因应指向 untrusted-sender，实际 ${probe.badErr}`);
  });

  await check('null sender（进程内直调 / verify stub）→ 放行', () => {
    assert.ok(probe.nullOk === true, `null sender 应放行（测试后门语义），实际 ${JSON.stringify(probe.nullErr)}`);
  });

  await check('主窗 sender 跨 channel 一致放行（门挂在注册层非单点 handler）', () => {
    assert.ok(probe.goodSecond === true, `第二 channel 主窗 sender 也应放行，实际 ${JSON.stringify(probe.goodSecondErr)}`);
  });

  await check('on 通道：不可信 sender 不得应答挂起审批（frame 判据不够）', () => {
    assert.strictEqual(probe.foreignErr, null, `探针调用异常：${probe.foreignErr}`);
    assert.deepStrictEqual(
      probe.foreignAnswered, [],
      `另一扇窗的 sender 不该应答审批，实际应答了 ${JSON.stringify(probe.foreignAnswered)}`,
    );
  });

  await check('on 通道：主窗 sender 仍能正常应答 allowed-once', () => {
    assert.strictEqual(probe.mainErr, null, `探针调用异常：${probe.mainErr}`);
    assert.ok(
      (probe.mainAnswered || []).includes('allowed-once'),
      `主窗应答必须落到 resolve，实际 ${JSON.stringify(probe.mainAnswered)}`,
    );
  });

  await check('on 通道：进程内直调（sender 缺省）保持放行', () => {
    assert.ok(
      (probe.nullAnswered || []).includes('rejected'),
      `null sender 直调应放行（与 handle 层同口径），实际 ${JSON.stringify(probe.nullAnswered)}`,
    );
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();

/**
 * 子进程跑真实主进程（stub electron）。与 memory-promotion-verify.cjs 同套路：
 * stub dist/main.js → 等 bootRuntime + 主窗创建 → 用不同 sender 打真实 handler。
 */
function runProbe() {
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    const APP_DIR = ${JSON.stringify(__dirname)};
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ipcguard-'));
    process.env.ORCHDESK_HOME = HOME;
    const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
    const stub = makeElectronStub({
      home: HOME,
      getPath: (n) => n === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', n),
    });
    const ipc = stub.ipcHandlers;
    const orig = Module._load;
    Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
    require(${JSON.stringify(path.join(__dirname, 'dist', 'main.js'))});

    const out = {};
    (async () => {
      // 等 bootRuntime 完成（handler 注册早于运行时就绪，直接 kick 会竞态）
      for (let i = 0; i < 300; i++) {
        const h = ipc.get('orchdesk:plugin-runtime');
        if (h) {
          const st = await h(null);
          if (st && st.plugins && st.plugins.length >= 9 && st.plugins.every((p) => p.available === false)) break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      // 等主窗创建（app.whenReady().then 里 bootRuntime await 后 createWindow）。
      let mainWin = null;
      for (let i = 0; i < 100 && !mainWin; i++) {
        mainWin = stub.windows.find((w) => w.opts && w.opts.webPreferences && w.opts.webPreferences.preload) || null;
        if (!mainWin) await new Promise((r) => setTimeout(r, 50));
      }
      if (!mainWin) { console.log('ERR: 主窗未创建'); process.exit(1); }

      const call = (ch, sender, ...args) => {
        const handler = ipc.get(ch);
        if (!handler) throw new Error('no handler ' + ch);
        return handler({ sender }, ...args); // 事件对象仅带 sender（门只读 sender）
      };

      // 用无副作用的只读 channel 打门（usage / models-get 均不写盘）
      try { const v = await call('orchdesk:usage', mainWin.webContents); out.goodOk = true; out.goodValue = v; }
      catch (e) { out.goodOk = false; out.goodErr = e && (e.message || String(e)); }

      const thirdParty = new stub.BrowserWindow({}).webContents;
      try { await call('orchdesk:usage', thirdParty); out.badOk = true; }
      catch (e) { out.badOk = false; out.badErr = e && (e.message || String(e)); }

      try { const v = await call('orchdesk:usage', null); out.nullOk = true; out.nullValue = v; }
      catch (e) { out.nullOk = false; out.nullErr = e && (e.message || String(e)); }

      try { await call('orchdesk:models-get', mainWin.webContents); out.goodSecond = true; }
      catch (e) { out.goodSecond = false; out.goodSecondErr = e && (e.message || String(e)); }

      // orchdesk:authz-submit-decision 走 ipcMain.on，handle 层的 sender 门覆盖不到它。
      // 旧判据只比「senderFrame 是不是自己那个 mainFrame」，另一扇带 preload 的合法窗
      // 天然满足，于是能替主窗应答全部挂起审批（含 allowed-once）。
      const az = require(${JSON.stringify(path.join(__dirname, 'dist', 'ipc-authz.js'))});
      const answered = [];
      const mkPending = () => {
        const id = az.nextApprovalId();
        az.pendingApprovals.set(id, { resolve: (o) => answered.push(o), timer: setTimeout(() => {}, 5000) });
        return id;
      };
      const onFire = (sender, id, outcome) => {
        const fn = stub.ipcListeners.get('orchdesk:authz-submit-decision');
        if (!fn) throw new Error('authz on-listener 未注册');
        fn({ sender, senderFrame: sender ? sender.mainFrame : null }, id, outcome);
      };

      const idForeign = mkPending();
      try { onFire(thirdParty, idForeign, 'allowed-once'); out.foreignErr = null; }
      catch (e) { out.foreignErr = String((e && e.message) || e); }
      out.foreignAnswered = answered.slice();

      const idMain = mkPending();
      try { onFire(mainWin.webContents, idMain, 'allowed-once'); out.mainErr = null; }
      catch (e) { out.mainErr = String((e && e.message) || e); }
      out.mainAnswered = answered.slice();

      const idNull = mkPending();
      onFire(null, idNull, 'rejected');
      out.nullAnswered = answered.slice();

      console.log('RESULT_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + (e && e.stack || e)); process.exit(1); });
  `;
  const tmp = path.join(os.tmpdir(), `ipc-guard-probe-${Date.now()}.cjs`);
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
