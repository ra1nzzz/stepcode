# SPEC — 运行时替换

- 状态：契约已定。公开仓库已创建。OrchDesk 改接尚未做
- 日期：2026-09-29
- 权限档契约：ADR 0003 的 CLI 预设；本 GUI 暴露范围见 ADR 0004
- 嵌入方式：ADR 0005。进程内库组合

## 契约

| 字段 | 值 |
|---|---|
| 上游仓库 | https://github.com/stepfun-ai/Step-Code |
| 跟踪单位 | 提交。当前 `93ebc5bea25032a77af007a968a8998b492989f5`。不跟踪浮动 `main` |
| 更新 | 移动锁定点 + ADR。`step update` 只描述已安装程序，不作为本仓库的锁定方式 |
| 嵌入方式 | 进程内组合。`createStepExtensionInline` 接收 `bypass` 或 `autopilot`；`confirm` 由本 GUI 提供 |
| 不采用的宿主协议 | `--sdk-stdio` 的 `permissionMode`；`--mode rpc` 作为两档控制面；`--non-interactive-approval allow` |
| 本仓库公开远程 | https://github.com/ra1nzzz/stepcode 。2026-09-29 已创建，公开 |
| OrchDesk 替换面 | 停止装载 `apps/desktop/dsh-runtime.ts`。九个插件与市场插件装载器删除，不迁移。见下表 |
| 会话与凭据 | 留在 Step 运行时自己的存储根。本 GUI 不另造会话格式 |
| 沙箱 | 不迁移 `sandboxPolicy`。不发送 `sandbox.enabled` |
| 权限档 | 本 GUI 只发 `bypass`、`autopilot`。界面词是默认模式、完全信任。行为以锁定点对应预设的 `decideStepToolCall` 为准 |
| 不提供的档 | `ask`、`read-only` 不进入本 GUI。运行时若带回这两档，不得显示成默认模式或完全信任 |

## 不变量

1. 本 GUI 的两档机器标识与上游 `bypass`、`autopilot` 一致，不改其裁决函数。
2. 界面只有两个权限档名称。宿主兼容词不能变成第三档。
3. 危险命令的产品文案不得写成「任何模式都弹窗」，除非锁定点的 `strict` 行为已改成确认。当前源码对 `strict` 是拒绝。
4. 无界面运行不得继承「未选择策略时交互默认 Bypass」。
5. 替换 dsh 前必须有清单。清单已在 ADR 0005：九个插件删除且不迁移。没有按该清单改接之前，不改宿主代码。
6. 不把宿主兼容词、`--approval-mode auto` 或 `STEP_AUTOPILOT` 单独写成第三档。完全信任是 `autopilot` 预设，不是单独打开后续跑再另选一套审批。
7. 危险命令确认必须走到本 GUI 的 `confirm`。不得用 `bypassPermissions` 或 `--non-interactive-approval allow` 代替。

## 随 dsh 删除

证据在 `docs/research/2026-09-29-embed-and-plugins.md`。这里只列规范处置。

| 插件 | 处置 |
|---|---|
| intent | 删除。不迁。工具裁决只留 `decideStepToolCall` |
| trace | 删除。不迁 |
| authz | 删除。不迁。不把它的 `default` / `trusted` / `paranoid` 改名成两档 |
| brain | 删除。不迁 |
| multi | 删除。不迁。专家团不在这次替换里重建 |
| memory | 删除。不迁。旧的四域 JSON 不读入新核 |
| prompt | 删除。不迁。不为它保留 Cordis |
| compensation | 删除。不迁。不作为第二套审批 |
| evolution | 删除。不迁 |

市场插件装载器（`startupMarketPlugins` / `setMarketPluginEnabled`）随 `dsh-runtime` 删除。不逐个迁移市场目录。

宿主服务 `sandboxPolicy`、`approval`、`agents` 停止提供。调用它们的桌面桥在改接时移除，或显式返回不可用。
