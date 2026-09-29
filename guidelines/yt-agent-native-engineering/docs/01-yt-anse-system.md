# YT-ANSE System Specification v0.1

## Definition

YT-ANSE (YT Agent-Native Software Engineering) is a project-centered software production system in which project knowledge is persistent, development is progressively specified, execution is Agent-orchestrated, deterministic operations are enforced by tooling, review is adversarial and evidence-driven, and optimization converges to an accepted state.

## Five principles

### 1. Knowledge before Action
Restore `/docs`, current Git state and relevant project context before making material changes.

### 2. Specification before Parallelism
Establish sufficient behavior, boundaries and contracts before parallel execution.

### 3. Determinism before Intelligence
Use code for scope, parsing, matching, validation, accounting and other deterministic work; use Agents for reasoning and dynamic decisions.

### 4. Evidence before Judgment
Findings require concrete anchors and verification evidence. Best practice is not automatically a requirement.

### 5. Convergence before Perfection
Stop when hard gates pass and further changes have insufficient net value. Preserve the historical best state.

## Closed loop

```text
Intent → Context → Specify → Contract → Execute
→ Review → Verify → Integrate → Checkpoint
→ Converge → Persist → /docs
```

## Layer contracts

- `/docs`: normative project memory.
- Orchestration: decides required process and execution structure.
- Deterministic Engine: enforces mechanical correctness and resource limits.
- Review Agents: reason about code, architecture and risk.
- Governance: decides applicability, priority, acceptance and convergence.
