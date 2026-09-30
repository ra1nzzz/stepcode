/**
 * 文件编辑 / diff 验证（P3 · ADR-0012「编辑后置」的兑现）
 * ----------------------------------------------------------------------------
 *   A. 纯逻辑（renderer/file-edit.js UMD-lite 直测）：行级 diff 正确性、
 *      EOL 保护、规模上限显式降级（tooLarge）、hunk 分组。
 *   B. 纯逻辑（file-panel.ts）：normalizeFileWrite 防呆参数校验。
 *   C. 接线（stub electron 驱动真实 dist/main.js）：file-read 的 editable
 *      判定（截断/编码可疑）+ file-write 写回、外部修改拒绝、临时文件清理。
 *
 * 运行：node file-edit-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const APP_DIR = __dirname;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-fileedit-'));
process.env.ORCHDESK_HOME = HOME;

const { importTs } = require('./scripts/ts-load.cjs');
const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');
const { check, summary } = createChecker();

(async () => {
  // =========================================================================
  console.log('== A. 纯逻辑：renderer/file-edit.js（UMD-lite，双环境同一份） ==');
  const fe = require('./renderer/file-edit.js');

  await check('EOL：CRLF 探测 + 按原风格还原（textarea 把 CRLF 吃成 LF 的补救）', () => {
    assert.strictEqual(fe.detectEol('a\r\nb\r\nc'), 'crlf');
    assert.strictEqual(fe.detectEol('a\nb\nc'), 'lf');
    assert.strictEqual(fe.detectEol(''), 'lf');
    assert.strictEqual(fe.applyEol('a\nb\nc', 'crlf'), 'a\r\nb\r\nc');
    assert.strictEqual(fe.applyEol('a\r\nb\nc', 'lf'), 'a\nb\nc');
    // 关键场景：CRLF 文件进 textarea 后变 LF，写盘前还原成 CRLF —— 与原文逐字节一致
    const orig = 'line1\r\nline2\r\n';
    const bufferized = orig.replace(/\r\n/g, '\n');
    assert.strictEqual(fe.applyEol(bufferized, 'crlf'), orig);
  });

  await check('EOL：多数派判定 —— 混合行尾不按少数派全量改写，CR-only 不被并成一行', () => {
    // 混合行尾若按「见一个 CRLF 就判 CRLF」处理，保存会产生看不见的整文件
    // 变更（而 diff 在规范化后算，用户根本看不到自己改了什么）。
    assert.strictEqual(fe.detectEol('a\nb\nc\r\n'), 'lf', 'LF 多数 → lf');
    assert.strictEqual(fe.detectEol('a\r\nb\r\nc\n'), 'crlf', 'CRLF 多数 → crlf');
    // CR-only（老 Mac 风格）：判成 lf 会让 applyEol 把裸 \r 吃掉 → 整个文件并成一行
    assert.strictEqual(fe.detectEol('a\rb\rc'), 'cr');
    assert.strictEqual(fe.applyEol('a\rb\rc', 'cr'), 'a\rb\rc');
    assert.strictEqual(fe.applyEol('a\nb\nc', 'cr'), 'a\rb\rc');
  });

  await check('diff：完全一致 → 空行序列 + 全 0 统计（渲染层显示「无变更」）', () => {
    const d = fe.computeDiff('a\nb\nc', 'a\nb\nc');
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.rows.length, 0);
    assert.strictEqual(d.stats.adds, 0);
    assert.strictEqual(d.stats.dels, 0);
  });

  await check('diff：改中间一行 → del+add 各 1，行号正确，上下文 3 行', () => {
    const old = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n');
    const neu = old.replace('l5', 'L5-changed');
    const d = fe.computeDiff(old, neu);
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.stats.adds, 1);
    assert.strictEqual(d.stats.dels, 1);
    const del = d.rows.find((r) => r.t === 'del');
    const add = d.rows.find((r) => r.t === 'add');
    assert.strictEqual(del.an, 5);
    assert.strictEqual(del.s, 'l5');
    assert.strictEqual(add.bn, 5);
    assert.strictEqual(add.s, 'L5-changed');
    // computeDiff 返回全量行序列（公共前后缀也是 ctx）；裁剪到 ±3 上下文是 groupHunks 的职责
    const ctxAn = d.rows.filter((r) => r.t === 'ctx').map((r) => r.an);
    assert.deepStrictEqual(ctxAn, [1, 2, 3, 4, 6, 7, 8, 9, 10]);
    const groups1 = fe.groupHunks(d.rows);
    assert.strictEqual(groups1.length, 1);
    assert.strictEqual(groups1[0][0].an, 2, 'hunk 视图从 del-3 行开始');
  });

  await check('diff：末尾追加行（含补末尾换行的语义差异）', () => {
    const d1 = fe.computeDiff('a\nb', 'a\nb\nc');
    assert.strictEqual(d1.ok, true);
    assert.strictEqual(d1.stats.adds, 1);
    assert.strictEqual(d1.rows.find((r) => r.t === 'add').bn, 3);
    // 「b」→「b\n」在拆行语义上是真差异（文件是否以换行结尾变了），不是无变更
    const d2 = fe.computeDiff('a\nb', 'a\nb\n');
    assert.strictEqual(d2.ok, true);
    assert.strictEqual(d2.stats.adds, 1, '结尾多一个空行 = 文件多了末尾换行');
  });

  await check('diff：两处独立修改 → groupHunks 分 2 组，组内含 ±3 上下文', () => {
    const lines = [];
    for (let i = 1; i <= 30; i++) lines.push('row' + i);
    const old = lines.join('\n');
    const neu = old.replace('row5', 'ROW5').replace('row25', 'ROW25');
    const d = fe.computeDiff(old, neu);
    assert.strictEqual(d.ok, true);
    const groups = fe.groupHunks(d.rows);
    assert.strictEqual(groups.length, 2, '改动相距 20 行，不该合并成一组');
    assert.ok(groups[0].some((r) => r.t === 'del' && r.an === 5));
    assert.ok(groups[1].some((r) => r.t === 'del' && r.an === 25));
    // 每组首行都是 ctx（上下文），且组数不因上下文重叠而粘连
    assert.strictEqual(groups[0][0].t, 'ctx');
  });

  await check('diff：行数超上限 → tooLarge 显式降级（只给行数变化，不假装无差异）', () => {
    const big = [];
    for (let i = 0; i < fe.MAX_DIFF_LINES + 1; i++) big.push('x' + i);
    const d = fe.computeDiff(big.join('\n'), big.concat(['tail']).join('\n'));
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.tooLarge, true);
    assert.strictEqual(d.lineDelta, 1);
  });

  await check('diff：DP 配额兜底（行数未超限但完全重写的两段大文本 → tooLarge）', () => {
    const a = [];
    const b = [];
    for (let i = 0; i < 3000; i++) { a.push('a' + i); b.push('z' + i); }
    const d = fe.computeDiff(a.join('\n'), b.join('\n'));
    assert.strictEqual(d.ok, false, '3000x3000 剩余矩阵超 4M 配额');
    assert.strictEqual(d.tooLarge, true);
  });

  // =========================================================================
  console.log('== B. 纯逻辑：normalizeFileWrite 防呆 ==');
  const fp = await importTs('file-panel.ts');

  await check('file-write 归一化：正常路径 + 内容字节按 UTF-8 计', () => {
    const r = fp.normalizeFileWrite({ path: 'D:/proj/a.ts', content: 'const 你 = 1;', expectedMtimeMs: 12345.6 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bytes, Buffer.byteLength('const 你 = 1;', 'utf8'));
    assert.strictEqual(r.expectedMtimeMs, 12345.6);
    // 数字字符串也收（IPC 序列化容错）
    assert.strictEqual(fp.normalizeFileWrite({ path: 'D:/x', content: '', expectedMtimeMs: '42' }).ok, true);
  });

  await check('file-write 归一化：缺 path / 相对路径 / 二进制扩展名拒绝', () => {
    assert.strictEqual(fp.normalizeFileWrite({}).ok, false);
    assert.strictEqual(fp.normalizeFileWrite({ path: 'x.ts', content: '', expectedMtimeMs: 1 }).ok, false);
    const bin = fp.normalizeFileWrite({ path: 'D:/x/logo.png', content: 'x', expectedMtimeMs: 1 });
    assert.strictEqual(bin.ok, false);
    assert.ok(bin.reason.includes('二进制'));
  });

  await check('file-write 归一化：缺 expectedMtimeMs 拒绝（防静默覆盖的第一道闸）', () => {
    const r = fp.normalizeFileWrite({ path: 'D:/x/a.txt', content: 'x' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('expectedMtimeMs'));
    assert.strictEqual(fp.normalizeFileWrite({ path: 'D:/x/a.txt', content: 'x', expectedMtimeMs: -1 }).ok, false);
    assert.strictEqual(fp.normalizeFileWrite({ path: 'D:/x/a.txt', content: 'x', expectedMtimeMs: NaN }).ok, false);
  });

  await check('file-write 归一化：内容超 2MB 上限拒绝（与读取上限一致）', () => {
    const r = fp.normalizeFileWrite({ path: 'D:/x/big.txt', content: 'x'.repeat(fp.FILE_READ_MAX_BYTES + 1), expectedMtimeMs: 1 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('上限'));
  });

  // =========================================================================
  console.log('== C. 接线：stub electron 驱动 dist/main.js ==');
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-edit-'));
  const editPath = path.join(root, 'edit.txt');
  fs.writeFileSync(editPath, 'l1\r\nl2\r\nl3\r\n', 'utf-8');
  fs.writeFileSync(path.join(root, 'big.log'), Buffer.alloc(fp.FILE_READ_MAX_BYTES + 1024, 0x61));
  // GBK「你好」：UTF-8 解码必出 U+FFFD（编码可疑的显式判定素材）
  fs.writeFileSync(path.join(root, 'gbk.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));

  const fileRead = (p) => ipcHandlers.get('orchdesk:file-read')(null, { path: p });
  const fileWrite = (input) => ipcHandlers.get('orchdesk:file-write')(null, input);

  await check('file-read 新字段：mtimeMs 必带 + 正常文本 editable=true', async () => {
    const r = await fileRead(editPath);
    assert.strictEqual(r.ok, true);
    assert.ok(typeof r.mtimeMs === 'number' && r.mtimeMs > 0);
    assert.strictEqual(r.editable, true);
    assert.strictEqual(r.encodingSuspicious, false);
    assert.ok(r.content.includes('\r\n'), 'CRLF 原样读出（EOL 判定素材）');
  });

  await check('file-read：截断文件 editable=false（保存会丢数据的口子必须堵死）', async () => {
    const r = await fileRead(path.join(root, 'big.log'));
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.editable, false);
  });

  await check('file-read：非 UTF-8 内容 encodingSuspicious=true + editable=false（显式原因）', async () => {
    const r = await fileRead(path.join(root, 'gbk.txt'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.encodingSuspicious, true);
    assert.strictEqual(r.editable, false);
  });

  await check('file-write：正常写回（内容落盘 + 返回新 size/mtime）', async () => {
    const rd = await fileRead(editPath);
    const res = await fileWrite({ path: editPath, content: 'l1\r\nl2-changed\r\nl3\r\nl4\r\n', expectedMtimeMs: rd.mtimeMs });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(fs.readFileSync(editPath, 'utf-8'), 'l1\r\nl2-changed\r\nl3\r\nl4\r\n');
    assert.strictEqual(res.size, Buffer.byteLength('l1\r\nl2-changed\r\nl3\r\nl4\r\n', 'utf8'));
    assert.ok(Math.abs(res.mtimeMs - fs.statSync(editPath).mtimeMs) < 2);
    // 写成功后不留临时文件
    const leftover = fs.readdirSync(root).filter((n) => n.includes('.orchdesk-tmp'));
    assert.strictEqual(leftover.length, 0, 'rename 后临时文件必须消失');
  });

  await check('file-write：外部修改过 → 拒绝 code=modified-externally（磁盘内容不被覆盖）', async () => {
    const rd = await fileRead(editPath);
    // 模拟外部修改（编辑器 / git / Agent 工具）：内容与 mtime 都变了。
    // 先等 10ms：真实的外部写入不可能发生在读取后 1ms 内，而快速 NVMe 上
    // 立即 append 的 mtime 漂移仅 ~1ms，会落入生产代码刻意的 2ms 容差区间
    // （容差吸收的是同 tick 浮点抖动，不是 1ms 内的真实改写）——不等就会
    // 把「容差设计」误测成「防覆盖失效」。
    await new Promise((r) => setTimeout(r, 10));
    fs.appendFileSync(editPath, 'external-edit\r\n');
    const res = await fileWrite({ path: editPath, content: '覆盖!', expectedMtimeMs: rd.mtimeMs });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'modified-externally');
    assert.ok(fs.readFileSync(editPath, 'utf-8').includes('external-edit'), '外部改动必须完好');
  });

  await check('file-write：mtime 容差 2ms（同一次 stat 的浮点抖动不误伤）', async () => {
    const rd = await fileRead(editPath);
    const res = await fileWrite({ path: editPath, content: 'tolerance\r\n', expectedMtimeMs: rd.mtimeMs + 1.5 });
    assert.strictEqual(res.ok, true, '1.5ms 漂移应放行');
    assert.strictEqual(fs.readFileSync(editPath, 'utf-8'), 'tolerance\r\n');
  });

  await check('file-write：参数防呆有 reason（二进制 / 缺 mtime / 目录 / 超限）', async () => {
    const bin = await fileWrite({ path: path.join(root, 'x.png'), content: 'x', expectedMtimeMs: 1 });
    assert.strictEqual(bin.ok, false);
    assert.ok(bin.reason.includes('二进制'));
    const noMt = await fileWrite({ path: editPath, content: 'x' });
    assert.strictEqual(noMt.ok, false);
    assert.ok(noMt.reason.includes('expectedMtimeMs'));
    const dir = await fileWrite({ path: root, content: 'x', expectedMtimeMs: 1 });
    assert.strictEqual(dir.ok, false);
    assert.ok(dir.reason.includes('目录'));
    const huge = await fileWrite({ path: editPath, content: 'x'.repeat(fp.FILE_READ_MAX_BYTES + 1), expectedMtimeMs: 1 });
    assert.strictEqual(huge.ok, false);
    assert.ok(huge.reason.includes('上限'));
  });

  await check('file-write：写回后再读，基线轮转（新 mtimeMs 可支撑连续编辑）', async () => {
    const rd1 = await fileRead(editPath);
    await fileWrite({ path: editPath, content: 'v2\r\n', expectedMtimeMs: rd1.mtimeMs });
    const rd2 = await fileRead(editPath);
    assert.strictEqual(rd2.content, 'v2\r\n');
    assert.ok(rd2.mtimeMs >= rd1.mtimeMs, '第二次读取的 mtime 是新基线');
    const res = await fileWrite({ path: editPath, content: 'v3\r\n', expectedMtimeMs: rd2.mtimeMs });
    assert.strictEqual(res.ok, true, '连续编辑（读→写→读→写）不被自己的上一次写入误伤');
  });

  // 清理
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  const ok = summary('文件编辑 / diff 全部验证通过');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
