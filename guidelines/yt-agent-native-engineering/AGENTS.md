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
