/**
 * TRACE 脱敏遥测上传验证（真实链路 · 本地 mock GitHub 端点）
 * ----------------------------------------------------------------------------
 * 背景：scripts/verify-plugins.mjs 只验证了 `mask()` 这个纯函数，从未驱动过真实
 * 上传链路（队列 → 批量 → 重试 → 指数退避 → 失败不阻塞会话）。本机 Electron
 * 阻断（BUG-W02）且不能依赖外网，故：
 *
 *   - 用 node:http 起一个本地 mock GitHub 端点（127.0.0.1 随机端口）；
 *   - 插件硬编码请求 `https://api.github.com/...`（源码 uploadBatch 只用 repoUrl
 *     解析 owner/repo，端点域名写死），因此在传输层把该域名重写到 127.0.0.1，
 *     请求构造 / 头 / body / 重试逻辑全部走真实代码；
 *   - 用可控的 Date.now 偏移驱动 30s 量级的指数退避，无需真等。
 *
 * 运行：node scripts/verify-trace-upload.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Context } = require('@deepseek-ai/cordis');

let passed = 0;
let failed = 0;
const log = [];
let current = '';

function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => { passed++; log.push(`  PASS  [${current}] ${name}`); },
        (e) => { failed++; log.push(`  FAIL  [${current}] ${name}\n        ${e.message}`); });
    }
    passed++;
    log.push(`  PASS  [${current}] ${name}`);
  } catch (e) {
    failed++;
    log.push(`  FAIL  [${current}] ${name}\n        ${e.message}`);
  }
  return undefined;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function settle(n = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 全局探针：时间 / 定时器 / 控制台
// ---------------------------------------------------------------------------
const realNow = Date.now.bind(Date);
/** 时间偏移（毫秒）：用于在秒级内驱动 30s 量级的指数退避。 */
let timeOffset = 0;
Date.now = () => realNow() + timeOffset;

async function withOffset(ms, fn) {
  timeOffset = ms;
  try { return await fn(); } finally { timeOffset = 0; }
}

async function waitFor(pred, label, timeout = 5000) {
  const t0 = realNow();
  while (realNow() - t0 < timeout) {
    if (pred()) return;
    await sleep(1);
  }
  throw new Error('等待超时：' + label);
}

// 定时器探针：验证插件卸载时 30s 刷新定时器被 clearInterval（否则进程无法退出）；
// 同时捕获回调，供「直驱 30s tick」用例使用（真实 setInterval 无法被时间偏移驱动）。
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const startedIntervals = [];
const clearedIntervals = [];
globalThis.setInterval = function (fn, ms, ...rest) {
  const id = realSetInterval(fn, ms, ...rest);
  startedIntervals.push({ id, fn, ms });
  return id;
};
globalThis.clearInterval = function (id) {
  clearedIntervals.push(id);
  return realClearInterval(id);
};

// 控制台探针：任何一行输出都不得包含 token
const consoleLines = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    consoleLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    return orig(...args);
  };
}

// ---------------------------------------------------------------------------
// 凭据与路径（全部为显式假数据，绝不写真实 token / 本机路径）
// ---------------------------------------------------------------------------
const FAKE_TOKEN = 'ghp_FAKEVERIFYTOKEN0123456789abcdefghijklmnop';
const FAKE_ENV_TOKEN = 'ghp_FAKEENVTOKEN9876543210zyxwvutsrqponmlk';
const FAKE_REPO = 'https://github.com/orchdesk-verify/trace-verify';
/** 脱敏用例用的假敏感串（非真实凭据）。 */
const SECRETS = {
  winPath: 'C:\\Users\\testuser\\secret-folder\\keys.txt',
  apiKey: 'sk-fakeTESTKEY0123456789abcdef',
  email: 'alice@example.com',
};
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-trace-verify-'));

// ---------------------------------------------------------------------------
// 本地 mock GitHub 端点（127.0.0.1 + 随机端口）
// ---------------------------------------------------------------------------
const received = [];
let responder = () => ({ status: 201, body: JSON.stringify({ ok: true }) });

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = JSON.parse(raw); } catch { /* 记录原始串即可 */ }
    received.push({ method: req.method, url: req.url, headers: req.headers, raw, json });
    const r = responder({ n: received.length, req, raw, json }) || { status: 201 };
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(r.body ?? '{}');
  });
});

const setStatus = (status) => { responder = () => ({ status }); };
const resetReceived = () => { received.length = 0; };

// ---------------------------------------------------------------------------
// fetch 传输层重写：api.github.com → 127.0.0.1（唯一一处「绕过」，其余全真实）
// ---------------------------------------------------------------------------
const GITHUB_PREFIX = 'https://api.github.com';
const realFetch = globalThis.fetch;
let localPort = 0;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url);
  if (typeof url === 'string' && url.startsWith(GITHUB_PREFIX)) {
    return realFetch(`http://127.0.0.1:${localPort}${url.slice(GITHUB_PREFIX.length)}`, init);
  }
  // 除 GitHub 遥测端点外一律拒绝，避免测试意外触网
  throw new Error(`[verify] 非预期的外网请求被拦截：${url}`);
};

// ---------------------------------------------------------------------------
// 装载：真实 Cordis Context + 真实 lib 产物
// ---------------------------------------------------------------------------
function normalizeInject(mod) {
  const out = { ...mod };
  if (Array.isArray(out.inject)) {
    const obj = {};
    for (const k of out.inject) obj[k] = true;
    out.inject = obj;
  }
  return out;
}

let traceMod = null;

async function bootTrace(cfg) {
  const ctx = new Context();
  const mod = await import(pathToFileURL(require.resolve('../packages/plugin/trace/lib/index.js')).href);
  traceMod = mod;
  const plugin = normalizeInject(mod);
  const config = plugin.Config(cfg);
  const timersBefore = startedIntervals.length;
  const fiber = ctx.plugin(plugin, config);
  await settle();
  return { ctx, fiber, mod, config, timerId: startedIntervals[timersBefore]?.id };
}

/** 触发一次 Loop 前事件（step 可控）。 */
async function firePreStep(ctx, { text, step = 0, turn = 0, agentId = 'agent-verify-1' }) {
  return ctx.waterfall('agent/pre-step', {
    agent: { id: agentId, session: { id: 'sess-verify-1' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    turn,
    step,
  }, async () => ({ kind: 'enter', messages: [] }));
}

/** 取最近一次上传的最后一条记录。 */
function lastUploadedRecord() {
  const last = received[received.length - 1];
  assert(last && last.json, '还没有任何上传请求');
  const lines = String(last.json.body).split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function allRawBodies() {
  return received.map((r) => r.raw).join('\n');
}

// ---------------------------------------------------------------------------
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  localPort = server.address().port;

  console.log('== trace（脱敏遥测上传）==');

  // =========================================================================
  current = '装载';
  await check('mock GitHub 端点监听 127.0.0.1 随机端口', () => {
    const addr = server.address();
    assert(addr && addr.address === '127.0.0.1', '未监听回环地址：' + JSON.stringify(addr));
    assert(addr.port > 0, '未分配随机端口');
  });
  const rt = await bootTrace({
    repoUrl: FAKE_REPO,
    maskEnabled: true,
    cacheDir: CACHE_DIR,
    token: FAKE_TOKEN,
    batchSize: 1,
  });
  const { ctx, fiber, mod } = rt;
  await check('trace 插件在真实 Cordis ctx 上激活（fiber.state=2）', () => {
    assert(fiber.state === 2, `未激活，state=${fiber.state}`);
  });
  await check('导出 recordFeedback / queueSize / mask / flush', () => {
    assert(typeof mod.recordFeedback === 'function', 'recordFeedback 未导出');
    assert(typeof mod.queueSize === 'function', 'queueSize 未导出');
    assert(typeof mod.mask === 'function', 'mask 未导出');
    assert(typeof mod.flush === 'function', 'flush 未导出');
  });
  await check('上传请求被路由到本地 mock 端点（插件端点域名硬编码为 api.github.com）', async () => {
    resetReceived();
    setStatus(201);
    mod.recordFeedback('read', 'positive', 'route-check');
    await waitFor(() => received.length === 1, '路由检查请求');
    const last = received[received.length - 1];
    assert(last.headers['x-orchdesk-trace'] === 'masked', '缺少 X-Orchdesk-Trace 头');
  });

  // =========================================================================
  // 语用意图标签
  // =========================================================================
  current = '意图标签';
  const INTENT_SAMPLES = [
    ['exec', 'delete the stale build cache'],
    ['write', 'write the report into the notes file'],
    ['network', 'POST the summary to the internal api'],
    ['message', '把这封邮件通知给负责人'],
    ['read', 'read the config file and list the keys'],
    ['query', '为什么这个任务会失败'],
    ['other', '嗯，好的'],
  ];
  await check('step===0 时观测一条 source:"pre-step" 记录', async () => {
    resetReceived();
    setStatus(201);
    await firePreStep(ctx, { text: 'read the config file', step: 0 });
    await waitFor(() => received.length === 1, 'pre-step 观测上传');
    const rec = lastUploadedRecord();
    assert(rec.source === 'pre-step', 'source=' + rec.source);
    assert(rec.feedback === null, 'Loop 前观测的 feedback 应为 null，实际 ' + rec.feedback);
    assert(rec.v === 1 && typeof rec.ts === 'string', 'schema 字段不完整：' + JSON.stringify(rec));
  });
  await check('step!==0 时不观测（每个 turn 只记一次）', async () => {
    resetReceived();
    await firePreStep(ctx, { text: 'read the config file', step: 3 });
    await settle();
    assert(received.length === 0, 'step!==0 不应产生上传，实际 ' + received.length);
  });
  await check('七类语用意图标签分类正确', async () => {
    for (const [expected, text] of INTENT_SAMPLES) {
      resetReceived();
      await firePreStep(ctx, { text, step: 0 });
      await waitFor(() => received.length === 1, `意图样本「${text}」`);
      const rec = lastUploadedRecord();
      assert(rec.intent === expected, `「${text}」应判为 ${expected}，实际 ${rec.intent}`);
    }
  });
  await check('意图标签取值在枚举内（read/write/exec/network/message/query/other）', () => {
    const allowed = ['read', 'write', 'exec', 'network', 'message', 'query', 'other'];
    for (const r of received) {
      const lines = String(r.json.body).split('\n').filter(Boolean);
      for (const line of lines) {
        const rec = JSON.parse(line);
        assert(allowed.includes(rec.intent), '出现枚举外标签：' + rec.intent);
      }
    }
  });
  await check('sessionKey 为哈希（不含原始 agent/session id 形状）', () => {
    const rec = lastUploadedRecord();
    assert(/^k[0-9a-z]+$/.test(rec.sessionKey), 'sessionKey 不是哈希形态：' + rec.sessionKey);
    assert(!rec.sessionKey.includes('agent-verify-1'), 'sessionKey 泄露原始 agent id');
    assert(!rec.sessionKey.includes('sess-verify-1'), 'sessionKey 泄露原始 session id');
  });

  // =========================================================================
  // 脱敏（根源性）
  // =========================================================================
  current = '脱敏';
  const DIRTY_TEXT =
    `delete the temp files under ${SECRETS.winPath} using ${SECRETS.apiKey} and notify ${SECRETS.email}`;
  await check('喂入含绝对路径/API Key/邮箱的结构，payload 中不含任何原文', async () => {
    resetReceived();
    setStatus(201);
    await firePreStep(ctx, { text: DIRTY_TEXT, step: 0 });
    await waitFor(() => received.length === 1, '脏数据上传');
    const raw = allRawBodies();
    for (const [kind, value] of Object.entries(SECRETS)) {
      assert(!raw.includes(value), `${kind} 泄漏到上传 payload：${value}`);
    }
    assert(!raw.includes('testuser'), '用户名片段泄漏');
    assert(!raw.includes('delete the temp files'), '消息原文泄漏');
  });
  await check('上传记录的字段严格白名单（v/ts/sessionKey/intent/feedback/source）', () => {
    const rec = lastUploadedRecord();
    const keys = Object.keys(rec).sort().join(',');
    const allowed = ['feedback', 'intent', 'sessionKey', 'source', 'ts', 'v'];
    const extra = Object.keys(rec).filter((k) => !allowed.includes(k));
    assert(extra.length === 0, '出现白名单外字段：' + extra.join(',') + ' → ' + keys);
  });
  await check('mask() 对脏输入只保留白名单（根源性脱敏，不依赖正则清洗）', () => {
    const dirty = {
      v: 1,
      ts: new Date().toISOString(),
      sessionKey: 'kabc123',
      intent: 'exec',
      feedback: null,
      source: 'pre-step',
      // 模拟上游误塞的自由文本
      text: DIRTY_TEXT,
      message: DIRTY_TEXT,
      password: 'hunter2',
      cwd: SECRETS.winPath,
      apiKey: SECRETS.apiKey,
      contact: SECRETS.email,
    };
    const cleaned = mod.mask(dirty);
    const s = JSON.stringify(cleaned);
    for (const value of [...Object.values(SECRETS), 'hunter2', 'password', 'cwd']) {
      assert(!s.includes(value), 'mask() 后仍含敏感值：' + value);
    }
    assert(cleaned.intent === 'exec' && cleaned.sessionKey === 'kabc123', '白名单元数据丢失：' + s);
  });
  await check('上传 title 只含条数与日期，不含消息内容', () => {
    const last = received[received.length - 1];
    const title = String(last.json.title);
    assert(/^\[orchdesk-trace\] \d+ records @ \d{4}-\d{2}-\d{2}$/.test(title), 'title 形态不符：' + title);
    for (const value of Object.values(SECRETS)) {
      assert(!title.includes(value), 'title 泄漏敏感值：' + value);
    }
  });

  // =========================================================================
  // 上传成功路径
  // =========================================================================
  current = '上传';
  await check('mock 服务 201 → 队列清空（pending=0, retry=0）', async () => {
    resetReceived();
    setStatus(201);
    mod.recordFeedback('write', 'positive', 'upload-ok');
    await waitFor(() => received.length >= 1, '成功上传');
    await mod.flush();
    const q = mod.queueSize();
    assert(q.pending === 0, 'pending 应清空，实际 ' + q.pending);
    assert(q.retry === 0, 'retry 应清空，实际 ' + q.retry);
  });
  await check('请求语义正确：POST /repos/<owner>/<repo>/issues + masked 头', () => {
    const last = received[received.length - 1];
    assert(last.method === 'POST', '方法应为 POST，实际 ' + last.method);
    assert(last.url === '/repos/orchdesk-verify/trace-verify/issues', '路径不符：' + last.url);
    assert(last.headers['x-orchdesk-trace'] === 'masked', '缺少 masked 声明头');
    assert(String(last.headers['content-type'] || '').includes('application/json'), 'Content-Type 不符');
  });
  await check('多条记录按 batchSize 分批上送（body 为 JSONL，一行一条）', async () => {
    resetReceived();
    setStatus(201);
    for (let i = 0; i < 3; i++) mod.recordFeedback('query', 'neutral', `batch-${i}`);
    await waitFor(() => received.length >= 3, '成批上送');
    const lines = received.map((r) => String(r.json.body).split('\n').filter(Boolean).length);
    assert(lines.reduce((a, b) => a + b, 0) === 3, '上送记录数不符：' + JSON.stringify(lines));
  });

  // =========================================================================
  // 失败重试 + 指数退避
  // =========================================================================
  current = '重试';
  await check('500 → 进入重试队列（不丢单、不抛错）', async () => {
    resetReceived();
    setStatus(500);
    mod.recordFeedback('read', 'negative', 'retry-1');
    await waitFor(() => received.length === 1 && mod.queueSize().retry === 1, '首次失败入重试队列');
    const q = mod.queueSize();
    assert(q.pending === 0, 'pending 应已出队，实际 ' + q.pending);
    assert(q.retry === 1, 'retry 应为 1，实际 ' + q.retry);
  });
  await check('退避期内不重发（首次退避 30s）', async () => {
    await mod.flush(); // 不退避时间 → 不应产生新请求
    assert(received.length === 1, '退避期内不应重发，实际请求数 ' + received.length);
    await withOffset(28_000, () => mod.flush());
    assert(received.length === 1, '28s 时不应重发（退避 30s），实际 ' + received.length);
  });
  await check('退避到期后重发，且间隔翻倍（30s → 60s）', async () => {
    await withOffset(34_000, () => mod.flush());
    assert(received.length === 2, '过 30s 应重发一次，实际 ' + received.length);
    // 本次失败后 nextAt = now + 30_000 * 2^1 = 60s
    await withOffset(90_000, () => mod.flush());
    assert(received.length === 2, '未到 60s 不应重发，实际 ' + received.length);
    await withOffset(100_000, () => mod.flush());
    assert(received.length === 3, '过 60s 应再次重发，实际 ' + received.length);
  });
  await check('服务恢复后重试成功，重试队列归零', async () => {
    setStatus(201);
    await withOffset(300_000, () => mod.flush());
    await waitFor(() => mod.queueSize().retry === 0, '重试队列归零');
    const q = mod.queueSize();
    assert(q.pending === 0 && q.retry === 0, `应清空，实际 pending=${q.pending} retry=${q.retry}`);
    assert(received.length === 4, '应恰好 4 次请求（1 首发 + 3 重试），实际 ' + received.length);
    assert(received[3].url.includes('/issues'), '最后一次应为成功的 issues 上传');
  });
  await check('重试 5 次上限后丢弃单条且不崩溃', async () => {
    resetReceived();
    setStatus(500);
    mod.recordFeedback('exec', 'negative', 'retry-exhaust');
    // 必须等到失败已处理完（入重试队列），否则后续 flush 撞上 flushing 门闩早退
    await waitFor(() => received.length === 1 && mod.queueSize().retry === 1, '首发失败');
    // attempt 1..5 依次失败，第 6 次（attempt 已达 5）丢弃；每步推进到下一次到期
    for (const off of [32_000, 96_000, 220_000, 465_000, 950_000]) {
      await withOffset(off, () => mod.flush());
    }
    assert(received.length === 6, `应为 1 首发 + 5 次重试 = 6 次请求，实际 ${received.length}`);
    const q = mod.queueSize();
    assert(q.retry === 0, '超上限后应丢弃，retry 实际 ' + q.retry);
  });

  // =========================================================================
  // 上传失败不阻塞会话
  // =========================================================================
  current = '不阻塞会话';
  await check('上传失败时 agent/pre-step 返回值与成功时完全一致', async () => {
    // 清场：把上一节残留（含退避中的重试项）全部上送成功后，再开始对比
    setStatus(201);
    await withOffset(2_000_000, () => mod.flush());
    await waitFor(() => mod.queueSize().pending === 0 && mod.queueSize().retry === 0, '清场');

    resetReceived();
    // 注意：pending 归零只代表批次已出队，不代表请求已落定 —— 必须等服务端收到
    const okDecision = await firePreStep(ctx, { text: 'read the config', step: 0 });
    await waitFor(() => received.length === 1, '成功路径上传落定');

    setStatus(500);
    resetReceived();
    const failDecision = await firePreStep(ctx, { text: 'read the config', step: 0 });
    assert(JSON.stringify(okDecision) === JSON.stringify(failDecision),
      `决策被上传失败改变：${JSON.stringify(okDecision)} → ${JSON.stringify(failDecision)}`);
    assert(failDecision && failDecision.kind === 'enter', '主流程语义应不受影响');
    await waitFor(() => received.length === 1 && mod.queueSize().retry === 1, '失败后入重试队列');
  });
  await check('上传失败时观测仍然完成（记录进入重试队列而非静默丢弃）', () => {
    const q = mod.queueSize();
    assert(q.retry === 1, '失败记录应进入重试队列，实际 retry=' + q.retry);
    assert(q.pending === 0, '失败记录应已从待发队列出队，实际 pending=' + q.pending);
    const rec = lastUploadedRecord();
    assert(rec.source === 'pre-step', '观测记录应保留来源标记，实际 ' + rec.source);
    assert(rec.intent === 'read', '意图标签应已观测，实际 ' + rec.intent);
  });

  // =========================================================================
  // recordFeedback
  // =========================================================================
  current = '反馈落点';
  await check('recordFeedback(intent, feedback, sessionKey) 入队并上送', async () => {
    setStatus(201);
    await withOffset(2_000_000, () => mod.flush()); // 清掉上一节的重试残留
    await waitFor(() => mod.queueSize().retry === 0 && mod.queueSize().pending === 0, '清场');
    resetReceived();
    mod.recordFeedback('message', 'positive', 'sess-from-ui');
    await waitFor(() => received.length === 1, '反馈上送');
    const rec = lastUploadedRecord();
    assert(rec.source === 'user', 'source 应为 user，实际 ' + rec.source);
    assert(rec.feedback === 'positive', 'feedback 应为 positive，实际 ' + rec.feedback);
    assert(rec.intent === 'message', 'intent 应原样带回，实际 ' + rec.intent);
    assert(/^k[0-9a-z]+$/.test(rec.sessionKey), 'sessionKey 应为哈希，实际 ' + rec.sessionKey);
    assert(rec.sessionKey !== 'sess-from-ui', 'sessionKey 不应是原始 sid');
  });
  await check('缺省 sessionKey → "anonymous"（不泄露调用方身份）', async () => {
    resetReceived();
    mod.recordFeedback('query', 'neutral');
    await waitFor(() => received.length === 1, '匿名反馈上送');
    const rec = lastUploadedRecord();
    assert(rec.sessionKey === 'anonymous', 'sessionKey 应为 anonymous，实际 ' + rec.sessionKey);
    assert(rec.messageKey === undefined, '未传 messageKey 时不应出现该字段');
  });

  // =========================================================================
  // 凭据（第二实例：token 改为来自环境变量）
  // =========================================================================
  current = '凭据';
  await check('token 只在 Authorization 头，不在 payload / title / labels 中', () => {
    for (const r of received) {
      assert(!r.raw.includes(FAKE_TOKEN), 'payload 中出现了 token');
      assert(String(r.headers.authorization || '').includes(FAKE_TOKEN), 'Authorization 头应携带 token');
    }
  });
  await check('token 不出现在任何控制台输出/异常文本中', () => {
    for (const line of consoleLines) {
      assert(!line.includes(FAKE_TOKEN), '日志中出现了 token：' + line);
    }
  });
  await check('插件真实异常文本不含 token（捕获 flush 返回的原始错误）', async () => {
    resetReceived();
    setStatus(500);
    mod.recordFeedback('read', 'negative', 'err-msg-check');
    await waitFor(() => received.length === 1 && mod.queueSize().retry === 1, '首发失败入重试队列');
    // 推进到重试到期 → drainRetry 再次真实失败 → 捕获插件内部真实异常文本（非自造 Error）
    const r = await withOffset(31_000, () => mod.flush());
    assert(typeof r.lastError === 'string' && /github upload failed: 500/.test(r.lastError),
      '未捕获到插件真实异常文本：' + JSON.stringify(r.lastError));
    assert(!r.lastError.includes(FAKE_TOKEN), '异常文本不应含 token');
    for (const line of consoleLines) assert(!line.includes(FAKE_TOKEN), '日志泄漏 token');
  });

  // 收尾：清掉第一实例残留，再换一个「token 只来自环境变量」的实例
  setStatus(201);
  await withOffset(5_000_000, () => mod.flush());
  await waitFor(() => mod.queueSize().pending === 0 && mod.queueSize().retry === 0, '第一实例清场');
  await Promise.resolve(fiber.dispose());
  await settle();

  await check('ORCHDESK_TRACE_TOKEN 环境变量回退生效（config.token 为空时）', async () => {
    process.env.ORCHDESK_TRACE_TOKEN = FAKE_ENV_TOKEN;
    resetReceived();
    const rt2 = await bootTrace({
      repoUrl: FAKE_REPO, maskEnabled: true, cacheDir: CACHE_DIR, token: '', batchSize: 1,
    });
    try {
      rt2.mod.recordFeedback('read', 'positive', 'env-token');
      await waitFor(() => received.length === 1, 'env token 上传');
      const last = received[received.length - 1];
      assert(String(last.headers.authorization || '').includes(FAKE_ENV_TOKEN),
        'Authorization 应使用 env token，实际 ' + last.headers.authorization);
      assert(!last.raw.includes(FAKE_ENV_TOKEN), 'env token 不应进入 payload');
    } finally {
      delete process.env.ORCHDESK_TRACE_TOKEN;
      await Promise.resolve(rt2.fiber.dispose());
      await settle();
    }
  });
  await check('未配置 repoUrl 时不发起上传（仓库不硬编码）', async () => {
    resetReceived();
    const rt3 = await bootTrace({
      repoUrl: '', maskEnabled: true, cacheDir: CACHE_DIR, token: FAKE_TOKEN, batchSize: 1,
    });
    try {
      rt3.mod.recordFeedback('read', 'positive', 'no-repo');
      await settle();
      await sleep(50);
      assert(received.length === 0, '未配置仓库时不应发起请求，实际 ' + received.length);
    } finally {
      await Promise.resolve(rt3.fiber.dispose());
      await settle();
    }
  });

  // =========================================================================
  // 队列保留 / 合并上送 / 非 github 端点 / 定时器兜底
  // =========================================================================
  current = '队列兜底';
  await check('无 repoUrl（trace 关闭/未配置）：记录不入队（关闭则不记录）', async () => {
    const rt = await bootTrace({
      repoUrl: '', maskEnabled: true, cacheDir: CACHE_DIR, token: FAKE_TOKEN, batchSize: 5,
    });
    try {
      resetReceived();
      const pendingBefore = rt.mod.queueSize().pending;
      rt.mod.recordFeedback('read', 'positive', 'no-repo-drop');
      await settle();
      // ③加固：repoUrl 空 = 用户关闭 trace → 关闭则不记录，不入队也不占内存
      assert(rt.mod.queueSize().pending === pendingBefore,
        `repoUrl 空时记录不应入队（${pendingBefore} → ${rt.mod.queueSize().pending}）`);
      // 无滞留记录 → flush 无事可做（skippedReason 为 null 属正常，非「配置缺失滞留」）
      const r = await rt.mod.flush();
      assert(received.length === 0, `不应发起请求，实际 ${received.length}`);
      assert(r.skippedReason === null,
        'repoUrl 空且无滞留时 flush 应无事可做（skippedReason=null），实际 ' + r.skippedReason);
    } finally {
      await Promise.resolve(rt.fiber.dispose());
      await settle();
    }
  });
  await check('无 token：flush 后记录仍在队列（不静默丢单）且给出未上送原因', async () => {
    delete process.env.ORCHDESK_TRACE_TOKEN;
    const rt = await bootTrace({
      repoUrl: FAKE_REPO, maskEnabled: true, cacheDir: CACHE_DIR, token: '', batchSize: 5,
    });
    try {
      resetReceived();
      rt.mod.recordFeedback('read', 'positive', 'no-token-keep');
      const r = await rt.mod.flush();
      assert(rt.mod.queueSize().pending >= 1, `记录应保留在队列，实际 ${rt.mod.queueSize().pending}`);
      assert(received.length === 0, `不应发起请求，实际 ${received.length}`);
      assert(r.skippedReason === 'token-not-configured', '未上送原因不符：' + r.skippedReason);
    } finally {
      await Promise.resolve(rt.fiber.dispose());
      await settle();
    }
  });
  await check('batchSize>1：多条记录合并为一次上送（body 为 3 行 JSONL）', async () => {
    const rt = await bootTrace({
      repoUrl: FAKE_REPO, maskEnabled: true, cacheDir: CACHE_DIR, token: FAKE_TOKEN, batchSize: 5,
    });
    try {
      setStatus(201);
      // 清掉上游「无 token」用例滞留的记录（顺带验证滞留记录在配置齐全后最终落网；
      // 「无 repoUrl」用例因③加固关闭则不记录，已不入队，无滞留）
      await rt.mod.flush();
      await waitFor(() => rt.mod.queueSize().pending === 0, '滞留记录清空');
      resetReceived();
      for (let i = 0; i < 3; i++) rt.mod.recordFeedback('query', 'neutral', `merge-${i}`);
      assert(received.length === 0, 'batchSize 未满足时 scheduleFlush 不应上送');
      await rt.mod.flush();
      await waitFor(() => received.length === 1, '合并上送');
      const lines = String(received[0].json.body).split('\n').filter(Boolean);
      assert(lines.length === 3, `应 3 行 JSONL 合并上送，实际 ${lines.length}`);
      assert(rt.mod.queueSize().pending === 0, '上送后队列应清空');
    } finally {
      await Promise.resolve(rt.fiber.dispose());
      await settle();
    }
  });
  await check('非 github.com repoUrl：显式进入 error 状态（可查询），不静默', async () => {
    const rt = await bootTrace({
      repoUrl: 'https://gitlab.com/orchdesk-verify/trace-verify',
      maskEnabled: true, cacheDir: CACHE_DIR, token: FAKE_TOKEN, batchSize: 5,
    });
    try {
      resetReceived();
      rt.mod.recordFeedback('read', 'positive', 'non-github');
      const r = await rt.mod.flush();
      assert(received.length === 0, `不应向任何端点发起请求，实际 ${received.length}`);
      const errs = rt.mod.errorRecords();
      assert(Array.isArray(errs) && errs.length >= 1, '应有显式 error 记录可查询');
      const last = errs[errs.length - 1];
      assert(/github\.com/i.test(last.reason), '错误原因应指明仅支持 github.com：' + last.reason);
      assert(rt.mod.queueSize().errors === errs.length, 'queueSize().errors 应与 errorRecords 一致');
      assert(rt.mod.queueSize().pending === 0, 'error 记录不应滞留在待发队列');
      assert(r.skippedReason && /github\.com/i.test(r.skippedReason), 'flush 结果应体现未上送原因');
    } finally {
      await Promise.resolve(rt.fiber.dispose());
      await settle();
    }
  });
  await check('30s 定时器路径：低流量（< batchSize）滞留记录也会被兜底上送', async () => {
    const rt = await bootTrace({
      repoUrl: FAKE_REPO, maskEnabled: true, cacheDir: CACHE_DIR, token: FAKE_TOKEN, batchSize: 20,
    });
    try {
      setStatus(201);
      resetReceived();
      rt.mod.recordFeedback('read', 'positive', 'timer-flush');
      await settle();
      await sleep(50);
      assert(received.length === 0, `batchSize 未满足时不应上送，实际 ${received.length}`);
      assert(rt.mod.queueSize().pending === 1, '记录应滞留在队列');
      // 直驱 30s 定时器回调（真实 setInterval 无法被时间偏移驱动，故直接触发 tick）
      const entry = startedIntervals[startedIntervals.length - 1];
      assert(entry && entry.ms === 30_000, '应存在 30s 刷新定时器');
      entry.fn();
      await waitFor(() => received.length === 1, '定时器兜底上送');
      assert(rt.mod.queueSize().pending === 0, '兜底上送后队列应清空');
    } finally {
      await Promise.resolve(rt.fiber.dispose());
      await settle();
    }
  });

  await check('③PENDING_MAX 硬上限：极端滞留下 pending 不无界增长（丢最旧）', async () => {
    // repoUrl 有值但 token 缺（dev 常驻滞留场景）：recordFeedback 成功入队但 flush 不发送，
    // 以此制造远超上限的滞留量，验证 enqueue 的 while-shift 兜底截断。
    const cap = 2000; // 与源码 PENDING_MAX 常量保持一致（改动需同改两处）
    const rt = await bootTrace({
      repoUrl: FAKE_REPO, maskEnabled: true, cacheDir: CACHE_DIR, token: '', batchSize: 5,
    });
    try {
      setStatus(201); // 即便意外发送也返回成功，避免测试挂起
      const fill = cap + 75;
      for (let i = 0; i < fill; i++) rt.mod.recordFeedback('read', 'neutral', `cap-${i}`);
      await settle();
      const size = rt.mod.queueSize().pending;
      assert(size === cap,
        `滞留量应被截断到 PENDING_MAX(${cap})，实际 ${size}`);
      // 稳定性：再多塞也不超过上限
      for (let i = 0; i < 10; i++) rt.mod.recordFeedback('read', 'neutral', `cap-extra-${i}`);
      await settle();
      assert(rt.mod.queueSize().pending === cap, '超上限后不应继续增长');
    } finally {
      // 排空共享模块级 pending，避免污染后续用例（卸载用例 dispose 会用 token 兜底发送）
      const drain = await bootTrace({
        repoUrl: FAKE_REPO, maskEnabled: true, cacheDir: CACHE_DIR, token: FAKE_TOKEN, batchSize: 200,
      });
      try {
        setStatus(201);
        await drain.mod.flush();
        await waitFor(() => drain.mod.queueSize().pending === 0, 'PENDING_MAX 用例滞留记录排空');
      } finally {
        await Promise.resolve(drain.fiber.dispose());
        await settle();
      }
      await Promise.resolve(rt.fiber.dispose());
      await settle();
    }
  });

  // =========================================================================
  // 卸载：定时器清理（否则进程无法退出）
  // =========================================================================
  current = '卸载';
  await check('插件卸载时清理 30s 刷新定时器（无残留句柄）', async () => {
    const before = startedIntervals.length;
    const rt4 = await bootTrace({
      repoUrl: FAKE_REPO, maskEnabled: true, cacheDir: CACHE_DIR, token: FAKE_TOKEN, batchSize: 20,
    });
    assert(startedIntervals.length === before + 1, 'apply 应注册一个刷新定时器');
    const timerId = startedIntervals[startedIntervals.length - 1].id;
    await Promise.resolve(rt4.fiber.dispose());
    await settle();
    assert(clearedIntervals.includes(timerId), '卸载时未 clearInterval（定时器残留）');
  });

  // -------------------------------------------------------------------------
  // 收尾：恢复全局探针、关闭 mock 服务端点
  // -------------------------------------------------------------------------
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  Date.now = realNow;
  // 先断开 keep-alive 连接，防止 undici 连接池悬挂导致 close 不返回
  try { server.closeAllConnections(); } catch { /* 低版本 Node 无此 API */ }
  await new Promise((r) => server.close(r));
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error('异常:', e);
  globalThis.fetch = realFetch;
  try { server.closeAllConnections(); } catch { /* ignore */ }
  try { await new Promise((r) => server.close(r)); } catch { /* ignore */ }
  // 失败路径也要清理临时缓存目录
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
