import json
from pathlib import Path

import pytest

from enthusia_ticket_corpus.real_ingest import run_real_ingest


def _ticket(ticket_id: str, category: str = "general_support", staff_text: str = "I checked this and resolved it.") -> dict:
    return {
        "ticket_id": ticket_id,
        "channel_id": f"ticket-{ticket_id}",
        "guild": "Enthusia",
        "category": category,
        "created_at": "2026-09-01T12:00:00Z",
        "closed_at": "2026-09-01T13:00:00Z",
        "flags": {"dm": False, "deleted": False, "private": False},
        "messages": [
            {
                "message_id": f"{ticket_id}-p",
                "author_id": "PLAYER",
                "author_name": "PLAYER",
                "role": "player",
                "content": "How do I fix this server issue?",
                "timestamp": "2026-09-01T12:00:00Z",
            },
            {
                "message_id": f"{ticket_id}-s",
                "author_id": "STAFF_1",
                "author_name": "STAFF_1",
                "role": "staff",
                "content": staff_text,
                "timestamp": "2026-09-01T13:00:00Z",
            },
        ],
    }


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )


def test_real_ingest_requires_governance_ack(tmp_path: Path) -> None:
    source = tmp_path / "export.jsonl"
    _write_jsonl(source, [_ticket("1")])

    with pytest.raises(ValueError, match="governance"):
        run_real_ingest(
            input_path=str(source),
            output_dir=str(tmp_path / "out"),
            dataset_version="ticket-real-test-v1",
            reference_date="2026-10-07T00:00:00Z",
            run_id="test-run",
            operator="test-operator",
            governance_acknowledged=False,
        )


def test_real_ingest_writes_review_only_partitions_and_content_free_rejections(tmp_path: Path) -> None:
    source = tmp_path / "export.jsonl"
    _write_jsonl(
        source,
        [
            _ticket("1"),
            _ticket("2", staff_text="not my problem, figure it out yourself"),
            _ticket("3", category="appeal"),
        ],
    )

    manifest = run_real_ingest(
        input_path=str(source),
        output_dir=str(tmp_path / "out"),
        dataset_version="ticket-real-test-v1",
        reference_date="2026-10-07T00:00:00Z",
        run_id="test-run",
        operator="test-operator",
        governance_acknowledged=True,
    )

    assert manifest["status"] == "review_required_not_admitted"
    assert manifest["counts"]["in_scope"] == 2
    assert manifest["counts"]["positive_review_candidates"] == 1
    assert manifest["counts"]["negative_eval_candidates"] == 1
    assert manifest["counts"]["rejected"] == 1

    positive = (tmp_path / "out" / "positive-review-candidates.jsonl").read_text(encoding="utf-8")
    negative = (tmp_path / "out" / "negative-eval-candidates.jsonl").read_text(encoding="utf-8")
    rejected = (tmp_path / "out" / "rejected.jsonl").read_text(encoding="utf-8")

    assert '"quality": "GOOD"' in positive
    assert '"quality": "BAD_RESPONSE"' in negative
    assert json.loads(rejected) == {
        "reason": "outside_first_pass_scope",
        "ticket_id": "3",
    }
    assert "not my problem" not in rejected
    assert manifest["next_gate"].startswith("Manual real-ticket sample review")


def test_real_ingest_redacts_pii_before_review_artifact(tmp_path: Path) -> None:
    source = tmp_path / "export.jsonl"
    ticket = _ticket("4", staff_text="Please send a screenshot, then I can check it.")
    ticket["messages"][0]["content"] = "My email is realperson@example.com and my IP is 192.0.2.55."
    _write_jsonl(source, [ticket])

    run_real_ingest(
        input_path=str(source),
        output_dir=str(tmp_path / "out"),
        dataset_version="ticket-real-test-v1",
        reference_date="2026-10-07T00:00:00Z",
        run_id="test-run",
        operator="test-operator",
        governance_acknowledged=True,
    )

    blob = (tmp_path / "out" / "positive-review-candidates.jsonl").read_text(encoding="utf-8")
    assert "realperson@example.com" not in blob
    assert "192.0.2.55" not in blob
    assert "[EMAIL]" in blob
    assert "[IP]" in blob


def test_real_ingest_refuses_git_worktree_output(tmp_path: Path) -> None:
    source = tmp_path / "export.jsonl"
    _write_jsonl(source, [_ticket("5")])

    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()

    with pytest.raises(ValueError, match="Git worktree"):
        run_real_ingest(
            input_path=str(source),
            output_dir=str(repo / "private-output"),
            dataset_version="ticket-real-test-v1",
            reference_date="2026-10-07T00:00:00Z",
            run_id="test-run",
            operator="test-operator",
            governance_acknowledged=True,
        )


def test_real_ingest_refuses_existing_output_dir(tmp_path: Path) -> None:
    source = tmp_path / "export.jsonl"
    _write_jsonl(source, [_ticket("6")])
    out = tmp_path / "out"
    out.mkdir()

    with pytest.raises(ValueError, match="must not already exist"):
        run_real_ingest(
            input_path=str(source),
            output_dir=str(out),
            dataset_version="ticket-real-test-v1",
            reference_date="2026-10-07T00:00:00Z",
            run_id="test-run",
            operator="test-operator",
            governance_acknowledged=True,
        )
