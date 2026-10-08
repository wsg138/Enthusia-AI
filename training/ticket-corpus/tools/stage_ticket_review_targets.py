"""Stage private synthetic support-ticket candidates for independent review.

This is a preparation-only converter. It creates draft W16-compatible
prompt/completion targets and a manifest of HOLD decisions. It cannot approve,
split, or train any record. Requires an explicit local source directory and
audit filters. No network/model access. Never copies staff-only material into
trainable records or prints private ticket text.

Example:
  python stage_ticket_review_targets.py \
    --source-dir PRIVATE/SyntheticWorkers/outputs \
    --audit-dir PRIVATE/SyntheticWorkers/audit \
    --out-dir PRIVATE/SyntheticWorkers/staged-review-v1 \
    --w16-root CHECKOUT/training/datasets
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

SCHEMA = "enthusia-ticket-review-admission/v1"
SOURCE_PATTERN = re.compile(r"^W[0-9]{2}-(?!batch[0-9])[a-z0-9-]+\.jsonl$")
CHECKED_CLAIM = re.compile(
    r"\b(?:I checked|I've checked|I found|I verified|the logs (?:show|confirm)|"
    r"the database (?:shows|confirms)|the checks show|I pulled (?:the )?logs)\b",
    re.IGNORECASE,
)
ARTIFACT_WORDING = re.compile(
    r"\b(?:in this fixture|synthetic fixture|training (?:example|dataset)|"
    r"this (?:synthetic|fictional) (?:example|scenario)|source_refs|staff-only evidence summary)\b",
    re.IGNORECASE,
)


def canonical_json(row: dict) -> str:
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def load_w16_validator(w16_root: Path):
    if not (w16_root / "enthusia_datasets" / "record.py").is_file():
        raise ValueError("W16 root must contain enthusia_datasets/record.py")
    sys.path.insert(0, str(w16_root))
    from enthusia_datasets.record import validate_record
    return validate_record


def record_digest(record: dict) -> str:
    """Same algorithm as W19 review_admission.record_digest."""
    doc = dict(record)
    doc.pop("dataset_version", None)
    doc.pop("quality_metadata", None)
    return _digest(canonical_json(doc).encode("utf-8"))


def _iter_jsonl(path: Path):
    """Yield (line, record, canonical original line bytes digest)."""
    for line_number, text in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not text.strip():
            continue
        item = json.loads(text)
        if not isinstance(item, dict):
            raise ValueError(f"{path.name}:{line_number} not a JSON object")
        yield line_number, item, _digest(text.encode("utf-8"))


def load_review_filters(audit: Path) -> tuple[set[str], set[str], dict[str, str]]:
    triage = audit / "triage-index.jsonl"
    warnings = audit / "quality-probes-index.jsonl"
    lineage = audit / "method-v2-lineage-groups.json"
    if not all(p.is_file() for p in (triage, warnings, lineage)):
        raise FileNotFoundError("required frozen triage, warnings or lineage audit absent")

    priority = {
        o["candidate_id"] for _, o, _ in _iter_jsonl(triage)
        if o.get("bucket") == "PRIORITY_INDEPENDENT_REVIEW"
    }
    warned = {o["id"] for _, o, _ in _iter_jsonl(warnings)}
    components = json.loads(lineage.read_text(encoding="utf-8-sig"))
    family: dict[str, str] = {}
    for i, group in enumerate(components):
        for cid in group["ids"]:
            if cid in family:
                raise ValueError(f"duplicate lineage membership: {cid}")
            family[cid] = f"seed-component-{i:04d}"
    return priority, warned, family


def _valid_conversation(convo) -> bool:
    if not isinstance(convo, list) or len(convo) < 4:
        return False
    return (sum(isinstance(x, dict) and x.get("role") == "user" for x in convo) >= 2
            and sum(isinstance(x, dict) and x.get("role") == "assistant" for x in convo) >= 2
            and all(isinstance(x, dict) and x.get("role") in ("user", "assistant")
                    and isinstance(x.get("content"), str) and x["content"].strip()
                    for x in convo))


def make_draft_targets(
    source: dict, source_digest: str, source_file_digest: str,
    family_group: str, validator,
) -> list[tuple[dict, dict]]:
    """Return W16 review drafts, plus strictly HOLD manifest entries.

    Every model output is as-of a previous *player* message. Later messages,
    synthetic investigation results, staff notes, and absent tool traces
    are excluded. This does not certify factual correctness.
    """
    cid = source["candidate_id"]
    convo = source.get("conversation")
    if not _valid_conversation(convo):
        return []
    lane = source["lane"]
    staged = []
    prior = []
    ordinal = 0
    for index, message in enumerate(convo):
        role, content = message["role"], message["content"]
        if role == "assistant" and index > 0 and convo[index - 1]["role"] == "user":
            ordinal += 1
            slice_id = f"{cid}-a{ordinal:02d}"
            flags = []
            if CHECKED_CLAIM.search(content):
                flags.append("unverified_tool_result_claim")
            if ARTIFACT_WORDING.search(content):
                flags.append("artifact_language_visible")
            draft = {
                "id": slice_id,
                "candidate_id": slice_id,
                "source_candidate_id": cid,
                "worker_origin": "ticket_worker_v1",
                "source_candidate_sha256": source_digest,
                "source_file_sha256": source_file_digest,
                "source_revision": f"sha256:{source_file_digest}",
                "family_group": family_group,
                "seed_refs": source["seed_refs"],
                "source_type": "synthetic",
                "visibility": "public",
                "scenario": f"Synthetic support ticket; lane {lane}",
                "messages": [dict(m) for m in prior],
                "expected_answer": content,
                "expected_actions": [],
                "tools": [],
                "facts": [],
                "tags": ["review_pending", "synthetic_ticket"],
                "quality": "USABLE_WITH_EDIT",
                "generator": "enthusia-synthetic-ticket-worker-v1",
                "tool_trace_status": "reference_only",
                "review_flags": flags,
            }
            # No staff_handoff or investigation fields may enter a draft.
            clean = validator(draft)
            manifest = {
                "candidate_id": slice_id,
                "record_sha256": record_digest(clean),
                "source_candidate_sha256": source_digest,
                "source_file_sha256": source_file_digest,
                "source_revision": f"sha256:{source_file_digest}",
                "family_group": family_group,
                "seed_refs": source["seed_refs"],
                "parent_ids": [],
                # Explicit placeholders are non-authoritative: HOLD only.
                "independent_reviewer_id": "PENDING_INDEPENDENT_REVIEW",
                "generator_id": "synthetic-ticket-worker-v1",
                "review_status": "HOLD",
                "approved_uses": [],
                "split": "none",
                "rights_cleared": False,
                "privacy_cleared": False,
                "staff_visibility_reviewed": False,
                "source_withdrawn": False,
                "tool_trace_status": "reference_only",
            }
            staged.append((clean, manifest))
        prior.append({"role": role, "content": content})
    return staged


def stage(source_dir: Path, audit_dir: Path, out_dir: Path, w16_root: Path) -> dict:
    validator = load_w16_validator(w16_root)
    priority, warned, family = load_review_filters(audit_dir)
    if out_dir.exists():
        raise FileExistsError("review staging destination already exists; never overwrite a release")
    originals = sorted(p for p in source_dir.iterdir() if SOURCE_PATTERN.fullmatch(p.name))
    if not originals:
        raise ValueError("no canonical worker JSONL files found")

    outputs: list[dict] = []
    entries: list[dict] = []
    source_index: list[dict] = []
    skipped = Counter()
    inventory = []
    seen = set()
    for path in originals:
        fd = _digest(path.read_bytes())
        count = 0
        for source_line, source, raw_digest in _iter_jsonl(path):
            cid = source.get("candidate_id")
            count += 1
            if not isinstance(cid, str) or cid in seen:
                raise ValueError("missing/duplicate source candidate identifier")
            seen.add(cid)
            if cid not in priority:
                skipped["not_priority_multiturn"] += 1
                continue
            if cid in warned:
                skipped["lexical_warning"] += 1
                continue
            if cid not in family:
                skipped["missing_lineage_component"] += 1
                continue
            pairs = make_draft_targets(source, raw_digest, fd, family[cid], validator)
            if not pairs:
                skipped["no_safe_player_to_assistant_slice"] += 1
                continue
            for row, entry in pairs:
                outputs.append(row)
                entries.append(entry)
                source_index.append({
                    "draft_id": row["candidate_id"],
                    "source_candidate_id": cid,
                    "source_filename": path.name,
                    "source_line": source_line,
                    "source_refs": source.get("source_refs", []),
                    "family_group": family[cid],
                    "review_flags": row["review_flags"],
                    "investigation_step_count": len(source.get("investigation", [])),
                    "investigation_turn_order_verified": False,
                    "staff_handoff_needed": bool(
                        source.get("staff_handoff", {}).get("needed", False)
                    ),
                    "review_status": "HOLD",
                    "training_eligible": False,
                })
        inventory.append({"filename": path.name, "sha256": fd, "records": count})
    if not outputs:
        raise ValueError("no reviewable candidate slices; no output written")
    if len({row["id"] for row in outputs}) != len(outputs):
        raise ValueError("duplicate staged target ID")
    # All entries must be HOLD, and no positive quality labels can escape.
    assert all(x["quality"] == "USABLE_WITH_EDIT" for x in outputs)
    assert all(e["review_status"] == "HOLD" and not e["approved_uses"] for e in entries)

    out_dir.mkdir(parents=True)  # protected by pre-existing directory check
    draft_path = out_dir / "DRAFT-W16-NOT-TRAINABLE.private.jsonl"
    approval_path = out_dir / "REVIEW-MANIFEST-ALL-HOLD.private.json"
    index_path = out_dir / "REVIEW-SOURCE-INDEX.private.jsonl"
    draft_path.write_text("\n".join(canonical_json(x) for x in outputs) + "\n",
                          encoding="utf-8")
    approval_path.write_text(json.dumps({
        "schema": SCHEMA,
        "manifest_id": "review-pending-ticket-staging-v1",
        "review_protocol_revision": "ticket-review-pending-v1",
        "entries": entries,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    index_path.write_text(
        "\n".join(canonical_json(x) for x in source_index) + "\n",
        encoding="utf-8"
    )
    report = {
        "status": "REVIEW_ONLY_NOT_TRAINABLE",
        "candidates_seen": len(seen),
        "eligible_unwarned_source_candidates": sum(
            1 for cid in seen if cid in priority and cid not in warned
        ),
        "draft_prompt_completion_slices": len(outputs),
        "all_review_statuses": "HOLD",
        "approved_training_records": 0,
        "draft_flags": dict(Counter(f for row in outputs for f in row["review_flags"])),
        "skipped": dict(skipped),
        "source_inventory": inventory,
        "draft_sha256": _digest(draft_path.read_bytes()),
        "manifest_sha256": _digest(approval_path.read_bytes()),
        "private_review_index_sha256": _digest(index_path.read_bytes()),
        "private_review_index_records": len(source_index),
        "warnings": [
            "A structural draft is NOT a reviewed target.",
            "No unanchored investigation trace was converted into a tool result.",
            "Curator must validate private source content, reviewer identities, and family splits.",
            "All draft quality flags and manifest decisions are non-trainable.",
        ],
    }
    (out_dir / "STAGING-REPORT.json").write_text(json.dumps(report, indent=2) + "\n",
                                                   encoding="utf-8")
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--audit-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--w16-root", type=Path, required=True)
    args = parser.parse_args(argv)
    report = stage(args.source_dir, args.audit_dir, args.out_dir, args.w16_root)
    # No private ticket content in stdout.
    print(json.dumps({k: v for k, v in report.items()
                      if k not in ("source_inventory",)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
