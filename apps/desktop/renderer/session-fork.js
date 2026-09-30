/*!
 * OrchDesk 会话分叉与回放（PRD FR-6）
 * ---------------------------------------------------------------------------
 * 单一实现，双环境可用：
 *   · 浏览器 / 渲染进程 → window.OrchDeskFork（index.html 在 app.js 之前加载）
 *   · Node 验证套件     → require('../renderer/session-fork.js')
 *
 * 为什么是 .js 而不是 .ts：主窗口 webPreferences 是 sandbox:true，preload
 * 拿不到 require；而渲染层 app.js 是 IIFE 纯 JS，也不能 require TS 产物。
 * 若拆成「TS 源码 + 生成 renderer 副本」，就多一个必须手跑的构建步骤
 * （vendor-dsh 那类步骤已经踩过坑），一旦忘记同步就是逻辑漂移。所以这里
 * 用 UMD-lite 单文件：渲染层与验证套件跑的是同一份代码，零构建步骤。
 *
 * 诚实边界：OrchDesk 当前的「日志」形态是 orchdesk-sessions.json 里的消息
 * 数组，还不是 dsh 的 SessionEvent append-only 事件流（那需要接管
 * ctx.sessions，属 P7 路线图，切换前须新 ADR）。这里交付的是**分叉语义与
 * 回放视图**本身：分叉 = 继承前 N 条消息 + 血缘元数据；回放 = 从同一份数据
 * 重建只读时间线。数据形态升级成真事件流时，这两个能力不需要重写。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  /* global window */
  if (root) root.OrchDeskFork = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** 摘要长度上限（回放时间线只放摘要，不放全文）。 */
  var DETAIL_MAX = 120;

  /**
   * @typedef {Object} ForkLineage
   * @property {string} from      源会话 id
   * @property {number} atIndex   分叉点：继承前 atIndex 条消息
   * @property {number} at        分叉时间戳（epoch ms）
   * @property {string} [fromTitle] 源会话标题快照（源被删后血缘仍可读）
   */

  /**
   * 归一化血缘：缺字段 / 类型不对 → null（宁可没有血缘，也不要假血缘）。
   * @param {unknown} raw
   * @returns {ForkLineage | null}
   */
  function normalizeFork(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var from = String(raw.from == null ? '' : raw.from).trim();
    if (!from) return null;
    var atIndex = Number(raw.atIndex);
    if (!isFinite(atIndex) || atIndex < 0) return null;
    var at = Number(raw.at);
    var title = String(raw.fromTitle == null ? '' : raw.fromTitle).trim();
    var out = { from: from, atIndex: Math.trunc(atIndex), at: isFinite(at) && at > 0 ? at : Date.now() };
    if (title) out.fromTitle = title;
    return out;
  }

  /**
   * 取分叉继承的消息前缀。
   * atIndex 非法（null / '' / 非数字 / 负数）一律按「全部继承」处理 —— 与用户
   * 点「创建分支」时的直觉一致，且不会静默丢消息。
   *
   * 为什么 null 也要当非法：Number(null) === 0，若照单全收，调用方一句
   * forkMessages(msgs, maybeNull) 就会静默得到「空分支」。丢消息是不可逆的，
   * 所以只有**真数字**才算分叉点。
   * @template T
   * @param {readonly T[]} msgs
   * @param {unknown} atIndex
   * @returns {T[]}
   */
  function forkMessages(msgs, atIndex) {
    var list = Array.isArray(msgs) ? msgs : [];
    if (atIndex === null || atIndex === '' || atIndex === undefined) return list.slice();
    var n = Number(atIndex);
    if (!isFinite(n) || n < 0) return list.slice();
    return list.slice(0, Math.min(Math.trunc(n), list.length));
  }

  /**
   * 构造分叉血缘（调用方负责把结果挂到新会话上）。
   * @param {{ id?: string, title?: string, msgs?: unknown[] }} from
   * @param {number} atIndex
   * @param {number} [now]
   * @returns {ForkLineage}
   */
  function makeForkLineage(from, atIndex, now) {
    var src = from || {};
    var total = Array.isArray(src.msgs) ? src.msgs.length : 0;
    var n = Number(atIndex);
    var idx = isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), total) : total;
    var out = {
      from: String(src.id == null ? '' : src.id),
      atIndex: idx,
      at: typeof now === 'number' && isFinite(now) ? now : Date.now(),
    };
    if (src.title) out.fromTitle = String(src.title);
    return out;
  }

  /** 会话是否可作为分叉源（有消息才谈得上分叉点）。 */
  function canFork(session) {
    return !!(session && Array.isArray(session.msgs) && session.msgs.length > 0);
  }

  function summarize(v) {
    var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) + '…' : s;
  }

  function textOf(m) {
    var t = m.x == null ? m.text : m.x;
    return t == null ? '' : String(t);
  }

  /**
   * 从会话数据重建只读时间线。
   * 事件顺序 = 消息顺序；消息内先工具步骤、再 SubAgent、再用户反馈
   * （这三件都是「这条回复产生过程中发生的事」，放在该消息之后更符合因果）。
   * @param {{ msgs?: unknown[], fork?: unknown }} session
   * @returns {Array<{seq:number,kind:string,ts:string,label:string,detail:string,status?:string}>}
   */
  function buildReplayTimeline(session) {
    var out = [];
    if (!session) return out;
    var seq = 0;

    var fork = normalizeFork(session.fork);
    if (fork) {
      out.push({
        seq: ++seq,
        kind: 'fork-origin',
        ts: new Date(fork.at).toLocaleString('zh-CN'),
        label: '分叉起点',
        detail: '继承自「' + (fork.fromTitle || fork.from) + '」第 ' + fork.atIndex + ' 条消息之后',
      });
    }

    var msgs = Array.isArray(session.msgs) ? session.msgs : [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i] || {};
      var isUser = (m.r || m.role) === 'user';
      var ts = String(m.t == null ? '' : m.t);
      out.push({
        seq: ++seq,
        kind: isUser ? 'user' : 'agent',
        ts: ts,
        label: isUser ? '用户输入' : 'Agent 回复',
        detail: summarize(textOf(m)),
        status: m.typing ? 'running' : 'done',
      });

      var tools = Array.isArray(m.tools) ? m.tools : [];
      for (var j = 0; j < tools.length; j++) {
        var tr = tools[j] || {};
        var ph = String(tr.ph == null ? 'done' : tr.ph);
        out.push({
          seq: ++seq,
          kind: 'tool',
          ts: ts,
          label: '工具 · ' + String(tr.n == null ? 'unknown' : tr.n),
          detail: summarize(tr.result) || (ph === 'running' ? '执行中' : '完成'),
          status: ph === 'running' ? 'running' : 'done',
        });
      }

      if (m.sub && typeof m.sub === 'object') {
        var running = String(m.sub.state == null ? '' : m.sub.state) === 'running';
        out.push({
          seq: ++seq,
          kind: 'subagent',
          ts: ts,
          label: 'SubAgent · ' + String(m.sub.name == null ? '未命名' : m.sub.name),
          detail: running ? '执行中 · 即用即走' : '已回收并销毁',
          status: running ? 'running' : 'done',
        });
      }

      if (m.feedback) {
        out.push({
          seq: ++seq,
          kind: 'feedback',
          ts: ts,
          label: '用户反馈',
          detail: summarize(m.feedback) || '已记录',
        });
      }
    }
    return out;
  }

  /** 回放时间线里每种事件的中文名（渲染层展示用，放这里避免 UI 里散落字符串）。 */
  var REPLAY_KIND_LABELS = {
    'fork-origin': '分叉',
    user: '输入',
    agent: '回复',
    tool: '工具',
    subagent: 'SubAgent',
    feedback: '反馈',
  };

  return {
    DETAIL_MAX: DETAIL_MAX,
    REPLAY_KIND_LABELS: REPLAY_KIND_LABELS,
    normalizeFork: normalizeFork,
    forkMessages: forkMessages,
    makeForkLineage: makeForkLineage,
    canFork: canFork,
    buildReplayTimeline: buildReplayTimeline,
  };
});
