# Ticket review editorial derivatives (HOLD-only)

**Status:** CPU-only private review aid. Not independent approval, not a
trainable release and not permission for a paid GPU run.

This follows PR #95 (fail-closed independent training admission), PR #96
(private ticket draft staging) and PR #97 (quality-risk screening).

## Why a separate derivative?

Some worker-generated support replies state that a database, proxy log,
inventory snapshot or player record has already been checked, even though the
candidate's investigation is a synthetic fixture without a verified
as-of-turn tool trace. Such conclusions cannot be presented as fact in the
model's player-facing completion.

An editorial suggestion can instead ask for the needed context, describe the
next authorized check, or keep the finding explicitly inconclusive. A
suggestion is **not** certified correct until independently verified.

Also, modifying an earlier assistant reply requires propagating the change
into later training prompts from the same source ticket; otherwise the next
example trains on a stale/contradictory prior assistant message.

## Tool

`training/ticket-corpus/tools/apply_review_proposals.py` requires all inputs
in the authorized private workspace:

- Original staged W16-shaped draft dataset plus per-record source index
  and HOLD-only manifest;
- Private independently curated/editorial correction notes with proposal
  metadata (these may contain player-facing draft dialogue);
- Private source path-revision resolutions verified against exact GitHub
  commits and file blob hashes;
- Canonical W16 dataset validator path; and
- A **new, nonexistent** private output directory.

Example invocation:

```powershell
python training/ticket-corpus/tools/apply_review_proposals.py \
  --staged-dir "PRIVATE/SyntheticWorkers/staged-review-v2" \
  --editorial-notes "PRIVATE/SyntheticWorkers/screening-v2/EDITORIAL-REVIEW-NOTES.private.jsonl" \
  --source-resolutions "PRIVATE/SyntheticWorkers/screening-v2/SOURCE-REVISION-RESOLUTIONS.private.json" "PRIVATE/SyntheticWorkers/screening-v2/BLOB-REVISION-RESOLUTIONS.private.json" \
  --w16-root "CHECKOUT/training/datasets" \
  --out-dir "PRIVATE/SyntheticWorkers/editorial-derivative-vNEXT"
```

The script refuses stale/mismatched hashes, unknown/duplicate correction IDs,
any proposal falsely asserting training approval, unverified revision-map
entries, source-path-changing resolution maps, and overwriting existing
releases. It verifies the full derivative against the original HOLD-only
contract and recomputes the reviewed-target SHA-256 after each authorized
edit.

Source citations are in the private review index, **never inserted into
player-visible training text**. Source path existence does not certify any
live incident or actual observed database/log response.

## Executed private pass — 2026-10-07

Source input: 668 HOLD-only drafts from 334 higher-priority synthetic
multi-turn tickets.

Stored privately on the owner's PC:

`C:\Users\racec\Blackboard\Enthusia-AI-Training\SyntheticWorkers\editorial-derivative-v1`

Measured outcome:

| Measure | Count |
| --- | ---: |
| Player-answer editorial proposals applied | 13 |
| Affected later prompt contexts replayed | 3 |
| Source-reference occurrences repinned in private index | 156 |
| Distinct source-resolution entries used | 12 |
| Final W16-shaped drafts | 668 |
| Independently approved targets | **0** |

Of the 156 reference occurrences, 152 were previously mutable `@main`
paths and four occurrences were two incorrect file-blob-as-commit pins
repeated across two assistant slices from one source ticket. Both issues
were resolved to verified full Git commits, but the underlying synthetic
incident claims are still not verified.

The new derivative retained all rights/privacy/source review fields as
uncleared and every manifest entry remained `HOLD`.

Separate CPU-only W16/W19 preflight:
- All **668** normalized target hashes matched corresponding private
  HOLD-manifest entries, with no schema/digest or private staff-handoff
  embedding errors.
- W19 rejected **all 668/668** with `not independently approved`.
- Existing W16 credential-pattern scanner found **0** matches. This is
  **not** sufficient for full privacy or authorized-data clearance.

New screening pass (`SyntheticWorkers/screening-v4`) found:

| Queue | Before edits | After edits |
| --- | ---: | ---: |
| Evidence/safety review | 107 | 91 |
| Style/source review | 184 | 195 |
| No current screening warning | 377 | 382 |

The explicit detected unsupported-verified-result *target* claim count
dropped **104 → 91**. Source-index mutable-reference warnings dropped
to zero. There remain **68** nonversioned/nonrepo citation warning
occurrences and repeated reply templates. Old `review_flags` are retained
conservatively as provenance from the original generation pass, even where
their target text is now proposed for correction.

The review sampler now reserves coverage of all **19 connected incident
families** before adding further high-risk examples; its 60-case private
manual review sample spans 19 families. It never treats the 382
unflagged examples as automatically correct.

## Tests and next actions

- **25 synthetic-only staging/screening/derivative tests passed** on the
  owner's Windows computer.
- Original worker sources and previous staging/screening releases remain
  unchanged. Nothing in private review folders was committed to GitHub.
- No owner approval required at this stage, no GPU/RunPod spending, no
  model training, no live server access, and no W20 holdout changes.

Next: independently compare the corrected answer **and its entire prior
assistant context** against authorized source material, check rights/privacy,
and record a reviewer disposition. Additional 91 evidence-risk completions
still need investigation, controlled edits or rejection. Only a *separate*
explicit APPROVED manifest after successful independent review can make an
edited target W19 training-eligible. Do not change HOLD flags automatically.
