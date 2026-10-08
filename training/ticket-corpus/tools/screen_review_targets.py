"""CPU-only screening of HOLD-only ticket review drafts.

This is a triage tool, not an independent quality judge. It MUST NOT change
source files, assign GOOD/IDEAL, grant uses, or create APPROVED manifests.
All prompt/answer text and individual citation refs stay in PRIVATE outputs.

The source index, manifest and draft must agree one-to-one, or refuse input.
No GitHub or production calls. Intended for repeatable screening before
independent semantic and factual review.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

EVIDENCE_CLAIM = re.compile(
    r"\b(?:I(?:'ve| have)? (?:checked|verified|confirmed|found|pulled|"
    r"looked (?:up|at)|compared) (?:the |your |that |an? )?|"
    r"the (?:logs|database|records|checks|server state|evidence) "
    r"(?:show|shows|confirm|confirms|indicate|indicates)|"
    r"this (?:check|inspection) (?:shows|confirms)|"
    r"(?:the )?backups? (?:show|shows|confirm|confirms))\b",
    re.IGNORECASE,
)
ARTIFACT = re.compile(
    r"\b(?:in (?:this|the) test scenario|in this fixture|fixture(?:-only)? (?:evidence|shows)|"
    r"synthetic (?:fixture|example|scenario)|training (?:example|dataset)|"
    r"(?:source_refs|scenario_facts|staff_handoff)|"
    r"as an ai language model)\b",
    re.IGNORECASE,
)
PROMISE = re.compile(
    r"\b(?:I(?:'ll| will) (?:refund|restore|reimburse|ban|punish|"
    r"roll\s?back|delete|edit|transfer) (?:your |the |those |that |it\b)|"
    r"I(?:'ve| have) (?:refunded|restored|reimbursed|punished|banned|"
    r"deleted|transferred))\b", re.IGNORECASE,
)
SECRETS_REQUEST = re.compile(
    r"\b(?:send|share|post|paste|give)\b.{0,35}\b(?:password|"
    r"recovery code|verification code|2fa code|api key|private key)\b",
    re.IGNORECASE,
)
MUTABLE = re.compile(r"@[a-zA-Z][\w./-]*(?=[:#]|$)")
PINNED = re.compile(r"@[0-9a-fA-F]{40}(?=[:#]|$)")
NORMALIZE = re.compile(r"\s+")


def canonical(record):
    return json.dumps(record, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()]


def candidate_digest(record):
    x = dict(record)
    x.pop("dataset_version", None)
    x.pop("quality_metadata", None)
    return digest(canonical(x).encode("utf-8"))


def verify_staged(drafts: list, source_index: list, manifest: dict):
    if manifest.get("schema") != "enthusia-ticket-review-admission/v1":
        raise ValueError("expected HOLD-only independent admission v1 manifest")
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ValueError("invalid review manifest")
    if not (len(drafts) == len(source_index) == len(entries)):
        raise ValueError("incomplete/stale staging files: mismatched record counts")
    by_id = {}
    by_src = {}
    by_entry = {}
    for row in drafts:
        rid = row.get("candidate_id")
        if not rid or rid in by_id or row.get("id") != rid:
            raise ValueError("duplicate/mismatched draft id")
        if row.get("quality") != "USABLE_WITH_EDIT":
            raise ValueError("draft has unexpectedly trainable quality label")
        if "staff_handoff" in row or "investigation" in row:
            raise ValueError("private internal evidence in draft")
        by_id[rid] = row
    for row in source_index:
        rid = row.get("draft_id")
        if rid in by_src or rid not in by_id:
            raise ValueError("source index missing or duplicate draft ID")
        by_src[rid] = row
    for row in entries:
        rid = row.get("candidate_id")
        if rid in by_entry or rid not in by_id:
            raise ValueError("manifest missing or duplicate draft ID")
        if (row.get("review_status") != "HOLD"
                or row.get("approved_uses") != []
                or row.get("split") != "none"
                or row.get("rights_cleared") is not False
                or row.get("privacy_cleared") is not False
                or row.get("staff_visibility_reviewed") is not False):
            raise ValueError("expected strictly HOLD-only manifest")
        if candidate_digest(by_id[rid]) != row.get("record_sha256"):
            raise ValueError("manifest target digest mismatch")
        if row.get("family_group") != by_id[rid].get("family_group"):
            raise ValueError("manifest/draft family mismatch")
        by_entry[rid] = row
    if set(by_id) != set(by_src) or set(by_id) != set(by_entry):
        raise ValueError("stale staging sources: ID sets differ")
    return by_id, by_src, by_entry


def flag_case(draft: dict, meta: dict, duplicate_frequency: int) -> dict:
    answer = draft["expected_answer"]
    messages = draft["messages"]
    history = " ".join(
        m.get("content", "") for m in messages if m.get("role") == "assistant"
    )
    flags = set(draft.get("review_flags", []))
    if EVIDENCE_CLAIM.search(answer):
        flags.add("unsupported_verified_result_in_target")
    if EVIDENCE_CLAIM.search(history):
        flags.add("unsupported_verified_result_in_context")
    if ARTIFACT.search(answer):
        flags.add("synthetic_artifact_wording_in_target")
    if ARTIFACT.search(history):
        flags.add("synthetic_artifact_wording_in_context")
    if PROMISE.search(answer):
        flags.add("discretionary_action_promised")
    if SECRETS_REQUEST.search(answer):
        flags.add("sensitive_credential_request_review")
    if duplicate_frequency >= 4:
        flags.add("repeated_target_text_4plus")
    refs = meta.get("source_refs", [])
    if any(
        MUTABLE.search(str(ref.get("ref", "")))
        and not PINNED.search(str(ref.get("ref", "")))
        for ref in refs if isinstance(ref, dict)
    ):
        flags.add("mutable_referenced_source")
    if any(
        isinstance(ref, dict) and (
            "@" not in str(ref.get("ref", ""))
            and not str(ref.get("ref", "")).startswith(("private:", "ticket-rewrite-"))
        )
        for ref in refs
    ):
        flags.add("nonversioned_ref_review")
    if not messages or messages[-1].get("role") != "user":
        flags.add("prompt_not_last_player_turn")
    if not answer.strip():
        flags.add("empty_target")
    if len(answer.split()) >= 130:
        flags.add("long_support_reply_review")

    urgent = {
        "unsupported_verified_result_in_target",
        "unsupported_verified_result_in_context",
        "synthetic_artifact_wording_in_target",
        "synthetic_artifact_wording_in_context",
        "discretionary_action_promised",
        "sensitive_credential_request_review",
    }
    if flags & urgent:
        tier = "EVIDENCE_OR_SAFETY_REVIEW"
    elif flags:
        tier = "STYLE_OR_PROVENANCE_REVIEW"
    else:
        tier = "STANDARD_INDEPENDENT_REVIEW"
    return {
        "draft_id": draft["id"], "source_candidate_id": meta["source_candidate_id"],
        "lane": draft["id"][:3], "family_group": draft["family_group"],
        "risk_tier": tier, "flags": sorted(flags),
        "source_filename": meta["source_filename"],
        "source_line": meta["source_line"],
        "review_status": "PENDING_INDEPENDENT",
        "rights_clearance": "NOT_VERIFIED",
        "production_evidence_verified": False,
        "training_eligible": False,
        "reviewer_notes": "",
        # Keep prompt and response in the private queue, never stdout/GitHub.
        "prompt": messages, "proposed_answer": answer,
        "source_refs": refs,
    }


def screen(staging: Path, output: Path):
    if output.exists():
        raise FileExistsError("screening release exists; never overwrite")
    drafts = read_jsonl(staging / "DRAFT-W16-NOT-TRAINABLE.private.jsonl")
    index = read_jsonl(staging / "REVIEW-SOURCE-INDEX.private.jsonl")
    manifest = json.loads(
        (staging / "REVIEW-MANIFEST-ALL-HOLD.private.json").read_text(encoding="utf-8-sig")
    )
    by_id, by_src, _ = verify_staged(drafts, index, manifest)
    freq = Counter(
        (row["id"][:3], NORMALIZE.sub(" ", row["expected_answer"].strip().lower()))
        for row in drafts
    )
    cases = []
    for rid, draft in sorted(by_id.items()):
        answer_key = NORMALIZE.sub(" ", draft["expected_answer"].strip().lower())
        cases.append(flag_case(draft, by_src[rid], freq[(rid[:3], answer_key)]))
    tiers = {
        "EVIDENCE_OR_SAFETY_REVIEW": 0,
        "STYLE_OR_PROVENANCE_REVIEW": 1,
        "STANDARD_INDEPENDENT_REVIEW": 2,
    }
    cases.sort(key=lambda c: (tiers[c["risk_tier"]], -len(c["flags"]),
                              c["family_group"], c["lane"], c["draft_id"]))
    # Sample examples across family groups first, then multiple examples from a
    # group only when other groups are already represented.
    selected = []
    selected_ids = set()
    for tier in tiers:
        cands = [c for c in cases if c["risk_tier"] == tier]
        per_family = defaultdict(list)
        for c in cands:
            per_family[c["family_group"]].append(c)
        fams = sorted(per_family)
        for round_no in range(max((len(v) for v in per_family.values()),default=0)):
            for fam in fams:
                group = per_family[fam]
                if round_no < len(group):
                    case = group[round_no]
                    if case["draft_id"] not in selected_ids:
                        selected.append(case)
                        selected_ids.add(case["draft_id"])
                    if len(selected) >= 60: break
            if len(selected) >= 60: break
        if len(selected) >= 60:break
    flag_counts = Counter(flag for case in cases for flag in case["flags"])
    tier_counts = Counter(case["risk_tier"] for case in cases)
    family_counts = Counter(case["family_group"] for case in cases)
    report = {
        "status": "REVIEW_ONLY_ZERO_TRAINING_ADMISSIONS",
        "drafts": len(cases), "unique_families": len(family_counts),
        "risk_tiers": dict(tier_counts),
        "flag_counts": dict(sorted(flag_counts.items())),
        "manual_sample_size": len(selected),
        "manual_sample_families": len({c["family_group"] for c in selected}),
        "all_review_statuses": "PENDING_INDEPENDENT",
        "approved_records": 0,
        "limitations": [
            "Regex/structural warnings are not independent factual review.",
            "A standard-risk draft is NOT an approved draft.",
            "Missing or non-anchored logs/DB results cannot be made real via editing.",
            "Source rights, privacy, production state and deployment require separate checks.",
        ],
    }
    output.mkdir(parents=True)
    for filename, rows in [
        ("SCREENING-QUEUE.private.jsonl", cases),
        ("MANUAL-REVIEW-SAMPLE.private.jsonl", selected),
    ]:
        (output / filename).write_text(
            "\n".join(canonical(x) for x in rows) + "\n",
            encoding="utf-8"
        )
    report["queue_sha256"] = digest(
        (output / "SCREENING-QUEUE.private.jsonl").read_bytes()
    )
    report["manual_sample_sha256"] = digest(
        (output / "MANUAL-REVIEW-SAMPLE.private.jsonl").read_bytes()
    )
    (output / "SCREENING-SUMMARY.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--staging-dir", required=True, type=Path)
    p.add_argument("--out-dir", required=True, type=Path)
    args = p.parse_args(argv)
    report = screen(args.staging_dir, args.out_dir)
    print(json.dumps(report, indent=2))  # counts only
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
