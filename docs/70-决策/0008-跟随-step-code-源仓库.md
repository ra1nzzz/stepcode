---
id: adr-0008
type: adr
status: accepted
updated: 2026-10-01
---

# ADR 0008 — 运行时核跟随 Step Code 源仓库

- 状态：已接受
- 日期：2026-10-01
- 取代：[ADR 0003](0003-采用-step-code-预设.md) 第 4 条，以及 [ADR 0005](0005-进程内嵌入与插件删除.md) 里「跟随官方更新仍是移动锁定点并记 ADR。`step update` 不移动这个锁定点。」
- 不改：[ADR 0004](0004-gui-两档.md) 的两档，也不改 ADR 0005 的进程内组合和 `confirm` 接缝。

## 背景

用户要求 CLI 源仓库作为 Agent 运行时核，并且可以一直随官方更新。此前 `93ebc5be` 是天花板：commit、tree 或包版本不符就拒绝加载。每次前进都要新的 ADR。

核对结果：

- 源仓库是 https://github.com/stepfun-ai/Step-Code 。进程内接缝是该仓库构建出的 `createStepExtensionInline`。
- 官方安装包通道是 `https://static-openapi.stepfun.com/stepcode`。2026-10-01 的 `latest.json` 为 `0.1.2`，产物是平台压缩包里的 `step.exe` 和资源。
- 本机已装的 CLI（`0.1.1`）包名是 `@step-harness/coding-agent`，但没有 `dist/index.js`，也没有 `createStepExtensionInline`。

所以安装包和 `step update` 不能当作进程内运行时。能加载的是源仓库的构建产物。

## 决策

1. Agent 运行时核是 `stepfun-ai/Step-Code`。不是安装包，不是 `step.exe`，也不是 ISO 10303 的 `stepcode/stepcode`。
2. `93ebc5be` / `@step-harness/coding-agent@0.84.4` 是随包兜底，不是天花板。该源仓库的更新修订可以直接加载，不必为每一次提交另记 ADR。
3. 可加载的条件：来源是这个仓库（git remote 或 `step-origin.json`），包名仍是 `@step-harness/coding-agent`，导出 `createStepExtensionInline`，Node 不低于 `22.19.0`。版本号可以变。接缝消失则拒绝该修订，回落到上一份可加载的运行时。
4. 工具裁决仍在所加载修订自己的 `decideStepToolCall` 里。本 GUI 不重写它。官方更新可以改变哪些命令要确认。这是本决定接受的代价。
5. `step update` 只更新 CLI 安装。在官方安装包导出 `createStepExtensionInline` 之前，壳不把安装目录当作运行时。
6. 壳启动时，若找到该源仓库的检出，且工作树干净，就快进到 `origin/main` 并重建 `dist`。有本地改动则不快进，仍加载当前 HEAD（接缝还在时）。快进或重建失败则回到快进前的提交。

## 打包形态

1. 包内运行时是 esbuild 打好的单文件 `resources/step/index.js`，不是 `packages/*/dist` 的原样拷贝。2026-10-01 实测：原样拷贝里那 1044 个文件有 82 种裸导入（`@step-harness/*`、`chalk`、`typebox`、`undici`…），包里没有 node_modules 可解析，导入就在 `ERR_MODULE_NOT_FOUND: chalk` 上失败。
2. 打不进去的外部依赖随包放在 `resources/step/node_modules`：`@silvia-odwyer/photon-node`、`jiti`。别的都是内建或已内联。
3. 包内同时写 `step-origin.json` 与 `step-lock.json`，记下这次打包用的提交。
4. 包内的没有 `.git`，不参与快进。要让它跟随官方，给它一份官方检出，用 `ORCHDESK_STEP_CODE` 或 `ORCHDESK_STEP_RUNTIME` 指过去。没有检出时用随包版本。
5. 因此「一直随官方更新」分两种：源码场景启动即快进重建；分发给最终用户的打包场景随壳自己的 OTA 走，每个新 exe 带一份当次的官方修订。

## 后果

没有官方检出、构建失败，或新修订没有接缝时，壳使用随包锁定点。安装包的 `0.1.x` 和源包的 `0.84.4` 不是同一条版本线，不能拿前者去对后者。

随机目录、remote 不是这个仓库的检出，仍然拒绝。浮动来源不等于取消接缝检查。
