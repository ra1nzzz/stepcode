---
name: yt-anse-review
version: 3.0.0
description: >-
  YT-ANSE Review Governance + Deterministic Review Engine protocol. Combines
  three-dimensional review, risk lenses, evidence governance, deterministic
  scope/group/rule/anchor controls, adversarial review and convergence.
---

# YT-ANSE Review 3.0

## 1. Mission

Review is not “find as many issues as possible”. It is:

```text
establish coverage
→ apply the right lenses
→ find candidate issues
→ prove or disprove them
→ assess applicability and priority
→ fix and verify
→ converge to the best accepted state
```

## 2. Architecture

```text
                 YT-ANSE Review
                        │
        ┌───────────────┼───────────────┐
        ↓               ↓               ↓
 Deterministic      Agent            Governance
   Engine          Reasoning        & Convergence
        │               │               │
 Scope / Coverage   Context          Applicability
 Grouping           Analysis        Severity / Priority
 Rule Resolution    Architecture    Evidence
 Budget             Risk            Fix / Verify
 Anchor             Business        Best State
 Fact Gate          Logic           Convergence
 Session / Metrics
```

Never use an Agent to perform a deterministic check when a reliable script can perform it.

## 3. Review Modes

```text
Lite     → narrow scope, essential checks
Standard → default feature/module review
Deep     → high-risk / cross-module / release review
System   → architecture, integration, runtime and business-flow review
```

Mode is selected by risk and scope, not by habit.

## 4. Step 0 — Restore Context

Read:

```text
AGENTS.md
→ relevant /docs
→ current git state
→ relevant specs / ADR / checkpoints
→ affected code / tests / runtime entrypoints
```

For a long-running review, resume from the persisted review session when available.

## 5. Step 1 — Deterministic Scope Manifest

Before Agent review, resolve scope mechanically.

Every changed item must receive one explicit state:

```text
reviewed
excluded + reason
skipped + reason
failed + reason
```

At minimum record:

```yaml
review_id:
base:
head:
mode:
changed_files:
reviewed_files:
excluded_files:
coverage:
ruleset_hash:
lenses:
groups:
context_budget:
```

**Unknown coverage is not PASS.**

Use `engine/scripts/review_scope.py` or an equivalent deterministic implementation.

## 6. Step 2 — Resolve Rules and Review Lenses

Review Lenses are selected by path, change type, risk and project policy.

### Core Lenses

```text
quality
 efficiency
 reuse
 idempotency
 security
 observability
 data_integrity
 concurrency
 resilience
```

### Optional Lenses

```text
compatibility
architecture
testability
ux
terminology
business_logic
privacy
agent_safety
cost
```

Never elevate an industry best practice to a required finding without proving applicability and project relevance.

## 7. Step 3 — Semantic Review Units

Do not assume `1 file = 1 review unit`.

Group files when semantic or contractual relationships improve reasoning. Guard every group with:

```text
max files
max context/tokens
max review work
fallback to smaller groups / single-file review
```

Grouping is an optimization, never a coverage dependency.

## 8. Step 4 — Context and Budget Gate

Budget is explicit:

```text
Global Budget
+ Group Budget
+ Round Budget
```

Before an LLM call, ensure the context fits the budget. If not:

```text
split → compress → retry
```

A skipped or truncated group must remain visible in the manifest and cannot silently become PASS.

## 9. Step 5 — Independent Adversarial Review

Preferred roles:

```text
Quality Reviewer
Efficiency Reviewer
Reuse Reviewer
```

Add risk-specific reviewers only when justified.

Reviewers must be independent where correlation could hide failure. Do not use another reviewer’s conclusion as evidence.

Focus on changed behavior and affected contracts; inspect surrounding code when necessary to understand the change.

## 10. Step 6 — Finding Contract

A candidate finding contains:

```yaml
id:
scope: line | file | module | system
path:
start_line:
end_line:
symbol:
lens:
claim:
evidence:
severity:
priority:
applicability:
required_now:
fix:
verification:
status:
```

Evidence anchors are mandatory for formal findings. Prefer deterministic line resolution. If resolution fails, mark the finding unresolved or invoke a relocation agent, then re-validate deterministically.

## 11. Step 7 — Fact Gate

The Fact Gate answers:

> Is the central claim actually supported by repository evidence?

Use deterministic validation first where possible; use an independent Agent for semantic fact checking.

Never equate “cannot verify” with “false”.

Candidate states:

```text
proposed
→ fact_checked
→ confirmed
```

or:

```text
rejected
```

## 12. Step 8 — Governance Gate

A confirmed finding must still answer:

```text
Applicable?
Required now?
Severity?
Likelihood?
Impact?
Fix Cost?
Regression Risk?
Marginal Benefit?
```

Classify:

```text
Required Gap
Recommended Improvement
Future Enhancement
Not Applicable
```

Then assign:

```text
P0 — critical security / integrity / availability / core-business failure
P1 — high-impact architecture / reliability / performance / extensibility issue
P2 — local quality / cleanup / non-critical improvement
```

Severity and priority are separate concepts.

## 13. Step 9 — Targeted Fix

Fix only what the finding requires.

Rules:

1. P0 before P1 before P2.
2. Preserve stable contracts unless the task explicitly changes them.
3. Avoid opportunistic refactoring.
4. Re-review affected scope after the fix.
5. Cross-module contract changes require Integration Review.

## 14. Step 10 — Verification

Every confirmed finding must have a matching verification method.

```text
Finding
→ Evidence
→ Fix
→ Test / Runtime Verification
→ Re-review
```

Suitable evidence includes:

```text
unit / type / static / integration / E2E / benchmark /
profile / security / migration / runtime observation
```

## 15. Step 11 — Integration Review

After module-level completion:

```text
Module Review
→ Contract Verification
→ Integration
→ Integration Review
→ System Verification
→ Smoke / E2E when relevant
```

Check explicitly:

```text
interfaces
shared state
data consistency
concurrency
error propagation
transaction boundaries
external dependencies
observability
```

Local correctness does not prove global correctness.

## 16. Step 12 — Multi-round Review

Default maximum: 3 rounds.

```text
Round 1 → obvious defects + primary lenses
Round 2 → missed risks + cross-file consistency
Round 3 → residual risk + adversarial challenge
```

Stop early when no meaningful new findings appear or the budget is exhausted.

## 17. Step 13 — Best State and Convergence

Track after every round:

```text
CURRENT_STATE
BEST_STATE
resolved findings
new findings
regressions
verification
review cost
```

Do not optimize scores for their own sake.

A later state may be rejected when:

```text
risk reduction is negligible
or
complexity / regression risk exceeds benefit
```

Terminal decision:

```text
PASS
ACCEPT AS-IS
ROLLBACK TO BEST
ESCALATE HUMAN
```

## 18. Session and Metrics

Persist enough state to resume a review without chat history:

```text
manifest
scope
groups
findings
verification
metrics
best_state
current_state
decision
```

Measure where possible:

```text
coverage
precision
recall
F1
false-positive rate
anchor accuracy
verification rate
regression rate
tokens
time
cost per finding
```

Use a project Gold Set to evaluate changes to the review system itself.

## 19. Knowledge Synchronization

Review results are project knowledge.

Before final acceptance:

```text
confirmed decisions
accepted risks
new architectural facts
new terminology
benchmark findings
review limitations
→ update /docs
```

A review with stale `/docs` is incomplete.

## 20. Deterministic Engine Interface

Recommended engine modules:

```text
scope resolver
rule/lens resolver
grouping guard
context/token guard
anchor resolver
finding validator
session store
metrics collector
```

Reference scripts are under `engine/scripts/`.

## 21. Anti-patterns

Never:

- claim full coverage without a scope manifest;
- let an Agent invent line numbers when deterministic resolution is possible;
- delete an uncertain finding merely because it feels low-value;
- treat best practice as a mandatory requirement without applicability evidence;
- optimize for score, reviewer count or process completeness;
- assume the latest state is the best state;
- let a successful module review substitute for integration verification.
