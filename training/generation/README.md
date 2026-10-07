# Synthetic corpus generation (W17)

Deterministic synthetic training-corpus generation for Enthusia AI.
Implements [TRAINING-AND-EVALUATION-SPEC](../../specs/TRAINING-AND-EVALUATION-SPEC.md)
sections 5–6 and [MASTER-SPECIFICATION](../../specs/MASTER-SPECIFICATION.md)
section 42, on top of W16's dataset pipeline (`training/datasets`, PR #3).

Training stack is Python (spec §9.3). The sibling `package.json` keeps the
npm workspace slot; the real implementation is the `enthusia_generation`
package below. W16's code is used, never modified.

## Layout

```
training/generation/
├── enthusia_generation/      # the generator package
│   ├── fixtures.py           # fixture source registry (traceable sources)
│   ├── scenarios.py          # scenario template library (14 categories)
│   ├── variations.py         # linguistic variation forms (spec section 5)
│   ├── records.py            # (scenario, form) -> W16 record rendering
│   ├── qa.py                 # source-grounded Q&A generation
│   ├── traces.py             # tool-use trace generation (spec section 6)
│   ├── adversarial.py        # adversarial generation (spec section 42.2)
│   ├── validate.py           # quality validation (W16 schema + traceability)
│   └── corpus.py             # deterministic corpus builder + manifest (CLI)
├── fixtures/
│   └── sources.json          # fixture knowledge base (NO real Enthusia data)
├── corpus/
│   ├── w17-sample-corpus.jsonl  # generated sample corpus (109 records)
│   └── corpus-manifest.json     # provenance manifest
├── tests/                    # pytest suite (35 tests)
└── pyproject.toml
```

## Production-training boundary

The checked-in `corpus/w17-sample-corpus.jsonl` is a **sample/fixture
artifact**, not an approved production tuning corpus. Its facts are purposely
plausible fixture data so the generation and evaluation machinery can be
tested deterministically without depending on live server state.

Do not relabel or feed this sample directly into a production fine-tune.
Production synthetic examples must be regenerated from current authoritative
Enthusia sources and pass the normal review/admission gates. W19 independently
blocks this fixture generator from production train/validation.

## Key rules

- **No real Enthusia data.** All facts come from `fixtures/sources.json`,
  plausible fixtures versioned like `2026.10`. A superseded archive source
  (`docs:archive/ranks-2026-09.md`, version `2026.09`) exists for stale-data
  scenarios.
- **Every factual example has traceable sources.** Each record's `facts`
  entries are `{claim, source, source_version}` resolved from the registry;
  `validate.py` rejects any fact whose exact claim text is not in the named
  fixture source at the recorded version, and rejects factual records with
  no facts (except curated `BAD_RESPONSE` negatives and `tool-failure`
  fallbacks, which make no factual claims).
- **Deterministic.** Fixed seed (`17017`) and fixed `created_at`; same inputs
  → byte-identical corpus. Record ids are `w17-0001…`.

## Categories (spec §42 / WORKER-EXECUTION-PLAN §20)

onboarding, commands, permissions, rank, economy, tickets, rules, bugs,
account linking, ambiguity, escalation, stale data, conflicting evidence,
privacy.

## Variation forms (spec section 5)

faq, typo (typo-heavy), new_player, advanced, wrong_assumption,
missing_evidence, conflicting_evidence, troubleshooting, historical,
staff_only, escalation. `faq`/`typo`/`new_player` render algorithmically
from a scenario's base Q&A; the rest are explicit per-scenario variants.

## Tool-use traces (spec section 6)

`user → assistant (ack) → tool result(s) → assistant (final)` following the
spec skeleton (resolve identity → read live state → compare → answer or
escalate). `expected_actions` carries ordered `tool:<name>` entries; one
trace exercises the tool-failure fallback (tag `tool-failure`).

## Adversarial examples (spec section 42.2)

All seven types, each with ≥2 examples, tagged `adversarial` so W16's
pipeline routes them to the adversarial evaluation partition:

stale_data, ambiguous_ranks, conflicting_configs, undeployed_git,
hallucinated_commands, unauthorized_info (tag `privacy`), prompt_injection.

## Validation (spec section 42.3)

`validate.validate_corpus` runs: W16 `validate_record`, W16 secret scan
(hard fail), W16 quality assessment, fact traceability, factual
completeness, and coverage (14 categories, 7 adversarial types, 11 forms,
≥100 records).

## Generate the corpus

```bash
cd training/generation
PYTHONPATH=../datasets:. python3 -m enthusia_generation.corpus --out corpus
```

## Run the tests

```bash
cd training/generation
python3 -m pytest tests/ -q
```

Tests that need W16's `enthusia_datasets` skip cleanly when it is absent
(stacked PRs); with W16 present the suite includes full W16-pipeline
acceptance: zero rejections, linguistic variants dedupe to one canonical
record per template at the default threshold, and the full 109-record
corpus is kept at exact-text threshold.

## W16 pipeline notes

Records share `template_id` per scenario so W16's leak-grouping keeps
linguistic variants in the same split (spec section 8). At the default
0.85 similarity threshold the pipeline collapses high-similarity variants
to one record per template — W16's specified behavior, and
`similarity_threshold` is a pipeline parameter W19 can raise to keep every
variant. `PRIVATE_EXCLUDE` / `BAD_RESPONSE` records never enter
train/validation by W16 design.
