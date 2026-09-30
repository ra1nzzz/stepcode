/**
 * models.dev 目录 + 可用模型拉取验证（方案 A 双源合并）
 * ----------------------------------------------------------------------------
 * 覆盖：
 *   A. parseCatalog —— api.json → 内部结构（id/name/ctx/price/caps），脏数据跳过
 *   B. extractModelIds —— {data:[{id}]} / {models:[{id|name}]} / 纯数组 / ollama 优先级 / 空→null
 *   C. matchProvider —— presetId 精确 → URL 主机名（协议/端口/尾斜杠变体）→ 名称归一化 → null
 *   D. enrichModels —— 精确 → 后缀 → 包含三级匹配；不重复占用；未命中原样；enriched 标记
 *   E. fetchLiveModels（127.0.0.1 真 HTTP stub）—— openai 形态+Authorization 头 canary、
 *      401→auth、404→no-endpoint、ollama /api/tags 404→回退 /v1/models、断网→network、垃圾→shape
 *   F. listAvailableModels 编排 —— live+matched→mixed、live 无匹配→live、live 失败+matched→catalog、
 *      两者皆无→ok:false 带中文 reason
 *   G. 缓存 —— 写入即读、TTL 24h 过期重拉（stub 计数）、提供商 <10 的坏缓存忽略
 *
 * 运行：node model-catalog-verify.cjs   （ts-loader 直测 TS 源码，无需先 tsc）
 */

const assert = require('node:assert');
const http = require('node:http');
const { importTs } = require('./scripts/ts-load.cjs');

let pass = 0, fail = 0;
function check(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') { throw new Error('check 同步函数不应返回 Promise'); } pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; console.log(`  FAIL  ${name}\n        ${(err && err.stack || err).toString().split('\n').slice(0, 3).join('\n        ')}`); }
}
async function checkA(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; console.log(`  FAIL  ${name}\n        ${(err && err.stack || err).toString().split('\n').slice(0, 3).join('\n        ')}`); }
}

/* ---------- 测试内 cache/fetch 桩（内存文件 + 可控 fetch，支持多路由） ---------- */
function makeStubs() {
  const files = new Map();
  let now = 1_000_000;
  const fetchLog = [];
  const routes = [];
  const stubs = {
    files,
    fetchLog,
    now: () => now,
    advance: (ms) => { now += ms; },
    readFile: (p) => { if (!files.has(p)) { const e = new Error('ENOENT'); throw e; } return files.get(p); },
    writeFile: (p, data) => { files.set(p, data); },
    fetchImpl: async (url, init) => {
      fetchLog.push({ url: String(url), auth: init && init.headers && init.headers.Authorization });
      for (const [prefix, handler] of routes) {
        if (String(url).startsWith(prefix)) return handler(String(url), init);
      }
      throw new Error('stub fetch 未注册该 URL：' + url);
    },
    route: (urlPrefix, handler) => { routes.push([urlPrefix, handler]); },
  };
  return stubs;
}

const CATALOG_FIXTURE = {
  openai: {
    id: 'openai', name: 'OpenAI', api: 'https://api.openai.com/v1', doc: 'https://platform.openai.com/docs', env: ['OPENAI_API_KEY'],
    models: {
      'openai/gpt-5': { id: 'openai/gpt-5', name: 'GPT-5', limit: { context: 400000 }, cost: { input: 1.25, output: 10 }, tool_call: true, reasoning: true },
      'openai/gpt-4o': { id: 'openai/gpt-4o', name: 'GPT-4o', limit: { context: 128000 }, cost: { input: 2.5, output: 10 }, tool_call: true },
      'openai/whisper-1': { id: 'openai/whisper-1', name: 'Whisper', limit: {} },
    },
  },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', api: 'https://api.deepseek.com/v1',
    models: { 'deepseek/deepseek-chat': { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', limit: { context: 128000 }, cost: { input: 0.27, output: 1.1 } } },
  },
  ollama: {
    id: 'ollama', name: 'Ollama', api: 'http://localhost:11434/v1',
    models: { 'ollama/qwen3:8b': { id: 'ollama/qwen3:8b', name: 'Qwen3 8B', limit: { context: 131072 } } },
  },
  // 以下为满足「提供商 ≥10 才认目录」防截断下限的填充项（模块对真 api.json 的防御）
  moonshotai: { id: 'moonshotai', name: 'Moonshot AI', api: 'https://api.moonshot.cn/v1', models: { 'moonshotai/kimi-k2': { id: 'moonshotai/kimi-k2', name: 'Kimi K2', limit: { context: 262144 } } } },
  zhipuai: { id: 'zhipuai', name: 'Zhipu AI', api: 'https://open.bigmodel.cn/api/paas/v4', models: { 'zhipuai/glm-5': { id: 'zhipuai/glm-5', name: 'GLM-5', limit: { context: 204800 } } } },
  alibaba: { id: 'alibaba', name: 'Alibaba', api: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: { 'alibaba/qwen3-max': { id: 'alibaba/qwen3-max', name: 'Qwen3 Max', limit: { context: 262144 } } } },
  xai: { id: 'xai', name: 'xAI', api: 'https://api.x.ai/v1', models: { 'xai/grok-4': { id: 'xai/grok-4', name: 'Grok 4', limit: { context: 256000 } } } },
  anthropic: { id: 'anthropic', name: 'Anthropic', api: 'https://api.anthropic.com/v1', models: { 'anthropic/claude-opus-4': { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', limit: { context: 200000 } } } },
  google: { id: 'google', name: 'Google', api: 'https://generativelanguage.googleapis.com/v1beta', models: { 'google/gemini-2.5-pro': { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', limit: { context: 1048576 } } } },
  meta: { id: 'meta', name: 'Meta', api: 'https://api.llama.com/v1', models: { 'meta/llama-4': { id: 'meta/llama-4', name: 'Llama 4', limit: { context: 1048576 } } } },
  openrouter: { id: 'openrouter', name: 'OpenRouter', api: 'https://openrouter.ai/api/v1', models: { 'openrouter/auto': { id: 'openrouter/auto', name: 'Auto Router', limit: { context: 128000 } } } },
};

(async () => {
  const MC = await importTs('model-catalog.ts');

  /* ================= A. parseCatalog ================= */
  check('A1 api.json → 内部结构：id/name/ctx/price/caps 正确映射', () => {
    const ps = MC.parseCatalog(CATALOG_FIXTURE);
    assert.ok(ps.length >= 10, 'fixture 提供商数应 ≥10（防截断下限）');
    const oa = ps.find((p) => p.id === 'openai');
    assert.strictEqual(oa.name, 'OpenAI');
    assert.strictEqual(oa.api, 'https://api.openai.com/v1');
    assert.deepStrictEqual(oa.env, ['OPENAI_API_KEY']);
    assert.strictEqual(oa.models.length, 3);
    const g5 = oa.models.find((m) => m.id === 'openai/gpt-5');
    assert.strictEqual(g5.ctx, 400000);
    assert.strictEqual(g5.priceIn, 1.25);
    assert.strictEqual(g5.priceOut, 10);
    assert.deepStrictEqual(g5.caps, ['tool_call', 'reasoning']);
    const w = oa.models.find((m) => m.id === 'openai/whisper-1');
    assert.strictEqual(w.ctx, undefined, '无 limit 不应伪造 ctx');
    assert.strictEqual(w.caps, undefined);
  });
  check('A2 脏数据（非对象/坏 models）不崩且跳过', () => {
    const ps = MC.parseCatalog({ bad: null, worse: 'x', ok: { name: 'Ok', models: { 'ok/a': { name: 'A' }, 'ok/b': 42 } } });
    assert.strictEqual(ps.length, 1);
    assert.strictEqual(ps[0].models.length, 1);
    assert.strictEqual(MC.parseCatalog(null).length, 0);
    assert.strictEqual(MC.parseCatalog('nope').length, 0);
  });

  /* ================= B. extractModelIds ================= */
  check('B1 {data:[{id}]} / {models:[{id|name}]} / 纯数组 三形态', () => {
    assert.deepStrictEqual(MC.extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] }, 'openai-compatible'), ['a', 'b']);
    assert.deepStrictEqual(MC.extractModelIds({ models: [{ name: 'qwen3:8b' }] }, 'ollama'), ['qwen3:8b']);
    assert.deepStrictEqual(MC.extractModelIds(['x', 'y'], 'openai-compatible'), ['x', 'y']);
  });
  check('B2 ollama 优先 models 键；空数组→null；缺 id/name 的条目跳过', () => {
    assert.deepStrictEqual(MC.extractModelIds({ models: [{ name: 'm1' }], data: [{ id: 'd1' }] }, 'ollama'), ['m1']);
    assert.strictEqual(MC.extractModelIds({ data: [] }, 'openai-compatible'), null);
    assert.deepStrictEqual(MC.extractModelIds({ data: [{ id: 'ok' }, { foo: 1 }] }, 'openai-compatible'), ['ok']);
    assert.strictEqual(MC.extractModelIds({}, 'openai-compatible'), null);
  });

  /* ================= C. matchProvider ================= */
  check('C1 presetId 精确优先于其它', () => {
    const ps = MC.parseCatalog(CATALOG_FIXTURE);
    assert.strictEqual(MC.matchProvider(ps, { presetId: 'deepseek', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI' }).id, 'deepseek');
  });
  check('C2 URL 主机名匹配容忍协议/端口/尾斜杠/路径', () => {
    const ps = MC.parseCatalog(CATALOG_FIXTURE);
    for (const url of ['https://api.openai.com/v1', 'http://api.openai.com:8443/v1/', 'api.openai.com', 'HTTPS://API.OPENAI.COM/v1']) {
      assert.strictEqual(MC.matchProvider(ps, { baseUrl: url }).id, 'openai', `应匹配 openai：${url}`);
    }
    assert.strictEqual(MC.matchProvider(ps, { baseUrl: 'https://api.deepseek.com' }).id, 'deepseek');
  });
  check('C3 名称归一化匹配 + 无可匹配返回 null', () => {
    const ps = MC.parseCatalog(CATALOG_FIXTURE);
    assert.strictEqual(MC.matchProvider(ps, { name: ' 深Seek ' }).id, 'deepseek');
    assert.strictEqual(MC.matchProvider(ps, { name: 'OpenAI 兼容网关' }).id, 'openai', '包含式归一化匹配');
    assert.strictEqual(MC.matchProvider(ps, { baseUrl: 'http://127.0.0.1:9999', name: '某自建网关' }), null);
    assert.strictEqual(MC.matchProvider([], { presetId: 'openai' }), null);
  });

  /* ================= D. enrichModels ================= */
  check('D1 精确 → 后缀 → 包含三级匹配 + enriched 标记', () => {
    const ps = MC.parseCatalog(CATALOG_FIXTURE);
    const oa = ps.find((p) => p.id === 'openai');
    const r = MC.enrichModels(['gpt-4o', 'openai/gpt-5', 'whisper'], oa);
    assert.strictEqual(r[0].id, 'gpt-4o');
    assert.strictEqual(r[0].name, 'GPT-4o');
    assert.strictEqual(r[0].enriched, true);
    assert.strictEqual(r[1].id, 'openai/gpt-5');
    assert.strictEqual(r[1].ctx, 400000);
    assert.strictEqual(r[2].enriched, true, 'whisper 包含式命中 whisper-1');
  });
  check('D2 同一目录项不被两个 live id 重复占用；未命中原样保留', () => {
    const ps = MC.parseCatalog(CATALOG_FIXTURE);
    const oa = ps.find((p) => p.id === 'openai');
    const r = MC.enrichModels(['gpt-4o', 'gpt-4o-mini-clone'], oa);
    assert.strictEqual(r[0].enriched, true);
    assert.strictEqual(r[1].enriched, undefined, '第二个近似 id 不得抢占同一目录项');
    const r2 = MC.enrichModels(['my-private-model'], null);
    assert.deepStrictEqual(r2, [{ id: 'my-private-model' }]);
  });

  /* ================= E. fetchLiveModels（真 HTTP stub） ================= */
  function stubServer(handler) {
    return new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
    });
  }
  const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  await checkA('E1 openai 形态：URL/Authorization 头（canary）/解析', async () => {
    const { srv, base } = await stubServer((req, res) => {
      assert.strictEqual(req.url, '/v1/models');
      assert.strictEqual(req.headers.authorization, 'Bearer sk-canary-123');
      sendJson(res, 200, { object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-5' }] });
    });
    const r = await MC.fetchLiveModels({ type: 'openai-compatible', baseUrl: base + '/v1', apiKey: 'sk-canary-123' }, globalThis.fetch);
    assert.deepStrictEqual(r, { ok: true, ids: ['gpt-4o', 'gpt-5'] });
    srv.close();
  });

  await checkA('E2 401 → auth；429 → rate-limit；500 → server；404 → no-endpoint', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limit'], [503, 'server'], [404, 'no-endpoint']]) {
      const { srv, base } = await stubServer((req, res) => sendJson(res, status, { error: 'x' }));
      const r = await MC.fetchLiveModels({ type: 'openai-compatible', baseUrl: base, apiKey: 'k' }, globalThis.fetch);
      assert.deepStrictEqual(r, { ok: false, kind, status }, `status ${status} 应分类为 ${kind}`);
      srv.close();
    }
  });

  await checkA('E3 ollama /api/tags 404 → 回退 /v1/models 且成功', async () => {
    const { srv, base } = await stubServer((req, res) => {
      if (req.url === '/api/tags') { sendJson(res, 404, {}); return; }
      assert.strictEqual(req.url, '/v1/models');
      assert.strictEqual(req.headers.authorization, undefined, 'ollama 不应带 Authorization');
      sendJson(res, 200, { data: [{ id: 'qwen3:8b' }] });
    });
    const r = await MC.fetchLiveModels({ type: 'ollama', baseUrl: base }, globalThis.fetch);
    assert.deepStrictEqual(r, { ok: true, ids: ['qwen3:8b'] });
    srv.close();
  });

  await checkA('E4 端口无人监听 → network；200 但非 JSON → shape', async () => {
    const dead = await stubServer((req, res) => res.end('not-json'));
    // 先起一个真服务占端口，再关掉，拿一个必拒的端口
    const port = dead.srv.address().port;
    dead.srv.close();
    await new Promise((r) => setTimeout(r, 50));
    const r1 = await MC.fetchLiveModels({ type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k' }, globalThis.fetch);
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.kind, 'network');
    const { srv, base } = await stubServer((req, res) => { res.writeHead(200); res.end('<html>nope'); });
    const r2 = await MC.fetchLiveModels({ type: 'openai-compatible', baseUrl: base, apiKey: 'k' }, globalThis.fetch);
    assert.deepStrictEqual(r2, { ok: false, kind: 'shape' });
    srv.close();
  });

  /* ================= F. listAvailableModels 编排 ================= */
  await checkA('F1 live 成功 + 目录匹配 → mixed（带元数据与 matched）', async () => {
    const s = makeStubs();
    s.route('https://models.dev/api.json', async () => ({ ok: true, status: 200, json: async () => CATALOG_FIXTURE }));
    MC.initModelCatalog({ cacheDir: 'C:/fake/cache', fetchImpl: s.fetchImpl, now: s.now, readFile: s.readFile, writeFile: s.writeFile });
    s.route('https://api.openai.com/v1/models', async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'gpt-5' }] }) }));
    const r = await MC.listAvailableModels({ type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, 'mixed');
    assert.strictEqual(r.matched.id, 'openai');
    assert.strictEqual(r.models[0].name, 'GPT-4o');
    assert.strictEqual(r.models[1].ctx, 400000, 'gpt-5 后缀命中 openai/gpt-5');
  });

  await checkA('F2 live 成功 + 无目录匹配 → live（原样 id）', async () => {
    const s = makeStubs();
    MC.initModelCatalog({ cacheDir: 'C:/fake/cache', fetchImpl: s.fetchImpl, now: s.now, readFile: s.readFile, writeFile: s.writeFile });
    s.route('https://models.dev/api.json', async () => ({ ok: true, status: 200, json: async () => CATALOG_FIXTURE }));
    s.route('http://127.0.0.1:1/models', async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'my-gw-1' }] }) }));
    const r = await MC.listAvailableModels({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
    assert.strictEqual(r.source, 'live');
    assert.deepStrictEqual(r.models, [{ id: 'my-gw-1' }]);
    assert.strictEqual(r.matched, undefined);
  });

  await checkA('F3 live 失败 + 目录匹配 → catalog 回退（中文 reason 不带出）', async () => {
    const s = makeStubs();
    MC.initModelCatalog({ cacheDir: 'C:/fake/cache', fetchImpl: s.fetchImpl, now: s.now, readFile: s.readFile, writeFile: s.writeFile });
    s.route('https://models.dev/api.json', async () => ({ ok: true, status: 200, json: async () => CATALOG_FIXTURE }));
    s.route('https://api.deepseek.com/v1/models', async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const r = await MC.listAvailableModels({ type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'bad' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, 'catalog');
    assert.strictEqual(r.matched.id, 'deepseek');
    assert.ok(r.models.some((m) => m.id === 'deepseek/deepseek-chat'));
  });

  await checkA('F4 live 失败 + 无匹配 → ok:false + 可读 reason', async () => {
    const s = makeStubs();
    MC.initModelCatalog({ cacheDir: 'C:/fake/cache', fetchImpl: s.fetchImpl, now: s.now, readFile: s.readFile, writeFile: s.writeFile });
    s.route('https://models.dev/api.json', async () => ({ ok: true, status: 200, json: async () => CATALOG_FIXTURE }));
    s.route('http://10.255.255.1:9/models', async () => { throw new TypeError('fetch failed'); });
    const r = await MC.listAvailableModels({ type: 'openai-compatible', baseUrl: 'http://10.255.255.1:9', apiKey: 'k' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, '网络不可达');
  });

  /* ================= G. 缓存 ================= */
  await checkA('G1 写入即读；TTL 24h 内不重拉；过期重拉（stub 计数）', async () => {
    const s = makeStubs();
    MC.initModelCatalog({ cacheDir: 'C:/fake/cache', fetchImpl: s.fetchImpl, now: s.now, readFile: s.readFile, writeFile: s.writeFile });
    let catalogCalls = 0;
    s.route('https://models.dev/api.json', async () => { catalogCalls++; return { ok: true, status: 200, json: async () => CATALOG_FIXTURE }; });
    const r1 = await MC.getCatalogPresets();
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(catalogCalls, 1, '首次应联网');
    assert.ok(s.files.has('C:/fake/cache/models-dev-catalog.json'), '应落缓存文件');
    const r2 = await MC.getCatalogPresets();
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(catalogCalls, 1, '缓存新鲜不应重拉');
    s.advance(25 * 60 * 60 * 1000);
    const r3 = await MC.getCatalogPresets();
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(catalogCalls, 2, '超过 24h 应重拉');
    // 预排序稳定（按 name localeCompare 升序，且全量在列）
    const names = r3.providers.map((p) => p.name);
    assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
    assert.ok(names.includes('OpenAI') && names.includes('Zhipu AI'));
    assert.strictEqual(r3.providers.find((p) => p.id === 'openai').modelCount, 3);
  });

  await checkA('G2 坏缓存（提供商 <10 / 缺 fetchedAt）忽略并重拉；目录不可用 → ok:false 带 reason', async () => {
    const s = makeStubs();
    MC.initModelCatalog({ cacheDir: 'C:/fake/cache', fetchImpl: s.fetchImpl, now: s.now, readFile: s.readFile, writeFile: s.writeFile });
    s.writeFile('C:/fake/cache/models-dev-catalog.json', JSON.stringify({ fetchedAt: s.now(), providers: [{ id: 'a', name: 'A', models: [] }] }));
    let calls = 0;
    s.route('https://models.dev/api.json', async () => { calls++; return { ok: true, status: 200, json: async () => CATALOG_FIXTURE }; });
    await MC.getCatalogPresets();
    assert.strictEqual(calls, 1, '提供商 <10 的坏缓存必须忽略');
    // 目录彻底不可用
    const s2 = makeStubs();
    MC.initModelCatalog({ cacheDir: 'C:/fake/cache2', fetchImpl: s2.fetchImpl, now: s2.now, readFile: s2.readFile, writeFile: s2.writeFile });
    s2.route('https://models.dev/api.json', async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const r = await MC.getCatalogPresets();
    assert.strictEqual(r.ok, false);
    assert.ok(/目录不可用/.test(r.reason), 'reason 应可读：' + r.reason);
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败, 共 ${pass + fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('套件崩溃：', err); process.exit(1); });
