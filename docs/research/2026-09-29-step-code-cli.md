# Step Code CLI 核对

- 访问日期：2026-09-29
- 来源：https://github.com/stepfun-ai/Step-Code
- 观察点：`main` @ `93ebc5bea25032a77af007a968a8998b492989f5`
- 结论：这是 Agent CLI。权限档沿用其四档预设，不新造「部分信任 / 完全信任」。

## 仓库

公开，非 fork，MIT。根目录是 pnpm workspace：`apps/cli`，以及 `packages/agent-core`、`coding-agent`、`config`、`contracts`、`providers`、`telemetry`、`tui`。

中文 README 自述：终端 Agent，单轮可完成阅读、修改和测试；命令为 `step`；`Shift+Tab` 循环权限档。安装器把程序放到 `~/.stepcode/bin`，`step update` 升级已安装的程序。这是发行更新方式，不是本仓库锁定源码的方式。

## 权限档

`packages/coding-agent/src/step/permissions.ts` 导出四档，测试期望同一顺序：

| 机器标识 | 界面词 | 底层 mode | 无界面时的默认审批 | 失败后续跑 | 源码描述 |
|---|---|---|---|---|---|
| `ask` | Ask | `confirm` | `deny` | 否 | Safe tools run; writes and commands ask first |
| `read-only` | Read Only | `strict` | `deny` | 否 | Read and discovery tools only |
| `bypass` | Bypass | `auto` | `allow` | 否 | Run ordinary tools without approval; dangerous commands still ask |
| `autopilot` | Autopilot | `auto` | `allow` | 是 | Bypass ordinary approvals and resume transient model failures |

`decideStepToolCall` 的可见行为：

- 只读工具名包括 `read_file`、`list_directory`、`find_files`、`search_files`、`search_web` 及对应原生名。
- 写或执行工具名包括 `write_file`、`edit_file`、`run_command` 及 `write`、`edit`、`bash`。
- `strict` 拒绝可变工具。
- `auto` 放行普通工具。
- `confirm` 放行只读工具，其余要求确认。
- 命中危险命令规则时，`strict` 拒绝，其他 mode 要求确认。
- 命令分析不完整时同样：`strict` 拒绝，其他 mode 要求确认。
- 未显式选择策略时，交互默认落到 `bypass`；无界面的运行不得继承这个默认。

`packages/coding-agent/src/step/stdio-host.ts` 另有一套宿主词：`default`、`acceptEdits`、`plan`、`bypassPermissions`、`dontAsk`。`normalizeStepPermissionMode` 把前三个分别折成 `confirm`、`confirm`、`strict`，把 `bypassPermissions` 折成 `auto`。`dontAsk` 不在该函数里。2026-09-29 重读 host：`#approvalForTool` 不调用这个函数，`bypassPermissions` 在那条路径上跳过 SDK 审批回调。所以这些宿主词不是 CLI 预设的别名。详见 `docs/research/2026-09-29-embed-and-plugins.md`。

## 与 README 的一处不一致

中文 README 写「危险命令在任何模式下都会单独弹窗确认」。同一观察点的 `decideStepToolCall` 在 `strict` 下对危险命令返回 `deny`，不是 `confirm`。以源码为这四档的行为；README 这句话不单独当成契约。

## 未找到的东西

仓库检索没有名为 chat/coding、且表示信任档的产品枚举。`coding-agent` 是包名，不是一种可切换的信任档。

宿主协议和插件去留的核对见 `docs/research/2026-09-29-embed-and-plugins.md`。`stdio-host.ts` 的宿主词不是本 GUI 的权限档。
