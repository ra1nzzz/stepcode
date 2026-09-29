# stepcode 项目知识

本目录是 stepcode 的规范性知识，不是 YT-ANSE 方法论文档。

| 路径 | 内容 |
|---|---|
| `adr/0001-adopt-yt-anse.md` | 采用 YT-ANSE |
| `adr/0002-runtime-source-conflict.md` | 排除 ISO 10303 的 STEPcode |
| `adr/0003-adopt-step-code-presets.md` | 采用 Step Code CLI。界面范围被 ADR 0004 取代 |
| `adr/0004-gui-two-presets.md` | 本 GUI 只保留默认模式、完全信任 |
| `adr/0005-in-process-embed-and-plugin-cut.md` | 进程内组合；九个插件随 dsh 删除 |
| `product/PRD.md` | 运行时替换。公开仓库已创建，改接未开始 |
| `specs/runtime-replacement.md` | 替换契约 |
| `specs/PLAN.md` | 增量顺序。下一步是改接 OrchDesk |
| `architecture/runtime-boundary.md` | dsh 现状与进程内组合后的边界 |
| `glossary/terms.md` | 规范词 |
| `research/2026-09-29-runtime-source.md` | 错误来源的核对 |
| `research/2026-09-29-step-code-cli.md` | Step Code CLI 核对 |
| `research/2026-09-29-embed-and-plugins.md` | 嵌入接缝与插件去留核对 |
| `references/yt-anse.md` | 准则来源 |
| `references/stepcode-upstream.md` | 已排除的 STEPcode |
| `references/step-code-cli.md` | 已接受的 CLI |
| `references/orchdesk.md` | 待替换宿主 |
| `references/stepcode-repo.md` | 本仓库公开远程 |
| `checkpoints/2026-09-29-docs-gate.md` | 来源冲突时的人工升级 |
| `checkpoints/2026-09-29-cli-presets.md` | 权限档裁决 |
| `checkpoints/2026-09-29-embed-decision.md` | 名称、嵌入方式、插件去留 |
| `checkpoints/2026-09-29-public-repo.md` | 建立公开仓库 |
| `state/CURRENT_STATE.md` | 当前状态 |
| `state/BEST_STATE.md` | 可回滚基线 |

准则快照在 `guidelines/yt-agent-native-engineering/`。已加载规则在 `.ohmyagent/AGENTS.md`。
