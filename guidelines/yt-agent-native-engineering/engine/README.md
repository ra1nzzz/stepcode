# YT-ANSE Review Engine

The engine is the deterministic execution layer beneath `yt-anse-review`.

## Responsibility

Use code for work that has a deterministic answer:

```text
scope
file states
rule/lens resolution
budget checks
anchors
schema validation
session persistence
metrics
```

Use Agents for semantic reasoning, architecture, business logic and risk judgment.

## Contract

An engine step should be:

- deterministic for the same inputs;
- inspectable;
- testable without an LLM when possible;
- explicit about skipped/failed work;
- safe to compose into long-running review sessions.
