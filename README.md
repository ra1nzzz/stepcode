# stepcode

公开仓库：https://github.com/ra1nzzz/stepcode

当前版本：v0.1.0（`apps/desktop/package.json`。版本守卫核对这一行，改版本必须同步改这里）

本仓库不是 ISO 10303 的 STEPcode（https://github.com/stepcode/stepcode）。那个仓库不是 Agent CLI。

知识库唯一入口是 [docs/README.md](docs/README.md)。

产品代码在 [apps/desktop](apps/desktop)：Electron 桌面壳。运行时核是锁定点的 `@step-harness/coding-agent`，接缝是 `createStepExtensionInline`，危险命令确认走本 GUI 的弹窗。见 [ADR 0005](docs/70-决策/0005-进程内嵌入与插件删除.md) 与 [ADR 0007](docs/70-决策/0007-精简版归属.md)。

```bash
pnpm install
pnpm run typecheck   # 桌面 tsc
pnpm run verify      # 版本守卫 + apps/desktop 的 30 个验证套件
cd apps/desktop
node step-t4-verify.cjs   # 工具调用符合锁定点裁决，危险命令走本 GUI 确认
node step-t5-verify.cjs   # 用户发送由 Step 会话执行，不再走 OpenAI 循环
```

`pnpm run verify` 原先还跑 `scripts/` 下四个 Cordis 套件（`verify-plugins` / `intent-gate-verify` / `verify-orchestration` / `verify-trace-upload`）。它们装载的是删除清单上的九插件，本仓库没有 `@deepseek-ai/cordis`，四条必然崩在 require；`README` 当年那句「不要用它当验收」就是这个原因。四条已随链路移除，见 [冲突裁决](docs/00-项目/冲突裁决.md)。逐项结果仍记在 [检查点](docs/00-项目/检查点.md)。
