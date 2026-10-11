"""Fail-closed QA for private reference-only tool-trace review packets.

The auditor never grants approval. It binds every packet row to one immutable
HOLD-only staging release, distinguishes completed evidence/action claims from
prospective capability promises, and writes PRIVATE annotations plus aggregate
counts. Raw prompts, answers, and refs never appear in the aggregate summary.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from hashlib import sha256
from pathlib import Path

from apply_review_proposals import verify_rejected_source_ledger
from screen_review_targets import (
    ASSERTED_RESULT,
    EVIDENCE_CLAIM,
    FUTURE_HANDOFF,
    SOURCE_FINDING,
    TOOL_INTENT,
    UNVERIFIED_HANDOFF,
    candidate_digest,
    canonical,
    read_jsonl,
    verify_staged,
)

PACKET_SCHEMA = "enthusia-private-unverified-trace-review/v1"
ANNOTATION_SCHEMA = "enthusia-private-tool-trace-qa/v1"
CORRECTION_SCHEMA = "enthusia-private-tool-trace-correction-proposal/v1"


def _digest_file(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def _normalize(text: str) -> str:
    return text.replace("’", "'").replace("‘", "'")


def _claim_classes(text: str) -> set[str]:
    checked = _normalize(text)
    classes: set[str] = set()
    if (
        EVIDENCE_CLAIM.search(checked)
        or ASSERTED_RESULT.search(checked)
        or SOURCE_FINDING.search(checked)
    ):
        classes.add("COMPLETED_RESULT_CLAIM")
    if UNVERIFIED_HANDOFF.search(checked):
        classes.add("COMPLETED_HANDOFF_CLAIM")
    if TOOL_INTENT.search(checked):
        classes.add("PROSPECTIVE_TOOL_CAPABILITY")
    if FUTURE_HANDOFF.search(checked):
        classes.add("PROSPECTIVE_HANDOFF_CAPABILITY")
    return classes


def _context_classes(messages: list[dict]) -> set[str]:
    classes: set[str] = set()
    for message in messages:
        if message.get("role") == "assistant":
            classes.update(_claim_classes(str(message.get("content", ""))))
    return classes


def _required_verification(
    target_classes: set[str], context_classes: set[str]
) -> list[str]:
    needs: list[str] = []
    combined = target_classes | context_classes
    requirements = (
        ("COMPLETED_RESULT_CLAIM", "OBSERVED_AS_OF_TURN_TOOL_OR_EXTERNAL_EVIDENCE"),
        ("COMPLETED_HANDOFF_CLAIM", "VERIFIED_HANDOFF_ACTION_TRACE"),
        (
            "PROSPECTIVE_TOOL_CAPABILITY",
            "VERIFIED_TOOL_CAPABILITY_AND_ORCHESTRATION_CONTRACT",
        ),
        (
            "PROSPECTIVE_HANDOFF_CAPABILITY",
            "VERIFIED_HANDOFF_CAPABILITY_AND_AUTHORIZATION",
        ),
    )
    needs.extend(requirement for claim, requirement in requirements if claim in combined)
    return needs or ["NO_CURRENT_TRACE_TRIGGER_REVIEW_INHERITED_WARNING"]


def _correction_strategy(source_rejected: bool, target_classes: set[str]) -> str:
    if source_rejected:
        return "NO_EDIT_KEEP_SOURCE_QUARANTINED"
    completed = {"COMPLETED_RESULT_CLAIM", "COMPLETED_HANDOFF_CLAIM"}
    prospective = {"PROSPECTIVE_TOOL_CAPABILITY", "PROSPECTIVE_HANDOFF_CAPABILITY"}
    if completed & target_classes:
        return "REWRITE_TO_UNRESOLVED_STATE_AND_REQUEST_OR_CONDITION_ON_EVIDENCE"
    if prospective & target_classes:
        return "VERIFY_CAPABILITY_OR_REMOVE_FIRST_PERSON_ACTION_PROMISE"
    return "REVIEW_INHERITED_WARNING_NO_TARGET_TEXT_CHANGE_PROPOSED"


def _validate_packet_row(row: dict, draft: dict, meta: dict, entry: dict) -> None:
    cid = draft["candidate_id"]
    exact_fields = {
        "source_candidate_id": draft.get("source_candidate_id"),
        "family_group": draft.get("family_group"),
    }
    if row.get("schema") != PACKET_SCHEMA or row.get("candidate_id") != cid:
        raise ValueError(f"{cid}: invalid trace-review packet identity")
    if row.get("reviewed_target_sha256") != entry.get("record_sha256"):
        raise ValueError(f"{cid}: reviewed target hash mismatch")
    if candidate_digest(draft) != row.get("reviewed_target_sha256"):
        raise ValueError(f"{cid}: packet target no longer matches staging")
    for field in ("source_candidate_sha256", "source_file_sha256", "source_revision"):
        if row.get(field) != draft.get(field) or row.get(field) != entry.get(field):
            raise ValueError(f"{cid}: {field} mismatch")
    for field, expected in exact_fields.items():
        if row.get(field) != expected:
            raise ValueError(f"{cid}: {field} mismatch")
    _validate_packet_context(row, draft, meta, cid)


def _validate_packet_context(row: dict, draft: dict, meta: dict, cid: str) -> None:
    if (
        meta.get("source_candidate_id") != draft.get("source_candidate_id")
        or meta.get("family_group") != draft.get("family_group")
    ):
        raise ValueError(f"{cid}: source index lineage mismatch")
    if draft.get("expected_actions") or draft.get("tools"):
        raise ValueError(f"{cid}: staged trace is not reference-only")
    if draft.get("tool_trace_status") not in (None, "reference_only"):
        raise ValueError(f"{cid}: staged trace status is inconsistent")
    expected = (
        ("as_of_turn_messages", draft.get("messages"), "as-of-turn prompt"),
        ("proposed_player_visible_answer", draft.get("expected_answer"), "proposed answer"),
        ("source_refs", meta.get("source_refs", []), "source refs"),
    )
    for field, value, label in expected:
        if row.get(field) != value:
            raise ValueError(f"{cid}: {label} mismatch")


def _validate_hold_fields(row: dict, cid: str) -> None:
    reported = row.get("reported_flags")
    if row.get("tool_trace_status") != "reference_only":
        raise ValueError(f"{cid}: packet is not reference_only")
    if not isinstance(reported, list) or "unverified_tool_result_claim" not in reported:
        raise ValueError(f"{cid}: packet missing inherited trace warning")
    if row.get("recorded_expected_action_count") != 0 or row.get("recorded_tool_count") != 0:
        raise ValueError(f"{cid}: packet unexpectedly records tool actions")
    required_false = (
        "training_eligible",
        "rights_cleared",
        "privacy_cleared",
        "accepted_as_verified",
    )
    if row.get("review_status") != "PENDING_INDEPENDENT" or any(
        row.get(field) is not False for field in required_false
    ):
        raise ValueError(f"{cid}: packet contains an earned-status claim")


def _annotation(row: dict, source_rejected: bool) -> dict:
    target_classes = _claim_classes(row["proposed_player_visible_answer"])
    context_classes = _context_classes(row["as_of_turn_messages"])
    return {
        "schema": ANNOTATION_SCHEMA,
        "candidate_id": row["candidate_id"],
        "source_candidate_id": row["source_candidate_id"],
        "reviewed_target_sha256": row["reviewed_target_sha256"],
        "source_candidate_sha256": row["source_candidate_sha256"],
        "source_revision": row["source_revision"],
        "packet_row_sha256": sha256(canonical(row).encode("utf-8")).hexdigest(),
        "source_rejected": source_rejected,
        "target_claim_classes": sorted(target_classes),
        "context_claim_classes": sorted(context_classes),
        "required_verification": _required_verification(target_classes, context_classes),
        "proposed_correction": _correction_strategy(source_rejected, target_classes),
        "review_status": "PENDING_INDEPENDENT",
        "training_eligible": False,
        "accepted_as_verified": False,
    }


def _correction_proposal(annotation: dict) -> dict | None:
    if annotation["source_rejected"]:
        return None
    if annotation["proposed_correction"] != "VERIFY_CAPABILITY_OR_REMOVE_FIRST_PERSON_ACTION_PROMISE":
        return None
    return {
        "schema": CORRECTION_SCHEMA,
        "candidate_id": annotation["candidate_id"],
        "source_candidate_id": annotation["source_candidate_id"],
        "expected_original_record_sha256": annotation["reviewed_target_sha256"],
        "expected_original_source_sha256": annotation["source_candidate_sha256"],
        "expected_original_source_revision": annotation["source_revision"],
        "proposal_kind": "CAPABILITY_VERIFICATION_OR_PLAYER_SAFE_REWRITE",
        "edit_instruction": (
            "Verify the exact deployed tool/action capability and authorization for this "
            "as-of-turn context. If it cannot be verified, remove the first-person promise "
            "to check, compare, inspect, query, or hand off; preserve uncertainty and ask "
            "only for the minimum evidence needed without implying a result occurred."
        ),
        "approval_status": "HOLD",
        "training_eligible": False,
        "requires_independent_review": True,
    }


def _validate_screening_row(
    row: dict, draft: dict, meta: dict, blocked: set[str]
) -> tuple[bool, bool]:
    cid = draft["candidate_id"]
    expected = (
        ("source_candidate_id", draft.get("source_candidate_id")),
        ("family_group", draft.get("family_group")),
        ("prompt", draft.get("messages")),
        ("proposed_answer", draft.get("expected_answer")),
        ("source_refs", meta.get("source_refs", [])),
    )
    if any(row.get(field) != value for field, value in expected):
        raise ValueError(f"{cid}: stale screening queue content")
    warning = "unverified_tool_result_claim" in row.get("flags", [])
    urgent = row.get("risk_tier") == "EVIDENCE_OR_SAFETY_REVIEW"
    quarantined_urgent = urgent and draft.get("source_candidate_id") in blocked
    return warning, quarantined_urgent


def _validate_screening_queue(
    path: Path,
    by_id: dict[str, dict],
    by_src: dict[str, dict],
    blocked: set[str],
) -> tuple[dict, set[str]]:
    rows = read_jsonl(path)
    if len(rows) != len(by_id):
        raise ValueError("screening queue count does not match staging")
    seen: set[str] = set()
    warning_ids: set[str] = set()
    urgent = quarantined = 0
    for row in rows:
        cid = row.get("draft_id")
        if not isinstance(cid, str) or cid in seen or cid not in by_id:
            raise ValueError("screening queue has duplicate or unknown draft")
        warning, quarantined_urgent = _validate_screening_row(
            row, by_id[cid], by_src[cid], blocked
        )
        if warning:
            warning_ids.add(cid)
        urgent += row.get("risk_tier") == "EVIDENCE_OR_SAFETY_REVIEW"
        quarantined += quarantined_urgent
        seen.add(cid)
    summary = {
        "screening_rows": len(rows),
        "screening_unverified_tool_warning_rows": len(warning_ids),
        "screening_evidence_or_safety_rows": urgent,
        "screening_evidence_or_safety_quarantined_rows": quarantined,
        "screening_evidence_or_safety_nonquarantined_rows": urgent - quarantined,
        "screening_queue_sha256": _digest_file(path),
    }
    return summary, warning_ids


def _load_release(staging: Path, quarantine_path: Path):
    drafts = read_jsonl(staging / "DRAFT-W16-NOT-TRAINABLE.private.jsonl")
    index = read_jsonl(staging / "REVIEW-SOURCE-INDEX.private.jsonl")
    manifest_path = staging / "REVIEW-MANIFEST-ALL-HOLD.private.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    by_id, by_src, by_entry = verify_staged(drafts, index, manifest)
    blocked = verify_rejected_source_ledger(
        staging, quarantine_path, drafts, index, manifest
    )
    return manifest_path, by_id, by_src, by_entry, blocked


def _audit_packet(
    packet: list[dict],
    by_id: dict[str, dict],
    by_src: dict[str, dict],
    by_entry: dict[str, dict],
    blocked: set[str],
) -> tuple[list[dict], set[str]]:
    annotations: list[dict] = []
    seen: set[str] = set()
    for row in packet:
        cid = row.get("candidate_id")
        if not isinstance(cid, str) or cid in seen or cid not in by_id:
            raise ValueError("duplicate or unknown trace-review candidate")
        _validate_packet_row(row, by_id[cid], by_src[cid], by_entry[cid])
        _validate_hold_fields(row, cid)
        rejected = by_id[cid].get("source_candidate_id") in blocked
        if row.get("source_rejected") is not rejected:
            raise ValueError(f"{cid}: quarantine status mismatch")
        annotations.append(_annotation(row, rejected))
        seen.add(cid)
    return annotations, seen


def _write_private_outputs(output: Path, annotations: list[dict]):
    output.mkdir(parents=True)
    annotations_path = output / "TRACE-QA-ANNOTATIONS.private.jsonl"
    annotations_path.write_text(
        "\n".join(canonical(row) for row in annotations) + "\n", encoding="utf-8"
    )
    proposals = [
        proposal
        for row in annotations
        if (proposal := _correction_proposal(row)) is not None
    ]
    proposals_path = output / "TRACE-QA-CORRECTION-PROPOSALS.private.jsonl"
    proposals_path.write_text(
        "\n".join(canonical(row) for row in proposals) + ("\n" if proposals else ""),
        encoding="utf-8",
    )
    return annotations_path, proposals_path, proposals


def _counter_fields(annotations: list[dict]) -> dict:
    target = Counter(claim for row in annotations for claim in row["target_claim_classes"])
    context = Counter(claim for row in annotations for claim in row["context_claim_classes"])
    requirements = Counter(
        need for row in annotations for need in row["required_verification"]
    )
    strategies = Counter(row["proposed_correction"] for row in annotations)
    return {
        "claim_class_counts": dict(sorted((target + context).items())),
        "target_claim_class_counts": dict(sorted(target.items())),
        "context_claim_class_counts": dict(sorted(context.items())),
        "verification_requirement_counts": dict(sorted(requirements.items())),
        "proposed_correction_counts": dict(sorted(strategies.items())),
    }


def _build_report(
    *,
    packet: list[dict],
    annotations: list[dict],
    manifest_path: Path,
    packet_path: Path,
    quarantine_path: Path,
    annotations_path: Path,
    proposals_path: Path,
    proposals: list[dict],
    screening_summary: dict,
) -> dict:
    return {
        "status": "REVIEW_ONLY_ZERO_TRAINING_ADMISSIONS",
        "packet_rows": len(packet),
        "unique_candidates": len(annotations),
        "source_rejected_rows": sum(row["source_rejected"] for row in annotations),
        **_counter_fields(annotations),
        "staging_manifest_sha256": _digest_file(manifest_path),
        "input_packet_sha256": _digest_file(packet_path),
        "quarantine_ledger_sha256": _digest_file(quarantine_path),
        "annotations_sha256": _digest_file(annotations_path),
        "correction_proposals": len(proposals),
        "correction_proposals_sha256": _digest_file(proposals_path),
        "approved_records": 0,
        **screening_summary,
        "limitations": [
            "Lexical classification does not prove a tool action occurred or did not occur.",
            "Capability promises require the deployed tool/authorization contract to be verified.",
            "No annotation grants rights, privacy, factual, split, or training approval.",
            "Quarantined sources remain rejected and are not proposed for editing.",
        ],
    }


def audit(
    staging: Path,
    packet_path: Path,
    quarantine_path: Path,
    output: Path,
    screening_path: Path | None = None,
) -> dict:
    if output.exists():
        raise FileExistsError("QA release exists; never overwrite")
    manifest_path, by_id, by_src, by_entry, blocked = _load_release(
        staging, quarantine_path
    )
    screening_summary: dict = {}
    warning_ids: set[str] | None = None
    if screening_path is not None:
        screening_summary, warning_ids = _validate_screening_queue(
            screening_path, by_id, by_src, blocked
        )
    packet = read_jsonl(packet_path)
    annotations, seen = _audit_packet(packet, by_id, by_src, by_entry, blocked)
    if warning_ids is not None and seen != warning_ids:
        raise ValueError("trace packet does not match screening warning ID set")
    annotations_path, proposals_path, proposals = _write_private_outputs(
        output, annotations
    )
    report = _build_report(
        packet=packet,
        annotations=annotations,
        manifest_path=manifest_path,
        packet_path=packet_path,
        quarantine_path=quarantine_path,
        annotations_path=annotations_path,
        proposals_path=proposals_path,
        proposals=proposals,
        screening_summary=screening_summary,
    )
    (output / "TRACE-QA-SUMMARY.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging-dir", type=Path, required=True)
    parser.add_argument("--trace-packet", type=Path, required=True)
    parser.add_argument("--source-quarantine-ledger", type=Path, required=True)
    parser.add_argument("--screening-queue", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    report = audit(
        args.staging_dir,
        args.trace_packet,
        args.source_quarantine_ledger,
        args.out_dir,
        args.screening_queue,
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
