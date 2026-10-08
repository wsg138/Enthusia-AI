# Q01 — Synthetic Ticket Trace QA (review-only)

**Scope:** [issue #107](https://github.com/wsg138/Enthusia-AI/issues/107), supplementing the admission requirements of [#94](https://github.com/wsg138/Enthusia-AI/issues/94). This work adds diagnostics, **not** human approvals, incident proof, a trainable dataset, or a replacement admission gate.

## Workflow

Run the existing `tools/build_rejected_source_quarantine.py` against the **same immutable HOLD release** being audited and the original private six-source REJECT recommendations. The earlier v4-bound ledger must never be relabeled or silently reused for v5. Both sibling draft slices for each rejected source remain blocked.

Then audit a private packet and its matching private screening queue:

```text
python training/ticket-corpus/tools/audit_unverified_trace_packet.py \
  --staging-dir PRIVATE/SyntheticWorkers/editorial-derivative-v5 \
  --trace-packet PRIVATE/SyntheticWorkers/parallel-review-coordinator/UNVERIFIED-TOOL-TRACE-REVIEW-V9.private.jsonl \
  --source-quarantine-ledger PRIVATE/RELEASE-BOUND-SOURCE-QUARANTINE.private.json \
  --screening-queue PRIVATE/SyntheticWorkers/screening-v9/SCREENING-QUEUE.private.jsonl \
  --out-dir PRIVATE/SyntheticWorkers/parallel-review-coordinator/NEW-IMMUTABLE-QA-RELEASE
```

The tool refuses an existing output directory. It verifies the complete HOLD-only staging manifest, target SHA-256, source candidate/source file SHA-256, source revision, prompt/answer, source refs, source index, reference-only trace status, quarantine ledger and—when supplied—the screening warning ID set. Discrepancies fail closed. **Only run on the owner's authorized private PC.** Never upload the input packet, generated annotations, conversations, source index, individual citations, or rejection ledger to GitHub.

The new private `TRACE-QA-ANNOTATIONS.private.jsonl` includes only reviewed-target/source hash pins, packet-row digest, evidence categories, unresolved verification requirements and provisional correction strategies. For non-quarantined target replies that promise future tool work, `TRACE-QA-CORRECTION-PROPOSALS.private.jsonl` records hash-pinned HOLD-only reviewer instructions to verify the deployed capability or remove the unsupported first-person promise; it does not rewrite canonical dialogue. `TRACE-QA-SUMMARY.json` is aggregate-only and SHA-256-pins the inputs and outputs. None of these artifacts alters canonical v5 or claims approval.

## Provisional findings on 2026-10-08

The v5 screening packet holds **73** inherited `unverified_tool_result_claim` warnings, **one** on a quarantined source. The Q01 private audit matched **all 73 packet IDs** against the 668-row v5 manifest and original screening-v9 ID set; it found zero approvals. The aggregate lexical classification is:

| Review requirement / observation | Counts |
| --- | ---: |
| Observed as-of-turn evidence for completed-result phrasing | 1 |
| Verified action trace for completed handoff phrasing | 1 |
| Capability and orchestration contract for prospective tool work | 56 |
| Handoff capability and authorization for prospective staff work | 2 |
| No current lexical trace trigger; inherited warning still needs review | 16 |
| Quarantined source candidates included in packet | 1 |

Review requirements overlap: counts must not be summed as mutually exclusive dispositions. Some prospective-intent wording appears in **prior assistant context**, not the target answer; future action promises are not themselves completed-tool claims. The private annotation set proposes **no edits for quarantined sources**, **34 provisional capability-verification-or-rewording decisions**, and **38 inherited-warning reviews without target rewrite**. These are reviewer assignments, not automatic edits.

A separate new-directory Q01 re-screen of unchanged v5 identified **23 exact repeated-target groups** across **94 draft slices**, with the largest group containing five. It detected no cross-lane group reaching the 4+ threshold. Additional possible capability-promise signals occurred in **238 target replies** and **177 prior-turn contexts**; the revised screener flags these conservatively in the style/provenance tier. Its resulting tiers (6 evidence/safety, 474 style/provenance, 188 standard) are **not directly comparable as quality gains or regressions** with screening-v9 because the detection rules changed.

All 668 drafts remain HOLD, split `none`, no approved uses; **0 trainable**. All six source-level REJECT recommendations and both sibling slices per source remain quarantined. The six evidence/safety-tier v9 cases all belong to those quarantined sources. No results establish player facts, staff actions, tool execution, current deployment state, rights, or privacy clearance.

## Independent reviewer obligations

1. **Evidence/result claims:** Verify original as-of-turn tool call, response bytes, timestamps, permission scope, event linkage, and whether the source represented production at that time. A pinned GitHub commit, issue, snapshot or fixture is not itself a real incident result.
2. **Future action promises:** Check whether the assistant actually has that read tool or Ticket Bot contract, the caller's authorization and consent, time-of-turn deployment configuration, and whether an action could realistically be invoked next. GitHub `main` is never automatically the deployed system. Remove unsupported first-person promises if capability cannot be verified.
3. **Staff handoffs and visibility:** Require the Ticket Bot-authorized action trace or a separately verified staff review path. Keep internal notes/evidence out of player-visible targets. Avoid claims that escalation, restoration, punishment, refunds, or ticket closure already happened without verification.
4. **Repetition/quality:** Manually inspect each repeated-answer group for identical boilerplate that fails to answer different player contexts. A repeated generic request can be valid, but should not replace tailored troubleshooting.
5. **Provenance and governance:** Verify exact source revision and deployment authority, source bytes and hash, deletion/withdrawal propagation, independent privacy and rights review, reviewer identity, contamination/connected-family split, and release-bound rejection ledger. Preserve HOLD or REJECT until independently adjudicated.

## Tests and limitations

Synthetic-only regression tests cover hash and prompt binding, stale or mismatched source provenance, quarantine false claims, unrecorded action insertion, duplicate packet rows, immutable output, future-vs-completed claim distinction, inherited warning, earlier-turn context, and answer repetition flags. Runtime and GitHub checks must pass at exact PR head before merge.

This QA is deterministic, not semantic verification. Regex can miss deceptive claims and can overflag legitimate conditional language. **Do not automatically demote warnings, generate approvals, unquarantine, train, touch W20, or export private data.** Case-specific independent human review remains outstanding.
