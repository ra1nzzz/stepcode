/**
 * step-model-bridge 纯逻辑核对：GUI 模型配置 → Step 原生 models.json / auth.json。
 *
 * 这层是「设置页配的模型真的被回合使用」的唯一投影点。错一个字段名（例如把 Step 的
 * `providers` 写成数组、或把 `apiKey` 留在 models.json 而不是 auth.json），表现是
 * 回合静默用错凭据或不发请求——不是崩，所以必须有断言钉住形状。
 *
 * 只核对纯函数：require dist/step-model-bridge.js，不落盘、不起 electron。
 */
const assert = require('node:assert');

const b = require('./dist/step-model-bridge.js');

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}

const ollama = () => ({
  id: 'ollama-local', name: 'Ollama（本机）', type: 'ollama', apiMode: 'ollama',
  baseUrl: 'http://127.0.0.1:11434', models: ['qwen2.5-coder:7b'],
});

const openaiCompat = (over = {}) => ({
  id: 'my-openai', name: '我的 OpenAI', type: 'openai-compatible', apiMode: 'chat',
  baseUrl: 'https://api.example.com/v1', apiKey: 'probe-key', models: ['gpt-4o-mini'],
  ...over,
});

async function main() {
  console.log('== step-model-bridge 纯逻辑核对 ==');

  await check('providers 是对象而不是数组（Step 的 models.json 形状）', () => {
    const out = b.toStepModelsJson({ providers: [openaiCompat()] });
    assert.equal(Array.isArray(out.providers), false, 'providers 必须是对象');
    assert.deepStrictEqual(Object.keys(out.providers), ['my-openai']);
    assert.deepStrictEqual(out.providers['my-openai'].models, [{ id: 'gpt-4o-mini' }]);
  });

  await check('凭据只进 auth.json，不写进 models.json', () => {
    const cfg = { providers: [openaiCompat()] };
    assert.equal(JSON.stringify(b.toStepModelsJson(cfg)).includes('probe-key'), false,
      'models.json 不得出现明文 key');
    assert.deepStrictEqual(b.toStepAuthJson(cfg)['my-openai'], { type: 'api_key', key: 'probe-key' });
  });

  await check('Ollama 的 baseUrl 补 /v1（GUI 存的是不带 /v1 的根）', () => {
    const out = b.toStepModelsJson({ providers: [ollama()] });
    assert.equal(out.providers['ollama-local'].baseUrl, 'http://127.0.0.1:11434/v1');
  });

  await check('已带 /v1 的 Ollama baseUrl 不重复补', () => {
    const out = b.toStepModelsJson({ providers: [{ ...ollama(), baseUrl: 'http://127.0.0.1:11434/v1' }] });
    assert.equal(out.providers['ollama-local'].baseUrl, 'http://127.0.0.1:11434/v1');
  });

  await check('Ollama 无 key 时写占位凭据（Step 把无凭据的标记为不可用）', () => {
    const auth = b.toStepAuthJson({ providers: [ollama()] });
    assert.equal(auth['ollama-local'].key, b.OLLAMA_PLACEHOLDER_KEY);
  });

  await check('apiMode=responses 映射到 openai-responses，其余映射到 openai-completions', () => {
    const responses = b.toStepModelsJson({ providers: [openaiCompat({ apiMode: 'responses' })] });
    assert.equal(responses.providers['my-openai'].api, 'openai-responses');
    for (const mode of ['chat', 'completions', undefined]) {
      const out = b.toStepModelsJson({ providers: [openaiCompat({ apiMode: mode })] });
      assert.equal(out.providers['my-openai'].api, 'openai-completions', `apiMode=${mode} 应映射为 openai-completions`);
    }
  });

  await check('api 名只在 Step 支持的四种之内', () => {
    const supported = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
    const cfg = { providers: [ollama(), openaiCompat(), openaiCompat({ id: 'r', apiMode: 'responses' })] };
    for (const [id, p] of Object.entries(b.toStepModelsJson(cfg).providers)) {
      assert.ok(supported.has(p.api), `${id} 的 api=${p.api} 不在 Step 支持列表里`);
    }
  });

  await check('没有凭据的 openai-compatible 不写 auth（不能假装可用）', () => {
    const auth = b.toStepAuthJson({ providers: [openaiCompat({ apiKey: '' })] });
    assert.equal('my-openai' in auth, false);
  });

  await check('空壳提供商（无 id 或无模型）不写进 Step 目录', () => {
    const cfg = {
      providers: [
        { id: '', type: 'openai-compatible', baseUrl: 'https://x/v1', models: ['m'] },
        { id: 'no-models', type: 'openai-compatible', baseUrl: 'https://x/v1', models: [] },
        { id: 'blank-models', type: 'openai-compatible', baseUrl: 'https://x/v1', models: ['  '] },
        openaiCompat(),
      ],
    };
    const out = b.toStepModelsJson(cfg);
    assert.deepStrictEqual(Object.keys(out.providers), ['my-openai']);
  });

  await check('缺少 baseUrl 的条目不写（否则 Step 拿到空 baseUrl）', () => {
    const out = b.toStepModelsJson({ providers: [openaiCompat({ baseUrl: '' })] });
    assert.deepStrictEqual(Object.keys(out.providers), []);
  });

  await check('默认模型优先取 GUI 指定的提供商', () => {
    const cfg = { providers: [ollama(), openaiCompat()], defaultProvider: 'my-openai', defaultModel: 'gpt-4o-mini' };
    assert.deepStrictEqual(b.pickDefaultModel(cfg), { provider: 'my-openai', modelId: 'gpt-4o-mini' });
  });

  await check('默认模型不在该提供商列表内时退回其第一个模型', () => {
    const cfg = { providers: [openaiCompat()], defaultProvider: 'my-openai', defaultModel: '不存在的模型' };
    assert.deepStrictEqual(b.pickDefaultModel(cfg), { provider: 'my-openai', modelId: 'gpt-4o-mini' });
  });

  await check('未指定默认时取第一个可用提供商', () => {
    const cfg = { providers: [ollama(), openaiCompat()] };
    assert.deepStrictEqual(b.pickDefaultModel(cfg), { provider: 'ollama-local', modelId: 'qwen2.5-coder:7b' });
  });

  await check('一个可用提供商都没有时返回 undefined（调用方决定怎么报错）', () => {
    assert.equal(b.pickDefaultModel({ providers: [] }), undefined);
    assert.equal(b.pickDefaultModel({}), undefined);
  });

  await check('指纹：同配置稳定，换 key / 换模型 / 换提供商都变', () => {
    const base = { providers: [openaiCompat()], defaultProvider: 'my-openai', defaultModel: 'gpt-4o-mini' };
    const fp = b.configFingerprint(base);
    assert.equal(b.configFingerprint({ ...base }), fp, '同配置指纹必须稳定');
    assert.notEqual(b.configFingerprint({ providers: [openaiCompat({ apiKey: 'other-key' })], defaultProvider: 'my-openai', defaultModel: 'gpt-4o-mini' }), fp, '换 key 必须换指纹');
    assert.notEqual(b.configFingerprint({ providers: [openaiCompat({ models: ['gpt-4o'] })], defaultProvider: 'my-openai', defaultModel: 'gpt-4o' }), fp, '换模型必须换指纹');
    assert.notEqual(b.configFingerprint({ providers: [openaiCompat(), ollama()], defaultProvider: 'ollama-local', defaultModel: 'qwen2.5-coder:7b' }), fp, '换提供商必须换指纹');
  });

  await check('指纹不泄漏明文 key', () => {
    const fp = b.configFingerprint({ providers: [openaiCompat()] });
    assert.equal(fp.includes('probe-key'), false, '指纹里不得出现明文 key');
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  await check('指纹：改无关提供商不打断当前会话', () => {
    const base = { providers: [openaiCompat()], defaultProvider: 'my-openai', defaultModel: 'gpt-4o-mini' };
    const fp = b.configFingerprint(base);
    const withExtra = {
      providers: [openaiCompat(), { ...ollama(), apiKey: 'unrelated' }],
      defaultProvider: 'my-openai', defaultModel: 'gpt-4o-mini',
    };
    assert.equal(b.configFingerprint(withExtra), fp, '只增加无关提供商不应换指纹');
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
  if (failed > 0) process.exit(1);
  console.log('MODEL_BRIDGE_OK');
  process.exit(0);
}

main();
