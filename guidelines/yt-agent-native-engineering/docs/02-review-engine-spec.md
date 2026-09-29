# YT-ANSE Review Engine Specification v0.1

## Purpose

Provide a deterministic substrate beneath `yt-anse-review` so review quality does not depend on Agent self-discipline for mechanical tasks.

## Pipeline

```text
Review Request
→ Scope Manifest
→ Rule / Lens Resolution
→ Semantic Review Units
→ Budget Gate
→ Agent Review
→ Deterministic Evidence Anchoring
→ Fact Gate
→ Governance Gate
→ Fix / Verify
→ Integration Review
→ Convergence
```

## Review Manifest

Every review records:

```yaml
review_id:
base:
head:
mode:
changed_files:
reviewed_files:
excluded_files:
coverage:
lenses:
ruleset_hash:
groups:
context_budget:
review_rounds:
```

## Coverage contract

Every changed file must end in exactly one explicit state:

```text
reviewed
excluded + reason
skipped + reason
failed + reason
```

Unknown coverage is not PASS.

## Semantic grouping

Grouping is an optimization, not a correctness dependency.

Guardrails:

- maximum files per group
- maximum context size
- deterministic fallback to smaller groups / single-file review
- no cross-group finding target unless the finding is represented as module/system scope

## Review Lens Registry

Default lenses:

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

Optional lenses:

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

Lens selection should be risk- and path-aware.

## Evidence anchor

A finding must have an anchor:

```text
LINE | FILE | MODULE | SYSTEM
```

Prefer deterministic line resolution. If resolution fails, mark it unresolved or invoke a relocation agent, then re-validate deterministically.

## Fact Gate

Only remove a finding when deterministic or review evidence establishes that the claim is false. Unverified is not the same as false.

## Governance Gate

A confirmed finding is still assessed for:

```text
Applicability
Required now?
Severity
Likelihood
Impact
Fix cost
Regression risk
Marginal benefit
```

## Finding states

```text
proposed
→ fact_checked
→ confirmed
→ fixed
→ verified
```

Alternative terminal states:

```text
rejected
accepted_risk
```

## Convergence

The review may end as:

```text
PASS
ACCEPT AS-IS
ROLLBACK TO BEST
ESCALATE HUMAN
```

Maintain `CURRENT_STATE` and `BEST_STATE` across rounds.
