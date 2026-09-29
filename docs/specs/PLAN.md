# PLAN — 运行时替换

- 日期：2026-09-29
- 当前增量：建立公开仓库。不改 OrchDesk。

| 顺序 | 增量 | 状态 | 完成标准 |
|---|---|---|---|
| 1 | 排除错误的 STEPcode 仓库 | 完成 | ADR 0002 |
| 2 | 核对 Step Code CLI，并沿用其权限档 | 完成 | ADR 0003。本 GUI 只暴露两档，见 ADR 0004 |
| 3 | 确认公开仓库名称 | 完成 | 用户确认 `ra1nzzz/stepcode`。创建见第 4 步 |
| 4 | 初始化提交并建立公开仓库 | 完成 | https://github.com/ra1nzzz/stepcode 公开。README 不把 STEPcode 写成 Agent CLI |
| 5 | 选定嵌入方式并锁定运行时核 | 完成 | ADR 0005：进程内库组合。锁定点仍是 ADR 0003 的提交 |
| 6 | 写 OrchDesk 替换清单 | 完成 | ADR 0005：九个插件删除且不迁移 |
| 7 | 按清单改接 OrchDesk | 未开始 | 先有第 4 步的公开仓库；一次工具调用符合 `decideStepToolCall`；确认不走 `bypassPermissions` |

第 4 步已完成。改接仍晚于清单，清单已经写完。下一步是第 7 步，本增量不改 OrchDesk。
