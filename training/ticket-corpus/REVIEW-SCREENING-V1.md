# Independent ticket-review screening (pre-admission, HOLD-only)

Status: **screening implementation and private pilot complete**. This is a deterministic risk-prioritization pass, **not** a model judge, human independent approval, or training dataset release.

## Purpose and inputs

Read the 668 private, W16-shaped review drafts from
`SyntheticWorkers/staged-review-v2`, their exact source-index entries, and the
HOLD-only approval manifest from prior PR #96. Refuse input if ID sets, exact
target hashes, family metadata, or counts disagree, or if any quality/approval
was silently promoted.

The screening tool is `training/ticket-corpus/tools/screen_review_targets.py`.
It uses Python standard library only and makes **no network, player-data,
server, GPU, or model API calls**.

Run with two explicit private paths and a **new destination** on each pass:

```powershell
python training/ticket-corpus/tools/screen_review_targets.py \
  --staging-dir "PRIVATE/SyntheticWorkers/staged-review-v2" \
  --out-dir "PRIVATE/SyntheticWorkers/screening-vNEXT"
```

Output stays on the authorized owner's PC; do not commit private queues.

## Screening findings (2026-10-07, screening-v2)

From **668** drafts spanning **19** connected incident/source families:

| Queue | Count |
| --- | ---: |
| EVIDENCE_OR_SAFETY_REVIEW | 107 |
| STYLE_OR_PROVENANCE_REVIEW | 184 |
| STANDARD_INDEPENDENT_REVIEW | 377 |

Warning occurrences, **not** disjoint record counts:
- 104 completions claiming verified evidence/results that are not anchored to observed tool output;
- 73 already had earlier unverified-tool-claim warnings;
- 3 include such claims in prior assistant context (even when current completion is mild);
- 128 have heavily repeated expected-answer text within their lane;
- 50 point to mutable Git repository branches;
- 68 have non-versioned references;
- one player-visible response says “test scenario.”

All **668 remain unapproved**. “Standard” means no current heuristic warning, not verified GOOD/IDEAL.

Created:
- `SCREENING-QUEUE.private.jsonl` — full per-target flags, risk tier, prompt, proposed answer and private source locator.
- `MANUAL-REVIEW-SAMPLE.private.jsonl` — 60 risk-prioritized examples spanning 18 connected families.
- `SCREENING-SUMMARY.json` — aggregate counts, content hashes and limitations.
- `EDITORIAL-REVIEW-NOTES.private.jsonl` — 14 preliminary response corrections and one prior-context repair recommendation. Editorial proposals only, all HOLD.
- `SOURCE-REVISION-RESOLUTIONS.private.json` — immutable Git commit path mappings for 10 mutable-referenced paths, from four repositories, with blob SHA-1 checks. Some references use the same path with/without blob-hash fragment; **no scenario/production claim was certified**.

## Review policy

Never treat a populated `source_refs` field as proof the source supports a
specific claim. A pinned code file can establish implemented *possible behavior*,
not that an inventory vanished, a player was kicked, or a transaction occurred.
No synthetic fixture evidence can be presented as a production observation.

The highest-risk category requires:
1. original case + exact source identity and independent fact check;
2. as-of-turn tool trace if the completion asserts checked logs/DB/history;
3. rewrite to investigation intent or abstention when trace is unavailable;
4. separation of player-visible reply and staff-only evidence;
5. independent privacy/rights/authority review and proportional escalation.

Moderate issues need source SHA pinning, current behavior confirmation, tone/
repetition review, and potential rewrite. Even clear-looking responses require
manual/independent sampling: screening is not a positive correctness test.

Do not simply relabel source worker `PASS` or `GOOD`. In a new release,
approved edited W16 record content must be independently hashed and approved
in the W19 review-admission manifest (issue #94 / PR #95). Source-family splits
must be frozen before any model training/evaluation; W20 frozen test data
remains untouched.

## Verified limits and user action

- Synthetic-only screener regression tests: **10/10 passed**.
- No ticket contents, private identifiers, source logs, or review queues
  published to GitHub.
- No source-data mutation, no training approval, no RunPod/GPU spending, and
  no live-server changes.
- No owner action is needed now. Ask owner only if a genuine policy decision,
  authorization/permission, or a concrete paid training budget approval is
  required. The current step is independent factual/semantic review, not
  training execution.

Suggested next scope: verify exact source claims for the 60 sampled drafts;
repair/remove the unsupported observed-action completions; conduct independent
review/rights/privacy clearance on the strongest corrected targets; then run
CPU-only W16/W19 conversion checks on an explicitly approved, immutable release.
