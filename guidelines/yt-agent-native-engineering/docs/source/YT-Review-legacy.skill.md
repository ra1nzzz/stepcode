---
name: yt-dev-review
version: 2.0.0
description: >-
  YT-Review 系统化代码审查与全面修复方法论。
  以“三维九域”作为核心检查框架，加入第五阶段“收敛与验收”，
  强调行业最佳实践、显性证据、适用性判断、P0/P1/P2 分级、历史最佳状态、
  边际收益与停止条件，避免 Review 演化为无限优化循环。
---

# YT-Review：三维九域 + 收敛验收

## 1. 定位

YT-Review 不是“给代码打分”，而是一套：

> **Evidence-Based + Adversarial + Risk-Gated + Convergent Review Protocol**

目标：

1. 系统发现真实缺陷
2. 用行业最佳实践建立评价基准
3. 用显性证据支撑评分变化
4. 覆盖三大核心维度与六大高频盲区
5. 按风险优先级修复
6. 验证修复结果
7. 选择历史最佳状态
8. 在达到足够成熟度后主动停止

---

## 2. 触发条件

出现以下任一情况自动启用：

- 新模块完成
- 重要功能完成
- 跨模块重构完成
- 数据模型变化
- API/接口变化
- 高风险逻辑变化
- 发布前
- 用户明确要求代码 Review
- Agent 判断当前变更具有中高风险

Tiny change 可采用 Lite Review。

---

# 第一阶段：三维并行评审

启动至少 3 个相互独立的 Review 角色：

```text
Reviewer A → 代码质量
Reviewer B → 代码效率
Reviewer C → 可复用性
```

核心要求：

- 并行执行
- 独立判断
- 具体证据
- 不互相引用结论作为证据

---

## 3. 维度 A — 代码质量

重点检查：

- 可读性
- 模块职责
- 命名
- 类型安全
- 错误处理
- 状态管理
- 复杂度
- 测试覆盖
- 一致性
- 可维护性

### 评分要求

不得只写：

```text
7.8/10
```

必须写明：

```text
Best Practice:
Evidence:
Gap:
Impact:
Recommended Fix:
Score:
```

---

## 4. 维度 B — 代码效率

重点检查：

- 时间复杂度
- 空间复杂度
- 重复计算
- IO
- 网络调用
- 数据库访问
- 缓存
- 批处理
- 并发
- 不必要的渲染/重建
- 阻塞

要求优先提供可验证证据：

- benchmark
- profiler
- query plan
- trace
- runtime observation
- complexity analysis

---

## 5. 维度 C — 可复用性

重点检查：

- 重复代码
- 模块边界
- 抽象层
- 接口设计
- 参数化
- 公共能力提取
- 依赖反转
- 可测试性
- 跨模块复用

必须警惕过度抽象。

> **并非所有重复代码都值得抽象。**

如果抽象会增加复杂度，却没有明确的复用场景，应倾向于保留局部简单实现。

---

# 第二阶段：六大盲区专项扫描

三维 Review 完成后，必须独立扫描以下六域：

```text
① 幂等性
② 安全性
③ 可观测性
④ 数据完整性
⑤ 并发与竞态
⑥ 外部依赖韧性
```

---

## 6. 幂等性（Idempotency）

检查：

- 重试
- 重复提交
- 消息重复消费
- Job 重跑
- 网络超时后的重复调用
- 分布式操作重复执行

必须明确哪些操作：

```text
safe to retry
unsafe to retry
conditionally idempotent
```

---

## 7. 安全性（Security）

检查：

- 权限
- 身份认证
- 输入校验
- 注入
- Secrets
- 文件访问
- SSRF
- XSS
- CSRF
- 数据泄漏
- 日志敏感信息
- 依赖漏洞

安全问题不得通过“评分平均”掩盖。

---

## 8. 可观测性（Observability）

检查：

- 日志
- metrics
- traces
- correlation/request ID
- 错误上下文
- 关键状态转移
- 调试能力
- 告警触发条件

要求：出现问题时，系统必须能够回答：

```text
发生了什么？
发生在哪里？
为什么发生？
影响了什么？
```

---

## 9. 数据完整性（Data Integrity）

检查：

- schema
- migration
- transaction
- atomicity
- consistency
- validation
- partial write
- rollback
- duplicate data
- lost update
- corruption

涉及财务、库存、订单、用户核心数据时，应升级为高风险审查。

---

## 10. 并发与竞态（Concurrency）

检查：

- race condition
- deadlock
- lost update
- double execution
- transaction isolation
- shared state
- lock
- async cancellation
- queue ordering

必须尽量通过测试、trace 或可复现案例证明。

---

## 11. 外部依赖韧性（Resilience）

检查：

- timeout
- retry
- backoff
- circuit breaker
- fallback
- rate limit
- dependency failure
- network partition
- third-party API 变化
- partial failure

---

# 12. 评分体系：Evidence-Gated Score

## 12.1 评分定义

建议统一解释：

```text
0–4：明显不满足基本实践
5–6：基本可运行，但存在明显工程缺口
7–7.9：接近成熟，但存在值得修复的问题
8–8.9：达到当前项目所需的行业成熟实践
9–9.5：高成熟度、优秀实践
9.5–10：接近参考实现/极致优化
```

### 重要规则

> **8 分不是“完美”，而是“达到当前阶段所需的成熟实践”。**

9、10 分不是默认目标。

---

## 12.2 Score 必须由 Evidence 驱动

任何提分必须有显性凭证。

合法证据包括：

- SPEC/ADR 对应条款
- 代码位置
- 测试结果
- benchmark
- profiler
- static analysis
- type check
- security scan
- integration test
- runtime trace
- reproducible case
- migration test
- contract test

禁止仅写：

> “代码更优雅，所以从 7.5 提到 8.3。”

必须回答：

```text
Before:
Evidence:
Fix:
Verification:
After:
```

---

# 13. 最关键规则：Best Practice ≠ Requirement

发现行业最佳实践后，必须先判断：

```text
Applicable?
    ↓
Required for current system?
    ↓
Required for current stage?
    ↓
Evidence of gap?
```

例如：

> 分布式系统需要某种高级恢复能力

不能因此推断：

> 单机桌面工具必须实现同等级方案。

### Review 输出必须区分：

```text
Required Gap
Recommended Improvement
Future Enhancement
Not Applicable
```

---

# 第三阶段：分级修复

## 14. P0 — 立即修复

特征：

- 数据丢失/损坏
- 安全漏洞
- 服务停机
- 财务/库存等核心数据错误
- 严重一致性问题

P0 必须清零才能通过。

---

## 15. P1 — 架构债务 / 高影响问题

例如：

- 严重耦合
- 重复实现
- 错误处理混乱
- 核心模块职责不清
- 明确性能瓶颈
- 高风险扩展点

P1 是否必须全部修复，取决于当前阶段与影响面，但必须有明确决策。

---

## 16. P2 — 质量与体验

例如：

- 命名
- 日志规范
- 局部重构
- 类型细化
- 轻微可读性问题

P2 不得阻止项目为了“更漂亮”而进入无限 Review Loop。

---

## 17. 修复规则

按：

```text
P0 → P1 → P2
```

修复时遵循：

1. 小范围修改
2. 保持契约稳定
3. 不顺手扩大重构范围
4. 每次修复都必须重新验证
5. 发现跨模块影响，升级 Integration Review

---

# 第四阶段：验证闭环

## 18. Verify

修复后至少执行与问题类型对应的验证：

```text
Unit Test
Type Check
Static Analysis
Integration Test
Smoke Test
Benchmark
Security Scan
Migration Test
Runtime Observation
```

不是所有项目都必须全部执行，但每个 Review Finding 都必须有对应验证方式。

---

## 19. 修复闭环

```text
Finding
 ↓
Evidence
 ↓
Priority
 ↓
Fix
 ↓
Test
 ↓
Re-review
 ↓
Evidence Updated
```

修复后的评分只能基于新的证据更新。

---

# 第五阶段：Convergence & Acceptance

> **这是 YT-Review 2.0 的核心新增阶段。**

## 20. 为什么需要第五阶段

Review 的目标不是无限发现问题，而是：

> **达到合理成熟度后，以最低额外复杂度完成可靠交付。**

因此必须明确：

```text
继续优化？
还是
接受当前状态？
```

---

## 21. 历史最佳状态（Best State）

每一轮 Review 必须记录：

```text
Round
Score by Dimension
P0/P1/P2
Evidence
Changed Files
Resolved Findings
New Findings
Regression
```

维护：

```text
BEST_STATE
CURRENT_STATE
```

### 规则

后续版本不因“轮次更晚”而自动视为更优。

如果：

```text
CURRENT_STATE < BEST_STATE
```

允许：

```text
ROLLBACK TO BEST_STATE
```

---

## 22. 收敛决策函数

对于每个剩余问题，评估：

```text
Severity
×
Likelihood
×
Impact
×
Applicability
```

再考虑：

```text
Fix Cost
+
Complexity Introduced
+
Regression Risk
```

最终判断其净收益。

### 核心问题

> **“这个问题存在”不等于“这个问题现在值得修”。**

---

## 23. 边际收益（Marginal Gain）

记录每轮：

```text
Score Gain
Risk Reduction
Complexity Added
```

例如：

```text
Round 1: +0.8 / 高价值
Round 2: +0.5 / 高价值
Round 3: +0.2 / 中价值
Round 4: +0.05 / 低价值
Round 5: +0.02 / 几乎无价值
```

当连续多轮边际收益显著下降，应进入收敛判断，而不是自动继续。

---

## 24. Review 的五种终态

最终决策只能是以下之一：

### PASS

Hard Gate 通过，并达到项目目标成熟度。

### FIX

当前发现仍然值得继续修复。

### ACCEPT AS-IS

存在问题，但：

- 非当前阶段必要
- 风险低
- 修复成本高
- 或会引入更大复杂度

明确记录 Accepted Risk。

### ROLLBACK TO BEST

后续迭代损害了整体状态，恢复历史最佳版本。

### ESCALATE HUMAN

Agent 无法判断继续优化的收益与风险，交由人工决策。

---

## 25. Hard Gate 与 Soft Gate

### Hard Gate

例如：

```text
P0 = 0
Critical Security = 0
Critical Data Integrity = 0
Required Tests = Pass
```

### Soft Gate

例如：

```text
Quality >= 8
Efficiency >= 8
Reuse >= 8
```

### 规则

Soft Gate 不得掩盖 Hard Gate。

同时：

> **Soft Gate 的目标是“达到成熟线”，而不是“无限趋近 10 分”。**

---

# 26. 防止 20 轮无限循环

默认：

```text
max_review_rounds = 3
```

复杂项目允许提高，但超过 5 轮必须触发：

```text
Convergence Review
```

Convergence Review 必须回答：

1. 当前最佳状态是哪一轮？
2. 剩余问题哪些是 Required Gap？
3. 哪些只是 Recommended Improvement？
4. 最近几轮边际收益如何？
5. 后续修改是否可能伤害整体架构？
6. 是否应该回滚？
7. 是否应该 ACCEPT AS-IS？
8. 是否应该请求人工决策？

---

# 27. 抗偏差原则

## Reviewer Bias

Review Agent 倾向于发现更多问题，不代表每个问题都值得修。

## Score Chasing

不得为了数字提高而进行低价值重构。

## Best-Practice Inflation

不得不断引入越来越高等级、但与当前项目无关的实践作为扣分依据。

## Latest-Version Bias

不得默认最新版本优于历史最佳版本。

## Correlated Failure

实现 Agent 与 Review Agent 若使用相同视角导致结论高度一致，应增加独立 Review 视角或工具化验证。

---

# 28. 最终输出格式

## 评审报告

```text
## 评审报告

### 维度 A：代码质量（X/10）
- [事实/证据] 具体代码位置 + 问题
- [必要性] Required / Recommended / Future / N/A
- [修复建议]

### 维度 B：代码效率（X/10）
...

### 维度 C：可复用性（X/10）
...

### 盲区扫描
- 幂等性：发现/未发现
- 安全性：发现/未发现
- 可观测性：发现/未发现
- 数据完整性：发现/未发现
- 并发与竞态：发现/未发现
- 外部依赖韧性：发现/未发现

### 修复清单
| 优先级 | 文件 | Evidence | 问题 | 修复方案 | 验证 |
|---|---|---|---|---|---|

### 收敛状态
- Current State:
- Best State:
- Score Delta:
- Marginal Gain:
- Remaining Accepted Risks:

### 门禁结论
PASS / FIX / ACCEPT AS-IS / ROLLBACK TO BEST / ESCALATE HUMAN
```

---

# 29. 修复报告

```text
## 修复报告（X 项，Y/Y 测试通过）

### P0
| 文件 | 修复内容 | Evidence | 验证 |

### P1
| 文件 | 修复内容 | Evidence | 验证 |

### P2
| 文件 | 修复内容 | Evidence | 验证 |

### 验证结果
- Tests: Y/Y
- Type Check: PASS/FAIL
- Static Analysis: PASS/FAIL
- Module Load: PASS/FAIL
- Smoke Test: PASS/FAIL
- Integration: PASS/FAIL

### 最终状态
- Best State:
- Current State:
- Decision:
- Accepted Risks:
```

---

# 30. 核心原则

> **Review 的价值不是发现最多的问题，而是在真实证据、行业最佳实践与项目实际约束之间做出最优工程决策。**

> **代码质量的终点不是 10 分，而是达到当前项目所需的成熟度，并以最低额外复杂度稳定交付。**

> **最好的 Review 不是让系统永远处于“正在优化”，而是知道什么时候已经足够好、为什么足够好，以及为什么应该停止。**
