# stepcode

本仓库是 stepcode 的公开项目仓库：https://github.com/ra1nzzz/stepcode

当前只有规范性文档和开发准则快照，还没有应用代码。

## 不是 STEPcode

ISO 10303 的 STEPcode 在 https://github.com/stepcode/stepcode 。那个仓库已排除，不是本仓库的运行时，也不是 Agent CLI。

本仓库的运行时核锁定为 https://github.com/stepfun-ai/Step-Code 的提交 `93ebc5bea25032a77af007a968a8998b492989f5`。那是终端 Agent CLI，命令名是 `step`。跟随它的方式是移动锁定点并记 ADR，不是执行 `step update`，也不是把本仓库写成那个 CLI。

## 权限档

本 GUI 只准备两档：

| 界面词 | 机器标识 |
|---|---|
| 默认模式 | `bypass` |
| 完全信任 | `autopilot` |

完全信任不表示跳过危险命令确认。两档遇到危险命令都要确认。差别是 `autopilot` 会在瞬时模型失败后续跑。

## 文档

规范性知识在 `docs/`。开发准则入口是 `AGENTS.md`，已加载规则在 `.ohmyagent/AGENTS.md`。

本仓库的许可证尚未决定。上游 CLI 的 MIT 不自动覆盖本仓库。
