"""Outdated-marking tests: the critical rule (history != live truth)."""

from enthusia_ticket_corpus.outdated import has_high_risk_claim, markOutdated

REF = "2026-10-03T12:00:00Z"


def test_volatile_ip_is_high_risk():
    (m,) = markOutdated(
        ["Our current IP is play.oldexample.net"],
        ticket_date="2026-09-22T11:15:00Z",
        reference_date=REF,
    )
    assert m.stale_risk == "high"
    assert "ip_or_hostname" in m.reason


def test_price_is_medium_risk():
    (m,) = markOutdated(
        ["Devotee costs $10 per month"],
        ticket_date="2026-09-22T11:15:00Z",
        reference_date=REF,
    )
    assert m.stale_risk == "medium"


def test_live_fact_contradiction_is_high():
    (m,) = markOutdated(
        ["Our current IP is play.oldexample.net, as of today."],
        ticket_date="2026-09-22T11:15:00Z",
        live_facts={"current ip": "play.newexample.net"},
        reference_date=REF,
    )
    assert m.stale_risk == "high"
    assert "contradicts live fact" in m.reason


def test_matching_live_fact_is_not_contradiction():
    (m,) = markOutdated(
        ["Our current IP is play.newexample.net"],
        ticket_date="2026-09-22T11:15:00Z",
        live_facts={"current ip": "play.newexample.net"},
        reference_date=REF,
    )
    # Still volatile-shaped (IP), but NOT a contradiction.
    assert "contradicts live fact" not in m.reason


def test_plain_fresh_claim_is_low():
    (m,) = markOutdated(
        ["We reviewed the logs and denied the appeal"],
        ticket_date="2026-09-22T11:15:00Z",
        reference_date=REF,
    )
    assert m.stale_risk == "low"


def test_old_ticket_elevates_plain_claim():
    (m,) = markOutdated(
        ["We reviewed the logs and denied the appeal"],
        ticket_date="2024-01-01T00:00:00Z",
        reference_date=REF,
        max_age_days=365,
    )
    assert m.stale_risk == "medium"
    assert "old" in m.reason


def test_old_ticket_elevates_medium_to_high():
    (m,) = markOutdated(
        ["Devotee costs $10 per month"],
        ticket_date="2024-01-01T00:00:00Z",
        reference_date=REF,
        max_age_days=365,
    )
    assert m.stale_risk == "high"


def test_has_high_risk_claim():
    marked = markOutdated(
        ["Our IP is play.oldexample.net", "Thanks for asking"],
        ticket_date="2026-09-22T11:15:00Z",
        reference_date=REF,
    )
    assert has_high_risk_claim(marked) is True
    assert has_high_risk_claim(marked[1:]) is False


def test_permission_node_is_high_risk():
    (m,) = markOutdated(
        ["You need enthusia.staff.ban to do that"],
        ticket_date="2026-09-22T11:15:00Z",
        reference_date=REF,
    )
    assert m.stale_risk == "high"
