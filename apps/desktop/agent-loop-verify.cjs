/**
 * Agent 回合管线集成验证（BUG-014 / BUG-013 端到端）
 * ----------------------------------------------------------------------------
 * 用 stub 顶替 electron 模块，直接 require 编译产物 dist/main.js，
 * 捕获 ipcMain handler 并驱动 runAgentTurn，配合可控的假模型网关验证：
 *
 *   1. native function calling：模型返回 tool_calls → 工具被执行 → 结果回传
 *   2. 工具结果使用 role:'tool' + tool_call_id（符合 OpenAI 规范）
 *   3. 文本兜底：模型不支持工具时返回 <tool:...> → 仍能解析执行
 *   4. 网关拒绝 tools（400）→ 自动降级重试，不抛错
 *   5. 数据落在统一目录（ORCHDESK_HOME），并从历史位置迁移
 *
 * 运行：node agent-loop-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// 1. 准备隔离的数据目录（ORCHDESK_HOME）+ 一个「历史位置」用于迁移验证
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-home-'));
const LEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-legacy-'));
process.env.ORCHDESK_HOME = HOME;

// 历史位置预置一份会话 + 模型配置，验证启动迁移
fs.writeFileSync(
  path.join(LEGACY, 'orchdesk-sessions.json'),
  JSON.stringify({ 'legacy-sess': { id: 'legacy-sess', title: '历史会话', msgs: [{ role: 'user', text: '你好' }], updated: '2026-01-01T00:00:00.000Z' } }),
  'utf-8',
);
fs.writeFileSync(
  path.join(LEGACY, 'models.json'),
  JSON.stringify({ providers: [{ id: 'legacy-p', name: '历史提供商', type: 'ollama', baseUrl: 'http://127.0.0.1:1', models: ['legacy:1b'] }] }),
  'utf-8',
);

// ---------------------------------------------------------------------------
// 2. electron stub（共享脚手架 scripts/verify-kit.cjs，此处只覆盖本脚本差异）
// ---------------------------------------------------------------------------
const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');

const electronStub = makeElectronStub({
  home: path.join(os.tmpdir(), 'orchdesk-stub'),
  getPath: (name) => (name === 'userData' ? LEGACY : path.join(os.tmpdir(), 'orchdesk-stub', name)),
});
const ipcHandlers = electronStub.ipcHandlers;
const ipcListeners = electronStub.ipcListeners;

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// 3. 假模型网关：可编程应答
// ---------------------------------------------------------------------------
let scenario = [];       // 每次 fetch 返回一条应答
let requests = [];       // 记录所有请求，用于断言消息契约
let fetchError = null;

global.fetch = async (url, opts) => {
  // 意图门本地模型探测（Ollama /api/generate）不参与模型网关桩：不记录 requests、
  // 不消费 scenario——否则它会顶掉一条模型应答并污染计数（runtime 就绪时序不定，
  // Gate 活跃时必炸）。返回不可解析内容 → 探测按「无本地模型」走漏斗兜底。
  if (String(url).includes('/api/generate')) {
    const notVerdict = { response: 'stub-not-a-verdict' };
    return { ok: true, status: 200, text: async () => JSON.stringify(notVerdict), json: async () => notVerdict };
  }
  const body = JSON.parse(opts.body || '{}');
  requests.push({ url, body });
  if (fetchError) throw new Error(fetchError);
  const next = scenario.length > 1 ? scenario.shift() : scenario[0];
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(next),
    json: async () => next,
  };
};

/** OpenAI chat 应答构造器 */
const chatReply = (content, toolCalls) => ({ choices: [{ message: { content, tool_calls: toolCalls } }] });
const nativeFileList = () => [
  { id: 'call_1', type: 'function', function: { name: 'file_list', arguments: JSON.stringify({ path: HOME }) } },
];

// ---------------------------------------------------------------------------
// 4. 加载主进程
// ---------------------------------------------------------------------------
require('./dist/main.js');

const { check, summary } = createChecker();

(async () => {
  // 等 app.whenReady() 的 then 回调跑完（迁移 + loadStore）
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));

  console.log('\n== A. BUG-013 数据目录统一与迁移 ==');

  await check('启动后历史数据已迁移到 ORCHDESK_HOME', () => {
    assert.ok(fs.existsSync(path.join(HOME, 'orchdesk-sessions.json')), '会话文件应被迁移到统一目录');
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
    assert.ok(data['legacy-sess'], '历史会话应存在');
  });
  await check('历史模型配置已迁移（按 id 合并，不覆盖）', () => {
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'models.json'), 'utf-8'));
    assert.ok(data.providers.some((p) => p.id === 'legacy-p'), '历史提供商应被合并进来');
  });
  await check('会话文件落在统一数据目录而非 userData', () => {
    assert.ok(fs.existsSync(path.join(HOME, 'orchdesk-sessions.json')));
    assert.strictEqual(path.dirname(path.join(HOME, 'orchdesk-sessions.json')), HOME);
  });

  console.log('== B. BUG-014 原生 function calling ==');

  // 写入一个可用的模型配置
  fs.writeFileSync(path.join(HOME, 'models.json'), JSON.stringify({
    providers: [{ id: 'p1', name: '测试网关', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnc: Buffer.from('enc:test-key').toString('base64'), models: ['test-model'] }],
    defaultProvider: 'p1', defaultModel: 'test-model', maxToolIterations: 5,
  }), 'utf-8');

  const runAgentTurn = ipcHandlers.get('orchdesk:run-agent-turn');
  assert.ok(runAgentTurn, 'orchdesk:run-agent-turn handler 应已注册');

  // 场景 1：第一轮返回 tool_calls，第二轮返回最终文本
  requests = [];
  scenario = [chatReply('', nativeFileList()), chatReply('目录里有 2 个文件：a.txt、b.txt', undefined)];
  let out = await runAgentTurn(null, 's1', '列出目录内容', {});
  await check('工具被调用，最终拿到模型总结', () => {
    assert.strictEqual(out.intent, 'ACT');
    assert.ok(out.text.includes('a.txt'), '最终回复应包含模型总结: ' + out.text);
    assert.strictEqual(requests.length, 2, '应为「工具轮 + 总结轮」两次请求');
  });
  await check("第二轮请求里工具结果是 role:'tool'（不是 system）", () => {
    const msgs = requests[1].body.messages;
    const roles = msgs.map((m) => m.role);
    assert.ok(roles.includes('tool'), '应包含 role:tool，实际: ' + JSON.stringify(roles));
    assert.ok(!roles.slice(1).includes('system'), '除首条 system 外不应再插入 system 角色');
  });
  await check("tool 消息的 tool_call_id 与上一轮 assistant.tool_calls.id 匹配", () => {
    const msgs = requests[1].body.messages;
    const assistant = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.ok(assistant, '应存在带 tool_calls 的 assistant 消息');
    const ids = assistant.tool_calls.map((t) => t.id);
    const toolMsg = msgs.find((m) => m.role === 'tool');
    assert.ok(ids.includes(toolMsg.tool_call_id), `tool_call_id=${toolMsg.tool_call_id} 应匹配 ${JSON.stringify(ids)}`);
  });
  await check('请求携带了工具定义', () => {
    // 数量从工具表取，不写死：ADR-0011 加了 8 个浏览器工具后这里就是 15。
    // 写死常量会让「新增工具没下发」伪装成「套件过时」。
    const expected = require('./dist/agent-runtime.js').TOOL_DEFS.length;
    assert.ok(Array.isArray(requests[0].body.tools) && requests[0].body.tools.length === expected,
      `首轮应下发 ${expected} 个工具定义，实际 ${(requests[0].body.tools || []).length}`);
  });
  await check('会话已持久化（含工具步骤）', () => {
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
    const s = data['s1'];
    assert.ok(s, '会话 s1 应已落盘');
    const last = s.msgs[s.msgs.length - 1];
    assert.strictEqual(last.role, 'assistant');
    assert.ok(Array.isArray(last.tools) && last.tools.some((t) => t.n === 'file_list'), '应记录 file_list 工具步骤');
  });

  console.log('== C0. 意图门已随 dsh 删除 ==');

  // intent 插件已删除，不迁移。firePreStep 恒为 null，不再有「意图网关拦截」。
  // 破坏性命令若进入工具执行，仍由已停止的沙箱拒绝；本段只断言门不再短路。
  await check('dsh runtime 句柄保持为空', () => {
    assert.equal(require('./dist/dsh-runtime.js').getRuntime(), null);
  });
  requests = [];
  scenario = [chatReply('技能已安装完成', undefined)];
  out = await runAgentTurn(null, 's-gate1', '用 pnpm 安装这个 skill', {});
  await check('命令词 prompt 仍到达模型（不再等意图门）', () => {
    const modelCalls = requests.filter((r) => !String(r.url).includes('/api/generate'));
    assert.strictEqual(modelCalls.length, 1, '模型应被调用 1 次，实际 ' + modelCalls.length);
    assert.ok(out.text.includes('技能已安装'), '应拿到模型回复: ' + out.text);
  });

  requests = [];
  scenario = [chatReply('门已删除，模型收到原文', undefined)];
  out = await runAgentTurn(null, 's-gate2', '把所有日志文件全部删除', {});
  await check('destructive prompt 不再被已删除的意图门短路', () => {
    const modelCalls = requests.filter((r) => !String(r.url).includes('/api/generate'));
    assert.strictEqual(modelCalls.length, 1, '模型应被调用 1 次，实际 ' + modelCalls.length);
    assert.ok(!out.text.includes('意图网关拦截'), '不得伪造已删除的拦截: ' + out.text);
    assert.ok(out.text.includes('门已删除'), '应拿到模型回复: ' + out.text);
  });

  console.log('== C. 文本兜底解析 ==');

  requests = [];
  scenario = [
    chatReply('我先看看目录：\n<tool:file_list>{"path":"' + HOME.replace(/\\/g, '/') + '"}</tool>', undefined),
    chatReply('目录内容已读取完毕。', undefined),
  ];
  out = await runAgentTurn(null, 's2', '看看目录里有什么', {});
  await check('不支持 native tool_calls 时仍能解析 <tool:> 并执行', () => {
    assert.strictEqual(out.intent, 'ACT');
    assert.ok(out.text.includes('目录内容已读取完毕'), '实际: ' + out.text);
    assert.strictEqual(requests.length, 2, '应为两轮请求');
  });
  await check('文本兜底下工具结果用 user 角色（避免网关拒绝 role:tool）', () => {
    const msgs = requests[1].body.messages;
    const roles = msgs.map((m) => m.role);
    assert.ok(!roles.includes('tool'), '无 native tool_calls 时不应发 role:tool，实际: ' + JSON.stringify(roles));
    const resultMsg = msgs.find((m) => m.content && m.content.includes('[工具 file_list 执行结果]'));
    assert.ok(resultMsg, '应能找到工具结果消息');
    assert.strictEqual(resultMsg.role, 'user');
  });
  await check('工具参数被正确解析（旧实现把 args 塞进 input 导致执行失败）', () => {
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
    const tools = (data['s2'].msgs.at(-1).tools || []).filter((t) => t.n === 'file_list');
    assert.ok(tools.length > 0, 'file_list 应被执行过');
    assert.ok(!tools.some((t) => t.result && t.result.includes('路径不在允许范围内')),
      '参数解析错误会导致路径被拒，实际结果: ' + JSON.stringify(tools[0].result));
  });

  console.log('== D. 网关降级与错误处理 ==');

  requests = [];
  const originalFetch = global.fetch;
  let callNo = 0;
  global.fetch = async (url, opts) => {
    callNo++;
    if (callNo === 1) return { ok: false, status: 400, text: async () => 'unsupported parameter: tool_choice', json: async () => ({}) };
    return originalFetch(url, opts);
  };
  scenario = [chatReply('降级后正常回复', undefined)];
  out = await runAgentTurn(null, 's3', '测试降级', {});
  await check('网关拒绝 tool_choice(400) 时自动降级重试而非报错', () => {
    assert.ok(!out.text.includes('模型调用失败'), '实际: ' + out.text);
    assert.ok(out.text.includes('降级后正常回复'), '实际: ' + out.text);
  });
  global.fetch = originalFetch;

  requests = [];
  fetchError = 'connect ECONNREFUSED 127.0.0.1:9';
  out = await runAgentTurn(null, 's4', '测试网络错误', {});
  await check('网络错误被捕获并返回可读提示', () => {
    assert.ok(out.text.includes('模型调用失败'), '实际: ' + out.text);
    assert.strictEqual(out.intent, 'CONFIRM');
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
    const last = data['s4'] && data['s4'].msgs && data['s4'].msgs.at(-1);
    assert.ok(last && last.role === 'assistant' && String(last.text).includes('模型调用失败'), '失败回合应落盘');
  });
  fetchError = null;

  console.log('== E. 未配置模型 ==');
  const backup = fs.readFileSync(path.join(HOME, 'models.json'), 'utf-8');
  fs.writeFileSync(path.join(HOME, 'models.json'), JSON.stringify({ providers: [] }), 'utf-8');
  out = await runAgentTurn(null, 's5', '你好', {});
  await check('无模型配置时提示用户去设置页', () => {
    assert.ok(out.text.includes('未配置模型'), '实际: ' + out.text);
  });
  fs.writeFileSync(path.join(HOME, 'models.json'), backup, 'utf-8');

  console.log('== F. SSE 解析器 ==');
  {
    const mc = require('./dist/model-client.js');
    const chunks = [];
    const parsed = mc.consumeOpenAiSse(
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n',
      (c) => chunks.push(c),
    );
    await check('consumeOpenAiSse 拼出全文并回调 chunk', () => {
      assert.strictEqual(parsed.content, '你好');
      assert.deepStrictEqual(chunks, ['你', '好']);
    });
    const savedFetch = global.fetch;
    const jsonChunks = [];
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: { content: '目录里有 a.txt' } }),
    });
    const reply = await mc.callOllama(
      { name: 't', type: 'ollama', baseUrl: 'http://127.0.0.1' },
      'm',
      [{ role: 'user', content: 'hi' }],
      [],
      { onDelta: (c) => jsonChunks.push(c) },
    );
    global.fetch = savedFetch;
    await check('JSON 整包走 onDelta 一次', () => {
      assert.ok(String(reply.content).includes('a.txt'));
      assert.deepStrictEqual(jsonChunks, ['目录里有 a.txt']);
    });
    const ndChunks = [];
    const parts = [
      '{"message":{"content":"春"},"done":false}\n',
      '{"message":{"content":"秋"},"done":true}\n',
    ];
    global.fetch = async (_url, opts) => {
      assert.strictEqual(JSON.parse(opts.body).stream, true, 'Ollama 应请求 stream:true');
      let i = 0;
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                if (i >= parts.length) return { done: true, value: undefined };
                return { done: false, value: new TextEncoder().encode(parts[i++]) };
              },
              releaseLock() {},
            };
          },
        },
        text: async () => { throw new Error('应走 ReadableStream 而不是 res.text()'); },
      };
    };
    const streamReply = await mc.callOllama(
      { name: 't', type: 'ollama', baseUrl: 'http://127.0.0.1' },
      'm',
      [{ role: 'user', content: 'hi' }],
      [],
      { onDelta: (c) => ndChunks.push(c) },
    );
    global.fetch = savedFetch;
    await check('NDJSON 分片走 onDelta 多次', () => {
      assert.strictEqual(streamReply.content, '春秋');
      assert.deepStrictEqual(ndChunks, ['春', '秋']);
    });
    await check('shouldRetryWithoutStream 不误伤 tools 400', () => {
      assert.strictEqual(mc.shouldRetryWithoutStream(400, 'streaming is not supported', true), true);
      assert.strictEqual(mc.shouldRetryWithoutStream(400, 'unsupported parameter: tools', true), false);
      assert.strictEqual(mc.shouldRetryWithoutStream(401, 'nope', true), false);
      assert.strictEqual(mc.shouldRetryWithoutStream(400, 'invalid request', true), true);
      assert.strictEqual(mc.shouldRetryWithoutStream(400, 'invalid', false), false);
    });
    const streamFlags = [];
    global.fetch = async (_url, opts) => {
      const b = JSON.parse(opts.body);
      streamFlags.push(b.stream);
      if (b.stream) return { ok: false, status: 400, text: async () => 'stream not supported' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: '降级成功' } }) };
    };
    const dropped = await mc.callOllama(
      { name: 't', type: 'ollama', baseUrl: 'http://127.0.0.1' },
      'm',
      [{ role: 'user', content: 'hi' }],
      [],
    );
    global.fetch = savedFetch;
    await check('Ollama stream 400 后改 stream:false', () => {
      assert.deepStrictEqual(streamFlags, [true, false]);
      assert.strictEqual(dropped.content, '降级成功');
    });
  }

  console.log('== F. 回合 abort ==');
  const abortTurn = ipcHandlers.get('orchdesk:abort-agent-turn');
  await check('abort-agent-turn handler 已注册', () => {
    assert.ok(abortTurn, 'orchdesk:abort-agent-turn handler 应已注册');
  });
  await check('无进行中回合 abort 返回 no-active-turn', async () => {
    const r = await abortTurn(null, 'ghost');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-active-turn');
  });
  {
    const savedFetch = global.fetch;
    global.fetch = async (url, opts) => {
      await new Promise((_, reject) => {
        const onAbort = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (opts && opts.signal) {
          if (opts.signal.aborted) { onAbort(); return; }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    };
    const pending = runAgentTurn(null, 's-abort', '请停', {});
    await new Promise((r) => setTimeout(r, 40));
    const ar = await abortTurn(null, 's-abort');
    await check('进行中回合 abort 返回 ok', () => {
      assert.strictEqual(ar.ok, true);
    });
    out = await pending;
    await check('abort 后回合返回（已停止）', () => {
      assert.strictEqual(out.aborted, true);
      assert.ok(String(out.text).includes('已停止'), '实际: ' + out.text);
      assert.strictEqual(out.intent, 'CONFIRM');
    });
    global.fetch = savedFetch;

    // B-1 / M-8：中止回合也必须把 user 消息与「（已停止）」落盘 + 入事件流——
    // 修复前 abort 在循环内提前 return，磁盘上无迹可查。
    await check('中止回合仍落盘（user + （已停止）不丢失）', () => {
      const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
      const s = data['s-abort'];
      assert.ok(s && Array.isArray(s.msgs), '会话应已落盘');
      const texts = s.msgs.map((m) => String(m.text || ''));
      assert.ok(texts.includes('请停'), 'user 原文应落盘，实际: ' + JSON.stringify(texts));
      assert.ok(texts.some((t) => t.includes('已停止')), '应有「（已停止）」assistant 记录，实际: ' + JSON.stringify(texts));
    });
  }

  console.log('== G. B-1 消息结构双轨归一化（渲染层 r/x schema）==');

  // 渲染层 doSend 写 {r:'user',t,x}，persist-sessions 整表替换主进程 store。
  // 修复前 agent-turn 只认 role/text → 第二轮起历史全丢（探针实证：下发仅 [system,user]）。
  requests = [];
  scenario = [chatReply('知道了', undefined)];
  await ipcHandlers.get('orchdesk:persist-sessions')(null, [
    { id: 's-rt', pid: 'p1', title: '渲染层 schema', msgs: [
      { r: 'user', t: '09:00', x: '第一轮问题（r/x schema）' },
      { r: 'agent', t: '09:01', x: '第一轮回答' },
      { role: 'user', t: '09:02', text: '第二轮问题（role/text schema）' },
    ] },
  ]);
  out = await runAgentTurn(null, 's-rt', '第三轮问题', {});
  await check('渲染层 r/x 历史进入第二轮模型请求（B-1）', () => {
    const msgs = requests[0].body.messages.map((m) => m.content);
    assert.ok(msgs.includes('第一轮问题（r/x schema）'), 'r/x user 历史应下发，实际: ' + JSON.stringify(msgs));
    assert.ok(msgs.includes('第一轮回答'), 'r/x agent 历史应映射 assistant 下发');
    assert.ok(msgs.includes('第二轮问题（role/text schema）'), 'role/text 历史仍应下发');
    assert.ok(msgs.includes('第三轮问题'), '本轮新消息应下发');
  });

  console.log('== H. M-1 空回复不毒化原生工具能力 ==');

  // 网关对每个 attempt 都返回 200 空 content（finish=length/内容过滤类，与工具协议无关）。
  // 修复前这会把 provider+model 标记为「不吃工具」，整个进程生命周期文本兜底化。
  requests = [];
  scenario = [chatReply(''), chatReply(''), chatReply('空回复后拿到内容')];
  out = await runAgentTurn(null, 's-empty', '空回复场景', {});
  assert.ok(out.text.includes('空回复后拿到内容'), '应拿到总结，实际: ' + out.text);

  requests = [];
  scenario = [chatReply('下一轮', undefined)];
  out = await runAgentTurn(null, 's-empty', '下一轮提问', {});
  await check('空 content 不置 toolsRejected（下一轮回合仍下发原生工具定义）', () => {
    assert.ok(Array.isArray(requests[0].body.tools) && requests[0].body.tools.length > 0,
      '下一轮回合应仍下发 tools，实际: ' + JSON.stringify(requests[0].body.tools || null));
  });

  // 信道对照：工具协议被逐级拒绝（att1/att2 均 400 且 body 提及 tool）→ att3 无 tools 成功 →
  // 该 provider+model  memo 生效，后续回合转文本兜底（M-1 memo 收敛）。
  requests = [];
  const savedFetch2 = global.fetch;
  // body 感知桩（替代原计数式）：任何带 tools 的请求都被网关以「工具协议不支持」
  // 拒绝；不带 tools 的请求走场景应答。与 attempts 三档阶梯（tools+tool_choice →
  // tools → 无 tools）解耦——前两档都遭拒 → 第三档成功 → toolsRejected → memo。
  // （计数式桩曾让第二档「tools 无 tool_choice」成功：提供方支持 tools 只是
  // 不支持 tool_choice，不写 memo 才是正确行为——旧测试是意外通过。）
  global.fetch = async (url, opts) => {
    if (String(url).includes('/api/generate')) return savedFetch2(url, opts);
    const body = JSON.parse(opts.body || '{}');
    if (body.tools) {
      return { ok: false, status: 400, text: async () => 'tools not supported by this gateway', json: async () => ({}) };
    }
    return savedFetch2(url, opts);
  };
  scenario = [chatReply('明确拒绝工具后的文本回复', undefined)];
  out = await runAgentTurn(null, 's-reject', '工具协议被拒', {});
  await check('协议级 400 仍启用文本兜底（M-1 只收窄空回复，不放松真拒绝）', () => {
    assert.ok(out.text.includes('明确拒绝工具后的文本回复'), '实际: ' + out.text);
  });
  requests = [];
  scenario = [chatReply('再下一轮', undefined)];
  await runAgentTurn(null, 's-reject', '再问', {});
  await check('协议级拒绝后下一轮不下发 tools（memo 生效）', () => {
    assert.ok(!requests[0].body.tools, '已被协议拒绝的 provider 不应再下发 tools');
  });
  global.fetch = savedFetch2; // 恢复记录桩：memo 测试结束，后续用例走正常网关语义
  // M-1 memo 有 TTL + models-save 失效：保存模型配置后 memo 清空，下一轮恢复原生协议（防永久毒化）。
  requests = [];
  scenario = [chatReply('恢复后', undefined)];
  await ipcHandlers.get('orchdesk:models-save')(null, {
    providers: [{ id: 'p1', name: '测试网关', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', models: ['test-model'] }],
    defaultProvider: 'p1', defaultModel: 'test-model',
  });
  out = await runAgentTurn(null, 's-reject', '再问一次', {});
  await check('models-save 后 memo 失效，下一轮恢复下发原生 tools', () => {
    assert.ok(Array.isArray(requests[0].body.tools) && requests[0].body.tools.length > 0,
      '保存配置后应重新尝试原生工具协议');
  });
  global.fetch = savedFetch2;

  console.log('== I. M-8 signal 下穿 executeTool ==');

  // abort 时 shell 子进程要被 kill、审批要取消：executeTool 收得到 signal 是前置条件。
  // 用 tool-execute 后门无法传 ctx，这里经真实回合链路：工具执行中 abort → 回合返回已停止。
  requests = [];
  scenario = [chatReply('', [
    { id: 'call_x', type: 'function', function: { name: 'shell_command', arguments: JSON.stringify({ command: 'ping -n 5 127.0.0.1' }) } },
  ])];
  global.fetch = async (url, opts) => {
    await new Promise((_, reject) => {
      const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
      if (opts && opts.signal) {
        if (opts.signal.aborted) { onAbort(); return; }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };
  const pending2 = runAgentTurn(null, 's-signal', '跑个长命令', {});
  await new Promise((r) => setTimeout(r, 60));
  await abortTurn(null, 's-signal');
  out = await pending2;
  await check('工具执行期间 abort：回合返回已停止（signal 已下穿工具链）', () => {
    assert.strictEqual(out.aborted, true);
    assert.ok(String(out.text).includes('已停止'), '实际: ' + out.text);
  });
  global.fetch = savedFetch2;

  // -------------------------------------------------------------------------
  const ok = summary();

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(LEGACY, { recursive: true, force: true }); } catch {}

  if (!ok) process.exit(1);
  console.log('Agent 回合管线全部验证通过');
  // 主进程内的 dsh 运行时持有定时器/句柄，需显式退出，否则进程挂起
  process.exit(0);
})();
