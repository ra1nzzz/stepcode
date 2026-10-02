/* ============================================================================
 * OrchDesk 渲染进程（P1 真实渲染工程）
 * --------------------------------------------------------------------------
 * 渲染进程持有 UI 会话状态（state.sessions / state.projects）；所有需要落盘
 * 或需要真实模型的操作经 window.orchdesk 桥（contextBridge）调用主进程：
 *   - loadSessions()      启动时拉取持久化会话（空则首次运行，用种子数据）
 *   - persistSessions(arr) 任何变更后落盘（主进程写 userData JSON，可重启回放）
 *   - runAgentTurn(...)    模型回合 seam：主进程在此接 Step 会话（step-session.ts）
 * 红线（ADR-0002）：渲染进程绝不 require node / dsh 模块，一律经桥。
 * 若桥不存在（直接用浏览器打开 index.html 预览），自动回落到页内内存存储。
 * ========================================================================== */
(function () {
  'use strict';

  const I = {
    conv: '<path d="M4 5h16v11H9l-5 4z"/>',
    skills: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/><path d="M13 7.5h4M7.5 13v4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    fork: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V8a4 4 0 0 0-4-4H8"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l3 3h12l-1 8H6l-3-3z"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
    shield: '<path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5z"/>',
    shieldOff: '<path d="M5 5l14 14M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5z"/>',
    bot: '<rect x="4" y="7" width="16" height="12" rx="3"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><path d="M12 7V3M9 3h6"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1.2 13a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 6"/>',
    warn: '<path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.86a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    presentation: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    // 浏览器（ADR-0011）面板入口
    globe: '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
    // 建议项图标（iconMap 引用，此前缺失 → ic() 渲染空 SVG）
    barChart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    // ---- 本轮 UI 重构新增 ----
    // 终端（状态栏右下角图标；此前只有文字按钮，无图标）
    terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="6 9 9 12 6 15"/><line x1="12" y1="15" x2="17" y2="15"/>',
    // 下拉箭头（思考链展开 / 终端抽屉）
    chevDown: '<polyline points="6 9 12 15 18 9"/>',
    // 关闭叉（浏览器 TAB 单关）
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    // 图片占位（浏览器页面快照无缩略图时）
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><polyline points="21 16 16 11 5 20"/>',
    // 双箭头全关（浏览器「全部关闭」）
    xAll: '<polyline points="4 8 8 12 4 16"/><line x1="13" y1="8" x2="20" y2="16"/><line x1="20" y1="8" x2="13" y2="16"/>',
  };
  const ic = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;
  /** 工具步骤行（live typing 与静态消息两处共用，杜绝双份模板漂移）。
   * 色义：执行中=琥珀脉冲 / 出错=红 / 完成=绿；sm=true 为 typing 紧凑行。 */
  function toolRow(t, sm) {
    const ph = t.ph === 'running' ? 'running' : (t.ph === 'error' ? 'error' : 'done');
    const dot = ph === 'running' ? 'var(--warn)' : (ph === 'error' ? 'var(--danger)' : 'var(--ok)');
    const anim = ph === 'running' ? 'animation:pulse 1.6s infinite' : '';
    const lbl = ph === 'running' ? '执行中' : (ph === 'error' ? '出错' : '完成');
    const trowSt = sm ? 'style="margin-top:2px"' : '';
    const monoSt = sm ? 'style="font-size:11px"' : '';
    const faintSt = sm ? 'style="margin-left:auto;font-size:11px"' : 'style="margin-left:auto"';
    return `<div class="trow" ${trowSt}><span class="tdot" style="background:${dot};${anim}"></span><span class="mono" ${monoSt}>${esc(t.n)}</span><span class="faint" ${faintSt}>${lbl}</span></div>`;
  }
  // 专家 / 专家团：**回落到多 Agent 编排插件（multi）提供的真实目录**。
  // 编排插件可用时以 catalog 为准（8 专家 + 3 团），不可用时才用下面的兜底清单。
  const EXPERTS = ['Orchestrator（主会话）', '开发总监', '设计总监', '测试总监', '项目管理总监', '文档总监', '艺术总监', '风险控制总监'];
  const TEAMS = [{ n: '预置 · 全栈开发团', m: '开发总监 + 测试总监 + 文档总监' }, { n: '预置 · 写作团', m: '文档总监 + 艺术总监' }, { n: '自定义 · 我的专家团', m: '自编排（拖拽专家）' }];

  /** 专家列表：优先取编排插件真实目录。 */
  function expertList() {
    const cat = state.orchestrationCatalog;
    if (cat && Array.isArray(cat.experts) && cat.experts.length) {
      return cat.experts.map((e) => e.title || e.name || e.id);
    }
    return EXPERTS;
  }

  /** 团队列表：优先取编排插件真实目录（成员 id 映射为展示名）。 */
  function teamList() {
    const cat = state.orchestrationCatalog;
    if (cat && Array.isArray(cat.teams) && cat.teams.length) {
      const nameOf = (id) => {
        const e = (cat.experts || []).find((x) => x.id === id);
        return e ? (e.title || e.name || e.id) : id;
      };
      return cat.teams.map((t) => ({
        n: t.name || t.id,
        m: Array.isArray(t.members) ? t.members.map(nameOf).join(' + ') : '',
        id: t.id,
      }));
    }
    return TEAMS;
  }

  /** 编排数据是否来自真实插件（否则 UI 标注「未接入」）。 */
  function orchestrationLive() {
    const cat = state.orchestrationCatalog;
    return !!(cat && Array.isArray(cat.experts) && cat.experts.length);
  }
  // 界面只有两档。机器标识是 bypass / autopilot。宿主带回的其它 id 或文案不得显示成第三档。
  const FALLBACK_AUTH_MODES = [
    { id: 'bypass', label: '默认模式', blurb: '普通工具直接运行。危险命令仍由本界面确认。' },
    { id: 'autopilot', label: '完全信任', blurb: '普通工具直接运行，并在模型短暂失败后续跑。危险命令仍由本界面确认。' },
  ];
  const GUI_PRESET_LABELS = { bypass: '默认模式', autopilot: '完全信任' };
  const authModesForRender = () => FALLBACK_AUTH_MODES.map((m) => ({ ...m }));
  const authModeLabel = (id) => GUI_PRESET_LABELS[id] || '未接入';
  // BUG-045：沙箱模式的机器标识由**主进程**映射成中文口径，随 sandbox-get 的 modeLabel 一起回传
  // （映射表在 ipc-sandbox.ts）。渲染层这里刻意不留任何机器标识字面量：一是界面文案不许夹带
  // 机器标识，二是 `step-t4-verify` 的 BANNED_UI 扫的就是本文件源码——在这写一句解释都会把
  // 守卫自己撞红（本轮实测踩到，注释里提一次禁用词即判红）。
  // 完全信任比默认模式更会在失败后续跑，用警告色。未接入不是健康。
  const AUTH_MODE_DOT_COLORS = { bypass: 'var(--ok)', autopilot: 'var(--warn)' };
  const authModeDotColor = () => (GUI_PRESET_LABELS[state.authMode] && state.authzLoaded
    ? AUTH_MODE_DOT_COLORS[state.authMode]
    : 'var(--fg-faint)');
  const PROMPT_CAT_LABELS = { role: '角色行为', safety: '安全边界', format: '输出格式', 'skill-link': '技能联动' };
  const PROMPT_CATS = Object.keys(PROMPT_CAT_LABELS);
  const PLUGINS = [
    { id: 'intent', n: '意图识别', on: 1, d: 'prompt 到达模型前必经 agent/pre-step；本地模型做 F1-F4 初筛，高风险才转人工确认。', repo: '', caps: ['prompt.read', 'intent.classify', 'flow.gate'], cfg: ['风险阈值：0.70', '默认回退：BLOCK'] },
    { id: 'trace', n: 'TRACE', on: 1, d: 'Agent Loop 前 / Loop 结束，记录用户对语用意图的反馈；脱敏后遥测上传。', repo: '', caps: ['event.read', 'pii.mask'], cfg: ['脱敏：开', '反馈时机：Loop 结束后'] },
    { id: 'brain', n: '脑手解耦', on: 1, d: '主会话负责理解、回收、沉淀；SubAgent 执行、反馈、即用即走。', repo: '', caps: ['agent.spawn', 'agent.dispose', 'memory.commit'], cfg: ['每任务并发：1-3'] },
    { id: 'multi', n: '多Agent编排', on: 1, d: '类 WorkBuddy 的专家与专家团；可用预置，也可自编排。', repo: '', caps: ['expert.load', 'team.compose', 'role.bind'], cfg: ['预置专家团：2 个'] },
    { id: 'hub', n: 'OrchClaw Hub', on: 0, d: '配对远程 Agent 后，主会话可向其下发任务并回收结果。', repo: '', caps: ['pair.token', 'agent.remote', 'ws.channel'], cfg: ['配对：安全存储加密'] }
  ];
  const SKILLS_MARKET = [
    { n: 'guanji', d: '观雅集官方客户端', caps: ['skill.fetch', 'skill.install'], auth: 0 },
    { n: 'consolidate-project-knowledge-base', d: '项目知识库治理', caps: ['fs.read', 'fs.write', 'doc.review'], auth: 1 },
    { n: 'aihot', d: 'AI 资讯日报', caps: ['web.fetch', 'cron.schedule'], auth: 0 },
  ];
  const PLUGIN_MARKET = [
    { n: 'Git 集成', d: '仓库操作 / PR / Issue', caps: ['git.read', 'git.write'], auth: 1 },
    { n: 'PDF 工具箱', d: '读取/合并/拆分/OCR', caps: ['pdf.read', 'pdf.write'], auth: 0 },
    { n: '浏览器自动化', d: 'Playwright 驱动', caps: ['browser.navigate', 'browser.screenshot'], auth: 1 },
    { n: '邮件助手', d: 'SMTP/IMAP 收发', caps: ['mail.send', 'mail.read'], auth: 1 },
    { n: '数据可视化', d: 'Chart.js 图表生成', caps: ['chart.render'], auth: 0 }
  ];
  // 连接器目录已移至后端注册表（PRD FR-3，apps/desktop/connector-registry.ts）。
  // 此前的静态数组带 on:1 —— GitHub 被硬编码成「已连」，是纯假状态，已删。

  // 模型池：仅来自真实配置（设置页添加的提供商）；无配置 = 空池，UI 显示"选择模型"
  let MODELS = [];

  /* ---------- 模型选择：持久化 + 默认策略 ---------- */
  const MODEL_SELECTION_KEY = 'orchdesk.modelSelection';
  const WORKSPACE_KEY = 'orchdesk.workspaceDir';
  function saveModelSelection(models) {
    try { localStorage.setItem(MODEL_SELECTION_KEY, JSON.stringify(models || [])); } catch { /* 隐私模式等忽略 */ }
  }
  function loadModelSelection() {
    try {
      const v = localStorage.getItem(MODEL_SELECTION_KEY);
      const arr = v ? JSON.parse(v) : null;
      return Array.isArray(arr) ? arr : null;
    } catch { return null; }
  }
  function loadWorkspaceDir() {
    try { return localStorage.getItem(WORKSPACE_KEY) || ''; } catch { return ''; }
  }
  function saveWorkspaceDir(dir) {
    state.workspaceDir = dir || '';
    try { localStorage.setItem(WORKSPACE_KEY, state.workspaceDir); } catch { /* 隐私模式等忽略 */ }
  }

  /**
   * 默认选择策略（providers 非空时调用）：
   * 1. 用户上次在对话框确认的选择优先（跨会话复用，localStorage 持久化）
   * 2. 仅一种有效模型 → 默认启用它
   * 3. 本地 + API → 本地勾选（意图识别）+ API（主运行）
   * 4. 多个 API → 设置页指定的默认模型 + 本地（若有）
   */
  function autoSelectModels(providers, defaultProviderId, defaultModelName) {
    const pool = dynamicModels.list;
    if (!pool.length) { state.selectedModels = []; return; }
    const has = (n) => pool.some(m => m.n === n);

    // 本地模型判定：提供商 type=ollama，或名称含 本地/Ollama
    const ollamaNames = new Set((providers || []).filter(p => p.type === 'ollama').map(p => p.name));
    const isLocal = (m) => ollamaNames.has(String(m.p).split(' · ')[0]) || /本地|Ollama/i.test(m.p);
    const localModels = pool.filter(isLocal);
    const apiModels = pool.filter(m => !isLocal(m));

    // 1) 用户持久化的选择优先（至少保留 1 个且全部仍有效）
    const saved = loadModelSelection();
    if (saved && saved.length > 0 && saved.every(has)) {
      state.selectedModels = saved;
      return;
    }

    if (apiModels.length === 0) {
      // 只有本地模型（0 或多个）：全不勾或勾第一个
      state.selectedModels = pool.length ? [pool[0].n] : [];
    } else if (apiModels.length === 1) {
      // 单个 API：本地（若有）作为意图识别 + API 主运行
      state.selectedModels = localModels.length ? [apiModels[0].n, localModels[0].n] : [apiModels[0].n];
    } else {
      // 多个 API：设置页指定的默认模型优先，其次默认提供商下的模型，再否则第一个 API
      const dm = (defaultModelName && has(defaultModelName) ? pool.find(m => m.n === defaultModelName && !isLocal(m)) : null)
        || (defaultProviderId ? apiModels.find(m => String(m.p).startsWith(defaultProviderId)) : null)
        || apiModels[0];
      state.selectedModels = localModels.length ? [dm.n, localModels[0].n] : [dm.n];
    }
    saveModelSelection(state.selectedModels);
    // P2：真模型就位即退出演示模式。否则用户在设置页配好提供商后，doSend 仍会走
    // echo 分支、chip 仍显示「演示模式」——配置生效了却看不到，比不配更糟。
    if (state.selectedModels.length) state.demoMode = false;
  }

  function getModelPool() { return dynamicModels.list.length ? dynamicModels.list : MODELS; }

  // holder 模式：actions 模块经 ctx 写入的是同一对象引用——直接 `let` 会让
  // ctx 拷贝到当时的快照，ctx.dynamicModels = … 写进副本、app.js 侧不更新（复审 P1）。
  const dynamicModels = { list: [] };

  /* ---------- FR-6 分叉与回放（纯逻辑，与验证套件共用同一份实现） ----------
   * session-fork.js 由 index.html 在 app.js 之前加载；缺失时 FORK 为 null，
   * 分叉点选择与回放视图降级为不可用并如实提示（不静默退化成「全继承」）。 */
  const FORK = (typeof window !== 'undefined' && window.OrchDeskFork) ? window.OrchDeskFork : null;

  /* ---------- 桥接（主进程 contextBridge；无桥接时显示"未连接"） ---------- */
  const bridge = (function () {
    const real = (typeof window !== 'undefined' && window.orchdesk) ? window.orchdesk : null;
    if (real) return real;
    // 无桥接：返回空壳，UI 显示"未连接"状态。
    // 下方显式 stub 覆盖高频路径的行为语义；Proxy 兜底其余方法——preload 暴露
    // 100+ 方法而 stub 只有 70 个回退，历史上调用未覆盖方法时浏览器预览模式直接
    // TypeError（取值时就抛，.catch 接不住）。未知名一律回落「未接入」Promise。
    // 无桥接：返回空壳，UI 显示"未连接"状态。
    // 审查项④：stub 语义抽至 renderer/bridge-stub.js（与 e2e 共用一份，消除双源）；
    // 下方 Proxy 兜底未知名方法——preload 暴露 100+ 方法而 stub 只有 70 个回退。
    const stub = (typeof window !== 'undefined' && window.orchdeskBridgeStub) || {};
    return new Proxy(stub, {
      get(target, prop) {
        if (prop in target) return target[prop];
        // 未知名：统一回落「未接入」Promise（订阅型方法调用方会再包一层取退订，
        // 返回 Promise 而非函数可被 typeof 区分，调用方已有可选调用防护）。
        return () => Promise.resolve({ ok: false, reason: '主进程未接入' });
      },
    });
  })();

  /* ---------- PRD FR-8 沙箱日志：判定结果与类型的中文名 ---------- */
  const SL_DECISION_LABELS = { all: '全部结果', allowed: '放行', denied: '拒绝', error: '出错' };
  // browser（ADR-0011）：内置浏览器的导航与页面内操作
  const SL_KIND_LABELS = { all: '全部类型', path: '路径', command: '命令', network: '网络', approval: '授权', browser: '浏览器', config: '配置' };

  /* ---------- 状态 ---------- */
  const state = {
    page: 'session', theme: 'dark', sel: null, ctxOpen: false, ctxTab: 'todo', pendingConfirm: false, pendingConfirmHtml: '', wz: 0, wzExpert: 0,
    // P4-S3-04/S3-06：授权服务是否真的加载过（区分「拉到了但空」与「没拉到」）。
    // 未加载时风控区必须显式标注，不能拿兜底文案冒充活着。
    authzLoaded: false,
    selProjForComposer: null, projDropdownOpen: false, composerMoreOpen: false,
    // P1.4 隐式 cwd：轻会话的默认工作目录（'' = 未设置，用主进程默认）。
    // localStorage 持久化（与模型选择同款的轻量偏好）。
    workspaceDir: '',
    newConvMode: true,
    feedback: new Set(), authMode: '',
    // 思考链展开态（本轮 UI 重构）：key = `${sid}|${msg.t}`，存已展开「思考中」详情的消息。
    thinkExpanded: new Set(),
    /** 进行中的模型回合 sessionId；非空时 composer 显示「停止」。 */
    turnBusy: null,
    /** 刚停止的回合。主区据此留一行落点，而不是忙态一清就什么都不剩。 */
    turnStopped: null,
    /** 刚完成的回合。主区据此留一个完成瞬间，而不是状态行直接消失。 */
    turnDone: null,
    // P1.3 任务监控自动浮出：ctxAutoOpened=本回合自动开过（仅此种情况才自动关）、
    // ctxAutoToggled=用户在本回合手动调过面板（尊重手动，不再自动管理）。
    ctxAutoOpened: false, ctxAutoToggled: false,
    // P2 模型内嵌（spec §5.3）：Ollama 自发现结果 + 演示模式标志。
    // demoMode 绝不写 selectedModels / modelProviders——演示回复不能被当成真模型结果。
    ollama: { ok: false, models: [], reason: '' },
    demoMode: false,
    authLevels: [], authAudit: [],
    // ④M-1：授权模式卡 / 白名单工具下拉数据化（canonical = 主进程 listGuiPermissionModes；加载后覆盖兜底文案）
    authModes: [], grantTools: [],
    // 授权白名单（PRD FR-9）：会话 / 永久规则。dsh 授权服务已卸下，此域为空。
    grants: [],
    promptDocs: [], promptConflicts: [],
    compAudit: [], compAuditLoaded: false, tempPlugins: [], tempPluginsLoaded: false,
    guanjiSkills: [], guanjiTokenSet: false, installedSkills: [], installedSkillsLoaded: false, askInputCb: null,
    hubStatus: { paired: false }, hubUrl: '', hubTaskText: '', hubResultText: '',
    memoryStats: null,
    pExpanded: new Set(),
    plugSideExpanded: new Set(['builtin', 'market', 'skills', 'experts', 'connectors']),
    selectedModels: [], thinkLevel: 'standard', modelProviders: [], mpEditing: null, defaultProvider: undefined,
    // 简化方案（2026-09-23）：视图双态。light=默认轻模式（列表+主区，右栏收起，
    // rail 收拢在 P1.2）；project=编排模式（右栏任务监控常驻）。持久化在 P3。
    viewMode: 'session',
    // models.dev 预设 + KEY 触发拉取（方案 A）：预设目录/选中项、拉取结果与勾选态
    mpPreset: null, mpPresetOpen: false, mpCatalog: null, mpCatalogLoading: false,
    mpModels: [], mpModelsChecked: new Set(), mpModelsSource: '', mpModelsLoading: false, mpModelsNote: '', mpModelsExpanded: false,
    maxToolIterations: 200, projects: [], sessions: {},
    // 实时工具步骤：sessionId → [{ n, ph, result }]，由主进程 orchdesk:tool-step 推送
    toolSteps: {},
    // 插件运行时真实状态（替代 PLUGINS 常量的硬编码 on 字段）
    pluginRuntime: null,
    // 编排目录（multi 插件真实数据；null = 未接入，UI 回落兜底清单并标注）
    orchestrationCatalog: null,
    // 沙箱策略（PRD FR-8）：模式 + 网络域名白名单。
    // R5-13：loaded=false 时 mode 为空串，UI 显示「未接入」而不是拿 'workspace-write'
    // 冒充已拉取（原注释写「null = 未拉取」但代码从不为 null，注释与实现早已漂移）。
    // networkAllow 空数组 = 全部拒绝（fail-closed），与设置页说明文案一致。
    sandbox: { mode: '', modeLabel: '', networkAllow: [], loaded: false },
    // 最近一次专家团派发结果（composeTeam 返回的 { rootId, nodes }）
    delegationLast: null,
    // TRACE 上报开关（默认开；bridge.traceStatus 拉取后覆盖）
    traceEnabled: true,
    traceBuiltin: false,
    // 桌面集成（PRD FR-4.2）：6 个开关此前全是 data-action="todo" 空壳。
    // null = 桥未接入（浏览器预览），UI 降级为不可点并标注。
    desktop: null,
    // 回放视图（PRD FR-6）：存放被回放的会话 id；非 null 时主区渲染只读时间线。
    replayFor: null,
    // 沙箱日志（PRD FR-8 可检索）：loaded=false 时 UI 标注「未接入」，
    // 与「接进了但没记录」区分开 —— 这两种状态的处置完全不同。
    sandboxLog: {
      entries: [], stats: { total: 0, allowed: 0, denied: 0, error: 0, byTool: [] },
      total: 0, max: 500, keyword: '', decision: 'all', kind: 'all', loaded: false,
    },
    // 数据目录内容清单（PRD FR-4.2）：真实扫描结果。ok=false = 未接入/扫描失败，
    // UI 显示「未接入」而不是沿用写死的「~ 24 MB」。
    dataDirInventory: { ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] },
    // 分层记忆：四域可查 + 晋升。loaded=false = 桥不可用，
    // 与「接进了但域是空的」区分开 —— worker 域空有两种完全不同的成因
    // （还没跑过 SubAgent vs 桥断了），UI 必须说清楚是哪一种。
    memory: { domain: 'worker', items: [], stats: null, loaded: false, busy: false },
    // 晋升审计（PRD FR-10「须显式操作并写审计」）：成功与失败都记。
    memoryPromotions: {
      entries: [], stats: { total: 0, promoted: 0, rejected: 0, byEdge: [] },
      total: 0, max: 200, ok: 'all', loaded: false,
    },
    // 记忆摘要方式（FR-10）：llm = 模型摘要，extractive = 抽取式兜底。
    // 必须显式展示 —— 否则「自动转储其实一直在兜底」这种降级无从发现。
    memorySummarize: { mode: 'extractive', provider: '', model: '', seam: false, loaded: false },
    // FR-5 用量追踪：真实记账（只统计网关上报过 usage 的回合）。loaded=false = 未接入。
    usage: {
      loaded: false,
      total: { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 },
      byModel: [], bySession: [],
    },
    // FR-6 回放数据源（ADR-0009）：事件流时间线。sid 不匹配当前回放会话 = 未加载。
    sessionEvents: { sid: null, data: null, loaded: false, error: '', bridgeMissing: false },
    // 浏览器（ADR-0011）：内置 CDP 浏览器窗口。loaded=false = 桥未接入；
    // open=false = 窗口没开（面板显示「未打开」，不显示空白页或假地址）。
    // Agent 默认在后台隐藏窗口操作网页，这个面板是用户唯一的观察与制动入口。
    browser: { loaded: false, open: false, url: '', title: '', visible: false, lastShot: null, lastError: '', shotsDir: '',
      // 页面快照 TAB（本轮 UI 重构）：底层是单个隐藏 CDP 窗口，同一时刻只有一个活跃页面，
      // 但 Agent 会先后访问多个 URL —— 每次 navigate 登记一张卡片（标题/URL/缩略图），
      // 侧栏里就是可单关/全关的 TAB 列表。绝不用「多个页面同时存在」的假象冒充多标签。
      pages: [], activePageId: null },
    // 浏览器面板是否打开（状态推送时据此决定是否重绘）
    browserPanelOpen: false,
    // 浏览器侧栏显隐（多 TAB 容器）。Agent 首次调用浏览器时自动置 true，
    // 同时默认收起任务监控侧栏——两个侧栏同时展开会把主区挤没。
    browserSideOpen: false,
    // 终端（P2-10）：ptyAvailable=false = 管道模式降级（必须显式展示，不冒充 PTY）。
    // loaded=false = 桥未接入；sessions=[] = 没有打开的终端（两者不是一回事）。
    terminal: { loaded: false, ptyAvailable: false, via: 'pipe', sessions: [], activeId: null },
    terminalPanelOpen: false,
    // 终端抽屉全屏档位（需求3）：全屏时抽屉占满除标题栏/状态栏外的高度，
    // 主区（flex:1）自动收缩——不是盖住主区。
    termFull: false,
    // 文件（P2-11）：root='' = 尚未选择目录。children 是目录懒加载缓存。
    filePanelOpen: false,
    // 右栏「文件」TAB（本轮 UI 重构）：与「产物」不同——产物是本会话 Agent 生成的内容，
    // 文件是当前工作目录的全部文件。root 自动跟随会话所绑定项目的本地目录。
    fileTab: { root: '', inited: false, loading: false, expanded: new Set(), children: new Map(), error: '', lastDir: '' },
    filePanel: { loaded: false, bridgeMissing: false, root: '', userPicked: false, truncated: false, expanded: new Set(), children: new Map(), preview: null, previewPath: '', previewLoading: false, shikiReady: false,
      // P3 编辑/diff：view = preview | edit | diff；diffRows/diffTooLarge 是最近一次计算结果
      view: 'preview', editBuf: '', editBase: '', eol: 'lf', dirty: false, saving: false, discardArmed: false,
      diffRows: null, diffTooLarge: false, diffLineDelta: 0, diffStat: '', saveError: '' },
    // 连接器（PRD FR-3）：真实后端注册表（凭证加密存储 + 保存即探测）。
    // loaded=false 时侧栏显示「未接入」，不能拿空数组冒充「都没配置」。
    connectors: { items: [], stats: { total: 0, configured: 0, tested: 0, ok: 0 }, loaded: false, expanded: null },
    connAudit: { entries: [], stats: { total: 0, saves: 0, clears: 0, tests: 0, fails: 0 }, total: 0, max: 200, loaded: false },
    // 本地插件市场（PRD FR-3）：dataDir()/plugins 下的第三方插件。
    market: { items: [], dir: '', count: 0, loaded: false, busy: null },
    // MCP（真接入）：真实 server 配置 + 连接状态 + 工具清单。
    // loaded=false = 主进程桥未接入；servers=[] = 已接入但没配置（两者不是一回事）。
    mcp: { servers: [], stats: { total: 0, configured: 0, connected: 0, tools: 0 }, loaded: false },
    mcpExpanded: null,
    // 插件页搜索（前端过滤；对内置插件卡片按名称/描述/能力/标识做不区分大小写子串匹配）
    plugSearch: '',
  };

  /* ---------- P3 项目模式：状态记忆（spec §6「模式选择记忆」） ---------- */
  // R2-3：轻/项目双壳层已取消（commit 6dbf8e7），viewMode 只剩一个固定值。
  // 原 loadViewMode / loadViewModePinned / saveViewMode 连 VIEWMODE_KEY 常量一并无人
  // 调用，整块删除；旧 localStorage 偏好不再读，避免把右栏钉成常驻。
  state.viewMode = 'session';

  const $ = (s) => document.querySelector(s);
  // 导航按用户要做的事命名，不按功能模块命名。id 不变，改了会断路由。
  const PAGES = [
    { id: 'session', n: '开始', icon: 'conv' },
    { id: 'plugins', n: '能力', icon: 'skills' },
    { id: 'settings', n: '偏好', icon: 'settings' }
  ];
  const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  // 导入期间挂起 persist：persist-sessions 是「渲染层状态整体重写」，若在
  // 主进程导入落盘与渲染层重拉之间触发，会把导入数据整体冲掉（审阅阻断项）。
  // holder 模式：actions 模块经 ctx 写的是同一引用（复审 P1：let 会被拷成快照，
  // settings.js 的 ctx.importSuspend = true 永远传不回本 IIFE，挂起形同虚设）。
  const importSuspend = { on: false };
  /** 沙箱日志检索防抖句柄（PRD FR-8）。 */
  let sblogTimer = 0;

  function persist() { if (importSuspend.on) return; persistSessions(); persistProjects(); }

  function persistSessions() { bridge.persistSessions(Object.values(state.sessions)).catch(() => {}); }

  /**
   * 项目分组落盘（BUG：此前只持久化 sessions，重启后项目全丢、会话退化为「任务」组）。
   * 用 try/catch 兜底：桥不可用时降级为不落盘，不影响会话本身。
   */
  let projectsPersistTimer = null;
  function persistProjects() {
    if (typeof bridge.persistProjects !== 'function') return;
    if (projectsPersistTimer) clearTimeout(projectsPersistTimer);
    projectsPersistTimer = setTimeout(() => {
      projectsPersistTimer = null;
      bridge.persistProjects(state.projects).catch((err) => {
        console.warn('[persist] 项目分组落盘失败:', err && err.message);
      });
    }, 250);
  }

  /**
   * 插件卡片状态徽章：优先取运行时真实状态（orchdesk:plugin-runtime），
   * 未接入运行时时回落常量声明并标注「未接入」，不伪造「已启用」。
   */
  function pluginBadge(id) {
    const rt = state.pluginRuntime;
    if (rt && rt.ready && Array.isArray(rt.plugins)) {
      const live = rt.plugins.find((x) => x.name === id);
      if (live) {
        if (live.active) return '<span class="badge ok">已启用</span>';
        // 停用逆回滚会把 error 写成「已停用…」。见 error 就标异常，会把主动停用误标。
        if (live.error && !/^已停用/.test(live.error)) return `<span class="badge warn" title="${esc(live.error)}">异常</span>`;
        if (!live.available) return '<span class="badge">未接入</span>';
        return `<span class="badge warn" title="${esc(live.error || '')}">已停用</span>`;
      }
      // 运行时不认识这个插件（如 hub 走独立实现）→ 回落常量
    }
    const p = PLUGINS.find((x) => x.id === id);
    if (!p) return '';
    // 运行时不可用（`orchdesk:plugin-runtime` 在 dsh 卸下后回 ready:false）时，不许回落到常量说「已启用」。
    // 那等于用一份写死的常量向用户宣称主进程已经不提供的能力。回落一律标未接入。
    return '<span class="badge">未接入</span>';
    return p.deferred ? '<span class="badge">延后 · 需联调</span>' : '<span class="badge">已关闭</span>';
  }

  /** 插件开关的初始状态：以运行时为准 */
  function pluginSwitchedOn(id) {
    const rt = state.pluginRuntime;
    if (rt && rt.ready && Array.isArray(rt.plugins)) {
      const live = rt.plugins.find((x) => x.name === id);
      if (live) return live.active === true;
    }
    const p = PLUGINS.find((x) => x.id === id);
    return !!(p && p.on);
  }

  /** 深拷贝会话（分叉用）。structuredClone 不可用时回落到 JSON 往返。 */
  function deepClone(v) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(v); } catch { /* 含不可克隆值时回落 */ }
    }
    return JSON.parse(JSON.stringify(v));
  }

  /* ---------- 渲染：导航 ---------- */
  function renderRail() {
    // rail 常驻：三页导航（会话/插件/设置）+ 底部主题切换。
    // 历史注释承诺的「底部给模式切换」随双壳层/导航抽屉取消已不存在——模式切换改在
    // 设置页「沙箱与授权」与授权模式弹窗里，此处不再预留位置。
    $('#rail').innerHTML = `<button class="navbtn side-toggle" data-action="toggle-side" title="会话列表" aria-label="打开或收起会话列表">${ic('grid', 16)}<span class="nl">会话</span></button>` +
      PAGES.map((p) => `<button class="navbtn ${state.page === p.id ? 'active' : ''}" data-action="nav" data-id="${p.id}" title="${p.n}">${ic(p.icon)}<span class="nl">${p.n}</span></button>`).join('') +
      `<div class="sp"></div><button class="navbtn" data-action="toggle-theme" title="切换主题">${ic('sun')}<span class="nl">主题</span></button>`;
  }

  /* ---------- 渲染：消息（外部/用户可控内容统一转义，防 XSS） ---------- */
  // 转义表提到闭包外：每次调用 new 一个字面量对象，2MB 文本实测 43ms。
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }
  /* 右栏任务监控就地刷新（P1.3 实时刷新 + P2 演示回合共用同一份门控）。
     只在「待办」TAB 刷；替换前后保住 .ctx-body 滚动位置；替换后补 hardenActions
     （innerHTML 重建会丢掉委托层此前补的 tabindex）。 */
  function refreshCtxLive() {
    const ctxEl = $('#context');
    if (!ctxEl || !state.ctxOpen || state.page !== 'session') return;
    // 检查器只剩这一回合的步骤，不再按旧 TAB 跳过刷新。
    const body = ctxEl.querySelector('.ctx-body');
    const keep = body ? body.scrollTop : 0;
    ctxEl.innerHTML = VIEWS.session.ctx();
    if (keep) { const nb = ctxEl.querySelector('.ctx-body'); if (nb) nb.scrollTop = keep; }
    hardenActions(ctxEl);
  }
  /** 路径末段（目录名）：三处曾各写一遍同样的 replace/split/pop（评审 C-F2）。 */
  function dirBase(d) {
    const s = String(d ?? '');
    return s.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || s;
  }

  /* ---------- PRD FR-4.2 桌面集成 ---------- */
  /** 自启动描述如实反映「系统实际状态」：写了但系统没接受 → 明确提示，不假装已生效。 */
  function desktopAutostartDesc() {
    const d = state.desktop;
    if (!d) return '开机时启动 StepCode Desktop';
    if (d.config.autostart && d.autostartEffective === false) return '开机时启动 · 系统未接受该设置';
    return '开机时启动 StepCode Desktop';
  }

  /** 悬浮窗内容由渲染层推送（主进程不猜「当前会话」）。未开启悬浮窗时不发 IPC。 */
  /* ---------- PRD FR-8 沙箱日志 ---------- */
  /** 当前检索条件（从 state 直接组装，避免 UI 与请求各存一份）。 */
  function sandboxLogQuery() {
    return { keyword: state.sandboxLog.keyword, decision: state.sandboxLog.decision, kind: state.sandboxLog.kind, limit: 100 };
  }

  /** 合并主进程返回。r 为 null / 非对象 → 保持 loaded=false（UI 标注未接入）。 */
  function applySandboxLog(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.entries)) return;
    state.sandboxLog = {
      entries: r.entries,
      stats: r.stats || { total: 0, allowed: 0, denied: 0, error: 0, byTool: [] },
      total: Number(r.total) || r.entries.length,
      max: Number(r.max) || state.sandboxLog.max,
      keyword: state.sandboxLog.keyword,
      decision: state.sandboxLog.decision,
      kind: state.sandboxLog.kind,
      loaded: true,
    };
  }

  /* ---------- PRD FR-10 分层记忆与晋升 ---------- */
  // 四域与晋升方向。worker 的临时结论只能逐层往上走：worker → director → project → global。
  // global 是终点，没有再上一层的去处（跨项目长期记忆，写进去就是最终形态）。
  const MEM_DOMAIN_LABELS = { global: '全局', project: '项目', director: '总监', worker: '临时' };
  const MEM_DOMAIN_DESC = {
    global: '跨项目长期事实（写入即最终形态，无上层）',
    project: '当前项目沉淀（来自 director 晋升）',
    director: '总监域（Worker 结论经 Director 过滤后落此）',
    worker: 'SubAgent 临时结果（即用即走，出域须过 Director 过滤）',
  };
  /** 晋升的下一层。null = 已在顶层。 */
  const MEM_NEXT_DOMAIN = { worker: 'director', director: 'project', project: 'global', global: null };

  const MEM_REASON_LABELS = {
    'memory-service-unavailable': '记忆服务未加载',
    'bad-domain': '域名参数非法',
    'bad-id': '条目 id 非法',
    'entry-not-found': '条目不存在（可能已被晋升走）',
    'same-domain': '源域与目标域相同',
    'brain-filter-unavailable': 'Director 过滤器不可用（fail-closed，默认拒绝）',
    'director-filter-pending': 'Director 过滤回调未注入（fail-closed，默认拒绝）',
    'director-filter-timeout': 'Director 过滤超时（fail-closed，按拒绝处理）',
  };

  /** 把插件返回的英文 reason 翻成中文；未登记的按前缀归类后原样带出。 */
  function memReasonText(reason) {
    const r = String(reason || '');
    if (MEM_REASON_LABELS[r]) return MEM_REASON_LABELS[r];
    if (r.startsWith('director-rejected:')) return `Director 驳回（${r.slice('director-rejected:'.length)}）`;
    if (r.startsWith('promoted:')) return `已晋升 ${r.slice('promoted:'.length).replace('->', ' → ')}`;
    if (r.startsWith('error:')) return `执行异常：${r.slice('error:'.length)}`;
    return r;
  }

  /** 重拉当前域条目 + 四域统计。桥不可用时保持 loaded=false。 */
  function refreshMemoryDomain() {
    if (typeof bridge.listMemoryDomain !== 'function') {
      state.memory = { ...state.memory, items: [], stats: null, loaded: false };
      if (state.page === 'settings') render();
      return;
    }
    bridge.listMemoryDomain(state.memory.domain).then((r) => {
      state.memory.items = Array.isArray(r) ? r : [];
      // null = 服务不可用（主进程侧域名非法 / memory 插件未加载都会回 null）。
      // 必须和「接进了但域是空的」区分开：前者要报「未接入」，后者才说「暂无条目」。
      // 把 null 当空数组会让「记忆服务根本没起来」看起来像「还没跑过 SubAgent」。
      state.memory.loaded = Array.isArray(r);
      if (state.page === 'settings') render();
    }).catch(() => {
      state.memory.loaded = false;
      if (state.page === 'settings') render();
    });
    refreshMemoryPromotions();
  }

  /** 重拉当前摘要方式（LLM / 抽取式兜底）。桥不可用时保持 loaded=false。 */
  function refreshMemorySummarize() {
    if (typeof bridge.getMemorySummarizeStatus !== 'function') {
      state.memorySummarize = { ...state.memorySummarize, loaded: false };
      if (state.page === 'settings') render();
      return;
    }
    bridge.getMemorySummarizeStatus().then((r) => {
      if (!r || typeof r !== 'object') return;
      state.memorySummarize = {
        mode: r.mode === 'llm' ? 'llm' : 'extractive',
        provider: String(r.provider || ''),
        model: String(r.model || ''),
        seam: !!r.seam,
        loaded: true,
      };
      if (state.page === 'settings') render();
    }).catch(() => {
      state.memorySummarize = { ...state.memorySummarize, loaded: false };
      if (state.page === 'settings') render();
    });
  }

  function refreshMemoryPromotions() {
    if (typeof bridge.getMemoryPromotions !== 'function') return;
    bridge.getMemoryPromotions({ ok: state.memoryPromotions.ok, limit: 60 }).then((r) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.entries)) return;
      state.memoryPromotions = {
        entries: r.entries,
        stats: r.stats || { total: 0, promoted: 0, rejected: 0, byEdge: [] },
        total: Number(r.total) || r.entries.length,
        max: Number(r.max) || state.memoryPromotions.max,
        ok: state.memoryPromotions.ok,
        loaded: true,
      };
      if (state.page === 'settings') render();
    }).catch(() => {});
  }

  /* ---------- 连接器（PRD FR-3） ---------- */
  /** 重拉连接器目录 + 状态。桥不可用时保持 loaded=false，UI 显「未接入」。 */
  function refreshConnectors() {
    if (typeof bridge.getConnectors !== 'function') {
      state.connectors = { ...state.connectors, loaded: false };
      if (state.page === 'plugins') render();
      return;
    }
    bridge.getConnectors().then((r) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.items)) return;
      state.connectors = {
        items: r.items,
        stats: r.stats || { total: 0, configured: 0, tested: 0, ok: 0 },
        loaded: true,
        expanded: state.connectors.expanded,
      };
      if (state.page === 'plugins') render();
    }).catch(() => {
      state.connectors = { ...state.connectors, loaded: false };
      if (state.page === 'plugins') render();
    });
    refreshConnectorAudit();
  }

  /* ---------- 本地已安装技能 ---------- */
  /**
   * 重拉本地技能清单（主进程真实扫描 数据目录/skills/*.skill）。
   * 此前 installedSkills 只在安装时往内存数组里 push，重启即清零 —— 磁盘上有包
   * 却显示 0 个。合并时保留内存中的启用/停用开关（该开关暂未持久化，默认启用）。
   * ok=false（扫描失败）与 ok=true + 空数组（真没装）分开存，UI 分别标注。
   */
  function refreshInstalledSkills() {
    if (typeof bridge.listInstalledSkills !== 'function') {
      state.installedSkillsLoaded = false;
      return Promise.resolve();
    }
    return bridge.listInstalledSkills().then((r) => {
      if (!r || typeof r !== 'object') return;
      state.installedSkillsLoaded = r.ok === true;
      if (r.ok !== true || !Array.isArray(r.items)) return;
      state.installedSkills = r.items.map((it) => {
        const prev = state.installedSkills.find((x) => x.slug === it.slug);
        return {
          slug: String(it.slug),
          bytes: Number(it.bytes) || 0,
          installedAt: Number(it.installedAt) || 0,
          // 启用状态仅本次运行有效：未见过的按启用计，见过的沿用用户选择。
          enabled: prev ? prev.enabled !== false : true,
        };
      });
    }).catch(() => { state.installedSkillsLoaded = false; });
  }

  function refreshConnectorAudit() {
    if (typeof bridge.getConnectorAudit !== 'function') return;
    bridge.getConnectorAudit({ limit: 30 }).then((r) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.entries)) return;
      state.connAudit = {
        entries: r.entries,
        stats: r.stats || { total: 0, saves: 0, clears: 0, tests: 0, fails: 0 },
        total: Number(r.total) || r.entries.length,
        max: Number(r.max) || state.connAudit.max,
        loaded: true,
      };
      if (state.page === 'plugins') render();
    }).catch(() => {});
  }

  /* ---------- MCP（真接入） ---------- */
  /** 重拉 MCP 列表 + 连接状态。桥不可用保持 loaded=false，UI 显「未接入」。 */
  function refreshMcp() {
    if (typeof bridge.mcpList !== 'function') {
      state.mcp.loaded = false;
      return Promise.resolve();
    }
    return bridge.mcpList().then((r) => {
      if (!r || typeof r !== 'object') return;
      state.mcp = {
        servers: Array.isArray(r.servers) ? r.servers : [],
        stats: r.stats || { total: 0, configured: 0, connected: 0, tools: 0 },
        loaded: r.ok === true,
      };
      if (state.page === 'plugins') render();
    }).catch(() => { state.mcp.loaded = false; });
  }

  /** 连接器状态徽标。manual（无自动探测）与 http 的「未验证」语义不同，不能共用一个词。 */
  function connBadge(c) {
    const st = c.state || {};
    if (!st.configured) return '<span class="ib badge">未配置</span>';
    if (c.manual) return st.lastTestOk === true ? '<span class="ib badge ok">已验证</span>' : '<span class="ib badge warn">已保存 · 不可自动验证</span>';
    if (st.lastTestOk === true) return '<span class="ib badge ok">已连接</span>';
    if (st.lastTestOk === false) return '<span class="ib badge warn">连通失败</span>';
    return '<span class="ib badge warn">已配置 · 未验证</span>';
  }

  /* ---------- 本地插件市场（PRD FR-3） ---------- */
  function refreshMarket() {
    if (typeof bridge.getMarketPlugins !== 'function') {
      state.market = { ...state.market, loaded: false };
      if (state.page === 'plugins') render();
      return;
    }
    bridge.getMarketPlugins().then((r) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.items)) return;
      state.market = { items: r.items, dir: String(r.dir || ''), count: Number(r.count) || 0, loaded: true, busy: state.market.busy };
      if (state.page === 'plugins') render();
    }).catch(() => {
      state.market = { ...state.market, loaded: false };
      if (state.page === 'plugins') render();
    });
  }

  /** 市场插件状态徽标：装载完成 ≠ 激活（依赖未满足时必须可区分）。 */
  function marketBadge(m) {
    if (!m.manifestOk) return '<span class="ib badge warn">manifest 非法</span>';
    if (!m.hasEntry) return '<span class="ib badge warn">缺 index.js</span>';
    if (m.active) return '<span class="ib badge ok">已启用</span>';
    if (m.enabled) return '<span class="ib badge warn">已启用 · 未激活</span>';
    return '<span class="ib badge">未启用</span>';
  }

  /**
   * 技能市场单元格：按本地已安装清单（磁盘真实扫描）反映状态。
   * 此前恒定渲染「安装」按钮 —— 安装成功后按钮文字不变，用户无法判断装没装上
   * （重试/重复安装的根源）。已安装 → 绿色「已安装」标记 + 可「重装」覆盖。
   */
  function skillInstallCell(slug) {
    const installed = (state.installedSkills || []).some((s) => s.slug === slug);
    if (installed) {
      return `<span class="badge ok" title="本地已安装（数据目录 skills/${esc(slug)}.skill）">已安装</span>`
        + `<button class="btn sm ghost" data-action="guanji-install" data-slug="${esc(slug)}" title="重新下载覆盖">重装</button>`;
    }
    return `<button class="btn sm primary" data-action="guanji-install" data-slug="${esc(slug)}">安装</button>`;
  }

  /* ---------- FR-5 用量追踪 ---------- */
  function refreshUsage() {
    if (typeof bridge.getUsage !== 'function') {
      state.usage = { ...state.usage, loaded: false };
      if (state.page === 'settings') render();
      return;
    }
    bridge.getUsage().then((r) => {
      if (!r || typeof r !== 'object') return;
      // 桥在但 IPC 出错 ≠ 未接入——错误态必须显式标注（审阅裁决：把异常显示成「未接入」同样违反「状态不许撒谎」）
      if (r.ok === false) {
        state.usage = { ...state.usage, loaded: false, error: String(r.reason || '读取失败') };
        if (state.page === 'settings') render();
        return;
      }
      if (!r.total) return;
      state.usage = { loaded: true, error: null, total: r.total,
        byModel: Array.isArray(r.byModel) ? r.byModel : [],
        bySession: Array.isArray(r.bySession) ? r.bySession : [] };
      if (state.page === 'settings') render();
    }).catch((err) => {
      state.usage = { ...state.usage, loaded: false, error: (err && err.message) ? String(err.message) : '桥接调用异常' };
      if (state.page === 'settings') render();
    });
  }

  /** token 数量的人类可读形态（12.3k / 4.56M）。 */
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  }

  /** FR-5 用量卡片：真实记账（只统计网关上报过 usage 的回合）。「未接入」≠「0」≠「读取失败」。 */
  function renderUsageCard() {
    const u = state.usage;
    if (!u.loaded) {
      if (u.error) {
        return `<div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px">
          <div class="row" style="justify-content:space-between"><b style="font-size:12px">用量追踪</b><span class="badge warn">读取失败</span></div>
          <div class="faint" style="font-size:11.5px;margin-top:4px">主进程用量读取失败：${esc(u.error)}（重新打开设置页可重试）。</div>
        </div>`;
      }
      return `<div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px">
        <div class="row" style="justify-content:space-between"><b style="font-size:12px">用量追踪</b><span class="badge">未接入</span></div>
        <div class="faint" style="font-size:11.5px;margin-top:4px">主进程未接入用量桥接，无法显示真实记账。</div>
      </div>`;
    }
    const rows = (u.byModel || []).map((m) => `<tr>
      <td class="mono" style="font-size:11.5px">${esc(m.model)}</td>
      <td style="text-align:right" class="mono">${fmtTokens(m.promptTokens)}</td>
      <td style="text-align:right" class="mono">${fmtTokens(m.completionTokens)}</td>
      <td style="text-align:right" class="mono"><b>${fmtTokens(m.totalTokens)}</b></td>
      <td style="text-align:right" class="faint">${m.turns} 回合</td>
    </tr>`).join('');
    return `<div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px">
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <b style="font-size:12px">用量追踪</b>
        <span class="row" style="gap:8px">
          <span class="faint" style="font-size:11px">合计 ↑${fmtTokens(u.total.promptTokens)} · ↓${fmtTokens(u.total.completionTokens)} · 总 ${fmtTokens(u.total.totalTokens)} · ${u.total.turns} 回合</span>
          <button class="btn sm ghost" data-action="usage-refresh">刷新</button>
          <button class="btn sm ghost" data-action="usage-clear">清空</button>
        </span>
      </div>
      ${(u.total.turns ? `<table style="width:100%">
        <tr><th style="text-align:left">模型</th><th style="text-align:right">输入 tokens</th><th style="text-align:right">输出 tokens</th><th style="text-align:right">合计</th><th style="text-align:right">回合</th></tr>
        ${rows}
      </table>` : '<div class="faint" style="font-size:11.5px">尚无用量记录 —— 网关未上报 usage 的回合不记账（「没上报」≠「0 token」）。</div>')}
    </div>`;
  }

  /* ---------- FR-6 事件流回放数据源（ADR-0009） ---------- */
  function refreshSessionEvents(sid) {
    // P4-S4-5：读取失败要与「桥真缺失」分开记——前者是「查不到」，后者是「没得查」。
    state.sessionEvents.error = '';
    state.sessionEvents.bridgeMissing = false;
    if (typeof bridge.getSessionEvents !== 'function') {
      // 桥真缺失：loaded 保持 false + bridgeMissing 标记，replaySourceNote 显示「未接入」
      state.sessionEvents = { sid: sid, data: null, loaded: false, error: '', bridgeMissing: true };
      render();
      return;
    }
    bridge.getSessionEvents(sid).then((r) => {
      // 异步竞态防线：回来时用户可能已切到另一个会话的回放
      if (state.replayFor !== sid) return;
      state.sessionEvents = { sid: sid, data: (r && typeof r === 'object') ? r : null, loaded: true, error: '', bridgeMissing: false };
      render();
    }).catch((err) => {
      if (state.replayFor !== sid) return;
      // P4-S4-5：IPC 抛错是「查失败」，不是「没接入」——带上原因，别再冒充未接入
      state.sessionEvents = { sid: sid, data: null, loaded: true, error: (err && err.message) || '未知错误', bridgeMissing: false };
      render();
    });
  }

  /* ---------- PRD FR-4.2 数据目录内容清单 ---------- */
  /**
   * 重拉数据目录清单。清单只在启动时取一次，导入数据 / 导出快照之后体积会变，
   * 所以给用户一个手动刷新入口 —— 否则 UI 上的数字会一直停在启动那一刻。
   */
  function refreshDataDirInventory() {
    if (typeof bridge.getDataDirInventory !== 'function') {
      state.dataDirInventory = { ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] };
      if (state.page === 'settings') render();
      return;
    }
    bridge.getDataDirInventory().then((r) => {
      state.dataDirInventory = (r && typeof r === 'object')
        ? r
        : { ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] };
      if (state.page === 'settings') render();
    }).catch(() => {});
  }

  /** 重拉日志并只重绘设置区（不整体 render，避免打断输入框光标）。 */
  function refreshSandboxLog() {
    if (typeof bridge.getSandboxLog !== 'function') return;
    bridge.getSandboxLog(sandboxLogQuery()).then((r) => {
      applySandboxLog(r);
      if (state.page === 'settings') render();
    }).catch(() => {});
  }

  function pushFloatingContext() {
    const d = state.desktop;
    if (!d || !d.config || !d.config.floating) return;
    if (typeof bridge.setFloatingContext !== 'function') return;
    const cur = state.sessions[state.sel];
    const sessions = Object.values(state.sessions).filter((s) => s && s.msgs && s.msgs.length).length;
    bridge.setFloatingContext({ title: (cur && cur.title) || '', sessions }).catch(() => {});
  }

  /**
   * 单个桌面集成开关。state.desktop 为 null（桥未接入 / 浏览器预览）时降级为
   * 不可点 + 标注「未接入」，避免又出现「UI 可点但不生效」的死挂点。
   */
  function desktopItem(key, name, desc, mono) {
    const d = state.desktop;
    const on = !!(d && d.config && d.config[key]);
    const disabled = !d;
    return `<div class="desktop-item"${disabled ? ' title="主进程未接入，当前为浏览器预览"' : ''}>
      <div><div class="di-name">${esc(name)}</div><div class="di-desc${mono ? ' mono' : ''}" data-desktop-desc="${esc(key)}">${esc(desc)}</div></div>
      <div class="switch ${on ? 'on' : ''}${disabled ? ' disabled' : ''}" data-action="desktop-toggle" data-dk="${esc(key)}" role="switch" aria-checked="${on}" aria-label="${esc(name)}"></div>
    </div>`;
  }
  /**
   * 主区回合条。右栏默认关闭，进行中的状态、进度和原因不能只放在那里。
   * 数据与右栏同源（toolSteps / pendingConfirm），不另造一份。
   */
  function renderTurnStrip(s) {
    const live = Array.isArray(state.toolSteps[s.id]) ? state.toolSteps[s.id] : [];
    const running = state.turnBusy === s.id;
    const waiting = !!state.pendingConfirm;
    const stopped = state.turnStopped && state.turnStopped.id === s.id;
    const doneTurn = state.turnDone && state.turnDone.id === s.id;
    if (!running && !waiting && !stopped && !doneTurn) return '';
    const done = live.filter((t) => t.ph === 'done').length;
    const current = [...live].reverse().find((t) => t.ph !== 'done') || live[live.length - 1];
    // 步骤只有名字和结果，没有「为什么」。不编造原因，只把已有的两段显式标出来。
    const doing = current ? (current.n || '工具') : (waiting ? '一个需要你确认的动作' : '组织回复');
    const outcome = current && current.result ? String(current.result) : '';
    const label = doneTurn && !running ? '已完成' : (stopped ? '已停止' : (waiting ? '等待确认' : '正在进行'));
    const tone = doneTurn && !running ? 'done' : (stopped ? 'stop' : (waiting ? 'wait' : 'run'));
    const progress = live.length ? `${done}/${live.length}` : '';
    return `<div class="turn-strip ${tone}" role="status">
      <span class="turn-label">${label}</span>
      <span class="turn-reason">${doneTurn && !running ? '这一回合已完成' : (stopped ? '这一回合已停止，可以修改后再发送' : '在做 ' + esc(doing))}</span>
      ${!stopped && outcome ? `<span class="turn-outcome">${esc(outcome)}</span>` : ''}
      ${progress ? `<span class="turn-progress">${progress}</span>` : ''}
    </div>`;
  }

  /** 会话页的记忆一行。没有统计就不渲染，避免空话。 */
  function renderMemoryLine() {
    const stats = state.memory && state.memory.stats;
    if (!stats) return '';
    const total = ['global', 'project', 'director', 'worker']
      .reduce((n, k) => n + (typeof stats[k] === 'number' ? stats[k] : 0), 0);
    if (!total) return '';
    return `<div class="memory-line">记得 ${total} 条：项目 ${Number(stats.project) || 0} · 全局 ${Number(stats.global) || 0}</div>`;
  }

  function renderMsg(m, sid) {
    const isU = (m.r || m.role) === 'user';
    const intentBadge = m.intent && m.intent !== 'ACT'
      ? (m.intent === 'CONFIRM' ? `<span class="badge warn">意图 · 待确认</span>` : `<span class="badge danger">意图 · 已拦截</span>`)
      : '';
    const tools = (m.tools && m.tools.length) ? `<details class="tools"><summary>${ic('chev', 14)} ${m.steps} 步 · ${m.tools.length} 个动作</summary>${m.tools.map((t) => toolRow(t)).join('')}</details>` : '';
    const sub = m.sub ? `<div class="subagent"><span class="badge ${m.sub.state === 'running' ? 'warn' : 'info'}">SubAgent</span><span class="mono">${esc(m.sub.name)}</span><span class="phases faint">${m.sub.state === 'running' ? '执行中 · 即用即走' : '已回收并销毁'}</span></div>` : '';
    // FR-5：单回合 token 徽标（网关没上报 usage 的回合没有该字段，不显示假 0）
    const tok = (m.tok && Number.isFinite(m.tok.p) && Number.isFinite(m.tok.c))
      ? `<span class="faint mono" style="font-size:11px;margin-left:6px">↑${fmtTokens(m.tok.p)} ↓${fmtTokens(m.tok.c)}</span>` : '';
    // BUG-036：这两个按钮在 app.js 里没有任何 data-action="trace" 的分发分支，
    // 点了不发 bridge.traceFeedback，state.feedback 也只从持久会话记录里回填。
    // 也就是说它是一个「承诺了用途的死控件」，而 trace 已按 SPEC 删除清单卸下且不迁移，
    // 主进程 orchdesk:trace-feedback 恒返回 unavailable。
    // 因此整块反馈控件（含那句不会发生的成功回执文案）一并撤掉；要恢复得先接一个真实落点。
    const fb = '';
    const raw = m.x || m.text || '';
    let txt;
    if (m.typing) {
      // BUG（全盘死挂点扫描）：typing 期间实时读 state.toolSteps[sid]（onToolStep 订阅
      // 写入、此前零读取）。主进程每步推送都会触发 render()，用户能看到工具正在跑，
      // 而非永远只显示「思考中…」直到整回合结束。
      const liveSteps = (sid && Array.isArray(state.toolSteps[sid]) && state.toolSteps[sid].length)
        ? state.toolSteps[sid]
        : null;
      const streamed = String(raw || '');
      const streamHtml = streamed ? `<div class="stream-partial">${esc(streamed)}</div>` : '';
      if (!liveSteps) {
        txt = streamHtml ? streamHtml + '<span class="faint">生成中…</span>' : '<span class="faint">思考中…</span>';
      } else {
        // 本轮 UI 重构：思考链默认折叠（只显示最近一步，不让工具流刷屏），
        // 右侧箭头可展开/收起完整明细。key 用 sid|t 唯一定位这条 typing 消息。
        const key = `${sid}|${m.t}`;
        const open = state.thinkExpanded.has(key);
        txt = streamHtml + `<div class="think-head"><span class="faint">思考中 · 正在执行 ${liveSteps.length} 个工具…</span>`
          + `<button class="think-toggle${open ? ' open' : ''}" data-action="think-toggle" data-k="${esc(key)}"`
          + ` title="${open ? '收起' : '展开'}思考链详情" aria-expanded="${open}">${ic('chevDown', 13)}</button></div>`
          + (open
            ? `<div class="think-detail">${liveSteps.map((st) => toolRow(st, true)).join('')}</div>`
            : toolRow(liveSteps[liveSteps.length - 1], true));
      }
    } else if (isU) {
      txt = esc(raw);
    } else {
      // Agent 回复：检测是否整条是纯代码块 → 否则 Markdown 渲染
      const trimmed = raw.trim();
      const fullCode = trimmed.match(/^```(\w*)\n([\s\S]*)\n```$/);
      if (fullCode) {
        txt = `<pre><code>${esc(fullCode[2].trim())}</code></pre>`;
      } else {
        txt = renderMD(raw);
      }
    }
    return `<div class="msg ${isU ? 'user' : 'agent'}${m.typing ? ' typing' : ''}">
      <div class="avatar">${isU ? '我' : 'AI'}</div>
      <div class="body"><div class="meta"><b>${isU ? '你' : 'StepCode'}</b><span>${m.t}</span>${intentBadge}${tok}</div>
      <div class="md-body">${txt}</div>${sub}${tools}${fb}</div></div>`;
  }

  /* ---------- 需求1：语义化的大任务步骤（待办数据源） ---------- */
  // 旧实现把 m.tools 的工具名（file_read / shell_command…）直接当待办条目，于是侧栏
  // 里清一色是命令执行。真正有用的待办是 Agent 对「用户这个请求」做的任务分拆
  // （调研可行性 / 多子代理审阅 / 头脑风暴 / UI 重构 / 提交推送 …）。
  // 用户裁决「两者结合」，故两级来源：
  //   ① 结构化 plan 块：```orch-plan / ```plan 围栏 或 <plan>…</plan>，支持 - [x] 完成标记
  //   ② 回退：Agent 正文里的 markdown 列表（checkbox 任务清单优先，其次「计划/步骤」小节下的列表）
  // 工具调用不再是待办，降为折叠的「执行明细」——那是手段，不是任务本身。
  function parseStepLine(line) {
    let s = (line || '').trim();
    if (!s) return null;
    let done = false;
    let m = s.match(/^[-*+]\s*\[([ xX])\]\s*(.+)$/);
    if (!m) m = s.match(/^\d+[.)]\s*\[([ xX])\]\s*(.+)$/);
    if (m) { done = m[1].toLowerCase() === 'x'; s = m[2].trim(); }
    else {
      const p = s.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
      if (!p) return null;   // 不是列表行 → 不是步骤
      s = p[1].trim();
    }
    // 行内状态标记（模型常用 emoji 而不是 checkbox）
    if (/^(?:✅|☑|✔)/.test(s) || /（已完成）|\(done\)/i.test(s)) done = true;
    s = s.replace(/^(?:✅|☑|✔|⏳|🔄|▶)\s*/, '').trim();
    if (!s || s.length > 120) return null;   // 过长的是正文而非步骤标题
    return { text: s, done };
  }

  function extractPlanSteps(msgs) {
    const isAgent = (m) => { const r = m.r || m.role; return r === 'agent' || r === 'assistant'; };
    const steps = [];
    // ① 结构化 plan 块
    (msgs || []).forEach((m) => {
      if (!isAgent(m)) return;
      const raw = m.x || m.text || '';
      const blocks = [];
      const fenceRe = /```(?:orch-plan|plan)\s*\n([\s\S]*?)```/gi;
      const tagRe = /<plan>([\s\S]*?)<\/plan>/gi;
      let mt;
      while ((mt = fenceRe.exec(raw))) blocks.push(mt[1]);
      while ((mt = tagRe.exec(raw))) blocks.push(mt[1]);
      blocks.forEach((b) => b.split(/\r?\n/).forEach((ln) => {
        const st = parseStepLine(ln);
        if (st) steps.push(st);
      }));
    });
    if (steps.length) return { steps, source: 'plan' };

    // ② 回退：正文 markdown 列表（先剔除代码块，避免把代码注释/数组当步骤）
    (msgs || []).forEach((m) => {
      if (!isAgent(m)) return;
      const raw = m.x || m.text || '';
      const lines = raw.split(/```/).filter((_, i) => i % 2 === 0).join('\n').split(/\r?\n/);
      let inPlanSection = false;
      lines.forEach((ln) => {
        if (/^\s{0,3}#{1,6}\s+/.test(ln) || /^[^`]{0,40}[：:]\s*$/.test(ln)) {
          inPlanSection = /(计划|步骤|安排|任务|方案|路线|待办|plan|step|todo|checklist)/i.test(ln);
          return;
        }
        const isCheckbox = /^\s*[-*+]\s*\[[ xX]\]/.test(ln);
        const st = parseStepLine(ln);
        if (st && (isCheckbox || inPlanSection)) steps.push(st);
      });
    });
    return { steps, source: steps.length ? 'list' : 'none' };
  }

  /* ---------- 渲染：侧栏（分组 / 项目切换 + 文件夹图标） ---------- */
  // 会话行（侧栏三处共用：项目展开 / 轻模式目录分组 / 任务组）。提为函数声明是为了
  // 让定义在前、调用在后的 renderProject 也能共用同一份实现——此前 renderProject 里
  // 内联了一份副本，改样式要改两处（评审 C-F1）。
  function sessItem(s) {
    return `<div class="sess ${state.sel === s.id ? 'active' : ''}" data-action="sel" data-id="${s.id}">
          <span class="sn" title="${esc(s.title)} ${esc(s.expert)}">${esc(s.title)}</span>
          ${s.updated !== '刚刚' ? `<span class="st">${esc(s.updated)}</span>` : ''}
          <button class="opbtn" data-action="sess-menu" data-id="${s.id}" title="会话操作" aria-label="会话操作">···</button>
        </div>`;
  }

  function renderSideSession() {
    const active = state.projects.filter(p => !p.archived);
    const archived = state.projects.filter(p => p.archived);

    const renderProject = (p) => {
      const expanded = state.pExpanded.has(p.id);
      return `<div class="proj">
        <div class="proj-head" data-action="proj-toggle" data-id="${p.id}">
          <span class="pf ${expanded ? 'open' : ''}">${ic('chev', 12)}</span>
          ${p.path ? '<span class="pf-open" style="color:var(--fg-faint);font-size:12px" title="有本地文件夹">' + ic('folderOpen', 14) + '</span>' : '<span class="pf-open" style="color:var(--fg-faint);font-size:12px" title="无文件夹绑定">' + ic('folder', 14) + '</span>'}
          <span class="pn">${esc(p.n)}</span>
          <span class="pm" style="display:flex;gap:1px;align-items:center">
            <button class="opbtn" data-action="proj-menu" data-id="${p.id}" title="项目操作">···</button>
          </span>
        </div>
        ${expanded ? `<div class="proj-list">${p.sessions.map((sid) => {
          const s = state.sessions[sid]; if (!s) return '';
          return sessItem(s);
        }).join('')}</div>` : ''}
      </div>`;
    };

    const activeBlocks = active.map(renderProject).join('');

    // 归档 - 折叠
    const archBlocks = archived.map(renderProject).join('');
    const archExpanded = state.pExpanded.has('__archived__');
    const archToggle = archBlocks ? `<div class="proj-head" data-action="proj-toggle" data-id="__archived__" style="opacity:0.6">
      <span class="pf ${archExpanded ? 'open' : ''}">${ic('chev', 12)}</span>
      <span class="pn" style="color:var(--fg-dim);text-transform:none;font-weight:500;letter-spacing:0;font-size:12px">已归档</span>
    </div>${archExpanded ? `<div class="proj-list">${archBlocks}</div>` : ''}` : '';

    // 任务模式会话（不属于任何项目的独立会话）
    const allProjectIds = new Set(state.projects.map(p => p.id));
    const taskSessions = Object.values(state.sessions).filter(s => s.pid === '__task__' || !allProjectIds.has(s.pid));
    let taskBlock = '';
    if (taskSessions.length) {
      // P1.4 轻模式：轻会话按工作目录分组（无 cwd 的归「任务」组，行为与旧版一致）
      const wsMap = new Map();
      const noWs = [];
      taskSessions.forEach((s) => {
        const d = String(s.cwd || '').trim();
        if (d) { if (!wsMap.has(d)) wsMap.set(d, []); wsMap.get(d).push(s); }
        else noWs.push(s);
      });
      const blocks = [];
      for (const [d, list] of wsMap) {
        const key = 'ws:' + d;
        const exp = state.pExpanded.has(key);
        blocks.push(`<div class="proj">
      <div class="proj-head" data-action="proj-toggle" data-id="${esc(key)}" title="${esc(d)}">
        <span class="pf ${exp ? 'open' : ''}">${ic('chev', 12)}</span>
        <span class="pf-open" style="color:var(--fg-faint)">${ic('folder', 14)}</span>
        <span class="pn" style="text-transform:none;font-weight:500;letter-spacing:0;font-size:12px">${esc(dirBase(d))}</span>
        <span class="pc">${list.length}</span>
      </div>
      ${exp ? `<div class="proj-list">${list.map(sessItem).join('')}</div>` : ''}
    </div>`);
      }
      if (noWs.length) {
        const exp = state.pExpanded.has('__task__');
        blocks.push(`<div class="proj">
      <div class="proj-head" data-action="proj-toggle" data-id="__task__">
        <span class="pf ${exp ? 'open' : ''}">${ic('chev', 12)}</span>
        <span class="pn" style="color:var(--fg-faint);text-transform:none;font-weight:500;letter-spacing:0;font-size:12px">${ic('zap', 14)} 任务</span>
        <span class="pc">${noWs.length}</span>
      </div>
      ${exp ? `<div class="proj-list">${noWs.map(sessItem).join('')}</div>` : ''}
    </div>`);
      }
      taskBlock = blocks.join('');
      // project 态：原有「任务」组
      const taskExpanded = state.pExpanded.has('__task__');
      taskBlock = `<div class="proj">
      <div class="proj-head" data-action="proj-toggle" data-id="__task__">
        <span class="pf ${taskExpanded ? 'open' : ''}">${ic('chev', 12)}</span>
        <span class="pn" style="color:var(--fg-faint);text-transform:none;font-weight:500;letter-spacing:0;font-size:12px">${ic('zap', 14)} 任务</span>
        <span class="pc">${taskSessions.length}</span>
      </div>
      ${taskExpanded ? `<div class="proj-list">${taskSessions.map(sessItem).join('')}</div>` : ''}
    </div>`;
    }

    // P4-S1-10：原实现这里只有一个「项目」tab、无 data-action，CSS 却给了 cursor:pointer
    // 和 hover 背景——看着是可切换的过滤器，点了没有任何反应；标签还承诺了一个不存在
    // 的「任务」tab。改为如实描述当前列表内容的静态标签（可点样式在 CSS 里按容器限定）。
    return `<div class="proj-seg">
      <span class="seg-label">项目 / 任务</span>
      <div class="seg-tabs">
        <span class="seg-tab active" title="项目与其下会话；轻会话按工作目录分组">项目</span>
      </div>
    </div>
    <div class="row" style="gap:6px;padding:4px 10px 8px">
      <button class="btn sm ghost" data-action="home-create-proj" title="新建项目并绑定本地文件夹">新建项目</button>
      <span style="flex:1"></span>
      <button class="iconbtn" data-action="newconv" title="新建会话" aria-label="新建会话">${ic('plus', 14)}</button>
    </div>` + activeBlocks + taskBlock + archToggle + `<div class="fab-wrap"><button class="fab" data-action="newconv" title="新建会话">${ic('plus', 22)}</button></div>`;
  }

  function getGreeting() {
    const h = new Date().getHours();
    let g;
    if (h < 6) g = '夜深了，注意休息';
    else if (h < 9) g = '早上好';
    else if (h < 12) g = '上午好';
    else if (h < 14) g = '中午好';
    else if (h < 18) g = '下午好';
    else if (h < 20) g = '傍晚好';
    else if (h < 22) g = '晚上好';
    else g = '夜深了，注意休息';
    return g + '! 一起来做点什么呢？';
  }

  /* R2-5：智能推荐（getSmartRecommendations）随首页改版整链失去调用者——渲染它的
     .home-quick-actions 已不存在，依赖它的 quick-* 八个动作注册因此不可达；且该函数
     即使被调用也是坏的（读 m.text / m.role，而消息结构用 m.x / m.r）。删除。 */
  function thinkLabel(l) { return ({ off: '关闭', standard: '标准', deep: '深度', max: '最大' })[l] || '标准'; }

  /* P4：意图门状态从运行时读，不写死。原实现是一行静态 HTML「本地模型」+ 绿点，
     意图门插件未装载/被停用时 UI 仍宣称本地模型在初筛，placeholder 也承诺「先经意图
     识别插件初筛」——安全初筛控件的状态是编造的（铁律：fail-closed + UI 不许撒谎）。
     判定与 pluginBadge / 能力 TAB 同源：运行时 ready 且插件 active 才叫就绪。 */
  function intentCtlState() {
    const rt = state.pluginRuntime;
    const ready = !!(rt && rt.ready && Array.isArray(rt.plugins));
    const live = ready ? rt.plugins.find((x) => x.name === 'intent') : null;
    if (live && live.active) {
      return { label: '本地模型', color: 'var(--ok)', placeholderSuffix: '（先经意图识别插件初筛）', tip: '意图识别插件已启用：prompt 到达模型前先做本地初筛' };
    }
    if (live && !live.available) {
      return { label: '未接入 · 按拒绝处理', color: 'var(--warn)', placeholderSuffix: '', tip: '意图识别插件未接入：fail-closed 按拒绝处理，高风险 prompt 会被拦下并转人工确认' };
    }
    if (live) {
      return { label: '已停用 · 按拒绝处理', color: 'var(--warn)', placeholderSuffix: '', tip: '意图识别插件已停用：fail-closed 按拒绝处理' };
    }
    if (ready) {
      return { label: '未装载 · 按拒绝处理', color: 'var(--warn)', placeholderSuffix: '', tip: '意图识别插件未装载：fail-closed 按拒绝处理' };
    }
    return { label: '运行时未接入 · 按拒绝处理', color: 'var(--warn)', placeholderSuffix: '', tip: '插件运行时未接入，无法确认意图门状态：fail-closed 按拒绝处理' };
  }

  function workdirChipHTML() {
    const s = state.sessions[state.sel];
    const bound = s ? (projectPathOf(s.id) || String(s.cwd || '').trim()) : '';
    const dir = bound || String(state.workspaceDir || '').trim();
    const label = dir ? dirBase(dir) : '设置工作目录';
    return `<button type="button" class="ws-chip" data-action="ws-pick" title="${esc(dir || '设置工作目录')}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      <span>${esc(label)}</span>
      <span class="ws-change">更改</span>
    </button>`;
  }

  function composerBarHTML(sendAction) {
    const thinkIdx = ({ off: 0, standard: 1, deep: 2, max: 3 })[state.thinkLevel] || 1;
    const intentCtl = intentCtlState();
    return `<div class="bar">
        <div class="composer-chips">
          ${workdirChipHTML()}
          <button type="button" class="auth" data-action="auth-open" title="授权模式：${authModeLabel(state.authMode)}">${ic('shield', 14)}<span>${authModeLabel(state.authMode)}</span></button>
          <div class="composer-more">
            <button class="t-btn" data-action="composer-more-toggle" data-tip="更多选项">${ic('more')}</button>
            <div class="composer-more-dropdown ${state.composerMoreOpen ? 'open' : ''}" id="composerMore">
              <div class="composer-more-item" data-action="skill-add">
                <span class="cm-icon">${ic('plus', 16)}</span>
                <span class="cm-label">加载技能</span>
              </div>
              <div class="composer-more-item" data-action="expert-add">
                <span class="cm-icon">${ic('at', 16)}</span>
                <span class="cm-label">引用专家或专家团</span>
              </div>
              <div class="composer-more-sep"></div>
              <div class="composer-more-item think-item">
                <div class="think-row"><span class="cm-label">思维深度</span><span class="tl">${thinkLabel(state.thinkLevel)}</span></div>
                <input type="range" min="0" max="3" step="1" value="${thinkIdx}" data-action="think-slider" aria-label="思维深度" aria-valuetext="${thinkLabel(state.thinkLevel)}">
              </div>
              <div class="composer-more-item" style="cursor:default" title="${esc(intentCtl.tip)}">
                <span class="cm-icon"><span class="dot" style="background:${intentCtl.color};width:7px;height:7px;border-radius:50%"></span></span>
                <span class="cm-label">意图识别</span>
                <span class="cm-val">${esc(intentCtl.label)}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="right">
          ${modelChipHTML()}
          <button class="btn sm primary" data-action="${sendAction}">发送</button>
        </div>
      </div>`;
  }

  function renderComposer(s) {
    const intentCtl = intentCtlState();
    renderTrayHint();
    // R2-6：expert 名来自编排插件目录（外部数据），直插 placeholder 属性未转义——
    // 含 " 会撑破属性、其余内容泄流成杂散属性。同文件另两处消费 s.expert 都走了 esc()。
    // 这条注释原先写成 JSX 的花括号注释形态：本文件是普通 JS 模板串，不是 JSX，
    // 于是整段文字被当内容渲染进作曲栏上方（实测截图可见）。
    return `<div class="composer"><div class="box">
      <textarea id="composer" placeholder="向 ${esc(s.expert)} 发消息…${intentCtl.placeholderSuffix}"></textarea>
      <div id="outboundWarn" class="outbound-warn" hidden></div>
      ${composerBarHTML('send')}
    </div></div>`;
  }

  /* ---------- P2：composer 模型 chip（内嵌配置入口，spec §5.3） ----------
   * 四态取代原来「有模型才显示、没有就写死选择模型」的按钮：
   *   ready  = 有可用模型     → 绿点 + 模型名，点击开模型选择器（原行为）
   *   ollama = 本机有 Ollama  → 橙点 + 「发现 Ollama · 一键接入」
   *   none   = 两者皆无       → 黄点 + 「未配置模型」，点击开内嵌预设面板
   *   demo   = 演示模式中     → 明确标注，不伪装成真模型（UI 不许撒谎）
   * 欢迎页与会话页 composer 共用同一份（原为两处逐字重复的按钮）。 */
  function modelChipState() {
    // 就绪态优先于演示态：万一 autoSelectModels 的退出没跑到（并发/异常），
    // 有真模型时就绝不再显示「演示模式」——UI 不许撒谎。
    if (state.selectedModels.length) {
      return {
        kind: 'ready',
        label: state.selectedModels.length > 1 ? state.selectedModels.length + ' 个模型' : state.selectedModels[0],
        tip: '当前可用模型，点击切换',
      };
    }
    if (state.demoMode) return { kind: 'demo', label: '演示模式', tip: '当前回复是本地回显，未调用任何模型。点击配置真模型' };
    const hasOllamaProvider = (state.modelProviders || []).some((p) => p.type === 'ollama');
    if (state.ollama.ok && state.ollama.models.length && !hasOllamaProvider) {
      return { kind: 'ollama', label: '发现 Ollama · 一键接入', tip: `本机 Ollama 有 ${state.ollama.models.length} 个模型，点击即接入` };
    }
    return { kind: 'none', label: '未配置模型', tip: '点击用 models.dev 预设 + KEY 两步完成配置' };
  }
  function modelChipHTML() {
    const st = modelChipState();
    const dot = st.kind === 'ready' ? 'var(--ok)' : st.kind === 'demo' ? 'var(--accent-fg)' : 'var(--warn)';
    const multi = st.kind === 'ready' && state.selectedModels.length > 1 ? ' multi' : '';
    return `<button class="c-mp mp-${st.kind}${multi}" data-action="${st.kind === 'ollama' ? 'ollama-adopt' : 'model-pick'}" title="${esc(st.tip)}" aria-label="${esc(st.tip)}"><span class="md" style="background:${dot}"></span><span class="mn">${esc(st.label)}</span>${st.kind === 'ready' ? ic('chev', 12) : ''}</button>`;
  }

  /* ---------- P2：内嵌模型配置面板 + Ollama 一键接入 ---------- */
  // 复用设置页同一套 mp* 表单状态与动作（预设下拉 / KEY 防抖拉取 / 默认全选），
  // 只把「类型/名称/URL/协议」收进高级折叠——轻用户看到的就是两步。
  function openModelSetupModal() {
    openModal(`<div class="mh">${ic('bot', 18)}<b>配置模型</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:12px">两步完成：① 选预设（或直接粘 KEY）→ ② 点「添加并开始聊天」。模型列表会自动拉取并默认全选。</div>
        <div class="mp-form">
          <div class="mp-row">
            <label class="mp-label">① 提供商预设</label>
            <div class="mp-preset">
              ${mpPresetControlHTML()}
              ${state.mpPresetOpen ? mpPresetPopHTML() : ''}
            </div>
          </div>
          <div class="mp-row">
            <label class="mp-label">② API Key</label>
            <input type="password" id="mp-key" placeholder="sk-...（Ollama 本地可留空）" class="mp-inp">
          </div>
          <div class="mp-row">
            <label class="mp-label">模型</label>
            <div class="mp-models-wrap"><div id="mp-models-pool">${mpModelsPoolHTML()}</div></div>
          </div>
          <details class="mp-adv"${state.mpEditing ? ' open' : ''}>
            <summary>高级：类型 / 名称 / Base URL / 协议</summary>
            <div class="mp-row">
              <label class="mp-label">类型</label>
              <select id="mp-type" class="mp-inp" style="max-width:180px">
                <option value="ollama">Ollama 本地</option>
                <option value="openai-compatible">OpenAI 兼容</option>
              </select>
            </div>
            <div class="mp-row">
              <label class="mp-label">名称</label>
              <input type="text" id="mp-name" placeholder="如 OpenAI、DeepSeek" class="mp-inp">
            </div>
            <div class="mp-row">
              <label class="mp-label">Base URL</label>
              <div class="mp-url-wrap">
                <input type="text" id="mp-url" placeholder="localhost:11434" class="mp-inp mp-url-inp">
                <label class="mp-url-check"><input type="checkbox" id="mp-fullurl" checked> 完整 URL（含 http://）</label>
              </div>
            </div>
            <div class="mp-row">
              <label class="mp-label">API 协议</label>
              <select id="mp-mode" class="mp-inp" style="max-width:200px">
                <option value="chat">/v1/chat/completions（标准对话）</option>
                <option value="responses">/v1/responses（Responses API）</option>
                <option value="completions">/v1/completions（文本补全）</option>
              </select>
            </div>
          </details>
        </div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="model-add-provider">添加并开始聊天</button>
      </div>`);
    mpEnsureCatalog();
    // 预填：探到本机 Ollama 时直接填好本地字段并拉一次模型——零配置用户只需点「添加」。
    const typeEl = $('#mp-type'), nameEl = $('#mp-name'), urlEl = $('#mp-url');
    if (typeEl && nameEl && urlEl && !state.mpPreset && state.ollama.ok && state.ollama.models.length) {
      typeEl.value = 'ollama';
      nameEl.value = 'Ollama（本机）';
      urlEl.value = 'http://127.0.0.1:11434';
      mpFetchModels(true);
    }
  }
  /* 一键接入本机 Ollama（chip「发现 Ollama」的直接动作）。写的是真提供商配置
     （持久化），不是演示模式；探到的模型全部纳入并设为默认。 */
  async function adoptOllama() {
    if (!state.ollama.ok || !state.ollama.models.length) { toast('未探测到本机 Ollama', 'warn'); return; }
    const models = state.ollama.models.slice();
    const providers = [...(state.modelProviders || [])];
    const pid = 'ollama-local';
    const provider = { id: pid, name: 'Ollama（本机）', type: 'ollama', apiMode: 'ollama', baseUrl: 'http://127.0.0.1:11434', models };
    const idx = providers.findIndex((p) => p.id === pid);
    if (idx >= 0) providers[idx] = provider; else providers.push(provider);
    const r = await bridge.saveModelConfig({ providers, defaultProvider: pid, defaultModel: models[0] });
    if (!r || !r.ok) { toast(`接入失败：${(r && r.reason) || ''}`, 'danger'); return; }
    state.modelProviders = providers;
    state.defaultProvider = pid;
    state.defaultModel = models[0];
    // 模型池直接用刚保存的 providers 建，不再回读 getModelConfig：回读拿到的是
    // 「保存前」快照时会把刚接入的提供商冲掉（并发写入/e2e 桩都会这样），chip
    // 于是又回到「未配置」——接入动作看起来没生效。
    dynamicModels.list = providers.flatMap((p) => (p.models || []).map((n) => ({
      n, p: p.name + ' · ' + p.type, k: p.type === 'ollama' ? '(本地)' : 'API', state: '已配',
    })));
    state.demoMode = false;   // 真模型就位，退出演示
    autoSelectModels(providers, pid, models[0]);
    render();
    toast(`已接入本机 Ollama · ${models.length} 个模型`, 'ok');
  }

  /* ---------- 渲染：会话主区（新对话 / 欢迎页 + 快捷入口） ---------- */
  function renderHomeScreen() {
    return `<div class="home-screen">
      <div class="home-greeting">${esc(getGreeting())}</div>
      <p class="home-note">从一句话开始。不会替你编任务。</p>
      <div class="home-input-wrap">
        <div class="composer"><div class="box">
          <textarea id="homeComposer" placeholder="向 StepCode 提问…" rows="1"></textarea>
          <div id="outboundWarn" class="outbound-warn" hidden></div>
          ${composerBarHTML('home-send')}
        </div></div>
      </div>
    </div>`;
  }

  /* ---------- FR-6 分叉点节点标记 ---------- */
  function renderForkNode(fork, atTail) {
    const when = new Date(fork.at).toLocaleString('zh-CN');
    return `<div class="fork-node">
      <span class="fn-line"></span>
      <span class="fn-badge">${ic('fork', 13)} 分叉点</span>
      <span class="fn-meta">继承自「${esc(fork.fromTitle || fork.from)}」第 ${fork.atIndex} 条消息之后 · ${esc(when)}${atTail ? ' · 其后为本分支独立写入' : ''}</span>
    </div>`;
  }

  /* ---------- FR-6 回放视图（只读时间线） ----------
   * 数据源优先级（ADR-0009）：append-only 事件流 > 消息数组回退。
   * 两种来源必须显式标注 —— 「事件流重建」与「历史会话回退」是不同的保证等级，
   * 混用不分会让「模型可见必入日志」变成一句没人能验证的话。 */
  function replaySourceNote() {
    const ev = state.sessionEvents;
    if (ev.loaded && ev.data && ev.data.source === 'event-log') return 'append-only 事件流重建';
    if (ev.loaded && ev.data && ev.data.source === 'legacy') return '历史会话：事件流无记录或不完整，从消息数组重建';
    // P4-S4-5：四态分清。原实现只有「未接入」一个兜底，把「加载中」「查失败」
    // 「桥真缺失」全说成同一句。bridgeMissing 必须排在 !loaded 之前——桥缺失时
    // loaded 本来就是 false，顺序反了会把「未接入」误显示成「加载中」。
    if (ev.bridgeMissing) return '从消息数组重建（事件流未接入）';
    if (!ev.loaded) return '事件流加载中…';
    if (ev.error) return `事件流读取失败：${ev.error} · 已从消息数组重建`;
    return '从消息数组重建（事件流未接入）';
  }
  function renderReplay(s) {
    const ev = state.sessionEvents;
    const events = (ev.loaded && ev.sid === s.id && ev.data && ev.data.source === 'event-log')
      ? (ev.data.timeline || [])
      : (FORK ? FORK.buildReplayTimeline(s) : []);
    const badgeOf = (kind) => ({
      'fork-origin': 'info', user: 'info', agent: 'ok', tool: 'warn', subagent: 'info', feedback: 'ok',
    }[kind] || 'info');
    const labelOf = (kind) => (FORK.REPLAY_KIND_LABELS[kind] || kind);
    return `<div style="flex:1;overflow-y:auto" id="msgScroll">
      <div style="max-width:760px;margin:0 auto;padding:18px 16px 10px">
        <div class="row" style="justify-content:space-between;margin-bottom:10px">
          <div class="row"><b style="font-size:16px">回放 · ${esc(s.title)}</b><span class="badge info">只读</span></div>
          <div class="row" style="gap:8px">
            <span class="faint">${events.length} 个事件</span>
            <button class="btn sm" data-action="replay-close" data-sid="${esc(s.id)}">返回会话</button>
          </div>
        </div>
        <div class="faint" style="margin-bottom:10px">回放自 ${esc(replaySourceNote())}，仅用于追溯，<b>不可编辑、不可继续对话</b>。</div>
        ${events.length ? `<div class="replay">${events.map((ev) => `<div class="rp-item rp-${esc(ev.kind)}">
          <span class="rp-dot"></span>
          <div class="rp-main">
            <div class="row rp-head">
              <span class="rp-seq mono">#${ev.seq}</span>
              <span class="badge ${badgeOf(ev.kind)}">${esc(labelOf(ev.kind))}</span>
              <span class="rp-label">${esc(ev.label)}</span>
              ${ev.status === 'running' ? '<span class="badge warn">进行中</span>' : ''}
              <span class="faint rp-ts">${esc(ev.ts)}</span>
            </div>
            <div class="rp-detail">${ev.detail ? esc(ev.detail) : '<span class="faint">（无摘要）</span>'}</div>
          </div>
        </div>`).join('')}</div>` : '<div class="ctx-empty">该会话还没有可回放的事件</div>'}
      </div></div>`;
  }

  function buildMsgListHtml(s) {
    const fork = FORK ? FORK.normalizeFork(s.fork) : null;
    const msgs = s.msgs || [];
    const atTail = !!fork && fork.atIndex >= msgs.length;
    return msgs
      .map((m, i) => (fork && i === fork.atIndex ? renderForkNode(fork, atTail) : '') + renderMsg(m, s.id))
      .join('') + (atTail ? renderForkNode(fork, true) : '');
  }

  const VIEWS = {};
  VIEWS.session = {
    side() { return renderSideSession(); },
    main() {
      // 新对话模式 → 主页（优先级最高）
      if (state.newConvMode) {
        state.newConvMode = false;
        return renderHomeScreen();
      }
      // 无选中会话 → 主页
      if (!state.sel || !state.sessions[state.sel]) {
        return renderHomeScreen();
      }
      const s = state.sessions[state.sel];
      // 回放视图（FR-6 只读）：优先于普通消息流，且不挂 composer。
      if (state.replayFor === s.id) return renderReplay(s);

      // 血缘提示 + 消息流中的分叉点节点标记（FR-6）
      const fork = FORK ? FORK.normalizeFork(s.fork) : null;
      const msgHtml = buildMsgListHtml(s);

      return `<div style="flex:1;overflow-y:auto" id="msgScroll">
        <div style="max-width:760px;margin:0 auto;padding:18px 16px 10px">
          ${renderTurnStrip(s)}
          ${renderMemoryLine()}
          <div class="row" style="justify-content:space-between;margin-bottom:4px">
            <div class="row"><b class="sess-title">${esc(s.title)}</b>
              <span class="badge info">${esc(s.expert)}</span></div>
            <div class="row" style="gap:4px">
              ${FORK ? `<button class="btn sm ghost" data-action="fork" data-sid="${esc(s.id)}" title="从此会话创建分支（可选分叉点）">${ic('fork', 13)} 分叉</button>` : ''}
              ${FORK ? `<button class="btn sm ghost" data-action="replay-open" data-sid="${esc(s.id)}" title="只读回放本会话">${ic('clock', 13)} 回放</button>` : ''}
              <button class="btn sm ghost" data-action="file-panel" title="当前工作目录的文件">文件</button>
              <button class="iconbtn" data-action="toggle-ctx" title="这一回合的步骤" aria-label="打开或收起本回合检查器" style="transform:rotate(${state.ctxOpen ? 0 : 180}deg);transition:.15s">${ic('chev', 14)}</button></div>
          </div>
          ${fork ? `<div class="fork-origin">${ic('fork', 13)} 分支自 <span class="mono">#${esc(fork.from)}</span>${fork.fromTitle ? `「${esc(fork.fromTitle)}」` : ''} · 继承前 ${fork.atIndex} 条 · ${esc(new Date(fork.at).toLocaleString('zh-CN'))}</div>` : ''}
          
          <div id="msgList">${msgHtml}</div>
        </div></div>
      ${renderComposer(s)}`;
    },
    ctx() {
      const s = state.sel && state.sessions[state.sel] ? state.sessions[state.sel] : null;
      const sub = !s
        ? '还没有进行中的回合'
        : (state.turnBusy === s.id ? '这一回合正在进行' : (state.pendingConfirm ? '有一个动作等待确认' : s.title));
      const plan = s ? extractPlanSteps(s.msgs || []) : { steps: [] };
      const live = s && Array.isArray(state.toolSteps[s.id]) ? state.toolSteps[s.id] : [];
      const showLive = !!(s && state.turnBusy === s.id && live.length);
      const lastAgent = s ? [...(s.msgs || [])].reverse().find((m) => (m.r === 'agent' || m.role === 'assistant' || m.role === 'agent') && !m.typing) : null;
      const settled = !showLive && lastAgent && Array.isArray(lastAgent.tools) ? lastAgent.tools : [];
      let stepsHTML = '';
      if (!s) {
        stepsHTML = '<div class="faint" style="font-size:12px;padding:8px 2px">发送一条消息后，这一回合的步骤会出现在这里。</div>';
      } else if (plan.steps.length || showLive || settled.length) {
        const rows = [];
        if (showLive) {
          live.forEach((t) => {
            const ph = t.ph === 'done' ? 'done' : (t.ph === 'error' ? 'error' : 'running');
            const mark = ph === 'done' ? '✓' : (ph === 'error' ? '!' : '…');
            rows.push('<div class="ctx-step"><span class="step-dot ' + ph + '">' + mark + '</span><span class="step-text">' + esc(t.n || '工具') + '</span></div>');
          });
        }
        if (!showLive) {
          settled.forEach((t) => {
            const ph = t.ph === 'error' ? 'error' : 'done';
            rows.push('<div class="ctx-step"><span class="step-dot ' + ph + '">' + (ph === 'error' ? '!' : '✓') + '</span><span class="step-text">' + esc(t.n || '工具') + '</span></div>');
          });
        }
        plan.steps.forEach((st) => {
          rows.push('<div class="ctx-step"><span class="step-dot ' + (st.done ? 'done' : 'pending') + '">' + (st.done ? '✓' : '') + '</span><span class="step-text">' + esc(st.text) + '</span></div>');
        });
        stepsHTML = '<div class="ctx-section"><div class="ctx-section-title">这一回合</div>' + rows.join('') + '</div>';
      } else {
        stepsHTML = '<div class="faint" style="font-size:12px;padding:8px 2px">这一回合还没有步骤。文件在主区，能力在插件页。</div>';
      }
      // R2-8：关闭钮放进右栏自己的头部。原来只有会话页主区头部那一个 chevron——
      // 用户在会话里钉住检查器后点到主页/插件/设置页，右栏保持展开而这三个视图都没有
      // 收起入口，只能先回会话页，浮出状态机存在无出口的死角。
      return '<div class="ctx-header"><div class="ctx-title">' + ic('clipboard', 16) + ' 这一回合</div>'
        + '<button class="iconbtn" data-action="toggle-ctx" title="收起检查器" aria-label="收起检查器" style="width:24px;height:24px">' + ic('x', 13) + '</button>'
        + '<div class="ctx-subtitle">' + esc(sub) + '</div></div>'
        + '<div class="ctx-body"><div id="confirmZone">' + (state.pendingConfirmHtml || '') + '</div>' + stepsHTML + '</div>';
    }

  };

  /* ---------- 渲染：插件视图 ---------- */
  VIEWS.plugins = {
    side() {
      const sec = (key, title, count, html) => {
        const expanded = state.plugSideExpanded.has(key);
        return `<div class="ssec">
          <div class="ss-h" data-action="pside-toggle" data-id="${key}">
            <span class="ss-c ${expanded ? 'open' : ''}">${ic('chev', 12)}</span>
            <span class="ss-t">${title}</span>
            <span class="ss-n">${count}</span>
          </div>
          ${expanded ? `<div class="ss-l">${html}</div>` : ''}
        </div>`;
      };
      // 侧栏条目统一构造：能跳转的给 pside-nav（滚动到主区对应分区并高亮），
      // 没有对应落点的显式标 .ss-i-static（cursor:default / 无 hover）——
      // 此前部分条目带 data-action、部分完全没有，看起来一样但点了没反应。
      const nav = (target, label, badge, on) => `<div class="ss-i pside-nav ${on ? 'on' : ''}" data-action="pside-nav" data-target="${target}"><span class="id"></span><span class="in">${label}</span>${badge || ''}</div>`;
      const staticRow = (label, badge) => `<div class="ss-i ss-i-static" title="仅展示，无对应操作"><span class="id"></span><span class="in">${label}</span>${badge || ''}</div>`;
      // 分区级跳转：该组暂无条目、但主区分区确实存在（连接器 / MCP / 临时插件 / 市场
      // 在未接入或空列表时）。可点（滚到分区）但视觉弱化，不假装有内容——此前这些兜底
      // 行完全静态，[psec-*] 分区「无侧栏入口」告警误报，用户也只能靠滚屏发现分区。
      const secJump = (target, label, badge) => `<div class="ss-i ss-i-jump" data-action="pside-nav" data-target="${target}" title="该组暂无条目，点击跳到配置区"><span class="id"></span><span class="in">${label}</span>${badge || ''}</div>`;
      // P4-S2-4：侧栏徽章改读运行时（pluginBadge），与主区卡片徽章/开关同源。
      // 原实现读常量 p.on——运行时就绪后会出现「侧栏显示 启 + 绿点，卡片显示 已停用」
      // 的同页矛盾。pluginBadge 在运行时不认识该插件时会回落常量，语义不变。
      const builtIn = PLUGINS.map((p) => nav('psec-builtin', p.n, pluginBadge(p.id), pluginSwitchedOn(p.id))).join('');
      // 本地市场未接入或为空：分区仍在，给分区级跳转（不假装有条目）
      const market = (state.market.loaded && state.market.items.length
        ? state.market.items.map((m) => nav('psec-market', esc(m.manifest && m.manifest.name || m.dir), marketBadge(m), m.active)).join('')
        : secJump('psec-market', '本地插件市场', `<span class="ib badge">${state.market.loaded ? '暂无' : '未接入'}</span>`)) +
        // 远程源未接入：无本地落点，标为静态（不假装可点）
        PLUGIN_MARKET.map((p) => staticRow(esc(p.n), '<span class="ib badge">远程未接入</span>')).join('');
      const skills = SKILLS_MARKET.map((s) => nav('psec-skills', `<span class="mono" style="font-size:11.5px">${esc(s.n)}</span>`,
        s.auth ? '<span class="ib badge warn">授权</span>' : '<span class="ib badge ok">可装</span>')).join('');
      // P4-S2-12：编排目录拉不到时回落硬编码 EXPERTS/TEAMS，必须显式标注兜底——
      // 否则 8 专家 + 3 团的兜底数据与真实目录同权展示，用户无从分辨（orchestrationLive()
      // 此前写了没人调用，三态标注被漏做；这里接上）。
      const orchNote = !orchestrationLive()
        ? `<div class="ss-i ss-i-static" title="编排插件目录未接入，以下为内置兜底名单"><span class="id"></span><span class="in">编排目录未接入 · 兜底名单</span><span class="ib badge">未接入</span></div>`
        : '';
      const experts = orchNote + [...expertList().map((e) => staticRow(e, '<span class="ib badge info">专家</span>')),
        ...teamList().map((t) => `<div class="ss-i ss-i-action"><span class="id"></span><span class="in">${esc(t.n)}</span><button class="btn sm ghost" data-action="team-compose" data-tid="${esc(t.id || '')}" data-tn="${esc(t.n)}">派发任务</button><span class="ib badge ceo">团</span></div>`)].join('');
      // 委派树结果（composeTeam 返回后渲染；CEO→Director→Worker 三层）。
      // ②半接线修复后 composeTeam 会把 task 真实喂给各 Director 经 agentRunner 执行，
      // 节点携带 task/result/note —— 必须在树里可见，否则又落入「执行了却存而不显」。
      const delRow = (n) => {
        const line = `<div class="ss-i"><span class="id"></span><span class="in">${esc(String(n.label || n.id))}</span><span class="ib badge ${String(n.layer) === 'ceo' ? 'ceo' : 'info'}">${esc(String(n.layer || ''))}</span><span class="ib badge ${String(n.status) === 'done' ? 'ok' : 'warn'}">${esc(String(n.status || ''))}</span></div>`;
        const cut = (s) => (s.length > 140 ? s.slice(0, 140) + '…' : s);
        const bits = [];
        const t = n.task; if (typeof t === 'string' && t) bits.push(`任务：${esc(cut(t))}`);
        const st = String(n.status || '');
        if (st === 'failed') bits.push(typeof n.note === 'string' && n.note ? `原因：${esc(cut(n.note))}` : '原因：执行失败');
        else if (st === 'done') { const r = n.result; if (typeof r === 'string' && r) bits.push(`产出：${esc(cut(r))}`); }
        if (st === 'running' || st === 'pending') bits.push(st === 'running' ? '执行中…' : '待执行');
        return line + (bits.length ? `<div class="del-note">${bits.join('<br>')}</div>` : '');
      };
      const deleg = (state.delegationLast?.nodes || []).map(delRow).join('');
      const expertsHtml = experts + (deleg ? sec('delegation', '最近一次委派树', (state.delegationLast?.nodes || []).length, deleg) : '');
      // 连接器侧栏：真实后端状态。桥不可用（loaded=false）显「未接入」，
      // 与「已接入但都没配置」必须区分 —— 把 null 当空数组是本项目踩过三次的坑。
      const connItems = state.connectors.loaded
        // 点击 = 滚到连接器分区 + 展开该连接器配置（此前只展开不滚动，
        // 若分区在下方视口外，点了像没反应）。
        ? state.connectors.items.map((c) => `<div class="ss-i ${c.state && c.state.lastTestOk === true ? 'on' : ''}" data-action="conn-nav" data-id="${esc(c.id)}"><span class="id"></span><span class="in">${esc(c.name)}</span>${connBadge(c)}</div>`).join('')
        : secJump('psec-connectors', '连接器配置', '<span class="ib badge">未接入</span>');
      const connCount = state.connectors.loaded ? state.connectors.stats.total : 0;
      // MCP / 临时插件：主区分区（psec-mcp / psec-temp）此前的侧栏盲区（/layout），
      // 用户只能靠滚屏发现。这里补上可跳转的侧栏组，未接入态显式标注。
      const mcpItems = state.mcp.loaded
        ? (state.mcp.servers.length
            ? state.mcp.servers.map((m) => nav('psec-mcp', esc(m.name || m.id), m.lastConnectOk === true ? '<span class="ib badge ok">连</span>' : '<span class="ib badge">待连</span>')).join('')
            : secJump('psec-mcp', 'MCP 配置', '<span class="ib badge">暂无</span>'))
        : secJump('psec-mcp', 'MCP 配置', '<span class="ib badge">未接入</span>');
      const mcpCount = state.mcp.loaded ? state.mcp.stats.total : 0;
      const tempItems = state.tempPlugins.length
        ? state.tempPlugins.map((p) => nav('psec-temp', `<span class="mono" style="font-size:11.5px">${esc(p.name)}</span>`, '<span class="ib badge warn">内存</span>')).join('')
        // P4-S2-5：区分「拉到了但真没有」与「没拉到」
        : secJump('psec-temp', '临时插件', `<span class="ib badge">${state.tempPluginsLoaded ? '暂无' : '未接入'}</span>`);
      return sec('builtin', '内置插件', PLUGINS.length, builtIn) +
        sec('market', '插件市场', (state.market.loaded ? state.market.items.length : 0) + PLUGIN_MARKET.length, market) +
        sec('skills', '技能市场', SKILLS_MARKET.length, skills) +
        sec('experts', '专家·专家团', expertList().length + teamList().length, expertsHtml) +
        sec('connectors', '连接器', connCount, connItems) +
        sec('mcp', 'MCP', mcpCount, mcpItems) +
        sec('temp', '临时插件', state.tempPlugins.length, tempItems);
    },
    main() {
      // 插件页搜索（2026-09-06）：顶部搜索条即时过滤内置插件卡片。
      // 全部卡片仍一次渲染（避免重渲染丢输入焦点），由 plugSearchFilter() 在
      // 运行时切换每张卡 .hidden；匹配文本（名称/描述/能力/标识/仓库）预先拼进
      // data-search 小写。不触后端，纯即时前端过滤。
      return `<div class="main-inner"><h1 class="pg">插件</h1><div class="pg-sub">一切皆插件——能力以插件形式挂载；启用 = 注册 effect，停用 = 注册回滚（无残留）。</div>
        <div class="plug-search-bar" id="psec-builtin">
          <input type="search" class="inp" id="plugSearch" placeholder="搜索内置插件（名称 / 能力 / 描述）…"
            value="${esc(state.plugSearch)}" aria-label="搜索内置插件">
          <span class="faint" id="plugSearchCount" style="font-size:11px"></span>
        </div>
        ${PLUGINS.map((p) => `<div class="plug" data-pid="${p.id}" data-search="${esc([p.n, p.d, (p.caps || []).join(' '), p.id, p.repo || ''].join(' ').toLowerCase())}">
          <div class="ph">
            <div style="min-width:0;flex:1">
              <div class="ptitle">${p.n}
                ${pluginBadge(p.id)}</div>
              <div class="pdesc">${p.d}</div>
              <div class="pmeta">${p.repo ? `<span class="mono">${p.repo}</span>·` : ''}<span class="faint">能力声明</span></div>
              <div class="pcaps" data-expanded="0">${(() => { const cs = p.caps || []; const chip = (c, warn, x) => `<span class="badge cap ${x || ''} ${warn ? 'warn' : ''}">${c}</span>`; const isWarn = (c) => c.includes('write') || c.includes('dispose') || c.includes('commit'); const rest = cs.slice(3); return cs.slice(0, 3).map((c, i) => chip(c, i > 0 && isWarn(c))).join('') + (rest.length ? rest.map((c) => chip(c, isWarn(c), 'extra')).join('') + `<span class="badge cap more" data-action="caps-expand" title="展开全部能力声明">+${rest.length}</span>` : ''); })()}</div>
            </div>
            <div class="pactions">
              <!-- 内联 onclick 里的 toast 在 IIFE 作用域外，点击必抛 ReferenceError；
                   切换逻辑统一交给下面委托的 case 'plug-toggle'（真实热插拔）。 -->
              <div class="switch ${pluginSwitchedOn(p.id) ? 'on' : ''}" data-action="plug-toggle" data-id="${p.id}" title="${pluginSwitchedOn(p.id) ? '点击停用' : '点击启用'}"></div>
              <button class="btn sm" data-action="plug-cfg" data-id="${p.id}">配置</button>
            </div>
          </div>
          <div class="pbody" data-cfg="${p.id}">
            ${p.cfg.map((c) => `<div class="row" style="padding:3px 0"><span class="faint" style="width:180px">${c}</span></div>`).join('')}
            <!-- 「查看审计日志」此前是无 data-action 的死按钮（主进程无该 IPC）；
                 不留死按钮 —— 停用即注册回滚（无残留），故这里只给真实停用的入口。 -->
            <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="plug-disable" data-id="${p.id}">停用（注册回滚，无残留）</button></div>
          </div>
        </div>`).join('')}
        <div class="faint" id="plugSearchEmpty" style="padding:14px;display:none">没有匹配的内置插件</div>
        <div class="sec-title psec" id="psec-connectors" style="margin-top:18px">连接器</div>
        <div class="card" style="padding:12px">
          <div class="faint" style="margin-bottom:8px">第三方服务接入：凭证仅本地<b>加密</b>保存（密钥存系统安全存储），保存即自动探测一次连通性。${state.connectors.loaded ? `共 ${state.connectors.stats.total} 个 · 已配置 ${state.connectors.stats.configured} · 连通 ${state.connectors.stats.ok}` : ''}</div>
          ${!state.connectors.loaded
    ? '<div class="faint">连接器注册表未接入（主进程桥不可用）</div>'
    : state.connectors.items.map((c) => {
      const st = c.state || {};
      const open = state.connectors.expanded === c.id;
      const lastMsg = st.lastTestAt
        ? `<span class="faint" style="font-size:11px">最近探测：${st.lastTestOk === true ? '<span style="color:var(--ok)">✓</span>' : st.lastTestOk === false ? '✗' : '·'} ${esc(st.lastTestMessage || '')}</span>`
        : (c.manual && st.configured ? `<span class="faint" style="font-size:11px">${esc(c.manualHint || '已保存凭证（无自动探测）')}</span>` : '');
      const formRows = c.fields.map((f) => {
        const val = (c.values && c.values[f.key]) || '';
        const inputType = f.type === 'secret' ? 'password' : 'text';
        return `<div class="mb-row"><label>${esc(f.label)}${f.required ? '' : ' <span class="faint">（选填）</span>'}</label><input class="inp" type="${inputType}" id="connf-${esc(c.id)}-${esc(f.key)}" placeholder="${esc(f.placeholder || '')}" value="${esc(val)}">${f.hint ? `<div class="faint" style="font-size:11px;margin-top:2px">${esc(f.hint)}</div>` : ''}</div>`;
      }).join('');
      return `<div class="plug" data-cid="${esc(c.id)}" ${open ? '' : ''}>
            <div class="ph">
              <div style="min-width:0;flex:1">
                <div class="ptitle">${esc(c.name)} ${connBadge(c)} ${c.caps.map((cap) => `<span class="badge cap">${esc(cap)}</span>`).join('')}</div>
                <div class="pdesc">${esc(c.desc)}</div>
                <div class="pmeta">${lastMsg}</div>
              </div>
              <div class="pactions">
                ${c.id === 'github' ? `<button class="btn sm ghost" data-action="conn-discover" data-id="${esc(c.id)}" title="从本机 CLI/git 登录态自动识别">自动发现</button>` : ''}
                ${c.manual ? '' : `<button class="btn sm" data-action="conn-test" data-id="${esc(c.id)}" ${st.configured ? '' : 'disabled'}>测试</button>`}
                <button class="btn sm" data-action="conn-cfg" data-id="${esc(c.id)}">${open ? '收起' : '配置'}</button>
              </div>
            </div>
            ${open ? `<div class="pbody" style="display:block">
              ${formRows}
              <div class="row" style="margin-top:8px;align-items:center">
                <button class="btn sm primary" data-action="conn-save" data-id="${esc(c.id)}">保存${c.manual ? '' : '并测试'}</button>
                <button class="btn sm ghost" data-action="conn-clear" data-id="${esc(c.id)}" ${st.configured ? '' : 'disabled'}>清除凭证</button>
                <span class="faint" style="font-size:11px;margin-left:auto;cursor:pointer" data-action="open-external" data-url="${esc(c.docsUrl)}">凭证获取文档 ↗</span>
              </div>
              ${c.manual ? `<div class="faint" style="font-size:11px;margin-top:6px">${esc(c.manualReason || '')}</div>` : ''}
            </div>` : ''}
          </div>`;
    }).join('')}
          ${state.connAudit.entries.length ? `<div class="sec-title" style="margin-top:12px;font-size:12px">审计（保存/清除/探测，${state.connAudit.total} 条 · 上限 ${state.connAudit.max}）</div>
          <div style="max-height:180px;overflow:auto">
            ${state.connAudit.entries.map((e) => `<div class="row" style="padding:3px 0;border-top:1px solid var(--border)"><span class="mono" style="font-size:11px;width:86px">${esc(e.id)}</span><span class="badge ${e.action === 'test' ? 'ok' : e.action === 'test-fail' ? 'warn' : ''}" style="margin:0 6px">${esc(e.action)}</span><span style="flex:1;font-size:11.5px">${esc(e.message)}</span><span class="faint mono" style="font-size:11px">${new Date(e.ts).toLocaleString()}</span></div>`).join('')}
          </div>
          <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="conn-audit-clear">清空审计</button></div>` : ''}
        </div>
        <div class="sec-title psec" id="psec-mcp" style="margin-top:18px">MCP（Model Context Protocol）</div>
        <div class="card" style="padding:12px">
          <div class="faint" style="margin-bottom:8px">接入 MCP server（stdio）：命令 + 参数 + 环境变量（env 密钥<b>加密</b>落盘）。保存即握手探测一次，拿到真实工具清单。${state.mcp.loaded ? `共 ${state.mcp.stats.total} 个 · 已连接 ${state.mcp.stats.connected} · 工具 ${state.mcp.stats.tools}` : ''}</div>
          ${!state.mcp.loaded
    ? '<div class="faint">MCP 桥未接入（主进程不可用）</div>'
    : state.mcp.servers.map((m) => {
      const connected = m.lastConnectOk === true;
      const open = state.mcpExpanded === m.id;
      const tools = Array.isArray(m.tools) ? m.tools : [];
      return `<div class="plug" data-mcpid="${esc(m.id)}">
            <div class="ph">
              <div style="min-width:0;flex:1">
                <div class="ptitle">${esc(m.name || m.id)} ${connected ? '<span class="ib badge ok">已连接</span>' : (m.enabled === false ? '<span class="ib badge">已停用</span>' : (m.lastConnectOk === false ? '<span class="ib badge warn">连接失败</span>' : '<span class="ib badge warn">待连接</span>'))}</div>
                <div class="pdesc mono" style="font-size:11px">${esc(m.command || '')}${(Array.isArray(m.args) && m.args.length) ? ' ' + m.args.map((a) => esc(a)).join(' ') : ''}</div>
                <div class="pmeta">${connected && tools.length ? tools.map((t) => `<span class="badge cap">${esc(t)}</span>`).join('') : `<span class="faint" style="font-size:11px">${esc(m.lastMessage || '尚未连接')}</span>`}</div>
              </div>
              <div class="pactions">
                <button class="btn sm" data-action="mcp-probe" data-id="${esc(m.id)}" ${m.enabled === false ? 'disabled' : ''}>探测</button>
                <button class="btn sm" data-action="mcp-toggle" data-id="${esc(m.id)}">${m.enabled === false ? '启用' : '停用'}</button>
                <button class="btn sm ghost" data-action="mcp-del" data-id="${esc(m.id)}">删除</button>
              </div>
            </div>
          </div>`;
    }).join('')}
          ${/* P4-S2-11：桥未接入时不给「+ 添加 MCP server」可点形态。原实现无条件渲染，用户点开、填完 ID/命令/env，保存时才 toast「主进程未接入」——整个填写过程是无效劳动，且与 fail-closed「不可用即不可操作」的姿态相悖。 */''}
          ${state.mcp.loaded
            ? '<div class="row" style="margin-top:10px"><button class="btn sm primary" data-action="mcp-add">+ 添加 MCP server</button></div>'
            : '<div class="row" style="margin-top:10px"><button class="btn sm" disabled title="MCP 桥未接入，无法添加">+ 添加 MCP server</button><span class="faint" style="font-size:11px;margin-left:8px">需主进程接入</span></div>'}
        </div>
        <div class="sec-title psec" id="psec-market" style="margin-top:18px">本地插件市场</div>
        <div class="card" style="padding:12px">
          <div class="faint" style="margin-bottom:8px">第三方插件放 <b>插件目录</b>（manifest.json + index.js）后出现在这里。扫描不执行代码；<b>启用 = 显式授权装载</b>，与内置插件同一套真热插拔（停用 = 逆回滚无残留）。远程市场需签名与来源校验，未接入。</div>
          <div class="row" style="margin-bottom:10px">
            <button class="btn sm" data-action="market-open-dir">打开插件目录</button>
            <button class="btn sm ghost" data-action="market-refresh">重新扫描</button>
            ${state.market.loaded ? `<span class="faint" style="font-size:11px;margin-left:auto">${state.market.items.length} 个目录 · ${state.market.count} 个已启用</span>` : ''}
          </div>
          ${!state.market.loaded
    ? '<div class="faint">本地插件市场未接入（主进程桥不可用）</div>'
    : state.market.items.length === 0
      ? `<div class="faint">插件目录为空：把含 manifest.json + index.js 的插件目录放进 ${esc(state.market.dir)} 后点「重新扫描」</div>`
      : state.market.items.map((m) => {
        const name = m.manifest && m.manifest.name ? m.manifest.name : m.dir;
        const desc = m.manifest && m.manifest.description ? m.manifest.description : '';
        const ver = m.manifest && m.manifest.version ? m.manifest.version : '';
        const caps = m.manifest && Array.isArray(m.manifest.caps) ? m.manifest.caps : [];
        const inj = m.manifest && Array.isArray(m.manifest.inject) ? m.manifest.inject : [];
        return `<div class="plug" data-mid="${esc(m.dir)}">
              <div class="ph">
                <div style="min-width:0;flex:1">
                  <div class="ptitle">${esc(name)} ${marketBadge(m)} ${ver ? `<span class="badge info mono">v${esc(ver)}</span>` : ''}</div>
                  ${desc ? `<div class="pdesc">${esc(desc)}</div>` : ''}
                  <div class="pmeta">
                    ${caps.map((cap) => `<span class="badge cap">${esc(cap)}</span>`).join('')}
                    ${inj.length ? `<span class="faint" style="font-size:11px;margin-left:6px">注入：${inj.map((s) => esc(s)).join('、')}</span>` : ''}
                    ${m.error ? `<div class="faint" style="font-size:11px;color:var(--warn, #b7791f)">${esc(m.error)}</div>` : ''}
                  </div>
                </div>
                <div class="pactions">
                  <div class="switch ${m.enabled ? 'on' : ''}" data-action="market-local-toggle" data-id="${esc(m.dir)}" title="${m.manifestOk && m.hasEntry ? (m.enabled ? '点击停用' : '点击启用（显式授权装载）') : 'manifest 非法或缺 index.js，不可启用'}"></div>
                </div>
              </div>
            </div>`;
      }).join('')}
        </div>
        <div class="sec-title muted psec" id="psec-temp" style="margin-top:18px">临时插件（自进化 · 仅驻内存 · 重启即失）</div>
        <div class="card temp-plug-card">
          <div class="faint" style="margin-bottom:8px">Agent 运行时自建的临时插件；信任级 = Shell，须沙箱内运行，不持久化。加载前经静态分析 + CONFIRM（fail-closed）。</div>
          ${state.tempPlugins.length ? state.tempPlugins.map((p) => `<div class="tp-item"><span class="mono">${p.name}</span><span class="badge warn">shell</span><span class="faint">仅驻内存</span><button class="btn sm ghost" data-action="tp-dispose" data-id="${p.id}">卸载</button></div>`).join('')
            // P4-S2-5：没拉到就不能说「暂无」——「未接入」与「为空」必须可区分
            : (state.tempPluginsLoaded
              ? '<div class="faint">暂无临时插件（创建后在此列出，重启即失）</div>'
              : '<div class="faint">临时插件列表未接入（主进程桥不可用）· 不是「没有临时插件」</div>')}
          <div class="row" style="margin-top:8px"><button class="btn sm" data-action="tp-new">+ 新建临时插件</button></div>
        </div>
        <div class="sec-title psec" id="psec-skills" style="margin-top:18px">技能市场（观雅集）</div>
        <div class="card models-card" style="padding:12px">
          ${state.guanjiTokenSet
            ? '<div class="row" style="margin-bottom:8px"><span class="badge ok">已配置 TOKEN</span><button class="btn sm ghost" data-action="guanji-token" style="margin-left:8px">更换 TOKEN</button></div>'
            : '<div class="row" style="margin-bottom:8px"><span class="badge warn">未配置 TOKEN</span><button class="btn sm primary" data-action="guanji-token" style="margin-left:8px">配置观雅集 TOKEN</button></div>'}
          <div class="row" style="margin-bottom:6px;gap:8px">
            <input type="search" class="inp" id="skillSearch" placeholder="搜索技能（slug / 名称 / 描述 / 能力）…" style="max-width:340px" aria-label="搜索技能">
            <span class="faint" id="skillSearchCount" style="font-size:11px"></span>
          </div>
          <table style="width:100%">
            <tr><th style="width:32%">技能</th><th>能力</th><th style="width:96px;text-align:right">状态</th></tr>
            ${(state.guanjiSkills.length ? state.guanjiSkills : SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }))).map((s) => `<tr data-skill-search="${esc([s.slug, s.name, s.description || '', (s.caps || []).join(' ')].join(' ').toLowerCase())}">
              <td><div class="mono" style="font-size:11.5px">${esc(s.slug)}</div><div class="faint" style="font-size:11px;margin-top:2px">${esc(s.description || '')}</div></td>
              <td>${s.caps.map((c) => `<span class="badge cap" style="margin:2px 4px 2px 0">${esc(c)}</span>`).join('')}${s.auth ? '<span class="badge warn">需授权</span>' : ''}</td>
              <td style="text-align:right">${skillInstallCell(s.slug)}</td>
            </tr>`).join('')}
          </table>
          <div class="row" style="margin-top:10px"><button class="btn sm" data-action="guanji-publish">发布技能到观雅集</button></div>
          ${state.installedSkills.length ? `<div class="sec-title" style="margin-top:14px;font-size:12px">已安装（${state.installedSkills.length}）</div>
          <div class="installed-skills">` + state.installedSkills.map((s) => {
            const on = s.enabled !== false;
            const size = s.bytes ? (s.bytes > 1024 ? (s.bytes / 1024).toFixed(1) + 'KB' : s.bytes + 'B') : '';
            return `<div class="is-row">
              <span class="is-name mono">${esc(s.slug)}</span>
              <span class="badge ${on ? 'ok' : ''}">${on ? '已启用' : '已停用'}</span>
              ${size ? `<span class="faint mono" style="font-size:11px">${size}</span>` : ''}
              <span style="flex:1"></span>
              <button class="btn sm" data-action="skill-toggle" data-n="${esc(s.slug)}">${on ? '停用' : '启用'}</button>
              <button class="btn sm ghost danger-text" data-action="skill-uninstall" data-n="${esc(s.slug)}">卸载</button>
            </div>`;
          }).join('') + `</div>` : ''}
        </div></div>`;
    },
    ctx() {
      return `<div class="sec-title">能力审查</div>
        <div class="faint" style="margin-bottom:8px">插件加载前经 inject 静态声明审查；<b>红色能力</b>需用户主动授权。</div>
        <div class="card" style="padding:10px">
          <div style="font-size:11.5px;font-weight:600;margin-bottom:6px">L0-L4 分级</div>
          <div class="levels">
            ${state.authLevels.length
              ? state.authLevels.map((l) => `<div class="lv"><span class="lv-n">L${l.level}</span><span class="lv-l">${esc(l.label)}</span><span class="faint">${esc(l.scope)}</span>${l.requiresApproval ? '<span class="badge warn">需授权</span>' : ''}</div>`).join('')
              // P4-S3-06：原实现只有「加载中…」一个分支，init 里 getAuthLevels 失败/返回空时
              // 它会永久卡死——没有「未接入」也没有重试。fail-closed 语义下要说清楚。
              : (state.authzLoaded
                ? '<div class="faint">授权插件未返回分级定义（重进设置页或重启应用可重试）</div>'
                : '<div class="faint">分级定义未接入（授权服务不可用 · fail-closed：按最严处理）</div>')}
          </div>
        </div>
        <div class="sec-title">当前激活</div>
        <div class="faint" style="font-size:12px">运行时未接入 · Cordis 插件已随 dsh 卸下（见 SPEC 删除清单）</div>
        <div class="sec-title">OrchClaw Hub 联调</div>
        <div class="card" style="padding:10px">
          <div class="faint" style="margin-bottom:8px">配对远程 Agent（凭据经系统安全存储加密）；主会话可向其下发任务并回收结果。端到端需可达远程 Hub。</div>
          ${state.hubStatus.paired
            ? `<div class="row" style="margin-bottom:8px"><span class="badge ok">已配对${state.hubStatus.agentName ? ' · ' + esc(state.hubStatus.agentName) : ''}</span><button class="btn sm ghost" data-action="hub-unpair" style="margin-left:8px">解除配对</button></div>`
            : `<div class="mb-row"><label>Hub URL</label><input class="inp" id="hubUrl" placeholder="https://hub.example.com" value="${esc(state.hubUrl || '')}"></div>`
               + `<div class="mb-row"><label>配对凭据</label><input class="inp" id="hubToken" type="password" placeholder="远程 Agent 配对 Token"></div>`
               + `<button class="btn sm primary" data-action="hub-pair">配对</button>`}
          <div class="mb-row" style="margin-top:8px"><label>向远程下发任务</label><textarea id="hubTask" class="inp" rows="2" placeholder="任务描述…">${esc(state.hubTaskText || '')}</textarea></div>
          <button class="btn sm" data-action="hub-send">发送任务</button>
          ${state.hubResultText ? `<div class="faint" style="margin-top:8px;white-space:pre-wrap">${esc(state.hubResultText)}</div>` : ''}
        </div>`;
    }
  };

  /* ---------- 渲染：设置视图 ---------- */
  /* 设置页分区注册表（/layout）：侧栏导航与主区分区的唯一真源。
     曾出现「凭据」导航项无对应分区（死入口）、「分层记忆」分区无导航入口的漂移；
     渲染期断言双向覆盖（见 render() 末尾），新增分区忘登记会立刻在控制台暴露。 */
  const SETTINGS_SECTIONS = [
    { id: 'model', n: '模型', icon: 'bot' },
    { id: 'sandbox', n: '沙箱与授权', icon: 'shield' },
    { id: 'prompt', n: '系统提示词', icon: 'at' },
    { id: 'desktop', n: '桌面集成', icon: 'settings' },
    { id: 'memory', n: '分层记忆', icon: 'archive' },
    { id: 'data', n: '数据目录', icon: 'folder' },
    { id: 'about', n: '关于', icon: 'at' },
  ];
  /* ---------- 模型提供商：models.dev 预设 + KEY 触发拉取（方案 A） ---------- */
  function fmtCtx(n) {
    if (!n) return '';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }
  function fmtPrice(a, b) {
    if (a == null && b == null) return '';
    const f = (v) => (v == null ? '?' : '$' + v);
    return `${f(a)}/${f(b)}`;
  }
  function mpModelChips(m) {
    const chips = [];
    if (m.ctx) chips.push(`<span class="badge" title="上下文窗口">${fmtCtx(m.ctx)}</span>`);
    const pr = fmtPrice(m.priceIn, m.priceOut);
    if (pr) chips.push(`<span class="badge" title="每百万 token 输入/输出单价">${pr}</span>`);
    (m.caps || []).forEach((c) => chips.push(`<span class="badge info">${c === 'tool_call' ? '工具调用' : '推理'}</span>`));
    if (m.enriched) chips.push('<span class="badge ok" title="元数据来自 models.dev 目录">目录</span>');
    return chips.join('');
  }
  function mpPresetControlHTML() {
    return `<button type="button" class="mp-inp mp-preset-btn" id="mp-preset-btn" data-action="mp-preset-toggle" role="combobox" aria-haspopup="listbox" aria-expanded="${state.mpPresetOpen ? 'true' : 'false'}" aria-controls="mp-preset-pop">${state.mpPreset ? `${esc(state.mpPreset.name)} <span class="faint">${esc(state.mpPreset.id)}</span>` : '选择预设（可选）…'}</button>${state.mpPreset ? '<button type="button" class="mp-preset-clear" data-action="mp-preset-clear" title="清除预设，改回自定义" aria-label="清除预设">×</button>' : ''}`;
  }
  function mpPresetPopHTML() {
    return `<div class="mp-preset-pop" id="mp-preset-pop"><input type="text" id="mp-preset-search" class="mp-inp" placeholder="搜索名称 / id / 域名，如 deepseek、智谱、openrouter" aria-label="搜索提供商预设" autocomplete="off"><div class="mp-preset-list" id="mp-preset-list" role="listbox" aria-label="提供商预设列表">${mpPresetItemsHTML()}</div></div>`;
  }
  function mpPresetItemsHTML() {
    if (state.mpCatalogLoading) return '<div class="faint" style="padding:8px">目录加载中…</div>';
    const list = state.mpCatalog;
    if (!list) return '<div class="faint" style="padding:8px">目录获取失败（离线或主进程不可用）。可手动填写下方字段，或 <button type="button" class="btn sm ghost" data-action="mp-catalog-retry">重试</button>。</div>';
    if (!list.length) return '<div class="faint" style="padding:8px">目录为空</div>';
    // 全量渲染（勿再加 slice 上限：models.dev 目录 120+ 提供商，截断会让
    // StepFun 这类后段提供商永远搜不到/滚不到——踩过）。
    return list.map((p) => `<div class="mp-preset-item" role="option" aria-selected="${state.mpPreset && state.mpPreset.id === p.id ? 'true' : 'false'}" tabindex="0" data-action="mp-preset-pick" data-id="${esc(p.id)}" data-search="${esc((p.name + ' ' + p.id + ' ' + (p.api || '')).toLowerCase())}"><span class="mp-preset-name">${esc(p.name)}</span><span class="mp-preset-id mono">${esc(p.id)}</span><span class="mp-preset-count">${p.modelCount} 模型</span></div>`).join('');
  }
  function mpModelsPoolHTML() {
    let note = '';
    if (state.mpModelsLoading) note = '<div class="mp-models-status" id="mp-models-status">正在获取可用模型…</div>';
    else if (state.mpModelsNote) {
      const retry = /获取失败|不可用/.test(state.mpModelsNote) ? ' <button type="button" class="btn sm ghost" data-action="mp-models-refetch">重试</button>' : '';
      note = `<div class="mp-models-status" id="mp-models-status">${esc(state.mpModelsNote)}${retry}</div>`;
    }
    if (state.mpModelsLoading || !state.mpModels.length) return note;
    const shown = state.mpModelsExpanded ? state.mpModels : state.mpModels.slice(0, 12);
    const rest = state.mpModels.length - shown.length;
    const items = shown.map((m) => {
      const on = state.mpModelsChecked.has(m.id) ? 'checked' : '';
      return `<label class="mp-model"><input type="checkbox" data-mid="${esc(m.id)}" ${on}><span class="mono">${esc(m.id)}</span>${m.name && m.name !== m.id ? ` <span class="faint">${esc(m.name)}</span>` : ''}<span class="mp-model-chips">${mpModelChips(m)}</span></label>`;
    }).join('');
    const srcLabel = state.mpModelsSource === 'mixed' ? '实时列表 + models.dev 增强' : state.mpModelsSource === 'catalog' ? 'models.dev 目录（非 KEY 实测范围）' : (state.mpModelsSource || '已保存');
    return note + `<fieldset class="mp-models-fs"><legend>可用模型 <span class="faint">（${srcLabel}）</span></legend>
      <div class="row" style="gap:6px;margin-bottom:6px;align-items:center">
        <button type="button" class="btn sm ghost" data-action="mp-models-all">全选</button>
        <button type="button" class="btn sm ghost" data-action="mp-models-none">全不选</button>
        <span class="faint" id="mp-models-count">已选 ${state.mpModelsChecked.size}/${state.mpModels.length}</span>
      </div>
      <div class="mp-models-list" id="mp-models-list">${items}</div>
      ${rest > 0 ? `<button type="button" class="btn sm ghost" data-action="mp-models-more" id="mp-models-more">展开全部（还有 ${rest} 个）</button>` : ''}
    </fieldset>`;
  }
  /** 局部刷新模型池（不整页 render——保住表单其它已填字段）。 */
  function mpRefreshPool() {
    const pool = $('#mp-models-pool'); if (!pool) return;
    pool.innerHTML = mpModelsPoolHTML();
    const inp = $('#mp-models');
    const hint = pool.previousElementSibling;
    // P4-S3-01：隐藏手动输入框时必须连值一起清掉。只隐藏不清值时，旧值仍在参与保存
    // 计算——用户看到的是勾选面板，存进去的却可能混着手动框里的残留模型名。
    if (inp) { inp.hidden = !!state.mpModels.length; if (state.mpModels.length) inp.value = ''; }
    if (hint && hint.tagName === 'SPAN') hint.hidden = !!state.mpModels.length;
  }
  function mpRefreshPreset() {
    const box = document.querySelector('.mp-preset'); if (!box) return;
    box.innerHTML = mpPresetControlHTML() + (state.mpPresetOpen ? mpPresetPopHTML() : '');
    if (state.mpPresetOpen) { const s = $('#mp-preset-search'); if (s) s.focus(); }
  }
  function mpRefreshPresetList() {
    const list = $('#mp-preset-list'); if (list) list.innerHTML = mpPresetItemsHTML();
  }
  function mpPresetFilter() {
    const q = ($('#mp-preset-search')?.value || '').trim().toLowerCase();
    let visible = 0;
    // 内联 display 隐藏（与 plugSearchFilter/skillSearchFilter 同惯用法）：
    // 本项目没有通用 .hidden 规则，类切换不产生视觉隐藏——曾因此出现
    // 「类换了但列表不过滤」的真 bug（e2e 只断言类存在性时没抓住）。
    document.querySelectorAll('#mp-preset-list .mp-preset-item').forEach((el) => {
      const hit = !q || (el.dataset.search || '').includes(q);
      el.style.display = hit ? '' : 'none';
      if (hit) visible++;
    });
    let empty = $('#mp-preset-empty');
    if (!visible) {
      if (!empty) {
        empty = document.createElement('div');
        empty.id = 'mp-preset-empty';
        empty.className = 'faint';
        empty.style.padding = '8px';
        empty.textContent = '无匹配的提供商';
        $('#mp-preset-list')?.appendChild(empty);
      }
    } else if (empty) empty.remove();
  }
  async function mpEnsureCatalog() {
    if (state.mpCatalog || state.mpCatalogLoading) return;
    state.mpCatalogLoading = true;
    mpRefreshPresetList();
    try {
      const r = await bridge.getModelCatalog();
      // 失败必须与「真空目录」区分：null=不可用（显式说明+可重试），[]=真拉到但一个
      // 都没有。把 null 当空数组会让用户以为目录就这么少（铁律：未接入≠为空≠失败）。
      state.mpCatalog = r && r.ok ? (r.providers || []) : null;
    } catch { state.mpCatalog = null; }
    state.mpCatalogLoading = false;
    mpRefreshPresetList();
  }
  function mpCurrentInput() {
    const type = $('#mp-type')?.value || 'ollama';
    let url = $('#mp-url')?.value?.trim() || '';
    // P4-S3-03：去掉 full 门禁——缺协议一律补 http://（已有协议的不动）。原实现勾着
    // 「完整 URL」反而不补，按 placeholder（localhost:11434）填写就探不到，失败提示又是
    // 泛泛的「获取失败」，把真实原因藏起来。
    if (url && !/^https?:\/\//i.test(url)) url = 'http://' + url;
    return { type, baseUrl: url, apiKey: ($('#mp-key')?.value || '').trim(), presetId: state.mpPreset?.id };
  }
  let mpFetchTimer = null, mpFetchToken = 0;
  function scheduleMpFetch() {
    clearTimeout(mpFetchTimer);
    mpFetchTimer = setTimeout(() => mpFetchModels(false), 800);
  }
  async function mpFetchModels(force) {
    const { type, baseUrl, apiKey, presetId } = mpCurrentInput();
    if (!baseUrl) return;
    // 非强制时，OpenAI 兼容要求 KEY 基本填完（≥8 字符）才探测，避免边打字边发请求
    if (!force && type !== 'ollama' && apiKey.length < 8) return;
    const token = ++mpFetchToken;
    state.mpModelsLoading = true;
    state.mpModelsNote = '';
    mpRefreshPool();
    const fail = (msg) => {
      if (token !== mpFetchToken) return;
      state.mpModels = []; state.mpModelsChecked = new Set();
      state.mpModelsNote = `获取失败：${msg}。可手动填写模型名称。`;
      state.mpModelsLoading = false;
      mpRefreshPool();
    };
    try {
      const r = await bridge.listModels({ type, baseUrl, apiKey, presetId });
      if (token !== mpFetchToken) return;
      if (r && r.ok) {
        state.mpModels = r.models || [];
        state.mpModelsChecked = new Set(state.mpModels.map((m) => m.id)); // 默认勾选全部可用
        state.mpModelsSource = r.source;
        const n = state.mpModels.length;
        const enriched = state.mpModels.filter((m) => m.enriched).length;
        state.mpModelsNote = r.source === 'catalog'
          ? `提供商列表端点不可用，已回退 models.dev 目录（${n} 个声明模型；非你的 KEY 实测可用范围）`
          : `已获取 ${n} 个可用模型（实时列表${enriched ? `，models.dev 增强 ${enriched} 个` : '；models.dev 无该提供商目录'}）`;
        state.mpModelsExpanded = false;
        state.mpModelsLoading = false;
        mpRefreshPool();
      } else {
        fail((r && r.reason) || '未知原因');
      }
    } catch (err) {
      fail((err && err.message) || err);
    }
  }
  function mpApplyPreset(id) {
    const p = (state.mpCatalog || []).find((x) => x.id === id);
    if (!p) return;
    state.mpPreset = { id: p.id, name: p.name, api: p.api };
    state.mpPresetOpen = false;
    // 就地更新控件与字段（不 render——表单可能已填了一半）
    mpRefreshPreset();
    const nameEl = $('#mp-name'); if (nameEl && !nameEl.value) nameEl.value = p.name;
    const typeEl = $('#mp-type'); if (typeEl && p.id === 'ollama') typeEl.value = 'ollama';
    const urlEl = $('#mp-url'); if (urlEl && p.api) urlEl.value = p.api;
    mpFetchModels(true); // KEY 可能已填：预设落定即拉一次
  }

  VIEWS.settings = {
    side() {
      return `<div class="sec-title">设置</div>
        <div class="settings-nav">
        ${SETTINGS_SECTIONS
          .map((s) => `<div class="node settings-nav-item" data-action="settings-nav" data-id="${s.id}"><span class="sni-icon">${ic(s.icon, 14)}</span><span class="sni-label">${s.n}</span></div>`).join('')}
        </div>`;
    },
    main() {
      // BUG（全盘死挂点扫描）：statbar 硬编码「%APPDATA%/OrchDesk」「dsh 99f6f02」——
      // 渲染层拿不到真实数据目录与运行时版本，宁可显示真实状态也不伪造。
      const ddOk = state.dataDirInventory && state.dataDirInventory.ok && state.dataDirInventory.dir;
      const ddShort = ddOk ? String(state.dataDirInventory.dir).replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') : '';
      const rtOk = state.pluginRuntime && state.pluginRuntime.ready;
      const sectionNames = { model: '模型', sandbox: '沙箱与授权', prompt: '提示词', desktop: '桌面集成', memory: '记忆', data: '数据', about: '关于' };
      const here = sectionNames[state.settingsSection] || '模型';
      return `<div class="main-inner"><h1 class="pg">偏好</h1><div class="pg-sub">当前：${here}。模型、沙箱、授权、桌面集成都在这一页。</div>
        <div class="statbar">
          <div class="stat"><div class="sk">授权模式</div><div class="sv"><span class="dot" style="background:${authModeDotColor()}"></span>${authModeLabel(state.authMode)}${state.authzLoaded ? '' : ' · 未接入'}</div></div>
          <div class="stat"><div class="sk">沙箱</div><div class="sv">${state.sandbox.mode ? `<span class="badge ok" style="font-weight:600">Windows ACL · ${esc(state.sandbox.modeLabel || '未识别档位')}</span>` : '<span class="badge">未接入</span>'}</div></div>
          <div class="stat"><div class="sk">数据目录</div><div class="sv" style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px" title="${esc(ddOk ? state.dataDirInventory.dir : '')}">${ddOk ? '…/' + esc(ddShort) : '本地（未扫描）'}</div></div>
          <div class="stat"><div class="sk">运行时</div><div class="sv" style="font-size:12px;font-weight:500">${rtOk ? `插件运行时就绪 · ${state.pluginRuntime.activeCount}/${state.pluginRuntime.total}` : '插件运行时未启动'}</div></div>
        </div>
        <div class="sec-title" id="settings-section-model"><span class="ico">${ic('bot', 14)}</span>模型管理</div>
        <div class="card" id="model-mgmt-card">
          <div class="faint" style="margin-bottom:14px">添加模型提供商后，会话中发送消息将调用真实模型 API（OpenAI 兼容或 Ollama 本地）。API Key 经系统安全存储加密。</div>
          <div id="model-providers-list"></div>
          <div id="default-model-pick-wrap" style="${state.modelProviders.length ? '' : 'display:none'}">
            <div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px;display:flex;align-items:center;gap:8px">
              <span class="faint" style="font-size:11.5px;white-space:nowrap">默认模型</span>
              <select id="default-model-pick" class="mp-inp" style="flex:1;font-size:12px">
                ${(state.modelProviders || []).flatMap(p => (p.models || []).map(m => ({ n: m, pn: p.name, pt: p.type }))).map(m =>
                  `<option value="${esc(m.n)}" ${state.defaultModel === m.n ? 'selected' : ''}>${esc(m.pn)} (${m.pt === 'ollama' ? '本地' : 'API'}) · ${esc(m.n)}</option>`
                ).join('')}
              </select>
            </div>
          </div>
          <div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px;display:flex;align-items:center;gap:8px">
            <span class="faint" style="font-size:11.5px;white-space:nowrap;flex:none">Agent 迭代</span>
            <input type="range" id="max-iter-pick" min="1" max="500" step="1" value="${state.maxToolIterations || 200}" style="flex:1" aria-label="Agent 迭代次数" aria-valuetext="${state.maxToolIterations || 200} 次">
            <span id="max-iter-val" class="mono" style="font-size:11px;color:var(--fg-dim);min-width:32px;text-align:right">${state.maxToolIterations || 200}</span>
          </div>
          ${renderUsageCard()}
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
            <b style="font-size:12.5px;margin-bottom:10px;display:block">${state.mpEditing ? '编辑提供商' : '添加提供商'}</b>
            <div class="mp-form">
              <div class="mp-row">
                <label class="mp-label">提供商预设</label>
                <div class="mp-preset">
                  ${mpPresetControlHTML()}
                  ${state.mpPresetOpen ? mpPresetPopHTML() : ''}
                </div>
                <span class="faint" style="font-size:11px;margin-left:8px">来自 models.dev 目录，选中自动填充名称与 Base URL</span>
              </div>
              <div class="mp-row">
                <label class="mp-label">类型</label>
                <select id="mp-type" class="mp-inp" style="max-width:180px">
                  <option value="ollama">Ollama 本地</option>
                  <option value="openai-compatible">OpenAI 兼容</option>
                </select>
              </div>
              <div class="mp-row">
                <label class="mp-label">名称</label>
                <input type="text" id="mp-name" placeholder="如 OpenAI、DeepSeek" class="mp-inp">
              </div>
              <div class="mp-row">
                <label class="mp-label">Base URL</label>
                <div class="mp-url-wrap">
                  <input type="text" id="mp-url" placeholder="localhost:11434" class="mp-inp mp-url-inp">
                  <label class="mp-url-check"><input type="checkbox" id="mp-fullurl" checked> 完整 URL（含 http://）</label>
                </div>
              </div>
              <div class="mp-row" id="mp-mode-row" style="display:none">
                <label class="mp-label">API 协议</label>
                <select id="mp-mode" class="mp-inp" style="max-width:200px">
                  <option value="chat">/v1/chat/completions（标准对话）</option>
                  <option value="responses">/v1/responses（ Responses API）</option>
                  <option value="completions">/v1/completions（文本补全）</option>
                </select>
                <span class="faint" style="font-size:11px;margin-left:8px">选择 API 端点协议</span>
              </div>
              <div class="mp-row">
                <label class="mp-label">API Key</label>
                <input type="password" id="mp-key" placeholder="sk-...（可选，Ollama 可留空）" class="mp-inp">
              </div>
              <div class="mp-row">
                <label class="mp-label">模型</label>
                <div class="mp-models-wrap">
                  <input type="text" id="mp-models" placeholder="gpt-4o, claude-3-5-sonnet（逗号分隔）" class="mp-inp" ${state.mpModels.length ? 'hidden' : ''}>
                  <span class="faint" style="font-size:11px;margin-left:8px" ${state.mpModels.length ? 'hidden' : ''}>逗号分隔多个模型名称（拉取失败时的手动兜底）</span>
                  <div id="mp-models-pool">${mpModelsPoolHTML()}</div>
                </div>
              </div>
              <div class="mp-row" style="margin-top:4px">
                <label class="mp-label"></label>
                <div style="display:flex;gap:8px">
                  <button class="btn sm primary" data-action="model-add-provider">${state.mpEditing ? '保存' : '添加'}</button>
                  ${state.mpEditing ? '<button class="btn sm" data-action="model-cancel-edit">取消</button>' : ''}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="sec-title" id="settings-section-sandbox"><span class="ico">${ic('shield', 14)}</span>沙箱与授权</div>
        <div class="card">
          <div class="row" style="margin-bottom:10px">
            <span class="badge ok">沙箱 Windows ACL</span><span class="badge info">L0-L4 分级</span><span class="faint">fail-closed</span>
          </div>
          <div class="faint" style="margin-bottom:8px">授权模式只有默认模式和完全信任。危险命令仍由本界面确认。</div>
          <div class="auth-modes">
            ${authModesForRender().map((m) => `<div class="am ${state.authMode === m.id ? 'sel' : ''}" data-action="auth-mode-pick" data-id="${m.id}">
              <div class="am-h"><b>${m.label}</b>${state.authMode === m.id ? '<span class="badge ok">当前</span>' : ''}</div>
              <div class="faint" style="font-size:11.5px;margin-top:4px">${m.blurb}</div>
            </div>`).join('')}
          </div>
          <div class="sec-title" style="margin:24px 0 8px">网络域名白名单</div>
          <div class="faint" style="margin-bottom:6px">一行一个域名（如 <span class="mono">github.com</span>），<span class="mono">*</span> 表示不限。<b>留空 = 全部拒绝</b>（fail-closed）：web_fetch / browser_open 命中不了白名单即直接拒绝。内网/云元数据端点另受 SSRF 防护拦截。</div>
          ${state.sandbox.loaded ? '' : '<div class="faint" style="margin-bottom:6px">白名单尚未拉取（主进程未返回）——显示为空，不代表已确认全部拒绝。</div>'}
          <textarea class="inp mono" id="net-allow" rows="3" style="width:100%;font-size:11.5px"${state.sandbox.loaded ? '' : ' disabled'} placeholder="${state.sandbox.loaded ? '' : '未拉取'}">${esc((state.sandbox.networkAllow || []).join('\n'))}</textarea>

          <div class="row" style="margin-top:8px"><button class="btn sm primary" data-action="sandbox-save-net">保存白名单</button><span class="faint" id="net-allow-tip"></span></div>
          <div class="sec-title" style="margin:24px 0 8px">L0-L4 分级</div>
          <div class="levels">
            ${state.authLevels.length ? state.authLevels.map((l) => `<div class="lv"><span class="lv-n">L${l.level}</span><span class="lv-l">${l.label}</span><span class="faint">${l.scope}</span>${l.requiresApproval ? '<span class="badge warn">需授权</span>' : ''}</div>`).join('')
              // P4-S3-06：设置页这处原来也只有「加载中…」一个分支，init 里 getAuthLevels
              // 失败/返回空时它会永久卡死。与授权模式弹窗里的那处同一套三态。
              : (state.authzLoaded
                ? '<div class="faint">授权插件未返回分级定义（重进设置页或重启应用可重试）</div>'
                : '<div class="faint">分级定义未接入（授权服务不可用 · fail-closed：按最严处理）</div>')}
          </div>
          <div class="sec-title" style="margin:24px 0 8px">授权白名单（可查看可撤销）</div>
          <div class="faint" style="margin-bottom:6px">粒度分「会话 / 永久」，规则 = 操作类型 + 目标（仅 <span class="mono">*</span> 通配，整串匹配）。命中即放行并计入审计。<b>永久粒度不允许</b>「任意操作」或 <span class="mono">*</span> 目标（一次点击不该等于永久免审一切）。</div>
          ${/* P4-S3-08：原实现的默认组合（工具=任意操作 *、粒度=永久）恰好是后端明文拒绝的
               组合，而 placeholder 又明示「或 *」、说明文字说「永久不允许 *」——用户按默认
               填完点添加才收到英文味很重的错误 reason。防错要靠事前：把会被拒的组合在选项里
               标注出来，默认落到合法组合。 */''}
          <div class="grant-add">
            <select id="grant-tool" class="inp" style="width:150px">
              ${(state.grantTools.length ? state.grantTools : ['file_write', 'shell_command', 'web_fetch', '*']).map((t) => `<option value="${t}">${t === '*' ? '任意操作（永久粒度不可用）' : t}</option>`).join('')}
            </select>
            <input type="text" id="grant-pattern" class="inp mono" placeholder="目标模式，如 D:/Code/OrchDesk/*（永久粒度不接受 *）" style="flex:1;font-size:11.5px">
            <select id="grant-scope" class="inp" style="width:110px"><option value="session">本会话</option><option value="permanent">永久（需具体目标）</option></select>
            <button class="btn sm primary" data-action="grant-add">+ 添加</button>
          </div>
          <div class="grant-list">
            ${state.grants.length ? state.grants.map((g) => `<div class="gr-item">
              <span class="badge ${g.scope === 'permanent' ? 'warn' : 'info'}">${g.scope === 'permanent' ? '永久' : '会话'}</span>
              <span class="mono">${esc(g.tool === '*' ? '任意操作' : g.tool)}</span>
              <span class="mono faint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.pattern)}">${esc(g.pattern)}</span>
              <span class="faint">${g.hits} 次</span>
              <button class="opbtn" data-action="grant-revoke" data-id="${esc(g.id)}" title="撤销">${ic('trash', 13)}</button>
            </div>`).join('') : '<div class="faint">暂无白名单（审批弹窗点「会话内允许 / 永久允许」即写入，也可上方手动添加）</div>'}
          </div>
          <div class="row" style="margin-top:8px">
            <button class="btn sm" data-action="grant-revoke-all" ${state.grants.length ? '' : 'disabled'}>全部撤销</button>
            <span class="faint">撤销立即生效，全部动作入审计日志</span>
          </div>
          <div class="sec-title" style="margin:24px 0 8px">审计日志（近期）</div>
          <div class="audit-log">
            ${state.authAudit.length ? state.authAudit.slice().reverse().slice(0, 12).map((e) => `<div class="al"><span class="mono" style="font-size:11px">${new Date(e.ts).toLocaleTimeString('zh-CN')}</span><span class="badge ${e.kind === 'approval-decided' ? (e.outcome === 'allowed-once' ? 'ok' : 'danger') : 'info'}">${e.kind}</span>${e.toolName ? `<span class="mono faint">${e.toolName}</span>` : ''}${e.outcome ? `<span class="faint">${e.outcome}</span>` : ''}${e.mode ? `<span class="faint">mode=${e.mode}</span>` : ''}</div>`).join('') : '<div class="faint">暂无审计事件（L3/L4 操作与模式切换会记录于此）</div>'}
          </div>
          <div class="sec-title" style="margin:24px 0 8px">补偿层审计（边界外操作）</div>
          <div class="audit-log">
            ${state.compAudit.length ? state.compAudit.slice().reverse().slice(0, 12).map((e) => `<div class="al"><span class="mono" style="font-size:11px">${new Date(e.ts).toLocaleTimeString('zh-CN')}</span><span class="badge warn">补偿</span><span class="mono faint">${esc(e.text || '')}</span>${e.note ? `<span class="faint">${esc(e.note)}</span>` : ''}</div>`).join('') : (state.compAuditLoaded
              ? '<div class="faint">暂无补偿动作记录（外发/不可逆操作后在此提供「补偿动作」）</div>'
              : '<div class="faint">补偿动作记录未接入（主进程桥不可用）· 不是「没有补偿动作」</div>')}
          </div>
          <div class="row" style="margin-top:8px"><button class="btn sm" data-action="comp-record">+ 记录补偿动作</button><span class="faint">不保证完全撤销，仅尽力补偿</span></div>
          <div class="sec-title" style="margin:24px 0 8px">沙箱日志（可检索）</div>
          <div class="faint" style="margin-bottom:6px">记录每一次沙箱判定：路径 / 命令 / 域名白名单、授权门、外发预判，以及执行成败。环形缓冲保留最近 ${state.sandboxLog.max} 条，随数据目录迁移。</div>
          <div class="sblog-bar">
            <input type="text" id="sblog-kw" class="inp mono" placeholder="检索：路径 / 命令 / 域名 / 会话 ID" style="flex:1;font-size:11.5px" value="${esc(state.sandboxLog.keyword)}">
            <select id="sblog-decision" class="inp" style="width:96px">
              ${['all', 'denied', 'allowed', 'error'].map((d) => `<option value="${d}"${state.sandboxLog.decision === d ? ' selected' : ''}>${SL_DECISION_LABELS[d]}</option>`).join('')}
            </select>
            <select id="sblog-kind" class="inp" style="width:110px">
              ${['all', 'path', 'command', 'network', 'approval', 'browser', 'config'].map((k) => `<option value="${k}"${state.sandboxLog.kind === k ? ' selected' : ''}>${SL_KIND_LABELS[k]}</option>`).join('')}
            </select>
            <button class="btn sm" data-action="sblog-clear" ${state.sandboxLog.total ? '' : 'disabled'}>清空</button>
          </div>
          <div class="sblog-stats sl-stats">
            <span class="badge info">共 ${state.sandboxLog.total} 条</span>
            <span class="badge ok">放行 ${state.sandboxLog.stats.allowed}</span>
            <span class="badge danger">拒绝 ${state.sandboxLog.stats.denied}</span>
            ${state.sandboxLog.stats.error ? `<span class="badge warn">出错 ${state.sandboxLog.stats.error}</span>` : ''}
            ${state.sandboxLog.stats.byTool.map((t) => `<span class="faint mono">${esc(t.tool)} ×${t.count}</span>`).join('')}
          </div>
          <div class="audit-log sblog sl-log">
            ${state.sandboxLog.entries.length ? state.sandboxLog.entries.map((e) => `<div class="al">
              <span class="mono" style="font-size:11px">${new Date(e.ts).toLocaleString('zh-CN')}</span>
              <span class="badge ${e.decision === 'allowed' ? 'ok' : (e.decision === 'denied' ? 'danger' : 'warn')}">${SL_DECISION_LABELS[e.decision] || e.decision}</span>
              <span class="badge info">${SL_KIND_LABELS[e.kind] || e.kind}</span>
              <span class="mono faint">${esc(e.tool)}</span>
              <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.target)}">${esc(e.target)}</span>
              ${e.reason ? `<span class="faint" style="max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.reason)}">${esc(e.reason)}</span>` : ''}
            </div>`).join('') : `<div class="faint">${state.sandboxLog.loaded ? '暂无匹配记录（Agent 执行文件 / 命令 / 网络操作时写入）' : '沙箱日志未接入（主进程桥不可用）'}</div>`}
          </div>
        </div>
        <div class="sec-title" id="settings-section-prompt"><span class="ico">${ic('at', 14)}</span>系统提示词库</div>
        <div class="card">
          <div class="faint" style="margin-bottom:8px">提示词与技能解耦；分类（角色行为 / 安全边界 / 输出格式 / 技能联动）；支持 <span class="mono">{'{skill:xxx}'}</span> 引用；按 Agent 绑定 + 优先级合并（冲突显式标记）。</div>
          <div class="row" style="margin-bottom:8px"><button class="btn sm primary" data-action="prompt-new">+ 新建提示词</button><span class="faint">共 ${state.promptDocs.length} 条</span></div>
          <div class="prompt-list">
            ${state.promptDocs.length ? state.promptDocs.map((d) => `<div class="pl-item" data-action="prompt-edit" data-id="${esc(d.id)}">
              // R5-02：title / agents / category 全部过 esc()。title 由 openPromptEditor
              // 经 doSavePrompt 落盘、listPrompts 读回，是可持久化的**存储型 XSS**：标题里含
              // img onerror 之类的片段会在渲染设置页时执行。本文件其余同类内容早已走 esc()，
              // 此处是漏网的那一处。（注释里别写反引号——会提前关闭外层模板字面量。）
              <div class="pl-h"><b>${esc(d.title)}</b><span class="badge info">${esc(PROMPT_CAT_LABELS[d.category] || d.category)}</span>${d.agents.length ? `<span class="faint">· ${esc(d.agents.join(', '))}</span>` : '<span class="faint">· 全局</span>'}</div>
              <div class="mono faint" style="font-size:11px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((d.body || '').slice(0, 80))}</div>
            </div>`).join('') : '<div class="faint">暂无提示词（新建后在此列出，可按 Agent 绑定与合并）</div>'}
          </div>
          ${state.promptConflicts.length ? `<div class="warn-list" style="margin-top:8px"><div class="badge warn">合并冲突 ${state.promptConflicts.length} 处（已显式标记，未静默覆盖）</div>${state.promptConflicts.slice(0, 4).map((c) => `<div style="font-size:11px;margin-top:4px">· ${esc(PROMPT_CAT_LABELS[c.category] || c.category)}：${esc(c.docA)} ↔ ${esc(c.docB)}</div>`).join('')}</div>` : ''}
        </div>
        <div class="sec-title" id="settings-section-desktop"><span class="ico">${ic('settings', 14)}</span>桌面集成</div>
        <div class="desktop-grid">
          ${desktopItem('tray', '系统托盘', '关闭窗口后继续运行')}
          ${desktopItem('shortcut', '全局快捷键', state.desktop && state.desktop.shortcutLabel ? state.desktop.shortcutLabel : 'Ctrl+Shift+Space', true)}
          ${desktopItem('autostart', '登录自启动', desktopAutostartDesc())}
          ${desktopItem('autoupdate', '自动更新', '启动时检查新版本并提醒；不自动下载，安装前先确认')}
          ${desktopItem('floating', '悬浮窗', '桌面常驻小窗，点击唤起主窗')}
          ${desktopItem('notify', '开机提醒', '关键事件系统通知')}
          <div class="desktop-item"><div><div class="di-name">TRACE 遥测</div><div class="di-desc" id="trace-desc">未启用：trace 随 dsh 卸下且不迁移，本壳不向任何仓库上报</div></div><div class="switch ${state.traceEnabled ? 'on' : ''}" id="trace-switch" data-action="trace-toggle"></div></div>
        </div>
        <div class="sec-title" id="settings-section-memory"><span class="ico">${ic('archive', 14)}</span>分层记忆</div>
        <div class="card">
          <div class="faint" style="margin-bottom:8px">四域物理隔离，各落独立文件。Worker 出域（→ 总监 / 项目 / 全局）一律经 Director 过滤，<b>fail-closed</b>：过滤器缺失、超时、抛错都按拒绝处理。</div>
          <div class="row" style="gap:6px;margin-bottom:8px;align-items:center">
            <span class="faint" style="font-size:11.5px">转储摘要</span>
            ${!state.memorySummarize.loaded
    // 桥断了就**不要**沿用上一秒的状态：那会把「已断开」显示成「正在用某模型」，
    // 与记忆列表同类的毛病（陈旧状态冒充现状）。loaded=false 一律报未接入。
    ? '<span class="badge warn">摘要状态未接入</span><span class="faint" style="font-size:11px">主进程桥不可用</span>'
    : state.memorySummarize.mode === 'llm'
      ? `<span class="badge ok">模型摘要</span><span class="faint mono" style="font-size:11px">${esc(state.memorySummarize.provider || '模型')} / ${esc(state.memorySummarize.model)}</span>`
      : '<span class="badge warn">抽取式兜底</span><span class="faint" style="font-size:11px">未配置模型：自动转储只保留首尾各 3 条原文</span>'}
          </div>
          <div class="row" style="margin-bottom:6px;gap:6px">
            ${['worker', 'director', 'project', 'global'].map((d) => {
    const n = state.memory.stats && typeof state.memory.stats[d] === 'number' ? state.memory.stats[d] : null;
    return `<span class="seg-tab ${state.memory.domain === d ? 'active' : ''}" data-action="mem-domain" data-domain="${d}" title="${esc(MEM_DOMAIN_DESC[d])}">${MEM_DOMAIN_LABELS[d]}${n === null ? '' : ` ${n}`}</span>`;
  }).join('')}
            <button class="btn sm" style="margin-left:auto" data-action="mem-refresh" ${state.memory.busy ? 'disabled' : ''}>刷新</button>
          </div>
          <div class="faint" style="margin-bottom:8px;font-size:11.5px">${esc(MEM_DOMAIN_DESC[state.memory.domain])}</div>
          ${state.memory.domain === 'worker' ? `<div class="row" style="margin-bottom:8px"><button class="btn sm primary" data-action="mem-promote-worker" ${(state.memory.busy || !state.memory.items.length) ? 'disabled' : ''}>批量晋升本域（逐条过 Director 过滤）</button><span class="faint" style="font-size:11px">一次最多 ${state.memory.promoteBatchMax || 20} 条，按时间正序</span></div>` : ''}
          <div class="mem-list">
            ${state.memory.items.length ? state.memory.items.slice().sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).map((e) => {
    const to = MEM_NEXT_DOMAIN[state.memory.domain];
    return `<div class="mem-item">
                <div class="mi-text" title="${esc(e.text)}">${esc(String(e.text || '').slice(0, 160))}</div>
                <div class="mi-meta">
                  <span class="mono faint">${esc(e.origin || '—')}</span>
                  ${e.agent ? `<span class="faint">${esc(e.agent)}</span>` : ''}
                  <span class="faint mono" style="margin-left:auto">${e.createdAt ? new Date(e.createdAt).toLocaleString('zh-CN') : ''}</span>
                </div>
                ${to ? `<button class="btn sm" data-action="mem-promote" data-id="${esc(e.id)}" data-from="${esc(state.memory.domain)}" data-to="${to}" ${state.memory.busy ? 'disabled' : ''}>晋升 → ${MEM_DOMAIN_LABELS[to]}</button>` : '<span class="faint" style="font-size:11px">已在顶层</span>'}
              </div>`;
  }).join('') : `<div class="faint">${state.memory.loaded ? (state.memory.domain === 'worker' ? '本域暂无条目（SubAgent 执行完被回收时，其结论会落到这里）' : '本域暂无条目（由下层晋升而来）') : '记忆服务未接入（主进程桥不可用）'}</div>`}
          </div>
          <div class="sec-title" style="margin:24px 0 8px">晋升审计</div>
          <div class="sblog-bar">
            <select id="mp-ok" class="inp" style="width:120px">
              ${[['all', '全部'], ['true', '已晋升'], ['false', '被拦下']].map(([v, t]) => `<option value="${v}"${state.memoryPromotions.ok === v ? ' selected' : ''}>${t}</option>`).join('')}
            </select>
            <button class="btn sm" data-action="mp-clear" ${state.memoryPromotions.total ? '' : 'disabled'}>清空</button>
          </div>
          <div class="sblog-stats mp-stats">
            <span class="badge info">共 ${state.memoryPromotions.total} 条</span>
            <span class="badge ok">已晋升 ${state.memoryPromotions.stats.promoted}</span>
            <span class="badge danger">被拦下 ${state.memoryPromotions.stats.rejected}</span>
            ${state.memoryPromotions.stats.byEdge.map((x) => `<span class="faint mono">${esc(x.edge)} ×${x.count}</span>`).join('')}
          </div>
          <div class="audit-log sblog mp-log">
            ${state.memoryPromotions.entries.length ? state.memoryPromotions.entries.map((e) => `<div class="al">
              <span class="mono" style="font-size:11px">${new Date(e.ts).toLocaleString('zh-CN')}</span>
              <span class="badge ${e.ok ? 'ok' : 'danger'}">${e.ok ? '已晋升' : '被拦下'}</span>
              <span class="mono faint">${esc(e.from)} → ${esc(e.to)}</span>
              <span class="badge info">${e.actor === 'auto' ? '自动' : '手动'}</span>
              <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.preview)}">${esc(e.preview) || '<span class="faint">（无预览）</span>'}</span>
              <span class="faint" style="max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(memReasonText(e.reason))}">${esc(memReasonText(e.reason))}</span>
            </div>`).join('') : `<div class="faint">${state.memoryPromotions.loaded ? '暂无晋升记录（在此点「晋升」后写入）' : '晋升审计未接入（主进程桥不可用）'}</div>`}
          </div>
        </div>
        <div class="sec-title" id="settings-section-data"><span class="ico">${ic('folder', 14)}</span>数据目录</div>
        <div class="card">
          // P4-S3-10：未扫描时不再显示字面量 %APPDATA%/OrchDesk——那是一个未经核实、
          // 却以真实面目呈现的路径。同页 statbar 对同一数据正确显示「本地（未扫描）」。
          <div class="row"><span class="mono">${esc(state.dataDirInventory.dir || '本地（未扫描）')}</span><span class="faint">· 本地优先，数据不出本机</span></div>
          ${state.dataDirInventory.ok
    ? `<div class="faint" style="margin-top:6px;font-size:11.5px">共 ${esc(state.dataDirInventory.totalSizeText)} · ${state.dataDirInventory.totalFiles} 个文件${state.dataDirInventory.errors.length ? ` · <span class="badge warn">${state.dataDirInventory.errors.length} 项扫描失败</span>` : ''}</div>
             <div class="dir-inv">${state.dataDirInventory.items.map((i) => `<div class="di-row">
               <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.name)}">${ic(i.kind === 'dir' ? 'folder' : 'fileText', 12)} ${esc(i.name === '.' ? '（全部）' : i.name)}</span>
               ${i.kind === 'dir' ? `<span class="faint">${i.files} 个文件</span>` : ''}
               <span class="faint mono">${esc(i.sizeText || '')}</span>
             </div>`).join('') || '<div class="faint">目录为空（首次运行尚未产生数据）</div>'}</div>`
    : '<div class="faint" style="margin-top:6px;font-size:11.5px">内容清单未接入（主进程桥不可用）</div>'}
          <div class="row" style="margin-top:8px"><button class="btn sm" data-action="open-project-dir">打开目录</button><button class="btn sm" data-action="open-log-dir">打开日志</button><button class="btn sm" data-action="dir-inv-refresh">刷新清单</button><button class="btn sm" data-action="snapshot-data">导出快照</button><button class="btn sm primary" data-action="check-updates">检查更新（先快照）</button></div>
          <div class="row" style="margin-top:6px"><button class="btn sm" data-action="export-data">导出数据</button><button class="btn sm" data-action="import-data">导入数据</button><span class="faint" style="font-size:11px">跨设备迁移 · 只补齐不覆盖</span></div>
        </div>
        <div class="sec-title" id="settings-section-about"><span class="ico">${ic('at', 14)}</span>关于</div>
        <div class="card">
          <div class="row" style="justify-content:space-between"><span>StepCode Desktop</span><b>P6</b></div>
          <div class="faint" style="margin-top:4px">会话优先的本地 Agent 工作台</div>
          <div class="faint" style="margin-top:8px;font-size:11.5px">底座 deepseek-harness（Cordis）· 基线 99f6f02</div>
        </div>
        <div style="margin-top:14px"><button class="btn" data-action="wz-open">重新打开入门向导</button></div></div>`;
    },
    ctx() {
      return `<div class="sec-title">凭据</div>
        <div class="faint">API Key 以 AES-256-GCM 加密存储；界面只显示掩码。</div>
        <div class="sec-title">一切皆插件</div>
        <div class="faint">模型、提示词、沙箱、授权、记忆等均为插件；关闭即卸载并回滚其注册（可逆效应），无残留。</div>
        <div class="sec-title">快捷操作</div>
        <div class="card" style="padding:10px">
          <div class="row" style="padding:4px 0"><span>备份整个数据目录</span>
            <span class="faint mono" style="margin-left:auto">${state.dataDirInventory.ok ? esc(state.dataDirInventory.totalSizeText) : '未接入'}</span>
            <button class="btn sm" data-action="export-data">导出</button></div>
          <div class="row" style="padding:4px 0"><span>打开数据目录</span>
            <span class="faint mono" style="margin-left:auto">${state.dataDirInventory.ok ? state.dataDirInventory.totalFiles + ' 个文件' : ''}</span>
            <button class="btn sm" data-action="open-project-dir">打开</button></div>
          <div class="row" style="padding:4px 0"><span>打开日志目录</span><button class="btn sm" style="margin-left:auto" data-action="open-log-dir">打开</button></div>
        </div>`;
    }
  };

  /* ---------- 向导 ---------- */
  const WZ = [
    { t: '欢迎使用 StepCode Desktop', h: `<div style="font-size:18px;font-weight:700;margin-bottom:8px">本地优先的 Agent 工作台</div>
      <div class="mut" style="margin-bottom:14px">打开就是会话。像 DSH 一样，你只需和一个 Agent 对话；脑-手解耦、多Agent编排、意图识别在后台安静运行，需要时再进「插件」或「设置」。</div>
      // P4-S1-13：不再写死「deepseek-harness 运行时 · 就绪 · 基线 99f6f02」——徽章和
      // commit 全无运行时背书，与 statbar 里同款硬编码曾被当 BUG 修掉是同一模式。
      // 向导是纯本地引导，只说本地运行，不冒充任何后端状态。
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:center"><span class="badge ok">本地</span><div><b>StepCode 运行时</b><div class="faint">数据留在本机 · 模型可随时配置</div></div></div>` },
    { t: '选择默认专家', h: `<div style="margin-bottom:10px" class="mut">你想先和谁对话？（之后可随时切换，或用专家团）</div>
      ${expertList().map((e, i) => `<div class="expert-opt ${state.wzExpert === i ? 'sel' : ''}" data-action="wz-expert" data-i="${i}"><div class="avatar" style="background:${i === 0 ? 'var(--ceo)' : 'var(--director)'}">${e[0]}</div><div><b>${e}</b><div class="faint">${i === 0 ? '主会话：理解/拆解/回收/沉淀' : '领域专家'}</div></div></div>`).join('')}` }
  ];
  function renderWizard() {
    $('#wzBody').innerHTML = WZ[state.wz].h;
    $('#wzNext').textContent = state.wz === 0 ? '下一步' : '进入会话';
  }

  /* ---------- 引擎 ---------- */
  function updateProtocolRow() {
    const t = $('#mp-type')?.value;
    const row = $('#mp-mode-row');
    if (row) row.style.display = t === 'openai-compatible' ? '' : 'none';
  }
  function renderModelProviders() {
    const el = $('#model-providers-list');
    if (!el) return;
    const providers = state.modelProviders || [];
    if (!providers.length) {
      el.innerHTML = '<div class="faint prov-empty">尚未配置模型提供商，请使用下方表单添加。<br>添加后可在对话中调用真实模型 API（OpenAI 兼容或 Ollama 本地），API Key 经系统安全存储加密。</div>';
      return;
    }
    const modeLabel = { chat: 'Chat', responses: 'Responses', completions: 'Completions', ollama: 'Ollama' };
    el.innerHTML = providers.map(p => `<div class="prov-row" data-id="${p.id}">
      <div class="prov-info">
        <div class="prov-name"><b>${esc(p.name)}</b><span class="badge info">${p.type === 'ollama' ? 'Ollama 本地' : 'OpenAI 兼容 · ' + (modeLabel[p.apiMode] || 'Chat')}</span></div>
        <div class="prov-detail"><span class="mono faint">${esc(p.baseUrl)}</span><span class="faint">·</span><span class="faint">${(p.models || []).join(', ')}</span></div>
      </div>
      <div class="prov-actions"><button class="btn sm ghost" data-action="model-test" data-id="${esc(p.id)}" data-n="${esc((p.models || [])[0] || p.name)}">测试</button><button class="btn sm" data-action="model-edit-provider" data-id="${p.id}">编辑</button><button class="btn sm danger" data-action="model-del-provider" data-id="${p.id}">删除</button></div>
    </div>`).join('');
    refreshDefaultModelPicker();
  }

  function refreshDefaultModelPicker() {
    const wrap = $('#default-model-pick-wrap');
    if (!wrap) return;
    const allModels = (state.modelProviders || []).flatMap(p => (p.models || []).map(m => ({ n: m, pn: p.name, pt: p.type })));
    const pick = wrap.querySelector('select');
    if (!pick) return;
    pick.innerHTML = allModels.map(m =>
      `<option value="${esc(m.n)}" ${state.defaultModel === m.n ? 'selected' : ''}>${esc(m.pn)} (${m.pt === 'ollama' ? '本地' : 'API'}) · ${esc(m.n)}</option>`
    ).join('');
    wrap.style.display = allModels.length ? '' : 'none';
  }

  /** 只重渲设置页主区 + 分区高亮/滚动（P4-S3-14：分区导航不该清空用户填了一半的表单）。 */
  function renderSettingsMain() {
    const v = VIEWS.settings;
    if (!v || state.page !== 'settings') { render(); return; }
    const main = $('#main');
    if (main) main.innerHTML = v.main();
    hardenActions($('#main'));
    const target = $('#settings-section-' + state.settingsSection);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('[data-action="settings-nav"]').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === state.settingsSection);
    });
  }

  function render() {
    try {
      renderRail();
      const v = VIEWS[state.page];
      if (!v) {
        $('#main').innerHTML = '<div style="color:red;padding:40px">未知页面：' + esc(state.page) + '</div>';
        return;
      }
      $('#side').innerHTML = v.side();
      $('#main').innerHTML = v.main();
      $('#context').innerHTML = v.ctx();
      $('#appGrid').classList.toggle('has-ctx', !!state.ctxOpen);
      $('#appGrid').classList.remove('light', 'project');
      document.body.classList.remove('light-mode');
      $('#winTitle').textContent = (PAGES.find((x) => x.id === state.page)?.n || '会话') + ' — 本地 Agent 工作台';
      // P1 键盘可达（/harden）：渲染后给所有非原生可交互的 [data-action] 补
      // role/tabindex —— 项目惯用 div+data-action，靠逐个补必漏（焦点样式有了，
      // 但没有 tabindex 焦点根本到不了）。委托层一次性收敛，新元素自动继承。
      hardenActions($('#main')); hardenActions($('#side')); hardenActions($('#context'));
      if (state.page === 'plugins') { plugSearchFilter(); skillSearchFilter(); }
      if (state.page === 'settings') renderModelProviders();
      // 设置页分区注册表断言（/layout）：导航项与主区分区必须双向覆盖。
      // 曾漂移出「凭据」死入口与「分层记忆」无入口——这里让下一次漂移当场现形。
      if (state.page === 'settings') {
        const navIds = SETTINGS_SECTIONS.map((s) => s.id);
        const secIds = [...document.querySelectorAll('[id^="settings-section-"]')].map((el) => el.id.replace('settings-section-', ''));
        const navNoSec = navIds.filter((id) => !secIds.includes(id));
        const secNoNav = secIds.filter((id) => !navIds.includes(id));
        if (navNoSec.length || secNoNav.length) {
          console.warn('[settings] 分区注册表漂移：导航无分区 =', navNoSec, '；分区无导航 =', secNoNav);
        }
      }
      // 插件页同理：每个主区分区（.psec[id]）都应至少有一个侧栏跳转入口
      // （[data-target]）。曾出现 MCP / 临时插件两个分区无任何侧栏入口。
      if (state.page === 'plugins') {
        const secIds = [...document.querySelectorAll('[id^="psec-"]')].map((el) => el.id);
        const targets = new Set([...document.querySelectorAll('#side [data-target]')].map((el) => el.dataset.target));
        const orphan = secIds.filter((id) => !targets.has(id));
        if (orphan.length) console.warn('[plugins] 主区分区无侧栏入口：', orphan);
      }
      if (state.page === 'settings' && state.settingsSection) {
        const target = $('#settings-section-' + state.settingsSection);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.querySelectorAll('[data-action="settings-nav"]').forEach(el => {
          // 用 class 而非 inline background（2026-09-06）：active 高亮走 .settings-nav-item.active
          el.classList.toggle('active', el.dataset.id === state.settingsSection);
        });
      } else if (state.page === 'settings') {
        // 首次进入设置页未选分区：高亮第一项（模型）
        document.querySelectorAll('[data-action="settings-nav"]').forEach(el => {
          el.classList.toggle('active', el.dataset.id === 'model');
        });
      }
      const sc = $('#msgScroll'); if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (err) {
      console.error('[render] ERROR:', err);
      // R2-9：err.stack 可能携带用户文本（会话标题 / prompt 片段），原样拼 innerHTML
      // 会把 HTML 注进错误页。同函数的未知页分支（下方）本来就走 esc()，此处口径不一致。
      $('#main').innerHTML = '<div style="color:#EF4444;padding:40px;font-family:monospace"><b>渲染错误</b><pre>' + esc((err && err.stack) || String(err)) + '</pre></div>';
    }
  }

  function updateMsgList() {
    const list = $('#msgList');
    const s = (state.page === 'session' && state.sel) ? state.sessions[state.sel] : null;
    if (!list || !s) { render(); return; }
    list.innerHTML = buildMsgListHtml(s);
    hardenActions(list);
    const sc = $('#msgScroll'); if (sc) sc.scrollTop = sc.scrollHeight;
  }

  /* ---------- P1 键盘可达（/harden，2026-09-06） ----------
   * 在委托层为 div[data-action] 统一补无障碍属性，取代「逐个补」——
   * 逐个补会在每次新增交互元素时漏一个（此前全项目 tabindex=0 即是证据）。
   * 只处理没有原生交互语义的标签（div/span/li），button/input/select 本身可聚焦。
   * 键盘触发（Enter/Space）由 body 级 keydown 委托统一接管（见 init 末尾）。 */
  /* ---------- 技能市场搜索过滤（2026-09-06）----------
   * 与插件搜索同套路：运行时不触发 render（保输入焦点），按 #skillSearch 词
   * 切换表格行可见性并更新命中计数。词来自 <input>，不做 DOM 重建。 */
  function skillSearchFilter() {
    const inp = $('#skillSearch');
    if (!inp) return;
    const q = inp.value.trim().toLowerCase();
    const rows = document.querySelectorAll('tr[data-skill-search]');
    let shown = 0;
    rows.forEach((r) => {
      const hit = !q || (r.dataset.skillSearch || '').includes(q);
      r.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    const cnt = $('#skillSearchCount');
    if (cnt) cnt.textContent = q ? `命中 ${shown}/${rows.length}` : '';
  }

  function hardenActions(root) {
    if (!root) return;
    root.querySelectorAll('[data-action]').forEach((el) => {
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'A' || tag === 'TEXTAREA') return;
      if (el.hasAttribute('role')) return;   // 已显式给过 role（如 .switch 的 role="switch"）不覆盖
      if (el.closest('[role="menu"]')) return; // 菜单项键盘由方向键/Enter 处理，不强制 tab
      el.setAttribute('role', 'button');
      if (el.hasAttribute('tabindex')) return; // 已显式给过（编辑器输入等）不抢
      el.tabIndex = 0;
    });
  }

  /* ---------- 插件页搜索过滤（2026-09-06） ----------
   * 在运行时按 #plugSearch 词隐藏/显示内置插件卡片，并更新命中计数。
   * 不清空 #plugSearch（input 里的词是用户正在输入的焦点所在），只改卡片可见性，
   * 所以不触发 render()，不丢焦点。空词 = 全部显示。 */
  function plugSearchFilter() {
    const inp = $('#plugSearch');
    if (!inp) return;
    const q = inp.value.trim().toLowerCase();
    state.plugSearch = inp.value; // 供「切走再切回」保留词（render 会回填 value）
    const cards = document.querySelectorAll('.plug[data-pid]');
    let shown = 0;
    cards.forEach((c) => {
      const hit = !q || (c.dataset.search || '').includes(q);
      c.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    const cnt = $('#plugSearchCount');
    if (cnt) cnt.textContent = q ? `命中 ${shown}/${cards.length}` : '';
    const empty = $('#plugSearchEmpty');
    if (empty) empty.style.display = (q && shown === 0) ? 'block' : 'none';
  }

  function updateTraceUi() {
    const sw = $('#trace-switch');
    if (sw) sw.classList.toggle('on', state.traceEnabled);
    const desc = $('#trace-desc');
    // BUG-036：这一支原文承诺把脱敏字段上报到另一个产品的公开仓库，而 trace 已按 SPEC
    // 删除清单卸下且不迁移，主进程 orchdesk:trace-* 一律返回不可用。开关打开时这句话
    // 就会显示给用户：既承诺了一件不发生的事，又把目标指向别的产品的仓库。
    if (desc) desc.textContent = state.traceBuiltin
      ? (state.traceEnabled
        ? '已勾选，但上报未启用：trace 随 dsh 卸下且不迁移，本壳不向任何仓库上报'
        : '已关闭——本壳不上传遥测，反馈也不落任何远端')
      : '未启用：trace 随 dsh 卸下且不迁移，本壳不向任何仓库上报';
  }

  function toast(msg, type = '') {
    const root = $('#toastRoot');
    // 堆叠上限 3 条：多行摘要（check-updates / import-data 等）连续触发时
    // 旧 toast 会让新 toast 挤出视口。屏读经 toastRoot 的 aria-live 播报。
    while (root.children.length >= 3) root.firstElementChild.remove();
    const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
    root.appendChild(t);
    // 退出与进入同为 200ms。到点先加 leaving，动画结束后再摘除，避免瞬切。
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 200);
    }, 3000);
  }

  /* ---------- Markdown 渲染器（基于 marked.js） ---------- */
  // M-3：marked 产物的 HTML 消毒。历史实现是正则白名单过滤——`\b` 边界使
  // `<a/href="…">` 之类畸形标签逃过转义，属性注入可绕过（当时只有 CSP 单点防御）。
  // 现改为 DOMPurify 真解析器消毒 + 显式标签/属性白名单；DOMPurify 加载失败时
  // 退化为「全量转义」（宁可显示纯文本，不冒 XSS 风险）。
  function renderMD(md) {
    if (!md) return '';
    let raw;
    try {
      raw = typeof marked !== 'undefined' ? marked.parse(md, { gfm: true, breaks: false }) : esc(md);
    } catch {
      return esc(md);
    }
    try {
      if (typeof DOMPurify === 'undefined' || !DOMPurify.sanitize) return esc(raw);
      return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: ['pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'ul', 'ol', 'li', 'p', 'br', 'strong', 'b', 'em', 'i', 'a', 'blockquote',
          'table', 'thead', 'tbody', 'tr', 'td', 'th', 'sup', 'sub', 'hr', 'del', 's', 'strike',
          'span', 'div', 'details', 'summary'],
        ALLOWED_ATTR: ['href', 'title', 'class'],
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: ['style', 'script', 'form', 'input'],
        FORBID_ATTR: ['style', 'srcset', 'onerror', 'onload', 'onclick'],
      });
    } catch {
      return esc(raw);
    }
  }

  function openProductPreview(name, content, lang) {
    const body = document.createElement('div');
    body.className = 'ctx-preview-overlay';
    body.innerHTML = `<div class="ctx-preview-card">
      <div class="ctx-preview-head">
        <span class="ph-title">${esc(name)}${lang ? ' <span class="faint" style="font-weight:400;font-size:11px">' + esc(lang) + '</span>' : ''}</span>
        <button class="ctx-preview-close" data-action="preview-close">✕</button>
      </div>
      <div class="ctx-preview-body">${renderMD(content)}</div>
    </div>`;
    document.body.appendChild(body);
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="preview-close"]') || e.target === body) body.remove();
    });
  }
  let _modalReturnFocus = null;
  function openModal(html) {
    _modalReturnFocus = document.activeElement;
    $('#modalRoot').innerHTML = `<div class="overlay" data-action="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    // P1 键盘可达（/audit）：开模态即把焦点移入对话框，Tab 在模态内循环，关闭后
    // 焦点还给触发元素。此前模态对键盘用户是陷阱——无初始焦点、不能 ESC 关。
    const modal = $('#modalRoot').querySelector('.modal');
    if (!modal) return;
    const focusables = () => [...modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    const first = focusables()[0];
    if (first) first.focus();
    modal.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Tab') return;
      const items = focusables(); if (!items.length) return;
      const idx = items.indexOf(document.activeElement);
      if (ev.shiftKey && idx <= 0) { ev.preventDefault(); items[items.length - 1].focus(); }
      else if (!ev.shiftKey && (idx === -1 || idx === items.length - 1)) { ev.preventDefault(); items[0].focus(); }
    });
  }
  function closeModal() {
    $('#modalRoot').innerHTML = '';
    // 焦点还给触发元素，避免键盘用户被弹回文档头
    if (_modalReturnFocus && _modalReturnFocus.isConnected) { try { _modalReturnFocus.focus(); } catch { /* ignore */ } }
    _modalReturnFocus = null;
  }

  function openMenu(anchor, items) {
    $('#menuRoot').innerHTML = '';
    const r = anchor.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.style.top = (r.bottom + 4) + 'px';
    pop.style.left = (r.right - 180) + 'px';
    pop.innerHTML = items.map((it) => `<div class="mi ${it.danger ? 'danger' : ''}" data-action="menu-item" data-id="${it.id || ''}">${it.svg ? `<span>${it.svg}</span>` : ''}<span>${it.label}</span></div>`).join('');
    $('#menuRoot').appendChild(pop);
    // 不用 {once:true}（与导航抽屉同一个坑）：菜单里点了「不关菜单」的项后，
    // once 监听已被该次点击消耗，再点菜单外将永远关不掉。改为常驻监听 + 自判自摘。
    setTimeout(() => {
      document.addEventListener('click', function close(ev) {
        if (!$('#menuRoot').innerHTML) { document.removeEventListener('click', close); return; }
        if (!ev.target.closest('.pop')) { $('#menuRoot').innerHTML = ''; document.removeEventListener('click', close); }
      });
    }, 0);
  }

  // R2-1：导航抽屉随汉堡菜单一并删除（commit 6dbf8e7）——全仓已无
  // [data-action="nav-drawer"] 触发元素，navDrawerHTML / toggleNavDrawer /
  // closeNavDrawer 与 #navDrawerRoot、.nav-drawer CSS 全是不可达死码。
  function openInspectorForTurn() {
    if (state.ctxOpen) return;
    state.ctxOpen = true;
    state.ctxAutoOpened = true;
    $('#appGrid')?.classList.add('has-ctx');
    const ctxEl = $('#context');
    if (ctxEl && state.page === 'session') {
      ctxEl.innerHTML = VIEWS.session.ctx();
      hardenActions(ctxEl);
    }
  }
  function scheduleCtxAutoClose() {
    if (!state.ctxAutoOpened || state.ctxAutoToggled) return;
    setTimeout(() => {
      if (state.turnBusy || state.ctxAutoToggled || !state.ctxOpen || state.pendingConfirm) return;
      state.ctxOpen = false;
      state.ctxAutoOpened = false;
      $('#appGrid')?.classList.remove('has-ctx');
    }, 5000);
  }
  function revealInspector() {
    state.ctxOpen = true;
    $('#appGrid')?.classList.add('has-ctx');
    const ctxEl = $('#context');
    if (ctxEl && state.page === 'session') {
      ctxEl.innerHTML = VIEWS.session.ctx();
      hardenActions(ctxEl);
    }

  }
  /* ---------- 会话工作区（BUG-023）：项目绑定目录 → 会话默认 cwd ---------- */
  // 主进程 sessionCwds 是进程内 Map（重启即失），所以「创建会话 / 打开会话 /
  // 重选项目 / 分叉」每次都要重放一次；无绑定或任务模式跳过（不误设）。
  // 失败必须可见（toast），不许静默——静默会让工作区悄悄回落 user home，
  // Agent 又在 C:\Users\my 里找 git 仓库，正是本 BUG 的形态。
  function projectPathOf(sid) {
    const s = state.sessions[sid];
    if (!s || !s.pid || s.pid === '__task__') return '';
    const p = state.projects.find((x) => x.id === s.pid);
    return p ? String(p.path || '').trim() : '';
  }

  /* P1.4：选择隐式工作目录（轻会话默认 cwd；欢迎页 chip 调用） */
  async function pickWorkspace() {
    try {
      const r = await bridge.pickFolder();
      if (r && r.ok && r.path) {
        saveWorkspaceDir(r.path);
        const cur = state.sessions[state.sel];
        // R2-7：项目绑定会话的 chip 显示的是 projectPathOf（只读绑定目录），此前
        // 「更改」对它无效却照样 toast 成功——用户眼见 chip 毫无变化却收到成功提示，
        // 操作像被静默吞掉。现在按会话类型给不同的成功文案，说清这次改的是什么。
        const isProjectBound = !!(cur && cur.pid && cur.pid !== '__task__' && projectPathOf(cur.id));
        if (cur && !isProjectBound) {
          cur.cwd = r.path;
          applySessionCwd(cur.id);
        }
        render();
        toast(isProjectBound
          ? `新会话的默认工作目录已设置为：${r.path}（当前会话绑定项目，仍用项目目录）`
          : `工作目录已设置：${r.path}`, 'ok');
      }
    } catch {
      const selected = prompt('请输入工作目录路径：');
      if (selected) { saveWorkspaceDir(selected); render(); }
    }
  }

  async function applySessionCwd(sid) {
    // P1.4：项目绑定目录优先；轻会话回落会话级 cwd（隐式工作目录）
    const dir = projectPathOf(sid) || String((state.sessions[sid] && state.sessions[sid].cwd) || '').trim();
    if (!dir) return;
    try {
      const r = await bridge.setSessionCwd(sid, dir);
      if (!r || r.ok !== true) toast(`项目工作区未生效：${(r && r.reason) || '未知原因'}`, 'warn');
    } catch {
      toast('项目工作区未设置（桥不可用）', 'warn');
    }
  }

  function createSessionInProject(pid) {
    // P3 触发①：主动建项目会话 → 自动升级项目模式（用户手动切过则不打扰）

    const id = 's' + Date.now().toString(36);
    const p = state.projects.find((x) => x.id === pid);
    const s = { id, pid, title: '新会话', expert: expertList()[state.wzExpert] || expertList()[0], model: state.selectedModels[0] || '—', updated: '刚刚', ts: nowTime(), msgs: [] };
    state.sessions[id] = s;
    if (p && !p.sessions.includes(id)) p.sessions.push(id);
    state.pExpanded.add(pid);
    state.sel = id;
    state.selProjForComposer = pid;
    state.projDropdownOpen = false;
    persist(); render();
    applySessionCwd(id);
    const pName = p ? p.n : pid;
    toast(`已新建会话 → ${pName}`, 'ok');
  }

  /* ---------- 会话操作（真实落盘，经桥） ---------- */
  function findProjectOf(sid) { return state.projects.find((p) => p.sessions.includes(sid)); }
  function touch(s) { s.updated = '刚刚'; }

  function doNewConv() {
    state.newConvMode = true;
    state.sel = null;
    render();
  }

  function patchComposerSend(sending) {
    const btn = document.querySelector('.composer .right [data-action="send"], .composer .right [data-action="abort-send"]');
    if (!btn) return;
    if (sending) {
      btn.setAttribute('data-action', 'abort-send');
      btn.textContent = '停止';
      btn.classList.remove('primary');
    } else {
      btn.setAttribute('data-action', 'send');
      btn.textContent = '发送';
      btn.classList.add('primary');
    }
  }

  async function doAbortSend() {
    const sid = state.turnBusy;
    if (!sid) return;
    // P2 演示模式没有主进程回合可停：直接清忙态，runDemoTurn 的循环守卫随即退出。
    if (state.demoMode) {
      state.turnStopped = { id: sid, at: Date.now() };
      state.turnBusy = null;
      patchComposerSend(false);
      updateMsgList();
      toast('已停止演示回合', 'warn');
      return;
    }
    if (typeof bridge.abortAgentTurn !== 'function') {
      toast('当前运行时不支持停止', 'warn');
      return;
    }
    try {
      await bridge.abortAgentTurn(sid);
    } catch (err) {
      toast('停止失败', 'danger');
    }
  }

  /* P2 演示模式（spec §5.3）：无真模型时的 echo Agent。
     目的只有一个：让用户在不配置任何 KEY 的情况下把 OrchDesk 的界面逛完（右栏
     任务监控、侧栏分组、快捷入口…）。回复明确自证是回显，不伪造模型能力；
     工具步骤走与真回合同一套 state.toolSteps 通道，右栏因此有东西可看。 */
  async function runDemoTurn(s, text, typingIdx) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 侧栏会话行如实标注。不调 render()——回合中整页重建会把 composer 的「停止」
    // 状态打回「发送」（updateMsgList 的存在意义就是不重建这两块）。
    s.model = '演示模式';
    // 但 chip 必须立刻翻到「演示模式」：doSend 只改了 state.demoMode，不重渲染的话
    // 整个回合 UI 都停在「未配置模型」——用户刚被告诉进了演示模式，眼前却是旧态。
    // 只换 chip 这一个按钮（原生 button，无 tabindex 要补，委托监听不受影响）。
    const chipEl = document.querySelector('.composer .c-mp');
    if (chipEl) chipEl.outerHTML = modelChipHTML();
    const plan = [
      { n: 'orch-plan', ph: 'running' },
      { n: 'orch-plan', ph: 'done', result: '演示：已解析输入（未调用任何模型）' },
      { n: 'workspace-scan', ph: 'running' },
      { n: 'workspace-scan', ph: 'done', result: '演示：已读取工作目录结构（本地模拟）' },
    ];
    try {
      for (const st of plan) {
        if (state.turnBusy !== s.id) return;   // 用户点了停止
        const list = state.toolSteps[s.id] = state.toolSteps[s.id] || [];
        const rec = [...list].reverse().find((x) => x.n === st.n && x.ph === 'running');
        if (rec && st.ph !== 'running') { rec.ph = st.ph; rec.result = st.result || ''; }
        else list.push({ n: st.n, ph: st.ph, result: st.result || '' });
        updateMsgList();
        refreshCtxLive();
        await sleep(300);
      }
      const echo = String(text || '').slice(0, 60);
      s.msgs[typingIdx] = {
        r: 'agent', t: nowTime(),
        x: `【演示模式 · 本地回显，未调用任何模型】\n\n收到你的输入：「${echo}」\n\n这一步是为了让你在配置模型之前就把 StepCode Desktop 全部界面逛完：\n· 右栏检查器随回合浮出，上面是这一回合的步骤\n· 侧栏按工作目录分组；输入栏可设默认工作目录\n· 分叉 / 回放 / 技能 / 终端 / 文件面板都可以直接点开看\n\n配置任意 OpenAI 兼容 API（或本机 Ollama）后，同样的输入会得到真实模型回复。点 composer 里的模型 chip 即可配置。`,
        // intent 用 'ACT'：renderMsg 只对 intent !== 'ACT' 挂徽标，且非 CONFIRM
        // 一律渲染成「意图 · 已拦截」——演示回复挂个拦截徽标是彻底的误告。
        intent: 'ACT', feedback: 1,
        // 形状与主进程 runAgentTurn 返回的 toolSteps 一致（{n, ph, result}）——
        // renderMsg/toolRow 读的是 t.n 与 t.ph，给错形状会渲染出空行与「undefined 步」。
        tools: plan.filter((x) => x.ph === 'done').map((x) => ({ n: x.n, ph: 'done', result: x.result })),
        steps: plan.filter((x) => x.ph === 'done').length,
      };
      updateMsgList();
      toast('演示回合完成 · 配置模型后即可获得真实回复', 'warn');
    } catch (err) {
      s.msgs[typingIdx] = { r: 'agent', t: nowTime(), x: '（演示回合异常：' + ((err && err.message) || err) + '）' };
      updateMsgList();
    } finally {
      if (state.turnBusy === s.id) state.turnBusy = null;
      patchComposerSend(false);
      // 回合结束整页刷新（与真回合路径同一处）：侧栏标题/待办/chip 终态一起落定。
      render();
      // P1.3 收梢：与真回合一致——仅自动浮出过的面板等 5s 自动收，用户手动调过则不关。
      // 放在这里而不是 doSend 的 finally：演示分支提前 return，那边的 finally 不会跑。
      scheduleCtxAutoClose();
    }
  }

  async function doSend() {
    const c = $('#composer'); if (!c) return;
    const text = c.value.trim();
    if (!text) { toast('输入为空', 'warn'); return; }
    if (state.turnBusy) { toast('请先停止当前生成，或等待完成', 'warn'); return; }
    if (state.selectedModels.length === 0) {
      // 配置可能在「设置 → 模型」刚更新过，或上一次 getModelConfig 请求失败，
      // 发送前再自动选择一次；仍为空才拦截（并给出可达的路径，而非死胡同）。
      autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel);
      if (state.selectedModels.length === 0 && !state.demoMode) {
        // P2 演示模式：两者皆无时不把用户堵死在设置页——进入 echo 演示，让全部 UI
        // 可逛；chip 常驻标注，配置真模型后立即退出。绝不写 selectedModels。
        state.demoMode = true;
        toast('未配置模型 · 已进入演示模式（回复为本地回显）', 'warn');
      }
    }
    const s = state.sessions[state.sel]; if (!s) return;
    const t = nowTime();
    s.msgs.push({ r: 'user', t, x: text }); touch(s);
    const typingIdx = s.msgs.push({ r: 'agent', t, x: '', typing: true }) - 1;
    // BUG（全盘死挂点扫描）：toolSteps 此前「有写入（onToolStep 订阅）无读取」=存而不显。
    // 新回合开始时清空本会话轨迹；回合中 renderMsg 的 typing 分支实时读它；回合结束把
    // runAgentTurn 返回的 tools/steps 静态写入该条 agent 消息（renderMsg 的「N 步 · M 个
    // 动作」展示形态随即生效）。
    state.toolSteps[s.id] = [];
    state.turnBusy = s.id;
    if (state.turnStopped && state.turnStopped.id === s.id) state.turnStopped = null;
    if (state.turnDone && state.turnDone.id === s.id) state.turnDone = null;
    // P1.3：轻模式回合开始自动浮出任务监控（project 态常驻）。
    // 语义与 spec「回合中浮出 / 结束 5s 收起 / 用户可钉住」对齐：
    //   · ctxAutoOpened = 本回合由自动浮出打开 → 才参与结束 5s 后的自动收起；
    //   · 用户空闲时手动展开 = 钉住：不自动开（已开）也不自动收（见 finally 分支）；
    //   · ctxAutoToggled = 本回合手动调过 → 仅本回合接管，下回合重置（否则一旦手动
    //     收起就再也浮不出，与「回合中浮出」的产品承诺相悖）。
    state.ctxAutoToggled = false;
    // 演示回合与真回合同一套浮出/收梢语义：ctxAutoOpened 在此置位，收梢在
    // runDemoTurn 的 finally 里统一安排（否则演示回合的面板永远不收）。
    openInspectorForTurn();
    c.value = '';
    updateMsgList();
    patchComposerSend(true);
    if (state.demoMode && state.selectedModels.length === 0) { await runDemoTurn(s, text, typingIdx); return; }
    try {
      const res = await bridge.runAgentTurn(s.id, text, { models: state.selectedModels, thinkLevel: state.thinkLevel });
      const tsteps = (res && Array.isArray(res.tools) && res.tools.length) ? res.tools : undefined;
      s.msgs[typingIdx] = {
        r: 'agent', t: nowTime(), x: res.text, intent: res.intent || 'ACT', feedback: 1,
        tools: tsteps,
        steps: tsteps ? tsteps.length : (Number(res && res.steps) || undefined),
      };
      touch(s); persist();
      updateMsgList();
      render(); // 回合结束刷新侧栏标题/待办；工具步骤过程中不走全页 render
      // typing 消息已被静态消息替换（tools 已随消息落库展示），live 轨迹不再需要
      delete state.toolSteps[s.id];
      if (!(res && res.aborted)) state.turnDone = { id: s.id, at: Date.now() };
      if (res && res.aborted) {
        state.turnStopped = { id: s.id, at: Date.now() };
        toast('已停止生成', 'warn');
      }
      // BUG-040：主进程 run-agent-turn 把 opts（models / thinkLevel）整个丢弃——
      // step-session.ts 只按 GUI 配置的默认提供商/模型跑一回合。原 toast 声称
      // 「N 模型 · 思维 X」，是把没发生的事报成发生了（铁律：UI 不得声称未提供的行为）。
      else toast('回合完成 · 已写入会话日志', 'ok');
    } catch (err) {
      s.msgs[typingIdx] = { r: 'agent', t: nowTime(), x: '（模型回合失败：' + (err && err.message ? err.message : err) + '）' };
      delete state.toolSteps[s.id];
      updateMsgList();
      toast('模型回合失败', 'danger');
    } finally {
      if (state.turnBusy === s.id) state.turnBusy = null;
      patchComposerSend(false);
      // P1.3：回合结束 5s 后自动收起任务监控（仅自动开过的面板；用户手动调过则不关）
      scheduleCtxAutoClose();
      // P3 触发④：Agent 产出多步计划 → 自动升级项目模式（任务监控/编排可视化就位）。
      // 单步不算——一步就能干完的活不值得把用户搬去重形态。

    }
  }

  async function doRename(sid, title) {
    const s = state.sessions[sid]; if (!s) return;
    s.title = title || s.title; touch(s); persist(); render();
    toast(`已重命名为「${s.title}」`, 'ok');
  }

  /**
   * 会话分叉（PRD FR-6）。
   * @param sid     源会话
   * @param name    分支名
   * @param atIndex 分叉点：继承前 atIndex 条消息（缺省 = 全部继承）。
   *                旧实现恒深拷贝全部消息，没有真正的「分叉点」概念。
   */
  async function doFork(sid, name, atIndex) {
    const src = state.sessions[sid];
    if (!src) return;
    if (!FORK) { toast('分叉模块未加载（session-fork.js 缺失）', 'err'); return; }
    const srcMsgs = Array.isArray(src.msgs) ? src.msgs : [];
    const id = 's' + Date.now().toString(36);
    const s = deepClone(src);
    const pid = src.pid && src.pid !== '__task__' ? src.pid : (state.projects.find((p) => !p.archived) || {}).id || '__task__';
    // 分叉点：由 FORK.makeForkLineage 夹到 [0, srcMsgs.length]，消息切片用同一个
    // idx，保证「血缘记录的分叉点」与「实际继承的条数」永远一致。
    const idx = FORK.makeForkLineage(src, Number(atIndex)).atIndex;
    s.id = id;
    s.title = name || ('分支-' + (src.title || sid));
    s.pid = pid;
    s.updated = '刚刚';
    // 血缘：from + 分叉点 + 源标题快照（源被删后仍可读）
    s.fork = FORK.makeForkLineage(src, idx);
    delete s.forkedFrom; delete s.forkedAt;
    // 只继承分叉点之前的消息。必须从 s.msgs（deepClone 产物）里切，不能从
    // src.msgs 切 —— 后者元素仍是源会话的对象引用，分支与源会共享消息对象。
    s.msgs = FORK.forkMessages(s.msgs, idx);
    state.sessions[id] = s;
    const proj = state.projects.find((p) => p.id === pid);
    if (proj && !proj.sessions.includes(id)) proj.sessions.unshift(id);
    state.sel = id; state.replayFor = null; persist(); render();
    applySessionCwd(id);
    // FR-6（ADR-0009）：分叉落事件——子日志只写一条 fork-origin 血缘，不拷贝父事件。
    // 写失败不回滚分叉（sessions.json 仍是运行态事实源），只如实提示。
    bridge.appendForkEvent({ newId: id, from: sid, fromTitle: src.title || sid, atIndex: idx, at: (s.fork && s.fork.at) || Date.now() })
      .then((r) => { if (!r || r.ok !== true) toast('事件流未记录分叉血缘' + (r && r.reason ? '：' + r.reason : ''), 'warn'); })
      .catch(() => toast('事件流未接入，分叉血缘未记录', 'warn'));
    toast(idx >= srcMsgs.length
      ? '已创建分支（继承全部消息，独立写入）'
      : `已从第 ${idx} 条消息处分叉（继承前 ${idx} 条）`, 'ok');
  }

  async function doDeleteSession(sid) {
    const from = findProjectOf(sid);
    if (from) from.sessions = from.sessions.filter((x) => x !== sid);
    delete state.sessions[sid];
    if (state.sel === sid) {
      state.sel = Object.keys(state.sessions)[0] || null;
    }
    persist(); render();
    toast(`会话 #${sid} 已删除`, 'warn');
  }

  async function doArchiveSession(sid) {
    const s = state.sessions[sid]; if (!s) return;
    const from = findProjectOf(sid);
    if (from) from.sessions = from.sessions.filter((x) => x !== sid);
    // R5-05：首跑用户从欢迎页发消息会创建 __task__ 会话且不创建任何项目，此时
    // state.projects 为 []——原来无条件访问 state.projects[0].sessions[0] 必抛
    // TypeError，归档按钮在该路径上直接坏掉，且 persist 已执行、状态半生效。
    // 兜底也不能再硬编码找 'p3'（那是种子数据的 id，真实首跑环境不存在）。
    // 归档目标统一为「已归档」虚拟容器，与 doArchiveProject 同一口径：找不到就建，
    // 不再借道任意 archived===1 的项目（那会把会话塞进一个已归档的真实项目里）。
    let arc = state.projects.find((p) => p.id === '__archived__');
    if (!arc) {
      arc = { id: '__archived__', n: '已归档', d: '', open: 0, archived: 1, sessions: [] };
      state.projects.push(arc);
    }
    if (arc && !arc.sessions.includes(sid)) arc.sessions.unshift(sid);
    s.pid = arc ? arc.id : s.pid; s.archived = 1;
    if (state.sel === sid) {
      const firstProject = state.projects[0];
      state.sel = (firstProject && firstProject.sessions[0]) || sid;
    }
    persist(); render();
    toast(`会话「${s.title}」已归档`, 'warn');
  }

  async function doArchiveProject(pid) {
    const p = state.projects.find((x) => x.id === pid); if (!p) return;
    // 将所有归档会话统一归入"已归档"虚拟容器
    let arch = state.projects.find((x) => x.id === '__archived__');
    if (!arch) {
      arch = { id: '__archived__', n: '已归档', d: '', open: 0, archived: 1, sessions: [] };
      state.projects.push(arch);
    }
    // 将项目内所有会话移入归档容器
    p.sessions.forEach((sid) => {
      if (!arch.sessions.includes(sid)) arch.sessions.push(sid);
      const s = state.sessions[sid]; if (s) { s.pid = arch.id; s.archived = 1; }
    });
    p.sessions = [];
    p.archived = 1; p.open = 0;
    state.pExpanded.delete(pid);
    state.pExpanded.add('__archived__');
    persist(); render();
    toast(`项目「${p.n}」已归档`, 'warn');
  }

  /* ---------- 授权模式选择（T-P3-2） ---------- */
  // 完全信任会在失败后续跑，切换前确认。这不是第三档，也不放宽危险命令。
  const MODE_RANK = { bypass: 0, autopilot: 1 };
  function confirmSwitchAuth(target) {
    const targetSpec = authModesForRender().find((m) => m.id === target);
    const currentRank = Object.prototype.hasOwnProperty.call(MODE_RANK, state.authMode) ? MODE_RANK[state.authMode] : 0;
    // 目标档未入表时不当成 1 放行：未知档位一律视为更严，必须先确认。
    const targetRank = MODE_RANK[target];
    const loosening = typeof targetRank === 'number' && targetRank > currentRank;
    openModal(`<div class="mh ${loosening ? 'danger' : ''}">${ic('shield', 18)}<b>切换授权模式到「${targetSpec ? targetSpec.label : target}」？</b></div>
      <div class="mb">
        <div>${targetSpec ? targetSpec.blurb : ''}</div>
        ${loosening ? `<div class="warn-list" style="margin-top:10px">
          <div>· 完全信任会在模型短暂失败后续跑</div>
          <div>· 危险命令仍由本界面确认，不会改成自动放行</div>
          <div>· 只对本次运行生效，重启回到默认模式</div>
        </div>` : ''}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn ${loosening ? 'danger' : 'primary'}" data-action="auth-do-switch" data-id="${target}">确认切换</button>
      </div>`);
  }
  function openAuthPicker() {
    openModal(`<div class="mh">${ic('shield', 18)}<b>选择授权模式</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:10px">只有默认模式和完全信任。危险命令仍由本界面确认。</div>
        ${authModesForRender().map((m) => `<div class="row" style="padding:9px 10px;border:1px solid ${state.authMode === m.id ? 'var(--accent)' : 'var(--border)'};border-radius:8px;margin-bottom:7px;cursor:pointer" data-action="auth-mode-pick" data-id="${m.id}">
          <div style="flex:1"><b>${m.label}</b>${state.authMode === m.id ? ' <span class="badge ok">当前</span>' : ''}<div class="faint" style="font-size:11px;margin-top:3px">${m.blurb}</div></div>
          ${state.authMode === m.id ? '' : '<button class="btn sm">选择</button>'}
        </div>`).join('')}
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
  }

  /* ---------- 浏览器面板（ADR-0011：内置 CDP 浏览器） ---------- */
  // Agent 默认在**后台隐藏窗口**里操作网页（保留登录态、不打断用户），若没有面板
  // 就成了黑箱：用户既不知道它打开了哪个页面，也没法叫停。面板承担三件事：
  // 看现状（标题/地址/最近截图）、调出或收回窗口、一键关闭。
  function applyBrowserState(st) {
    if (!st || typeof st !== 'object') return;
    const prev = state.browser;
    state.browser = {
      loaded: true,
      open: !!st.open,
      url: st.url || '',
      title: st.title || '',
      visible: !!st.visible,
      lastShot: st.lastShot || null,
      lastError: st.lastError || '',
      shotsDir: st.shotsDir || prev.shotsDir || '',
      pages: Array.isArray(st.pages) ? st.pages.slice() : (prev.pages || []),
      activePageId: st.pages && st.pages.find((p) => p.active) ? st.pages.find((p) => p.active).id : (prev.activePageId || null),
    };
    // 需求3：Agent 一调用浏览器就自动展开侧栏（并顶替任务监控），用户不必去找开关。
    // 只在「从未打开 → 打开」这个跃迁上自动展开，避免用户手动收起后被每次状态推送弹回来。
    if (state.browser.open && !prev.open) state.browserSideOpen = true;
    // 浏览器关了（窗口收起/全关）→ 侧栏也跟着收起，任务监控自动回来
    if (!state.browser.open && prev.open) state.browserSideOpen = false;
    renderStatusBarActions();
    renderBrowserSide();
  }

  /**
   * 浏览器侧栏（需求3）：与任务监控共用第 4 列，展开时顶替任务监控。
   * 内容 = 页面快照 TAB 列表（底层是单隐藏 CDP 窗口，同一时刻只有一个活跃页面，
   * 卡片表达的是「Agent 先后访问过哪些页面」，不是多标签浏览器）。
   */
  function renderBrowserSide() {
    const host = $('#browserSide');
    if (!host) return;
    const app = $('#appGrid');
    if (app) app.classList.toggle('browser-mode', !!state.browserSideOpen);
    if (!state.browserSideOpen) { host.innerHTML = ''; return; }
    const b = state.browser;
    const pages = b.pages || [];
    const closeBtn = '<button class="bw-side-x" data-action="bw-side-close" title="收起侧栏（回到任务监控）">' + ic('x', 13) + '</button>';
    if (!b.loaded) {
      host.innerHTML = `<div class="bw-head">${ic('globe', 14)}<b>浏览器</b>${closeBtn}</div>`
        + '<div class="bw-empty">未接入主进程，浏览器状态不可用。</div>';
      return;
    }
    if (!pages.length) {
      host.innerHTML = `<div class="bw-head">${ic('globe', 14)}<b>浏览器</b>${closeBtn}</div>`
        + '<div class="bw-empty">浏览器未打开。<br><span style="font-size:11px">让 Agent 访问网页时会自动打开并在此登记页面</span></div>';
      return;
    }
    const tabsHTML = pages.map((p) => {
      const host2 = (() => { try { return new URL(p.url).hostname; } catch { return p.url; } })();
      return `<div class="bw-tab${p.active ? ' active' : ''}" data-action="bw-tab-focus" data-id="${esc(p.id)}" title="${esc(p.url)}">
        ${p.shot ? `<img class="bw-tab-shot" src="${esc(p.shot)}" alt="">` : `<div class="bw-tab-shot ph">${ic('image', 18)}</div>`}
        <div class="bw-tab-meta">
          <div class="bw-tab-title">${esc(p.title || host2 || '(无标题)')}</div>
          <div class="bw-tab-url">${esc(host2)}</div>
        </div>
        <button class="bw-tab-x" data-action="bw-tab-close" data-id="${esc(p.id)}" title="关闭这个页面">${ic('x', 12)}</button>
      </div>`;
    }).join('');
    host.innerHTML = `<div class="bw-head">${ic('globe', 14)}<b>浏览器</b>`
      + `<span class="badge${b.visible ? ' ok' : ''}">${b.visible ? '窗口已显示' : '后台运行'}</span>`
      + `<button class="btn sm ghost" data-action="${b.visible ? 'browser-hide' : 'browser-show'}">${b.visible ? '收回' : '显示'}</button>`
      + `<button class="btn sm ghost" data-action="bw-tab-clear" title="关闭全部页面">${ic('xAll', 12)}</button>`
      + closeBtn + `</div>`
      + `<div class="bw-tabs">${tabsHTML}</div>`
      + `<div class="bw-foot faint">单窗口模型：同一时刻只有一个活跃页面，卡片是 Agent 访问过的页面快照。点击卡片＝显示该页。</div>`;
  }

  /**
   * 状态栏右下角图标区：浏览器 / 终端。
   * 标题栏的三个文字按钮（浏览器/终端/文件）已下移：文件进右栏 TAB，
   * 浏览器与终端改为这里的图标——未激活灰、激活点亮，点击切换开关。
   * 只在首次建 DOM，之后仅改 class/title，避免频繁重绘丢焦点。
   */
  /** P4-S1-12：状态栏专家数按真实目录刷新（原为 index.html 里写死的「1 专家在线」）。 */
  function renderTrayHint() {
    const el = $('#trayText'); if (!el) return;
    const n = expertList().length;
    el.textContent = n > 0 ? `本地运行 · ${n} 位专家在线` : '本地运行';
  }

  function renderStatusBarActions() {
    const host = $('#sbActions');
    if (!host) return;
    const b = state.browser;
    const t = state.terminal;
    if (host.childElementCount !== 3) {
      host.innerHTML = `<button class="sb-icon" data-action="file-panel" id="fileBtn" title="文件"></button>`
        + `<button class="sb-icon" data-action="browser-panel" id="browserBtn"></button>`
        + `<button class="sb-icon" data-action="terminal-panel" id="terminalBtn"></button>`;
    }
    const fBtn = $('#fileBtn');
    if (fBtn) {
      fBtn.innerHTML = ic('fileText', 15);
      fBtn.classList.toggle('on', !!state.filePanelOpen);
      fBtn.title = state.filePanelOpen ? '收起文件' : '文件（当前工作目录）';
    }

    const bBtn = $('#browserBtn');
    const tBtn = $('#terminalBtn');
    if (bBtn) {
      const on = !!b.open;
      bBtn.innerHTML = ic('globe', 15);
      bBtn.classList.toggle('on', on);
      bBtn.classList.toggle('unavailable', !b.loaded);
      bBtn.title = !b.loaded ? '内置浏览器（未接入主进程）'
        : on ? `内置浏览器：${b.title || b.url || '已打开'}${b.visible ? '' : '（后台运行）'} · 点击${state.browserSideOpen ? '收起' : '展开'}侧栏`
          : '内置浏览器（未打开）· Agent 访问网页时自动显示';
    }
    if (tBtn) {
      const on = !!state.terminalPanelOpen;
      tBtn.innerHTML = ic('terminal', 15);
      tBtn.classList.toggle('on', on);
      tBtn.classList.toggle('unavailable', !(t && t.loaded));
      tBtn.title = !(t && t.loaded) ? '终端（未接入主进程）'
        : `${on ? '收起' : '展开'}终端${t.ptyAvailable ? '' : '（node-pty 不可用，管道模式降级）'}`;
    }
  }

  /** 兼容旧调用点：浏览器状态变化后刷新状态栏图标。 */
  function renderBrowserBadge() { renderStatusBarActions(); }

  function loadBrowserStatus() {
    if (typeof bridge.getBrowserStatus !== 'function') return Promise.resolve();
    return bridge.getBrowserStatus()
      .then((st) => { applyBrowserState(st); })
      .catch((err) => { console.warn('[browser] 状态拉取失败:', err && err.message); });
  }

  function browserPanelHTML() {
    const b = state.browser;
    if (!b.loaded) {
      return `<div class="mh">${ic('globe', 18)}<b>内置浏览器</b></div>
        <div class="mb"><div class="faint">未接入主进程，浏览器状态不可用。</div></div>
        <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`;
    }
    const shot = b.lastShot;
    const stateText = b.open ? (b.visible ? '已显示' : '后台运行') : '未打开';
    return `<div class="mh">${ic('globe', 18)}<b>内置浏览器</b><span class="bw-dot ${b.open ? 'on' : ''}"></span><span class="faint" style="font-size:11px">${stateText}</span></div>
      <div class="mb">
        ${b.open
    ? `<div class="bw-row"><span class="bw-k">标题</span><span class="bw-v">${esc(b.title || '(无)')}</span></div>
           <div class="bw-row"><span class="bw-k">地址</span><span class="bw-v bw-url">${esc(b.url || '(无)')}</span></div>`
    : `<div class="faint" style="padding:6px 0">浏览器未打开。让 Agent 访问网页时它会自动打开（也可直接说「打开 xxx 网站」）。</div>`}
        ${shot ? `<div class="bw-shot">
          <div class="bw-k" style="margin-bottom:6px">最近截图</div>
          ${shot.dataUrl ? `<img class="bw-img" src="${esc(shot.dataUrl)}" alt="页面截图">` : '<div class="faint">（本次截图无预览缩略图）</div>'}
          ${shot.path ? `<div class="bw-path" title="${esc(shot.path)}">${esc(shot.path)}</div>` : ''}
        </div>` : ''}
        ${b.lastError ? `<div class="bw-err">最近错误：${esc(b.lastError)}</div>` : ''}
        <div class="faint" style="font-size:11px;margin-top:10px">点击 / 输入 / 执行脚本会改变页面状态，需经授权确认；每次操作都记入沙箱日志。</div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="browser-shot-dir">截图目录</button>
        <span class="row" style="margin-left:auto">
          ${b.open ? (b.visible
    ? '<button class="btn sm" data-action="browser-hide">收回后台</button>'
    : '<button class="btn sm" data-action="browser-show">显示窗口</button>') : ''}
          <button class="btn sm ghost" data-action="browser-close" ${b.open ? '' : 'disabled'}>关闭浏览器</button>
          <button class="btn ghost" data-action="modal-cancel">关闭</button>
        </span>
      </div>`;
  }

  function openBrowserPanel() {
    state.browserPanelOpen = true;
    openModal(browserPanelHTML());
  }

  /** 面板打开时状态变化 → 重绘（用户在看面板，内容必须跟着实时变）。 */
  function rerenderBrowserPanelIfOpen() {
    if (state.browserPanelOpen && $('#modalRoot .bw-dot, #modalRoot .bw-shot, #modalRoot .mb')) {
      openModal(browserPanelHTML());
    }
  }

  async function browserAct(fn, okMsg) {
    try {
      const r = await fn();
      if (r && r.ok === false) { toast(r.reason || '操作失败', 'err'); return; }
      if (r && r.state) applyBrowserState(r.state);
      else await loadBrowserStatus();
      if (okMsg) toast(okMsg, 'ok');
    } catch (err) {
      toast(`浏览器操作失败：${(err && err.message) || err}`, 'err');
    }
    rerenderBrowserPanelIfOpen();
  }

  /* ---------- 终端面板（P2-10：node-pty 正路 + 管道模式显式降级） ---------- */
  // 终端是「用户亲手操作」的入口，与浏览器面板（观察 Agent）相反。
  // xterm 实例与滚动位置不能随状态推送重绘 —— 所以走全屏覆盖层 +
  // 「骨架只建一次，头部与可见性单独更新」，不走 modal 体系。
  const termHandles = new Map(); // id -> { cont, term, fit, pre }

  function xtermAvailable() { return typeof window !== 'undefined' && window.Terminal; }
  function fitAvailable() { return typeof window !== 'undefined' && window.FitAddon && window.FitAddon.FitAddon; }

  function ensureTermSkeleton() {
    const root = $('#terminalRoot');
    if (root.dataset.ready) return;
    root.innerHTML = '<div class="fp-head" id="termHead"></div><div class="term-body" id="termBody"></div>';
    root.dataset.ready = '1';
  }

  function openTerminalPanel() {
    state.terminalPanelOpen = true;
    $('#terminalRoot').classList.remove('hidden');
    ensureTermSkeleton();
    refreshTerminal();
    renderStatusBarActions();   // 右下角终端图标点亮
  }

  function closeTerminalPanel() {
    state.terminalPanelOpen = false;
    state.termFull = false;
    const root = $('#terminalRoot');
    root.classList.add('hidden');
    root.classList.remove('full');
    renderStatusBarActions();
  }

  /** 抽屉全屏 / 还原（需求3）：全屏时主区自动收缩，不遮挡任何内容。 */
  function toggleTermFull() {
    state.termFull = !state.termFull;
    $('#terminalRoot').classList.toggle('full', state.termFull);
    renderTerminalPanel();
    // 高度变了，xterm 必须重新 fit，否则内容被裁或留白
    for (const [, h] of termHandles) { if (h.fit) { try { h.fit.fit(); } catch { /* 隐藏中 */ } } }
  }

  function terminalShortcutLabel() {
    return state.terminal.ptyAvailable ? 'PTY' : '管道模式';
  }

  async function refreshTerminal() {
    if (typeof bridge.terminalStatus !== 'function') {
      state.terminal.loaded = false;
      renderTerminalPanel();
      return;
    }
    try {
      const st = await bridge.terminalStatus();
      if (!st || typeof st !== 'object') {
        state.terminal.loaded = false;
      } else {
        state.terminal.loaded = true;
        state.terminal.ptyAvailable = !!st.ptyAvailable;
        state.terminal.via = st.via || 'pipe';
        const ids = new Set((st.sessions || []).map((s) => s.id));
        for (const id of [...termHandles.keys()]) if (!ids.has(id)) disposeTerm(id);
        (st.sessions || []).forEach((s) => { if (!termHandles.has(s.id)) attachTerm(s); });
        state.terminal.sessions = st.sessions || [];
        if (!state.terminal.activeId || !ids.has(state.terminal.activeId)) {
          state.terminal.activeId = state.terminal.sessions.length
            ? state.terminal.sessions[state.terminal.sessions.length - 1].id
            : null;
        }
      }
    } catch (err) {
      state.terminal.loaded = false;
    }
    renderTerminalPanel();
  }

  function attachTerm(s) {
    const body = $('#termBody');
    if (!body) return;
    const cont = document.createElement('div');
    cont.className = 'term-container';
    cont.dataset.tid = s.id;
    body.appendChild(cont);
    const rec = { cont, term: null, fit: null, pre: null };
    termHandles.set(s.id, rec);
    if (xtermAvailable()) {
      const term = new window.Terminal({
        cursorBlink: true, fontSize: 12, scrollback: 5000,
        fontFamily: 'Consolas, "Courier New", monospace',
        theme: { background: '#161622', foreground: '#e6e6f0', cursor: '#a78bfa' },
      });
      rec.term = term;
      if (fitAvailable()) {
        rec.fit = new window.FitAddon.FitAddon();
        term.loadAddon(rec.fit);
      }
      term.open(cont);
      if (rec.fit) { try { rec.fit.fit(); } catch { /* 尺寸为 0 时静默（面板还藏着） */ } }
      term.onResize(({ cols, rows }) => { bridge.terminalResize(s.id, cols, rows); });
      term.onData((d) => { bridge.terminalWrite(s.id, d); });
      if (s.replay) term.write(s.replay);
    } else {
      // 降级（可见）：xterm 缺失 → 只读回放 + 逐行输入，不冒充完整交互终端
      cont.innerHTML = '<div class="term-degrade">xterm 未加载：已降级为逐行输入模式（输出照常显示，方向键/交互式程序不可用）</div>'
        + '<pre class="term-pre"></pre>'
        + '<div class="term-fb-row"><span class="term-fb-ps">$</span><input type="text" class="term-fb-input" placeholder="输入命令后回车发送"></div>';
      rec.pre = cont.querySelector('.term-pre');
      if (s.replay) rec.pre.textContent = s.replay;
      const inp = cont.querySelector('.term-fb-input');
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && inp.value) {
          bridge.terminalWrite(s.id, inp.value + '\r');
          inp.value = '';
        }
      });
    }
  }

  function disposeTerm(id) {
    const h = termHandles.get(id);
    if (!h) return;
    if (h.term) { try { h.term.dispose(); } catch { /* 已销毁 */ } }
    h.cont.remove();
    termHandles.delete(id);
  }

  function showTermEmpty(text) {
    const body = $('#termBody');
    if (!body) return;
    let empty = body.querySelector('.term-empty');
    if (!text) { if (empty) empty.remove(); return; }
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'term-empty';
      body.appendChild(empty);
    }
    empty.innerHTML = text;
  }

  // R5-17：终端会话上限的渲染层副本。权威值在 terminal-tools.ts 的 TERMINAL_MAX_SESSIONS
  // （渲染层不许 import 主进程模块，arch-guard R17 机械校验两份一致，防漂移）。
  // 原来这里内联裸 6，主进程改上限时按钮的禁用态不会跟着变。
  const TERMINAL_MAX_SESSIONS = 6;

  function renderTerminalPanel() {
    if (!$('#terminalRoot').dataset.ready) return;
    const t = state.terminal;
    const head = $('#termHead');
    const closeBtn = '<button class="btn ghost sm" data-action="term-close">关闭</button>';
    // 需求3：抽屉全屏档位。全屏时上方主区（flex:1）自动收缩，不是盖住它。
    const fullBtn = `<button class="btn ghost sm" data-action="term-full" title="${state.termFull ? '还原高度' : '展开到全屏（上方空间自动收缩）'}">${state.termFull ? '还原' : '全屏'}</button>`;
    if (!t.loaded) {
      head.innerHTML = `<b>终端</b><span class="faint">未接入主进程</span><span style="margin-left:auto"></span>${fullBtn}${closeBtn}`;
      showTermEmpty('<div class="faint">主进程未接入终端服务（桥不可用）。</div>');
      return;
    }
    const tabs = t.sessions.map((s) => {
      const name = (s.shell || 'shell').split(/[\\/]/).pop();
      return `<button class="term-tab${s.id === t.activeId ? ' on' : ''}" data-action="term-tab" data-id="${s.id}" title="${esc(s.cwd)}（PID ${s.pid} · ${s.via === 'pty' ? 'PTY' : '管道'}）">${esc(name)}${s.exited ? '（已退出）' : ''}<span class="term-tab-x" data-action="term-tab-close" data-id="${s.id}" title="结束该会话">×</span></button>`;
    }).join('');
    head.innerHTML = `<b>终端</b>
      <span class="badge${t.ptyAvailable ? '' : ' warn'}" title="${t.ptyAvailable ? 'node-pty 已加载（真 PTY）' : 'node-pty 不可用：已降级为管道模式（交互式程序受限）'}">${terminalShortcutLabel()}</span>
      <span class="row" style="margin-left:10px">${tabs}</span>
      <button class="btn sm ghost" data-action="term-new" ${t.sessions.length >= TERMINAL_MAX_SESSIONS ? `disabled title="已达会话上限（${TERMINAL_MAX_SESSIONS}）"` : ''}>+ 新建</button>
      <span style="margin-left:auto"></span>${fullBtn}${closeBtn}`;
    if (!t.sessions.length) {
      showTermEmpty('<div class="faint">没有打开的终端。点「+ 新建」开一个。</div>');
      return;
    }
    showTermEmpty('');
    for (const [id, h] of termHandles) h.cont.classList.toggle('hidden', id !== t.activeId);
    const active = termHandles.get(t.activeId);
    if (active) {
      if (active.fit) { try { active.fit.fit(); } catch { /* 隐藏中 */ } }
      if (active.term) active.term.focus();
    }
  }

  async function newTerminalSession() {
    // BUG-023：终端落在当前会话的工作目录里（项目绑定目录 > 轻模式隐式 cwd）。
    // P4-S5-2：原实现只认项目绑定目录，轻模式会话的终端静默落到主进程 cwd，与 Agent
    // 实际干活的目录不一致。目录不存在时主进程会自行回落，不用这里兜底。
    const wsDir = fileTabRootDir();
    const r = await bridge.terminalCreate(wsDir ? { cwd: wsDir } : {});
    if (!r || r.ok === false) {
      toast(`创建终端失败：${(r && r.reason) || '未接入'}`, 'err');
      return;
    }
    await refreshTerminal();
    if (r.session && r.session.via === 'pipe') {
      toast('node-pty 不可用，已降级为管道模式（交互式程序受限）', 'warn');
    }
  }

  /* ---------- 文件面板（P2-11：只读浏览 + shiki 高亮，编辑后置） ---------- */
  const FILE_SHIKI_LANGS = ['typescript', 'javascript', 'json', 'markdown', 'css', 'html', 'python', 'bash', 'yaml', 'go', 'rust', 'sql'];
  // 语法高亮体积门槛（实测基准见 renderFileView 注释）：200KB ≈ 高亮耗时 ~1s。
  const FILE_SHIKI_MAX_CHARS = 200 * 1024;
  const FILE_SHIKI_MAX_LINES = 3000;

  function ensureFileSkeleton() {
    const root = $('#fileRoot');
    if (root.dataset.ready) return;
    root.innerHTML = '<div class="fp-head" id="fileHead"></div>'
      + '<div class="file-body"><div class="file-tree" id="fileTree"></div><div class="file-view" id="fileView"></div></div>';
    root.dataset.ready = '1';
  }

  function openFilePanel() {
    state.filePanelOpen = true;
    $('#fileRoot').classList.remove('hidden');
    ensureFileSkeleton();
    const fp = state.filePanel;
    if (!fp.userPicked) {
      const bound = fileTabRootDir() || String(state.workspaceDir || '').trim();
      if (bound && fp.root !== bound) {
        fp.root = bound;
        fp.expanded = new Set();
        fp.children = new Map();
        fp.loaded = false;
        fp.preview = null;
        fp.previewPath = '';
        loadFileDir(bound);
      }
    }
    renderFilePanel();
  }

  function closeFilePanel() {
    state.filePanelOpen = false;
    $('#fileRoot').classList.add('hidden');
  }

  async function pickFileRoot() {
    const r = await bridge.pickFolder();
    if (r && r.ok && r.path) {
      state.filePanel.userPicked = true;
      state.filePanel.root = r.path;
      state.filePanel.expanded = new Set();
      state.filePanel.children = new Map();
      state.filePanel.preview = null;
      state.filePanel.previewPath = '';
      await loadFileDir(r.path);
    } else if (r && r.ok === false) {
      toast(`选择目录失败：${(r && r.reason) || '未接入'}`, 'err');
    }
  }

  async function loadFileDir(dir) {
    const r = await bridge.fileTree(dir);
    if (r && r.bridgeMissing) {
      // 「未接入」与「接了但为空」必须分开：桥不存在时不能显示成「空目录」。
      state.filePanel.bridgeMissing = true;
      renderFilePanel();
      return;
    }
    if (!r || r.ok === false) {
      toast(`读取目录失败：${(r && r.reason) || '未接入'}`, 'err');
      state.filePanel.expanded.delete(dir);
      renderFilePanel();
      return;
    }
    state.filePanel.loaded = true;
    state.filePanel.children.set(dir, { entries: r.entries || [], truncated: !!r.truncated });
    if (!state.filePanel.root) state.filePanel.root = dir;
    renderFilePanel();
  }

  function fileEntryHTML(e, depth) {
    const pad = `padding-left:${8 + depth * 16}px`;
    if (e.kind === 'dir') {
      const open = state.filePanel.expanded.has(e.path);
      return `<div class="file-row dir${open ? ' open' : ''}" style="${pad}" data-action="file-toggle" data-path="${esc(e.path)}"><span class="file-caret">${open ? '▾' : '▸'}</span>${ic(open ? 'folderOpen' : 'folder', 14)}${esc(e.name)}</div>`;
    }
    const active = state.filePanel.previewPath === e.path ? ' active' : '';
    const ico = e.binary ? ic('fileText', 14) : ic(e.ext === 'md' ? 'fileText' : 'code', 14);
    return `<div class="file-row file${active}" style="${pad}" data-action="file-open" data-path="${esc(e.path)}" data-name="${esc(e.name)}"><span class="file-caret"></span>${ico}${esc(e.name)}<span class="file-size">${esc(e.sizeLabel || '')}</span></div>`;
  }

  /* ---------- 需求3：右栏「文件」TAB ----------
     与全屏文件面板（state.filePanel，含预览/编辑/diff）分开维护自己的根与展开态：
     TAB 的根自动跟随当前会话所绑定项目的本地目录（用户裁决），全屏面板仍可自选目录。 */
  function fileTabTreeHTML(dir, depth) {
    const ft = state.fileTab;
    const cached = ft.children.get(dir);
    if (!cached) return '';
    let html = (cached.entries || []).map((e) => {
      const full = e.path || (dir.replace(/[\\/]+$/, '') + '/' + e.name);
      e.path = full;
      const isDir = e.kind === 'dir';
      const open = ft.expanded.has(full);
      let out = `<div class="ftab-row${isDir ? ' dir' : ''}" data-action="${isDir ? 'ftab-toggle' : 'ftab-open'}" data-p="${esc(full)}" title="${esc(full)}" style="padding-left:${6 + depth * 13}px">`
        + `<span class="ftab-ico">${isDir ? ic(open ? 'folderOpen' : 'folder', 13) : ic(e.ext === 'md' ? 'fileText' : 'code', 13)}</span>`
        + `<span class="ftab-name">${esc(e.name)}</span></div>`;
      if (isDir && open) out += fileTabTreeHTML(full, depth + 1);
      return out;
    }).join('');
    if (cached.truncated) html += `<div class="ftab-row faint" style="padding-left:${6 + depth * 13}px">（条目超上限，已截断）</div>`;
    return html;
  }

  function fileTabBodyHTML() {
    const ft = state.fileTab;
    // 侧栏太窄放不下预览/编辑/diff，也放不下完整的目录选择流程：
    // 三个分支**都要**有进全屏面板的入口 —— 目录读不到时用户恰恰最需要它。
    const fullBtn = `<button class="btn sm ghost" data-action="file-panel" title="在全屏面板中打开（可预览 / 编辑 / diff / 选目录）">${ic('plus', 12)}</button>`;
    if (ft.error) {
      return `<div class="ctx-empty"><div class="empty-icon">${ic('warn', 24)}</div>目录读取失败<br><span style="font-size:11px">${esc(ft.error)}</span></div>`
        + `<div class="ftab-acts">${fullBtn}<button class="btn sm ghost" data-action="ftab-pick">选择目录</button></div>`;
    }
    if (!ft.root) {
      // 没有绑定目录时不冒充「空目录」：明确区分「未绑定」与「绑定了但空」
      // P4-S5-2：文案按「隐式 cwd 也未设」重写，并给出去欢迎页设定的下一步——
      // 原文案只提「项目未绑定」，向轻模式用户灌输一个他们不需要理解的「项目」概念。
      return `<div class="ctx-empty"><div class="empty-icon">${ic('folder', 24)}</div>尚未设置工作目录<br>`
        + `<span style="font-size:11px">在欢迎页点「设置工作目录」后自动显示该目录的文件，也可手动选择</span></div>`
        + `<div class="ftab-acts"><button class="btn sm ghost" data-action="ftab-pick">选择目录</button>${fullBtn}</div>`;
    }
    const base = dirBase(ft.root);
    return `<div class="ftab-head" title="${esc(ft.root)}">${ic('folderOpen', 13)}<span class="ftab-root">${esc(base)}</span>`
      + `<button class="btn sm ghost" data-action="ftab-refresh" title="刷新">${ic('refresh', 12)}</button>`
      + `<button class="btn sm ghost" data-action="ftab-pick" title="更换目录">${ic('folder', 12)}</button>`
      + fullBtn + `</div>`
      + `<div class="ftab-tree">${fileTabTreeHTML(ft.root, 0) || '<div class="faint" style="padding:8px">（空目录）</div>'}</div>`
      + `<div class="ftab-tip faint">点击文件在全屏面板中预览</div>`;
  }

  /**
   * P4-S5-2/S4-3：文件 TAB 的根目录 = 当前会话的工作目录。
   * 顺序：项目绑定目录 > 轻模式隐式 cwd（s.cwd，欢迎页设定、已下发主进程）。
   * 原实现只认项目绑定目录——新用户主流路径「欢迎页设工作目录 → 对话 → 点文件 TAB」
   * 得到的是「当前会话的项目未绑定本地目录」，被迫重选一个刚才已经选过的目录。
   */
  function fileTabRootDir() {
    const s = state.sessions[state.sel];
    return projectPathOf(state.sel) || String((s && s.cwd) || '').trim();
  }
  /** 首次进入文件 TAB 时按工作目录自动装载；切换会话后根目录变化则重载（S4-3/S5-4）。 */
  async function ensureFileTabRoot() {
    const ft = state.fileTab;
    if (ft.loading) return;
    const dir = fileTabRootDir();
    // 根目录变了就必须重装：ft.inited 原是全局一次性 guard，切到别的项目/目录的会话后
    // 仍显示上一个目录的树——把别项目的文件呈现为当前会话的文件（铁律：不许撒谎）。
    // 防重入：装载成功（ft.root===dir）或这个目录已经试过且没成功（ft.root 仍空而
    // lastDir===dir）都不再动。少了后半条，失败态下会变成
    // render → ensureFileTabRoot → render 的死循环（每次渲染重试一次 fileTree）。
    if (ft.inited && (ft.root === dir || (!ft.root && ft.lastDir === dir))) return;
    if (ft.inited) { ft.root = ''; ft.children.clear(); ft.expanded.clear(); ft.error = ''; }
    ft.lastDir = dir;
    ft.inited = true;
    if (!dir) return;
    ft.loading = true;
    try {
      const r = await bridge.fileTree(dir);
      if (r && r.bridgeMissing) { ft.error = '主进程未接入文件服务'; }
      else if (!r || r.ok === false) { ft.error = (r && r.reason) || '目录读取失败'; }
      else { ft.root = dir; ft.children.set(dir, { entries: r.entries || [], truncated: !!r.truncated }); ft.error = ''; }
    } catch (e) { ft.error = (e && e.message) || '目录读取失败'; }
    ft.loading = false;
    ft.inited = true;
    render();
  }

  async function fileTabLoadDir(dir) {
    const ft = state.fileTab;
    const r = await bridge.fileTree(dir);
    if (!r || r.ok === false) { toast(`读取目录失败：${(r && r.reason) || '未接入'}`, 'err'); ft.expanded.delete(dir); return; }
    ft.children.set(dir, { entries: r.entries || [], truncated: !!r.truncated });
  }

  function renderTreeLevel(dir, depth) {
    const cached = state.filePanel.children.get(dir);
    if (!cached) return '';
    let html = (cached.entries || []).map((e) => {
      // entries 上补 path/sizeLabel（宿主排序返回的是纯条目）
      const full = e.path || (dir.replace(/[\\/]+$/, '') + '/' + e.name);
      e.path = full;
      // sizeLabel 由宿主用 humanSize 给出（唯一真源），渲染层不再自己换算。
      let out = fileEntryHTML(e, depth);
      if (e.kind === 'dir' && state.filePanel.expanded.has(full)) {
        out += renderTreeLevel(full, depth + 1);
      }
      return out;
    }).join('');
    if (cached.truncated) html += `<div class="file-row faint" style="padding-left:${8 + depth * 16}px">（条目超上限，已截断）</div>`;
    return html;
  }

  function renderFilePanel() {
    if (!$('#fileRoot').dataset.ready) return;
    const fp = state.filePanel;
    const head = $('#fileHead');
    const closeBtn = '<button class="btn ghost sm" data-action="file-close">关闭</button>';
    // 「未接入」不能用 `typeof bridge.fileTree !== 'function'` 判——桥兜底 stub
    // 也是函数，那样永远命中不了。真实信号是宿主返回的 bridgeMissing 标记。
    if (fp.bridgeMissing) {
      head.innerHTML = `<b>文件</b><span class="faint">未接入主进程</span><span style="margin-left:auto"></span>${closeBtn}`;
      $('#fileTree').innerHTML = '<div class="faint" style="padding:10px">主进程未接入文件服务。</div>';
      $('#fileView').innerHTML = '';
      return;
    }
    head.innerHTML = `<b>文件</b>
      <span class="file-root" title="${esc(fp.root)}">${esc(fp.root || '（未选择目录）')}</span>
      <span class="row" style="margin-left:8px">
        <button class="btn sm ghost" data-action="file-pick">${fp.root ? '更换目录' : '选择目录'}</button>
        ${fp.root ? `<button class="btn sm ghost" data-action="file-refresh">刷新</button>` : ''}
      </span>
      <span style="margin-left:auto"></span>${closeBtn}`;
    if (!fp.root) {
      $('#fileTree').innerHTML = '<div class="faint" style="padding:10px">选择一个目录开始浏览（只读；编辑与 diff 后续按需加入）。</div>';
      $('#fileView').innerHTML = '';
      return;
    }
    $('#fileTree').innerHTML = renderTreeLevel(fp.root, 0) || '<div class="faint" style="padding:10px">（空目录）</div>';
    if (!fp.preview && !fp.previewLoading) {
      $('#fileView').innerHTML = '<div class="faint" style="padding:14px">左侧点选文件预览（只读）。</div>';
    }
  }

  async function openFilePreview(path, name) {
    const fp = state.filePanel;
    fp.previewPath = path;
    fp.previewLoading = true;
    // 换文件 = 重置编辑态（编辑另一个文件前不保留上一个文件的缓冲）
    fp.view = 'preview'; fp.editBuf = ''; fp.editBase = ''; fp.dirty = false; fp.saving = false; fp.discardArmed = false;
    fp.diffRows = null; fp.diffTooLarge = false; fp.diffLineDelta = 0; fp.saveError = '';
    const view = $('#fileView');
    if (view) view.innerHTML = `<div class="faint" style="padding:14px">读取中…</div>`;
    const r = await bridge.fileRead(path);
    fp.previewLoading = false;
    if (!r || r.ok === false) {
      fp.preview = null;
      if (view && fp.previewPath === path) {
        view.innerHTML = `<div class="file-view-head">${esc(path)}</div><div class="faint" style="padding:14px">读取失败：${esc((r && r.reason) || '未接入')}</div>`;
      }
      return;
    }
    if (view && fp.previewPath !== path) return; // 用户已点开别的文件
    fp.preview = r;
    renderFileView();
  }

  /** 文件不可编辑的原因（显式降级：不说「能编辑」也不说「坏了」，说清为什么不能）。 */
  function fileEditBlockReason(r) {
    if (r.binary) return '二进制文件';
    if (r.truncated) return '文件超过 2MB 读取上限（只读了前段，保存会截断文件）';
    if (r.encodingSuspicious) return '内容不是有效 UTF-8（保存会产生乱码）';
    return '';
  }

  /** 编辑缓冲的「将要写盘」形态：textarea 产物是纯 LF，CRLF 文件按原风格还原。 */
  function fileEditWillSave() {
    const fp = state.filePanel;
    return window.OrchDeskFileEdit
      ? window.OrchDeskFileEdit.applyEol(fp.editBuf, fp.eol)
      : fp.editBuf;
  }

  function fileViewToolbar(r) {
    const fp = state.filePanel;
    const editable = !!r.editable && typeof bridge.fileWrite === 'function' && !!(window.OrchDeskFileEdit && window.OrchDeskFileEdit.computeDiff);
    const reason = fileEditBlockReason(r);
    const btns = [];
    if (fp.view === 'edit') {
      // R5-12：原为 ${fp.diffRows ? 'ghost' : 'ghost'}——两分支相同，条件恒无效果。
      btns.push(`<button class="btn sm ghost" data-action="file-edit-diff">${fp.view === 'diff' ? '退出对比' : '对比变更'}</button>`);
      btns.push(`<button class="btn sm primary" data-action="file-edit-save"${fp.saving ? ' disabled' : ''}>${fp.saving ? '保存中…' : '保存'}</button>`);
      btns.push(`<button class="btn sm ghost" data-action="file-edit-cancel">${fp.discardArmed ? '确认丢弃？' : (fp.dirty ? '放弃修改' : '取消编辑')}</button>`);
    } else if (editable) {
      btns.push('<button class="btn sm ghost" data-action="file-edit">编辑</button>');
    }
    return `<span class="row" style="margin-left:auto">
      ${!editable && reason ? `<span class="faint" title="该文件不可编辑">不可编辑：${esc(reason)}</span>` : ''}
      ${fp.dirty ? '<span class="badge warn">未保存</span>' : ''}
      ${btns.join('')}
    </span>`;
  }

  function renderFileView() {
    const fp = state.filePanel;
    const view = $('#fileView');
    const r = fp.preview;
    if (!view || !r) return;
    const renderPath = fp.previewPath;
    const meta = `<div class="file-view-head"><span>${esc(fp.previewPath)}</span>
      <span class="faint">${esc(r.sizeLabel || '')}${r.truncated ? ' · 已截断（只读前 2MB）' : ''}</span>
      ${fileViewToolbar(r)}</div>`;
    if (r.binary) {
      view.innerHTML = meta + `<div class="faint" style="padding:14px">二进制文件（${esc(r.sizeLabel || '')}），不提供内容预览。</div>`;
      return;
    }
    if (fp.view === 'edit') {
      view.innerHTML = meta
        + (fp.saveError ? `<div class="file-edit-error">${esc(fp.saveError)} <button class="btn sm ghost" data-action="file-edit-reload">重新加载</button></div>` : '')
        + `<textarea id="fileEditBuf" class="file-edit-area" spellcheck="false">${esc(fp.editBuf)}</textarea>`;
      return;
    }
    if (fp.view === 'diff') {
      view.innerHTML = meta + renderFileDiffBody();
      return;
    }
    // shiki 高亮：可用 + 语言受支持 + 体积在阈值内才走；否则纯文本 <pre>（不猜语言）。
    // 体积门槛不是保守：codeToHtml 是同步阻塞渲染线程，实测 64KB=753ms、
    // 256KB=1.34s、1MB=5.1s、**2MB=10.5s**，且 HTML 膨胀约 6.8 倍（2MB 文本
    // 产出约 35 万个 span）。超过阈值一律回落 <pre> 并显式说明「为什么没高亮」。
    const lang = r.lang;
    const tooBigForShiki = r.content.length > FILE_SHIKI_MAX_CHARS
      || r.content.split('\n').length > FILE_SHIKI_MAX_LINES;
    if (tooBigForShiki) {
      view.innerHTML = meta
        + `<div class="faint" style="padding:8px 14px">文件过大（${esc(r.sizeLabel || '')}），已跳过语法高亮以保证界面响应；编辑与保存不受影响。</div>`
        + `<pre class="file-pre">${esc(r.content)}</pre>`;
      return;
    }
    const useShiki = typeof window !== 'undefined' && window.ShikiLite
      && lang && window.ShikiLite.supportedLang(lang) && lang !== 'plaintext';
    if (useShiki) {
      window.ShikiLite.createHighlighter({ langs: FILE_SHIKI_LANGS, theme: document.documentElement.dataset.theme === 'light' ? 'github-light' : 'github-dark' })
        .then((h) => {
          if (fp.previewPath !== renderPath || fp.view !== 'preview' || fp.preview !== r) return;
          view.innerHTML = meta + `<div class="file-code">${h.codeToHtml(r.content, { lang })}</div>`;
        })
        .catch((err) => {
          console.warn('[file] shiki 高亮失败，回落纯文本:', err && err.message);
          if (fp.view === 'preview') view.innerHTML = meta + `<pre class="file-pre">${esc(r.content)}</pre>`;
        });
      return;
    }
    view.innerHTML = meta + `<pre class="file-pre">${esc(r.content)}</pre>`;
  }

  function renderFileDiffBody() {
    const fp = state.filePanel;
    const fe = window.OrchDeskFileEdit;
    if (!fe) return '<div class="faint" style="padding:14px">对比组件未接入（file-edit.js 未加载）。</div>';
    if (fp.diffTooLarge) {
      return `<div class="faint" style="padding:14px">变更过大（行数变化 ${fp.diffLineDelta > 0 ? '+' : ''}${fp.diffLineDelta}），不提供逐行对比；保存仍可用。</div>`;
    }
    const rows = fp.diffRows || [];
    if (!rows.length) return '<div class="faint" style="padding:14px">无变更（与磁盘一致）。</div>';
    const groups = fe.groupHunks(rows);
    const html = groups.map((g) => {
      const body = g.map((row) => {
        const cls = row.t === 'add' ? 'add' : row.t === 'del' ? 'del' : 'ctx';
        return `<div class="fd-row ${cls}"><span class="fd-no">${row.an || ''}</span><span class="fd-no">${row.bn || ''}</span><span class="fd-t">${esc(row.s) || '&nbsp;'}</span></div>`;
      }).join('');
      return `<div class="fd-hunk">${body}</div>`;
    }).join('');
    const stat = fp.diffStat || '';
    return `<div class="fd-stat">${esc(stat)}</div><div class="file-diff">${html}</div>`;
  }

  function startFileEdit() {
    const fp = state.filePanel;
    const r = fp.preview;
    if (!r || r.binary || r.truncated || r.encodingSuspicious) return;
    const fe = window.OrchDeskFileEdit;
    fp.eol = fe ? fe.detectEol(r.content) : 'lf';
    fp.editBuf = r.content; // textarea 赋值后浏览器会把 CRLF 规范化为 LF（写盘时按 fp.eol 还原）
    // 缓存 dirty 比较基线（textarea 内容就是 LF 形态，与 editBuf 同形）
    fp.editBase = fe ? fe.applyEol(r.content, 'lf') : r.content;
    fp.dirty = false;
    fp.view = 'edit';
    fp.discardArmed = false;
    fp.saveError = '';
    fp.diffRows = null; fp.diffTooLarge = false;
    renderFileView();
    const ta = $('#fileEditBuf');
    if (ta) ta.focus();
  }

  function computeFileDiff() {
    const fp = state.filePanel;
    const fe = window.OrchDeskFileEdit;
    if (!fe || !fp.preview) return;
    const will = fileEditWillSave();
    const d = fe.computeDiff(fp.preview.content, will);
    if (d.ok) {
      fp.diffRows = d.rows;
      fp.diffTooLarge = false;
      fp.diffStat = `+${d.stats.adds} / -${d.stats.dels}`;
    } else {
      fp.diffRows = null;
      fp.diffTooLarge = true;
      fp.diffLineDelta = d.lineDelta;
      fp.diffStat = '';
    }
  }

  async function saveFileEdit() {
    const fp = state.filePanel;
    const r = fp.preview;
    if (!r || fp.saving) return;
    if (typeof bridge.fileWrite !== 'function') { toast('保存失败：主进程未接入', 'err'); return; }
    fp.saving = true;
    fp.saveError = '';
    renderFileView();
    const will = fileEditWillSave();
    const res = await bridge.fileWrite(r.path || fp.previewPath, will, r.mtimeMs);
    fp.saving = false;
    if (res && res.ok) {
      // 预览基线更新为刚写盘的内容（后续 diff/编辑以新基线为准）
      fp.preview.content = will;
      fp.preview.mtimeMs = res.mtimeMs;
      fp.preview.size = res.size;
      fp.preview.sizeLabel = res.sizeLabel;
      fp.dirty = false;
      fp.view = 'preview';
      fp.editBuf = '';
      // 基线轮转：连续编辑时以「刚写盘的内容」为新的比较基准，否则下一轮
      // 编辑会被自己上一次的保存误判成 dirty。
      fp.editBase = window.OrchDeskFileEdit
        ? window.OrchDeskFileEdit.applyEol(will, 'lf')
        : will;
      toast(`已保存（${res.sizeLabel || ''}）`, 'ok');
    } else {
      fp.saveError = (res && res.reason) || '保存失败';
      if (res && res.code === 'modified-externally') {
        // 外部修改拒绝：编辑态保留缓冲（改动不丢），由用户决定重新加载或另作处理
        fp.view = 'edit';
      }
    }
    renderFileView();
  }

  function cancelFileEdit() {
    const fp = state.filePanel;
    if (fp.dirty && !fp.discardArmed) {
      // 两段式确认：第一次点只 arm（不弹窗打断），3.5s 内再点才真的丢弃
      fp.discardArmed = true;
      renderFileView();
      setTimeout(() => { if (fp.discardArmed) { fp.discardArmed = false; if (fp.view === 'edit') renderFileView(); } }, 3500);
      return;
    }
    fp.view = 'preview';
    fp.editBuf = '';
    fp.dirty = false;
    fp.discardArmed = false;
    fp.saveError = '';
    fp.diffRows = null; fp.diffTooLarge = false;
    renderFileView();
  }

  function toggleFileDiff() {
    const fp = state.filePanel;
    if (fp.view === 'diff') { fp.view = 'edit'; renderFileView(); return; }
    computeFileDiff();
    fp.view = 'diff';
    renderFileView();
  }

  async function reloadFilePreview() {
    const fp = state.filePanel;
    const p = fp.previewPath;
    if (p) await openFilePreview(p);
  }


  /* ---------- 通用输入弹窗（Electron 不支持 window.prompt，统一走 modal） ---------- */
  function askInput(opts) {
    openModal(`<div class="mh">${ic('at', 18)}<b>${esc(opts.title)}</b></div>
      <div class="mb">
        ${opts.label ? `<div class="faint" style="margin-bottom:8px">${esc(opts.label)}</div>` : ''}
        <div class="mb-row"><input id="askInput" class="inp" type="${opts.secret ? 'password' : 'text'}" placeholder="${esc(opts.placeholder || '')}" style="width:100%" autofocus></div>
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="ask-input-ok">${esc(opts.okText || '确定')}</button></div>`);
    state.askInputCb = opts.onOk;
  }

  /** 观雅集技能安装（authorized=true 表示用户已在弹窗中显式授权高危能力）。 */
  async function doInstallGuanjiSkill(skill, authorized) {
    try {
      const r = await bridge.guanjiInstall(skill, authorized);
      if (r && r.ok) {
        // 不再手动 push 一条内存记录：以磁盘真实扫描为准（含体积/落盘时间），
        // 否则装完 UI 显示的是只有 slug 的假条目，且重启后来源不一致。
        await refreshInstalledSkills();
        toast(`已从观雅集安装「${skill.slug}」（能力审查：${r.review}）`, 'ok');
      } else if (r && r.review === 'needs-auth') {
        toast(`「${skill.slug}」需授权：请先在弹窗中确认高危能力`, 'danger');
      } else {
        toast(`安装失败：${(r && r.reason) || '未知错误'}`, 'danger');
      }
    } catch {
      toast('安装请求异常', 'danger');
    }
    closeModal();
    render();
  }

  /* ---------- 系统提示词编辑器（T-P4-3） ---------- */
  function openPromptEditor(doc) {
    const isEdit = !!doc;
    const title = isEdit ? doc.title : '';
    const category = isEdit ? doc.category : 'role';
    const body = isEdit ? doc.body : '';
    const agents = isEdit ? (doc.agents || []).join(', ') : '';
    // R5-03：三个回显值统一走 esc()。原来 title 只转义 "、body 只转义 <、
    // agents 完全没转义——agents 是用户自由输入，含 " 即打断属性，可注入
    // onfocus 之类事件属性。同一函数里三种口径且都不完整。
    // （本条原先也写成那种花括号注释形态，落在模板串里会被当正文渲染进弹窗。）
    openModal(`<div class="mh">${ic('at', 18)}<b>${isEdit ? '编辑提示词' : '新建提示词'}</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:8px">提示词与技能解耦；可在正文中使用 <span class="mono">{'{skill:xxx}'}</span> 引用技能（运行时展开）。</div>
        <div class="mb-row"><label>标题</label><input id="pmTitle" class="inp" value="${esc(title)}" placeholder="如：默认角色设定"></div>
        <div class="mb-row"><label>分类</label><select id="pmCat" class="inp">
          ${PROMPT_CATS.map((c) => `<option value="${c}" ${c === category ? 'selected' : ''}>${PROMPT_CAT_LABELS[c]}</option>`).join('')}
        </select></div>
        <div class="mb-row"><label>正文</label><textarea id="pmBody" class="inp" rows="5" placeholder="提示词内容…支持 {skill:xxx} 引用">${esc(body)}</textarea></div>
        <div class="mb-row"><label>绑定 Agent</label><input id="pmAgents" class="inp" value="${esc(agents)}" placeholder="留空=全局默认；多个用逗号分隔"></div>
      </div>
      <div class="mf">
        ${isEdit ? `<button class="btn danger" data-action="prompt-delete" data-id="${doc.id}">删除</button>` : ''}
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="prompt-save" data-id="${isEdit ? doc.id : ''}">保存</button>
      </div>`);
  }

  async function doSavePrompt(id) {
    const title = ($('#pmTitle')?.value || '').trim();
    const category = $('#pmCat')?.value || 'role';
    const body = ($('#pmBody')?.value || '').trim();
    const agents = ($('#pmAgents')?.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!title) { toast('请填写标题', 'warn'); return; }
    const patch = { title, category, body, agents, priority: 100 };
    try {
      const res = await bridge.savePrompt(id || '', patch);
      if (res && res.ok) {
        closeModal();
        await refreshPrompts();
        toast(isEdit(id) ? '提示词已更新' : '提示词已创建', 'ok');
      } else {
        toast('提示词未持久化（运行时未接入？仅在占位环境）', 'warn');
        // 占位环境：本地乐观更新，保证 UI 可演示。
        const local = { id: id || ('pl-' + Date.now()), title, category, body, agents, priority: 100, updatedAt: Date.now() };
        if (id) { const i = state.promptDocs.findIndex((d) => d.id === id); if (i >= 0) state.promptDocs[i] = local; }
        else state.promptDocs.unshift(local);
        closeModal(); render(); toast(isEdit(id) ? '提示词已更新（本地）' : '提示词已创建（本地）', 'ok');
      }
    } catch {
      toast('保存失败（运行时未接入）', 'warn');
    }
  }
  function isEdit(id) { return !!id; }

  async function doDeletePrompt(id) {
    try {
      const res = await bridge.deletePrompt(id);
      if (res && res.ok) { closeModal(); await refreshPrompts(); toast('提示词已删除', 'ok'); return; }
    } catch { /* 占位环境乐观删除 */ }
    state.promptDocs = state.promptDocs.filter((d) => d.id !== id);
    closeModal(); render(); toast('提示词已删除（本地）', 'ok');
  }

  async function refreshPrompts() {
    try {
      const list = await bridge.listPrompts();
      if (Array.isArray(list)) state.promptDocs = list;
      const merged = await bridge.mergePrompts('main');
      if (merged && Array.isArray(merged.conflicts)) state.promptConflicts = merged.conflicts;
    } catch { /* 占位环境保留本地数据 */ }
  }
  async function doSwitchAuth(target) {
    // 乐观更新可以，但切换失败必须回滚，不能把未生效的档显示成当前。
    if (target !== 'bypass' && target !== 'autopilot') {
      toast('只能选择默认模式或完全信任', 'err');
      return;
    }
    const prev = state.authMode;
    state.authMode = target;
    render();
    try {
      const res = await bridge.setAuthMode(target);
      if (!res || res.ok === false) {
        state.authMode = prev;
        render();
        toast(`授权模式切换未生效，已回滚为「${authModeLabel(prev)}」（运行时未接入？）`, 'err');
        return;
      }
      toast(`已切换为「${authModeLabel(target)}」`, 'warn');
    } catch {
      state.authMode = prev;
      render();
      toast(`授权模式切换失败，已回滚为「${authModeLabel(prev)}」（运行时未接入）`, 'err');
    }
  }

  /* ---------- 审批弹窗（T-P3-2 fail-closed） ---------- */
  // 主进程经 orchdesk:authz-approval-request 转发 Step 审批 → 渲染层弹窗 → 用户决定 → submitDecision。
  function showApprovalModal(req) {
    // PRD FR-9 授权粒度：单次 / 会话 / 永久。后两者需要「具体目标」才能建白名单规则
    // （拿不到目标就只能建 '*' 规则，等于对该工具全放行 —— 不提供这个选项）。
    const target = String(req.target || '').trim();
    const canRemember = !!target && !!req.toolName;
    const remember = canRemember
      ? `<div class="row" style="margin-top:10px">
           <button class="btn sm" data-action="approval-grant" data-id="${req.id}" data-scope="session" data-tool="${esc(req.toolName)}" data-target="${esc(target)}">会话内允许</button>
           <button class="btn sm" data-action="approval-grant" data-id="${req.id}" data-scope="permanent" data-tool="${esc(req.toolName)}" data-target="${esc(target)}">永久允许</button>
           <span class="faint">目标 <span class="mono">${esc(target.length > 48 ? target.slice(0, 48) + '…' : target)}</span></span>
         </div>`
      : `<div class="faint" style="margin-top:8px;font-size:11.5px">该请求未携带具体目标，只能单次允许（白名单需「操作类型 + 目标」两项齐全）。</div>`;
    openModal(`<div class="mh danger">${ic('warn', 18)}<b>授权确认（L3/L4 操作）</b></div>
      <div class="mb">
        <div>Agent 请求执行 <b>${esc(req.toolName || '受限操作')}</b>${req.reason ? `：<span class="faint">${esc(req.reason)}</span>` : ''}。</div>
        <div class="warn-list" style="margin-top:10px">
          <div>· 该操作属于 L3/L4 级别，需你显式授权</div>
          <div>· 超时或关闭将视为 <b>拒绝（fail-closed）</b>，操作不会执行</div>
          <div>· 「会话 / 永久允许」写入授权白名单，可在设置页查看与撤销</div>
        </div>
        ${remember}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="approval-deny" data-id="${req.id}">拒绝</button>
        <button class="btn danger" data-action="approval-allow" data-id="${req.id}">允许本次</button>
      </div>`);
  }

  /** 分叉点选项文案：说明「继承到第几条之后」。 */
  function forkOptionLabel(i, msgs) {
    const n = msgs.length;
    if (i >= n) return `全部 · 继承 ${n} 条`;
    if (i <= 0) return '空起点 · 不继承任何消息';
    const m = msgs[i - 1] || {};
    const who = (m.r || m.role) === 'user' ? '你' : 'Agent';
    const txt = String(m.x || m.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `第 ${i} 条（${who}：${txt || '（空消息）'}）之后`;
  }

  function confirmNewBranch(sid) {
    const s = state.sessions[sid];
    const msgs = (s && Array.isArray(s.msgs)) ? s.msgs : [];
    const n = msgs.length;
    // 没有分叉模块 or 没有消息 → 不给分叉点选择，只做「全继承」（或空起点）。
    const pickable = !!(FORK && n > 0);
    openModal(`<div class="mh">${ic('fork', 18)}<b>从此会话创建分支</b></div>
      <div class="mb">
        <div>分支继承 <span class="mono">#${esc(sid)}</span> 在<b>分叉点之前</b>的消息，之后写入独立会话，<b>互不污染</b>。</div>
        // P4-S4-4：删掉「可随时合并或丢弃分支」——全仓没有任何分支合并 UI/IPC，
        // 向用户预告一个不存在的功能，事后必然找不到入口。
        <div class="warn-list"><div>· 可在分叉点独立探索</div><div>· 主干不受影响</div><div>· 分支可随时归档 / 删除（侧栏 ··· 菜单）</div></div>
        <div style="margin-top:10px">分支名：<input type="text" id="fork-name" value="分支-${esc(sid)}-1" style="margin-top:4px"></div>
        ${pickable ? `<div style="margin-top:12px">
          <div class="row" style="justify-content:space-between">
            <span class="cm-label">分叉点</span><span class="tl mono" id="fork-at-label">${esc(forkOptionLabel(n, msgs))}</span>
          </div>
          <input type="range" id="fork-at" min="0" max="${n}" step="1" value="${n}" data-action="fork-slider" data-sid="${esc(sid)}" style="width:100%" aria-label="分叉点" aria-valuetext="${esc(forkOptionLabel(n, msgs))}">
          <div class="faint" style="font-size:11px;margin-top:2px">拖动选择从哪一条之后分出；默认继承全部 ${n} 条</div>
        </div>` : `<div class="faint" style="margin-top:10px">${FORK ? '当前会话还没有消息，分支将从空起点开始。' : '分叉模块未加载，无法选择分叉点。'}</div>`}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="branch-confirm" data-sid="${esc(sid)}"${FORK ? '' : ' disabled'}>创建分支</button>
      </div>`);
  }

  function confirmRename(sid) {
    const s = state.sessions[sid];
    openModal(`<div class="mh">${ic('edit', 18)}<b>重命名会话</b></div>
      <div class="mb">
        <div>新名称：<input type="text" value="${s ? esc(s.title) : ''}" style="margin-top:6px"></div>
        <div class="faint" style="margin-top:8px">会话 ID 保持 <span class="mono">#${esc(sid)}</span> 不变。</div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="rename-confirm" data-id="${esc(sid)}">保存</button>
      </div>`);
  }

  function confirmArchiveProject(pid) {
    const p = state.projects.find((x) => x.id === pid);
    openModal(`<div class="mh danger">${ic('archive', 18)}<b>归档项目「${p ? esc(p.n) : ''}」？</b></div>
      <div class="mb">
        <div>归档后将折叠到「已归档」分组，<b>不可在前台直接打开</b>。所有会话日志和事件仍保留在数据目录，可随时还原。</div>
        <div class="warn-list"><div>· 项目内 <b>${p ? p.sessions.length : 0}</b> 个会话一并归档</div><div>· 插件与配置保留</div><div>· 归档后可在「已归档」组中点击还原</div></div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn danger" data-action="archive-confirm" data-id="${esc(pid)}">确认归档</button>
      </div>`);
  }

  /* 破坏性操作统一确认（P1）：删会话 / MCP / 提供商 / 技能 / 提示词 / 清审计日志
     此前一键直达、无确认无撤销，与产品 fail-closed 的安全姿态自相矛盾。复用归档 /
     切授权模式既有的 warn-list 模态范式：列明将失去的内容，确认走独立 action，
     执行函数原样不动（只改入口）。 */
  function confirmDestructive(o) {
    openModal(`<div class="mh danger">${ic(o.icon || 'trash', 18)}<b>${esc(o.title)}</b></div>
      <div class="mb">
        ${o.body ? `<div>${o.body}</div>` : ''}
        ${o.warnList && o.warnList.length ? `<div class="warn-list" style="margin-top:10px">${o.warnList.map((w) => `<div>· ${w}</div>`).join('')}</div>` : ''}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn danger" data-action="${o.action}" data-id="${esc(o.id)}">${esc(o.confirmLabel || '确认删除')}</button>
      </div>`);
  }

  function openSkillPicker() {
    const skills = PLUGINS.concat(SKILLS_MARKET);
    openModal(`<div class="mh">${ic('plus', 18)}<b>加载技能到当前会话</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:8px">技能加载后将注册为本次会话的 effect，离开会话即卸载。</div>
        ${skills.map((p) => `<div class="row" style="padding:7px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:6px"><div style="flex:1"><b>${p.n || p.d}</b><div class="faint" style="font-size:11px">${p.d || ''}</div></div><button class="btn sm primary" data-action="skill-attach" data-n="${p.n || p.d}">加载</button></div>`).join('')}
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
  }

  function openExpertPicker() {
    openModal(`<div class="mh">${ic('at', 18)}<b>引用专家或专家团</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:8px">@ 引用后，专家将以 <b>SubAgent</b> 形式参与本次回复，不替换主会话。</div>
        <div class="sec-title" style="margin:6px 0">专家</div>
        ${expertList().map((e) => `<div class="row" style="padding:6px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:5px"><div style="flex:1"><b>${esc(e)}</b></div><button class="btn sm" data-action="expert-attach" data-n="${esc(e)}">@ 引用</button></div>`).join('')}
        <div class="sec-title" style="margin:10px 0 6px">专家团</div>
        ${teamList().map((t) => `<div class="row" style="padding:6px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:5px"><div style="flex:1"><b>${esc(t.n)}</b><div class="faint" style="font-size:11px">${esc(t.m || '')}</div></div><button class="btn sm primary" data-action="expert-attach" data-n="${esc(t.n)}">引用团</button></div>`).join('')}
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
  }

  function openModelPicker() {
    const pool = getModelPool();
    if (!pool.length) {
      // P2：无模型时不把用户弹去设置页——就地开内嵌配置面板（两步：预设 + KEY）。
      openModelSetupModal();
      return;
    }
    const poolNames = new Set(pool.map(m => m.n));
    // 同步：清理已不在当前模型池中的残留选中项
    const prevLen = state.selectedModels.length;
    state.selectedModels = state.selectedModels.filter(n => poolNames.has(n));
    if (state.selectedModels.length !== prevLen) {
      console.log('[model] cleaned stale selection:', prevLen, '->', state.selectedModels.length);
    }
    const groups = {};
    pool.forEach((m) => { const p = m.p.split(' · ')[0]; if (!groups[p]) groups[p] = []; groups[p].push(m); });
    const html = Object.entries(groups).map(([provider, models]) => {
      const allSel = models.every((m) => state.selectedModels.includes(m.n));
      return `<div class="mg-grp">
        <div class="mg-h">${esc(provider)}<span class="mg-all" data-action="mg-toggle-all" data-p="${esc(provider)}">${allSel ? '取消全选' : '全选'}</span></div>
        ${models.map((m) => { const sel = state.selectedModels.includes(m.n);
          const isDefault = state.defaultModel === m.n;
          return `<div class="m-opt ${sel ? 'sel' : ''}" data-action="model-toggle" data-n="${esc(m.n)}">
            <div class="mo-cb"></div>
            <div class="mo-info"><div class="mo-name">${esc(m.n)}${isDefault ? ' <span class="badge ok">默认</span>' : ''}</div><div class="mo-meta">${esc(m.p)}</div></div>
            <div class="mo-state">${m.state === '已测' || m.state === '已就绪' ? '<span class="badge ok">' + m.state + '</span>' : '<span class="badge">' + m.state + '</span>'}</div>
          </div>`; }).join('')}
      </div>`;
    }).join('');
    openModal(`<div class="mh">${ic('bot', 18)}<b>选择模型</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:10px">第一个选中 = 主运行模型；本地模型勾选后作为意图识别。此选择会保存，新会话自动复用。默认模型可在 设置→模型管理 中指定。</div>
        ${html}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="model-clear">清空</button>
        <button class="btn primary" data-action="model-confirm">确认（${state.selectedModels.length} 个）</button>
      </div>`);
  }

  /* ---------- 交互 ---------- */
  // 点击空白处关下拉
  document.body.addEventListener('click', (e) => {
    // 预设下拉：点击面板外即关
    if (state.mpPresetOpen && !e.target.closest('.mp-preset')) { state.mpPresetOpen = false; mpRefreshPreset(); }
    // R2-4：原实现还顺带查 .proj-select / .proj-dropdown 两个已随 UI 重构消失的类名，
    // 并读永不为 true的 state.projDropdownOpen——整段是不可达分支。
    if (state.composerMoreOpen && !e.target.closest('.composer-more')) {
      state.composerMoreOpen = false;
      const cm = document.querySelector('.composer-more-dropdown');
      if (cm) cm.classList.remove('open');
    }
  });
  /* composer Enter-to-send（homeComposer + 会话内 #composer） */
  document.body.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'plugSearch') plugSearchFilter();
    else if (e.target && e.target.id === 'skillSearch') skillSearchFilter();
    else if (e.target.id === 'mp-preset-search') mpPresetFilter();
    // KEY / URL / 类型 / 完整URL 勾选变化：防抖 800ms 后重新拉取可用模型
    else if (e.target.id === 'mp-key' || e.target.id === 'mp-url' || e.target.id === 'mp-type' || e.target.id === 'mp-fullurl') scheduleMpFetch();
    // 模型勾选面板：checkbox 变更只更新 Set 与计数，不重渲染
    else if (e.target && e.target.dataset && e.target.dataset.mid) {
      const mid = e.target.dataset.mid;
      if (e.target.checked) state.mpModelsChecked.add(mid); else state.mpModelsChecked.delete(mid);
      const c = $('#mp-models-count');
      if (c) c.textContent = `已选 ${state.mpModelsChecked.size}/${state.mpModels.length}`;
    }
  });
  document.body.addEventListener('keydown', (e) => {
    // R2-2：Ctrl+K / Cmd+K 把焦点送到导航轨第一项（汉堡菜单与导航抽屉已随
    // commit 6dbf8e7 删除，注释原写「唤出导航抽屉」与实现双向漂移）。
    // 焦点在终端内部时不抢——xterm/vim 等交互程序大量使用 Ctrl+K（A-P2-5）。
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      const inTerm = e.target && e.target.closest && e.target.closest('#terminalRoot .term-container');
      if (inTerm) return;
      e.preventDefault();
      const railBtn = document.querySelector('#rail [data-action="nav"]');
      if (railBtn) railBtn.focus();
      return;
    }

    // 预设下拉键盘导航：↑/↓ 移动、Enter 选中、Esc 关闭（先于硬委托，避免双触发）
    if (e.target && e.target.closest && e.target.closest('.mp-preset-pop')) {
      // 可见性按内联 display 判：mpPresetFilter 用 el.style.display 隐藏，本项目没有
      // .hidden 规则。此前用 :not(.hidden) 选，过滤后键盘导航仍会跳到已隐藏的项（A-P2-2）。
      const items = [...document.querySelectorAll('#mp-preset-list .mp-preset-item')]
        .filter((el) => el.style.display !== 'none');
      const cur = document.querySelector('#mp-preset-list .mp-preset-item.hl');
      let idx = items.indexOf(cur);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (cur) cur.classList.remove('hl');
        if (items.length) {
          idx = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
          items[idx].classList.add('hl');
        }
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); if (cur || items[0]) (cur || items[0]).click(); return; }
      if (e.key === 'Escape') { e.preventDefault(); state.mpPresetOpen = false; mpRefreshPreset(); return; }
    }
    if (e.key === 'Escape') {
      // 模态优先：ESC 关对话框（含破坏性操作确认），焦点经 closeModal 还回触发元素
      if ($('#modalRoot').firstElementChild) { closeModal(); return; }
      // 终端 / 文件面板：ESC 收起。但焦点在终端内部（xterm 的输入区 / 降级输入框）
      // 时不收 —— vim/less 等交互程序也用 ESC，不能被面板快捷键抢走。
      const inTerm = e.target && e.target.closest && e.target.closest('#terminalRoot .term-container');
      if (state.terminalPanelOpen && !inTerm) { closeTerminalPanel(); return; }
      if (state.filePanelOpen) { closeFilePanel(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && (e.target.id === 'homeComposer' || e.target.id === 'composer')) {
      e.preventDefault();
      // R5-18：原 closest('.home-textarea-wrap') 全仓不存在该类（欢迎页用的是
      // .home-input-wrap），该 closest 恒返回 null。删掉只留兜底 querySelector。
      const sendBtn = document.querySelector('[data-action="home-send"], [data-action="send"]');
      if (sendBtn) sendBtn.click();
    }
    // P1 键盘可达（/harden）：委托层统一把 Enter/Space 映射到 [data-action] 的 click。
    // 只对「被 hardenActions 补了 tabindex 的 div 交互元素」生效，不抢原生控件的默认键
    //（如文本输入的回车、按钮的 Space、下拉的箭头）。textarea 需要 shift+Enter 时不拦。
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest) {
      const actEl = e.target.closest('[data-action][tabindex]:not(button):not(input):not(select):not(a):not(textarea)');
      if (actEl) {
        e.preventDefault();
        actEl.click();
      }
    }
  });
  // ---------------------------------------------------------------------------
  // 动作注册表（审查整改：原 1337 行 / 161 case 的巨型 click switch 拆为具名函数）
  // 主 handler 退化为查表分发；未知动作显式告警（default 语义保留，不静默吞）。
  // ---------------------------------------------------------------------------
  /* ---- 动作注册表：按页模块 install（审查项③，renderer/actions/*.js）。
     ctx 注入本 IIFE 私有面；模块内一律 ctx.X 引用，不直连 app.js 作用域。 */
  const ACTIONS = {};
  {
    const ctx = { $, MODEL_SELECTION_KEY, MODE_RANK, SKILLS_MARKET, adoptOllama, applyBrowserState, applySessionCwd, askInput, autoSelectModels, bridge, browserAct, cancelFileEdit, checkOutbound, closeFilePanel, closeModal, closeTerminalPanel, confirmArchiveProject, confirmDestructive, confirmNewBranch, confirmRename, confirmSwitchAuth, confirmOutboundIfNeeded, createSessionInProject, desktopAutostartDesc, doAbortSend, doArchiveProject, doArchiveSession, doDeletePrompt, doDeleteSession, doFork, doInstallGuanjiSkill, doNewConv, doRename, doSavePrompt, doSend, doSwitchAuth, dynamicModels, revealInspector, esc, expertList, fileTabLoadDir, getModelPool, ic, importSuspend, loadFileDir, memReasonText, mpApplyPreset, mpEnsureCatalog, mpFetchModels, mpRefreshPool, mpRefreshPreset, mpRefreshPresetList, newTerminalSession, nowTime, openAuthPicker, openBrowserPanel, openExpertPicker, openFilePanel, openFilePreview, openMenu, openModal, openModelPicker, openModelSetupModal, openProductPreview, openPromptEditor, openSkillPicker, openTerminalPanel, persist, pickFileRoot, pickWorkspace, pushFloatingContext, refreshConnectorAudit, refreshConnectors, refreshDataDirInventory, refreshCtxLive, refreshMarket, refreshMcp, refreshMemoryDomain, refreshMemorySummarize, refreshSandboxLog, refreshSessionEvents, refreshTerminal, refreshUsage, reloadFilePreview, render, renderBrowserSide, renderFilePanel, renderModelProviders, renderSettingsMain, renderStatusBarActions, renderTerminalPanel, renderWizard, saveFileEdit, saveModelSelection, saveWorkspaceDir, startFileEdit, state, toast, toggleFileDiff, toggleTermFull, updateProtocolRow, updateTraceUi };
    for (const install of (window.__orchdeskActionModules || [])) install(ACTIONS, ctx);
  }


  document.body.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const a = el.dataset.action, id = el.dataset.id;
    const fn = ACTIONS[a];
    if (fn) {
      // 动作异常绝不静默死亡：此前 fn 抛错只产生 unhandled rejection，
      // 用户侧「点了没反应」且控制台之外无迹可寻（P1 修复）。
      try { await fn(el, id, e); }
      catch (err) {
        console.error('[orchdesk] 动作执行失败：', a, err);
        toast(`操作「${a}」执行失败：${(err && err.message) || err}`, 'danger');
      }
      return;
    }
    // 动作名拼错 / 新增动作忘了接线 —— 别静默吞掉（保留原 default 语义）。
    console.warn('[orchdesk] 未知的 data-action：', a);
  });
let outboundTimer = null;
  // P4-S1-05：不可逆操作的「一 shot 确认」标志。needsConfirm 时第一次发送被拦下并
  // 提示，用户再点一次才放行——不会把用户卡死在无限警告里。输入变化即重置。
  let outboundConfirmed = false;
  /** 取一次不可逆操作判定（同步 Promise 版，无防抖）。发送前用它兜底。 */
  function checkOutbound(text) {
    try { return Promise.resolve(bridge.withhold(text || '')); } catch { return Promise.resolve(null); }
  }
  function updateOutboundWarn(text) {
    const el = $('#outboundWarn'); if (!el) return;
    clearTimeout(outboundTimer);
    outboundConfirmed = false;   // 输入变了，上次的「已警告」作废
    outboundTimer = setTimeout(async () => {
      try {
        const w = await checkOutbound(text);
        if (w && w.needsConfirm) { el.hidden = false; el.textContent = w.warning || '⚠ 此操作不可撤销：发送前需二次确认'; }
        else { el.hidden = true; el.textContent = ''; }
      } catch { el.hidden = true; }
    }, 300);
  }
  /**
   * P4-S1-05：发送前的不可逆操作判定。返回 false = 本次发送应被拦下。
   * 存在的理由：会话页 composer 的预警走 300ms 防抖 input 监听，而欢迎页才是新用户
   * 第一站——act_home_send 把文本搬进 #composer 后立即 doSend，防抖定时器只可能在
   * 发送之后才 fire，欢迎页里那个 #outboundWarn 等于死的。于是在欢迎页发送前同步判
   * 一次；needsConfirm 时拦下并提示「再点一次发送」，第二次放行（一 shot 确认）。
   * 判定本身失败不拦路——补偿层在后端仍会 fail-closed，这里不做双重否决。
   */
  function confirmOutboundIfNeeded(text) {
    return Promise.resolve(bridge.withhold(text || '')).then((w) => {
      if (w && w.needsConfirm && !outboundConfirmed) {
        outboundConfirmed = true;
        toast(w.warning || '⚠ 此操作不可撤销：请再点一次「发送」确认', 'warn');
        return false;
      }
      outboundConfirmed = false;
      return true;
    }).catch(() => true);
  }

  document.body.addEventListener('input', (e) => {
    // P4-S1-05：欢迎页的 #homeComposer 也要预警。原实现只绑 #composer，而欢迎页才是
    // 新用户的第一站——act_home_send 把文本搬进 #composer 后立即 doSend，合成 input 事件
    // 触发的 300ms 定时器只可能在发送之后才 fire，欢迎页里那个 #outboundWarn 是死的：
    // 不可逆操作预警在新用户主路径上完全失效（铁律：fail-closed / 不静默）。
    if (e.target.id === 'composer' || e.target.id === 'homeComposer') { updateOutboundWarn(e.target.value); return; }
    // 文件编辑缓冲（P3）：只更新 dirty 徽标，不重渲染（textarea 重渲染会丢焦点/光标）
    if (e.target.id === 'fileEditBuf') {
      const fp = state.filePanel;
      const was = fp.dirty;
      fp.editBuf = e.target.value;
      // 基线在 startFileEdit 里算一次并缓存：每敲一键都对 2MB 文本做
      // applyEol + 读 2MB textarea 值，是纯粹的浪费（实测每次 1.1ms）。
      fp.dirty = fp.editBuf !== fp.editBase;
      if (was !== fp.dirty) {
        const badge = document.querySelector('#fileView .badge.warn');
        if (badge) badge.remove();
        if (fp.dirty) {
          const bar = document.querySelector('#fileView .file-view-head .row');
          if (bar) bar.insertAdjacentHTML('afterbegin', '<span class="badge warn">未保存</span>');
        }
      }
      return;
    }
    // 沙箱日志检索：条件变化即重拉。防抖 350ms —— 每敲一个字都发一次 IPC 会
    // 把输入变成卡顿源（日志体量可能上百条）。
    if (e.target.id === 'sblog-kw') {
      state.sandboxLog.keyword = e.target.value || '';
      clearTimeout(sblogTimer);
      sblogTimer = setTimeout(refreshSandboxLog, 350);
      return;
    }
    if (e.target.dataset.action === 'fork-slider') {
      const sid = e.target.dataset.sid;
      const s = sid && state.sessions[sid];
      const msgs = (s && Array.isArray(s.msgs)) ? s.msgs : [];
      const v = Math.max(0, Math.min(msgs.length, parseInt(e.target.value, 10) || 0));
      const lab = document.getElementById('fork-at-label');
      // 不写 state：分叉点只在点「创建分支」的那一刻读取，拖动中不落任何数据。
      if (lab) lab.textContent = forkOptionLabel(v, msgs);
    }
    if (e.target.dataset.action === 'think-slider') {
      const levels = ['off', 'standard', 'deep', 'max'];
      const labels = ['关闭', '标准', '深度', '最大'];
      const v = Math.max(0, Math.min(3, parseInt(e.target.value, 10) || 0));
      state.thinkLevel = levels[v];
      const tl = e.target.parentElement.querySelector('.tl');
      if (tl) tl.textContent = labels[v];
    }
  });
  document.body.addEventListener('change', (e) => {
    if (e.target.id === 'sblog-decision') {
      state.sandboxLog.decision = e.target.value || 'all';
      refreshSandboxLog();
      return;
    }
    if (e.target.id === 'sblog-kind') {
      state.sandboxLog.kind = e.target.value || 'all';
      refreshSandboxLog();
      return;
    }
    // 晋升审计过滤（PRD FR-10）。<select> 的 value 一定是字符串，故主进程侧
    // 的 ok 参数同时吃布尔与 'true'/'false'（只认布尔会让过滤静默失效）。
    if (e.target.id === 'mp-ok') {
      state.memoryPromotions.ok = e.target.value || 'all';
      refreshMemoryPromotions();
      return;
    }
    if (e.target.id === 'mp-type') updateProtocolRow();
    if (e.target.id === 'default-model-pick' && e.target.value !== state.defaultModel) {
      state.defaultModel = e.target.value;
      // R5-04：autoSelectModels 的第一优先是 localStorage 里的历史选择
      // （saved.every(has) 即早退）——常见路径下 selectedModels 原样返回，用户选的
      // 默认模型对实际发送（doSend 传 state.selectedModels）毫无影响，却 toast 成功。
      // 显式改默认模型时把选中集也切过去，让「默认」真的生效。
      // 去重后前插默认模型：长度有界（默认项只是被移到最前），不会因反复切换而无限增长
      state.selectedModels = [state.defaultModel, ...state.selectedModels.filter((n) => n !== state.defaultModel)];
      // 必须先落盘：autoSelectModels 的第一优先就是读 localStorage 的历史选择，
      // 不落盘的话它会在早退分支里把我们刚改的 selectedModels 原样覆盖回去。
      saveModelSelection(state.selectedModels);
      autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel);
      render();
      // P4-S3-09：静默保存改为有反馈。原实现 .catch(() => {}) 把失败吞掉，用户无从得知
      // 默认模型有没有生效（切换默认模型、拖迭代滑块两条路都是如此）。
      bridge.saveModelConfig({ providers: state.modelProviders, defaultProvider: state.defaultProvider, defaultModel: state.defaultModel })
        .then((r) => { if (r && r.ok) toast(`默认模型已设为「${state.defaultModel}」`, 'ok'); else toast(`默认模型未生效：${(r && r.reason) || '保存失败'}`, 'warn'); })
        .catch((err) => toast(`默认模型未生效：${(err && err.message) || err}`, 'warn'));
    }
    if (e.target.id === 'max-iter-pick') {
      state.maxToolIterations = Math.max(1, Math.min(500, parseInt(e.target.value) || 200));
      const valEl = $('#max-iter-val');
      if (valEl) valEl.textContent = state.maxToolIterations;
      bridge.saveModelConfig({ providers: state.modelProviders, defaultProvider: state.defaultProvider, defaultModel: state.defaultModel, maxToolIterations: state.maxToolIterations }).catch(() => {});
    }
  });

  /* ---------- 启动 ---------- */
  async function init() {
    console.log('[init] starting...', 'sessions:', Object.keys(state.sessions).length, 'projects:', state.projects.length);

    // P1.4：恢复隐式工作目录（轻会话默认 cwd，localStorage 持久化）
    state.workspaceDir = loadWorkspaceDir();

    // 立即渲染空壳（用户先看到界面，不等数据）
    render();

    // TRACE 上报状态（开关默认开；builtin = TOKEN 是否已加密内置）——fire-and-forget
    if (typeof bridge.traceStatus === 'function') {
      bridge.traceStatus().then((ts) => {
        state.traceEnabled = ts.enabled !== false;
        state.traceBuiltin = !!ts.builtin;
        updateTraceUi();
      }).catch(() => undefined);
    }

    // 第零步：加载项目分组（此前只加载会话 → 重启后项目全丢、会话退化为「任务」组）
    try {
      if (typeof bridge.loadProjects === 'function') {
        const remoteProjects = await bridge.loadProjects();
        if (Array.isArray(remoteProjects) && remoteProjects.length) {
          state.projects = remoteProjects.map((p) => ({ ...p, sessions: Array.isArray(p.sessions) ? p.sessions : [] }));
        }
      }
    } catch (err) { console.warn('[init] 项目分组加载失败:', err); }

    // 第一步：加载会话（决定走 wizard 还是主界面）
    try {
      const remote = await bridge.loadSessions();
      console.log('[init] loaded sessions:', remote.length);
      if (remote && remote.length) {
        state.sessions = {};
        remote.forEach((s) => { state.sessions[s.id] = s; });
        // 项目分组优先用落盘的成员关系，缺失时按 pid 重建（兼容旧数据）
        const known = new Set();
        state.projects.forEach((p) => { p.sessions.forEach((id) => known.add(id)); });
        state.projects.forEach((p) => {
          const owned = remote.filter((s) => s.pid === p.id).map((s) => s.id);
          p.sessions = p.sessions.filter((id) => state.sessions[id]);
          owned.forEach((id) => { if (!p.sessions.includes(id)) p.sessions.push(id); });
        });
        // 恢复 TRACE 反馈（此前反馈只存内存，刷新即丢）
        Object.values(state.sessions).forEach((s) => {
          if (Array.isArray(s.feedback)) s.feedback.forEach((k) => state.feedback.add(k));
        });
        if (!state.sessions[state.sel]) state.sel = remote[0].id;
      }
      console.log('[init] state.sel:', state.sel, 'total sessions:', Object.keys(state.sessions).length);
    } catch (err) { console.error('[init] error:', err); }

    // 订阅浏览器状态（ADR-0011）：Agent 在后台操作网页时，面板与标题栏状态点实时跟随。
    // 没有这个订阅，用户点开面板看到的永远是启动那一刻的快照。
    try {
      if (typeof bridge.onBrowserState === 'function') {
        bridge.onBrowserState((st) => {
          applyBrowserState(st);
          rerenderBrowserPanelIfOpen();
        });
      }
    } catch (err) { console.warn('[init] 浏览器状态订阅失败:', err); }

    // 订阅终端输出/退出（P2-10）：xterm 实例常驻，数据到达直接 write。
    try {
      if (typeof bridge.onTerminalData === 'function') {
        bridge.onTerminalData((ev) => {
          const h = termHandles.get(ev.id);
          if (!h) return; // 面板还没开：回放缓冲在主进程，重开 Tab 能补看
          if (h.term) h.term.write(ev.data);
          else if (h.pre) {
            // 降级 <pre> 路径：缓存到数组再 join。`textContent +=` 每次都要
            // 读出整个字符串再写回（O(n) 读 + O(n) 写），长会话会越敲越卡。
            h.lines = h.lines || [];
            h.lines.push(ev.data);
            let s = h.lines.join('');
            if (s.length > 400000) {
              s = s.slice(-200000);
              h.lines = [s];
            }
            h.pre.textContent = s;
            h.cont.scrollTop = h.cont.scrollHeight;
          }
        });
      }
      if (typeof bridge.onTerminalExit === 'function') {
        bridge.onTerminalExit((ev) => {
          const h = termHandles.get(ev.id);
          if (h && h.term) h.term.write(`\r\n\x1b[33m[orchdesk: 进程已退出，退出码 ${ev.code}]\x1b[0m\r\n`);
          else if (h && h.pre) {
            h.lines = h.lines || [];
            h.lines.push(`\n[orchdesk: 进程已退出，退出码 ${ev.code}]`);
            h.pre.textContent = h.lines.join('');
          }
          refreshTerminal();
        });
      }
    } catch (err) { console.warn('[init] 终端订阅失败:', err); }

    // 订阅工具执行步骤（此前主进程发 orchdesk:tool-step 但无人订阅 → 步骤条永远为空）
    try {
      if (typeof bridge.onToolStep === 'function') {
        // 渲染节流：文本兜底模式可一次解析多个工具连发 running/done，若每事件都刷新
        // 消息列表，毫秒窗口内会触发 2N 次 DOM 替换。合并到 ≤150ms 一次——只增量
        // 更新 #msgList，不整页 render（避免重建 composer / 侧栏）。
        function patchTypingMessage() {
          const list = $('#msgList');
          const s = (state.page === 'session' && state.sel) ? state.sessions[state.sel] : null;
          if (!list || !s) { updateMsgList(); return; }
          const typing = [...(s.msgs || [])].reverse().find((m) => (m.r === 'agent' || m.role === 'agent' || m.role === 'assistant') && m.typing);
          const node = list.querySelector('.msg.typing .md-body');
          if (!typing || !node) { updateMsgList(); return; }
          const wrap = document.createElement('div');
          wrap.innerHTML = renderMsg(typing, s.id);
          const next = wrap.querySelector('.md-body');
          if (!next) { updateMsgList(); return; }
          node.innerHTML = next.innerHTML;
          hardenActions(node);
          const sc = $('#msgScroll');
          if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80) sc.scrollTop = sc.scrollHeight;
        }
                let liveRenderTimer = null;
        const scheduleLiveRender = () => {
          if (liveRenderTimer) return;
          liveRenderTimer = setTimeout(() => {
            liveRenderTimer = null;
            patchTypingMessage();
            refreshCtxLive();
          }, 150);
        };
        bridge.onToolStep((step) => {
          const s = state.sessions[step.sessionId];
          if (!s || !step) return;
          state.toolSteps[step.sessionId] = state.toolSteps[step.sessionId] || [];
          const list = state.toolSteps[step.sessionId];
          if (step.ph === 'running') {
            list.push({ n: step.name, ph: 'running' });
          } else {
            const rec = [...list].reverse().find((x) => x.n === step.name && x.ph === 'running');
            if (rec) { rec.ph = step.ph; rec.result = step.result || ''; }
            else list.push({ n: step.name, ph: step.ph, result: step.result || '' });
          }
          if (state.sel === step.sessionId) scheduleLiveRender();
        });
        if (typeof bridge.onAgentDelta === 'function') {
          bridge.onAgentDelta((delta) => {
            const s = state.sessions[delta && delta.sessionId];
            if (!s || !delta || !delta.text) return;
            const typing = [...s.msgs].reverse().find((m) => (m.r === 'agent' || m.role === 'agent') && m.typing);
            if (!typing) return;
            typing.x = (typing.x || '') + delta.text;
            if (state.sel === delta.sessionId) scheduleLiveRender();
          });
        }
      }
    } catch (err) { console.warn('[init] 工具步骤订阅失败:', err); }

    // 第二步：并行加载所有元数据（互不依赖，同时发起）
    const results = await Promise.allSettled([
      // 授权
      bridge.getAuthMode().then(r => {
        if (r?.mode === 'bypass' || r?.mode === 'autopilot') state.authMode = r.mode;
      }).catch(() => {}),
      bridge.getAuthLevels().then((r) => {
        if (!Array.isArray(r)) { state.authzLoaded = false; return; }
        state.authzLoaded = true;
        if (r.length) state.authLevels = r;
      }).catch(() => { state.authzLoaded = false; }),
      // ④M-1：授权模式卡 + 白名单工具下拉数据化（canonical = 主进程 listGuiPermissionModes；加载后覆盖兜底文案）
      (typeof bridge.getAuthModes === 'function'
        ? bridge.getAuthModes().then((r) => {
            if (r && Array.isArray(r.modes)) {
              const ids = r.modes.map((m) => m && m.id);
              // 界面只认两档。宿主带回别的形态一律忽略，仍显示兜底两档。
              if (ids.length === 2 && ids[0] === 'bypass' && ids[1] === 'autopilot') state.authModes = r.modes;
            }
            if (r && Array.isArray(r.grantTools) && r.grantTools.length) state.grantTools = r.grantTools;
          })
        : Promise.resolve()).catch(() => {}),
      bridge.getAuthAudit().then(r => { if (Array.isArray(r)) state.authAudit = r; }).catch(() => {}),
      // 授权白名单（PRD FR-9）：真实规则列表（此前只有「单次」粒度，UI 无白名单可看）
      (typeof bridge.listGrants === 'function'
        ? bridge.listGrants().then(r => { if (Array.isArray(r)) state.grants = r; })
        : Promise.resolve()).catch(() => {}),
      // 提示词库
      bridge.listPrompts().then(r => { if (Array.isArray(r)) state.promptDocs = r; }).catch(() => {}),
      bridge.mergePrompts('main').then(r => { if (r?.conflicts) state.promptConflicts = r.conflicts; }).catch(() => {}),
      // 记忆 + 补偿 + 自进化
      bridge.getMemoryStats().then(r => {
        if (!r) return;
        state.memoryStats = r;
        // 四域真实计数（seg-tab 上显示的数字）。此前插件统计只被拉来存着，
        // 从没进过 UI —— 用户看不到 worker 域到底有没有东西。
        if (r.domainCounts && typeof r.domainCounts === 'object') state.memory.stats = r.domainCounts;
      }).catch(() => {}),
      bridge.getCompensationAudit().then(r => { state.compAuditLoaded = Array.isArray(r); if (Array.isArray(r)) state.compAudit = r; }).catch(() => { state.compAuditLoaded = false; }),
      // R5-13：networkAllow 非数组时兜底为空数组（全部拒绝），不再是 ['*']（悄悄放开全网）。
      // 原实现在主进程没返回白名单时把 UI 显示成「不限」，与同页「留空 = 全部拒绝
      // （fail-closed）」的说明直接矛盾——用户看到的和实际生效的是两回事。
      // mode 缺失时留空串（UI 走「未接入」分支），不用 'workspace-write' 冒充已拉取。
      bridge.getSandbox().then(r => {
        if (!r || typeof r !== 'object') return;
        state.sandbox = {
          mode: typeof r.mode === 'string' ? r.mode : '',
          // BUG-045：中文口径由主进程给出，渲染层不再自己映射（也拿不到机器标识白名单）。
          modeLabel: typeof r.modeLabel === 'string' ? r.modeLabel : '',
          networkAllow: Array.isArray(r.networkAllow) ? r.networkAllow : [],
          loaded: true,
        };
        render();
      }).catch(() => {}),
      // 数据目录内容清单（PRD FR-4.2）：真实体积与文件数（此前 UI 写死「~ 24 MB」）
      (typeof bridge.getDataDirInventory === 'function'
        ? bridge.getDataDirInventory().then(r => { if (r && typeof r === 'object') state.dataDirInventory = r; })
        : Promise.resolve()).catch(() => {}),
      // 沙箱日志（PRD FR-8 可检索）：每次刷新设置页都会重拉，见 refreshSandboxLog
      (typeof bridge.getSandboxLog === 'function'
        ? bridge.getSandboxLog(sandboxLogQuery()).then(r => { applySandboxLog(r); })
        : Promise.resolve()).catch(() => {}),
      // 桌面集成（PRD FR-4.2）：6 个开关的真实状态（此前 UI 硬编码 on/off，与系统无关）
      (typeof bridge.getDesktop === 'function'
        ? bridge.getDesktop().then(r => { if (r && r.config) state.desktop = r; })
        : Promise.resolve()).catch(() => {}),
      // P4-S2-5：临时插件列表的三态。原实现 catch(() => {}) 不置任何标志，侧栏跳转行
      // 和主区一律显示「暂无」——把「桥未接入/读取失败」说成「真的没有临时插件」
      // （本项目自己踩过三次的 null 当空数组坑）。
      bridge.listTempPlugins().then((r) => {
        // BUG-040④：主进程桥在 dsh 卸下后回的是 `{ok:false}`（Promise 正常 resolve，
        // 走不到 catch）。旧代码无条件把 loaded 置真，于是界面显示「暂无临时插件」——
        // 把「读取失败/未接入」说成「确实一个都没有」。只有真是数组才算加载成功。
        state.tempPluginsLoaded = Array.isArray(r);
        if (Array.isArray(r)) state.tempPlugins = r;
      }).catch(() => { state.tempPluginsLoaded = false; }),
      // 浏览器（ADR-0011）：启动即同步一次状态，标题栏入口才能如实显示开/关
      (typeof bridge.getBrowserStatus === 'function'
        ? bridge.getBrowserStatus().then(r => { applyBrowserState(r); })
        : Promise.resolve()).catch(() => {}),
      // P4：终端状态同样启动即同步。此前只有浏览器同步了，terminal.loaded 初值 false 且
      // refreshTerminal 只在用户首次打开面板/建会话/进程退出时才跑——冷启后终端图标一直
      // 置灰显示「未接入主进程」+ not-allowed 光标，而桥其实是好的、点击也能打开。
      // 把「已接入」持续显示成「未接入」是铁律里的「UI 不许撒谎」。
      (typeof bridge.terminalStatus === 'function'
        ? bridge.terminalStatus().then((st) => {
            if (st && typeof st === 'object') {
              state.terminal.loaded = true;
              state.terminal.ptyAvailable = !!st.ptyAvailable;
              state.terminal.via = st.via || state.terminal.via;
              if (Array.isArray(st.sessions)) state.terminal.sessions = st.sessions;
              renderStatusBarActions();
            }
          })
        : Promise.resolve()).catch(() => {}),
      // 插件运行时真实状态（插件页开关据此显示，而非硬编码的 p.on）
      (typeof bridge.getPluginRuntime === 'function'
        ? bridge.getPluginRuntime().then(r => { if (r) state.pluginRuntime = r; })
        : Promise.resolve()).catch(() => {}),
      // 编排目录（8 专家 + 3 团的真实数据，替代渲染层硬编码常量）
      (typeof bridge.getOrchestrationCatalog === 'function'
        ? bridge.getOrchestrationCatalog().then(r => {
            if (r && Array.isArray(r.experts) && r.experts.length) state.orchestrationCatalog = r;
            renderTrayHint();
          })
        : Promise.resolve()).catch(() => {}),
      // P2：本机 Ollama 自发现（composer 模型 chip 的零配置入口）。失败也置位——
      // chip 要能区分「探过没有」与「还没探」，不能把未探测显示成就绪。
      (typeof bridge.probeOllama === 'function'
        ? bridge.probeOllama().then((r) => {
            state.ollama = { ok: !!(r && r.ok), models: (r && r.models) || [], reason: (r && r.ok ? '' : ((r && r.reason) || '未探测到本机 Ollama')) };
            if (!state.ollama.ok) console.warn('[ollama] 自发现未命中：', state.ollama.reason);
          }).catch((err) => {
            state.ollama = { ok: false, models: [], reason: (err && err.message) || '探测异常' };
            console.warn('[ollama] 自发现异常：', state.ollama.reason);
          })
        : Promise.resolve()),
      // 模型管理
      bridge.getModelConfig().then(async (mc) => {
        if (mc && mc.providers && mc.providers.length) {
          state.modelProviders = mc.providers;
          dynamicModels.list = mc.providers.flatMap(p => p.models.map(n => ({ n, p: p.name + ' \u00b7 ' + p.type, k: '(本地)', state: '\u5df2\u914d' })));
          if (mc.defaultProvider) state.defaultProvider = mc.defaultProvider;
          state.defaultModel = mc.defaultModel;
          state.maxToolIterations = mc.maxToolIterations || 200;
          autoSelectModels(mc.providers, mc.defaultProvider, mc.defaultModel);
        } else {
          // BUG-015：桥接可用但无提供商时不要清空选择（可能是瞬时失败），
          // 交给 autoSelectModels 决定，避免「发送被拦死且无出路」。
          dynamicModels.list = [];
          autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel);
        }
      }).catch(() => { dynamicModels.list = []; autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel); }),
      // 观雅集
      bridge.guanjiTokenStatus().then(r => { state.guanjiTokenSet = !!(r && r.configured); }).catch(() => {}),
      bridge.guanjiList().then(r => { if (Array.isArray(r) && r.length) state.guanjiSkills = r; }).catch(() => {}),
      // 本地已安装技能（磁盘真实扫描；此前只存内存，重启即显示 0 个）
      refreshInstalledSkills(),
      // MCP（真接入）：真实 server 配置 + 连接状态 + 工具清单
      refreshMcp(),
      // Hub
      bridge.hubStatus().then(r => { if (r) state.hubStatus = r; }).catch(() => {}),
    ]);

    // 订阅审批弹窗
    if (bridge.onAuthRequest) {
      bridge.onAuthRequest((req) => { showApprovalModal(req); });
    }

    // 需求3：状态栏右下角图标区（浏览器 / 终端）在所有元数据到位后建一次，
    // 此时 loaded / open 已是真实值，图标才不会先闪一下「未接入」再点亮。
    renderStatusBarActions();
    renderBrowserSide();

    console.log('[init] parallel results:', results.map((r, i) => r.status === 'rejected' ? `${i}:FAIL` : `${i}:ok`).join(', '));

    // Final render
    if (!Object.keys(state.sessions).length) {
      console.log('[init] showing wizard (no sessions)');
      $('#wizard').classList.remove('hidden');
      renderWizard();
    } else {
      console.log('[init] rendering...');
      render();
    }
    // R5-01：状态栏不再向上游仓库要 commit。原实现每次冷启动 fetch
    // api.github.com/.../commits/main，把**上游 main 的最新 sha** 当作「OrchDesk Core」
    // 的版本显示——本地构建 / fork / 旧版本运行时，状态栏展示的并不是正在运行的代码；
    // 且这是模型 API 之外的云端依赖，违反「本地优先、离线可用」。项目自己已因同一模式
    // （无运行时背书的 commit 展示）修过向导和 statbar 两处，此处复发。
    // 现在只显示本地已知信息：主进程版本（拿不到就保持 index.html 的初值
    // 「OrchDesk Core」），不编造任何 commit。
    try {
      const el = $('#statusText');
      const v = typeof bridge.getAppVersion === 'function' ? await bridge.getAppVersion() : null;
      if (el && v && v.version) el.textContent = 'StepCode Desktop · v' + v.version;
    } catch { /* 拿不到本地版本就保持初值，不编造 */ }
    console.log('[init] done');
  }
  setInterval(() => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000);
  init();
})();
