# W18 — Historical Ticket Corpus Pipeline

Fixture-driven implementation of TRAINING-AND-EVALUATION-SPEC §4 for support
ticket transcripts. Emits MASTER-SPEC §27-conformant training candidates with
`source_type: "ticket"`.

## ⚠️ Governance

**Real ticket extraction is BLOCKED** until
`training/datasets/GOVERNANCE-CHECKPOINT.md` is fully signed off (§9).
This package only ever processes **synthetic fixture data**
(`fixtures/tickets.jsonl`). Absolutely no real ticket data extraction.

## Layout

```
training/ticket-corpus/
  redaction.yml                  # redaction configuration
  pyproject.toml
  enthusiasm_ticket_corpus/  (package `enthusia_ticket_corpus`)
    extract.py    # transcript parsing, speaker roles, problem classification
    redact.py     # PII redaction + pseudonymization (config-driven)
    privacy.py    # pre-redaction severe-PII / doxxing-grade exclusion
    secrets.py    # credential-shape detection, removal, reject-on-residual
    outdated.py   # markOutdated(): stale-fact flagging (critical rule)
    quality.py    # IDEAL/GOOD/USABLE_WITH_EDIT/BAD_RESPONSE/OUTDATED/INCOMPLETE/PRIVATE_EXCLUDE
    patterns.py   # evidence-request + staff-decision pattern extraction
    pipeline.py   # 12-stage orchestration -> section-27 candidates
    schema.py     # local section-27 contract validator
  fixtures/tickets.jsonl         # SYNTHETIC fixture tickets (not real data)
  tests/                         # pytest suite
```

## Pipeline stages (spec §4)

1. extract → 2. normalize/source privacy exclusion → 3. remove secrets → 4. mark speaker roles →
5. identify problem → 6. identify evidence → 7. identify staff actions →
8. identify outcome → 9. label quality → 10. mark stale facts →
11. build candidates → 12. review/filter

## Critical rule

Historical ticket facts do **not** outrank current live facts
(WORKER-EXECUTION-PLAN §21). `markOutdated()` flags volatile claims
(IPs, prices, permission nodes, plugin versions, temporal claims) and any
claim contradicting caller-supplied live facts → candidate labeled `OUTDATED`.

## W16 relationship

W16's dataset pipeline (`enthusia_datasets`, PR #3) owns the canonical record
schema and downstream stages (secret scan, dedupe, splits, versioning). This
workstream:

- emits candidates conforming to the §27 contract W16 validates;
- reuses W16's secret-pattern contract and reject-on-residual policy;
- does **not** modify W16's code and does not duplicate it into this PR.

Run tests: `python3 -m pytest training/ticket-corpus/tests/`
Cross-check against W16's validator when available:
`W16_PACKAGE_DIR=~/workspace/enthusia-ai/w16-work/training/datasets python3 -m pytest`


## Severe-PII exclusion

Before ordinary redaction, W18 drops tickets containing high-confidence
doxxing-grade real-world PII shapes such as Social Security numbers, explicit
home/street addresses, dates of birth, or explicitly labeled full/legal names.
The rejection log stores only the ticket ID and an exclusion reason; the
sensitive value is never copied into a training candidate or rejection log.

This is intentionally narrower than normal PII redaction. Server addresses,
Minecraft coordinates, and Minecraft usernames continue through the ordinary
redaction/quality pipeline rather than being treated as real-world addresses.
