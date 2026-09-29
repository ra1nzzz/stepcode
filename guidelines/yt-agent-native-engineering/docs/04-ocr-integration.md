# OpenCodeReview Integration Notes

Alibaba OpenCodeReview is treated as a reference implementation for deterministic review execution, not as the governing methodology of YT-ANSE.

## Capabilities adopted conceptually

1. Deterministic file selection and explicit exclusion reasons.
2. Semantic grouping with file-count and token guardrails.
3. Rule resolution by file/path.
4. Separate planning and main review loops when complexity warrants it.
5. Memory compression for long tool-use sessions.
6. Deterministic line resolution plus optional model-assisted relocation.
7. Independent post-review fact filtering.
8. Persisted review sessions.
9. Telemetry and benchmark measurement.

## What remains YT-ANSE-specific

- Project knowledge governance.
- Ontology and terminology control.
- Progressive specification across development work, not only PR review.
- Applicability and required-now decisions.
- P0/P1/P2 governance.
- Historical best state and rollback.
- Marginal-gain convergence.
- System-level integration acceptance.

## Reference

https://github.com/alibaba/open-code-review
