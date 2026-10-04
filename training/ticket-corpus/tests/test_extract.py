"""Extraction tests: parsing, speaker roles, problem classification."""

import pytest

from enthusia_ticket_corpus.extract import (
    classify_category,
    parse_ticket,
    problem_statement,
)


def _raw(**overrides):
    base = {
        "ticket_id": "fx-t",
        "channel_id": "CH-1",
        "guild": "Enthusia",
        "category": "support",
        "created_at": "2026-09-20T14:00:00Z",
        "closed_at": "2026-09-20T15:00:00Z",
        "flags": {},
        "messages": [
            {
                "message_id": "m1",
                "author_id": "1",
                "author_name": "P",
                "role": "player",
                "content": "  I lost my stuff   ",
                "timestamp": "",
            },
            {
                "message_id": "m2",
                "author_id": "2",
                "author_name": "S",
                "role": "staff",
                "content": "ok",
                "timestamp": "",
            },
        ],
    }
    base.update(overrides)
    return base


def test_parse_ok_and_normalizes():
    t = parse_ticket(_raw())
    assert t.ticket_id == "fx-t"
    assert t.messages[0].content == "I lost my stuff"
    assert [m.role for m in t.messages] == ["player", "staff"]


def test_parse_rejects_bad_role():
    raw = _raw()
    raw["messages"][0]["role"] = "admin"
    with pytest.raises(ValueError):
        parse_ticket(raw)


def test_parse_requires_ticket_id():
    with pytest.raises(ValueError):
        parse_ticket(_raw(ticket_id=""))


def test_source_exclusions():
    assert parse_ticket(_raw(flags={"dm": True})).is_excluded_source() == (True, "dm_channel")
    assert parse_ticket(_raw(flags={"deleted": True})).is_excluded_source() == (True, "deleted_ticket")
    assert parse_ticket(_raw(guild=None)).is_excluded_source() == (True, "no_guild_dm")
    assert parse_ticket(_raw()).is_excluded_source() == (False, "")


def test_problem_statement_first_player_messages():
    t = parse_ticket(_raw())
    assert problem_statement(t) == "I lost my stuff"


def test_classify_category():
    assert classify_category("someone griefed my house") == "grief-theft"
    assert classify_category("I lost my diamond gear to a bug") == "lost-items"
    assert classify_category("how do I appeal my ban") == "punishment-appeal"
    assert classify_category("the shop is broken, bug report") == "bug-report"
    assert classify_category("what is the server ip") == "question"
    assert classify_category("hello there friend") == "other"
