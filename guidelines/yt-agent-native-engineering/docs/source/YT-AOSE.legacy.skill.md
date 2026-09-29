---
name: yt-aose-agent-self-orchestration-engine
version: 1.0.0
description: >-
  YT-AOSE（Agent-Orchestrated Software Engineering）自编排开发引擎。
  以渐进式规格开发（Progressive Specification）与 PRD/SPEC/ADR/PLAN/CHECKPOINT
  五件套为控制面，让 SOTA Agent 自主完成需求澄清、规格升级、任务解耦、并行执行、
  对抗性审阅、定点修复、集成验证与状态推进，同时通过按复杂度分级治理避免过度工程化，
  通过契约优先、依赖图、集成门禁避免 Multi-Agent 集成地狱。
---

# YT-AOSE Agent 自编排开发引擎

## 1. 定位

YT-AOSE 不是“让 Agent 多写一些代码”的提示词，而是一套 Agent-Native Software Engineering 的自编排协议。

核心目标：

> **让 SOTA Agent 根据任务复杂度，自动决定需要多少规格、多少 Agent、多少 Review、何时并行、何时合并、何时停止，而不是机械套用完整工程流程。**

核心原则：

1. **渐进式规格，而非一次性大而全设计。**
2. **五件套是控制面，不是固定表单。**
3. **先建立边界与契约，再并行实现。**
4. **并行的最小单位是“低耦合、契约稳定”的模块，而不是任意文件。**
5. **执行必须优先使用当前可用的 SOTA 模型承担核心推理与架构决策。**
6. **实现 Agent 与 Review/Fix Agent 尽量角色分离，形成对抗性验证。**
7. **局部完成不等于项目完成，必须经过集成级验证。**
8. **质量优化必须可收敛；不得为了追求理论上的更高分无限循环。**
9. **保留历史最佳状态，允许回滚到 Best State，而不是默认“最后一轮最好”。**
10. **人负责意图、边界和高价值决策，Agent 负责探索、分解、执行与验证。**

---

## 2. 适用场景

适用于：

- 中大型软件项目
- 复杂功能迭代
- 多模块重构
- 新系统/新产品开发
- 需要多个 Coding Agent 并行执行的项目
- 需要高质量架构文档与长期可维护性的项目

不适合机械用于：

- 单行/单函数修改
- 明确且无架构影响的小 Bug
- 纯文本、样式、配置微调
- 10 分钟内可完成且几乎没有集成风险的任务

---

## 3. 总体模型

```text
Intent
  ↓
Complexity Assessment
  ↓
Progressive Specification
  ↓
PRD / SPEC / ADR / PLAN / CHECKPOINT（按需启用）
  ↓
Architecture & Contract Boundary
  ↓
Task Graph / Dependency Graph
  ↓
Parallel Agent Execution
  ↓
Module-level Adversarial Review
  ↓
Targeted Fix
  ↓
Integration
  ↓
Integration Review + Verification
  ↓
Convergence / Acceptance
  ↓
CHECKPOINT
```

---

## 4. 第一原则：渐进式规格开发

不要默认“一开始把所有 PRD、SPEC、ADR、PLAN 写完”。

根据任务复杂度逐级增加规格密度。

### L0 — Tiny Change

仅需要：

- 用户意图
- 实现范围
- 基本验证

流程：

```text
Prompt → Execute → Test → Done
```

### L1 — Small Feature

启用：

- 简短 SPEC
- 简短 PLAN

流程：

```text
SPEC → PLAN → Execute → Review → Verify
```

### L2 — Medium Feature

启用：

- PRD 或 Problem Statement
- SPEC
- PLAN
- CHECKPOINT

必要时补 ADR。

### L3 — Large Feature / Refactor

启用完整五件套：

- PRD
- SPEC
- ADR
- PLAN
- CHECKPOINT

并启用：

- 模块解耦
- Agent 并行
- 对抗性 Review
- 集成门禁

### L4 — Critical / High Risk

在 L3 基础上额外启用：

- 安全评估
- 数据迁移/回滚方案
- 性能预算
- 失败模式
- 可观测性
- 灾备/恢复
- 发布策略

**规则：规格是动态升级的，不是静态仪式。**

---

## 5. 五件套职责

### PRD — Intent / Outcome

回答：

- 为什么做
- 谁使用
- 解决什么问题
- 成功标准是什么
- 明确不做什么

PRD 不负责描述实现细节。

### SPEC — Contract / Behavior

回答：

- 系统必须做什么
- 输入/输出
- 状态变化
- 边界条件
- 验收标准
- 不变量

SPEC 是 Agent 执行的核心契约。

### ADR — Decision / Rationale

回答：

- 为什么选择这个方案
- 为什么不选其他方案
- 关键权衡是什么
- 哪些约束会长期存在

仅记录有长期影响、跨模块或不可逆的决策。

### PLAN — Execution

回答：

- 怎么拆
- 拆成哪些模块
- 哪些任务可以并行
- 依赖关系是什么
- 验证点在哪里

PLAN 必须是可执行的任务图，而不是流水账。

### CHECKPOINT — State / Recovery

回答：

- 当前完成了什么
- 哪些模块通过
- 哪些风险未解决
- 当前最佳状态在哪里
- 下一步是什么
- 如何从当前状态恢复

CHECKPOINT 是 Agent 长链任务的恢复锚点。

---

## 6. SOTA 模型执行策略

### 6.1 核心推理优先级

涉及以下任务时，优先使用当前可用 SOTA 模型：

- 需求理解
- 架构设计
- SPEC 设计
- ADR 决策
- 复杂重构
- 跨模块依赖分析
- 最终 Review
- 集成问题定位
- 收敛决策

### 6.2 模型分层

```text
SOTA / Architect Agent
    ↓
负责理解、架构、拆解、关键决策

Execution Agent
    ↓
负责模块实现、测试、机械修改

Review / Adversarial Agent
    ↓
独立挑战实现与规格

Fix Agent
    ↓
根据证据定点修复
```

不要为了节省 Token，把高难度架构问题下放给低能力执行模型。

### 6.3 模型身份不可靠时

如果运行环境无法可靠提供模型身份信息，不得假设 Agent 知道自己是不是 SOTA。
调度层应在外部配置当前：

```text
sota_models:
  - ...
execution_models:
  - ...
review_models:
  - ...
```

由 Runtime / Harness 决定实际模型角色。

---

## 7. 自编排：Agent 必须先做 Complexity & Risk Assessment

每次大任务开始前，先判断：

```text
complexity:
  tiny | small | medium | large | critical

risk:
  low | medium | high | critical

parallelizable:
  yes | partial | no

integration_risk:
  low | medium | high
```

然后自动决定：

- 是否需要五件套
- 是否需要 ADR
- 是否需要拆分 Agent
- 是否需要并行
- 是否需要独立 Review
- 是否需要集成 Review
- 是否需要人工 Gate

### 禁止

不得因为“技能要求完整流程”而给所有任务强行创建完整五件套。

---

## 8. 模块解耦与并行开发

### 8.1 并行前置条件

一个模块只有在满足以下条件时才能独立并行：

1. 责任边界明确
2. 输入/输出契约明确
3. 依赖方向明确
4. 共享状态可控
5. 数据模型/接口契约稳定
6. 与其他 Agent 的写入范围尽量不重叠

### 8.2 任务图

必须先建立：

```text
Task Graph
+
Dependency Graph
+
Interface Contract
```

然后再分派 Agent。

### 8.3 并行原则

优先并行：

```text
A: UI
B: Domain Logic
C: API
D: Tests
```

谨慎并行：

```text
多个 Agent 同时修改同一个核心模块
多个 Agent 修改同一数据结构
多个 Agent 同时进行跨边界重构
```

### 8.4 最小冲突原则

如果两个任务高度依赖，应宁可串行，也不要为了“Agent 数量”强行并行。

> **并行优化的是独立工作，不是制造更多协调成本。**

---

## 9. 防止集成地狱：Contract-First

并行开发前必须确定关键契约：

- API contract
- type/schema
- event/message contract
- module interface
- persistence model
- error semantics

模块内部可以变化，但跨模块契约必须稳定。

### 典型禁止模式

```text
Agent A 自己定义 API
Agent B 猜 API
Agent C 自己修改数据模型
最后统一“碰运气集成”
```

正确模式：

```text
Contract
  ↓
Parallel Implementation
  ↓
Contract Verification
  ↓
Integration
```

---

## 10. 每个模块完成后的 Review

每个模块完成后不得直接标记 DONE。

至少执行：

```text
Implementation
  ↓
Independent Adversarial Review
  ↓
Evidence Collection
  ↓
Targeted Fix
  ↓
Verification
```

Review 优先调用 `yt-dev-review`。

Review Agent 与 Implementation Agent 应尽量保持角色分离；对高风险模块优先使用独立 SOTA Review Agent。

---

## 11. 对抗性 Review 原则

Review Agent 不承担“证明自己写得好”的目标，而承担：

> **尝试证明当前实现不满足规格、不符合最佳实践或存在真实风险。**

它必须：

- 找证据
- 指出具体位置
- 区分事实与建议
- 判断适用性
- 判断严重程度
- 给出可验证修复方案

禁止：

- 无证据的主观扣分
- 为了提高分数而制造低价值重构
- 仅凭风格偏好制造 P1
- 把不适用的行业实践强行套进当前项目

---

## 12. 修复策略：定点，不扩散

Review 发现问题后：

1. 先判断问题是否属于当前阶段必须解决。
2. 优先修复 P0/P1。
3. 对 P2 评估边际价值。
4. 避免“顺手重构”扩大变更面。
5. 修复后仅重新审查受影响区域及其接口。
6. 涉及跨模块契约时，升级为 Integration Review。

---

## 13. 收敛机制

### 13.1 不允许无限 Review Loop

默认规则：

```text
max_review_rounds: 3
```

复杂项目可扩展，但必须有理由。

### 13.2 历史最佳状态

每轮记录：

```text
round_id
score
P0/P1/P2
changed_files
new_risks
resolved_risks
checkpoint
```

维护：

```text
BEST_STATE
CURRENT_STATE
```

如果后续修改导致整体质量下降，允许：

```text
ROLLBACK → BEST_STATE
```

### 13.3 收敛判定

满足以下任一情况可停止：

- 所有 Hard Gate 通过
- 达到目标成熟度
- 连续多轮边际收益很低
- 剩余问题属于非当前阶段要求
- 修复收益低于复杂度/风险成本
- 后续修改开始损害整体设计

### 13.4 ACCEPT AS-IS

“存在问题”不自动等于“必须继续修”。

Agent 必须判断：

```text
Applicable?
Required now?
Risk?
Fix Cost?
Architecture Impact?
Marginal Benefit?
```

允许输出：

```text
PASS
FIX
ACCEPT AS-IS
ROLLBACK TO BEST
ESCALATE HUMAN
```

---

## 14. 集成级质量门禁

模块全部完成后，必须进行：

```text
Module Review
  ↓
Contract Verification
  ↓
Integration
  ↓
Integration Review
  ↓
System Test
  ↓
Smoke Test
  ↓
Checkpoint
```

核心原则：

> **局部高分不能替代全局正确。**

必须特别验证：

- 模块接口
- 共享状态
- 数据一致性
- 并发行为
- 错误传播
- 事务边界
- 外部依赖
- 可观测性

---

## 15. Agent 自编排循环

```text
while not accepted:

  assess_complexity_and_risk()

  update_specification_level()

  if missing_required_spec:
      create_or_update_PRD_SPEC_ADR_PLAN()

  build_task_graph()
  establish_contracts()

  dispatch_parallel_agents_when_safe()

  for completed_module in completed_modules:
      run_adversarial_review()
      collect_evidence()
      fix_targeted_issues()
      verify_module()

  integrate_modules()
  run_integration_review()
  run_system_verification()

  record_checkpoint()
  update_best_state()

  decision = convergence_decision()

  if decision == PASS:
      accepted = true
  elif decision == ACCEPT_AS_IS:
      accepted = true
  elif decision == ROLLBACK_TO_BEST:
      restore_best_state()
  elif decision == ESCALATE_HUMAN:
      stop_at_human_gate()
```

---

## 16. 输出要求

### 开始任务时

输出：

```text
## YT-AOSE Orchestration Decision
- Complexity:
- Risk:
- Spec Level:
- Required Artifacts:
- Parallelizable Modules:
- Integration Risks:
- Review Strategy:
- Convergence Policy:
```

### 中间状态

每完成一个重要阶段更新 CHECKPOINT。

### 最终

输出：

```text
## YT-AOSE Final Report
- Objective:
- Spec Level:
- Modules:
- Parallel Agents:
- Module Review Results:
- Integration Review:
- Verification:
- Best State:
- Remaining Accepted Risks:
- Final Decision:
```

---

## 17. 反模式

### 过渡工程化

一个小需求生成完整 PRD/SPEC/ADR/PLAN/CHECKPOINT。

### 过度并行

没有稳定契约就拆 Agent。

### Review 无限循环

不断寻找理论上的新问题，没有停止条件。

### Score Chasing

为了从 8.4 提到 8.6，进行高风险、低收益改造。

### Local Optimization

模块评分都很高，但最终集成失败。

### Last Version Bias

默认最后一轮一定优于历史版本。

### Reviewer Echo

实现 Agent 与 Review Agent 使用相同视角，互相验证。

---

## 18. 最终原则

> **规格要够用，而不是够多；并行要建立在边界与契约之上；Review 要对抗而不是附和；修复要有证据；质量要能验证；优化必须能停止。**

YT-AOSE 的最终目标不是“让 Agent 更像工程师”，而是：

> **建立一个可由 Agent 自主运行、由工程约束控制、由证据驱动验证、由 Checkpoint 支持恢复的软件生产系统。**
