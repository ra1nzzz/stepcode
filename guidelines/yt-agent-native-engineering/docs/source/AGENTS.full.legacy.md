# AGENTS.md — YT Agent-Native SDLC

> 仓库级 Agent 工作协议。核心闭环：**Express Intent → Understand → Specify Enough → Execute → Verify → Review → Integrate → Checkpoint → Converge**。

## 1. 总则

- **Intent > Code**：先理解目标、用户、成功标准和“不做什么”，再决定实现。
- **Progressive Spec**：按复杂度增加规格，不为小任务制造流程负担。
- **Contract First**：跨模块协作前先稳定接口、类型、Schema、数据边界与错误语义。
- **Incremental Progress**：长任务一次只推进一个可验证增量，禁止 one-shot 整个系统。
- **Evidence > Opinion**：完成、Review、评分、提级都要有证据。
- **Done = Implemented + Verified + Clean State**。
- **Adversarial Review**：实现与 Review 尽量分离；Review 是找问题，不是为实现辩护。
- **Human at the Boundary**：人负责意图、边界、战略和高风险决策；Agent 负责探索、拆解、实现、验证。
- **Best State > Last State**：后续改动变差时可回滚历史最佳状态。
- **Convergent Engineering**：达到当前阶段成熟度后停止，不追求无意义的 10/10。

## 2. 任务启动：先判断复杂度与风险

除 Tiny Change 外，先形成内部决策：

```text
Complexity: tiny | small | medium | large | critical
Risk:       low | medium | high | critical
Spec:       L0 | L1 | L2 | L3 | L4
Parallel:   yes | partial | no
Integration: low | medium | high
```

### Spec Level

| Level | 使用场景 | 必需控制面 |
|---|---|---|
| L0 | 微小修改 | Intent + Verify |
| L1 | 小功能 | SPEC + PLAN |
| L2 | 中等功能 | Problem/PRD + SPEC + PLAN + CHECKPOINT；必要时 ADR |
| L3 | 大功能/重构 | PRD + SPEC + ADR + PLAN + CHECKPOINT + Module Review + Integration Gate |
| L4 | 关键/高风险 | L3 + Security / Migration / Rollback / Performance / Failure / Observability / Release |

**规格动态升级，不是固定仪式。**

---

## 3. 新会话先建立上下文

```text
1. pwd
2. Read AGENTS.md and project conventions
3. git status + recent git log
4. Find relevant modules, tests, run/build entrypoints
5. Read current SPEC / ADR / CHECKPOINT if present
6. Run the smallest useful baseline verification
```

不要猜：不确定就搜索仓库、真实类型、真实接口和真实运行入口。

遵循 **Just-in-Time Context**：只读取完成当前工作所需的信息，不无差别加载整个仓库。

---

## 4. Progressive Specification

### PRD / Problem
回答：**Why / Who / Outcome / Success / Out of Scope**。

### SPEC
定义 Agent 可执行的行为契约：

```text
Input / Output
State Changes
Invariants
Edge Cases
Error Semantics
Acceptance Criteria
```

### ADR
仅用于长期、跨模块、不可逆或高影响决策；记录选择、替代方案与权衡。

### PLAN
必须是任务图，而不是流水账：

```text
Task → Dependency → Contract → Verify
```

### CHECKPOINT
必须能让下一次 Agent 无需依赖聊天记忆继续工作：

```text
Current State / Completed / Risks / Best State / Next Step / Recovery Point
```

---

## 5. 长任务与跨上下文执行

复杂项目优先维护轻量状态文件，例如：

```text
.agent/
  feature_list.json   # 可验证功能清单
  progress.md         # 简短工作日志
  checkpoint.md       # 恢复锚点
```

规则：

1. 初始化运行环境、测试入口和特性清单。
2. 每次选择一个当前最高优先级、未完成、可验证的特性。
3. 实现 → 测试 → 更新状态；不要同时推进大量半成品。
4. 会话结束必须保持 clean state。
5. 重要进展用描述性 Git commit 保存。
6. 下个 Agent 先读状态与 Git 历史，再开始工作。
7. `passes=true` 只能在真实验证后设置；不得通过修改/删除测试制造绿色。

---

## 6. Agent 编排

### 角色

```text
Architect / SOTA
  → Intent / Architecture / SPEC / ADR / Decomposition / Key Decisions

Execution
  → Module implementation / mechanical changes / tests

Review / Adversarial
  → independent challenge / evidence / risk discovery

Fix
  → targeted correction based on evidence
```

复杂架构、跨模块推理、最终 Review 与收敛决策优先使用当前可用的高能力模型。

### 并行前提

只有同时满足以下条件才并行：

- 边界清楚
- 契约稳定
- 依赖方向明确
- 共享状态可控
- 写入范围基本不重叠
- 数据模型稳定

优先并行低耦合模块；高耦合任务宁可串行。

**不要为了“多 Agent”制造协调成本。**

---

## 7. Contract First

跨模块实现前先明确：

```text
API
Type / Schema
Event / Message
Module Interface
Persistence Model
Error Semantics
```

正确：

```text
Contract → Parallel Implementation → Contract Verify → Integration
```

禁止：

```text
A 自定义接口 → B 猜接口 → C 改数据模型 → 最后碰运气集成
```

---

## 8. Test / Eval First，Verification Always

对行为可明确验证的任务，优先：

```text
Expected Behavior
→ Test / Eval
→ Confirm Failure（新功能）
→ Implement
→ Iterate
→ Verify
```

验证按风险和任务选择：

```text
Unit / Type / Static
Integration / E2E / Browser
Smoke
Benchmark / Profile
Security / Migration
Runtime Observation
```

规则：

- Bug 优先补回归测试。
- 测试不得为了迎合实现而修改。
- UI / Web 功能不能只靠 Unit Test；优先真实用户路径 E2E。
- 只要问题类型需要，就必须有对应的验证证据。
- Agent 不得仅凭“代码看起来对”宣布完成。

---

## 9. Module Review：三维九域

重要模块完成后：

```text
Implementation
→ Independent Review
→ Evidence
→ Targeted Fix
→ Verification
```

### 三维

**Code Quality**：职责、可读性、命名、类型、错误处理、状态、复杂度、测试、维护性。

**Efficiency**：时间/空间复杂度、重复计算、IO、网络、DB、缓存、批处理、并发、渲染、阻塞；尽量用 benchmark / profiler / trace 证明。

**Reusability**：重复代码、模块边界、抽象、接口、参数化、公共能力、依赖反转、测试性；警惕过度抽象。

### 六大盲区

```text
Idempotency
Security
Observability
Data Integrity
Concurrency / Race
External Dependency Resilience
```

至少考虑重试、重复执行、权限、敏感数据、日志、事务、竞态、超时、限流、第三方失败与部分失败。

---

## 10. Evidence-Gated Review

每个重要 Finding 尽量遵循：

```text
Best Practice
→ Applicable?
→ Required Now?
→ Evidence
→ Gap
→ Impact
→ Priority
→ Fix
→ Verification
```

分类只能是：

```text
Required Gap
Recommended Improvement
Future Enhancement
Not Applicable
```

**Best Practice ≠ Requirement。**
不把大规模系统的实践机械套到当前项目。

禁止：

- 无证据主观扣分
- 为提高分数制造低价值重构
- 仅凭个人风格制造 P1
- “最新”自动等于“更好”

---

## 11. Priority & Fix

```text
P0 → P1 → P2
```

**P0**：数据损坏/丢失、安全漏洞、停机、核心业务数据错误、严重一致性问题。**必须清零。**

**P1**：高影响架构债务、明确瓶颈、严重耦合、关键职责混乱、高风险扩展点。是否全部修复由阶段与影响面决定，但必须明确决策。

**P2**：命名、局部重构、日志、类型细化等。不得阻塞交付或触发无限 Review。

修复必须：

1. 小范围、定点。
2. 尽量稳定既有契约。
3. 不顺手扩大重构面。
4. 修复后重新验证。
5. 跨模块影响 → Integration Review。

---

## 12. Test / Eval First，Verification Always

对行为可明确验证的任务，优先：

```text
Expected Behavior
→ Test / Eval
→ Confirm Failure（新功能）
→ Implement
→ Iterate
→ Verify
```

验证按风险和任务选择：

```text
Unit / Type / Static
Integration / E2E / Browser
Smoke
Benchmark / Profile
Security / Migration
Runtime Observation
```

---

## 13. Review Loop

默认最多 3 轮：

```text
Round 1 → primary findings
Round 2 → missed risks / consistency
Round 3 → residual risk / adversarial challenge
```

保持：

```text
BEST_STATE
CURRENT_STATE
```

后续状态不因“更新”自动优于历史最佳。

---

## 14. Integration Gate

```text
Module Review
→ Contract Verification
→ Integration
→ Integration Review
→ System Verification
→ Smoke / E2E
→ Checkpoint
```

---

## 15. Knowledge Sync

完成任何 material change 后：

```text
Change
→ Docs Impact Check
→ Update /docs
→ Verify links / terminology / status
→ Checkpoint
```

`/docs` 是规范性知识权威；代码、测试、运行结果和外部资料是证据。

---

## 16. Convergence

继续修复前评估：

```text
Severity × Likelihood × Impact × Applicability
vs.
Fix Cost + Complexity + Regression Risk
```

停止条件：

- Hard Gate 通过；
- 达到当前阶段成熟度；
- 边际收益持续降低；
- 剩余问题不是当前 Required Gap；
- 修复成本高于净收益；
- 后续变化开始伤害 BEST_STATE。

终态：

```text
PASS
FIX
ACCEPT AS-IS
ROLLBACK TO BEST
ESCALATE HUMAN
```

---