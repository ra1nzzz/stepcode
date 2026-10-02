/**
 * 无主进程桥接（浏览器预览 / e2e）时的 bridge 空壳——app.js 与 e2e-fix-verify
 * 共用同一份语义定义（审查项④：双源合并）。app.js 在 window.orchdesk 缺失时以
 * Proxy 包装本对象（未知名方法兜底「未接入」Promise）；e2e 经 addInitScript
 * 加载本文件后再叠加自己的种子数据。
 * 契约：没有宿主的字段一律答「不可用」，不得用假数据冒充已接入。
 */
const AUTH_MODES_STUB = [
  { id: 'bypass', label: '默认模式', blurb: '普通工具直接运行。危险命令仍由本界面确认。' },
  { id: 'autopilot', label: '完全信任', blurb: '普通工具直接运行，并在模型短暂失败后续跑。危险命令仍由本界面确认。' },
];
window.orchdeskBridgeStub = {
      loadSessions: () => Promise.resolve([]),
      persistSessions: (arr) => Promise.resolve({ ok: false, reason: '未连接主进程' }),
      runAgentTurn: (sessionId, text, opts) => Promise.resolve({ text: '未连接主进程运行时，无法调用模型。请在设置中配置模型提供商。', intent: 'CONFIRM' }),
      abortAgentTurn: () => Promise.resolve({ ok: false, reason: '未连接主进程' }),
      onAgentDelta: () => () => {},
      // 授权：无主进程桥接时不虚构当前档，界面显示「未接入」。
      getAuthMode: () => Promise.resolve({ unavailable: true, reason: '主进程未接入' }),
      setAuthMode: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      getAuthLevels: () => Promise.resolve(null),
      getAuthAudit: () => Promise.resolve(null),
      getAuthModes: () => Promise.resolve({ modes: AUTH_MODES_STUB.map((m) => ({ ...m })), grantTools: [] }),
      onAuthRequest: () => () => {},
      submitDecision: () => {},
      // 授权白名单（PRD FR-9）
      listGrants: () => Promise.resolve([]),
      addGrant: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      revokeGrant: () => Promise.resolve({ ok: false }),
      revokeAllGrants: () => Promise.resolve({ ok: false, revoked: 0 }),
      // 提示词库
      listPrompts: () => Promise.resolve([]),
      mergePrompts: () => Promise.resolve({ sections: [], conflicts: [] }),
      savePrompt: () => Promise.resolve({ ok: false }),
      deletePrompt: () => Promise.resolve({ ok: false }),
      // 记忆
      getMemoryStats: () => Promise.resolve(null),
      // TRACE 用户反馈（PRD FR-7）
      traceFeedback: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      // 沙箱（PRD FR-8）
      getSandbox: () => Promise.resolve({ mode: 'workspace-write', modeLabel: '工作区内可写', networkAllow: [] }),
      setNetworkAllow: (list) => Promise.resolve({ ok: false, reason: '主进程未接入', networkAllow: list }),
      // PRD FR-8：沙箱日志检索（无桥时返回 null → loaded 保持 false，UI 标注未接入
      // 而不是假装「空日志」—— 这两种状态的处置完全不同）
      getSandboxLog: () => Promise.resolve(null),
      clearSandboxLog: () => Promise.resolve({ ok: false, cleared: 0 }),
      // PRD FR-4.2：数据目录内容清单（无桥时 ok=false，UI 不显示假体积）
      getDataDirInventory: () => Promise.resolve({ ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] }),
      // 桌面集成（PRD FR-4.2）：无桥时 config 为 null → 开关降级为不可点并标注
      getDesktop: () => Promise.resolve({ config: null, shortcutLabel: 'Ctrl+Shift+Space', labels: {}, autostartEffective: false }),
      setDesktop: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      setFloatingContext: () => Promise.resolve({ ok: false }),
      // 补偿层
      withhold: (text) => Promise.resolve({ needsConfirm: false, category: 'other', reason: '', warning: '' }),
      // FR-6 事件流（ADR-0009）：无桥 → null，回放回退消息数组并标注「事件流未接入」
      getSessionEvents: () => Promise.resolve(null),
      appendForkEvent: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      // FR-5 用量追踪：无桥 → null，UI 标注「未接入」而非假 0
      getUsage: () => Promise.resolve(null),
      clearUsage: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      compensate: (text, note) => Promise.resolve({ id: 'cmp-' + Date.now().toString(36), ts: Date.now(), text: (text || '').slice(0, 80), note: note || '', action: '记录操作以便审计追溯' }),
      getCompensationAudit: () => Promise.resolve([]),
      createTempPlugin: (spec) => Promise.resolve({ ok: false, reason: '主进程未接入（P1-5 seam）' }),
      listTempPlugins: () => Promise.resolve([]),
      disposeTempPlugin: (id) => Promise.resolve(false),
      guanjiTokenStatus: () => Promise.resolve({ configured: false }),
      guanjiSetToken: () => Promise.resolve({ ok: false }),
      guanjiList: () => Promise.resolve(SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }))),
      guanjiInstall: (skill) => skill && skill.auth ? Promise.resolve({ ok: false, review: 'needs-auth', reason: '需配置观雅集 TOKEN' }) : Promise.resolve({ ok: true, review: 'allowed' }),
      guanjiPublish: () => Promise.resolve({ ok: false, reason: '需配置观雅集 TOKEN' }),
      // 本地已安装技能：无桥 → ok:false（UI 标注「未接入」），不能用空数组冒充「已扫描但没装」
      listInstalledSkills: () => Promise.resolve({ ok: false, items: [], reason: '主进程未接入' }),
      uninstallSkill: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      hubStatus: () => Promise.resolve({ paired: false }),
      hubPair: () => Promise.resolve({ ok: false, reason: '未配对' }),
      hubSend: () => Promise.resolve({ ok: false, reason: '未配对' }),
      hubResult: () => Promise.resolve({ status: 'error', result: '未配对' }),
      snapshotData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      checkUpdates: () => Promise.resolve({ snapshot: { ok: false }, update: { available: false, note: '未接入' } }),
      exportData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      importData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      openLogDir: () => Promise.resolve({ ok: false, reason: '未接入' }),
      // 浏览器（ADR-0011）：无桥时返回 open:false —— 面板据此显示「未接入」，
      // 不能用「空白页 / 0 张截图」冒充「浏览器已就绪只是没开」。
      getBrowserStatus: () => Promise.resolve({ open: false }),
      setBrowserVisible: () => Promise.resolve({ ok: false }),
      closeBrowser: () => Promise.resolve({ ok: false, closed: false }),
      openBrowserShotDir: () => Promise.resolve({ ok: false, reason: '未接入' }),
      onBrowserState: () => () => {},
      // 终端（P2-10）：无桥 → null，面板显示「未接入」而不是「0 个会话」
      terminalCreate: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      terminalWrite: () => Promise.resolve({ ok: false }),
      terminalResize: () => Promise.resolve({ ok: false }),
      terminalKill: () => Promise.resolve({ ok: false }),
      terminalStatus: () => Promise.resolve(null),
      onTerminalData: () => () => {},
      onTerminalExit: () => () => {},
      // 文件（P2-11）：无桥 → bridgeMissing 标记。不能用 `typeof fn !== 'function'`
      // 判「未接入」——stub 本身也是函数，那样永远显示成「空目录」。
      fileTree: () => Promise.resolve({ ok: false, reason: '主进程未接入', bridgeMissing: true }),
      fileRead: () => Promise.resolve({ ok: false, reason: '主进程未接入', bridgeMissing: true }),
      fileWrite: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      // P2 模型内嵌：本机 Ollama 自发现。无桥时 ok=false（chip 显示「未配置模型」），
      // 不用空数组冒充「探过但没装」——两者对用户的下一步动作完全不同。
      probeOllama: () => Promise.resolve({ ok: false, models: [], reason: '主进程未接入' }),
      // R5-01：预览态拿不到本地版本 → 返回空，状态栏保持初值「StepCode Desktop」，不编造
      getAppVersion: () => Promise.resolve({ version: '' }),
    };
