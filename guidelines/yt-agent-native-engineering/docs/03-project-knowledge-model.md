# Project Knowledge Model v0.1

Recommended `/docs` structure:

```text
/docs
├── ontology/
├── glossary/
├── product/
├── architecture/
├── specs/
├── adr/
├── decisions/
├── research/
├── references/
├── assets/
├── checkpoints/
├── reviews/
└── state/
```

## Knowledge classes

| Class | Question answered |
|---|---|
| Ontology | What concepts exist and how do they relate? |
| Glossary | What is the canonical term and definition? |
| Product | Why does the system exist? |
| Architecture | How is it structurally organized? |
| SPEC | What behavior is required? |
| ADR | Why was a durable decision made? |
| Research | What external evidence was found? |
| Reference | What source supports a claim? |
| Asset | What non-code artifacts exist and why? |
| Checkpoint | What is the current recoverable state? |
| Review | What was challenged, proved and accepted? |
| State | What is current, best and unresolved? |

## Knowledge lifecycle

```text
Discover → Validate → Canonicalize → Record → Use → Verify → Update
```
