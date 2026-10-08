"""Freeze six-worker assignments for a private HOLD-only ticket-review queue.

CPU-only, stdlib-only. Never reads live systems, approves data, repairs tickets,
or uploads private records. Fail closed on mismatched original records, source
index, manifest, queue, or duplicate IDs. Output must be a NEW private folder.

Run this coordinator-side, not in each worker's shared output folder.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from hashlib import sha256
import json
from pathlib import Path

from screen_review_targets import candidate_digest, verify_staged

EXPECTED_RISK = "EVIDENCE_OR_SAFETY_REVIEW"


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def json_canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False)


def assign_slot(source_id: str, slots: int = 6) -> int:
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("missing source candidate ID")
    if slots < 1:
        raise ValueError("invalid worker count")
    return sha256(source_id.encode("utf-8")).digest()[0] % slots + 1


def build_ledger(drafts: list[dict], index: list[dict],
                 manifest: dict, queue: list[dict],
                 *, slots: int = 6, expected_risk_count: int | None = 71):
    by_draft, by_src, by_manifest = verify_staged(drafts, index, manifest)
    by_queue = {}
    for case in queue:
        rid = case.get("draft_id")
        if not isinstance(rid, str) or not rid or rid in by_queue:
            raise ValueError("queue has duplicate or missing draft ID")
        by_queue[rid] = case
    if set(by_queue) != set(by_draft):
        raise ValueError("queue does not cover the exact staged draft release")
    workers = {slot: [] for slot in range(1, slots + 1)}
    seen: set[str] = set()
    all_selected = []
    for rid in sorted(by_queue):
        case = by_queue[rid]
        row = by_draft[rid]
        source = by_src[rid]
        admission = by_manifest[rid]
        if case.get("proposed_answer") != row.get("expected_answer"):
            raise ValueError(f"{rid}: stale proposed answer")
        if case.get("family_group") != row.get("family_group"):
            raise ValueError(f"{rid}: family mismatch")
        if (case.get("source_candidate_id") != row.get("source_candidate_id")
                or case.get("source_candidate_id") != source.get("source_candidate_id")):
            raise ValueError(f"{rid}: source candidate mismatch")
        if case.get("training_eligible") is not False:
            raise ValueError(f"{rid}: screened record might be trainable")
        if admission.get("review_status") != "HOLD":
            raise ValueError(f"{rid}: original admission is not HOLD")
        if case.get("risk_tier") != EXPECTED_RISK:
            continue
        if rid in seen:
            raise ValueError("duplicate selected record")
        seen.add(rid)
        slot = assign_slot(case["source_candidate_id"], slots)
        record = {
            "draft_id": rid,
            "source_candidate_id": case["source_candidate_id"],
            "family_group": row["family_group"],
            "slot": slot,
            "record_sha256": candidate_digest(row),
            "answer_sha256": sha256(row["expected_answer"].encode("utf-8")).hexdigest(),
            "review_status": "HOLD",
            "training_eligible": False,
        }
        if record["record_sha256"] != admission.get("record_sha256"):
            raise ValueError(f"{rid}: manifest digest mismatch")
        workers[slot].append(record)
        all_selected.append(record)
    if expected_risk_count is not None and len(all_selected) != expected_risk_count:
        raise ValueError(
            f"risk queue changed: expected {expected_risk_count}, found {len(all_selected)}"
        )
    if sum(map(len, workers.values())) != len(seen):
        raise ValueError("assignment missing or duplicated a selected draft")
    # Every source ID maps to one slot; no ticket can span workers.
    source_slots = defaultdict(set)
    for item in all_selected:
        source_slots[item["source_candidate_id"]].add(item["slot"])
    if any(len(s) != 1 for s in source_slots.values()):
        raise ValueError("one original ticket is assigned to multiple workers")
    summary = {
        "status": "HOLD_ONLY_PARALLEL_REVIEW_ASSIGNMENT",
        "slots": slots,
        "all_staged_drafts_checked": len(by_draft),
        "risk_cases_selected": len(all_selected),
        "unique_source_candidates": len(source_slots),
        "slot_counts": {str(i): len(workers[i]) for i in workers},
        "approved_records": 0,
        "assignment_rule": "sha256(source_candidate_id utf8).digest()[0] % slots + 1",
        "limitations": [
            "Worker branch existence is not evidence review output is complete.",
            "No worker review is automatically admitted into the training corpus.",
            "Independent evidence/rights/privacy review and W19 approval are still required.",
        ],
    }
    return workers, summary


def freeze(staged_dir: Path, screening_dir: Path, out_dir: Path,
           *, slots: int = 6, expected_risk_count: int = 71):
    if out_dir.exists():
        raise FileExistsError("review intake release already exists; no overwrite")
    drafts_path = staged_dir / "DRAFT-W16-NOT-TRAINABLE.private.jsonl"
    index_path = staged_dir / "REVIEW-SOURCE-INDEX.private.jsonl"
    manifest_path = staged_dir / "REVIEW-MANIFEST-ALL-HOLD.private.json"
    queue_path = screening_dir / "SCREENING-QUEUE.private.jsonl"
    drafts = load_jsonl(drafts_path)
    index = load_jsonl(index_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    queue = load_jsonl(queue_path)
    assignments, summary = build_ledger(
        drafts, index, manifest, queue,
        slots=slots, expected_risk_count=expected_risk_count,
    )
    out_dir.mkdir(parents=True)
    paths = {}
    for slot, assigned in assignments.items():
        name = f"SLOT-{slot}-ASSIGNMENTS.private.jsonl"
        path = out_dir / name
        path.write_text("\n".join(json_canonical(item) for item in assigned) + "\n",
                        encoding="utf-8")
        paths[str(slot)] = sha256(path.read_bytes()).hexdigest()
    all_slots = [r for slot in assignments for r in assignments[slot]]
    digest = sha256("\n".join(json_canonical(item) for item in all_slots).encode("utf-8")).hexdigest()
    summary["assignment_digest_sha256"] = digest
    summary["per_slot_file_sha256"] = paths
    summary["input_sha256"] = {
        "drafts": sha256(drafts_path.read_bytes()).hexdigest(),
        "index": sha256(index_path.read_bytes()).hexdigest(),
        "manifest": sha256(manifest_path.read_bytes()).hexdigest(),
        "screening_queue": sha256(queue_path.read_bytes()).hexdigest(),
    }
    (out_dir / "PARALLEL-REVIEW-ASSIGNMENT-SUMMARY.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged-dir", type=Path, required=True)
    parser.add_argument("--screening-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--slots", type=int, default=6)
    parser.add_argument("--expected-risk-count", type=int, default=71)
    args = parser.parse_args()
    result = freeze(
        args.staged_dir, args.screening_dir, args.out_dir,
        slots=args.slots, expected_risk_count=args.expected_risk_count,
    )
    print(json.dumps({
        "status": result["status"],
        "all_staged_drafts_checked": result["all_staged_drafts_checked"],
        "risk_cases_selected": result["risk_cases_selected"],
        "unique_source_candidates": result["unique_source_candidates"],
        "slot_counts": result["slot_counts"],
        "approved_records": result["approved_records"],
        "assignment_digest_sha256": result["assignment_digest_sha256"],
    }, indent=2))


if __name__ == "__main__":
    main()
