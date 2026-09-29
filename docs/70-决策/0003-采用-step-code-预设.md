---
id: adr-0003
type: adr
status: accepted
updated: 2026-09-29
---

# ADR 0003 — 采用 Step Code CLI 及其权限档

- 状态：已接受。界面只暴露两档的决定见 [ADR 0004](0004-gui-两档.md)
- 日期：2026-09-29
- 核对记录：[Step Code CLI](../99-归档/研究/2026-09-29-step-code-cli.md)

## 背景

用户更正运行时来源为 https://github.com/stepfun-ai/Step-Code ，并要求沿用 CLI 已有模式，不空造。此前「把 chat/coding 精简为部分信任和完全信任」与这条裁决冲突。

## 决策

1. Agent 运行时核来自 `stepfun-ai/Step-Code`，当前观察点 `93ebc5bea25032a77af007a968a8998b492989f5`。
2. 权限档只使用 `ask`、`read-only`、`bypass`、`autopilot`。机器标识保持不变。界面词沿用 Ask、Read Only、Bypass、Autopilot，不另起中文同义词。
3. 撤回「部分信任」「完全信任」作为模式。它们不是 CLI 的档，也不映射到 OrchDesk 的 `default` / `trusted` / `paranoid`。
4. 跟随官方更新指移动这个锁定点，并另记 ADR。不漂在 `main` 上，也不把 `step update` 当成源码锁定方式。
5. ISO 10303 的 `stepcode/stepcode` 仍然排除，见 [ADR 0002](0002-排除-stepcode.md)。

## 未决

嵌入方式和 OrchDesk 替换清单已由 [ADR 0005](0005-进程内嵌入与插件删除.md) 接受。本 ADR 不改锁定点，也不改这四档的运行时定义。未决项当时不得用新模式名填上；该约束仍然有效。

## 后果

后续规格、界面和宿主只消费这四档。新增第五档或合并两档，都要新的 ADR，不能在实现时顺手改。界面暴露范围以 ADR 0004 为准，不以本 ADR 第 2、3 条的界面用词为准。
