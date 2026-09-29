# stepcode 开发准则

本项目以 YT-ANSE（YT Agent-Native Software Engineering）为开发准则。

## 绑定来源

- 上游：https://github.com/ra1nzzz/yt-agent-native-engineering
- 分支：`main`
- 锁定提交：`8a241bd1159b7d3f9ebce97678224ff2e2875fb6`
- 提交时间：2026-09-29 15:00:56 +0800
- 提交说明：`docs: add docs/terminology-and-ui-language.md`
- 快照：`guidelines/yt-agent-native-engineering/`
- 来源记录：`guidelines/PROVENANCE.md`、`docs/references/yt-anse.md`、`docs/adr/0001-adopt-yt-anse.md`

快照是只读准则包。不得把项目知识写入快照。更新准则只能重新锁定上游提交，并另记决策。

## 路径裁决

本段优先于下文上游宪法中的路径示例。

| 上游写法 | 本仓库实际路径 |
|---|---|
| 准则文档、技能、引擎、参考文献 | `guidelines/yt-agent-native-engineering/` 下的同名路径 |
| `docs/terminology-and-ui-language.md` | `guidelines/yt-agent-native-engineering/docs/terminology-and-ui-language.md` |
| 项目规范性知识 `/docs` | 本仓库根目录 `docs/` |
| 已加载的 `AGENTS.md` | 本文件。根目录 `AGENTS.md` 只是入口 |

本仓库 `docs/` 只记录 stepcode 的意图、本体、术语、规格、架构、契约、决策、研究、参考、资产、状态、风险和已接受决定。准则仓库中的方法论文档不是 stepcode 的产品需求。

## 执行入口

新任务或切换上下文时，按此顺序恢复，不猜测已有仓库证据能回答的问题：

1. 本文件
2. 与任务相关的准则文档：`guidelines/yt-agent-native-engineering/docs/`
3. 本仓库 `docs/` 中已有的项目知识
4. Git 状态，以及相关代码、测试、入口
5. 适用的 SPEC / ADR / CHECKPOINT

需要编排、知识治理或评审时，读取并执行：

- `guidelines/yt-agent-native-engineering/skills/yt-aose/SKILL.md`（`yt-anse-orchestration`）
- `guidelines/yt-agent-native-engineering/skills/yt-knowledge/SKILL.md`（`yt-anse-knowledge`）
- `guidelines/yt-agent-native-engineering/skills/yt-review/SKILL.md`（`yt-anse-review`）

确定性检查使用 `guidelines/yt-agent-native-engineering/engine/`。已有脚本能完成的范围、解析、匹配、校验和记账，不用 Agent 代替。

会话中若仍可见旧版 `yt-dev-review`（三维九域 v2），本项目评审以快照中的 `yt-anse-review` 为准。

微小改动保持 L0。不要对琐碎变更套用 L3/L4。

Done = 已实现 + 已验证 + 已写入本仓库 `docs/` + 可恢复。

---

# 上游宪法（锁定文本）

以下文本来自锁定提交的 `AGENTS.md`。除上面的路径裁决外，原文生效。

# YT-ANSE — Agent-Native Software Engineering

> **Knowledge → Specify → Contract → Execute → Deterministic Review → Verify → Converge → Knowledge**

## 1. Constitution

1. `/docs` is the project's **normative source of truth** for intent, ontology, terminology, requirements, architecture, contracts, decisions, research, references, assets, state, risks and accepted decisions.
2. After any material change—code, document, asset, configuration, interface, research result, citation, or discovered constraint—perform a **Docs Impact Check** and update the relevant `/docs` before declaring the work complete.
3. `/docs` defines what the project means or requires. Code, tests, runtime observations and external sources are evidence. Conflicts must be recorded and resolved explicitly; never silently choose a source.
4. One concept → one canonical term → one stable meaning. Do not invent synonyms for convenience.
5. Keep machine identifiers stable. Human-readable surfaces use canonical project terminology and Chinese descriptions where appropriate.
6. Use concise, precise, enterprise/office/e-commerce language. Remove AI-flavored filler, vague hedging, internal jargon and unnecessary English.
7. Use deterministic tooling for deterministic work. Use Agents for reasoning, retrieval, synthesis, architecture and judgment.
8. Evidence precedes judgment. Best Practice ≠ Requirement. A finding is not automatically a required fix.
9. Prefer the minimum sufficient process, agent count and context. Do not add ceremony without demonstrated value.
10. **Done = implemented + verified + documented + recoverable.**

## 2. Restore Before Action

On a new task or context switch:

```text
AGENTS.md
→ relevant /docs
→ git status / recent history
→ relevant code / tests / entrypoints
→ SPEC / ADR / CHECKPOINT if applicable
```

Use just-in-time context. Do not guess when repository evidence can answer the question.

## 3. Progressive Specification

Assess non-trivial work:

```text
complexity: tiny | small | medium | large | critical
risk:       low | medium | high | critical
parallel:   yes | partial | no
integration: low | medium | high
```

| Level | Minimum control plane |
|---|---|
| L0 | Intent + verification |
| L1 | SPEC + PLAN |
| L2 | Problem/PRD + SPEC + PLAN + CHECKPOINT; ADR when needed |
| L3 | PRD + SPEC + ADR + PLAN + CHECKPOINT + Review + Integration Gate |
| L4 | L3 + security / migration / rollback / performance / failure / observability / release controls |

Never impose L3/L4 process on trivial changes.

## 4. Contract Before Parallelism

Before parallel or cross-boundary work, stabilize relevant:

```text
API / Type / Schema / Event / Module Interface / Persistence / Error Semantics
```

```text
Contract
→ Task Graph / Dependency Graph
→ Parallel Execution
→ Contract Verification
→ Integration
```

Parallelize only when boundaries, dependencies and shared state are controlled.

## 5. Incremental Execution

Prefer:

```text
one high-value, independently verifiable increment
→ implement
→ verify
→ update /docs
→ checkpoint when material
→ next increment
```

Do not announce a large task complete because the implementation merely compiles.

## 6. Review Gate

Use `yt-anse-review` for important features, cross-module refactors, API/data-model changes, high-risk logic, release candidates, or when explicitly requested. Tiny changes may use Lite Review.

The Review system must separate:

```text
Deterministic Execution
+ Agent Reasoning
+ Evidence Governance
+ Convergence
```

Required review properties:

- explicit scope and coverage;
- applicable Review Lenses;
- evidence anchors;
- fact verification;
- risk/applicability/priority assessment;
- verification after fixes;
- integration validation for cross-boundary changes.

## 7. Verification

Select evidence by risk:

```text
Unit / Type / Static / Integration / E2E / Browser / Smoke /
Benchmark / Profile / Security / Migration / Runtime Observation
```

Do not weaken tests to make an implementation pass. Critical user paths prefer real E2E verification.

## 8. Knowledge, Terminology and UI Language

Treat project terminology as ontology:

```text
Concept → Definition → Relation → Canonical Term → Presentation
```

New cross-module terms must enter `/docs` before propagation. Naming changes trigger impact review across UI, prompts, notifications, CLI, API human-readable messages, tests and docs.

Current language baseline is maintained in `docs/terminology-and-ui-language.md`.

## 9. Convergence

Maintain:

```text
CURRENT_STATE
BEST_STATE
```

A later version is not automatically better. Stop when hard gates pass and remaining issues are non-essential, low-value, high-cost, or likely to add more risk than value.

Allowed terminal decisions:

```text
PASS
ACCEPT AS-IS
ROLLBACK TO BEST
ESCALATE HUMAN
```
