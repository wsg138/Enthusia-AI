"""End-to-end pipeline tests on the synthetic fixture corpus."""

import os

import pytest

import enthusia_ticket_corpus.pipeline as pipeline_mod
from enthusia_ticket_corpus.pipeline import (
    PipelineConfig,
    load_fixtures,
    run_pipeline,
)
from enthusia_ticket_corpus.schema import validate_candidate

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "fixtures", "tickets.jsonl")
REF = "2026-10-03T12:00:00Z"


def _config(**kw):
    base = dict(
        reference_date=REF,
        live_facts={"current ip": "play.newexample.net"},
        dataset_version="ticket-corpus-fixture-v1",
    )
    base.update(kw)
    return PipelineConfig(**base)


def _run():
    return run_pipeline(load_fixtures(FIXTURES), _config())


def test_fixtures_load():
    tickets = load_fixtures(FIXTURES)
    assert len(tickets) == 7


def test_end_to_end_stats():
    result = _run()
    assert result.stats["tickets_in"] == 7
    assert result.stats["candidates"] == 6
    assert result.stats["rejected"] == 1
    assert result.stats["labels"] == {
        "GOOD": 1,
        "USABLE_WITH_EDIT": 2,
        "OUTDATED": 1,
        "INCOMPLETE": 1,
        "BAD_RESPONSE": 1,
    }


def test_expected_labels_per_fixture():
    result = _run()
    by_ticket = {c["ticket_id"]: c for c in result.candidates}
    assert by_ticket["fx-lost-items-001"]["quality"] == "GOOD"
    assert by_ticket["fx-ban-appeal-002"]["quality"] == "USABLE_WITH_EDIT"
    assert by_ticket["fx-server-ip-003"]["quality"] == "OUTDATED"
    assert by_ticket["fx-bug-secret-004"]["quality"] == "USABLE_WITH_EDIT"
    assert by_ticket["fx-incomplete-006"]["quality"] == "INCOMPLETE"
    assert by_ticket["fx-bad-response-007"]["quality"] == "BAD_RESPONSE"


def test_dm_ticket_rejected_before_redaction():
    result = _run()
    assert result.rejected == [
        {"ticket_id": "fx-dm-005", "reason": "source_excluded", "detail": "dm_channel"}
    ]


def test_outdated_fixture_marks_stale_claims():
    result = _run()
    cand = {c["ticket_id"]: c for c in result.candidates}["fx-server-ip-003"]
    assert "stale-truth" in cand["tags"]
    assert any(s["stale_risk"] == "high" for s in cand["stale_claims"])


def test_secret_fixture_cleaned():
    result = _run()
    cand = {c["ticket_id"]: c for c in result.candidates}["fx-bug-secret-004"]
    blob = " ".join(m["content"] for m in cand["messages"])
    assert "sk-fixtureFakeKeyForTesting1234567890" not in blob
    assert "PRIVATE KEY" not in blob
    assert "[SECRET_REMOVED" in blob


def test_pii_redacted_in_candidates():
    result = _run()
    cand = {c["ticket_id"]: c for c in result.candidates}["fx-ban-appeal-002"]
    blob = " ".join(m["content"] for m in cand["messages"])
    assert "fixtureb@example.com" not in blob and "[EMAIL]" in blob
    assert "192.0.2.44" not in blob and "[IP]" in blob
    # Usernames pseudonymized.
    assert "FixturePlayerB" not in blob


def test_candidates_validate_against_schema():
    for cand in _run().candidates:
        validate_candidate(cand)


def test_candidate_provenance():
    result = _run()
    cand = {c["ticket_id"]: c for c in result.candidates}["fx-lost-items-001"]
    assert cand["source_type"] == "ticket"
    assert cand["visibility"] == "staff"  # never public (governance section 3)
    assert cand["governance_ref"] == "training/datasets/GOVERNANCE-CHECKPOINT.md"
    assert all(f["source"] == "ticket:fx-lost-items-001" for f in cand["facts"])
    assert "decision:refund" in cand["tags"]
    assert any(e["evidence_type"] == "screenshot" for e in cand["evidence_requests"])


def test_deterministic_output():
    first, second = _run(), _run()
    assert first.candidates == second.candidates
    assert first.stats == second.stats


def test_candidate_timestamp_comes_from_source_ticket():
    tickets = load_fixtures(FIXTURES)
    source = next(t for t in tickets if t["ticket_id"] == "fx-lost-items-001")
    candidate = next(
        c for c in _run().candidates if c["ticket_id"] == "fx-lost-items-001"
    )
    assert candidate["created_at"] == source["closed_at"]


def test_secret_residual_rejects_ticket(monkeypatch):
    tickets = load_fixtures(FIXTURES)[:1]

    def dirty_remove(ticket):
        return ticket, {"clean": False, "patterns": ["openai_key"]}

    monkeypatch.setattr(pipeline_mod, "remove_secrets", dirty_remove)
    result = run_pipeline(tickets, _config())
    assert result.candidates == []
    assert result.rejected[0]["reason"] == "secret_residual"


def test_parse_error_rejected():
    result = run_pipeline([{"ticket_id": "", "messages": []}], _config())
    assert result.rejected[0]["reason"] == "parse_error"
