"""Convert six HOLD-only worker reviews into private editorial proposals.

Requires a fully valid, frozen 71/71 intake. Rejected candidates become
explicit quarantine entries, never editorial rewrites. All outputs are PRIVATE;
this tool cannot approve a draft, change the source corpus, or assign splits.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

from audit_parallel_review_intake import audit, get_key, jsonl, load_assignments


def canonical(x):
    return json.dumps(x,sort_keys=True,ensure_ascii=False,
                      separators=(",",":"),allow_nan=False)


def prepare(assigned, reports):
    check = audit(assigned, reports)
    if check["status"] != "HOLD_ONLY_REVIEW_INTAKE_COMPLETE":
        raise ValueError("worker review incomplete or invalid; no proposals exported")
    proposals, quarantine, pending = [], [], []
    for slot in sorted(assigned):
        for case in reports[slot]:
            rid=get_key(case,("draft_id","candidate_id","id"))
            original=assigned[slot][rid]
            action=get_key(case,("recommendation","suggested_action","decision")).upper()
            entry={
                "draft_id":rid,
                "source_candidate_id":original["source_candidate_id"],
                "family_group":original["family_group"],
                "worker_slot":slot,
                "review_status":"HOLD",
                "training_eligible":False,
                "independent_approval":False,
            }
            if action=="PROPOSE_REWRITE":
                answer=case.get("proposed_corrected_response")
                if not isinstance(answer,str) or not answer.strip():
                    raise ValueError(f"{rid}: missing proposed rewritten answer")
                if sha256(answer.encode("utf-8")).hexdigest()==original["answer_sha256"]:
                    raise ValueError(f"{rid}: proposed answer unchanged")
                proposals.append({
                    **entry,
                    "approval_status":"HOLD",
                    "candidate_action":"PROPOSE_EDIT_AFTER_SOURCE_CHECK",
                    "review_type":"WORKER_PRELIMINARY_NOT_INDEPENDENT_APPROVAL",
                    "suggested_player_safe_answer":answer,
                    "explanation":case.get("explanation",""),
                    "issue":"UNANCHORED_EVIDENCE_WORKER_REVIEW"
                })
            elif action=="REJECT":
                quarantine.append({**entry,
                    "recommendation":"REJECT",
                    "reason":case.get("explanation",""),
                    "independent_disposition":"PENDING_CONFIRMATION"})
            else:
                pending.append({**entry,"recommendation":"KEEP_PENDING"})
    all_ids=[x["draft_id"] for x in proposals+quarantine+pending]
    if len(all_ids)!=len(set(all_ids)):
        raise ValueError("duplicate ID in normalized worker decisions")
    return proposals,quarantine,pending,{
        "status":"REVIEW_PROPOSALS_ONLY_ALL_HOLD",
        "worker_review_results":len(all_ids),
        "proposed_rewrites":len(proposals),
        "quarantine_recommendations":len(quarantine),
        "kept_pending":len(pending),
        "approved_records":0,
        "limitations":[
            "These are preliminary worker judgments, not independent final approvals.",
            "Quarantined cases must be excluded from future training releases.",
            "Proposed answers still require source/privacy/policy validation.",
        ],
    }


def convert(assignment_dir:Path, inputs:dict[int,Path], out_dir:Path):
    if out_dir.exists():
        raise FileExistsError("coordinator normalization destination already exists")
    _,assigned=load_assignments(assignment_dir)
    if set(inputs)!=set(assigned):
        raise ValueError("must supply exactly one review file for every slot")
    rows={slot:jsonl(path) for slot,path in inputs.items()}
    proposals,quarantine,pending,report=prepare(assigned,rows)
    out_dir.mkdir(parents=True)
    for name,data in [
        ("NORMALIZED-EDITORIAL-PROPOSALS.private.jsonl",proposals),
        ("QUARANTINED-REJECTION-RECOMMENDATIONS.private.jsonl",quarantine),
        ("KEEP-PENDING.private.jsonl",pending)]:
        (out_dir/name).write_text("\n".join(canonical(x) for x in data)+"\n",
                                  encoding="utf-8")
    (out_dir/"NORMALIZATION-SUMMARY.json").write_text(
        json.dumps(report,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,indent=2))
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--assignment-dir",type=Path,required=True)
    p.add_argument("--out-dir",type=Path,required=True)
    p.add_argument("--review",action="append",default=[])
    args=p.parse_args()
    mapping={}
    for value in args.review:
        slot,separator,path=value.partition("=")
        if not separator: p.error("--review must be SLOT=FILE")
        if int(slot) in mapping:p.error("duplicate worker slot")
        mapping[int(slot)]=Path(path)
    convert(args.assignment_dir,mapping,args.out_dir)


if __name__=="__main__":
    main()
