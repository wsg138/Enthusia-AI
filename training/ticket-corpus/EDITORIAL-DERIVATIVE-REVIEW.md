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


## Private v8 editorial proposals and quarantined-source gate

Following merged PR #100, a fresh 28-case risk queue from private
`screening-v7` exposed 22 source tickets requiring provisional copy edits.
The remaining six source tickets are **REJECT recommendations**; do not rewrite
either sibling slice to make those sources appear trainable.

The owner-private coordinator packet contains **37 proposed answer edits
across 22 non-rejected source tickets**: 22 second-turn target edits and 15
earlier assistant-turn edits. Each proposed edit is pinned to the exact
original W16 reviewed-target digest and source-candidate digest from the
immutable `editorial-derivative-v3` manifest. Editing an earlier assistant
turn requires deterministic replay into its sibling follow-up prompt.

Private input only:
`SyntheticWorkers/parallel-review-coordinator/EDITORIAL-PROPOSALS-V8.private.jsonl`.

For the next *new* immutable review derivative, pass:
`--source-quarantine-ledger PRIVATE/SyntheticWorkers/parallel-review-coordinator/quarantine-v1/SOURCE-QUARANTINE.private.json`
to `tools/apply_review_proposals.py`, with
`--staged-dir PRIVATE/SyntheticWorkers/editorial-derivative-v3`,
the pinned editorial notes path, trusted pre-existing source resolution
files, and a fresh `--out-dir`.

When this ledger is supplied, the tool:
- verifies the private ledger matches the exact immutable input HOLD-manifest
  bytes and contains both sibling slices for every rejected source;
- fails if any submitted proposal edits a rejected source ticket;
- requires each proposed edit to pin and match its original W16 target digest,
  exact source digest and source-ticket ID;
- retains all other HOLD-only W16/W19 constraints and as-of-turn replay.

A validated proposal is **not** an approved target. All outputs remain
`HOLD`, `split=none`, zero approved uses, rights/privacy uncleared.
Re-run private W16/W19 preflight and HOLD-only screening on any generated
derivative, to a *new* versioned directory, before substantive human review.
Do not leak private transcript, source-index or editorial content into GitHub.

**Execution status:** 37 private proposals have been constructed and read-only
checked against the original 668-entry HOLD manifest and six-source rejection
ledger with no conflicts. The authorized PC refused local script updates and
derivative generation under tool safety checks, so the new v4 derivative,
its W16/W19 checks and re-screening have **not** been executed. The existing
v3 all-HOLD release remains authoritative; do not claim v4 exists.


## Mandatory private quarantine ledger on each future editorial run

The editorial derivative CLI now requires
`--source-quarantine-ledger PRIVATE/.../SOURCE-QUARANTINE.private.json`
instead of leaving this lineage guard optional. Its Python `run(...)`
entrypoint also fails before reading or writing any dataset files when
`quarantine_ledger` is absent. This ensures the six source-level REJECT
recommendations (both assistant slices per source) are not accidentally
omitted during subsequent proposal application. Per-proposal source and
original reviewed-target hashes remain mandatory when the ledger is supplied.

**Historical status before the PC connection recovered:** v3 was the
current release and the 37 v8 proposals were unapplied. The old PC execution
block and lack of v4 validation described that earlier stage only. See the
executed v4/v5 status below for the current state.

Passing synthetic code tests cannot establish actual source verification,
privacy/rights, historical incident facts, or authorized staff tool actions.


## Executed immutable HOLD-only derivatives v4 and v5 — 2026-10-08

This update supersedes the earlier pending/blocked status. The authorized
Blackboard PC connection recovered. The coordinator mirrored the exact
merged PR #103 editorial and screening tools into the owner's **private**
`TicketStageTest/tools` directory, then executed the guarded CPU-only
workflow there. Private inputs, conversation text, and outputs were never
committed to GitHub.

**v4** was derived from v3 using the v3-release-bound private six-source
quarantine ledger and `EDITORIAL-PROPOSALS-V8.private.jsonl`. The tool
reported **668 drafts, 37 rewritten target answers, 15 earlier-assistant
context replays, zero source-ref changes and zero approvals**. An independent
read-only before/after structural comparison confirmed exactly those
37+15 edits; no other target fields or source-index fields changed and
all 12 slices from the six rejected source tickets were byte-for-byte
unchanged.

**v5** was derived from v4 using 44 case-specific private HOLD-only
`EDITORIAL-PROPOSALS-V9.private.jsonl` corrections for the 44
non-quarantined high-priority replies in `screening-v8`. Before that run,
the original six REJECT recommendations were re-frozen through the existing
ledger builder against v4's exact all-HOLD manifest into an immutable
`parallel-review-coordinator/quarantine-v2/SOURCE-QUARANTINE.private.json`
(SHA-256
`0e8f54b06bbb6d2c3dc7c21187c3fe7026fecb1d726a0e22a68581af32cb9b9f`).
The v4-to-v5 derivative reported **668 drafts, 44 rewritten target answers,
zero prior-context replays, zero source-ref changes and zero approvals**.
A separate structural comparison confirmed 44 target-only edits, all source
index values unchanged, and all 12 quarantined slices unchanged.

`TicketStageTest/validate_editorial_release_v4.py` and `v5.py`
each performed local W16 normalization, normalized target SHA-256 checks,
W19 HOLD-only admission checks, and W16's existing credential-pattern scan.
For **both** immutable derivatives:

- 668/668 draft/manifest hashes matched; no schema/digest or known
  staff-only structural errors were reported.
- W19 refused **all 668/668** as `not independently approved`.
- Existing scanner found **0 credential-pattern matches**; this does **not**
  imply comprehensive privacy, licensing or staff-visibility clearance.

Latest private review candidate:
`SyntheticWorkers/editorial-derivative-v5/` with
`SyntheticWorkers/screening-v9/`. Original v3 and v4 immutable releases
remain unchanged and available for comparison and rollback.

The 44 v9 edits are **provisional editorial corrections only**. None has
independent source/action-log verification, privacy/rights clearance or a
trainable split. Six rejected source tickets stay quarantined. The v8
50-case review packet remains private at
`parallel-review-coordinator/PRIORITIZED-EVIDENCE-PACKET-V8.private.jsonl`;
its historical original risk ratings are not fresh v9 approvals.

**Next permitted work:** independent per-record/as-of-turn factual review,
rights/privacy and staff-only visibility assessment, source-lineage/split
audit and controlled further HOLD-only edits. Do not train, run a paid GPU,
release a model, alter production, or touch W20 holdout data as a result
of any of these screening scores or CPU checks.
