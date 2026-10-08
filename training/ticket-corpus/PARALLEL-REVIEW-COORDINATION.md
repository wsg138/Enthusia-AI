# Parallel ticket review: coordinator intake (HOLD only)

Status: **2026-10-08 all six worker outputs mechanically validated and
private editorial derivative prepared**. This process does not authorize
training, production changes or paid GPU use.

## Frozen input and partition

The authoritative sources on the owner's authorized PC are:
- `SyntheticWorkers/editorial-derivative-v2/`: 668 W16-shaped candidates,
  private source index and all-HOLD W19 admission manifest.
- `SyntheticWorkers/screening-v5/SCREENING-QUEUE.private.jsonl`: the exact
  screening queue containing 71 evidence/safety-risk candidates.
- `SyntheticWorkers/parallel-review-coordinator/assignment-v1/`: newly frozen,
  coordinator-owned, hash-bound slot assignment files. Never put coordinator
  output inside an individual worker's result directory.

Coordinator tool:
`training/ticket-corpus/tools/freeze_parallel_review_assignments.py`.

The assignments are the same rule given to all six workers:

```python
slot = hashlib.sha256(source_candidate_id.encode("utf-8")).digest()[0] % 6 + 1
```

**Do not use Python's randomized `hash()`.** All slices of one source
candidate stay with the same worker.

| Slot | Evidence-risk drafts |
| ---: | ---: |
| 1 | 12 |
| 2 | 9 |
| 3 | 11 |
| 4 | 12 |
| 5 | 15 |
| 6 | 12 |
| **All** | **71** |

The coordinator verifies every staged ID/manifest digest/HOLD state against
the screening queue before assignment. It refuses to overwrite any frozen
release. Private slot files record original full normalized record SHA-256,
answer SHA-256, source candidate ID and incident family. No raw ticket dialogue
or secrets appear in this document or the public tests.

Use a fresh output directory for repeat runs:

```powershell
python training/ticket-corpus/tools/freeze_parallel_review_assignments.py \
  --staged-dir "PRIVATE/SyntheticWorkers/editorial-derivative-v2" \
  --screening-dir "PRIVATE/SyntheticWorkers/screening-v5" \
  --out-dir "PRIVATE/SyntheticWorkers/parallel-review-coordinator/assignment-vNEXT" \
  --slots 6 --expected-risk-count 71
```

## Intake once worker output files are complete

`training/ticket-corpus/tools/audit_parallel_review_intake.py` consumes
**explicit review output paths**, not entire directories. Never guess that a
work-in-progress file represents a completed worker. Do not run mutating
commands against any worker directory.

For a record to validate, the worker must provide:
- `draft_id` and `source_candidate_id`;
- `original_target_hash` matching the **frozen answer SHA-256** or
  **frozen full reviewed-target SHA-256**;
- `recommendation`: only `KEEP_PENDING`, `PROPOSE_REWRITE`, or `REJECT`;
- `review_status` either omitted or HOLD/PENDING_INDEPENDENT;
- no self-asserted `training_eligible`, rights/privacy clearance, or other
  approval flag.

Example after all six report files have been identified:

```powershell
python training/ticket-corpus/tools/audit_parallel_review_intake.py \
  --assignment-dir "PRIVATE/SyntheticWorkers/parallel-review-coordinator/assignment-v1" \
  --review "1=PRIVATE/SyntheticWorkers/parallel-review/slot-1/REVIEW-RESULTS.private.jsonl" \
  --review "2=PRIVATE/SyntheticWorkers/parallel-review/slot-2/REVIEW-RESULTS.private.jsonl" \
  --review "3=PRIVATE/SyntheticWorkers/parallel-review/slot-3/REVIEW-RESULTS.private.jsonl" \
  --review "4=PRIVATE/SyntheticWorkers/parallel-review/slot-4/REVIEW-RESULTS.private.jsonl" \
  --review "5=PRIVATE/SyntheticWorkers/parallel-review/slot-5/REVIEW-RESULTS.private.jsonl" \
  --review "6=PRIVATE/SyntheticWorkers/parallel-review/slot-6/REVIEW-RESULTS.private.jsonl" \
  --out-dir "PRIVATE/SyntheticWorkers/parallel-review-coordinator/intake-v1"
```

**These paths are illustrative**; inspect each worker's actual filename first.
Where workers used different field names, explicitly reconcile the private
schema instead of inventing missing fields or treating unrecognized evidence
as approval.

The intake check refuses assignments changed since freezing, wrong-slot
cases, duplicated/missing cases, bad original hashes, non-provisional
recommendations, and training/clearance status promotions. It emits an
aggregate review-status summary and private issue report **without copying
worker dialogue into GitHub**. A complete report means only that **the
expected worker records are present and mechanically consistent**.

## Gates after intake

Before any approved training release:
1. Independently inspect each proposed replacement and *preceding as-of-turn
   context*, not just the current answer, against authorized source evidence.
2. Confirm source credibility, rights/privacy handling, staff policy,
   incident-family leakage prevention, and actual tool-result provenance.
3. Quarantine disputed/unsupported cases without forcing approval.
4. Create a **new immutable derivative** and independent W19 approval manifest
   only after explicit adjudication; run CPU-only W16/W19 checks.
5. Never consume W20 frozen evaluation data as training data; require owner
   approval before any paid GPU run or production change.

## Verification

The coordinator assignment was executed on the owner's Windows PC and
assigned all 71 evidence-risk cases exactly once across six slots.

**30 synthetic-only coordinator tests passed**: assignment freezing, worker
intake validation, approval refusal, review-proposal normalization, and
rejection quarantine. These tests do not validate the workers' substantive
review findings.

**No user action needed for the coordinator stage.** Worker results can be
checked when submitted; six parallel worker chats are not themselves
six independently approved reviewers.

## Executed worker intake and editorial derivative (2026-10-08)

All six private review-result files were present and validated against the
frozen 71-case assignment ledger:

- **71/71** source IDs, draft IDs and original-target hashes matched.
- **0** missing, duplicate, wrong-worker or stale results.
- **65** `PROPOSE_REWRITE` recommendations; **6** `REJECT` recommendations.
- **0** worker-provided training approvals admitted. W19 remains HOLD.

The newest coordinator-owned private artifacts:

- `SyntheticWorkers/parallel-review-coordinator/intake-v2/` — verified
  six-worker mechanical intake and counts.
- `SyntheticWorkers/parallel-review-coordinator/normalized-worker-review-v1/`
  — **65** private HOLD-only editorial proposals and a separate **6-case**
  rejection/quarantine list.
- `SyntheticWorkers/editorial-derivative-v3/` — new immutable private
  derivative with those 65 proposed answers applied. Original worker
  files, staged review and prior derivatives remain unchanged.
- `SyntheticWorkers/screening-v6/` — independent risk *screening*, not
  an independent correctness/admission decision.

`prepare_parallel_review_proposals.py` refuses incomplete or stale six-slot
intake, empty/unchanged proposed rewrites and worker training-approval claims.
It does not apply rejected cases as rewrites. Maintain the private quarantine
list in any later independent approval/admission process: the original rejected
record remains in the all-HOLD draft corpus but **must not** become trainable.

After review proposal application:

| Screening category | Before (v5) | After (v6) |
| --- | ---: | ---: |
| Evidence/safety review | 71 | 6 |
| Style/provenance review | 214 | 258 |
| Standard independent review | 383 | 404 |

The remaining six flagged completions correspond to the six rejection
recommendations. The *screening heuristic* finding no warning is **not**
independent factual quality approval.

Fresh CPU-only W16/W19 check on derivative-v3:
- **668/668** records and HOLD manifest record hashes validated;
- **668/668** refused admission for `not independently approved`;
- **0** schema/digest/staff-handoff errors;
- **0** credential-pattern matches (not full privacy clearance).

Next: independently adjudicate the 65 revised answers and six rejected cases
against as-of-turn evidence and current policy; enforce quarantine in any
future admissions; address remaining quality/repetition/source warnings
across the other drafts; freeze leakage-safe connected families; only then
consider an explicitly approved release and paid training.
