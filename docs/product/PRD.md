# PRD — 替换运行时核

- 状态：草案。来源、权限档、嵌入方式、替换清单和公开仓库已定。改接尚未开始
- 日期：2026-09-29
- 复杂度：large
- 风险：high
- 并行：no
- 集成：high

## 问题

OrchDesk 的执行核是 dsh。用户要求换成可跟随官方更新的 Step Code CLI，并沿用 CLI 自己的模式。

## 已接受

1. 运行时核是 https://github.com/stepfun-ai/Step-Code ，当前锁定 `93ebc5bea25032a77af007a968a8998b492989f5`。
2. 运行时仍使用 CLI 预设，不新造执行策略。本 GUI 只提供两档：默认模式（`bypass`）、完全信任（`autopilot`）。不提供 `ask`、`read-only`。
3. 更新官方 CLI 时移动锁定点并记 ADR，不静默跟 `main`。
4. 公开远程是 https://github.com/ra1nzzz/stepcode 。2026-09-29 已创建，可见性为公开。
5. 运行时核在进程内组合。接缝是 `createStepExtensionInline` 的权限策略，加上本 GUI 提供的 `confirm`。只发 `bypass` 或 `autopilot`。见 ADR 0005。
6. OrchDesk 的 9 个 Cordis 插件随 `dsh-runtime` 删除，能力不迁入这次替换。市场插件装载器同样删除。

## 仍是意图，尚未接受为实现要求

1. 按 ADR 0005 的清单改接 OrchDesk：停止装载 `dsh-runtime`，改为进程内组合。改接尚未开始。

## 非目标

- 不引入「部分信任」。
- 不把「完全信任」实现成跳过危险命令确认。
- 不把 STEPcode 的 EXPRESS/Part 21 能力做成产品功能。
- 不在本增量修改 OrchDesk。清单已写完，改接仍是后续增量。
- 不重新解释 OrchDesk 的轻模式、项目模式或模型协议 `chat`。
- 不把 `--sdk-stdio` 的 `permissionMode` 当成默认模式或完全信任。`bypassPermissions` 会跳过 SDK 审批回调。
- 不把 `--non-interactive-approval allow` 当成完全信任。
- 不把九个插件的产品能力算进这次替换的验收。

## 验收

来源和权限档：

- 本 GUI 只出现「默认模式」「完全信任」，机器标识分别是 `bypass`、`autopilot`。
- 不存在把 `partial-trust` 或 `full-trust` 写成机器标识的规范性句子。

嵌入和替换完成之后才生效：

- 锁定点可复现，移动锁定点有 ADR。
- OrchDesk 卸下 dsh 之前，替换清单已经在 ADR 0005。清单是删除，不是保留或迁移。
- 一条不依赖 dsh 的会话能完成一次工具调用，且调用结果符合当前锁定点的 `decideStepToolCall`。
- 该会话的权限策略只能是 `bypass` 或 `autopilot`，确认回调由本 GUI 提供。

## 开放问题

无。公开仓库已创建。改接是 PLAN 第 7 步，不是未决产品问题。
