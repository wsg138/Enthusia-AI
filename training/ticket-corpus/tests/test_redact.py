"""Redaction tests: PII rules, pseudonym determinism, custom patterns."""

from enthusia_ticket_corpus.extract import Ticket, TicketMessage
from enthusia_ticket_corpus.redact import RedactionConfig, Redactor


def _ticket():
    return Ticket(
        ticket_id="fx-r",
        guild="Enthusia",
        messages=[
            TicketMessage("m1", "111", "SomePlayer", "player",
                          "mail me at player@example.com or <@222>"),
            TicketMessage("m2", "222", "SomeStaff", "staff",
                          "your ip 192.0.2.10, call 555-123-4567, see https://x.example/p?t=abc&id=1"),
        ],
    )


def test_pii_rules():
    r = Redactor(RedactionConfig())
    text, applied = r.redact_text(
        "mail me at player@example.com or <@123456789012345679>, "
        "id 123456789012345678, ip 192.0.2.10"
    )
    assert "[EMAIL]" in text and "player@example.com" not in text
    assert "[USER]" in text and "123456789012345678" not in text
    assert "[IP]" in text and "192.0.2.10" not in text
    assert "email" in applied and "mention" in applied


def test_phone_and_url_query():
    r = Redactor(RedactionConfig())
    text, _ = r.redact_text("call 555-123-4567, see https://x.example/p?t=abc")
    assert "[PHONE]" in text and "555-123-4567" not in text
    assert text.endswith("https://x.example/p")


def test_pseudonym_determinism():
    cfg = RedactionConfig()
    t1, _ = Redactor(cfg).redact_ticket(_ticket())
    t2, _ = Redactor(cfg).redact_ticket(_ticket())
    assert t1.messages[0].author_name == t2.messages[0].author_name
    assert t1.messages[0].author_name == "PLAYER_1"
    assert t1.messages[1].author_name == "STAFF_1"
    # Real identifiers are gone.
    assert "SomePlayer" not in t1.messages[0].author_name
    assert "111" not in t1.messages[0].author_id


def test_custom_pattern():
    cfg = RedactionConfig.from_dict(
        {
            "custom_patterns": [
                {
                    "name": "uuid",
                    "regex": r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
                    "replacement": "[UUID]",
                }
            ]
        }
    )
    r = Redactor(cfg)
    text, applied = r.redact_text("uuid 12345678-1234-1234-1234-1234567890ab here")
    assert "[UUID]" in text
    assert "custom:uuid" in applied


def test_pseudonymization_can_be_disabled():
    cfg = RedactionConfig(pseudonymize_users=False)
    t, _ = Redactor(cfg).redact_ticket(_ticket())
    assert t.messages[0].author_name == "SomePlayer"
