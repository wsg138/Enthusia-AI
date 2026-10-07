# W18 — Historical Ticket Corpus Pipeline

Implementation of TRAINING-AND-EVALUATION-SPEC §4 for support ticket
transcripts. Emits MASTER-SPEC §27-conformant review candidates with
`source_type: "ticket"`. Synthetic fixtures remain the default test input;
governed real-ticket ingestion is available only through the explicit gated
command described below.

## ⚠️ Governance

Owner authorization for the historical-ticket workstream is recorded in
`training/datasets/GOVERNANCE-CHECKPOINT.md` and issue #65. A specific real
content run is still **BLOCKED** until every run-specific §9 sign-off item is
complete.

The real-ingest command additionally refuses to run without
`--ack-governance`, refuses raw/review artifacts inside Git worktrees, writes
to a new restricted output directory, and emits review-only partitions. It
does not admit records to W16 training partitions.

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
    real_ingest.py # gated real-export -> review partitions + manifest
    rewrite_queue.py # positive review candidates -> reference-only rewrite queue
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


## Governed real-ticket ingestion

The first direct-training pass is intentionally restricted to closed
`GENERAL_SUPPORT` and `BUG_REPORT` tickets exported by the Support Bot's
structured exporter. Human-decision ticket types such as appeals and player
reports are not admitted by this first pass.

After the run-specific governance block is signed, run the sanitizer from a
controlled environment with both the raw export and output directory **outside
Git worktrees**:

```bash
python -m enthusia_ticket_corpus.real_ingest \
  --input /secure/tmp/enthusia-ticket-export.jsonl \
  --output-dir /secure/tmp/w18-run-001 \
  --dataset-version ticket-real-v1 \
  --reference-date 2026-10-07T00:00:00Z \
  --run-id w18-real-001 \
  --operator "<authorized operator>" \
  --ack-governance
```

Outputs:

- `positive-review-candidates.jsonl` — `IDEAL`, `GOOD`, and
  `USABLE_WITH_EDIT`; still requires manual/W16 review.
- `negative-eval-candidates.jsonl` — `BAD_RESPONSE`, `OUTDATED`, and
  `INCOMPLETE`; useful for evaluation/adversarial work, not positive SFT.
- `rejected.jsonl` — ticket ID + rejection reason only; no rejected content.
- `manifest.json` — hashes, counts, source period, operator/run provenance,
  dataset version, and the next admission gate.

The raw Support Bot export remains temporary and must follow the governance
retention policy. Only sanitized review artifacts proceed to the next gate.



## Owner-reviewed behavior rubric

Historical rewrites and future synthetic ticket generation must also follow
[OWNER-REVIEW-RUBRIC.md](OWNER-REVIEW-RUBRIC.md). The key owner decision is
that the assistant should investigate bugs/support cases with authoritative
logs, databases, current server state, memory, and player context itself rather
than acting as a passive intake form. Mutable procedures and current truth stay
in tools/memory rather than being baked into model weights.

## Historical staff responses are reference-only

Production dump review showed that even auto-`GOOD` historical tickets can
contain staff shorthand, guesses, one-off actions, stale operational claims,
or answers that only make sense with missing staff-side context. Real tickets
are therefore treated primarily as **source cases**, not automatic imitation
targets.

After W18 produces `positive-review-candidates.jsonl`, build a separate
rewrite queue outside Git:

```bash
python -m enthusia_ticket_corpus.rewrite_queue \
  --input /secure/tmp/w18-run-001/positive-review-candidates.jsonl \
  --output-dir /secure/tmp/w18-rewrite-001
```

The queue preserves the sanitized player context, historical transcript,
evidence/decision metadata, and historical answer as **reference-only**.
Every case is emitted with:

- `target_answer: null`;
- `target_quality: "UNREVIEWED"`;
- `training_eligible: false`;
- rewrite requirements derived from W18 quality reasons.

The historical answer must never be copied directly into W16/W19 merely
because W18 called the conversation `GOOD`. A later grounded rewrite/review
must author a verified target and explicitly relabel the finished candidate
`GOOD` or `IDEAL`. W16 and W19 independently fail closed on every other
quality label.

## Severe-PII exclusion

Before ordinary redaction, W18 drops tickets containing high-confidence
doxxing-grade real-world PII shapes such as Social Security numbers, explicit
home/street addresses, dates of birth, or explicitly labeled full/legal names.
The rejection log stores only the ticket ID and an exclusion reason; the
sensitive value is never copied into a training candidate or rejection log.

This is intentionally narrower than normal PII redaction. Server addresses,
Minecraft coordinates, and Minecraft usernames continue through the ordinary
redaction/quality pipeline rather than being treated as real-world addresses.
