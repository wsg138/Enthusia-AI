"""Tests for the reference-only W18 historical rewrite queue."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from enthusia_ticket_corpus.rewrite_queue import build_rewrite_queue


def _candidate(
    *,
    rid: str = "ticket-1",
    quality: str = "USABLE_WITH_EDIT",
    reasons: list[str] | None = None,
) -> dict:
    return {
        "id": rid,
        "source_type": "ticket",
        "visibility": "staff",
        "scenario": "[bug-report] The market command stopped working.",
        "messages": [
            {"role": "user", "content": "The market command stopped working."},
            {"role": "assistant", "content": "It is a known bug, I'll fix it later."},
        ],
        "expected_answer": "It is a known bug, I'll fix it later.",
        "facts": [],
        "tags": ["bug-report", "ticket-corpus"],
        "quality": quality,
        "ticket_id": rid.removeprefix("ticket-"),
        "quality_reasons": reasons
        or [
            "current_state_claim_requires_verification",
            "staff_action_claim_requires_context",
        ],
        "evidence_requests": [],
        "staff_decisions": [{"decision": "close"}],
        "stale_claims": [
            {
                "claim": "It is a known bug.",
                "stale_risk": "medium",
                "reason": "volatile current-state claim",
            }
        ],
    }


def _write(path: Path, records: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )


def test_historical_staff_answer_is_reference_only(tmp_path: Path) -> None:
    source = tmp_path / "input.jsonl"
    output = tmp_path / "output"
    _write(source, [_candidate()])

    manifest = build_rewrite_queue(
        input_path=str(source),
        output_dir=str(output),
    )

    case = json.loads(
        (output / "rewrite-queue.jsonl").read_text(encoding="utf-8")
    )
    assert case["historical_expected_answer_reference"] == (
        "It is a known bug, I'll fix it later."
    )
    assert case["historical_staff_reference"] == [
        "It is a known bug, I'll fix it later."
    ]
    assert case["target_answer"] is None
    assert case["target_quality"] == "UNREVIEWED"
    assert case["training_eligible"] is False
    assert manifest["counts"]["training_eligible"] == 0


def test_rewrite_requirements_respond_to_quality_reasons(tmp_path: Path) -> None:
    source = tmp_path / "input.jsonl"
    output = tmp_path / "output"
    _write(
        source,
        [
            _candidate(
                reasons=[
                    "volatile_claim_requires_verification",
                    "human_decision_like_content",
                    "missing_evidence_request",
                    "thin_staff_response",
                ]
            )
        ],
    )

    build_rewrite_queue(input_path=str(source), output_dir=str(output))
    case = json.loads(
        (output / "rewrite-queue.jsonl").read_text(encoding="utf-8")
    )
    joined = " ".join(case["rewrite_requirements"]).lower()
    assert "re-verify" in joined
    assert "punishment/appeal" in joined
    assert "evidence" in joined
    assert "complete standalone answer" in joined


@pytest.mark.parametrize("quality", ["BAD_RESPONSE", "OUTDATED", "INCOMPLETE"])
def test_negative_quality_cannot_enter_rewrite_queue(
    tmp_path: Path, quality: str
) -> None:
    source = tmp_path / "input.jsonl"
    _write(source, [_candidate(quality=quality)])
    with pytest.raises(ValueError, match="rewrite queue accepts only"):
        build_rewrite_queue(
            input_path=str(source),
            output_dir=str(tmp_path / "output"),
        )


def test_output_is_new_and_manifest_tracks_hashes(tmp_path: Path) -> None:
    source = tmp_path / "input.jsonl"
    output = tmp_path / "output"
    _write(
        source,
        [
            _candidate(rid="ticket-2", quality="GOOD", reasons=["clean_conversation"]),
            _candidate(rid="ticket-1"),
        ],
    )

    manifest = build_rewrite_queue(
        input_path=str(source),
        output_dir=str(output),
    )
    lines = [
        json.loads(line)
        for line in (output / "rewrite-queue.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    assert [case["case_id"] for case in lines] == ["ticket-1", "ticket-2"]
    assert manifest["counts"]["rewrite_cases"] == 2
    assert manifest["counts"]["historical_quality"] == {
        "GOOD": 1,
        "USABLE_WITH_EDIT": 1,
    }
    assert len(manifest["artifacts"]["rewrite-queue.jsonl"]) == 64

    with pytest.raises(ValueError, match="must not already exist"):
        build_rewrite_queue(
            input_path=str(source),
            output_dir=str(output),
        )
