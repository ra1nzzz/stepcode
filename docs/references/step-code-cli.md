# Step Code CLI

| 项 | 值 |
|---|---|
| 来源 | https://github.com/stepfun-ai/Step-Code |
| 访问日期 | 2026-09-29 |
| 默认分支 | `main` |
| 观察点 | `93ebc5bea25032a77af007a968a8998b492989f5` |
| 许可 | MIT |
| 适用性 | 本仓库的 Agent 运行时核。不是 ISO 10303 的 STEPcode |
| 决策 | 来源与预设：`docs/adr/0003-adopt-step-code-presets.md`。嵌入：`docs/adr/0005-in-process-embed-and-plugin-cut.md` |

产品入口是终端命令 `step`。权限档以 `packages/coding-agent/src/step/permissions.ts` 的 `STEP_PERMISSION_PRESETS` 为准，不另造模式。
