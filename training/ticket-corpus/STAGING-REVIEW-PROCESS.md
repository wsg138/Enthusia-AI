# Synthetic ticket review staging: HOLD-first conversion

**Status: implemented and tested. Not a training-release approval.**

This tool converts selected, existing private ticket-worker candidates into reviewable W16-shaped *assistant completion drafts*. It does not label a draft GOOD/IDEAL or claim that a synthetic investigation actually took place.

## What to run

Use `training/ticket-corpus/tools/stage_ticket_review_targets.py` with four explicit arguments:

```powershell
python training/ticket-corpus/tools/stage_ticket_review_targets.py \
  --source-dir "PRIVATE/SyntheticWorkers/outputs" \
  --audit-dir "PRIVATE/SyntheticWorkers/audit" \
  --out-dir "PRIVATE/SyntheticWorkers/staged-review-vNEXT" \
  --w16-root "CHECKOUT/training/datasets"
```

Use a **new output folder on every release**. Existing destinations are refused; the original candidate files are never edited. Do not commit the private output folder to GitHub.

The converter ingests only canonical W01–W15 lane JSONL, excluding worker batch fragments. Its selection requires both:
- Prior independent structural triage to the multi-turn review queue.
- No earlier lexical review warning.

It constructs one prompt-completion draft for each assistant turn immediately following a player turn, using only previously visible messages as prompt context. Later player messages do not enter earlier prompts; no invented tool output is synthesized. No staff-only handoff or internal investigation is included in the W16 draft.

**Every draft** is `quality=USABLE_WITH_EDIT`, with `tool_trace_status=reference_only`. Every manifest entry is `HOLD`, `split=none`, with zero approved uses and uncleared rights, privacy, staff visibility. These cannot enter ordinary W19 train/validation without independent review and a replacement approved manifest, and cannot train directly through the GPU runner.

## Private output files

- `DRAFT-W16-NOT-TRAINABLE.private.jsonl` — player-facing as-of-turn prompt/completion candidates only.
- `REVIEW-MANIFEST-ALL-HOLD.private.json` — exact reviewed-target hash placeholders and source provenance, with **all 668 HOLD**. Not an approval file.
- `REVIEW-SOURCE-INDEX.private.jsonl` — per-target original file and line number, cited source refs, flags, and staff-handoff existence. This is deliberately **separate** from the W16 draft and remains private.
- `STAGING-REPORT.json` — aggregate counts, source-file SHA-256 digests, skipped reasons and artifact hashes.

Source digest is computed from the source JSONL line, and source-file digest from the entire original file. The line and candidate IDs are maintained in the private review index. A pinned GitHub code path existing does not certify any generated fictional production-state result.

## Initial private pass

Owner PC path: `C:\Users\racec\Blackboard\Enthusia-AI-Training\SyntheticWorkers\staged-review-v2`

- Original worker candidates scanned: **1,301**
- Multiturn candidates without initial lexical warnings: **334**
- W16-shaped assistant completion drafts produced: **668**
- Tool-result claims lacking verified as-of-turn evidence: **73** flagged
- Excluded from this conversion: 206 lexically warned multi-turn tickets + 761 other/secondary candidates
- W16 credential-pattern matches across the initial 668 drafts: **0** (this is NOT a complete privacy audit)
- Manifest entries: **668/668 HOLD**, approved training records: **0**
- Independently checked pinned source *path existence*: **7**, not player incident truth
- Generated a private index with **668** source locators.

Synthetic-only unit tests: `python -m unittest discover -s training/ticket-corpus/tests -p test_stage_ticket_review_targets.py -v`. Six tests passed on the Windows owner PC, including non-overwrite, as-of-turn context, omission of staff material, and HOLD-only manifest creation. Separate CPU validation re-read all 668 drafts, recomputed W16-normalized target hashes, and confirmed W19 admission returned `not independently approved` for every draft.

## Next review steps

1. Use `REVIEW-SOURCE-INDEX.private.jsonl` to independently verify specific code/config/source revisions and the corresponding original private candidate evidence.
2. Reject or correct artificial language, unsupported claims of log/DB checks, wrong tool sequencing, unsafe escalation and private-staff leakage. The 73 flagged source-check claims deserve special attention; even unflagged drafts require semantic review.
3. Verify provenance, privacy, deletion and authorized rights independently. Preserve immutable correction deltas and reviewer identity.
4. Assign train/validation/holdout at the **connected source family** level, not at record or assistant-slice level.
5. Produce a *new* review manifest with only truly approved uses and exact hashes of the final edited W16 targets. Never flip the HOLD placeholders into APPROVED automatically.
6. Run W16/W19 CPU validation, source deletion propagation and leakage checks before model training. Preserve the frozen W20 holdout.
7. Paid GPU work requires separate owner approval; none was used in this conversion.

## Limitations

The converter cannot independently know whether a support reply is factually correct, whether a source was deployed, whether a player really lost an item, or whether an as-of-turn tool check happened. It intentionally produces **unapproved candidates only**.

This workflow is adapted from the separate AI-Moderation-API technical methods review. Moderation-classifier 120-second target windows do not apply to multi-day support tickets.
