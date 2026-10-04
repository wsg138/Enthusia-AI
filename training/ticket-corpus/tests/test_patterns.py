"""Pattern extraction tests: evidence requests and staff decisions."""

from enthusia_ticket_corpus.extract import TicketMessage
from enthusia_ticket_corpus.patterns import (
    extract_evidence_requests,
    extract_staff_decisions,
)


def _msgs(*pairs):
    return [
        TicketMessage(f"m{i}", str(i), "N", role, content)
        for i, (role, content) in enumerate(pairs)
    ]


def test_evidence_requests_found():
    msgs = _msgs(
        ("player", "I lost my stuff"),
        ("staff", "Can you send a screenshot of your death location and your coordinates?"),
        ("staff", "Also, what time did this happen, and list your items?"),
        ("player", "ok here"),
    )
    found = extract_evidence_requests(msgs)
    types = {f["evidence_type"] for f in found}
    assert {"screenshot", "coordinates", "timestamp", "item_list"} <= types
    assert all(f["message_id"].startswith("m") for f in found)


def test_player_questions_not_counted_as_evidence():
    msgs = _msgs(("player", "can you send a screenshot? no wait"))
    assert extract_evidence_requests(msgs) == []


def test_decisions_found_with_duration():
    msgs = _msgs(
        ("player", "unban me"),
        ("staff", "Your ban appeal is denied. You are muted for 7 days."),
        ("staff", "I've refunded your items and I'm escalating this to an admin."),
    )
    found = extract_staff_decisions(msgs)
    by_decision = {f["decision"]: f for f in found}
    assert by_decision["deny"]["message_id"] == "m1"
    assert by_decision["mute"]["duration"] == "7 days"
    assert by_decision["refund"]["message_id"] == "m2"
    assert by_decision["escalate"]["message_id"] == "m2"


def test_no_false_decision_on_player_text():
    msgs = _msgs(("player", "I was banned unfairly"))
    assert extract_staff_decisions(msgs) == []


def test_deterministic_ordering():
    msgs = _msgs(
        ("staff", "screenshot please, then your coordinates"),
        ("staff", "muted for 7 days, appeal denied"),
    )
    first = extract_evidence_requests(msgs)
    second = extract_evidence_requests(msgs)
    assert first == second
