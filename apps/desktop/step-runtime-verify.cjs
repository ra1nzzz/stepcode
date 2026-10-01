/**
 * 包内运行时必须真的能加载。
 * 此前直接拷 packages/*\/dist 会 ERR_MODULE_NOT_FOUND（裸导入没有 node_modules 可解析），
 * 这个检查就是为了不再退回去：产物自包含，剩下的外部依赖必须真的解析得到。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const seam = require('./dist/step-extension.js');
const ROOT = path.join(__dirname, 'vendor', 'step');
const ENTRY = path.join(ROOT, 'index.js');
/** 包外的依赖，按相对路径放在 runtime/ 下；叫 node_modules 会被 electron-builder 滤掉。 */
const ALLOWED_EXTERNALS = ['runtime/jiti', 'runtime/photon-node'];

let failed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => console.log('  PASS  ' + name),
        (err) => { failed += 1; console.log('  FAIL  ' + name); console.log('        ' + err.message); },
      );
    }
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

function shippedExternals() {
  return fs.readdirSync(path.join(ROOT, 'runtime')).map((n) => 'runtime/' + n).sort();
}

/** 产物里的相对导入必须真的落在磁盘上。 */
function relativeImports() {
  const src = fs.readFileSync(ENTRY, 'utf8');
  return [...new Set([...src.matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map((m) => m[1]))].sort();
}

async function main() {
  await check('包内运行时是自包含产物', () => {
    assert.ok(fs.existsSync(ENTRY), '缺少 ' + ENTRY);
    assert.ok(fs.statSync(ENTRY).size > 1024 * 1024, '产物过小，可能只拷了未打包的 dist');
    assert.ok(!fs.existsSync(path.join(ROOT, 'packages')), '不该再拷 packages 树');
  });

  await check('随包的外部依赖只有约定中的几个', () => {
    assert.deepEqual(shippedExternals(), ALLOWED_EXTERNALS.slice().sort());
  });

  await check('产物里的相对导入都落在磁盘上', () => {
    const imports = relativeImports();
    assert.ok(imports.length > 0, '没有相对导入，说明外部依赖被内联或路径写错');
    for (const spec of imports) {
      const target = path.resolve(ROOT, spec);
      assert.ok(fs.existsSync(target), `缺少 ${spec}`);
    }
  });

  await check('包内的外部依赖真的能加载', async () => {
    const mod = await import(pathToFileURL(path.join(ROOT, 'runtime/jiti/lib/jiti-static.mjs')).href);
    assert.equal(typeof mod.createJiti, 'function');
  });

  await check('包内运行时带来源清单', () => {
    const origin = JSON.parse(fs.readFileSync(path.join(ROOT, 'step-origin.json'), 'utf8'));
    assert.equal(origin.source, seam.OFFICIAL_STEP_SOURCE);
    assert.equal(origin.commit, seam.STEP_LOCK_COMMIT);
  });

  await check('经加载器能解析出接缝', async () => {
    const loaded = await seam.loadStepRuntime(ROOT, { nodeVersion: '22.19.0' });
    assert.equal(typeof loaded.createStepExtensionInline, 'function');
  });

  await check('包内运行时按 ESM 解析', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
  });

  if (failed) {
    console.log('FAIL ' + failed);
    process.exit(1);
  }
  console.log('packaged runtime checks passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
