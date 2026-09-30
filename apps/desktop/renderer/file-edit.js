/*!
 * OrchDesk 文件编辑 diff（P3，ADR-0012 的「编辑/diff 后置」兑现）
 * ---------------------------------------------------------------------------
 * 单一实现，双环境可用（与 session-fork.js 同一约定）：
 *   · 浏览器 / 渲染进程 → window.OrchDeskFileEdit（index.html 在 app.js 之前加载）
 *   · Node 验证套件     → require('../renderer/file-edit.js')
 *
 * 职责（纯逻辑，零 DOM / 零 electron）：
 *   1. 行级 diff：编辑缓冲 vs 磁盘内容，输出带行号的扁平行序列 + 增删统计
 *   2. EOL 保护：textarea 赋值会把 CRLF 规范化成 LF——保存前按原文件风格写回，
 *      且 diff 在规范化后的文本上计算（否则 CRLF 文件一进编辑器就是整文件假 diff）
 *   3. 规模上限：任一侧超行数上限，或前缀/后缀裁剪后的剩余部分超出 DP 配额，
 *      返回 tooLarge（渲染层显式标注「变更过大」，不许静默假装没差异）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  /* global window */
  if (root) root.OrchDeskFileEdit = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** 逐行 diff 的行数上限（任一侧超出 → tooLarge，只给行数变化不给逐行）。 */
  var MAX_DIFF_LINES = 5000;

  /** LCS 动态规划的单元配额（前缀/后缀裁剪后的剩余部分），防 O(n·m) 内存爆炸。 */
  var MAX_DP_CELLS = 4000000;

  /** 每个 hunk 两侧保留的上下文行数（与 git -U3 一致）。 */
  var CONTEXT = 3;

  /**
   * 检测换行风格，返回 'crlf' | 'cr' | 'lf'（多数派判定）。
   *
   * 不能写成「见一个 \r\n 就判 CRLF」：混合行尾的文件按少数派全量改写，会
   * 产生肉眼不可见却实实在在的整文件变更——而 diff 是在规范化后的文本上算的，
   * 用户连「我改了什么」都看不到。CR-only（老 Mac 风格）也必须单独识别：
   * applyEol 的 lf 分支会把裸 \r 一起吃掉，不识别就等于保存时把整个文件并成一行。
   */
  function detectEol(text) {
    if (typeof text !== 'string' || text === '') return 'lf';
    var crlf = 0;
    var cr = 0;
    var lf = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === '\r') {
        if (text.charAt(i + 1) === '\n') { crlf++; i++; } else { cr++; }
      } else if (c === '\n') { lf++; }
    }
    if (crlf > 0 && crlf >= lf && crlf >= cr) return 'crlf';
    if (cr > 0 && cr > lf) return 'cr';
    return 'lf';
  }

  /** 按目标风格规范化换行（textarea 产物是纯 LF）。 */
  function applyEol(text, eol) {
    if (typeof text !== 'string') return '';
    if (eol === 'crlf') return text.replace(/\r\n|\r|\n/g, '\r\n');
    if (eol === 'cr') return text.replace(/\r\n|\r|\n/g, '\r');
    return text.replace(/\r\n|\r/g, '\n');
  }

  /** 按行拆分（保留末尾空行语义：以 \n 结尾的文本最后多一个 ''，两侧一致即可对齐）。 */
  function splitLines(text) {
    if (text === '') return [];
    return String(text).split(/\r\n|\r|\n/);
  }

  /**
   * 行级 LCS diff。返回扁平行序列：
   *   { t: 'ctx'|'del'|'add', an: 旧文件行号(0=无), bn: 新文件行号(0=无), s: 文本 }
   * 渲染层按 an/bNo 跳变自行插入 hunk 分隔。
   */
  function diffRows(aLines, bLines) {
    var n = aLines.length;
    var m = bLines.length;
    // 公共前缀/后缀裁剪：编辑场景绝大多数改动集中在局部
    var pre = 0;
    while (pre < n && pre < m && aLines[pre] === bLines[pre]) pre++;
    var suf = 0;
    while (suf < n - pre && suf < m - pre && aLines[n - 1 - suf] === bLines[m - 1 - suf]) suf++;
    var ra = aLines.slice(pre, n - suf);
    var rb = bLines.slice(pre, m - suf);
    var rows = [];
    var i;
    for (i = 0; i < pre; i++) rows.push({ t: 'ctx', an: i + 1, bn: i + 1, s: aLines[i] });
    if (ra.length && rb.length && ra.length * rb.length > MAX_DP_CELLS) return null; // 超配额
    if (ra.length && rb.length) {
      // LCS DP：L[i][j] = ra 前 i 行与 rb 前 j 行的 LCS 长度
      var w = rb.length + 1;
      var L = new Uint32Array((ra.length + 1) * w);
      var x, y;
      for (x = 1; x <= ra.length; x++) {
        var ai = ra[x - 1];
        for (y = 1; y <= rb.length; y++) {
          L[x * w + y] = ai === rb[y - 1]
            ? L[(x - 1) * w + (y - 1)] + 1
            : Math.max(L[(x - 1) * w + y], L[x * w + (y - 1)]);
        }
      }
      // 回溯生成 ops（逆序）；循环退出后单侧剩余行也要吐完，否则丢 add/del
      var ops = [];
      x = ra.length; y = rb.length;
      while (x > 0 && y > 0) {
        if (ra[x - 1] === rb[y - 1]) { ops.push({ t: 'ctx', a: x - 1, b: y - 1 }); x--; y--; }
        else if (L[(x - 1) * w + y] >= L[x * w + (y - 1)]) { ops.push({ t: 'del', a: x - 1 }); x--; }
        else { ops.push({ t: 'add', b: y - 1 }); y--; }
      }
      while (x > 0) { ops.push({ t: 'del', a: x - 1 }); x--; }
      while (y > 0) { ops.push({ t: 'add', b: y - 1 }); y--; }
      ops.reverse();
      // ops → rows（行号以完整文件为基准：偏移 pre）
      for (i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (op.t === 'ctx') rows.push({ t: 'ctx', an: pre + op.a + 1, bn: pre + op.b + 1, s: ra[op.a] });
        else if (op.t === 'del') rows.push({ t: 'del', an: pre + op.a + 1, bn: 0, s: ra[op.a] });
        else rows.push({ t: 'add', an: 0, bn: pre + op.b + 1, s: rb[op.b] });
      }
    } else {
      // 单侧剩余：整段删除 / 整段新增（无对齐歧义）
      for (i = 0; i < ra.length; i++) rows.push({ t: 'del', an: pre + i + 1, bn: 0, s: ra[i] });
      for (i = 0; i < rb.length; i++) rows.push({ t: 'add', an: 0, bn: pre + i + 1, s: rb[i] });
    }
    for (i = 0; i < suf; i++) {
      rows.push({ t: 'ctx', an: n - suf + i + 1, bn: m - suf + i + 1, s: aLines[n - suf + i] });
    }
    return rows;
  }

  /**
   * 计算旧文本 → 新文本的 diff。
   * 返回 { ok:true, rows, stats:{adds,dels} } 或 { ok:false, tooLarge:true, lineDelta }。
   * 文本完全一致 → ok:true 且 rows=[]、stats 全 0（渲染层显示「无变更」）。
   */
  function computeDiff(oldText, newText) {
    var a = splitLines(typeof oldText === 'string' ? oldText : '');
    var b = splitLines(typeof newText === 'string' ? newText : '');
    if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
      return { ok: false, tooLarge: true, lineDelta: b.length - a.length };
    }
    var rows = diffRows(a, b);
    if (rows === null) {
      return { ok: false, tooLarge: true, lineDelta: b.length - a.length };
    }
    var adds = 0;
    var dels = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].t === 'add') adds++;
      else if (rows[i].t === 'del') dels++;
    }
    // 行内容完全一致（含仅 EOL 风格差异、前后缀全吞的情形）→ 空序列，渲染层显示「无变更」
    if (adds === 0 && dels === 0) {
      return { ok: true, rows: [], stats: { adds: 0, dels: 0 } };
    }
    return { ok: true, rows: rows, stats: { adds: adds, dels: dels } };
  }

  /**
   * 扁平行序列 → hunk 组（渲染层辅助）：每个组是「变更 ± CONTEXT 行上下文」的
   * 连续 keep 段；两个组之间渲染层画分隔线。实现 = 对每条变更行标记距离 ≤
   * CONTEXT 的窗口，窗口重叠自动合并成一组。
   */
  function groupHunks(rows) {
    var n = rows.length;
    var keep = new Array(n);
    var i, j;
    for (i = 0; i < n; i++) keep[i] = false;
    for (i = 0; i < n; i++) {
      if (rows[i].t !== 'ctx') {
        for (j = Math.max(0, i - CONTEXT); j <= Math.min(n - 1, i + CONTEXT); j++) keep[j] = true;
      }
    }
    var groups = [];
    var cur = null;
    for (i = 0; i < n; i++) {
      if (keep[i]) {
        if (!cur) { cur = []; groups.push(cur); }
        cur.push(rows[i]);
      } else {
        cur = null;
      }
    }
    return groups;
  }

  return {
    MAX_DIFF_LINES: MAX_DIFF_LINES,
    CONTEXT: CONTEXT,
    detectEol: detectEol,
    applyEol: applyEol,
    splitLines: splitLines,
    diffRows: diffRows,
    computeDiff: computeDiff,
    groupHunks: groupHunks,
  };
});
