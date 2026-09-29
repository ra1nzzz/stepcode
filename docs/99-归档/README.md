---
id: archive-index
type: archive-index
status: canonical
updated: 2026-09-29
---

# 归档索引

本目录是历史记录。当前事实见 [知识库入口](../README.md)。

| 旧路径 | 现路径 | 处置 | 后继 |
|---|---|---|---|
| `docs/state/CURRENT_STATE.md` | [当前状态](../00-项目/当前状态.md) | absorbed | 当前状态 |
| `docs/state/BEST_STATE.md` | [可恢复基线](../00-项目/可恢复基线.md) | absorbed | 可恢复基线 |
| `docs/glossary/terms.md` | [术语](../00-项目/术语.md) | absorbed | 术语 |
| `docs/architecture/runtime-boundary.md` | [运行时边界](../10-架构/运行时边界.md) | absorbed | 运行时边界 |
| `docs/product/PRD.md` | [运行时替换](../20-需求/运行时替换.md) | absorbed | 需求 |
| `docs/specs/runtime-replacement.md` | [替换契约](../30-开发/替换契约.md) 与 [不变量](../40-质量/不变量.md) | absorbed | 合同与质量门禁 |
| `docs/specs/PLAN.md` | [计划](../80-路线图/计划.md) | absorbed | 路线图 |
| `docs/adr/0001-adopt-yt-anse.md` | [ADR 0001](../70-决策/0001-采用-yt-anse.md) | absorbed | ADR 0001 |
| `docs/adr/0002-runtime-source-conflict.md` | [ADR 0002](../70-决策/0002-排除-stepcode.md) | absorbed | ADR 0002 |
| `docs/adr/0003-adopt-step-code-presets.md` | [ADR 0003](../70-决策/0003-采用-step-code-预设.md) | absorbed | ADR 0003 |
| `docs/adr/0004-gui-two-presets.md` | [ADR 0004](../70-决策/0004-gui-两档.md) | absorbed | ADR 0004 |
| `docs/adr/0005-in-process-embed-and-plugin-cut.md` | [ADR 0005](../70-决策/0005-进程内嵌入与插件删除.md) | absorbed | ADR 0005 |
| `docs/research/2026-09-29-runtime-source.md` | [运行时来源](研究/2026-09-29-运行时来源.md) | archived | [ADR 0002](../70-决策/0002-排除-stepcode.md) |
| `docs/research/2026-09-29-step-code-cli.md` | [Step Code CLI](研究/2026-09-29-step-code-cli.md) | archived | [ADR 0003](../70-决策/0003-采用-step-code-预设.md) |
| `docs/research/2026-09-29-embed-and-plugins.md` | [嵌入与插件](研究/2026-09-29-嵌入与插件.md) | archived | [ADR 0005](../70-决策/0005-进程内嵌入与插件删除.md) |
| `docs/checkpoints/2026-09-29-docs-gate.md` | [文档门禁](检查点/2026-09-29-文档门禁.md) | archived | [ADR 0002](../70-决策/0002-排除-stepcode.md) |
| `docs/checkpoints/2026-09-29-cli-presets.md` | [CLI 预设](检查点/2026-09-29-cli-预设.md) | archived | [ADR 0003](../70-决策/0003-采用-step-code-预设.md) |
| `docs/checkpoints/2026-09-29-gui-two-presets.md` | [GUI 两档](检查点/2026-09-29-gui-两档.md) | archived | [ADR 0004](../70-决策/0004-gui-两档.md) |
| `docs/checkpoints/2026-09-29-embed-decision.md` | [嵌入决定](检查点/2026-09-29-嵌入决定.md) | archived | [ADR 0005](../70-决策/0005-进程内嵌入与插件删除.md) |
| `docs/checkpoints/2026-09-29-public-repo.md` | [公开仓库](检查点/2026-09-29-公开仓库.md) | archived | [来源并入](../00-项目/来源并入.md) |
| `docs/references/stepcode-repo.md` | [本仓库](参考/stepcode-仓库.md) | archived | [来源并入](../00-项目/来源并入.md) |
| `docs/references/stepcode-upstream.md` | [STEPcode](参考/stepcode-上游.md) | archived | [来源并入](../00-项目/来源并入.md) |
| `docs/references/step-code-cli.md` | [Step Code CLI 参考](参考/step-code-cli.md) | archived | [来源并入](../00-项目/来源并入.md) |
| `docs/references/yt-anse.md` | [YT-ANSE 参考](参考/yt-anse.md) | archived | [来源并入](../00-项目/来源并入.md) |
| `docs/references/orchdesk.md` | [OrchDesk 参考](参考/orchdesk.md) | archived | [来源并入](../00-项目/来源并入.md) |

## 分支与工作树

| 仓库 | 分支或工作树 | tip | 处置 |
|---|---|---|---|
| `ra1nzzz/stepcode` | `main`，唯一工作树 | 整理前 `527adc7a4ce2711af7773f8cfd8696e9554b1e7a` | absorbed。默认分支保留 |
| `ra1nzzz/orchdesk` | 独立仓库 `main` | 整理日本地 `e29881bb6d2ab751549fc2d3f335a5339e747a83` | 不回放，不删除。证据点见 [来源并入](../00-项目/来源并入.md) |
| 准则快照 | `guidelines/yt-agent-native-engineering/` | tree `e3f5830f22f2f6fbecb81a620087789ee2602754` | mirror。不删除 |

没有未提交且无法恢复的制品。没有删除工作树或分支。
