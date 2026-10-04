# tests/regression

Regression tests, including the mandatory stale-source test from the
worker execution plan: an A -> B source update must result in current answer
B, history A, and no normal retrieval of A as current.

SKELETON (W01). Populated by W07 (memory) and W20 (evaluation).

Populated by W20: see stale-source.test.ts (mandatory A -> B stale-source regression via the evaluation scenario template).
