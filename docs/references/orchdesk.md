# OrchDesk

| 项 | 值 |
|---|---|
| 来源 | https://github.com/ra1nzzz/orchdesk |
| 访问日期 | 2026-09-29 |
| 本地检出 HEAD | `b68a955776dffd5fe45e3e0e2ca075d2b297ee65` |
| 适用性 | 待替换的现有桌面宿主及其 dsh 运行时核。不是本仓库的上游 CLI |
| 决策 | 来源冲突已解除。替换清单见 `docs/adr/0005-in-process-embed-and-plugin-cut.md`。代码尚未改 |

当前运行时核是 dsh，基线 `dsh-v0.1.3-alpha.1`（`d347e703908d0406b7a7ef80e3a0e594d86b2215`）。替换边界见 `docs/architecture/runtime-boundary.md`。
