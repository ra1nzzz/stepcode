---
id: adr-0001
type: adr
status: accepted
updated: 2026-09-29
---

# ADR 0001 — 采用 YT-ANSE 作为开发准则

- 状态：已接受
- 日期：2026-09-29
- 来源：[来源并入](../00-项目/来源并入.md)

## 背景

stepcode 在作此决定时还没有应用代码，也没有已提交历史。后续实现需要先固定开发准则，避免边写边改规则。

## 决策

采用 YT-ANSE 作为本项目开发准则。

- 锁定 https://github.com/ra1nzzz/yt-agent-native-engineering `main` 的 `8a241bd1159b7d3f9ebce97678224ff2e2875fb6`。
- 完整工作树放在 `guidelines/yt-agent-native-engineering/`，作为只读快照。
- Agent 实际加载 `.ohmyagent/AGENTS.md`。根目录 `AGENTS.md` 只指向该文件。
- 项目规范性知识写入本仓库 `docs/`。准则仓库的方法论文档不视为 stepcode 的产品需求。

不把上游仓库设为子模块。需要更新时，按提交重新拉取并记 ADR。

## 后果

非微小变更按 YT-ANSE 执行：先恢复上下文，再按复杂度补规格；跨边界工作先稳定契约；确定性工作用快照中的 `engine/`；重要变更走 `yt-anse-review`；完成前更新本仓库 `docs/`。

会话中的 `yt-dev-review`（三维九域 v2）不作为本项目评审协议。本项目使用快照中的 `yt-anse-review`。

目录分层的后续裁决见 [冲突裁决](../00-项目/冲突裁决.md)。本 ADR 不要求把知识库做成准则仓库建议的那组目录名。
