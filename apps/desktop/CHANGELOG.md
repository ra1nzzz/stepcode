# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.16.0] - 2026-09-08

### Added
- **phase8**: Canonical event emission + SSE/WS consumer + docs

### Fixed
- **events**: 非消息 canonical 事件不落本地消息流（修复 Phase 8 回归）


## [0.15.1] - 2026-09-07

### Fixed
- **plugins**: 插件页面整体梳理（安装态/侧栏导航/padding/内部标识/死按钮）


## [0.15.0] - 2026-09-06

### Added
- **connector**: 连接器 CLI 登录态自动发现（github 从 ~/.git-credentials / gh 识别，只回填不自动写盘）
- **ui**: UI/UX 前端收敛（对比度 / 键盘可达 / 硬编码色 / 插件&SKILL 搜索 / 设置页导航 / 响应式）
- **mcp**: MCP 真接入（零依赖 stdio 客户端，替换「能力」TAB 的假 MCP 分组）
- **ui**: 右栏「技能与MCP」→「能力」（插件/技能/MCP 三组，均改取真数据源）
- **ui**: 待办语义化 + 侧栏重构（文件TAB/浏览器侧栏/终端抽屉）+ 思考链展开


## [0.14.0] - 2026-09-04

### Added
- 委派树展示 composeTeam 执行结果（task/产出/状态），②真执行 UI 闭环

### Changed
- **dsh-runtime**: 插件装载三样板收敛 + startRuntime 竞态修复（⑤）
- **audit**: canonical 去重 + authz 模式数据通道（④H+M）

### Fixed
- 全项目多维审验③ 无界内存队列加固（trace/memory/multi 三插件）
- 全项目多维审验① IPC sender 校验（纵深防御，唯一可信窗=主窗）
- 全项目多维审验②半接线接成真执行（composeTeam 喂 task + Director 放行门）
- 全项目多维审验②半接线之死代码/过时注释清理
- 全项目多维审验第二轮（loadModelConfig 默认统一 + 双窗口导航防护）
- 全项目多维审验第一轮（六处确定性高危 + 回归断言）
- 全盘死挂点扫描修复（IPC/事件/UI 全景图 11 处 + 三方审阅收敛）


## [0.13.2] - 2026-09-03

### Fixed
- BUG-023 项目绑定目录贯通会话工作区（实机冒烟第二批反馈）


## [0.13.1] - 2026-09-03

### Fixed
- BUG-022 项目菜单「打开项目目录」恒开数据目录（实机冒烟首批反馈）


## [0.13.0] - 2026-09-03

### Added
- **desktop**: 文件 Tab 编辑与 diff（Minke 对照 P3，ADR-0013）
- **desktop**: PTY 终端 Tab + 只读文件 Tab（Minke 对照 P2-10/11，ADR-0012）
- **browser**: 浏览器工具（Electron 自带 CDP，8 个工具）｜ADR-0011
- **verify**: TS 直测 loader + 架构守护测试（ADR-0010）

### Fixed
- **desktop**: yt-dev-review 三方审阅交叉修复（终端/文件/编辑）
- **browser**: CDP 挂起源三条全部留降级｜真机冒烟 11/11


## [0.12.0] - 2026-08-31

### Added
- **usage/events**: FR-5 用量追踪 + FR-6 SessionEvent append-only 事件流（ADR-0009）
- **market**: FR-3 本地插件市场注册表（manifest 校验 + 真热插拔，fail-closed）
- **connector**: FR-3 连接器后端注册表（8 连接器 + 加密凭证 + 保存即探测）
- **memory**: 补 FR-10 转储链（语义分块 + LLM 摘要 seam，第十五个死挂点）
- **memory**: 补 FR-10 分层记忆晋升调用链（第十四个死挂点）
- **fork/sandbox/datadir**: 补 PRD 三处缺口（FR-6 分叉回放 / FR-8 沙箱日志 / FR-4.2 内容清单）
- **authz**: 授权白名单（会话/永久，可查看可撤销）（PRD FR-9，第十一个死挂点）
- **desktop**: 桌面集成 6 项真实接线（PRD FR-4.2，第十个死挂点）

### Fixed
- **usage/events**: FR-5/FR-6 三方审阅交叉修复（2 BLOCKER + 4 采纳项）


## [0.11.0] - 2026-08-31

### Added
- **trace,comp,sandbox**: wire user feedback telemetry, outbound compensation gate and network allowlist (eighth/ninth dead hooks, FR-7/FR-8/FR-12); repair rotten e2e fixture


## [0.10.1] - 2026-08-30

### Fixed
- **memory**: hydrate+persist four-domain memory; enforce subject convention in memory_save; hermetic trace build dir; repair release workflow


## [0.10.0] - 2026-08-30

### Added
- **trace**: wire encrypted builtin token and settings toggle into upload chain (sixth dead hook); keep Issues as target


## [0.9.1] - 2026-08-30

### Fixed
- **bridge**: firePreStep payload carries full session messages so memory 80% dump threshold actually works


## [0.9.0] - 2026-08-30

### Added
- **multi**: wire compose-team dispatch bridge and plugin-page UI (fifth dead hook)


## [0.8.0] - 2026-08-30

### Added
- **agent**: wire promptLib into system prompt (FR-5/11), semantic memory recall with tail fallback, approval gate for file_write


## [0.7.0] - 2026-08-30

### Added
- **authz**: wire approval gate into shell_command execution; fix answerer registered to wrong component (BUG-021)


## [0.6.0] - 2026-08-30

### Added
- **runtime**: bridge intent gateway and trace into main dialog flow via agent/pre-step waterfall (ADR-0008); resolve PLAN T-P1-5 drift


## [0.5.0] - 2026-08-30

### Added
- **agent**: wire dsh memory into dialog flow (memory_save + recall injection) and add set_cwd session working dir (BUG-019/020)


## [0.4.1] - 2026-08-30

### Fixed
- **BUG-018 发消息能响应，要求执行任务时报「模型返回空内容」**：StepFun 等网关在 chat 模式下接受 `tools`/`tool_choice` 参数但返回 200 空内容（软拒绝），原降级逻辑只处理硬 4xx/错误含 tool 的情况。现 `callOpenAICompatible` 识别软拒绝并逐级降级到不带 tools；成功后把 `provider.id|model` 记入进程级记忆，后续会话直接走 `<tool:>` 文本兜底解析
- 空内容但去 tools 后仍空时，不再误置 `toolsRejected=true`，避免把真·空响应误判为网关不支持工具
- 软拒绝降级路径补 `[softReject]` 模型日志，便于线上定位

### Changed
- 验证套件：`model-loop-verify.cjs` 新增 M 组 3 项（软拒绝逐级降级 / 文本兜底完成任务 / 跨会话记忆），`npm run verify` 扩至 11 套件 313 项

## [0.4.0] - 2026-08-30

### Added
- **dsh/Cordis 运行时接入**：主进程 `startRuntime()` 真实装载 9 个插件（intent / trace / authz / brain / multi / memory / prompt / compensation / evolution），FR-7~FR-13 不再是空壳
- **数据目录统一**：新增纯逻辑 `data-dir.ts`（零 electron 依赖、可 node 单测）；`guanji.json` / `hub.json` / `skills` 一并纳入 `dataDir()`，凭据类 copy-if-absent 迁移
- **数据导出 / 导入**（BUG-013 方案 B）：单文件 JSON 备份（`kind: orchdesk-backup`），导入复用启动迁移的「只补齐不覆盖」策略，设置页新增入口
- **主进程日志系统**：`<dataDir>/logs/main-YYYYMMDD.log`（按天滚动、2MB 截断、留 7 天）；console 全量镜像；模型调用结构化埋点（URL / HTTP 状态 / 耗时 / 正文长度，不记密钥）；设置页「打开日志」
- **验证套件扩容**：model-loop 25（真 HTTP 线级）/ orchestration 45（SubAgent 派生与三层编排）/ trace-upload 36（脱敏上传）/ data-dir 36 / data-port 10，全套 308 项
- **版本守卫** `scripts/check-version.cjs`：禁止在已发布版本号上重复打包

### Fixed
- 便携模式生产失效：`resolveDataDir` 漏传 `existsSync`（缺省恒 false），测试自注入掩盖了该缺陷
- 导入竞态：persist-sessions 整体重写会冲掉导入数据；伪造备份可写入明文凭据（新增结构校验 + 256MB 上限）
- `apiMode:'responses'` 丢失 system 提示词与 assistant 历史（工具能力彻底失效）；明文 `apiKey` 被静默删除（改就地加密迁移）
- `brain.promoteWorkerOutput` 恒 false → FR-10 worker→director 晋升永久断裂（接入 director 过滤 seam，默认仍拒绝）；multi rootId 同毫秒碰撞；委派树只展开一层；失败节点被跨 root 洗白
- TRACE：30s 定时器路径被批量门控拦截致记录永不上传；splice 误删队首未到期项；无 repoUrl/token 时静默丢单
- 打包：`vendor-dsh.cjs` 产物写错目录、`exports` 缺 `./` 前缀；`@deepseek-ai/*` 需 `extraFiles` 才会进包
- **BUG-017 真机启动崩溃** "Cannot find module '@deepseek-ai/cordis'"：asar 内 CJS 裸说明符不落到包外依赖，改显式路径 ESM 动态加载
- 模型「返回空内容」无法定位：改为带诊断（provider / model / apiMode / HTTP / finish_reason / 响应片段）；兼容 content 为分段数组形态

### Changed
- 验证入口扩至 11 套件（`npm run verify`），打包产物新增 9/9 插件真实 import 实测
- 打包脚本前置版本守卫（SemVer 治理：feat→minor / fix→patch）

## [0.2.0] - 2026-08-28

### Added
- 智能推荐按钮：`getSmartRecommendations()` 基于近 7 天消息主题信号 + 技能使用频率 + 空闲检测动态生成快捷按钮
- 动态时段问候语：`getGreeting()` 扩展为早上好/上午好/中午好/下午好/傍晚好/晚上好/夜深了 +「一起来做点什么呢？」
- Markdown 渲染：集成 marked.js (MIT, UMD) 替换手写正则渲染器；Agent 消息自动 MD 渲染
- 模型管理「默认模型」下拉：设置页可选择所有已配置提供商的模型作为默认
- `vendor/marked.min.js` UMD 构建（renderer 直接引用无需 bundler）

### Changed
- **启动并行化**：`init()` 14 个串行 IPC → `Promise.allSettled` 并行；首屏先 `render()` 再后台加载数据
- **欢迎页布局**：`.home-screen` 垂直居中；`.composer` 去底部背景和 border-top；`.home-greeting` 字号缩小
- **md-body CSS**：列表紧凑化（`ul margin:2px 0` / `li margin:0 0 2px`）
- **MODELS 架构**：删除/添加提供商时不再操作 `MODELS` 数组，改为 `bridge.getModelConfig()` 刷新 `dynamicModels`
- `publish` 脚本移除 `--publish always`（CI 场景单独控制）

### Fixed
- composer 更多按钮下拉浮窗被 `.box` 裁剪（overflow→visible, z-index 50→200）
- 项目选择器 `.proj-dropdown` 点击无响应（z-index + pointer-events + 阻止冒泡）
- 模型确认选择未持久化到 session（现写入 `session.models` + localStorage）
- 白屏闪烁：`BrowserWindow` 加 `backgroundColor: '#1E1E1E'`

### Security
- ctx-empty 占位符 `💬` → `ic('clipboard')` SVG（emoji → SVG 全覆盖）

## [0.1.0] - 2026-08-24

### Added
- Electron 桌面壳基础框架（main.ts + preload.ts + renderer/）
- 4 列布局（rail / side / main / context）
- 会话 CRUD（新建/重命名/分支/归档）
- 模型多选 + 思维深度滑竿 + 授权模式芯片
- 5 内置插件 UI（意图识别/TRACE/脑手解耦/多Agent编排/OrchClaw Hub）
- 观雅集技能市场客户端（复用 guanji SKILL API 约定）
- OrchClaw Hub 配对客户端（safeStorage 加密凭据）
- 补偿层 + 自进化插件（withhold/compensate/temp plugin）
- electron-builder 打包（nsis + portable）
- GitHub Releases 自动发布
- 更新前数据快照（snapshotData）
- 模型管理页面（添加/编辑/删除提供商 + 连通性测试）
- P1-P6 全部代码落地 + tsc 编译通过

### Security
- XSS 防护（`esc()` 统一转义）
- API Key 经 safeStorage 加密
- guanji-publish 路径白名单
- approval fail-closed 门控
