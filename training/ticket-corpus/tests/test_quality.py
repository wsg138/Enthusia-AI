"""Quality-labeling tests: precedence chain and IDEAL never auto-assigned."""

from enthusia_ticket_corpus.extract import Ticket, TicketMessage
from enthusia_ticket_corpus.outdated import MarkedClaim
from enthusia_ticket_corpus.quality import TicketContext, label_quality


def _ctx(player_texts, staff_texts, **kw):
    msgs = [
        TicketMessage(f"p{i}", "1", "P", "player", c) for i, c in enumerate(player_texts)
    ] + [
        TicketMessage(f"s{i}", "2", "S", "staff", c) for i, c in enumerate(staff_texts)
    ]
    ticket = Ticket(ticket_id="fx-q", guild="Enthusia", messages=msgs)
    base = dict(
        ticket=ticket,
        category="question",
        problem="\n".join(player_texts),
        secret_report={"clean": True},
    )
    base.update(kw)
    return TicketContext(**base)


def test_private_excluded_source():
    ctx = _ctx(["hi"], ["hello"], source_excluded=True, source_exclusion_reason="dm_channel")
    label = label_quality(ctx)
    assert label.label == "PRIVATE_EXCLUDE"


def test_secret_residual_excluded():
    ctx = _ctx(["hi"], ["hello"], secret_report={"clean": False})
    assert label_quality(ctx).label == "PRIVATE_EXCLUDE"


def test_no_staff_is_incomplete():
    assert label_quality(_ctx(["how do I claim land?"], [])).label == "INCOMPLETE"


def test_dismissive_staff_is_bad():
    label = label_quality(_ctx(["help"], ["not my problem, figure it out yourself"]))
    assert label.label == "BAD_RESPONSE"
    assert "staff_dismissive" in label.reasons


def test_profanity_is_bad():
    label = label_quality(_ctx(["help"], ["oh shit, let me check"]))
    assert label.label == "BAD_RESPONSE"


def test_low_signal_staff_reply_is_incomplete():
    label = label_quality(_ctx(["Can I have the missing tag?"], ["Given!"]))
    assert label.label == "INCOMPLETE"
    assert "low_signal_staff_response" in label.reasons


def test_ticket_management_only_reply_is_incomplete():
    label = label_quality(
        _ctx(
            ["The bug is still happening."],
            ["Did you mean to leave the ticket open?"],
        )
    )
    assert label.label == "INCOMPLETE"
    assert "staff_only_deferred_or_managed_ticket" in label.reasons


def test_staff_deferral_only_is_incomplete():
    label = label_quality(
        _ctx(
            ["Can someone help with this?"],
            ["I'm off for the night; someone will get to this."],
        )
    )
    assert label.label == "INCOMPLETE"


def test_encouraging_bug_abuse_is_bad_response():
    label = label_quality(_ctx(["Can I keep doing this bug?"], ["nah abuse it"]))
    assert label.label == "BAD_RESPONSE"
    assert "staff_encourages_abuse_or_exploit" in label.reasons


def test_do_not_abuse_is_not_false_positive():
    label = label_quality(
        _ctx(
            ["Can I keep doing this bug?"],
            ["Do not abuse it. Please stop and send us the reproduction steps."],
        )
    )
    assert label.label != "BAD_RESPONSE"


def test_punishment_like_support_ticket_needs_manual_edit():
    label = label_quality(
        _ctx(
            ["Why did my ban become permanent?"],
            ["Using an alternate account while banned is ban evasion."],
            category="punishment-appeal",
        )
    )
    assert label.label == "USABLE_WITH_EDIT"
    assert "human_decision_like_content" in label.reasons


def test_high_stale_claim_is_outdated():
    ctx = _ctx(
        ["what is the ip"],
        ["Our current IP is play.oldexample.net"],
        marked_claims=[MarkedClaim("Our current IP is play.oldexample.net", "high", "ip")],
    )
    assert label_quality(ctx).label == "OUTDATED"


def test_chatter_needs_edit():
    label = label_quality(_ctx(["lol ok thanks"], ["You are welcome. Resolved."]))
    assert label.label == "USABLE_WITH_EDIT"
    assert "chatter_to_trim" in label.reasons


def test_missing_evidence_needs_edit():
    ctx = _ctx(
        ["I lost my diamond gear to a bug"],
        ["We will look into it."],
        category="lost-items",
        evidence_requests=[],
    )
    label = label_quality(ctx)
    assert label.label == "USABLE_WITH_EDIT"
    assert "missing_evidence_request" in label.reasons


def test_clean_ticket_is_good():
    ctx = _ctx(
        ["I lost my netherite gear"],
        ["Can you send a screenshot?", "Refunded. Closing this ticket."],
        category="lost-items",
        evidence_requests=[{"evidence_type": "screenshot"}],
        staff_decisions=[{"decision": "refund"}],
    )
    label = label_quality(ctx)
    assert label.label == "GOOD"


def test_ideal_never_auto_assigned():
    # Battery of representative contexts: none may come back IDEAL.
    contexts = [
        _ctx(["hi"], ["hello, resolved"]),
        _ctx(["lol"], ["done"], category="lost-items",
             evidence_requests=[{"evidence_type": "screenshot"}]),
        _ctx(["q"], ["a" * 50]),
    ]
    for ctx in contexts:
        assert label_quality(ctx).label != "IDEAL"
