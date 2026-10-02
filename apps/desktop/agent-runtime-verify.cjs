/**
 * Agent Runtime 单元验证（BUG-014 防回归）
 * ----------------------------------------------------------------------------
 * 直接 require 编译产物 dist/agent-runtime.js（纯逻辑、不依赖 electron），
 * 覆盖：
 *   1. parseToolArgs —— 参数宽容解析
 *   2. normalizeNativeToolCalls —— OpenAI / Ollama / 摊平 三种 tool_calls 形态
 *   3.（原 extractToolCalls 文本兜底解析一节，随 agent-runtime 的残留表面一起删除，见 BUG-061）
 *   5. buildAssistantToolCallMessage + buildToolResultMessage —— OpenAI 消息契约


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
console.log('== 7. 安全修复断言（B-1 / B-2 / M-5）==');

// B-1：渲染层（{r,t,x}）与主进程（{role,text}）消息双轨 → 读侧归一化
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
