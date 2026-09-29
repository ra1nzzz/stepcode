# 运行时边界

- 状态：上游、嵌入方式和删除清单已定。OrchDesk 代码未改
- 日期：2026-09-29

## 现状

OrchDesk 的桌面壳与 dsh 运行时核是分开的。

```text
Electron 主进程
  → dsh-runtime（Cordis Context）
      → 宿主服务：sandboxPolicy / approval / agents
      → 业务插件
  → 渲染进程只经 contextBridge 调用显式能力
```

证据：`ra1nzzz/orchdesk` 检出 `b68a955776dffd5fe45e3e0e2ca075d2b297ee65` 的 `apps/desktop/dsh-runtime.ts`。基线 `d347e703908d0406b7a7ef80e3a0e594d86b2215`。

OrchDesk 授权三档不是本次要保留的模式。替换时删除或停用，不改名成 Step Code 的四档。

## 目标

```text
Electron 主进程
  → 锁定点的 @step-harness/coding-agent（进程内）
      → createStepExtensionInline({ permission: bypass | autopilot })
      → confirm 由本 GUI 提供
  → 不再装载 dsh-runtime
  → 不再装载 9 个 Cordis 插件，也不再装载市场插件
```

已定：

- 产品仓库是 https://github.com/ra1nzzz/stepcode 。
- 上游和锁定点见 ADR 0003。本 GUI 只暴露两档，见 ADR 0004。
- 嵌入方式见 ADR 0005：进程内组合，不把子进程协议当作权限面。
- 会话存储和模型凭据留在 Step 运行时自己的存储根。
- 不迁移 `sandboxPolicy`，不发送 `sandbox.enabled`。
- 九个插件全部删除且不迁移。没有「留下」的 Cordis 插件。
- 跟随官方更新只移动锁定点。
- 不新造执行策略。中文名称只覆盖 `bypass` 和 `autopilot`。

本页仍不写 IPC 方法名。确认对话框如何从主进程到达渲染进程，是改接增量的事，不改变上面的接缝角色。

清单已写完。在按 ADR 0005 改接之前，仍不改 `D:\Code\orchdesk`。
