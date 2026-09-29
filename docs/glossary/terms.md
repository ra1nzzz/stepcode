# 术语

一个概念只保留一个规范词。人读界面用中文规范词。机器标识保持 CLI 原值。

| 概念 | 规范词 | 机器标识 | 含义 | 状态 |
|---|---|---|---|---|
| 本产品仓库 | stepcode | `stepcode` | 公开项目仓库。尚无应用代码 | 已用 |
| 公开远程 | stepcode 公开仓库 | `ra1nzzz/stepcode` | https://github.com/ra1nzzz/stepcode 。2026-09-29 已创建，公开 | 已创建 |
| 运行时上游 | Step Code | `step-code` | `stepfun-ai/Step-Code`。终端 Agent CLI | 已核对 |
| ISO 10303 库 | STEPcode | `stepcode-iso10303` | `stepcode/stepcode`。已排除 | 已排除 |
| 待替换的运行时 | dsh 运行时 | `dsh-runtime` | OrchDesk 主进程中的 Cordis/dsh 核。替换时整段停止装载 | 已核对 |
| 目标运行时 | Agent 运行时核 | `agent-runtime-core` | 锁定的 Step Code 执行核。进程内组合，不是子进程协议 | 已接受 |
| 嵌入方式 | 进程内库组合 | — | `createStepExtensionInline` 加本 GUI 的 `confirm`。不是 npm 上的公开 SDK | 已接受 |
| 本 GUI 权限档 | 默认模式 | `bypass` | CLI 预设 `bypass`。普通工具不审批；危险命令仍要确认 | 本 GUI 提供 |
| 本 GUI 权限档 | 完全信任 | `autopilot` | CLI 预设 `autopilot`。普通审批同默认模式，并在瞬时模型失败后续跑 | 本 GUI 提供 |
| CLI 权限档 | Ask | `ask` | 只读可跑；写入和命令先确认 | 本 GUI 不提供 |
| CLI 权限档 | Read Only | `read-only` | 只允许阅读和发现 | 本 GUI 不提供 |

## 关系

```text
stepcode 的公开远程是 https://github.com/ra1nzzz/stepcode
stepcode 锁定 step-code 作为 agent-runtime-core
agent-runtime-core 以进程内库组合替换 OrchDesk 的 dsh-runtime
默认模式 = CLI 预设 bypass
完全信任 = CLI 预设 autopilot
ask 与 read-only 存在于 CLI，不进入本 GUI
九个 Cordis 插件随 dsh-runtime 删除，不迁入 agent-runtime-core
```

## 禁止混用

| 不要用来指代 | 原因 |
|---|---|
| 部分信任 | 已撤回。不是默认模式，也不是完全信任 |
| 完全信任 = 不再确认危险命令 | 与锁定点行为不符。两档遇到危险命令都要确认 |
| Bypass / Autopilot 作为界面词 | 上游界面词。本 GUI 用「默认模式」「完全信任」 |
| `default` / `full-trust` | 不是本产品的机器标识 |
| chat 模式 / coding 模式 | 不是权限档 |
| 默认安全 / 信任模式 / 偏执模式 | OrchDesk 的 `default` / `trusted` / `paranoid`，不映射到这两档 |
| 轻模式 / 项目模式 | OrchDesk 的界面布局 |
| `bypassPermissions` | `--sdk-stdio` 的宿主词。会跳过 SDK 审批回调，不是完全信任，也不是 `bypass` |
| `--approval-mode auto` | 底层 mode。单独使用不能区分默认模式和完全信任 |
| `--non-interactive-approval allow` | 没有审批界面时的放行回退，不是完全信任 |
