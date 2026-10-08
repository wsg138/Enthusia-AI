# Ticket worker admission contract (W19)

**Status:** engineering safeguard, not an authorization to train. No historical or synthetic worker candidate is approved merely by passing these tests.

## The rule

An independently reviewed manifest, stored PRIVATELY, is required for normalized ticket-worker training records. A worker's self-review PASS or a copied GOOD/IDEAL label never constitutes approval.

Preserve these metadata fields when converting private worker JSONL to canonical W16 format: candidate_id, worker_origin (ticket_worker_v1), source_candidate_sha256, source_file_sha256, source_revision, family_group, seed_refs, tool_trace_status.

An authorized curator must independently verify each source and its actual hash, fix the player-visible target, remove staff-only material, check privacy and rights, and assign a family-level split. The exact normalized W16 target is hashed with record_digest() AFTER validate_record() adds defaults.

W19 checks manifest membership, source hashes/revision, normalized target hash, privacy/rights review, reviewer identity, family lineage, and approved use. It does not automatically prove that a claimed reviewer exists or that a source file hash really matches the original private source: those are independent curation responsibilities. Any change to reviewed content invalidates the approval digest.

## Manifest schema (private, fictional placeholders)

- schema: enthusia-ticket-review-admission/v1
- manifest_id: unique private release id
- review_protocol_revision: immutable rubric version
- entries: array of per-candidate review records
- Each entry requires: candidate_id; record_sha256; source_candidate_sha256; source_file_sha256; source_revision; family_group; seed_refs; independent_reviewer_id; generator_id; review_status (APPROVED/HOLD/REJECTED); approved_uses; split (train/validation/holdout/none); rights_cleared; privacy_cleared; staff_visibility_reviewed; source_withdrawn; tool_trace_status (reference_only/as_of_verified).
- Optional lineage: parent_ids, session_group, source_ticket_ids, source_message_ids, incident_id, canonical_event_id.

**Default every newly entered record to HOLD, no approved uses, and uncleared rights/privacy until independent review confirms otherwise. Never auto-generate APPROVED entries from worker quality flags.**

An approval becomes train-eligible ONLY if:
1. Record and provenance hashes/revisions match exactly.
2. Independent reviewer is present and differs from generator.
3. Approval is active, training is an allowed use, and rights/privacy/staff visibility are cleared.
4. Source is not withdrawn; split is explicitly train or validation.
5. Connected source-ticket, seed, incident, family and parent lineage never crosses train/validation/holdout.
6. Staff-only handoff text is excluded; unanchored, reference-only tool traces are not training targets.
7. Existing W16 validation, secret scan, W19 quality/visibility restrictions, dedupe, and special evaluation partitions still apply.

Manifest digest and protocol revision are recorded in W19's output manifest.

## CPU-only invocation

The W19 assembly CLI accepts --ticket-review-manifest /private/approved.json along with --corpora, --out-dir and --dataset-version.

The W19 prepare CLI also accepts --ticket-review-manifest /private/approved.json.

Without a matching review manifest, worker-derived records are excluded regardless of their GOOD/IDEAL label. With a manifest present, only matches are admitted; contradictory lineage split assignments fail the whole build.

Existing non-worker historical and repository test fixtures preserve their existing behavior. A worker-to-W16 converter **must never strip worker_origin or candidate_id**. Deliberate provenance falsification is outside the cryptographic protection of this code and requires process access controls.

## Current audit state

Private source: C:\Users\racec\Blackboard\Enthusia-AI-Training\SyntheticWorkers\outputs

Private QA sample: C:\Users\racec\Blackboard\Enthusia-AI-Training\SyntheticWorkers\audit\INDEPENDENT-REVIEW-SAMPLE.private.jsonl

1,301 candidates, 540 multi-turn-shaped, 334 multi-turn with no initial lexical warnings, 2,632 unanchored investigation steps, 30 connected source families. **Zero independently approved for training.**

Next: independent curation and source verification, then a $0 CPU-only preflight. No GPU, model download, production deployment or new historical extraction is authorized by this document.

## Synthetic regression tests

training/finetune/tests/test_review_admission.py uses invented data only. It tests missing approval, changed text, source provenance, withdrawn sources, reviewer identity, staff-only leakage, unverified tool traces, held-out family leakage, and explicit approved split assignment.


## Mandatory source-quarantine gate for assistant-slice releases

For stage-style worker `candidate_id` values such as
`W01-0123-a01`, an APPROVED W19 review record also requires an
**immutable, private source-quarantine ledger**. The loader finds it from
`quarantine_ledger_file` in the private independent review manifest (relative
to that manifest's directory, or absolute on the authorized machine).

That manifest must additionally pin:

- `quarantine_ledger_sha256`: the exact SHA-256 of the ledger file;
- `source_hold_manifest_sha256`: the original immutable all-HOLD cohort
  manifest SHA-256 recorded inside the quarantine ledger.

A missing or altered ledger, wrong release, malformed/duplicate rejected-source
entries, missing sibling slice, inconsistent source lineage, or candidate from
a rejected source **blocks W19 admission** even when an individual candidate
is marked APPROVED. The source-level refusal covers both listed slices and
any later slice retaining the same source ID. Do not mutate the original
rejection ledger to "fix" a reviewed target. A future independent adjudication
must create a new, auditable decision/release; staff may not silently convert
a previous REJECT into approval.

Build the PRIVATE ledger from the frozen `editorial-derivative-v3` and
`normalized-worker-review-v1` outputs, with no training operation:

```powershell
python training/ticket-corpus/tools/build_rejected_source_quarantine.py \
  --staging-dir "PRIVATE/SyntheticWorkers/editorial-derivative-v3" \
  --rejections "PRIVATE/SyntheticWorkers/parallel-review-coordinator/normalized-worker-review-v1/QUARANTINED-REJECTION-RECOMMENDATIONS.private.jsonl" \
  --out-file "PRIVATE/SyntheticWorkers/parallel-review-coordinator/quarantine-v1/SOURCE-QUARANTINE.private.json"
```

This private ledger is not the W19 approval manifest, must never be published,
and never grants rights/privacy, quality admission or training permission.
The direct GPU input validator uses the same W19 admission check.
