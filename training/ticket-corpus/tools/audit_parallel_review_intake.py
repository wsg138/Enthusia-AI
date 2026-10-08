"""Read-only, fail-closed intake for six independent HOLD-only ticket reviews.

This tool does not edit datasets, combine private dialogue, or approve
training. It checks completeness, exact frozen slot ownership, target hashes,
and that workers did not assert training approval. It emits counts and
a private issue list; reviewed answers remain solely in worker directories.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

VALID_RECOMMENDATIONS = {"KEEP_PENDING", "PROPOSE_REWRITE", "REJECT"}
HASH_FIELDS = ("original_target_hash", "original_target_sha256",
               "original_answer_sha256", "original_record_sha256",
               "original_record_hash", "record_sha256")


def jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()]


def get_key(row: dict, names: tuple[str, ...]):
    for n in names:
        if n in row and row[n] is not None:
            return row[n]
    return None


def load_assignments(root: Path):
    summary_path = root / "PARALLEL-REVIEW-ASSIGNMENT-SUMMARY.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8-sig"))
    if (summary.get("status") != "HOLD_ONLY_PARALLEL_REVIEW_ASSIGNMENT"
            or summary.get("approved_records") != 0):
        raise ValueError("invalid or non-HOLD coordinator assignment release")
    slots = int(summary["slots"])
    if slots < 1:
        raise ValueError("empty worker assignment")
    assigned = {}
    for slot in range(1, slots+1):
        path = root / f"SLOT-{slot}-ASSIGNMENTS.private.jsonl"
        expected = summary["per_slot_file_sha256"][str(slot)]
        if sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"slot {slot} assignment hash changed")
        items = jsonl(path)
        assigned[slot] = {}
        for item in items:
            rid = item.get("draft_id")
            if (not isinstance(rid, str) or rid in assigned[slot]
                    or item.get("slot") != slot
                    or item.get("training_eligible") is not False
                    or item.get("review_status") != "HOLD"):
                raise ValueError(f"slot {slot} invalid or duplicate assignment")
            assigned[slot][rid] = item
    combined = [rid for records in assigned.values() for rid in records]
    if (len(set(combined)) != len(combined)
            or len(combined) != summary["risk_cases_selected"]):
        raise ValueError("incomplete/overlapping coordinator assignment")
    return summary, assigned


def check_result(result: dict, assignment: dict):
    rid = get_key(result, ("draft_id", "candidate_id", "id"))
    if rid != assignment["draft_id"]:
        raise ValueError("wrong draft ID")
    src = get_key(result, ("source_candidate_id", "source_id"))
    if src != assignment["source_candidate_id"]:
        raise ValueError(f"{rid}: source candidate mismatch")
    observed_hash = get_key(result, HASH_FIELDS)
    accepted_hashes = {assignment["record_sha256"],
                       assignment["answer_sha256"]}
    if not isinstance(observed_hash, str) or observed_hash not in accepted_hashes:
        raise ValueError(f"{rid}: missing or stale original target hash")
    rec = get_key(result, ("recommendation", "suggested_action", "decision"))
    if not isinstance(rec, str) or rec.upper() not in VALID_RECOMMENDATIONS:
        raise ValueError(f"{rid}: missing/unknown provisional recommendation")
    blocked_truthy = ("training_eligible", "approved_for_training",
                      "independently_approved_for_training", "rights_cleared",
                      "privacy_cleared", "independent_approval")
    if any(result.get(k) not in (None, False) for k in blocked_truthy):
        raise ValueError(f"{rid}: worker claimed training/rights approval")
    if result.get("rights_clearance") not in (None, "NOT_VERIFIED", "UNCLEARED"):
        raise ValueError(f"{rid}: worker claimed rights clearance")
    if result.get("approved_uses") not in (None, []):
        raise ValueError(f"{rid}: worker claimed approved dataset uses")
    if result.get("split") not in (None, "none", "NONE"):
        raise ValueError(f"{rid}: worker tried to assign a train/eval split")
    if result.get("admission_status") not in (None, "HOLD", "NOT_APPROVED"):
        raise ValueError(f"{rid}: worker claimed admission")
    if result.get("final_admission_decision") not in (None, "HOLD", "NOT_APPROVED"):
        raise ValueError(f"{rid}: worker claimed final admission")
    if result.get("review_status") not in (None, "HOLD", "PENDING_INDEPENDENT"):
        raise ValueError(f"{rid}: worker attempted a review status promotion")
    if result.get("approval_status") not in (None, "HOLD", "PENDING"):
        raise ValueError(f"{rid}: worker attempted approval")
    # Source evidence and proposed answers are not copied to intake output.
    return rec.upper()


def audit(assigned: dict[int, dict], worker_inputs: dict[int, list[dict]]):
    problems = []
    counts = {}
    for slot, expected in assigned.items():
        results = worker_inputs.get(slot)
        if results is None:
            problems.append({"slot":slot,"type":"MISSING_WORKER_FILE"})
            counts[str(slot)] = {"expected":len(expected),"received":0,"accepted":0}
            continue
        seen = set()
        accepted = Counter()
        for r in results:
            rid = get_key(r,("draft_id","candidate_id","id"))
            if rid in seen:
                problems.append({"slot":slot,"type":"DUPLICATE_DRAFT","draft_id":rid})
                continue
            seen.add(rid)
            if rid not in expected:
                problems.append({"slot":slot,"type":"WRONG_SLOT_OR_UNASSIGNED","draft_id":rid})
                continue
            try:
                rec = check_result(r,expected[rid])
                accepted[rec] += 1
            except (ValueError,TypeError) as exc:
                problems.append({"slot":slot,"type":"INVALID_OR_STALE_RESULT",
                                 "draft_id":rid,"reason":str(exc)})
        for rid in sorted(set(expected)-seen):
            problems.append({"slot":slot,"type":"MISSING_DRAFT","draft_id":rid})
        counts[str(slot)] = {
            "expected":len(expected), "received":len(results),
            "accepted":sum(accepted.values()),
            "provisional_recommendations":dict(sorted(accepted.items())),
        }
    all_expected=sum(len(x) for x in assigned.values())
    all_accepted=sum(x["accepted"] for x in counts.values())
    report={
        "status":"HOLD_ONLY_REVIEW_INTAKE_COMPLETE" if not problems and all_accepted==all_expected
                 else "HOLD_ONLY_REVIEW_INTAKE_INCOMPLETE_OR_INVALID",
        "expected_records":all_expected,
        "validated_worker_records":all_accepted,
        "slot_counts":counts,
        "issue_count":len(problems),
        "approved_records":0,
        "issue_details":problems,
        "limitations":[
            "Worker recommendations are NOT independent approval or source verification.",
            "No training record is admitted; all original W19 rights/privacy gates remain.",
            "Only source candidate IDs, original hashes and provisional actions are checked.",
        ]
    }
    return report


def ingest(root: Path, slot_paths: dict[int, Path], out_dir: Path):
    if out_dir.exists():
        raise FileExistsError("intake report already exists")
    summary, assigned = load_assignments(root)
    if any(slot not in assigned for slot in slot_paths):
        raise ValueError("unknown worker slot supplied")
    worker_inputs = {slot: jsonl(path) for slot,path in slot_paths.items()}
    report = audit(assigned, worker_inputs)
    out_dir.mkdir(parents=True)
    (out_dir/"INTAKE-VALIDATION.private.json").write_text(
        json.dumps(report,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    public = {k:v for k,v in report.items() if k!="issue_details"}
    print(json.dumps(public,indent=2))
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assignment-dir",type=Path,required=True)
    parser.add_argument("--out-dir",type=Path,required=True)
    parser.add_argument("--review",action="append",default=[],
                        help="N=ABSOLUTE_PATH_TO_WORKER_RESULTS_JSONL; repeat for each slot")
    args=parser.parse_args()
    mapping={}
    for item in args.review:
        if "=" not in item:
            parser.error("--review must be SLOT=PATH")
        slot_s,path=item.split("=",1)
        slot=int(slot_s)
        if slot in mapping:
            parser.error("duplicate worker slot")
        mapping[slot]=Path(path)
    ingest(args.assignment_dir,mapping,args.out_dir)


if __name__ == "__main__":
    main()
