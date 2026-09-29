---
name: yt-anse-knowledge
version: 1.0.0
description: YT-ANSE 项目知识库治理协议。
---

# YT-ANSE Knowledge Governance

## Mission

`/docs` is the project's normative knowledge source. Keep project meaning, decisions, specifications, terminology, references, state, evidence indexes and accepted risks synchronized with implementation.

## Non-negotiable rules

1. Before acting, restore the smallest relevant `/docs` context.
2. After any material change, perform a Docs Impact Check before continuing.
3. Never declare Done while required `/docs` updates are stale.
4. Code, tests, runtime and external sources are evidence; `/docs` records the normative interpretation and decision.
5. Never silently resolve conflicts between implementation and `/docs`; record the conflict and decision.
6. One concept → one canonical term → one stable meaning.
7. New cross-module terminology must be defined in `/docs` before propagation.
8. Keep semantic content separate from presentation wording.

## Docs Impact Check

```text
Change
→ Identify affected concepts / decisions / specs / references
→ Update canonical /docs documents
→ Verify links / terminology / status
→ Continue
```

## Research record

For external research, record:

```text
source
access date
finding
applicability
decision / next action
```

## Evidence vs normative knowledge

```text
/docs = what the project currently means / requires / has decided
Code / Test / Runtime / External Source = what the evidence shows
```

Resolve conflicts explicitly.

## Terminology and UI language

Use the project's canonical glossary and ontology. Prefer concise enterprise / office / e-commerce language.

- UI terminology must not expose internal implementation jargon.
- Machine identifiers, enum values and error codes remain stable; human-readable surfaces add Chinese meaning.
- Error messages state: object + action + reason + next step.
- Notifications state: conclusion + key context + next action / entry point.
- Status labels express status, not instructions.
- Avoid decorative AI wording, vague hedging, role-play pleasantries and unnecessary English.

The detailed terminology baseline lives in `docs/terminology-and-ui-language.md`.
