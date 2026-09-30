/**
 * 真实模型闭环「线级（wire-level）」验证
 * ----------------------------------------------------------------------------
 * 分工边界：本脚本 = **真实传输层**（node:http 起 127.0.0.1 真 HTTP 服务，main.ts
 * 的 fetch 真的发出去，验证 URL 拼装 / 请求头 / body 形态 / 错误泄漏）；
 * agent-loop-verify.cjs = **逻辑层**（global.fetch 假桩，验证回合消息契约、降级、
 * 持久化，完全跳过 HTTP 层）。两者互不替代。
 * 覆盖范围外：真实网络上的 300s 空闲超时（mock 即时应答）。空闲计时本身见 U。
 *
 * 验证项：
 *
 *       1. OpenAI chat 形态：URL 拼装 / Authorization 头 / body 形态 / stream:true
 *       2. 一轮内多个 tool_calls **全部**执行（回归防线：旧实现只取 [0]）
 *       3. 多轮工具循环与轮次上限
 *       4. Ollama 形态：{baseUrl}/api/chat + message.tool_calls 归一化
 *       5. apiMode responses / completions：不发 tools，各自正确取正文
 *       6. 网关拒绝 tools（400 且含 tool）→ 逐级降级 + toolsRejected 生效
 *       7. 401 / 429 可读错误且**不泄漏 API Key**（mock 回显请求头/body 作 canary）
 *       8. 迭代上限不死循环
 *       9. 超长工具结果回传模型时被裁剪（阈值以 agent-runtime.ts 为准 = 20000）
 *      10. 未配置 API Key 时不发 HTTP 请求
 *      11. fail-closed：200 但非 JSON 响应 / Ollama 非 200 → 可读错误而非崩溃
 *      12. 软拒绝（200 空内容但带 tools）→ 降级为文本兜底解析
 *
 * 运行：node model-loop-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// 1. 隔离数据目录（ORCHDESK_HOME）+ 用户数据目录（迁移源）
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-wire-home-'));
const LEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-wire-legacy-'));
process.env.ORCHDESK_HOME = HOME;

// ---------------------------------------------------------------------------
// 2. electron stub（共享脚手架 scripts/verify-kit.cjs，此处只覆盖本脚本差异）
// ---------------------------------------------------------------------------
const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');

const electronStub = makeElectronStub({
  home: path.join(os.tmpdir(), 'orchdesk-wire-stub'),
  getPath: (name) => (name === 'userData' ? LEGACY : path.join(os.tmpdir(), 'orchdesk-wire-stub', name)),
});
const ipcHandlers = electronStub.ipcHandlers;

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// 3. 真实本地 HTTP mock 服务（127.0.0.1 随机端口）
// ---------------------------------------------------------------------------
const KEY = 'test-key-do-not-use';
/** 用真实加密链路产出 apiKeyEnc（v1:AES-256-GCM），与 main.ts 的 decryptKey 同源。 */
const { encryptSecret } = require('./dist/credentials.js');
const KEY_ENC = encryptSecret(KEY);

let calls = [];          // 每次真实请求：{ method, url, headers, body, raw }
let plan = [];           // 应答队列（取完后重复最后一条）
let responder = null;    // 可编程应答（优先于 plan）
let lastAuth = null;     // 最近一次请求携带的 Authorization 头（防泄漏断言用）

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 非 JSON 请求体，忽略 */ }
    calls.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
    lastAuth = req.headers.authorization || null;

    let out;
    try {
      out = responder ? responder({ body, url: req.url, headers: req.headers, raw })
        : (plan.length > 1 ? plan.shift() : plan[0]);
    } catch (err) {
      out = { status: 500, text: 'mock 处理异常: ' + err.message };
    }
    if (!out) out = { status: 500, text: 'mock 未配置应答' };

    const payload = Buffer.from(String(out.text != null ? out.text : ''), 'utf-8');
    res.writeHead(out.status || 200, {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      Connection: 'close',
    });
    res.end(payload);
  });
});

// ---------------------------------------------------------------------------
// 4. mock 应答构造器
// ---------------------------------------------------------------------------
const json = (status, obj) => ({ status, text: JSON.stringify(obj) });
const text = (status, s) => ({ status, text: s });
const okJson = (obj) => json(200, obj);

/** OpenAI chat 应答（toolCalls 为 undefined 时不带该字段）。 */
const chat = (content, toolCalls) => okJson({ choices: [{ message: { content, tool_calls: toolCalls } }] });
/** Ollama /api/chat 应答。 */
const ollama = (content, toolCalls) => okJson({ message: { content, tool_calls: toolCalls } });

const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// ---------------------------------------------------------------------------
// 5. 测试脚手架（check + 计分走共享 verify-kit）
// ---------------------------------------------------------------------------
const { check, summary } = createChecker();

/** 写入本轮使用的模型配置（每次 runAgentTurn 都会重新读盘）。 */
function writeModels(provider, maxToolIterations) {
  fs.writeFileSync(
    path.join(HOME, 'models.json'),
    JSON.stringify({ providers: [provider], defaultProvider: provider.id, defaultModel: provider.models[0], maxToolIterations }),
    'utf-8',
  );
}

/** 读取落盘会话的最后一条 assistant 消息。 */
function lastAssistant(sessionId) {
  const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
  const msgs = (data[sessionId] && data[sessionId].msgs) || [];
  return msgs.filter((m) => m.role === 'assistant').pop() || {};
}

(async () => {
  // --- 启动 mock 服务 ---
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const PORT = server.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;
  const BASE_V1 = `${BASE}/v1`;

  // --- 准备被测文件（都在 HOME 下，通过 isPathAllowed 沙箱）---
  const SMALL = path.join(HOME, 'small.txt');
  fs.writeFileSync(SMALL, 'hello-wire', 'utf-8');
  const HEAD_SENTINEL = 'HEAD-SENTINEL-BEGIN';
  const TAIL_SENTINEL = 'TAIL-SENTINEL-END';
  const BIG = path.join(HOME, 'big.txt');
  const BIG_CONTENT = `${HEAD_SENTINEL}\n${'0123456789'.repeat(3000)}\n${TAIL_SENTINEL}`;
  fs.writeFileSync(BIG, BIG_CONTENT, 'utf-8');

  // --- 加载主进程（真实 fetch 会打到上面的 mock 服务）---
  require('./dist/main.js');
  // 等 app.whenReady() 的 then 回调跑完（迁移 + loadStore + bootRuntime）
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));

  const runAgentTurn = ipcHandlers.get('orchdesk:run-agent-turn');
  assert.ok(runAgentTurn, 'orchdesk:run-agent-turn handler 应已注册');

  const reset = () => { calls = []; plan = []; responder = null; lastAuth = null; };

  // =========================================================================
  console.log('\n== A. OpenAI chat 形态：线级契约 ==');

  writeModels({ id: 'p-chat', name: '线级测试网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  plan = [chat('你好，我是线级测试模型', undefined)];
  let out = await runAgentTurn(null, 's-a', '打个招呼', {});

  await check('A1 请求路径为 {baseUrl}/v1/chat/completions 且带 Authorization: Bearer <key>', () => {
    assert.strictEqual(calls.length, 1, '应只发 1 次请求，实际: ' + calls.length);
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[0].url, '/v1/chat/completions', '实际路径: ' + calls[0].url);
    assert.strictEqual(calls[0].headers.authorization, `Bearer ${KEY}`, 'Authorization 头不符: ' + calls[0].headers.authorization);
  });
  await check('A2 body 含 model / messages / tools，且 stream:true', () => {
    const b = calls[0].body;
    assert.strictEqual(b.model, 'wire-model', '实际 model: ' + b.model);
    assert.ok(Array.isArray(b.messages) && b.messages.length >= 2, 'messages 应含 system + user');
    // 数量从工具表取（ADR-0011 起为 15：新增 8 个浏览器工具），不写死常量
    const expectTools = require('./dist/agent-runtime.js').TOOL_DEFS.length;
    assert.ok(Array.isArray(b.tools) && b.tools.length === expectTools, `应下发 ${expectTools} 个工具定义，实际: ` + (b.tools || []).length);
    assert.strictEqual(b.stream, true, 'chat 请求应 stream:true（JSON 网关仍走整包兜底）');
  });
  await check('A3 正文取自 choices[0].message.content', () => {
    assert.strictEqual(out.text, '你好，我是线级测试模型', '实际: ' + out.text);
    assert.strictEqual(out.intent, 'ACT');
  });

  // =========================================================================
  console.log('== B. 一轮多个 tool_calls 全部执行（回归防线：旧实现只取 [0]）==');

  reset();
  plan = [
    chat('', [tc('call_list', 'file_list', { path: HOME }), tc('call_read', 'file_read', { path: SMALL })]),
    chat('两个工具都执行完了', undefined),
  ];
  out = await runAgentTurn(null, 's-b', '列出目录并读取文件', {});

  await check('B1 一轮内 2 个 tool_calls 全部执行：工具结果消息 2 条且 tool_call_id 两条都对得上', () => {
    assert.strictEqual(calls.length, 2, '应为「工具轮 + 总结轮」2 次请求，实际: ' + calls.length);
    const msgs = calls[1].body.messages;
    const assistant = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.ok(assistant, '第 2 轮应回传带 tool_calls 的 assistant 消息');
    assert.strictEqual(assistant.tool_calls.length, 2, 'assistant 消息应含 2 个 tool_calls');
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 2, '工具结果消息应为 2 条，实际: ' + toolMsgs.length);
    // OpenAI 规范：tool 消息必须严格按 assistant.tool_calls 的顺序回传（不排序）。
    const ids = assistant.tool_calls.map((t) => t.id);
    const gotIds = toolMsgs.map((m) => m.tool_call_id);
    assert.deepStrictEqual(gotIds, ids, `tool_call_id 顺序/取值不匹配: ${JSON.stringify(gotIds)} vs ${JSON.stringify(ids)}`);
    const names = toolMsgs.map((m) => m.name).sort();
    assert.deepStrictEqual(names, ['file_list', 'file_read'], '两个工具都应被执行，实际: ' + JSON.stringify(names));
    assert.ok(toolMsgs.some((m) => m.content.includes('small.txt')), 'file_list 结果应包含目录内容');
    assert.ok(toolMsgs.some((m) => m.content.includes('hello-wire')), 'file_read 结果应包含文件内容');
  });
  await check('B2 落盘记录里两个工具步骤都在（steps=2）', () => {
    const a = lastAssistant('s-b');
    assert.strictEqual(a.steps, 2, '实际 steps: ' + a.steps);
    const names = (a.tools || []).map((t) => t.n).sort();
    assert.deepStrictEqual(names, ['file_list', 'file_read'], '实际: ' + JSON.stringify(names));
  });

  // =========================================================================
  console.log('== C. 多轮工具循环 ==');

  reset();
  plan = [chat('', [tc('c1', 'file_list', { path: HOME })]), chat('总结：目录下有 small.txt 与 big.txt', undefined)];
  out = await runAgentTurn(null, 's-c', '看看目录', {});

  await check('C1 第 1 轮返 tool_calls → 第 2 轮给最终总结：共 2 轮 HTTP，最终回复为第 2 轮文本', () => {
    assert.strictEqual(calls.length, 2, '应为 2 轮请求，实际: ' + calls.length);
    assert.strictEqual(out.text, '总结：目录下有 small.txt 与 big.txt', '实际: ' + out.text);
    const a = lastAssistant('s-c');
    assert.strictEqual(a.steps, 1, '本轮应只执行 1 个工具步骤，实际: ' + a.steps);
  });

  // =========================================================================
  console.log('== D. Ollama 形态 ==');

  writeModels({ id: 'p-ollama', name: '本机 Ollama', type: 'ollama', baseUrl: BASE, models: ['qwen3:14b'] }, 5);
  reset();
  plan = [
    // 真实 Ollama 形态：tool_calls 元素**没有 id/type 字段**，arguments 是**对象**
    // 而非 JSON 字符串（与 OpenAI 形态的关键差异，覆盖归一化的「对象参数」路径）。
    ollama('', [
      { function: { name: 'file_list', arguments: { path: HOME } } },
      { function: { name: 'file_read', arguments: { path: SMALL } } },
    ]),
    ollama('ollama 形态执行完毕', undefined),
  ];
  out = await runAgentTurn(null, 's-d', '用 ollama 列目录', {});

  await check('D1 provider.type=ollama 时请求打到 {baseUrl}/api/chat 且 body 含 tools', () => {
    assert.strictEqual(calls[0].url, '/api/chat', '实际路径: ' + calls[0].url);
    const b = calls[0].body;
    assert.strictEqual(b.model, 'qwen3:14b');
    assert.strictEqual(b.stream, true, 'Ollama 请求应 stream:true');
    const expectTools2 = require('./dist/agent-runtime.js').TOOL_DEFS.length;
    assert.ok(Array.isArray(b.tools) && b.tools.length === expectTools2, `Ollama 形态也应下发 ${expectTools2} 个 tools，实际: ` + (b.tools || []).length);
    assert.strictEqual(calls[0].headers.authorization, undefined, 'Ollama 形态不带 Authorization 头');
  });
  await check('D2 message.tool_calls 被归一化执行（缺 id 的调用自动补 id 且能对上）', () => {
    const msgs = calls[1].body.messages;
    const assistant = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.ok(assistant, '应回传带 tool_calls 的 assistant 消息');
    assert.strictEqual(assistant.tool_calls.length, 2);
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 2, '2 个 ollama tool_calls 都应执行');
    const ids = assistant.tool_calls.map((t) => t.id).sort();
    assert.deepStrictEqual(toolMsgs.map((m) => m.tool_call_id).sort(), ids, 'tool_call_id 应与 assistant.tool_calls 一一对应');
    assert.ok(ids.every((i) => typeof i === 'string' && i.length > 0), '自动补的 id 不应为空: ' + JSON.stringify(ids));
    assert.strictEqual(out.text, 'ollama 形态执行完毕', '实际: ' + out.text);
  });

  // =========================================================================
  console.log("== E. apiMode:'responses' 与 'completions'（不发 tools）==");

  writeModels({ id: 'p-resp', name: 'responses 网关', type: 'openai-compatible', apiMode: 'responses', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  plan = [
    okJson({ output_text: 'responses 直出正文' }),
    okJson({ output_text: 'responses 第二轮正文' }),
  ];
  out = await runAgentTurn(null, 's-e1', '问个问题', {});
  await check('E1 responses 形态：路径 /v1/responses、body 无 tools、正文取 output_text', () => {
    assert.strictEqual(calls[0].url, '/v1/responses', '实际路径: ' + calls[0].url);
    const b = calls[0].body;
    assert.ok(!('tools' in b), 'responses 形态不应下发 tools，实际 keys: ' + Object.keys(b).join(','));
    assert.ok(!('messages' in b), 'responses 形态用 input 而非 messages');
    assert.strictEqual(out.text, 'responses 直出正文', '实际: ' + out.text);
  });
  out = await runAgentTurn(null, 's-e1', '再问一句', {});
  await check('E1b responses input 为完整消息数组：developer(system) + user + assistant 历史 + user，而非只有 user', () => {
    const input = calls[1].body.input;
    assert.ok(Array.isArray(input), 'input 应为消息数组（responses 规范），实际: ' + typeof input);
    assert.deepStrictEqual(input.map((m) => m.role), ['developer', 'user', 'assistant', 'user'],
      '角色序列应为 developer/user/assistant/user，实际: ' + JSON.stringify(input.map((m) => m.role)));
    assert.ok(String(input[0].content).includes('你是 OrchDesk 的本地 Agent'), 'system 提示词应以 developer 角色保留');
    assert.ok(String(input[0].content).includes('<tool:'), 'system 提示词应含 <tool:> 兜底格式说明');
    assert.ok(String(input[1].content).includes('问个问题'), '首轮 user 消息应保留');
    assert.ok(String(input[2].content).includes('responses 直出正文'), 'assistant 历史应保留（多轮上下文不断裂）');
    assert.ok(String(input[3].content).includes('再问一句'), '最新 user 消息应在末尾');
    assert.strictEqual(out.text, 'responses 第二轮正文', '实际: ' + out.text);
  });

  reset();
  plan = [okJson({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses 数组正文' }] }] })];
  out = await runAgentTurn(null, 's-e2', '再问个问题', {});
  await check('E2 responses 形态：正文取 output[].content[].text', () => {
    assert.strictEqual(out.text, 'responses 数组正文', '实际: ' + out.text);
    assert.strictEqual(calls.length, 1, '不应触发工具循环，实际请求数: ' + calls.length);
  });

  writeModels({ id: 'p-comp', name: 'completions 网关', type: 'openai-compatible', apiMode: 'completions', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  plan = [okJson({ choices: [{ text: 'completions 正文' }] })];
  out = await runAgentTurn(null, 's-e3', '补全一下', {});

  await check('E3 completions 形态：路径 /v1/completions、body 无 tools、正文取 choices[].text', () => {
    assert.strictEqual(calls[0].url, '/v1/completions', '实际路径: ' + calls[0].url);
    const b = calls[0].body;
    assert.ok(!('tools' in b), 'completions 形态不应下发 tools');
    assert.ok(!('messages' in b), 'completions 形态用 prompt 而非 messages');
    assert.strictEqual(typeof b.prompt, 'string', '应有 prompt 字段');
    assert.ok(b.prompt.includes('补全一下'), 'prompt 应包含用户输入: ' + b.prompt);
    assert.strictEqual(out.text, 'completions 正文', '实际: ' + out.text);
  });

  // =========================================================================
  console.log('== F. 网关拒绝 tools（400 含 tool）→ 降级 + 文本兜底 ==');

  writeModels({ id: 'p-deg', name: '拒绝工具的网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  let noToolsRound = 0;
  responder = ({ body }) => {
    if (body.tools) return text(400, 'unsupported parameter: tools is not supported by this gateway');
    noToolsRound++;
    if (noToolsRound === 1) {
      return chat(`我先看下目录：\n<tool:file_list>{"path":${JSON.stringify(HOME)}}</tool>`, undefined);
    }
    return chat('降级兜底完成：目录已列出', undefined);
  };
  out = await runAgentTurn(null, 's-f', '列目录', {});

  await check('F1 400 且错误信息含 tool → 逐级降级（完整 → 去 tool_choice → 去 tools）', () => {
    // 第 1 轮 3 次（2 次 400 + 1 次成功），第 2 轮因 toolsRejected 直接省掉全部重试 → 恰 4 次。
    // 若回归为 5+ 次，说明 toolsRejected 失效（第 2 轮又重复了 2 次降级重试）。
    assert.strictEqual(calls.length, 4, '应恰好 4 次请求（3 次降级 + 1 次免重试续轮），实际: ' + calls.length);
    assert.ok(Array.isArray(calls[0].body.tools), '第 1 次应带 tools');
    assert.strictEqual(calls[0].body.tool_choice, 'auto', '第 1 次应带 tool_choice:auto');
    assert.ok(Array.isArray(calls[1].body.tools), '第 2 次仍带 tools');
    assert.ok(!('tool_choice' in calls[1].body), '第 2 次应去掉 tool_choice');
    assert.ok(!('tools' in calls[2].body), '第 3 次应完全去掉 tools');
  });
  await check('F2 toolsRejected 生效：降级后后续请求都不再带 tools', () => {
    const after = calls.slice(2);
    assert.ok(after.length >= 1, '降级后应还有后续请求');
    assert.ok(after.every((c) => !('tools' in c.body)),
      '降级后不应再出现 tools，实际: ' + JSON.stringify(after.map((c) => Object.keys(c.body))));
  });
  await check('F3 降级后走文本兜底仍能完成任务', () => {
    assert.strictEqual(out.text, '降级兜底完成：目录已列出', '实际: ' + out.text);
    const a = lastAssistant('s-f');
    assert.ok((a.tools || []).some((t) => t.n === 'file_list'), '应通过文本兜底执行 file_list，实际: ' + JSON.stringify(a.tools));
    const msgs = calls[calls.length - 1].body.messages;
    assert.ok(msgs.some((m) => m.role === 'user' && String(m.content).includes('[工具 file_list 执行结果]')),
      '文本兜底模式下工具结果应以 user 角色回传');
  });

  // =========================================================================
  console.log('== G. 401 / 429 可读错误且防密钥泄漏（canary 回显）==');
  //
  // canary 设计：mock 在响应体里**回显请求的 Authorization 头与请求体**（模拟真实
  // 网关的调试回显行为）。若代码把请求头/body（或完整响应体）拼进错误文案，断言
  // 必命中。回显内容位于响应体 300 字符之后：现实现对错误文案取响应前 300 字符
  // （属可接受行为），全量回显类泄漏仍会被完整捕获。
  const BODY_SENTINEL = 'CANARY-REQ-BODY-9f3a7c';
  const PAD_320 = 'x'.repeat(320); // 把回显推到响应体 300 字符截断窗口之外

  writeModels({ id: 'p-401', name: '鉴权失败网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  responder = ({ headers, raw }) => json(401, {
    error: { message: 'Unauthorized ' + PAD_320 },
    echo: { auth: headers.authorization, body: raw + ' ' + BODY_SENTINEL },
  });
  out = await runAgentTurn(null, 's-g1', '你好', {});
  const authOnWire = lastAuth;

  await check('G1 HTTP 401：错误消息含状态码、提示可读，且不泄漏 API Key / 请求头 / 请求体', () => {
    assert.strictEqual(authOnWire, `Bearer ${KEY}`, '密钥确实上了线（Authorization 头），实际: ' + authOnWire);
    assert.ok(out.text.includes('模型调用失败'), '应有可读提示，实际: ' + out.text);
    assert.ok(out.text.includes('401'), '消息应含状态码 401，实际: ' + out.text);
    assert.ok(!out.text.includes(KEY), `错误消息泄漏了密钥: ${out.text}`);
    assert.ok(!out.text.includes(`Bearer ${KEY}`), '不应把 Authorization 头（含回显）拼进错误文案');
    assert.ok(!out.text.toLowerCase().includes('bearer'), '不应把 Authorization 头回显给用户: ' + out.text);
    assert.ok(!out.text.includes(BODY_SENTINEL), '不应把请求体回显片段拼进错误文案: ' + out.text);
    assert.strictEqual(out.intent, 'CONFIRM');
  });

  reset();
  responder = ({ headers, raw }) => text(429, 'rate limit exceeded, ' + PAD_320 + ' echo-auth: ' + headers.authorization + ' echo-body: ' + raw.slice(0, 50) + ' ' + BODY_SENTINEL);
  out = await runAgentTurn(null, 's-g2', '你好', {});

  await check('G2 HTTP 429：错误消息含状态码、提示可读，且不泄漏 API Key / 请求头 / 请求体', () => {
    assert.ok(out.text.includes('模型调用失败'), '实际: ' + out.text);
    assert.ok(out.text.includes('429'), '消息应含状态码 429，实际: ' + out.text);
    assert.ok(!out.text.includes(KEY), `错误消息泄漏了密钥: ${out.text}`);
    assert.ok(!out.text.toLowerCase().includes('bearer'), '不应把 Authorization 头（含回显）回显给用户: ' + out.text);
    assert.ok(!out.text.includes(BODY_SENTINEL), '不应把请求体回显片段拼进错误文案: ' + out.text);
  });

  // =========================================================================
  console.log('== H. 迭代上限不死循环 ==');

  writeModels({ id: 'p-loop', name: '循环网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 3);
  reset();
  responder = () => chat('', [tc('loop_call', 'file_list', { path: HOME })]);   // 永远返 tool_calls
  out = await runAgentTurn(null, 's-h', '一直调工具', {});

  await check('H1 maxToolIterations=3 时循环 3 次即停，返回兜底文案（不无限挂住）', () => {
    assert.strictEqual(calls.length, 3, '应恰好 3 次请求，实际: ' + calls.length);
    assert.ok(out.text.includes('已完成 3 个工具步骤'), '实际: ' + out.text);
    assert.ok(out.text.includes('未给出最终总结'), '实际: ' + out.text);
    assert.strictEqual(lastAssistant('s-h').steps, 3, '实际 steps: ' + lastAssistant('s-h').steps);
  });

  // =========================================================================
  console.log('== I. 超长工具结果被裁剪（阈值 20000，见 agent-runtime.ts）==');

  writeModels({ id: 'p-trunc', name: '裁剪网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  plan = [chat('', [tc('t1', 'file_read', { path: BIG })]), chat('大文件已读取', undefined)];
  out = await runAgentTurn(null, 's-i', '读大文件', {});

  await check('I1 超长工具输出（>20KB）回传模型时被裁剪到 20000 字符并附截断提示', () => {
    const msgs = calls[1].body.messages;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '应有工具结果消息');
    const N = BIG_CONTENT.length;
    assert.ok(N > 20000, '测试文件应超过 20KB，实际: ' + N);
    const expectTail = `\n…（已截断，共 ${N} 字符）`;
    assert.ok(toolMsg.content.includes('[工具 file_read 执行结果]'), '应带工具结果前缀');
    assert.ok(toolMsg.content.endsWith(expectTail), `应以截断文案结尾，实际结尾: ${JSON.stringify(toolMsg.content.slice(-40))}`);
    const head = '[工具 file_read 执行结果]\n';
    const bodyLen = toolMsg.content.length - head.length - expectTail.length;
    assert.strictEqual(bodyLen, 20000, '裁剪后正文应恰为 20000 字符，实际: ' + bodyLen);
  });
  await check('I2 裁剪边界正确：头部哨兵保留、尾部哨兵被截掉', () => {
    const toolMsg = calls[1].body.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg.content.includes(HEAD_SENTINEL), '头部内容应保留');
    assert.ok(!toolMsg.content.includes(TAIL_SENTINEL), '尾部超出阈值的内容应被裁掉');
    assert.strictEqual(out.text, '大文件已读取', '实际: ' + out.text);
  });

  // =========================================================================
  console.log('== J. 未配置 API Key ==');

  writeModels({ id: 'p-nokey', name: '无密钥网关', type: 'openai-compatible', baseUrl: BASE_V1, models: ['wire-model'] }, 5);
  reset();
  responder = () => chat('不应被调用', undefined);
  out = await runAgentTurn(null, 's-j', '你好', {});

  await check('J1 未配置 API Key 时给出清晰提示且不发出任何 HTTP 请求', () => {
    assert.ok(out.text.includes('未配置 API Key'), '实际: ' + out.text);
    assert.ok(out.text.includes('无密钥网关'), '提示应点明是哪个提供商，实际: ' + out.text);
    assert.strictEqual(calls.length, 0, '不应发出 HTTP 请求，实际: ' + calls.length);
    assert.strictEqual(out.intent, 'CONFIRM');
  });

  // =========================================================================
  console.log('== K. fail-closed：异常响应不崩溃 ==');

  writeModels({ id: 'p-html', name: '返回HTML的网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  responder = () => text(200, '<html><body><h1>502 Bad Gateway</h1></body></html>');
  out = await runAgentTurn(null, 's-k1', '你好', {});

  await check('K1 200 但返回 HTML（非 JSON）：不崩溃，走「模型调用失败」可读提示', () => {
    assert.ok(out.text.includes('模型调用失败'), '应有可读失败提示，实际: ' + out.text);
    assert.strictEqual(out.intent, 'CONFIRM');
    assert.ok(!out.text.includes('undefined'), '不应出现 undefined 兜底文案: ' + out.text);
  });

  writeModels({ id: 'p-ollama-err', name: '故障 Ollama', type: 'ollama', baseUrl: BASE, models: ['qwen3:14b'] }, 5);
  reset();
  responder = () => text(500, 'ollama internal error: ' + 'z'.repeat(500));
  out = await runAgentTurn(null, 's-k2', '你好', {});

  await check('K2 Ollama 非 200（500）：可读错误且错误正文截断到 300 字符', () => {
    assert.ok(out.text.includes('模型调用失败'), '应有可读失败提示，实际: ' + out.text);
    assert.ok(out.text.includes('500'), '消息应含状态码 500，实际: ' + out.text);
    assert.ok(out.text.includes('Ollama'), '消息应点明 Ollama，实际: ' + out.text);
    assert.ok(out.text.includes('ollama internal error'), '应保留错误正文开头，实际: ' + out.text);
    assert.ok(!out.text.includes('z'.repeat(280)), '错误正文应截断在 300 字符内（不应全量透传 500 字符错误体）');
    assert.ok(out.text.length < 420, '整条错误文案长度应受控，实际: ' + out.text.length);
  });

  // =========================================================================
  console.log('== L. 空内容诊断 + content 数组形态 ==');

  writeModels({ id: 'p-arr', name: '数组内容网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  responder = () => json(200, { choices: [{ message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }, finish_reason: 'stop' }] });
  out = await runAgentTurn(null, 's-l1', '数组内容', {});

  await check('L1 content 为分段数组（[{type:text,text}]) → 正确拼接正文（不再误判为空内容）', () => {
    assert.strictEqual(out.text, '第一段第二段', '实际: ' + out.text);
    assert.strictEqual(out.intent, 'ACT');
  });

  writeModels({ id: 'p-emptydiag', name: '空内容网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  responder = () => json(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  out = await runAgentTurn(null, 's-l2', '空内容', {});

  await check('L2 HTTP 200 但 content 为空 → 回复携带可定位诊断（provider/model/apiMode/HTTP 200/响应片段）', () => {
    assert.ok(out.text.includes('模型返回空内容'), '实际: ' + out.text);
    assert.ok(out.text.includes('provider=空内容网关'), '应含 provider 名: ' + out.text);
    assert.ok(out.text.includes('model=wire-model'), '应含模型名: ' + out.text);
    assert.ok(out.text.includes('apiMode=chat'), '应含 apiMode: ' + out.text);
    assert.ok(out.text.includes('HTTP 200'), '应含状态码: ' + out.text);
    assert.ok(out.text.includes('finish_reason=stop'), '应含 finish_reason: ' + out.text);
    assert.ok(!out.text.includes(KEY), '诊断不应泄漏密钥: ' + out.text);
  });

  // =========================================================================
  console.log('== M. 软拒绝（200 空内容带 tools）→ 降级 + 文本兜底 ==');

  writeModels({ id: 'p-soft', name: '软拒绝网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  let softNoToolsRound = 0;
  responder = ({ body }) => {
    if (body.tools) return json(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
    softNoToolsRound++;
    if (softNoToolsRound === 1) {
      return chat(`我先看下目录：\n<tool:file_list>${JSON.stringify({ path: HOME })}</tool>`, undefined);
    }
    return chat('软拒绝兜底完成', undefined);
  };
  out = await runAgentTurn(null, 's-m', '列目录', {});
  // M2 要引用本回合最后一个请求——M1b 会追加 calls，先固定边界。
  const sMCallsEnd = calls.length;

  await check('M1 带 tools 时 200 空内容 → 调用内降级 + 轮内软兜底（不写跨会话毒化）', () => {
    // 3 次降级（tools+choice → tools → 无 tools）+ 第 4 次为工具执行后的续轮：
    // 轮内软降级标志使其不再带 tools（省无效重试），但**不写 memo**（M-1）。
    assert.strictEqual(calls.length, 4, '应恰好 4 次请求（3 次降级 + 1 次轮内软兜底续轮），实际: ' + calls.length);
    assert.strictEqual(calls[0].body.tool_choice, 'auto', '第 1 次应带 tool_choice:auto');
    assert.ok(Array.isArray(calls[0].body.tools), '第 1 次应带 tools');
    assert.ok(Array.isArray(calls[1].body.tools), '第 2 次仍带 tools');
    assert.ok(!('tool_choice' in calls[1].body), '第 2 次应去掉 tool_choice');
    assert.ok(!('tools' in calls[2].body), '第 3 次应完全去掉 tools');
    assert.ok(!('tools' in calls[3].body), '第 4 次因轮内软兜底不再带 tools');
  });
  // M-1（2026-09 修复）：空内容不再置 toolsRejected——200 空内容可能是 finish=length /
  // 内容过滤 / 网关抖动，与工具协议无关。只生效于本回合（软兜底），不进跨会话 memo。
  await check('M1b 空内容不毒化：下一回合首次请求仍尝试原生 tools', async () => {
    const before = calls.length;
    responder = ({ body }) => (body.tools
      ? json(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] })
      : chat('二次降级内容', undefined));
    await runAgentTurn(null, 's-m1b', '再列一次', {});
    assert.ok(Array.isArray(calls[before].body.tools), '修复后新回合首次请求仍应带 tools');
  });
  await check('M2 降级后走文本兜底仍能完成任务', () => {
    assert.strictEqual(out.text, '软拒绝兜底完成', '实际: ' + out.text);
    const a = lastAssistant('s-m');
    assert.ok((a.tools || []).some((t) => t.n === 'file_list'), '应通过文本兜底执行 file_list，实际: ' + JSON.stringify(a.tools));
    const msgs = calls[sMCallsEnd - 1].body.messages;
    assert.ok(msgs.some((m) => m.role === 'user' && String(m.content).includes('[工具 file_list 执行结果]')),
      '文本兜底模式下工具结果应以 user 角色回传');
  });

  await check('M3 空内容软拒绝不跨会话毒化（同 provider+model 下一轮仍尝试 tools）', async () => {
    reset();
    softNoToolsRound = 0;
    responder = ({ body }) => {
      if (body.tools) return json(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
      softNoToolsRound++;
      if (softNoToolsRound === 1) {
        return chat(`<tool:file_list>${JSON.stringify({ path: HOME })}</tool>`, undefined);
      }
      return chat('跨轮不毒化完成', undefined);
    };
    out = await runAgentTurn(null, 's-m2', '再列目录', {});
    // M-1 修复后：空内容软拒绝不进 memo，本轮首请求仍带 tools（调用内降级后完成）。
    assert.ok(Array.isArray(calls[0].body.tools), '首轮请求应仍尝试 tools（不再被上一会话毒化），实际 keys: ' + Object.keys(calls[0].body).join(','));
    assert.strictEqual(out.text, '跨轮不毒化完成', '实际: ' + out.text);
  });

  // =========================================================================
  console.log('== N. 记忆与工作目录：插件已删除，变更失败关闭 ==');

  writeModels({ id: 'p-mem', name: '记忆网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  plan = [
    chat('', [tc('n1', 'memory_save', { content: '用户叫我小星' }), tc('n2', 'set_cwd', { path: HOME })]),
    chat('都记住了，目录也切好了', undefined),
  ];
  out = await runAgentTurn(null, 's-n', '记住我叫小星，切到我的项目目录', {});

  await check('N1 memory_save 与 set_cwd 失败关闭，不迁移已删除服务', () => {
    const a = lastAssistant('s-n');
    const names = (a.tools || []).map((t) => t.n).sort();
    assert.deepStrictEqual(names, ['memory_save', 'set_cwd'], '实际: ' + JSON.stringify(names));
    const saved = (a.tools || []).find((t) => t.n === 'memory_save');
    assert.ok(String(saved.result).includes('记忆服务未就绪'), 'memory_save 应拒绝: ' + saved.result);
    const cwdTool = (a.tools || []).find((t) => t.n === 'set_cwd');
    assert.ok(String(cwdTool.result).includes('沙箱服务已停止'), 'set_cwd 应拒绝: ' + cwdTool.result);
    assert.strictEqual(out.text, '都记住了，目录也切好了', '实际: ' + out.text);
  });

  await check('N2 未落库的记忆不得注入 system prompt', async () => {
    reset();
    plan = [chat('你叫我小星', undefined)];
    out = await runAgentTurn(null, 's-n', '我叫什么？', {});
    const sys = calls[0].body.messages.find((m) => m.role === 'system');
    assert.ok(sys, '应有 system 消息');
    assert.ok(!sys.content.includes('用户叫我小星'), '拒绝保存后不得注入记忆');
  });

  await check('N3 被拒绝的 set_cwd 不得把相对路径放进新目录', async () => {
    fs.writeFileSync(path.join(HOME, 'marker-wxtools.txt'), 'git-repo-here', 'utf-8');
    reset();
    plan = [
      chat('', [tc('n3', 'file_list', { path: '.' })]),
      chat('列好了', undefined),
    ];
    out = await runAgentTurn(null, 's-n', '列一下当前目录', {});
    const msgs = calls[1].body.messages;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '应有工具结果');
    assert.ok(!toolMsg.content.includes('marker-wxtools.txt'), '未切换的目录不得列出标记文件: ' + String(toolMsg.content).slice(0, 200));
  });

  // =========================================================================
  console.log('== N+. BUG-023 项目绑定目录 → 会话工作区（set-session-cwd 贯通）==');

  // 项目目录在临时区且**不在任何白名单根下**（非 dataDir / stub home / temp）——
  // 修复前：即使 cwd 设成功，file_* 也会被 isPathAllowed 拒绝（工作区名存实亡）。
  const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-wire-proj-'));
  const setSessionCwd = ipcHandlers.get('orchdesk:set-session-cwd');
  const rel = (p) => path.resolve(p);

  await check('B1 set-session-cwd：合法绝对路径 → ok 且返回 resolved 路径', async () => {
    assert.ok(setSessionCwd, 'orchdesk:set-session-cwd handler 应已注册');
    const r = await setSessionCwd(null, 's-b23', PROJ);
    assert.strictEqual(r.ok, true, '实际: ' + JSON.stringify(r));
    assert.strictEqual(r.path, rel(PROJ));
  });

  await check('B2 set-session-cwd 拒绝非法输入（相对路径 / 不存在 / 缺 sid）', async () => {
    const r1 = await setSessionCwd(null, 's-b23', 'relative/dir');
    assert.strictEqual(r1.ok, false, '相对路径应被拒');
    const r2 = await setSessionCwd(null, 's-b23', path.join(PROJ, '不存在的目录'));
    assert.strictEqual(r2.ok, false, '不存在的目录应被拒');
    assert.ok(String(r2.reason).includes('不存在'), 'reason 应说明目录不存在');
    const r3 = await setSessionCwd(null, '', PROJ);
    assert.strictEqual(r3.ok, false, '缺 sid 应被拒');
  });

  await check('B3 会话工作区注入 system prompt「当前工作目录」（渲染层驱动即生效）', async () => {
    reset();
    writeModels({ id: 'p-b23', name: '工作区网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
    plan = [chat('好的', undefined)];
    out = await runAgentTurn(null, 's-b23', '拉取更新', {});
    const sys = calls[0].body.messages.find((m) => m.role === 'system');
    assert.ok(sys, '应有 system 消息');
    assert.ok(sys.content.includes(rel(PROJ)), `cwd 应为项目目录 ${rel(PROJ)}`);
  });

  await check('B4 沙箱白名单纳入会话工作区：file_list "." 在项目目录内可用', async () => {
    fs.writeFileSync(path.join(PROJ, 'marker-b23.txt'), 'proj-root', 'utf-8');
    reset();
    plan = [
      chat('', [tc('b4', 'file_list', { path: '.' })]),
      chat('列好了', undefined),
    ];
    out = await runAgentTurn(null, 's-b23', '列一下项目目录', {});
    const msgs = calls[1].body.messages;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '应有工具结果');
    assert.ok(!String(toolMsg.content).includes('不允许'), `不应被沙箱拒绝: ${String(toolMsg.content).slice(0, 120)}`);
    assert.ok(toolMsg.content.includes('marker-b23.txt'), `相对路径应落在项目目录，实际: ${String(toolMsg.content).slice(0, 200)}`);
  });

  await check('B5 沙箱停止后 set_cwd 一律拒绝，子目录和目录外都不放行', async () => {
    const sub = fs.mkdtempSync(path.join(PROJ, 'sub-'));
    reset();
    plan = [chat('', [tc('b5', 'set_cwd', { path: sub })]), chat('切好了', undefined)];
    out = await runAgentTurn(null, 's-b23', '切到子目录', {});
    const a = lastAssistant('s-b23');
    const cwdTool = (a.tools || []).find((t) => t.n === 'set_cwd');
    assert.ok(cwdTool, '应有 set_cwd 调用');
    assert.ok(String(cwdTool.result).includes('沙箱服务已停止'), '子目录不得在沙箱停止后放行: ' + cwdTool.result);
    reset();
    plan = [chat('', [tc('b5b', 'set_cwd', { path: os.tmpdir() })]), chat('', undefined)];
    out = await runAgentTurn(null, 's-b23', '切到外面', {});
    const a2 = lastAssistant('s-b23');
    const cwdTool2 = (a2.tools || []).find((t) => t.n === 'set_cwd');
    assert.ok(cwdTool2 && String(cwdTool2.result).includes('沙箱服务已停止'), '目录外也必须拒绝: ' + (cwdTool2 && cwdTool2.result));
  });

  // =========================================================================
  console.log('== O. 意图网关已删除，不再短路模型 ==');

  writeModels({ id: 'p-gate', name: '门控网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  responder = () => chat('不应该被调用', undefined);
  out = await runAgentTurn(null, 's-o', 'rm -rf /', {});

  await check('O1 已删除的意图门不再拦截，模型收到原文且不伪造拦截文案', () => {
    assert.strictEqual(calls.length, 1, `模型应被调用 1 次，实际 ${calls.length}`);
    assert.ok(!out.text.includes('意图网关拦截'), '不得伪造拦截: ' + out.text);
    assert.strictEqual(out.text, '不应该被调用');
    const a = lastAssistant('s-o');
    assert.ok(!String(a.text).includes('意图网关拦截'), '落盘不得写已删除的拦截文案');
  });

  // =========================================================================
  console.log('== P. 提示词库接入对话流（FR-5/FR-11）==');

  writeModels({ id: 'p-pr', name: '提示词网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  // 经真实 prompt-save 桥写入一条提示词（agents 留空 = 对全部 Agent 生效）
  const saveR = await ipcHandlers.get('orchdesk:prompt-save')(null, { title: '回复风格', body: '始终用简洁中文回答', category: 'style', agents: [], priority: 10 });
  plan = [chat('好的', undefined)];
  out = await runAgentTurn(null, 's-p', '在吗', {});

  await check('P1 prompt-save 不可用，正文不得注入 system prompt', () => {
    assert.strictEqual(saveR && saveR.ok, false, '保存必须失败: ' + JSON.stringify(saveR).slice(0, 160));
    assert.strictEqual(saveR.unavailable, true);
    assert.ok(String(saveR.reason).includes('提示词库插件未接入'), '实际: ' + saveR.reason);
    const sys = calls[0].body.messages.find((m) => m.role === 'system');
    assert.ok(sys, '应有 system 消息');
    assert.ok(!sys.content.includes('始终用简洁中文回答'), '未落库的提示词不得注入');
  });

  // =========================================================================
  console.log('== Q. 专家团派发桥（multi composeTeam 端到端）==');

  writeModels({ id: 'p-or', name: '编排网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  responder = () => chat('分包任务完成', undefined);
  const comp = await ipcHandlers.get('orchdesk:compose-team')(null, 'team-fullstack', '做一个登录页');

  await check('Q1 compose-team 在 multi 删除后不可用，不返回委派树', () => {
    assert.ok(comp && comp.error, '应明确失败: ' + JSON.stringify(comp).slice(0, 200));
    assert.ok(String(comp.error).includes('编排服务未就绪'), '实际: ' + comp.error);
    assert.ok(!comp.rootId, '不得返回已删除编排的 rootId');
  });

  // =========================================================================
  console.log('== R. 用量追踪与 SessionEvent 双写（FR-5 / FR-6，ADR-0009）==');

  // R1: 网关回 usage → 记账 + tok 徽标 + 事件流
  writeModels({ id: 'p-us', name: '用量网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['usage-model'] }, 5);
  reset();
  responder = () => {
    const u = { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 };
    return okJson({ choices: [{ message: { content: '带用量的回答' } }], usage: u });
  };
  out = await runAgentTurn(null, 's-usage', '用量测试输入', {});

  await check('R1 网关上报 usage → assistant 消息带 tok 徽标（单回合累计）', () => {
    const m = lastAssistant('s-usage');
    assert.ok(m.tok, 'assistant 消息应带 tok: ' + JSON.stringify(m).slice(0, 200));
    assert.strictEqual(m.tok.p, 120);
    assert.strictEqual(m.tok.c, 45);
  });

  await check('R2 usage.json 落盘且 orchdesk:usage 聚合正确（「没上报」≠「0」对侧：上报了必须记）', () => {
    const file = path.join(HOME, 'usage.json');
    assert.ok(fs.existsSync(file), 'usage.json 应已落盘');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.ok(data.entries.length >= 1, '应至少 1 条回合条目');
    const e = data.entries[data.entries.length - 1];
    assert.strictEqual(e.totalTokens, 165, '应记录 165，实际 ' + e.totalTokens);
    assert.strictEqual(e.sessionId, 's-usage');
    assert.strictEqual(e.model, 'usage-model');
  });

  await check('R3 orchdesk:usage IPC 返回聚合（total + byModel + bySession）', async () => {
    const u = await ipcHandlers.get('orchdesk:usage')(null);
    assert.ok(u.ok !== false, 'usage IPC 应 ok: ' + JSON.stringify(u).slice(0, 150));
    assert.ok(u.total.turns >= 1 && u.total.totalTokens >= 165, JSON.stringify(u.total));
    assert.ok(u.byModel.some((m) => m.model === 'usage-model'), 'byModel 应含 usage-model');
    assert.ok(u.bySession.some((s) => s.sessionId === 's-usage'), 'bySession 应含 s-usage');
  });

  await check('R4 SessionEvent 事件流：user + assistant（含 model）双写进 events/<sid>.ndjson', () => {
    const evFile = path.join(HOME, 'events', 's-usage.ndjson');
    assert.ok(fs.existsSync(evFile), '事件文件应存在: ' + evFile);
    const evs = fs.readFileSync(evFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(evs[0].kind, 'user');
    assert.strictEqual(evs[0].text, '用量测试输入', '「模型可见必入日志」：用户输入全文');
    assert.strictEqual(evs[1].kind, 'assistant');
    assert.strictEqual(evs[1].text, '带用量的回答');
    assert.strictEqual(evs[1].model, 'usage-model');
    assert.ok(evs[1].tok && evs[1].tok.p === 120, '事件也应带 token 用量');
  });

  await check('R4b 非消息 canonical 事件不落本地消息流（task.*/tool.* 只走 SSE/WS）', () => {
    // Phase 8 回归：emitCanonicalEvent 曾把 task.created 也转成 kind='user' 写进
    // events/<sid>.ndjson，在真实 user 事件前多插一条 → 分叉点/回放整体错位。
    // 消息流必须只含 user/assistant/fork-origin，且条数与「一轮对话」一致。
    const evFile = path.join(HOME, 'events', 's-usage.ndjson');
    const evs = fs.readFileSync(evFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const kinds = evs.map((e) => e.kind);
    assert.ok(
      kinds.every((k) => k === 'user' || k === 'assistant' || k === 'fork-origin'),
      '本地消息流只应含 user/assistant/fork-origin，实际: ' + JSON.stringify(kinds),
    );
    assert.strictEqual(evs.length, 2, `一轮对话应恰好 2 条消息事件（实际 ${evs.length} 条：${kinds}）`);
  });

  await check('R5 orchdesk:session-events IPC → event-log 源时间线', async () => {
    const r = await ipcHandlers.get('orchdesk:session-events')(null, 's-usage');
    assert.strictEqual(r.source, 'event-log', '应从事件流取，实际 ' + r.source);
    assert.ok(r.timeline.length >= 2, JSON.stringify(r.timeline || []).slice(0, 200));
  });

  // R6: 网关不回 usage → 不记账（助手消息无 tok 字段）
  reset();
  plan = [chat('没有用量的回答', undefined)];
  out = await runAgentTurn(null, 's-nousage', '再来一条', {});

  await check('R6 网关不回 usage → 不记条目、消息无 tok（不伪造 0）', () => {
    const m = lastAssistant('s-nousage');
    assert.ok(!m.tok, '不应有 tok 字段: ' + JSON.stringify(m.tok));
    const before = JSON.parse(fs.readFileSync(path.join(HOME, 'usage.json'), 'utf-8'));
    const mine = before.entries.filter((e) => e.sessionId === 's-nousage');
    assert.strictEqual(mine.length, 0, '该会话不应有记账条目');
  });

  console.log('== S. chat SSE 真 HTTP（JSON 网关以外的流式正文）==');
  writeModels({ id: 'p-chat', name: '线级测试网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  plan = [text(200, 'data: {"choices":[{"delta":{"content":"春"}}]}\n\ndata: {"choices":[{"delta":{"content":"秋"}}]}\n\ndata: [DONE]\n')];
  out = await runAgentTurn(null, 's-sse', '流式你好', {});
  await check('S1 stream:true 且 SSE 拼出全文', () => {
    assert.strictEqual(calls[0].body.stream, true, 'chat 应请求 stream:true');
    assert.strictEqual(out.text, '春秋', '实际: ' + out.text);
  });

  console.log('== T. stream:true 被拒 → 同轮 stream:false（不误伤 tools 降级）==');
  writeModels({ id: 'p-chat', name: '线级测试网关', type: 'openai-compatible', baseUrl: BASE_V1, apiKeyEnc: KEY_ENC, models: ['wire-model'] }, 5);
  reset();
  responder = ({ body }) => {
    if (body.stream) return text(400, 'streaming is not supported by this gateway');
    return chat('非流式兜底回复', undefined);
  };
  out = await runAgentTurn(null, 's-stream-drop', '你好', {});
  await check('T1 stream 400 后改 stream:false 且仍带 tools', () => {
    assert.ok(calls.length >= 2, '应至少 2 次请求，实际: ' + calls.length);
    assert.strictEqual(calls[0].body.stream, true);
    assert.strictEqual(calls[1].body.stream, false);
    assert.ok(Array.isArray(calls[1].body.tools), '卸流后仍应带 tools，不能误走 tools 降级');
    assert.strictEqual(out.text, '非流式兜底回复', '实际: ' + out.text);
  });

  // =========================================================================
  console.log('== U. 空闲超时：有字节就续命，绝对上限仍切断 ==');
  await check('U1 touch 重置空闲计时，绝对上限不被 touch 推迟', async () => {
    const mc = require('./dist/model-client.js');
    const h = mc.openModelAbort(undefined, 80, 400);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(h.signal.aborted, false, '50ms 时不应已空闲超时');
    h.touch();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(h.signal.aborted, false, 'touch 后续命，不应在原空闲点中止');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(h.signal.aborted, true, '静默超过 idle 应中止');
    assert.strictEqual(h.signal.reason && h.signal.reason.name, 'AbortError');
    h.dispose();

    const h2 = mc.openModelAbort(undefined, 500, 120);
    const t0 = Date.now();
    h2.touch();
    await new Promise((r) => h2.signal.addEventListener('abort', () => r(), { once: true }));
    const dt = Date.now() - t0;
    assert.ok(dt < 220, '绝对上限应切断持续 touch，实际 ' + dt);
    h2.dispose();
    assert.ok(mc.modelTimeoutText(false).includes('模型调用失败'));
    assert.ok(!mc.modelTimeoutText(false).includes('120s'));
  });

  const ok = summary();

  // 收尾：关服务 + 清临时目录
  server.closeAllConnections && server.closeAllConnections();
  await new Promise((r) => server.close(r));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(LEGACY, { recursive: true, force: true }); } catch {}

  if (!ok) process.exit(1);
  console.log('真实 HTTP 线级验证全部通过');
  // 主进程内的 dsh 运行时持有定时器/句柄，需显式退出，否则进程挂起
  process.exit(0);
})().catch((err) => {
  console.error('\n验证脚本异常终止:', err);
  // 失败路径同样清理临时目录（不残留 orchdesk-wire-* 垃圾）
  try { server.closeAllConnections && server.closeAllConnections(); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(LEGACY, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
