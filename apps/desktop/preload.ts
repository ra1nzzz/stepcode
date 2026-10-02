import { contextBridge, ipcRenderer } from 'electron';

// ============================================================================
// OrchDesk 渲染进程 preload（上下文隔离桥）
// ----------------------------------------------------------------------------
// 红线：不在渲染进程暴露 nodeIntegration；只经 contextBridge 暴露白名单方法。
// API 签名一旦确定，后续 Phase 不得破坏性改动（加方法可以，改签名不行）。
// 渲染进程持有 UI 会话状态；主进程负责「持久化（load/persist）+ 模型回合」。
// ============================================================================

type Session = {
  id: string;
  pid: string;
  title: string;
  expert: string;
  model?: string;
  updated?: string;
  ts?: string;
  archived?: number;
  msgs: Array<Record<string, unknown>>;
};

const orchdesk = {
  /** 启动时拉取持久化会话；空数组代表首次运行（渲染进程回落种子数据）。 */
  loadSessions: (): Promise<Session[]> =>
    ipcRenderer.invoke('orchdesk:load-sessions'),

  /** 任意变更后落盘（主进程写 userData JSON，可重启回放）。 */
  persistSessions: (sessions: Session[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:persist-sessions', sessions),

  /** 项目分组：启动时拉取（此前缺失，重启后项目全丢）。 */
  loadProjects: (): Promise<Array<{ id: string; n?: string; sessions?: string[]; archived?: number }>> =>
    ipcRenderer.invoke('orchdesk:load-projects'),

  /** 项目分组：变更后落盘。 */
  persistProjects: (projects: Array<{ id: string; n?: string; sessions?: string[]; archived?: number }>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:persist-projects', projects),

  /** 工具执行步骤（主进程 step-session 实时推送；此前无订阅方，步骤条永远为空）。 */
  onToolStep: (cb: (step: { sessionId: string; name: string; ph: 'running' | 'done' | 'error'; result?: string }) => void): (() => void) => {
    const listener = (_e: unknown, step: { sessionId: string; name: string; ph: 'running' | 'done' | 'error'; result?: string }): void => cb(step);
    ipcRenderer.on('orchdesk:tool-step', listener);
    return () => ipcRenderer.removeListener('orchdesk:tool-step', listener);
  },

  /** 模型增量文本：typing 消息实时追加（JSON 整包一次；SSE 按 chunk）。 */
  onAgentDelta: (cb: (delta: { sessionId: string; text: string }) => void): (() => void) => {
    const listener = (_e: unknown, delta: { sessionId: string; text: string }): void => cb(delta);
    ipcRenderer.on('orchdesk:agent-delta', listener);
    return () => ipcRenderer.removeListener('orchdesk:agent-delta', listener);
  },

  /** 插件运行时：真实装载状态（替代渲染层硬编码常量）。 */
  getPluginRuntime: (): Promise<{ ready: boolean; activeCount: number; total: number; plugins: Array<{ name: string; active: boolean; available: boolean; error?: string }> }> =>
    ipcRenderer.invoke('orchdesk:plugin-runtime'),

  /** 插件真实热插拔（FR-3）：启用注册 effect，停用逆回滚。 */
  setPluginEnabled: (name: string, enabled: boolean): Promise<{ ok: boolean; active?: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:plugin-set-enabled', name, enabled),

  /** 编排目录（multi 插件）：8 专家 + 3 团的真实数据。 */
  getOrchestrationCatalog: (): Promise<{ experts?: unknown[]; teams?: unknown[] } | null> =>
    ipcRenderer.invoke('orchdesk:orchestration-catalog'),

  /** 专家团派发（multi composeTeam）：三层编排，返回 { rootId, nodes } 或 { error }。 */
  composeTeam: (teamId: string, task: string): Promise<{ error?: string; rootId?: string; nodes?: unknown[] }> =>
    ipcRenderer.invoke('orchdesk:compose-team', teamId, task),

  /** TRACE 上报状态：enabled（用户开关，默认开）+ builtin（TOKEN 是否已加密内置）。 */
  traceStatus: (): Promise<{ enabled: boolean; builtin: boolean }> =>
    ipcRenderer.invoke('orchdesk:trace-status'),

  /** TRACE 上报开关（重启生效：config 在插件装载时注入）。 */
  traceSetEnabled: (enabled: boolean): Promise<{ ok: boolean; reason?: string; requiresRestart?: boolean }> =>
    ipcRenderer.invoke('orchdesk:trace-set-enabled', enabled),

  /** 模型回合 seam：主进程在此接入真实 dsh ctx / Ollama（P1-5）。 */
  runAgentTurn: (
    sessionId: string,
    text: string,
    opts: { models?: string[]; thinkLevel?: string },
  ): Promise<{ text: string; intent: string }> =>
    ipcRenderer.invoke('orchdesk:run-agent-turn', sessionId, text, opts),

  /** 中止进行中的模型回合（composer「停止」）。无进行中回合时返回 ok:false。 */
  abortAgentTurn: (sessionId: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:abort-agent-turn', sessionId),

  /** 授权模式（T-P3-2）：读取当前生效的 GUI 档（bypass / autopilot）；Step 运行时未接入时拿不到值。 */
  getAuthMode: (): Promise<{ mode: string }> =>
    ipcRenderer.invoke('orchdesk:authz-get-mode'),

  /** 授权模式（T-P3-2）：切换模式（经 dsh sandbox/mode + approval/policy 持久化）。 */
  setAuthMode: (mode: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:authz-set-mode', mode),

  /** 授权分级（T-P3-2）：L0-L4 定义，供设置页/插件页展示。 */
  getAuthLevels: (): Promise<Array<{ level: number; label: string; scope: string; requiresApproval: boolean }>> =>
    ipcRenderer.invoke('orchdesk:authz-get-levels'),

  /**
   * ④M-1：授权模式卡 + 白名单工具下拉数据化（canonical = authz 插件 AUTHZ_MODES / GRANT_TOOLS）。
   * 此前渲染层硬编码 AUTH_MODES，trusted 文案已漂移（丢了「仍受 SandboxMode 约束」）。
   */
  getAuthModes: (): Promise<{ modes: Array<{ id: string; label: string; sandboxMode: string; approvalPolicy: string; blurb: string }>; grantTools: string[] }> =>
    ipcRenderer.invoke('orchdesk:authz-get-modes'),

  /** 授权审计日志（T-P3-2）：近期 approval/* + sandbox/mode 事件快照。 */
  getAuthAudit: (): Promise<Array<{ kind: string; ts: number; mode?: string; outcome?: string; toolName?: string; reason?: string }>> =>
    ipcRenderer.invoke('orchdesk:authz-get-audit'),

  // ---- PRD FR-9：授权白名单（操作类型 + 路径，会话 / 永久，可查看可撤销） ----
  listGrants: (): Promise<Array<{ id: string; tool: string; pattern: string; scope: 'session' | 'permanent'; sessionId?: string; createdAt: number; hits: number; note?: string }>> =>
    ipcRenderer.invoke('orchdesk:authz-list-grants'),

  /** 新增一条白名单规则（返回拒绝原因，不静默丢弃）。 */
  addGrant: (
    input: { tool: string; pattern: string; scope: 'session' | 'permanent'; sessionId?: string; note?: string },
  ): Promise<{ ok: boolean; reason?: string; rule?: Record<string, unknown>; grants?: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('orchdesk:authz-grant', input),

  revokeGrant: (id: string): Promise<{ ok: boolean; grants?: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('orchdesk:authz-revoke-grant', id),

  revokeAllGrants: (): Promise<{ ok: boolean; revoked?: number; grants?: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('orchdesk:authz-revoke-all-grants'),

  /** 审批弹窗（T-P3-2 fail-closed）：渲染层订阅主进程转发的 approval/request。 */
  onAuthRequest: (cb: (req: { id: string; toolName: string; reason?: string; target?: string; sessionId?: string }) => void): (() => void) => {
    const listener = (_e: unknown, req: { id: string; toolName: string; reason?: string; target?: string; sessionId?: string }): void => cb(req);
    ipcRenderer.on('orchdesk:authz-approval-request', listener);
    return () => ipcRenderer.removeListener('orchdesk:authz-approval-request', listener);
  },

  /** 审批弹窗（T-P3-2）：渲染层把用户决定回传主进程（allowed-once/rejected/cancelled）。 */
  submitDecision: (id: string, outcome: string): void => {
    ipcRenderer.send('orchdesk:authz-submit-decision', id, outcome);
  },

  // ---- T-P4-1/2 记忆 + 提示词库（dsh 服务 seam：ctx.memory / ctx.promptLib） ----
  /** 记忆统计（上下文占用 / 转储数 / 召回命中）。 */
  getMemoryStats: (): Promise<{ usageRatio: number; dumps: number; recallHits: number; domainCounts: Record<string, number> }> =>
    ipcRenderer.invoke('orchdesk:memory-stats'),

  /** 列某域记忆条目（FR-10 四域可查）。null = 服务不可用。 */
  listMemoryDomain: (domain: string): Promise<Array<{ id: string; text: string; origin: string; agent: string; createdAt: number }> | null> =>
    ipcRenderer.invoke('orchdesk:memory-list', domain),

  /** 单条晋升（worker 出域须过 Director 过滤）。 */
  promoteMemory: (input: { id: string; from: string; to: string }): Promise<{ ok: boolean; reason: string }> =>
    ipcRenderer.invoke('orchdesk:memory-promote', input),

  /** 批量晋升 worker 域（每条过 Director 过滤，分批上限见主进程）。 */
  promoteWorkerDomain: (to: string): Promise<{
    ok: boolean; total: number; attempted: number; promoted: number; rejected: number; remaining: number;
    reasons: Array<{ id: string; ok: boolean; reason: string }>;
  }> => ipcRenderer.invoke('orchdesk:memory-promote-worker', { to }),

  /** 晋升审计列表（含统计）。 */
  getMemoryPromotions: (query?: Record<string, unknown>): Promise<{
    entries: Array<Record<string, unknown>>; stats: Record<string, unknown>; total: number; max: number;
  }> => ipcRenderer.invoke('orchdesk:memory-promotions', query || {}),

  /** 清空晋升审计。 */
  clearMemoryPromotions: (): Promise<{ ok: boolean; cleared: number }> =>
    ipcRenderer.invoke('orchdesk:memory-promotions-clear'),

  /** 连接器列表（PRD FR-3）：目录 + 脱敏凭证回显 + 探测状态。 */
  getConnectors: (): Promise<{
    items: Array<Record<string, unknown>>;
    stats: { total: number; configured: number; tested: number; ok: number };
  }> => ipcRenderer.invoke('orchdesk:connectors'),

  /** 保存连接器凭证（保存即探测一次；脱敏回显值按「未改动」处理）。 */
  connectorSave: (id: string, creds: Record<string, string>): Promise<{
    ok: boolean; configured?: boolean; state?: Record<string, unknown> | null;
    probe?: { ok: boolean; message: string; manual?: boolean } | null; reason?: string;
  }> => ipcRenderer.invoke('orchdesk:connector-save', id, creds),

  /** 清除连接器凭证。 */
  connectorClear: (id: string): Promise<{ ok: boolean; state?: Record<string, unknown> | null; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:connector-clear', id),

  /** 用已存凭证重新探测连通性。 */
  connectorTest: (id: string): Promise<{
    ok: boolean; message?: string; manual?: boolean; state?: Record<string, unknown> | null; reason?: string;
  }> => ipcRenderer.invoke('orchdesk:connector-test', id),

  /** 连接器自动发现：从本机 CLI 登录态找该连接器是否已可用。只找不写盘。 */
  connectorDiscover: (id: string): Promise<{
    found: boolean; cred?: { connectorId: string; source: string; secret: string; identity?: string; usable: boolean; note?: string } | null; reason?: string;
  }> => ipcRenderer.invoke('orchdesk:connector-discover', id),

  /** 连接器审计。 */
  getConnectorAudit: (query?: Record<string, unknown>): Promise<{
    entries: Array<Record<string, unknown>>; stats: Record<string, unknown>; total: number; max: number;
  }> => ipcRenderer.invoke('orchdesk:connector-audit', query || {}),

  /** 清空连接器审计。 */
  clearConnectorAudit: (): Promise<{ ok: boolean; cleared: number }> =>
    ipcRenderer.invoke('orchdesk:connector-audit-clear'),

  // ---- MCP（Model Context Protocol）真接入 ----

  /** MCP 列表（含连接状态 + 工具清单）。 */
  mcpList: (): Promise<{
    ok: boolean; servers: Array<Record<string, unknown>>;
    stats: { total: number; configured: number; connected: number; tools: number };
    reason?: string;
  }> => ipcRenderer.invoke('orchdesk:mcp-list'),

  /** 保存一条 MCP 配置（保存即探测一次）。 */
  mcpSave: (config: Record<string, unknown>): Promise<{
    ok: boolean; configured?: boolean; state?: Record<string, unknown> | null;
    probe?: { ok: boolean; connected: boolean; tools?: Array<Record<string, unknown>>; reason?: string; latencyMs?: number } | null;
    reason?: string;
  }> => ipcRenderer.invoke('orchdesk:mcp-save', config),

  /** 删除一条 MCP 配置。 */
  mcpDelete: (id: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:mcp-delete', id),

  /** 启用 / 停用。 */
  mcpSetEnabled: (id: string, enabled: boolean): Promise<{ ok: boolean; state?: Record<string, unknown> | null; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:mcp-set-enabled', id, enabled),

  /** 用已存配置重新探测（拿最新工具清单）。 */
  mcpProbe: (id: string): Promise<{
    ok: boolean; state?: Record<string, unknown> | null;
    probe?: { ok: boolean; connected: boolean; tools?: Array<Record<string, unknown>>; reason?: string; latencyMs?: number } | null;
    reason?: string;
  }> => ipcRenderer.invoke('orchdesk:mcp-probe', id),

  /** 调用 MCP 工具（主会话 / Agent 复用）。 */
  mcpCallTool: (id: string, toolName: string, args: unknown): Promise<{
    ok: boolean; result?: unknown; isError?: boolean; reason?: string;
  }> => ipcRenderer.invoke('orchdesk:mcp-call-tool', id, toolName, args),

  /** 打开外部链接（http/https 白名单；渲染层 <a href> 会导航窗口，不能用）。 */
  openExternal: (url: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:open-external', url),

  /** 本地插件市场（PRD FR-3）：扫描 dataDir()/plugins（不执行插件代码）。 */
  getMarketPlugins: (): Promise<{ items: Array<Record<string, unknown>>; dir: string; count: number }> =>
    ipcRenderer.invoke('orchdesk:market-plugins'),

  /** 启用 / 停用本地市场插件（与内置插件同形的真热插拔）。 */
  setMarketPluginEnabled: (dir: string, enabled: boolean): Promise<{ ok: boolean; state?: Record<string, unknown>; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:market-toggle', dir, enabled),

  /** 打开本地插件目录（不存在则创建）。 */
  openMarketDir: (): Promise<{ ok: boolean; dir?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:market-open-dir'),

  // ---- 浏览器工具（ADR-0011：Electron 自带 CDP） ----
  /**
   * 浏览器状态：open=false 表示窗口未打开（不要显示成「空白页」）。
   * lastShot.dataUrl 是 JPEG 缩略图（data URL），供面板预览；path 是 PNG 绝对路径。
   */
  getBrowserStatus: (): Promise<{
    open: boolean; url?: string; title?: string; visible?: boolean;
    lastShot?: { path: string; dataUrl?: string } | null; lastError?: string; shotsDir?: string;
    /** 页面快照 TAB（单窗口模型下的「访问过的页面」登记簿，最新在前）。 */
    pages?: Array<{ id: string; url: string; title: string; shot?: string; at: number; active: boolean }>;
  }> => ipcRenderer.invoke('orchdesk:browser-status'),

  /** 显示 / 隐藏浏览器窗口（Agent 默认在后台窗口操作，用户可随时调出来看）。 */
  setBrowserVisible: (visible: boolean): Promise<{ ok: boolean; state?: Record<string, unknown> }> =>
    ipcRenderer.invoke('orchdesk:browser-toggle-visible', visible),

  /** 关闭浏览器窗口（用户侧紧急制动）。 */
  closeBrowser: (): Promise<{ ok: boolean; closed: boolean; state?: Record<string, unknown> }> =>
    ipcRenderer.invoke('orchdesk:browser-close'),

  /**
   * 关闭单个页面快照 TAB（侧栏卡片的「×」）。
   * 关的是**卡片**不是窗口——底层只有一个隐藏窗口，关活跃卡才会连带收起窗口。
   */
  closeBrowserPage: (id: string): Promise<{ ok: boolean; reason?: string; state?: Record<string, unknown> }> =>
    ipcRenderer.invoke('orchdesk:browser-close-page', id),

  /** 关闭全部页面快照 TAB（侧栏「全部关闭」）：清空登记簿并收起窗口。 */
  clearBrowserPages: (): Promise<{ ok: boolean; state?: Record<string, unknown> }> =>
    ipcRenderer.invoke('orchdesk:browser-clear-pages'),

  /**
   * 用户亲手把窗口切到某个已访问过的页面（侧栏点 TAB 卡片）。
   * 用户操作不走授权门，但主进程侧强制 SSRF 主机黑名单（isBlockedHost：内网/回环/
   * 元数据一律拒绝）并记沙箱日志——不假设 URL 一定来自 Agent：bridge 暴露给页面
   * 全局，被攻陷的渲染层传任意 URL 也到不了内网（R4-1）。
   */
  browserGoto: (url: string): Promise<{ ok: boolean; reason?: string; state?: Record<string, unknown> }> =>
    ipcRenderer.invoke('orchdesk:browser-goto', url),

  /** 在系统文件管理器中打开截图目录。 */
  openBrowserShotDir: (): Promise<{ ok: boolean; dir?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:browser-open-shot-dir'),

  /** 浏览器状态推送（Agent 操作网页时面板实时更新）。 */
  onBrowserState: (cb: (st: {
    open: boolean; url?: string; title?: string; visible?: boolean;
    lastShot?: { path: string; dataUrl?: string } | null; lastError?: string;
  }) => void): (() => void) => {
    const listener = (_e: unknown, st: {
      open: boolean; url?: string; title?: string; visible?: boolean;
      lastShot?: { path: string; dataUrl?: string } | null; lastError?: string;
    }): void => cb(st);
    ipcRenderer.on('orchdesk:browser-state', listener);
    return () => ipcRenderer.removeListener('orchdesk:browser-state', listener);
  },

  // ---- 终端（PTY）Tab（吸收计划 P2-10） ----
  /** 创建终端会话；result.via='pipe' 表示降级（渲染层必须显示管道模式提示）。 */
  terminalCreate: (input?: { cwd?: string; cols?: number; rows?: number }): Promise<{
    ok: boolean; reason?: string; session?: { id: string; pid: number; shell: string; cwd: string; via: 'pty' | 'pipe' };
  }> => ipcRenderer.invoke('orchdesk:terminal-create', input || {}),

  /** 写入用户键入（键盘事件直通）。 */
  terminalWrite: (id: string, data: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:terminal-write', id, data),

  /** 调整尺寸（管道模式 no-op）。 */
  terminalResize: (id: string, cols: number, rows: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:terminal-resize', id, cols, rows),

  /** 关闭会话（幂等）。 */
  terminalKill: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:terminal-kill', id),

  /** 全量状态：Tab 栏数据源 + 每会话回放缓冲。ptyAvailable=false = 管道模式。 */
  terminalStatus: (): Promise<{
    ptyAvailable: boolean; via: 'pty' | 'pipe'; count: number;
    sessions: Array<{ id: string; pid: number; shell: string; cwd: string; via: 'pty' | 'pipe'; exited: boolean; exitCode?: number; replay: string }>;
  }> => ipcRenderer.invoke('orchdesk:terminal-status'),

  /** 终端输出推送（主进程已攒批节流）。 */
  onTerminalData: (cb: (ev: { id: string; data: string }) => void): (() => void) => {
    const listener = (_e: unknown, ev: { id: string; data: string }): void => cb(ev);
    ipcRenderer.on('orchdesk:terminal-data', listener);
    return () => ipcRenderer.removeListener('orchdesk:terminal-data', listener);
  },

  /** 终端退出推送（Tab 保留为已退出状态，可回看输出）。 */
  onTerminalExit: (cb: (ev: { id: string; code: number }) => void): (() => void) => {
    const listener = (_e: unknown, ev: { id: string; code: number }): void => cb(ev);
    ipcRenderer.on('orchdesk:terminal-exit', listener);
    return () => ipcRenderer.removeListener('orchdesk:terminal-exit', listener);
  },

  // ---- 文件 Tab（吸收计划 P2-11，只读优先） ----
  /** 列一层目录（渲染层懒加载逐层展开）；truncated=条目超上限被裁。 */
  fileTree: (dir: string): Promise<{
    ok: boolean; reason?: string; dir?: string; truncated?: boolean; total?: number;
    entries?: Array<{ name: string; kind: 'file' | 'dir'; size: number; mtime: number; ext: string; binary: boolean }>;
  }> => ipcRenderer.invoke('orchdesk:file-tree', { dir }),

  /** 读文件（≤2MB，超出显式 truncated；二进制只给元信息不吐内容）。
   *  editable/binary/truncated/encodingSuspicious 由主进程统一判定，渲染层不猜。 */
  fileRead: (path: string): Promise<{
    ok: boolean; reason?: string; path?: string; binary?: boolean; truncated?: boolean;
    size?: number; sizeLabel?: string; lang?: string | null; content?: string;
    mtimeMs?: number; encodingSuspicious?: boolean; editable?: boolean;
  }> => ipcRenderer.invoke('orchdesk:file-read', { path }),

  /** 写回文件（P3 用户亲手编辑；带读取时 mtime 做乐观并发检查，
   *  外部修改过返回 code='modified-externally'，渲染层提示重新加载）。 */
  fileWrite: (path: string, content: string, expectedMtimeMs: number): Promise<{
    ok: boolean; reason?: string; code?: string;
    path?: string; size?: number; sizeLabel?: string; mtimeMs?: number;
  }> => ipcRenderer.invoke('orchdesk:file-write', { path, content, expectedMtimeMs }),

  // ---- FR-6 SessionEvent 事件流（ADR-0009） ----
  /** 会话回放数据源：事件流时间线（沿血缘链拼接）；source='legacy' = 历史会话无事件日志。 */
  getSessionEvents: (sid: string): Promise<{
    ok: boolean; source: 'event-log' | 'legacy'; count: number;
    timeline: Array<{ seq: string; kind: string; label: string; detail: string; ts: string }>;
    context?: Array<{ role: 'user' | 'assistant'; text: string }>;
    reason?: string;
  }> => ipcRenderer.invoke('orchdesk:session-events', sid),

  /** 分叉落事件：子日志写一条 fork-origin 血缘（append-only，不拷贝父事件）。 */
  appendForkEvent: (payload: { newId: string; from: string; fromTitle?: string; atIndex: number; at?: number }): Promise<{ ok: boolean; count?: number; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:fork-event', payload),

  // ---- FR-5 用量追踪 ----
  /** 模型用量聚合（按模型 / 按会话 / 合计；只统计真实上报过 usage 的回合）。 */
  getUsage: (): Promise<{
    ok: boolean; reason?: string;
    total: { promptTokens: number; completionTokens: number; totalTokens: number; turns: number };
    byModel: Array<{ model: string; promptTokens: number; completionTokens: number; totalTokens: number; turns: number }>;
    bySession: Array<{ sessionId: string; totalTokens: number; turns: number }>;
  }> => ipcRenderer.invoke('orchdesk:usage'),

  /** 清空用量记账。 */
  clearUsage: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:usage-clear'),

  /** 当前记忆摘要方式（llm = 模型摘要；extractive = 抽取式兜底）。 */
  getMemorySummarizeStatus: (): Promise<{ seam: boolean; provider: string; model: string; mode: 'llm' | 'extractive' }> =>
    ipcRenderer.invoke('orchdesk:memory-summarize-status'),

  /** 提示词库列表。 */
  listPrompts: (): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke('orchdesk:prompt-list'),

  /** 合并类别提示词（按 agentId；返回 sections 与显式冲突列表，无 ok 包层）。 */
  mergePrompts: (agentId: string): Promise<{ sections: Array<Record<string, unknown>>; conflicts: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('orchdesk:prompt-merge', agentId),

  /** 保存单个提示词。 */
  savePrompt: (doc: Record<string, unknown>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:prompt-save', doc),

  /** 删除单个提示词。 */
  deletePrompt: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:prompt-delete', id),

  // ---- T-P5-1 补偿层（dsh 服务 seam：ctx.compensation） ----
  /** 外发预判（composer「不可撤销」警示条）。 */
  withhold: (text: string): Promise<{ needsConfirm: boolean; category: string; reason: string; warning: string }> =>
    ipcRenderer.invoke('orchdesk:comp-withhold', text),

  // ---- PRD FR-8 沙箱 ----
  /** 沙箱策略快照（模式 + 网络域名白名单）。 */
  getSandbox: (): Promise<{ mode: string; modeLabel: string; networkAllow: string[] }> =>
    ipcRenderer.invoke('orchdesk:sandbox-get'),

  /** 设置网络请求域名白名单（['*'] = 不限）。 */
  setNetworkAllow: (list: string[]): Promise<{ ok: boolean; reason?: string; networkAllow?: string[] }> =>
    ipcRenderer.invoke('orchdesk:sandbox-set-network-allow', list),

  // ---- PRD FR-8 沙箱日志（可检索） ----
  /**
   * 检索沙箱判定日志（默认返回最新 200 条 + 统计）。
   * keyword 按 tool / target / reason / sessionId 大小写不敏感匹配；决策与类型可过滤。
   */
  getSandboxLog: (query?: {
    keyword?: string;
    decision?: 'allowed' | 'denied' | 'error' | 'all';
    kind?: 'path' | 'command' | 'network' | 'approval' | 'outbound' | 'config' | 'all';
    limit?: number;
  }): Promise<{
    entries: Array<{ id: string; ts: number; tool: string; kind: string; target: string; decision: string; reason?: string; mode?: string; sessionId?: string }>;
    stats: { total: number; allowed: number; denied: number; error: number; byTool: Array<{ tool: string; count: number }> };
    total: number;
    max: number;
  }> => ipcRenderer.invoke('orchdesk:sandbox-log', query || {}),

  /** 清空沙箱日志（返回被清掉的条数）。 */
  clearSandboxLog: (): Promise<{ ok: boolean; cleared: number; entries: unknown[]; stats: { total: number; allowed: number; denied: number; error: number; byTool: unknown[] } }> =>
    ipcRenderer.invoke('orchdesk:sandbox-log-clear'),

  // ---- PRD FR-4.2 桌面集成（托盘 / 快捷键 / 自启动 / 更新 / 悬浮窗 / 通知） ----
  /** 桌面集成开关快照（含快捷键读法与自启动的**系统实际**状态）。 */
  getDesktop: (): Promise<{
    config: Record<string, boolean>;
    shortcutLabel: string;
    labels: Record<string, string>;
    autostartEffective: boolean;
  }> => ipcRenderer.invoke('orchdesk:desktop-get'),

  /** 切换单个桌面集成开关（返回落盘后的完整配置）。 */
  setDesktop: (
    key: string,
    value: boolean,
  ): Promise<{ ok: boolean; reason?: string; warning?: string; changed?: boolean; config?: Record<string, boolean>; autostartEffective?: boolean }> =>
    ipcRenderer.invoke('orchdesk:desktop-set', key, value),

  /** 悬浮窗上下文：切换会话时推送（主进程不猜「当前会话」）。 */
  setFloatingContext: (ctx: { title?: string; sessions?: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:desktop-floating-context', ctx),

  /** TRACE 用户反馈（PRD FR-7）：每条 Agent 消息底部标记 → 脱敏入遥测队列。 */
  traceFeedback: (
    payload: { intent?: string; feedback?: 'positive' | 'neutral' | 'negative'; sessionKey?: string; messageKey?: string },
  ): Promise<{ ok: boolean; reason?: string; queue?: { pending: number; retry: number; errors: number } }> =>
    ipcRenderer.invoke('orchdesk:trace-feedback', payload),

  /** 记录补偿动作。 */
  compensate: (text: string, note?: string): Promise<{ id: string; category: string; action: string; ts: number }> =>
    ipcRenderer.invoke('orchdesk:comp-compensate', text, note),

  /** 补偿层审计快照。 */
  getCompensationAudit: (): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke('orchdesk:comp-audit'),

  // ---- T-P5-2 自进化（dsh 服务 seam：ctx.evolution；临时插件仅驻内存） ----
  /** 创建临时插件（静态门控 + CONFIRM，仅驻内存）。 */
  createTempPlugin: (spec: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:evol-create', spec),

  /** 当前驻内存临时插件列表。 */
  listTempPlugins: (): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke('orchdesk:evol-list'),

  /** 卸载临时插件。 */
  disposeTempPlugin: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:evol-dispose', id),

  // ---- T-P6-1 观雅集技能市场（复用 guanji SKILL API 约定；TOKEN 由用户配置） ----
  /** TOKEN 配置状态（不返回明文）。 */
  guanjiTokenStatus: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('orchdesk:guanji-token-status'),

  /** 用户配置观雅集 TOKEN（来自登录后 GET /api/auth/token 的结果）。 */
  guanjiSetToken: (token: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:guanji-set-token', token),

  /** 拉取观雅集真实技能列表（最近上新 + 精品推送合并去重）。 */
  guanjiList: (): Promise<Array<{ slug: string; name: string; description: string; caps: string[]; auth: 0 | 1 }>> =>
    ipcRenderer.invoke('orchdesk:guanji-list'),

  /** 安装技能（主进程先做能力审查；auth=1 需 authorized=true 显式授权后放行）。 */
  guanjiInstall: (skill: { slug: string; name: string; description: string; caps: string[]; auth: 0 | 1 }, authorized = false): Promise<{ ok: boolean; review: string; reason?: string; path?: string }> =>
    ipcRenderer.invoke('orchdesk:guanji-install', skill, authorized),

  /** 发布技能到观雅集（用户登录后）。 */
  guanjiPublish: (input: { slug: string; alias?: string; filePath: string }): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:guanji-publish', input),

  /** 本地已安装技能（真实扫描数据目录/skills；ok=false = 扫描失败，不等于「没装」）。 */
  listInstalledSkills: (): Promise<{ ok: boolean; items: Array<{ slug: string; bytes: number; installedAt: number }>; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:skills-installed'),

  /** 卸载本地技能包（真删文件；slug 走目录名白名单，防路径穿越）。 */
  uninstallSkill: (slug: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:skill-uninstall', slug),

  // ---- T-P6-2 OrchClaw Hub 联调（配对凭据经 safeStorage 加密存储） ----
  /** 当前配对状态。 */
  hubStatus: (): Promise<{ paired: boolean; url?: string; agentName?: string }> =>
    ipcRenderer.invoke('orchdesk:hub-status'),

  /** 配对远程 Agent。 */
  hubPair: (url: string, token: string): Promise<{ ok: boolean; reason?: string; handle?: string; agentName?: string }> =>
    ipcRenderer.invoke('orchdesk:hub-pair', url, token),

  /** 主会话向远程 Agent 发任务。 */
  hubSend: (text: string): Promise<{ ok: boolean; reason?: string; taskId?: string }> =>
    ipcRenderer.invoke('orchdesk:hub-send', text),

  /** 回传远程 Agent 结果。 */
  hubResult: (taskId: string): Promise<{ status: string; result?: string }> =>
    ipcRenderer.invoke('orchdesk:hub-result', taskId),

  // ---- T-P5/T-P6 数据快照 + 更新检查 ----
  snapshotData: (): Promise<{ ok: boolean; dir?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:snapshot-data'),
  checkUpdates: (): Promise<{ snapshot: { ok: boolean; dir?: string }; update?: { available: boolean; version?: string; note?: string }; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:check-updates'),
  /**
   * 用系统默认文件管理器打开目录。
   * 传 `boundPath` = 打开该项目绑定的本地文件夹（项目 `··` 菜单）；
   * 不传 = 打开数据目录（设置页）。BUG-022：旧签名无参，项目绑定路径传不进来。
   */
  openProjectDir: (
    boundPath?: string,
  ): Promise<{ ok: boolean; path?: string; source?: 'bound' | 'data'; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:open-project-dir', boundPath),

  /**
   * 设置会话工作区（BUG-023）：把项目绑定目录设为该会话的默认 cwd。
   * 渲染层在「创建会话 / 打开会话 / 重选项目 / 分叉」时驱动（主进程 Map 重启即失）。
   */
  setSessionCwd: (
    sessionId: string,
    dir: string,
  ): Promise<{ ok: boolean; path?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:set-session-cwd', sessionId, dir),

  /** 打开文件夹选择对话框 */
  pickFolder: (): Promise<{ ok: boolean; path?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:pick-folder'),

  /** 打开日志目录（模型调用 / 插件加载诊断留痕）。 */
  openLogDir: (): Promise<{ ok: boolean; file?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:open-log-dir'),

  /** PRD FR-4.2「数据目录 · 内容清单」：真实扫描结果（此前 UI 写死「~ 24 MB」）。 */
  getDataDirInventory: (): Promise<{
    ok: boolean;
    dir: string;
    items: Array<{ name: string; size: number; kind: 'file' | 'dir'; files: number; mtime: number }>;
    totalSize: number;
    totalFiles: number;
    errors: string[];
    reason?: string;
  }> => ipcRenderer.invoke('orchdesk:data-dir-inventory'),

  /** 导出全部业务数据到用户选择的 JSON 备份文件（BUG-013 方案 B）。 */
  exportData: (): Promise<{ ok: boolean; path?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:export-data'),

  /** 从备份 JSON 导入（与启动迁移同一套「只补齐不覆盖」合并策略）。 */
  importData: (): Promise<{ ok: boolean; imported?: Record<string, number>; notes?: string[]; path?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:import-data'),

  // ---- FR-5 模型管理（配置持久化 + 连通性测试） ----
  /** 取模型配置（不含明文 API Key）。 */
  getModelConfig: (): Promise<{ providers: Array<{ id: string; name: string; type: string; baseUrl: string; models: string[] }>; defaultProvider?: string }> =>
    ipcRenderer.invoke('orchdesk:models-get'),
  /** 保存模型配置（API Key 经 safeStorage 加密）。 */
  saveModelConfig: (config: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:models-save', config),
  /** 测试模型连通性。 */
  testModel: (providerId: string, model: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> =>
    ipcRenderer.invoke('orchdesk:models-test', providerId, model),
  /** R5-01：本地应用版本（状态栏显示「OrchDesk Core · v<x>」；不再向上游仓库要 commit）。 */
  getAppVersion: (): Promise<{ version: string }> =>
    ipcRenderer.invoke('orchdesk:app-version'),
  /** models.dev 目录预设（添加提供商表单的“预设”可搜索下拉数据源；缓存 TTL 24h）。 */
  getModelCatalog: (): Promise<{ ok: boolean; providers: Array<{ id: string; name: string; api?: string; modelCount: number }>; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:models-catalog'),
  /** 拉取提供商可用模型（live 优先：提供商 /models + KEY；失败回退 models.dev 目录）。 */
  listModels: (input: { type: string; baseUrl: string; apiKey?: string; presetId?: string }): Promise<
    | { ok: true; source: 'live' | 'catalog' | 'mixed'; models: Array<{ id: string; name?: string; ctx?: number; priceIn?: number; priceOut?: number; caps?: string[]; enriched?: boolean }>; matched?: { id: string; name: string; api?: string } }
    | { ok: false; reason: string }
  > =>
    ipcRenderer.invoke('orchdesk:models-list', input),
  /** P2：本机 Ollama 自发现（composer 模型 chip 零配置入口；主进程代查 127.0.0.1:11434）。 */
  probeOllama: (): Promise<{ ok: boolean; models: string[]; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:ollama-probe'),
};

contextBridge.exposeInMainWorld('orchdesk', orchdesk);
