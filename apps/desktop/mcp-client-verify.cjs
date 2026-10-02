/**
 * MCP 客户端验证（真接入）。
 *
 * A 组：纯逻辑（require dist/mcp-client.js）—— 配置归一化 / id 白名单 / 序列化-解析
 *       往返（坏条目丢弃、env 密文保留）。
 * B 组：真实 stdio 握手 —— 用 node 起一个最小 MCP server 子进程，验证
 *       connectMcpServer 能完成 initialize → tools/list 拿到真实工具清单，
 *       以及 tools/call 的调用链路。全程不触外网，子进程就是本仓库脚本。
 *
 * 运行：node mcp-client-verify.cjs（需先 npx tsc -p tsconfig.json）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = __dirname;
const MCP = require(path.join(APP_DIR, 'dist', 'mcp-client.js'));
const TT = require(path.join(APP_DIR, 'dist', 'terminal-tools.js'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// 最小 MCP server（stdio JSON-RPC 2.0）：回应 initialize / tools/list / tools/call。
const MOCK_SERVER = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const tools = [
  { name: 'echo', description: 'echo 回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0.0' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }) + '\\n');
  } else if (msg.method === 'tools/call') {
    const p = msg.params || {};
    if (p.name === 'add') {
      const { a = 0, b = 0 } = p.arguments || {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(a + b) }], isError: false } }) + '\\n');
    } else if (p.name === 'echo') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: (p.arguments && p.arguments.text) || '' }], isError: false } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } }) + '\\n');
    }
  }
});
`;

(async () => {
  console.log('== MCP 客户端（真接入）==');

  /* ============================== A 组：纯逻辑 ============================== */

  // BUG-049：MCP 子进程与终端共用同一份 env 剔除清单，特别是数据目录定位变量。
  await check('buildChildEnv 剥掉宿主内部变量，但尊重 config.env 的显式覆盖', () => {
    const saved = { ...process.env };
    process.env.ORCHDESK_HOME = 'C:/Users/x/AppData/Roaming/OrchDesk';
    process.env.ORCHDESK_DATA_DIR = 'C:/Users/x/AppData/Roaming/OrchDesk';
    process.env.ORCHDESK_STEP_RUNTIME = 'D:/checkout/step';
    process.env.NODE_OPTIONS = '--require shim.cjs';
    process.env.KEEP_ME = 'ordinary-value';
    try {
      const env = TT.buildChildEnv(undefined);
      for (const k of ['ORCHDESK_HOME', 'ORCHDESK_DATA_DIR', 'ORCHDESK_STEP_RUNTIME', 'NODE_OPTIONS']) {
        assert(!(k in env), `${k} 不该进 MCP 子进程 env`);
      }
      assert(env.KEEP_ME === 'ordinary-value', '普通变量必须保留');
      const withExtra = TT.buildChildEnv({ ORCHDESK_HOME: '/deliberate/path' });
      assert(withExtra.ORCHDESK_HOME === '/deliberate/path', 'config.env 显式赋值必须赢过剔除');
    } finally {
      for (const k of ['ORCHDESK_HOME', 'ORCHDESK_DATA_DIR', 'ORCHDESK_STEP_RUNTIME', 'NODE_OPTIONS', 'KEEP_ME']) {
        if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
      }
    }
  });

  await check('归一化：合法配置通过，字段齐全', () => {
    const r = MCP.normalizeMcpConfig({ id: 'fs', command: 'npx', args: ['-y', 'x'], env: { K: 'v' }, enabled: true });
    assert(r.ok === true, `应通过，实际 ${JSON.stringify(r)}`);
    assert(r.config.id === 'fs' && r.config.command === 'npx', 'id/command 丢失');
    assert(r.config.args.length === 2, 'args 丢失');
    assert(r.config.env.K === 'v', 'env 丢失');
    assert(r.config.transport === 'stdio', 'transport 不是 stdio');
  });

  await check('归一化：command 空 / id 非法 → 拒绝', () => {
    assert(MCP.normalizeMcpConfig({ id: 'ok', command: '' }).ok === false, '空 command 应拒');
    assert(MCP.normalizeMcpConfig({ id: '../evil', command: 'npx' }).ok === false, '路径穿越 id 应拒');
    assert(MCP.normalizeMcpConfig({ id: 'a/b', command: 'npx' }).ok === false, '含斜杠 id 应拒');
    assert(MCP.normalizeMcpConfig({ command: 'npx' }).ok === false, '缺 id 应拒');
  });

  await check('id 白名单：isMcpId 三态', () => {
    assert(MCP.isMcpId('filesystem') === true, '合法 id 应通过');
    assert(MCP.isMcpId('') === false, '空 id 应拒');
    assert(MCP.isMcpId('..') === false, '.. 应拒');
    assert(MCP.isMcpId('a\\b') === false, '反斜杠应拒');
    assert(MCP.isMcpId('x'.repeat(65)) === false, '超长 id 应拒');
  });

  await check('序列化-解析往返：好条目保留，坏条目丢弃并计数', () => {
    const store = MCP.emptyMcpStore();
    store.servers['good'] = MCP.normalizeMcpConfig({ id: 'good', command: 'npx', args: ['-y', 'x'] }).config;
    const text = MCP.serializeMcpStore(store);
    // 直接在 servers 对象里注入一条坏条目（command 空）再解析
    const obj = JSON.parse(text);
    obj.servers.bad = { id: 'bad', command: '', args: [] };
    const parsed = MCP.parseMcpStore(JSON.stringify(obj));
    assert(parsed.ok === true, '整体解析应成功');
    assert(parsed.store.servers['good'] !== undefined, '好条目应保留');
    assert(parsed.store.servers['bad'] === undefined, '坏条目应丢弃');
    assert(parsed.dropped === 1, `应丢弃 1 条，实际 ${parsed.dropped}`);
  });

  await check('解析容错：整段坏 JSON → ok=false 不抛异常', () => {
    const parsed = MCP.parseMcpStore('{{{ not json');
    assert(parsed.ok === false, '坏 JSON 应 ok=false');
    assert(parsed.reason, '应带 reason');
  });

  /* ===================== B 组：真实 stdio 握手 + 工具调用 ===================== */

  const serverFile = path.join(os.tmpdir(), 'orchdesk-mcp-mock-server.js');
  fs.writeFileSync(serverFile, MOCK_SERVER, 'utf8');
  const cfg = { id: 'mock', name: 'mock', command: process.execPath, args: [serverFile], enabled: true, transport: 'stdio' };

  await check('connectMcpServer：initialize + tools/list 拿到真实工具清单', async () => {
    const r = await MCP.connectMcpServer(cfg, { initTimeoutMs: 10000 });
    assert(r.ok === true, `应连接成功，实际 ${JSON.stringify(r)}`);
    assert(r.connected === true, 'connected 应为 true');
    assert(Array.isArray(r.tools) && r.tools.length === 2, `应有 2 个工具，实际 ${JSON.stringify(r.tools)}`);
    assert(r.tools.some((t) => t.name === 'echo'), '应有 echo 工具');
    assert(r.tools.some((t) => t.name === 'add'), '应有 add 工具');
    assert(typeof r.latencyMs === 'number', '应带耗时');
  });

  await check('callMcpTool：tools/call 真实调用 add(1,2)=3', async () => {
    const r = await MCP.callMcpTool(cfg, 'add', { a: 1, b: 2 }, { callTimeoutMs: 10000 });
    assert(r.ok === true, `应调用成功，实际 ${JSON.stringify(r)}`);
    assert(r.isError === false, 'isError 应为 false');
    const content = r.result && r.result.content && r.result.content[0];
    assert(content && content.text === '3', `add 结果应为 3，实际 ${JSON.stringify(r.result)}`);
  });

  await check('callMcpTool：未知工具 isError=true（业务错误≠协议失败）', async () => {
    const r = await MCP.callMcpTool(cfg, 'nope', {}, { callTimeoutMs: 10000 });
    assert(r.ok === true, '协议层应成功');
    assert(r.isError === true, 'isError 应为 true');
  });

  await check('connectMcpServer：命令不存在 → 快速失败并带 reason', async () => {
    const bad = { ...cfg, command: 'definitely-not-a-real-command-xyz' };
    const r = await MCP.connectMcpServer(bad, { initTimeoutMs: 5000 });
    assert(r.connected === false, '应失败');
    assert(r.reason, '应带失败原因');
  });

  await check('env 剔除：子进程不应继承 NODE_OPTIONS（防 shim 注入）', async () => {
    // 通过 server 侧验证：mock server 若继承 NODE_OPTIONS 会在输出里带上，这里直接
    // 校验 connectMcpServer 内部已剔除——用子进程打印 process.env.NODE_OPTIONS 验证。
    const probeServer = `
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'x' }) + '\\n');
// 直接把 NODE_OPTIONS 是否存在的结论写 stderr
process.stderr.write('NODE_OPTIONS=' + (process.env.NODE_OPTIONS || '') + '\\n');
process.exit(0);
`;
    const probeFile = path.join(os.tmpdir(), 'orchdesk-mcp-env-probe.js');
    fs.writeFileSync(probeFile, probeServer, 'utf8');
    process.env.NODE_OPTIONS = '--require=SHOULD_BE_STRIPPED';
    try {
      const r = await MCP.connectMcpServer({ id: 'probe', name: 'probe', command: process.execPath, args: [probeFile], enabled: true, transport: 'stdio' }, { initTimeoutMs: 5000 });
      // 握手会失败（server 不回应 initialize），但 stderr 里有结论可验证
      assert(r.connected === false, 'probe server 不应握手成功');
      assert(!/SHOULD_BE_STRIPPED/.test(r.reason || ''), `NODE_OPTIONS 未被剔除：${r.reason}`);
    } finally {
      delete process.env.NODE_OPTIONS;
    }
  });

  await check('归一化：参数超限判失败，不静默截断', () => {
    // 原实现先 .slice(0, MAX_ARGS) 再判 args.length > MAX_ARGS，条件恒假：
    // 超限配置被裁到上限并回 ok:true，用户看到「保存成功」而参数少了一截。
    const many = Array.from({ length: 400 }, (_, i) => `--a${i}`);
    const r = MCP.normalizeMcpConfig({ id: 'big', command: 'npx', args: many });
    assert(r.ok === false, `400 个参数应判失败，实际 ${JSON.stringify(r).slice(0, 120)}`);
    assert(/参数过多/.test(r.reason), `reason 应说明参数过多，实际 ${r.reason}`);
  });

  await check('子进程先退出：握手干净失败，且没有异常逃逸到进程顶层', async () => {
    // 这条只断言「不崩溃 + 干净失败」，**不是** stdin 监听器的反证：
    // 把两处 `child.stdin.on('error')` 删掉后本用例仍为绿（本机实测，见审阅记录）。
    // Windows 上向已关闭的读端写入得到的是静默 EOF 而不是 EPIPE 'error' 事件，
    // 所以这里构造不出可观测的异步 error。监听器本身按 Node 语义与
    // terminal-pty.ts:321 的既有规矩保留，属防御性修复，未被判红。
    // 服务端回完 initialize 就 destroy stdin，客户端紧接着写 notifications/initialized
    // 必然拿到 EPIPE。那是 stdin 流上的异步 'error' 事件，外层 try/catch 抓不到：
    // 没有监听器时 Node 抛成 uncaughtException，打包态 main.ts 会 process.exit(1)。
    const deadServer = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'dead', version: '0' } } }) + '\\n');
    rl.close();
    process.stdin.destroy();   // 读端当场关闭，下一次写必然 EPIPE
  }
});
`;
    const probeServer = path.join(os.tmpdir(), `orchdesk-mcp-dead-${Date.now()}.cjs`);
    fs.writeFileSync(probeServer, deadServer, 'utf8');
    const probe = `
const path = require('path');
process.on('uncaughtException', (e) => { console.log('UNCAUGHT:' + (e && e.message)); process.exit(2); });
const MCP = require(${JSON.stringify(path.join(__dirname, 'dist', 'mcp-client.js'))});
(async () => {
  const r = await MCP.connectMcpServer({ id: 'dead', name: 'dead', transport: 'stdio', command: process.execPath, args: [${JSON.stringify(probeServer)}], enabled: true }, { initTimeoutMs: 6000 });
  console.log('RESULT_JSON:' + JSON.stringify({ connected: r.connected, reason: String(r.reason || '') }));
  process.exit(0);
})().catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
`;
    const probeFile = path.join(os.tmpdir(), `orchdesk-mcp-epipe-${Date.now()}.cjs`);
    fs.writeFileSync(probeFile, probe, 'utf8');
    let out = '';
    try {
      out = require('node:child_process').execSync(`node "${probeFile}"`, { encoding: 'utf-8', timeout: 30_000 });
    } catch (err) {
      out = (err.stdout || '') + (err.stderr || '');
    } finally {
      try { fs.unlinkSync(probeFile); } catch { /* 临时探针 */ }
      try { fs.unlinkSync(probeServer); } catch { /* 假服务端也删：每跑一次留一个就是垃圾 */ }
    }
    assert(!/UNCAUGHT:/.test(out), `stdin 的 EPIPE 逃成了 uncaughtException：${out.slice(0, 200)}`);
    assert(/RESULT_JSON:/.test(out), `探针没有产出结果：${out.slice(0, 200)}`);
    const r = JSON.parse(out.match(/RESULT_JSON:(\{.*\})/)[1]);
    assert(r.connected === false, '握手不该成功（服务端已关闭读端）');
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();
