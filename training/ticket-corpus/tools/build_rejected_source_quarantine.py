"""Freeze private six-worker REJECT recommendations at source-ticket level.

Never publish the JSON ledger: it contains private source provenance.
Reads the *immutable* HOLD draft/source/manifest release and worker
recommendations. Refuses mismatches, incomplete sibling slices and overwrites.
Does not approve, edit, split or train any data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(row: dict) -> bytes:
    return json.dumps(row, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def load_lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()]


def freeze(*, staging: Path, rejected: Path, output: Path,
           expected_rejections: int = 6) -> dict:
    if output.exists():
        raise FileExistsError("immutable quarantine ledger exists; never overwrite")
    source_manifest = staging / "REVIEW-MANIFEST-ALL-HOLD.private.json"
    original = source_manifest.read_bytes()
    manifest = json.loads(original.decode("utf-8-sig"))
    drafts = load_lines(staging / "DRAFT-W16-NOT-TRAINABLE.private.jsonl")
    source_index = load_lines(staging / "REVIEW-SOURCE-INDEX.private.jsonl")
    recommendations = load_lines(rejected)
    if manifest.get("schema") != "enthusia-ticket-review-admission/v1":
        raise ValueError("unexpected source admission manifest schema")
    if len(manifest.get("entries", [])) != len(drafts) or len(drafts) != len(source_index):
        raise ValueError("source release count mismatch")
    def unique(rows, name):
        d = {}
        for row in rows:
            key = row.get(name)
            if not isinstance(key, str) or not key or key in d:
                raise ValueError("source release missing or duplicate ID")
            d[key] = row
        return d
    by_entry = unique(manifest["entries"], "candidate_id")
    by_draft = unique(drafts, "candidate_id")
    by_index = unique(source_index, "draft_id")
    if set(by_entry) != set(by_draft) or set(by_draft) != set(by_index):
        raise ValueError("source index and HOLD release IDs differ")
    for cid, row in by_draft.items():
        entry, meta = by_entry[cid], by_index[cid]
        if row.get("id") != cid or meta.get("source_candidate_id") != row.get("source_candidate_id"):
            raise ValueError("draft/source-index lineage mismatch")
        checked = dict(row)
        checked.pop("dataset_version", None)
        checked.pop("quality_metadata", None)
        if entry.get("record_sha256") != digest(canonical(checked)):
            raise ValueError("original reviewed target hash mismatch")
        if (entry.get("review_status") != "HOLD" or entry.get("approved_uses") != []
                or entry.get("split") != "none" or entry.get("rights_cleared") is not False
                or entry.get("privacy_cleared") is not False
                or entry.get("staff_visibility_reviewed") is not False):
            raise ValueError("source release is not strictly HOLD")
        if row.get("quality") != "USABLE_WITH_EDIT":
            raise ValueError("unexpected source quality: must remain nontrainable")
    if len(recommendations) != expected_rejections:
        raise ValueError("unexpected number of rejection recommendations")
    entries, seen = [], set()
    for decision in recommendations:
        source = decision.get("source_candidate_id")
        if source in seen or not isinstance(source, str):
            raise ValueError("duplicate or missing rejected source")
        seen.add(source)
        if decision.get("recommendation") != "REJECT":
            raise ValueError("non-rejection in quarantine recommendations")
        slices = [f"{source}-a01", f"{source}-a02"]
        if decision.get("draft_id") != slices[1]:
            raise ValueError("worker rejection must match exact second draft")
        if any(cid not in by_entry for cid in slices):
            raise ValueError("missing rejected source sibling slice")
        a, b = [by_entry[cid] for cid in slices]
        if any(by_draft[cid].get("source_candidate_id") != source for cid in slices):
            raise ValueError("rejected source identity mismatch")
        for field in ("source_candidate_sha256", "source_file_sha256", "source_revision"):
            if not a.get(field) or a[field] != b.get(field):
                raise ValueError("rejected sibling source hash/revision mismatch")
        entries.append({
            "source_candidate_id": source,
            "source_candidate_sha256": a["source_candidate_sha256"],
            "source_file_sha256": a["source_file_sha256"],
            "source_revision": a["source_revision"],
            "disposition": "REJECT",
            "draft_ids": slices,
        })
    document = {
        "schema": "enthusia-ticket-source-quarantine/v1",
        "source_hold_manifest_sha256": digest(original),
        "source_count": len(entries),
        "draft_count": sum(len(e["draft_ids"]) for e in entries),
        "entries": sorted(entries, key=lambda x: x["source_candidate_id"]),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return {
        "source_count": document["source_count"],
        "draft_count": document["draft_count"],
        "quarantine_ledger_sha256": digest(output.read_bytes()),
        "status": "PRIVATE_QUARANTINE_ONLY_ZERO_ADMISSIONS",
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--staging-dir", required=True, type=Path)
    p.add_argument("--rejections", required=True, type=Path)
    p.add_argument("--out-file", required=True, type=Path)
    p.add_argument("--expected-rejections", type=int, default=6)
    a = p.parse_args()
    print(json.dumps(freeze(staging=a.staging_dir, rejected=a.rejections,
                            output=a.out_file,
                            expected_rejections=a.expected_rejections), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
