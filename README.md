# stepcode

公开仓库：https://github.com/ra1nzzz/stepcode

本仓库不是 ISO 10303 的 STEPcode（https://github.com/stepcode/stepcode）。那个仓库不是 Agent CLI。

知识库唯一入口是 [docs/README.md](docs/README.md)。

产品代码在 [apps/desktop](apps/desktop)：Electron 桌面壳。运行时核是锁定点的 `@step-harness/coding-agent`，接缝是 `createStepExtensionInline`，危险命令确认走本 GUI 的弹窗。见 [ADR 0005](docs/70-决策/0005-进程内嵌入与插件删除.md) 与 [ADR 0007](docs/70-决策/0007-精简版归属.md)。

```bash
pnpm install
pnpm run typecheck   # 桌面 tsc
cd apps/desktop
node step-t4-verify.cjs   # 工具调用符合锁定点裁决，危险命令走本 GUI 确认
node step-t5-verify.cjs   # 用户发送由 Step 会话执行，不再走 OpenAI 循环
```

不要用 `pnpm run verify` 当验收。它会因锁文件变化去核对全仓依赖。直接跑具体脚本，见 [检查点](docs/00-项目/检查点.md)。
