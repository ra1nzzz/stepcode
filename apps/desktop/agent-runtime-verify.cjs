/**
 * Agent Runtime 单元验证（BUG-014 防回归）
 * ----------------------------------------------------------------------------
 * 直接 require 编译产物 dist/agent-runtime.js（纯逻辑、不依赖 electron），
 * 覆盖：
 *   1. parseToolArgs —— 参数宽容解析
 *   2. normalizeNativeToolCalls —— OpenAI / Ollama / 摊平 三种 tool_calls 形态
 *   3. extractToolCalls —— <tool:> / 未闭合 / tool_call 包裹 / 裸写法 / 纯 JSON / 普通文本
 *   4. buildAssistantToolCallMessage + buildToolResultMessage —— OpenAI 消息契约
 *   5. formatToolResult / truncateForModel —— 结果裁剪
 *   6. buildSystemPrompt —— 提示词覆盖全部工具
 *
 * 运行：node agent-runtime-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const rt = require('./dist/agent-runtime.js');

let passed = 0;
let failed = 0;
const log = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    log.push(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 1. parseToolArgs：参数宽容解析 ==');

check('JSON 字符串 → 对象', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_read', '{"path":"a.txt"}'), { path: 'a.txt' });
});
check('对象直接透传', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_read', { path: 'a.txt' }), { path: 'a.txt' });
});
check('代码围栏包裹的 JSON', () => {
  assert.deepStrictEqual(rt.parseToolArgs('shell_command', '```json\n{"command":"git status"}\n```'), { command: 'git status' });
});
check('混杂文本中抠出 JSON', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_list', '好的，我先看目录 {"path":"."} 然后继续'), { path: '.' });
});
check('裸字符串 → 映射到主参数（shell_command）', () => {
  assert.deepStrictEqual(rt.parseToolArgs('shell_command', 'git status'), { command: 'git status' });
});
check('裸字符串 → 映射到主参数（file_read）', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_read', 'C:/tmp/a.txt'), { path: 'C:/tmp/a.txt' });
});
check('空参数 → 空对象', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_list', ''), {});
  assert.deepStrictEqual(rt.parseToolArgs('file_list', null), {});
});
check('非法 JSON 且无主参数 → input 兜底', () => {
  assert.deepStrictEqual(rt.parseToolArgs('unknown_tool', 'abc'), { input: 'abc' });
});

// ---------------------------------------------------------------------------
console.log('== 2. normalizeNativeToolCalls：原生 tool_calls 归一化 ==');

check('OpenAI 形态（arguments 为 JSON 字符串）', () => {
  const out = rt.normalizeNativeToolCalls([
    { id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'call_1');
  assert.strictEqual(out[0].name, 'file_read');
  assert.deepStrictEqual(out[0].arguments, { path: 'a.txt' });
  assert.strictEqual(out[0].rawArguments, '{"path":"a.txt"}');
});
check('Ollama 形态（arguments 为对象、无 id）', () => {
  const out = rt.normalizeNativeToolCalls([
    { function: { name: 'shell_command', arguments: { command: 'git log' } } },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'shell_command');
  assert.deepStrictEqual(out[0].arguments, { command: 'git log' });
  assert.ok(out[0].id, '缺失 id 时应自动生成');
});
check('摊平形态（name/arguments 在顶层）', () => {
  const out = rt.normalizeNativeToolCalls([{ name: 'file_list', arguments: '{"path":"."}' }]);
  assert.strictEqual(out[0].name, 'file_list');
  assert.deepStrictEqual(out[0].arguments, { path: '.' });
});
check('多个工具调用全部保留（旧实现只取第一个）', () => {
  const out = rt.normalizeNativeToolCalls([
    { id: 'c1', function: { name: 'file_list', arguments: '{"path":"."}' } },
    { id: 'c2', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
  ]);
  assert.strictEqual(out.length, 2);
});
check('无 name 的条目被丢弃', () => {
  assert.strictEqual(rt.normalizeNativeToolCalls([{ id: 'x', function: {} }]).length, 0);
});
check('非数组输入 → 空数组', () => {
  assert.deepStrictEqual(rt.normalizeNativeToolCalls(undefined), []);
  assert.deepStrictEqual(rt.normalizeNativeToolCalls(null), []);
  assert.deepStrictEqual(rt.normalizeNativeToolCalls({}), []);
});
check('畸形 function=primitive string 不抛 TypeError（"arguments" in 原始值会炸）', () => {
  // 某些网关对 function 返回裸字符串而非对象；旧代码 `'arguments' in fn` 对
  // primitive 抛 `Cannot use 'in' operator`。顶层有 name 时应正常解析并回落顶层 args。
  const out = rt.normalizeNativeToolCalls([
    { id: 'c1', name: 'file_list', function: 'file_list', arguments: '{"path":"."}' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'file_list');
  assert.deepStrictEqual(out[0].arguments, { path: '.' });
  // function 是 primitive 且顶层也无 name → 丢弃（不炸）
  assert.strictEqual(rt.normalizeNativeToolCalls([{ id: 'x', function: 'boom' }]).length, 0);
});
check('顶层 input 兜底（与 wrapper 分支口径一致）', () => {
  const out = rt.normalizeNativeToolCalls([{ name: 'file_read', input: '{"path":"a.txt"}' }]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].arguments, { path: 'a.txt' });
});

// ---------------------------------------------------------------------------
console.log('== 3. extractToolCalls：文本兜底解析 ==');

check('标准 <tool:name>json</tool>', () => {
  const r = rt.extractToolCalls('<tool:file_list>{"path":"."}</tool>');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'file_list');
  assert.deepStrictEqual(r.calls[0].arguments, { path: '.' });
  assert.strictEqual(r.stripped, '');
});
check('缺少闭合标签也能解析', () => {
  const r = rt.extractToolCalls('<tool:shell_command>{"command":"git status"}');
  assert.strictEqual(r.calls.length, 1);
  assert.deepStrictEqual(r.calls[0].arguments, { command: 'git status' });
});
check('正文 + 工具片段：剥离后保留正文', () => {
  const r = rt.extractToolCalls('我先看看目录：\n<tool:file_list>{"path":"."}</tool>\n然后读文件。');
  assert.strictEqual(r.calls.length, 1);
  assert.ok(r.stripped.includes('我先看看目录'), 'stripped 应保留正文: ' + JSON.stringify(r.stripped));
  assert.ok(!r.stripped.includes('<tool:'), 'stripped 不应残留工具标签');
});
check('一次多个工具调用', () => {
  const r = rt.extractToolCalls('<tool:file_list>{"path":"."}</tool><tool:file_read>{"path":"a.txt"}</tool>');
  assert.strictEqual(r.calls.length, 2);
});
check('重复调用去重', () => {
  const r = rt.extractToolCalls('<tool:file_list>{"path":"."}</tool><tool:file_list>{"path":"."}</tool>');
  assert.strictEqual(r.calls.length, 1);
});
check('tool:name;{...} 裸写法', () => {
  const r = rt.extractToolCalls('调用 tool:file_list;{"path":"."} 看看');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'file_list');
  assert.deepStrictEqual(r.calls[0].arguments, { path: '.' });
});
check('<tool_call>{...}</tool_call> 包裹写法', () => {
  const r = rt.extractToolCalls('<tool_call>{"name":"file_read","arguments":{"path":"a.txt"}}</tool_call>');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'file_read');
  assert.deepStrictEqual(r.calls[0].arguments, { path: 'a.txt' });
});
check('纯 JSON（name + arguments）', () => {
  const r = rt.extractToolCalls('{"name":"web_fetch","arguments":{"url":"https://a.com"}}');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'web_fetch');
});
check('普通文本不产生工具调用', () => {
  const r = rt.extractToolCalls('好的，我已经完成了任务，这是总结。');
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(r.stripped, '好的，我已经完成了任务，这是总结。');
});
check('含 <tool 字样但无合法格式时不误判', () => {
  const r = rt.extractToolCalls('请告诉我 tool: 是什么');
  assert.strictEqual(r.calls.length, 0);
});
check('未知工具名可被 isKnownTool 识别并过滤', () => {
  const r = rt.extractToolCalls('<tool:rm_rf>{"path":"/"}</tool>');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(rt.isKnownTool(r.calls[0].name), false);
  assert.strictEqual(rt.isKnownTool('file_read'), true);
});

// ---------------------------------------------------------------------------
console.log('== 4. OpenAI 消息契约 ==');

check("native 模式：assistant 消息带 tool_calls", () => {
  const calls = rt.normalizeNativeToolCalls([
    { id: 'call_1', function: { name: 'file_list', arguments: '{"path":"."}' } },
    { id: 'call_2', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
  ]);
  const msg = rt.buildAssistantToolCallMessage('先看目录', calls);
  assert.strictEqual(msg.role, 'assistant');
  assert.strictEqual(msg.tool_calls.length, 2);
  assert.strictEqual(msg.tool_calls[0].type, 'function');
  assert.strictEqual(msg.tool_calls[0].function.name, 'file_list');
  assert.strictEqual(msg.tool_calls[0].function.arguments, '{"path":"."}', 'arguments 必须原样回传');
});
check("native 模式：工具结果用 role:'tool' + tool_call_id", () => {
  const msg = rt.buildToolResultMessage({ id: 'call_1', name: 'file_list' }, { name: 'file_list', result: 'a.txt' }, 'native');
  assert.strictEqual(msg.role, 'tool', "必须用 role 'tool'，不能用 system/user");
  assert.strictEqual(msg.tool_call_id, 'call_1');
  assert.strictEqual(msg.name, 'file_list');
  assert.ok(msg.content.includes('a.txt'));
});
check("tool_call_id 与 assistant.tool_calls[].id 一一对应", () => {
  const calls = rt.normalizeNativeToolCalls([
    { id: 'c1', function: { name: 'file_list', arguments: '{"path":"."}' } },
    { id: 'c2', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
  ]);
  const assistant = rt.buildAssistantToolCallMessage('', calls);
  const ids = assistant.tool_calls.map((t) => t.id);
  for (const c of calls) {
    const toolMsg = rt.buildToolResultMessage(c, { name: c.name, result: 'ok' }, 'native');
    assert.ok(ids.includes(toolMsg.tool_call_id), `tool_call_id ${toolMsg.tool_call_id} 必须能在 assistant.tool_calls 中找到`);
  }
});
check("text 兜底模式：工具结果用 role:'user'（无 tool_calls 时 role:'tool' 非法）", () => {
  const msg = rt.buildToolResultMessage({ name: 'file_list' }, { name: 'file_list', result: 'a.txt' }, 'text');
  assert.strictEqual(msg.role, 'user');
  assert.strictEqual(msg.tool_call_id, undefined);
});
check("工具报错时结果文本标注失败", () => {
  const msg = rt.buildToolResultMessage({ id: 'c1', name: 'shell_command' }, { name: 'shell_command', result: '', error: '命令不在白名单' }, 'native');
  assert.ok(msg.content.includes('执行失败'));
  assert.ok(msg.content.includes('命令不在白名单'));
});

// ---------------------------------------------------------------------------
console.log('== 5. 结果裁剪 ==');

check('超长结果被截断并标注', () => {
  const long = 'x'.repeat(rt.TOOL_RESULT_FEEDBACK_LIMIT + 500);
  const out = rt.truncateForModel(long);
  assert.ok(out.length < long.length);
  assert.ok(out.includes('已截断'));
});
check('短结果原样返回', () => {
  assert.strictEqual(rt.truncateForModel('hello'), 'hello');
});
check('空结果有占位文本', () => {
  assert.ok(rt.formatToolResult('file_read', { name: 'file_read', result: '' }).includes('空结果'));
});

// ---------------------------------------------------------------------------
console.log('== 6. 系统提示词 ==');

check('提示词覆盖全部工具', () => {
  const p = rt.buildSystemPrompt();
  // 15 = 5 基础 + memory_save + set_cwd + 8 浏览器（ADR-0011）；新增工具必须同步此数
  assert.strictEqual(rt.TOOL_DEFS.length, 15, '工具应为 15 个，实际: ' + rt.TOOL_DEFS.length);
  for (const n of rt.TOOL_NAMES) assert.ok(p.includes(n), `提示词缺少工具 ${n}`);
});
check('提示词注入工作目录与长期记忆（dsh memory 接入对话流）', () => {
  const p = rt.buildSystemPrompt({ cwd: 'D:\\Code\\WxTools', memories: ['用户叫我小星'] });
  assert.ok(p.includes('D:\\Code\\WxTools'), '应注入 cwd，实际无');
  assert.ok(p.includes('用户叫我小星'), '应注入记忆条目，实际无');
  assert.ok(p.includes('memory_save'), '应告知保存事实的规则');
});
check('缺省提示词不含工作目录/记忆段（可选项不产生空段）', () => {
  const p = rt.buildSystemPrompt();
  assert.ok(!p.includes('当前工作目录'), '不应出现空 cwd 段');
  assert.ok(!p.includes('长期记忆'), '不应出现空记忆段');
  assert.ok(!p.includes('生效提示词'), '不应出现空提示词段');
});
check('提示词库段落注入（FR-5/FR-11 接入对话流）', () => {
  const p = rt.buildSystemPrompt({ prompts: ['【回复风格】简洁中文'] });
  assert.ok(p.includes('生效提示词'), '应有提示词段');
  assert.ok(p.includes('【回复风格】简洁中文'), '应含提示词正文');
});
check('提示词给出 <tool:> 兜底格式示例', () => {
  const p = rt.buildSystemPrompt();
  assert.ok(p.includes('<tool:'), '应包含兜底格式说明');
  assert.ok(p.includes('function calling'), '应优先引导原生 function calling');
});

// ---------------------------------------------------------------------------
console.log('== 7. 安全修复断言（B-1 / B-2 / M-5）==');

// B-1：渲染层（{r,t,x}）与主进程（{role,text}）消息双轨 → 读侧归一化
check('normalizeHistory：渲染层 r/x schema 与主进程 role/text schema 都归一为 ApiMessage', () => {
  const out = rt.normalizeHistory([
    { r: 'user', t: '10:00', x: '第一条（渲染层 schema）' },
    { role: 'assistant', text: '回复（主进程 schema）', tools: [] },
    { r: 'agent', x: 'agent 别名也应映射为 assistant' },
    { role: 'tool', text: '工具步骤消息不回灌模型' },
    { r: 'user', t: '10:01' }, // 无正文
  ]);
  assert.strictEqual(out.length, 3, '应归一 3 条（tool/空正文被过滤），实际 ' + out.length);
  assert.deepStrictEqual(out[0], { role: 'user', content: '第一条（渲染层 schema）' });
  assert.deepStrictEqual(out[1], { role: 'assistant', content: '回复（主进程 schema）' });
  assert.deepStrictEqual(out[2], { role: 'assistant', content: 'agent 别名也应映射为 assistant' });
});
check('normalizeHistory：limit 只保留最近 N 条', () => {
  const out = rt.normalizeHistory([
    { role: 'user', text: '第1条' },
    { role: 'assistant', text: '第2条' },
    { role: 'user', text: '第3条' },
  ], 2);
  assert.strictEqual(out.length, 2, '应只保留 2 条');
  assert.strictEqual(out[0].content, '第2条');
  assert.strictEqual(out[1].content, '第3条');
});
check('normalizeHistory：undefined / 空数组安全', () => {
  assert.deepStrictEqual(rt.normalizeHistory(undefined), []);
  assert.deepStrictEqual(rt.normalizeHistory([]), []);
});

// B-2：shell 元字符检测（命令白名单唯一结构绕过入口）
check('hasShellMetachars：拼接类元字符全部命中', () => {
  for (const cmd of [
    'git log && cmd /c calc',
    'echo hi | findstr x',
    'ls; rm -rf /',
    'echo $(whoami)',
    'echo `whoami`',
    'echo a > out.txt',
    'echo a < in.txt',
    'echo a\nrm -rf /',
  ]) {
    assert.strictEqual(rt.hasShellMetachars(cmd), true, '应判定含元字符: ' + JSON.stringify(cmd));
  }
});
check('hasShellMetachars：正常命令（含引号/参数/路径）不误伤', () => {
  for (const cmd of [
    'git status',
    'git log --format=%H',
    'npm run build',
    'dir "D:\\Code\\OrchDesk"',
    'find . -name "*.ts"',
    'node --version',
    '',
  ]) {
    assert.strictEqual(rt.hasShellMetachars(cmd), false, '不应误伤: ' + JSON.stringify(cmd));
  }
});
check('ALLOWED_COMMANDS 不含万能 shell/解释器与网络外发工具（B-2 白名单收口）', () => {
  // 网络出口统一走 web_fetch（域名白名单 + SSRF + 逐跳复检）——shell 里的 curl/wget 会绕开这三道门
  for (const bad of ['cmd', 'powershell', 'pwsh', 'node', 'python', 'python3', 'pip', 'npx', 'curl', 'wget']) {
    assert.ok(!rt.ALLOWED_COMMANDS.includes(bad), `白名单不应含 ${bad}（可执行任意代码/绕开网络门）`);
  }
  for (const keep of ['git', 'npm', 'pnpm', 'ls', 'dir', 'cat', 'type', 'find', 'ping']) {
    assert.ok(rt.ALLOWED_COMMANDS.includes(keep), `白名单应保留 ${keep}`);
  }
});

// M-5：迭代上限常量单源
check('MAX_TOOL_ITERATIONS_CAP/DEFAULT 为单源常量且取值合理', () => {
  assert.strictEqual(rt.MAX_TOOL_ITERATIONS_CAP, 500);
  assert.strictEqual(rt.MAX_TOOL_ITERATIONS_DEFAULT, 200);
  assert.ok(rt.MAX_TOOL_ITERATIONS_DEFAULT <= rt.MAX_TOOL_ITERATIONS_CAP, '默认值不得超上限');
});

// ---------------------------------------------------------------------------
console.log('\n' + log.join('\n'));
console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);

if (failed > 0) process.exit(1);
console.log('Agent Runtime 全部验证通过');
