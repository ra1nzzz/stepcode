/**
 * 官方 CLI 作为可更新核，桌面壳安装必须经过确认。
 * 有本机 step.exe 时只做 initialize / shutdown，不发模型回合。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const core = require('./dist/cli-core.js');
const stdio = require('./dist/cli-stdio.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS ', name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ', name);
    console.log('        ', err && err.message || err);
  }
}

function fakeChild(script) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = {
    stdin: { write(buf) { child._push(buf); } },
    stdout,
    stderr,
    frames: [],
    kill() { this.killed = true; },
    killed: false,
    on(event, cb) { if (event === 'exit') this._exit = cb; },
  };
  child._push = stdio.createFrameDecoder((frame) => {
    child.frames.push(frame);
    script(frame, (out) => stdout.emit('data', stdio.encodeStepFrame(out)));
  });
  return child;
}

check('0.1.1 低于官方 0.1.2', () => {
  assert.equal(core.compareReleaseVersions('0.1.1', '0.1.2'), -1);
  assert.equal(core.compareReleaseVersions('v0.1.2', '0.1.2'), 0);
  assert.equal(core.normalizeReleaseVersion('1.2.3-beta'), null);
});

check('只认独立的 step.exe，不认桌面壳文件名', () => {
  const found = core.locateStandaloneCli(
    ['D:/apps/StepCode Desktop.exe', 'C:/Users/x/.stepcode/bin/step.exe'],
    (p) => p.endsWith('step.exe') || p.endsWith('Desktop.exe'),
  );
  assert.equal(found.replace(/\\/g, '/').endsWith('/.stepcode/bin/step.exe'), true);
  const plan = core.planCliUpdate('D:/apps/StepCode Desktop.exe');
  assert.equal(plan.ok, false);
  const ok = core.planCliUpdate('C:/Users/x/.stepcode/bin/step.exe');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.args, ['update']);
});

check('查询选项带确认回调，没有跳过审批字段', () => {
  assert.equal(core.CLI_QUERY_OPTIONS.permissionMode, 'default');
  assert.equal(core.CLI_QUERY_OPTIONS.hasPermissionCallback, true);
  assert.equal(Object.hasOwn(core.CLI_QUERY_OPTIONS, 'bypassPermissions'), false);
  const src = fs.readFileSync(path.join(__dirname, 'cli-core.ts'), 'utf8')
    + fs.readFileSync(path.join(__dirname, 'cli-stdio.ts'), 'utf8')
    + fs.readFileSync(path.join(__dirname, 'cli-process.ts'), 'utf8');
  assert.equal(src.includes('bypassPermissions'), false);
});

check('桌面壳未确认或不在安装版时不能装', () => {
  assert.equal(core.desktopInstallDecision({ packaged: true, available: true, confirmed: false }).ok, false);
  assert.equal(core.desktopInstallDecision({ packaged: false, available: true, confirmed: true }).ok, false);
  assert.equal(core.desktopInstallDecision({ packaged: true, available: false, confirmed: true }).ok, false);
  assert.equal(core.desktopInstallDecision({ packaged: true, available: true, confirmed: true }).ok, true);
});

check('发布地址必须留在官方通道', () => {
  const bad = core.parseLatestManifest({
    version: '0.1.2',
    packages: { 'windows-x64': 'https://evil.example/step.zip' },
    checksums: { 'windows-x64': 'a'.repeat(64) },
  });
  const artifact = core.officialArtifact(bad, 'windows-x64');
  assert.equal('reason' in artifact, true);
  const good = core.officialArtifact(core.parseLatestManifest({
    version: '0.1.2',
    packages: { 'windows-x64': 'https://static-openapi.stepfun.com/stepcode/0.1.2/step.zip' },
    checksums: { 'windows-x64': 'b'.repeat(64) },
  }), 'windows-x64');
  assert.equal(good.fileName, 'step.zip');
});

async function runAsync() {
  const child = fakeChild((frame, send) => {
    if (frame.method === 'initialize') {
      send({
        protocol: core.CLI_PROTOCOL,
        version: 1,
        kind: 'response',
        replyTo: 'init',
        payload: { selectedProtocol: 1 },
      });
    }
    if (frame.method === 'query.start') {
      assert.equal(frame.payload.options.hasPermissionCallback, true);
      assert.equal(Object.hasOwn(frame.payload.options, 'bypassPermissions'), false);
      send({
        protocol: core.CLI_PROTOCOL,
        version: 1,
        kind: 'request',
        id: 'perm1',
        method: 'permission.request',
        payload: { toolName: 'bash', input: { command: 'rm -rf /' } },
      });
    }
    if (frame.kind === 'response' && frame.replyTo === 'perm1') {
      assert.equal(frame.payload.behavior, 'deny');
      send({
        protocol: core.CLI_PROTOCOL,
        version: 1,
        kind: 'event',
        method: 'query.message',
        payload: { message: { type: 'result', subtype: 'success', result: 'pong' } },
      });
    }
  });
  const result = await stdio.driveCliTurn(child, 'ping', {
    confirm: async () => false,
    timeoutMs: 2000,
  });
  assert.equal(result.text, 'pong');
  assert.equal(result.intent, 'ACT');
}

function liveSmoke() {
  const cli = path.join(os.homedir(), '.stepcode', 'bin', 'step.exe');
  if (!fs.existsSync(cli)) {
    console.log('  SKIP  本机没有官方 CLI，跳过握手');
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['--sdk-stdio', '--no-update-check', '--no-session'], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let done = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('官方 CLI 握手超时'));
    }, 12000);
    const push = stdio.createFrameDecoder((frame) => {
      if (done) return;
      if (frame.kind === 'response' && frame.replyTo === 'init') {
        done = true;
        clearTimeout(timer);
        child.stdin.write(stdio.encodeStepFrame(stdio.requestFrame('bye', 'runtime.shutdown', {})));
        setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(); }, 300);
      }
    });
    child.stdout.on('data', push);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.write(stdio.encodeStepFrame(stdio.requestFrame('init', 'initialize', { protocolRange: { min: 1, max: 1 } })));
  });
}

(async () => {
  console.log('== CLI 核与桌面壳更新 ==');
  try {
    await runAsync();
    passed += 1;
    console.log('  PASS  假 CLI 拒绝危险命令后仍能结束回合');
  } catch (err) {
    failed += 1;
    console.log('  FAIL  假 CLI 拒绝危险命令后仍能结束回合');
    console.log('        ', err && err.stack || err);
  }
  try {
    await liveSmoke();
    passed += 1;
    console.log('  PASS  本机官方 CLI 能完成协议握手');
  } catch (err) {
    failed += 1;
    console.log('  FAIL  本机官方 CLI 能完成协议握手');
    console.log('        ', err && err.message || err);
  }
  console.log(failed ? `FAIL ${failed}` : `PASS ${passed}`);
  process.exit(failed ? 1 : 0);
})();
