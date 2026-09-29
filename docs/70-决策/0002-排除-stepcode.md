---
id: adr-0002
type: adr
status: accepted
updated: 2026-09-29
---

# ADR 0002 — 不把 STEPcode 绑定为 Agent 运行时核

- 状态：已接受
- 日期：2026-09-29
- 核对记录：[运行时来源](../99-归档/研究/2026-09-29-运行时来源.md)

## 背景

用户要求以 https://github.com/stepcode/stepcode 为 Agent 运行时核，替换 OrchDesk 的 dsh，并把 chat/coding 精简为两个信任档。同一句话要求先按开发准则更新文档。

该 URL 的仓库是 ISO 10303 STEPcode，不是 Agent CLI。

## 决策

在用户明确给出可核对的 Agent CLI 来源之前：

1. 不把 `stepcode/stepcode` 锁定为运行时核，不写跟随其更新的依赖。
2. 不创建本仓库的公开远程。鉴权账号 `ra1nzzz` 可用，`ra1nzzz/stepcode` 当时不存在，但名称会公开表达产品身份，来源错误时不应先占名。
3. 不修改 OrchDesk，不替换 `dsh-runtime`。
4. 不把「部分信任」「完全信任」写成已定义行为，也不把它们映射到 OrchDesk 现有模式。

## 被否定的方案

- **直接 vendor STEPcode 并称为 Agent 运行时核**：与仓库内容矛盾，后续「随官方 CLI 更新」没有对象。
- **先建公开仓库、来源以后再改**：公开远程会把错误身份发出去。
- **把 OrchDesk 的 `trusted` 改名为完全信任、把其余档合并为部分信任**：用户说的是 chat/coding，仓库里没有这组模式。静默替换会改掉另一套已发布语义。

## 人工裁决

2026-09-29 用户确认该链接有误。随后给出 https://github.com/stepfun-ai/Step-Code ，并要求沿用 CLI 已有模式。该来源的接受决定在 [ADR 0003](0003-采用-step-code-预设.md)，不在本 ADR。

## 后果

本 ADR 只继续排除 `stepcode/stepcode`。公开建仓和 OrchDesk 替换不再因这条冲突停止。ADR 0003 原先的未决项已由 [ADR 0005](0005-进程内嵌入与插件删除.md) 接受。
