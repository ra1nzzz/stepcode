/**
 * Hub 联调客户端（T-P6-2）的门禁套件。
 *
 * 为什么值得单开一套：hub 的全部对外行为都压在「配对是否还在」这一格上，
 * 而 BUG-058 查明它此前只在单次进程生命周期里成立——handle 不落盘，重启后
 * `paired` 恒 false，磁盘上那把密文既用不了也没有撤销入口。这类「状态在内存里」
 * 的缺陷只能靠「模拟重启再读一次」测出来。
 *
 * electron 用最小替身（safeStorage 的三个方法）；网络全部走假 fetch，
 * 因此这套门禁不需要真的 Hub，也不会真发请求。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.message ? err.message : err));
  }
}

// ---------------------------------------------------------------- electron 替身
// 可逆的「加密」：enc:<明文>，足够让落盘字节与解密路径都可断言。
const electronStub = {
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf-8'),
    decryptString: (b) => {
      const t = b.toString('utf-8');
      if (!t.startsWith('enc:')) throw new Error('坏密文');
      return t.slice(4);
    },
  },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

const hubMod = require('./dist/hub.js');
const { setDataDirResolver } = require('./dist/data-dir.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-hub-'));
setDataDirResolver(() => dataDir);

/** 假网络：记录每次调用，返回可配置的响应。 */
let calls = [];
let nextResponse = { ok: true, status: 200, json: () => ({}) };
global.fetch = async (url, init) => {
  calls.push({ url: String(url), init: init || {} });
  if (nextResponse.throw) throw new Error(nextResponse.throw);
  const body = JSON.stringify(nextResponse.json || {});
  return {
    ok: nextResponse.ok,
    status: nextResponse.status,
    json: async () => JSON.parse(body),
  };
};

function hubFile() {
  return path.join(dataDir, 'hub.json');
}
function resetFile() {
  fs.rmSync(hubFile(), { force: true });
  calls = [];
}

(async () => {
  console.log('== Hub 联调客户端 ==');

  await check('decodeHubConfig：脏形状一律当未配对，合法形状保住 handle 与 agentName', () => {
    assert.equal(hubMod.decodeHubConfig(null), null);
    assert.equal(hubMod.decodeHubConfig('x'), null);
    assert.equal(hubMod.decodeHubConfig({ url: 123, handle: 'h' }), null, 'url 不是字符串就该整条弃');
    assert.equal(hubMod.decodeHubConfig({ url: 'hub.example.com' }), null, '缺协议不接受');
    assert.equal(hubMod.decodeHubConfig({ url: 'http://10.0.0.5:8080' }), null,
      '内网明文地址不当成有效配对（否则 Bearer 走明文送出）');
    const ok = hubMod.decodeHubConfig({ url: 'https://hub.example.com', tokenCipher: 'c', handle: 'h42', agentName: '远程助理' });
    assert.deepEqual(ok, { url: 'https://hub.example.com', tokenCipher: 'c', handle: 'h42', agentName: '远程助理' });
    // 非字符串的可选字段丢弃，而不是带进 fetch 的路径段。
    const dirty = hubMod.decodeHubConfig({ url: 'https://h.example.com', tokenCipher: 'c', handle: 'h', agentName: 7 });
    assert.equal(dirty.agentName, undefined);
    // 回环 http 是显式允许的例外（本地调试）。
    assert.ok(hubMod.decodeHubConfig({ url: 'http://127.0.0.1:8123', tokenCipher: 'c', handle: 'h' }));
    assert.equal(hubMod.decodeHubConfig({ url: 'http://127.0.0.1.evil.test/x', tokenCipher: 'c' }), null,
      '127.0.0.1 前缀型绕过必须被拒');
  });

  await check('pair 的三种拒绝路径不发网络、不落盘', async () => {
    resetFile();
    const c = new hubMod.HubClient();
    const r1 = await c.pair('http://hub.example.com', 'tok');
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /必须为 https/);
    const r2 = await c.pair('https://hub.example.com', '   ');
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /凭据为空/);
    const r3 = await c.pair('http://127.0.0.1.evil.test:8123', 'tok');
    assert.equal(r3.ok, false, '回环前缀型地址不得放行');
    assert.equal(calls.length, 0, '三条拒绝都应发生在发请求之前，实际发了 ' + calls.length);
    assert.equal(fs.existsSync(hubFile()), false, '被拒的配对不该留下配置文件');
  });

  await check('配对成功后 hub.json 只含密文，且 handle 一起落盘', async () => {
    resetFile();
    nextResponse = { ok: true, status: 200, json: { handle: 'h42', agentName: '远程助理' } };
    const c = new hubMod.HubClient();
    const r = await c.pair('https://hub.example.com/', 'sekret-token');
    assert.equal(r.ok, true, '配对应成功：' + r.reason);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hub.example.com/api/pair', '尾部斜杠应被裁掉');
    const raw = fs.readFileSync(hubFile(), 'utf-8');
    assert.equal(raw.includes('sekret-token'), false, '明文凭据绝不能进配置文件');
    assert.equal(raw.includes('enc:sekret-token'), false, '配置里也不该出现可逆替身的痕迹（应是 base64 密文）');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.handle, 'h42', 'handle 不落盘 = 重启后配对失效（BUG-058）');
    assert.equal(parsed.agentName, '远程助理');
    assert.equal(typeof parsed.tokenCipher, 'string');
    assert.equal(parsed.tokenCipher, Buffer.from('enc:sekret-token', 'utf-8').toString('base64'));
  });

  await check('模拟重启：新实例从盘上读回配对，任务请求带回归好的 Bearer 与 handle', async () => {
    resetFile();
    nextResponse = { ok: true, status: 200, json: { handle: 'h42', agentName: '远程助理' } };
    const first = new hubMod.HubClient();
    await first.pair('https://hub.example.com', 'tok2');
    calls = [];
    nextResponse = { ok: true, status: 200, json: { taskId: 't9' } };

    // 全新实例＝进程重启：内存里没有 handle，只有 hub.json。
    const revived = new hubMod.HubClient();
    const st = revived.status();
    assert.equal(st.paired, true, '重启后应仍算已配对（BUG-058 的正题）');
    assert.equal(st.agentName, '远程助理');
    const send = await revived.sendTask('帮我跑一遍测试');
    assert.equal(send.ok, true, '发任务应成功：' + send.reason);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hub.example.com/api/agent/h42/task');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok2',
      '凭据应从密文解密回来，而不是丢掉');
    assert.equal(JSON.parse(calls[0].init.body).text, '帮我跑一遍测试');
  });

  await check('未配对与坏密文都是可读失败，不是崩溃', async () => {
    resetFile();
    const c = new hubMod.HubClient();
    assert.equal(c.status().paired, false);
    assert.equal((await c.sendTask('x')).ok, false, '未配对时发任务必须被拒');
    assert.equal((await c.getResult('t1')).status, 'error', '未配对时取结果必须是 error 而不是抛异常');

    fs.writeFileSync(hubFile(), JSON.stringify({ url: 'https://h.example.com', tokenCipher: '@@@@', handle: 'h' }), 'utf-8');
    const broken = new hubMod.HubClient();
    assert.equal(broken.status().paired, true, '句柄与密文都在就算已配对（能不能用交给网络层判）');
    calls = [];
    nextResponse = { ok: true, status: 200, json: { taskId: 't' } };
    const r = await broken.sendTask('x');
    assert.equal(r.ok, true);
    assert.equal(calls[0].init.headers.Authorization, undefined,
      '解不开密文时不该带一个假的 Bearer 出去');
  });

  fs.rmSync(dataDir, { recursive: true, force: true });
  setDataDirResolver(null);
  console.log('\n结果：通过 ' + passed + ' / 失败 ' + failed);
  process.exit(failed ? 1 : 0);
})();
