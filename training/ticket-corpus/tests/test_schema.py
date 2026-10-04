"""Schema contract tests: local section-27 validator + optional W16 cross-check."""

import os
import sys

import pytest

from enthusia_ticket_corpus.schema import CandidateValidationError, validate_candidate


def _minimal_candidate(**overrides):
    rec = {
        "id": "ticket-fx-1",
        "source_type": "ticket",
        "visibility": "staff",
        "scenario": "[lost-items] lost netherite gear",
        "messages": [{"role": "user", "content": "I lost my gear"}],
        "expected_answer": "Refunded.",
        "facts": [
            {
                "claim": "Staff refunded the gear.",
                "source": "ticket:fx-1",
                "source_version": "2026-09-20",
            }
        ],
        "tags": ["lost-items"],
        "quality": "GOOD",
        "created_at": "2026-10-03T12:00:00Z",
    }
    rec.update(overrides)
    return rec


def test_accepts_valid_candidate():
    out = validate_candidate(_minimal_candidate())
    assert out["id"] == "ticket-fx-1"
    assert out["source_type"] == "ticket"


def test_rejects_bad_source_type():
    with pytest.raises(CandidateValidationError):
        validate_candidate(_minimal_candidate(source_type="forum"))


def test_rejects_bad_visibility():
    with pytest.raises(CandidateValidationError):
        validate_candidate(_minimal_candidate(visibility="galaxy"))


def test_rejects_bad_message_role():
    with pytest.raises(CandidateValidationError):
        validate_candidate(
            _minimal_candidate(messages=[{"role": "player", "content": "hi"}])
        )


def test_rejects_empty_messages():
    with pytest.raises(CandidateValidationError):
        validate_candidate(_minimal_candidate(messages=[]))


def test_rejects_bad_quality_label():
    with pytest.raises(CandidateValidationError):
        validate_candidate(_minimal_candidate(quality="PERFECT"))


def test_rejects_missing_id():
    with pytest.raises(CandidateValidationError):
        validate_candidate(_minimal_candidate(id="  "))


def test_preserves_extra_fields():
    out = validate_candidate(_minimal_candidate(ticket_id="fx-1", custom=1))
    assert out["ticket_id"] == "fx-1"


def test_w16_cross_check():
    """If W16's package is importable, our candidates must pass ITS validator.

    W16's PR targets main and is not in this branch's base, so this check only
    runs when W16_PACKAGE_DIR points at a checkout (local dev), and skips in CI.
    """
    w16_dir = os.environ.get("W16_PACKAGE_DIR")
    if not w16_dir or not os.path.isdir(w16_dir):
        pytest.skip("W16_PACKAGE_DIR not set; W16 not available on this branch")
    sys.path.insert(0, w16_dir)
    try:
        from enthusia_datasets.record import validate_record  # noqa: E402
    except ImportError:
        pytest.skip("enthusia_datasets not importable")
    out = validate_record(_minimal_candidate())
    assert out["source_type"] == "ticket"
