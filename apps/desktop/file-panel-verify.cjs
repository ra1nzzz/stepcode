/**
 * 文件 Tab 验证（吸收计划 P2-11 · 只读优先）
 * ----------------------------------------------------------------------------
 *   A. 纯逻辑（TS 直测）：参数校验、语言/二进制探测、排序、大小格式化。
 *   B. 接线（stub electron 驱动真实 dist/main.js）：file-tree / file-read 对
 *      真实临时目录生效——目录排序、截断显式、二进制不吐内容、错误有原因。
 *
 * 运行：node file-panel-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const APP_DIR = __dirname;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-filepanel-'));
process.env.ORCHDESK_HOME = HOME;

const { importTs } = require('./scripts/ts-load.cjs');
const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');
const { check, summary } = createChecker();

(async () => {
  // =========================================================================
  console.log('== A. 纯逻辑 ==');
  const fp = await importTs('file-panel.ts');

  await check('file-tree 归一化：相对路径 / 空 dir / 超长被拒（不猜）', () => {
    assert.strictEqual(fp.normalizeFileTree({ dir: 'sub/dir' }).ok, false);
    assert.ok(fp.normalizeFileTree({}).reason.includes('dir'));
    assert.strictEqual(fp.normalizeFileTree({ dir: 'D:/' + 'a'.repeat(3000) }).ok, false);
    const r = fp.normalizeFileTree({ dir: 'D:/proj', depth: '3' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.depth, 3);
  });

  await check('file-read 归一化：绝对路径放行，缺 path / 相对路径拒绝', () => {
    const r = fp.normalizeFileRead({ path: 'D:/proj/index.ts' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.maxBytes, fp.FILE_READ_MAX_BYTES);
    assert.strictEqual(fp.normalizeFileRead({}).ok, false);
    assert.strictEqual(fp.normalizeFileRead({ path: 'x.ts' }).ok, false);
  });

  await check('语言探测：常见扩展映射，未知/无扩展 → null（渲染层不许猜）', () => {
    assert.strictEqual(fp.languageOf('app.ts'), 'typescript');
    assert.strictEqual(fp.languageOf('comp.tsx'), 'tsx');
    assert.strictEqual(fp.languageOf('README.md'), 'markdown');
    assert.strictEqual(fp.languageOf('style.SCSS'), 'scss', '扩展名不区分大小写');
    assert.strictEqual(fp.languageOf('Makefile'), null);
    assert.strictEqual(fp.languageOf('a.unknownext'), null);
  });

  await check('二进制探测：扩展名快通道 + NUL 内容嗅探（只看头 8KB）', () => {
    assert.strictEqual(fp.looksBinaryByName('logo.png'), true);
    assert.strictEqual(fp.looksBinaryByName('app.dll'), true);
    assert.strictEqual(fp.looksBinaryByName('data.txt'), false);
    assert.strictEqual(fp.sniffBinary(new TextEncoder().encode('hello world')), false);
    const withNul = new Uint8Array(16);
    withNul[4] = 0;
    assert.strictEqual(fp.sniffBinary(withNul), true, '头部 NUL → 二进制');
    const tailNul = new Uint8Array(9000).fill(0x41); // 先填满非零，否则默认全 0 本身就是 NUL
    tailNul[8500] = 0;
    assert.strictEqual(fp.sniffBinary(tailNul), false, '8KB 窗口外的 NUL 不判二进制');
  });

  await check('排序：目录在前、名称不区分大小写升序、带 ext/binary 标注', () => {
    const sorted = fp.sortTreeEntries([
      { name: 'zebra.txt', kind: 'file', size: 1, mtime: 0 },
      { name: 'Beta', kind: 'dir', size: 0, mtime: 0 },
      { name: 'apple.md', kind: 'file', size: 2, mtime: 0 },
      { name: 'alpha', kind: 'dir', size: 0, mtime: 0 },
    ]);
    assert.deepStrictEqual(sorted.map((e) => e.name), ['alpha', 'Beta', 'apple.md', 'zebra.txt']);
    assert.strictEqual(sorted[2].ext, 'md');
    assert.strictEqual(sorted[3].binary, false);
    assert.strictEqual(sorted[0].ext, '', '目录没有 ext');
  });

  await check('排序：单目录条目数按上限裁剪（防巨型目录拖垮渲染层）', () => {
    const many = [];
    for (let i = 0; i < fp.FILE_TREE_MAX_ENTRIES + 100; i++) {
      many.push({ name: 'f' + i + '.txt', kind: 'file', size: 1, mtime: 0 });
    }
    assert.strictEqual(fp.sortTreeEntries(many).length, fp.FILE_TREE_MAX_ENTRIES);
  });

  await check('humanSize：B/KB/MB/GB 阶梯，非法输入给 ?（不抛异常）', () => {
    assert.strictEqual(fp.humanSize(512), '512 B');
    assert.strictEqual(fp.humanSize(2048), '2.0 KB');
    assert.strictEqual(fp.humanSize(5 * 1024 * 1024), '5.0 MB');
    assert.ok(fp.humanSize(3 * 1024 * 1024 * 1024).includes('GB'));
    assert.strictEqual(fp.humanSize(-1), '?');
    assert.strictEqual(fp.humanSize(NaN), '?');
  });

  await check('扩展名探测只看 basename（路径里的带点目录不许击穿）', () => {
    // 直接对整个路径 lastIndexOf('.') 会取到 "example/src/app.ts"，
    // 于是语言探测返回 null（高亮静默降级）、二进制快通道失效（丢一道写保护）。
    assert.strictEqual(fp.languageOf('D:/proj/com.example/src/app.ts'), 'typescript');
    assert.strictEqual(fp.languageOf('D:/proj/v1.2.3/notes.md'), 'markdown');
    assert.strictEqual(fp.looksBinaryByName('C:/a.b/logo.png'), true);
    assert.strictEqual(fp.looksBinaryByName('C:/a.b/app.ts'), false);
    // 以点开头的文件名（.gitignore）不算扩展名
    assert.strictEqual(fp.languageOf('/repo/.gitignore'), null);
  });

  await check('sortTreeEntries 直接给出 sizeLabel（humanSize 是唯一真源）', () => {
    const out = fp.sortTreeEntries([
      { name: 'a.txt', kind: 'file', size: 2048, mtime: 1 },
      { name: 'sub', kind: 'dir', size: 0, mtime: 1 },
    ]);
    assert.strictEqual(out[0].name, 'sub', '目录在前');
    assert.strictEqual(out[0].sizeLabel, '', '目录不显示大小');
    assert.strictEqual(out[1].sizeLabel, '2.0 KB');
    assert.strictEqual(out[1].ext, 'txt');
    assert.strictEqual(out[1].binary, false);
  });

  await check('clampInt 收敛后口径一致（空串/纯空格/负值都回落默认）', async () => {
    const ct = await importTs('common-tools.ts');
    assert.strictEqual(ct.clampInt('', 1, 10, 5), 5);
    assert.strictEqual(ct.clampInt('   ', 1, 10, 5), 5, '纯空格不能当 0');
    assert.strictEqual(ct.clampInt(undefined, 1, 10, 5), 5);
    assert.strictEqual(ct.clampInt('3', 1, 10, 5), 3);
    assert.strictEqual(ct.clampInt(99, 1, 10, 5), 10, '上限钳制');
    assert.strictEqual(ct.isAbsoluteLike('D:/a'), true);
    assert.strictEqual(ct.isAbsoluteLike('a/b'), false);
    assert.strictEqual(ct.extOfName('D:/p/com.example/a.TS'), 'ts', '大小写归一');
  });

  // =========================================================================
  console.log('== B. 接线：stub electron 驱动 dist/main.js ==');
  const electronStub = makeElectronStub({ home: HOME });
  const ipcHandlers = electronStub.ipcHandlers;
  const ready = new Promise((r) => { electronStub.app.whenReady = () => { setImmediate(r); return Promise.resolve(); }; });

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electronStub;
    return origLoad.apply(this, arguments);
  };
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) });

  require('./dist/main.js');
  await ready;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (ipcHandlers.has('orchdesk:plugin-runtime')) {
      const st = await ipcHandlers.get('orchdesk:plugin-runtime')(null);
      if (st && st.ready === false) break;
    }
  }

  // 临时目录：sub/（目录）+ b.md + a.txt（中英文）+ logo.png（假二进制）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-files-'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'b.md'), '# 标题\n内容', 'utf-8');
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello 世界', 'utf-8');
  fs.writeFileSync(path.join(root, 'app.js'), 'const x = 1;', 'utf-8');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]), Buffer.alloc(64)]);
  fs.writeFileSync(path.join(root, 'logo.png'), png);
  const bigBuf = Buffer.alloc(fp.FILE_READ_MAX_BYTES + 1024, 0x61);
  fs.writeFileSync(path.join(root, 'big.log'), bigBuf);
  fs.writeFileSync(path.join(root, 'nul-late.txt'), Buffer.concat([Buffer.alloc(9000, 0x41)]));

  const fileTree = (dir) => ipcHandlers.get('orchdesk:file-tree')(null, { dir });
  const fileRead = (p) => ipcHandlers.get('orchdesk:file-read')(null, { path: p });

  await check('file-tree：目录在前排序 + size/mtime 真实', async () => {
    const r = await fileTree(root);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.dir, root);
    assert.strictEqual(r.truncated, false);
    const names = r.entries.map((e) => e.name);
    assert.ok(names.indexOf('sub') === 0, '目录应在最前：' + names.join(','));
    assert.ok(names.indexOf('a.txt') < names.indexOf('b.md'));
    const a = r.entries.find((e) => e.name === 'a.txt');
    assert.strictEqual(a.kind, 'file');
    assert.strictEqual(a.size, Buffer.byteLength('hello 世界', 'utf-8'), 'UTF-8 字节数');
    assert.ok(a.mtime > 0);
  });

  await check('file-tree：二进制标注 / ext 标注随条目返回', async () => {
    const r = await fileTree(root);
    const logo = r.entries.find((e) => e.name === 'logo.png');
    assert.strictEqual(logo.binary, true);
    assert.strictEqual(logo.ext, 'png');
  });

  await check('file-tree：坏输入给明确 reason（不抛未捕获异常）', async () => {
    const r1 = await fileTree('relative/path');
    assert.strictEqual(r1.ok, false);
    assert.ok(r1.reason.includes('绝对路径'));
    const r2 = await fileTree(path.join(root, 'no-such-dir'));
    assert.strictEqual(r2.ok, false, '不存在的目录应报错');
    assert.ok(r2.reason && r2.reason.length > 0);
  });

  await check('file-read：文本内容 + 语言探测 + 大小标签', async () => {
    const r = await fileRead(path.join(root, 'app.js'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.binary, false);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.content, 'const x = 1;');
    assert.strictEqual(r.lang, 'javascript');
    assert.ok(r.sizeLabel.endsWith('B'));
  });

  await check('file-read：中文按 UTF-8 原样读回（不乱码）', async () => {
    const r = await fileRead(path.join(root, 'a.txt'));
    assert.strictEqual(r.content, 'hello 世界');
    assert.strictEqual(r.lang, 'plaintext');
  });

  await check('file-read：二进制只给元信息不吐内容（图片不进文本通道）', async () => {
    const r = await fileRead(path.join(root, 'logo.png'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.binary, true);
    assert.strictEqual(r.content, '');
    assert.strictEqual(r.lang, null);
    assert.strictEqual(r.size, png.length);
  });

  await check('file-read：超限显式 truncated（不静默），且内容不超上限', async () => {
    const r = await fileRead(path.join(root, 'big.log'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.binary, false);
    assert.strictEqual(r.truncated, true, 'stat.size > maxBytes 必须显式标记');
    assert.ok(Buffer.byteLength(r.content, 'utf-8') <= fp.FILE_READ_MAX_BYTES, '内容不得超上限');
    assert.strictEqual(r.lang, null, '.log 无映射 → 纯文本');
  });

  await check('file-read：目录 / 不存在的文件 → 明确 reason', async () => {
    const r1 = await fileRead(root);
    assert.strictEqual(r1.ok, false);
    assert.ok(r1.reason.includes('目录'));
    const r2 = await fileRead(path.join(root, 'ghost.txt'));
    assert.strictEqual(r2.ok, false);
    assert.ok(r2.reason.length > 0);
  });

  await check('file-read：合法含 U+FFFD 的文本不得被判「非 UTF-8」（不许误禁编辑）', async () => {
    // 「解出 U+FFFD 就判定非 UTF-8」会把本来就含替代字符的合法文本误判，
    // 结果是可编辑的文件被禁掉编辑——必须用 TextDecoder(fatal) 严格校验。
    const p = path.join(root, 'replacement.txt');
    fs.writeFileSync(p, 'prefix ' + '�' + ' suffix\n', 'utf8');
    const r = await fileRead(p);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.encodingSuspicious, false);
    assert.strictEqual(r.editable, true);
    assert.ok(r.content.includes('�'));
  });

  await check('file-tree：条目自带 sizeLabel，且目录不 stat（不返回目录大小）', async () => {
    const r = await fileTree(root);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const f = r.entries.find((e) => e.name === 'a.txt');
    assert.ok(f && f.sizeLabel && f.sizeLabel.length > 0, '文件条目应带 sizeLabel');
    const d = r.entries.find((e) => e.kind === 'dir');
    assert.ok(d, '应有目录条目');
    assert.strictEqual(d.sizeLabel, '');
  });

  // 清理
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  const ok = summary('文件 Tab 全部验证通过');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
