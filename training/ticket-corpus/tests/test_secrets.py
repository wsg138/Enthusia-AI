"""Secret handling tests: detection, removal, drop, reject-on-residual."""

from enthusia_ticket_corpus.extract import Ticket, TicketMessage
from enthusia_ticket_corpus.secrets import pattern_names, remove_secrets, scan_ticket


def _ticket(*contents):
    return Ticket(
        ticket_id="fx-s",
        guild="Enthusia",
        messages=[
            TicketMessage(f"m{i}", "1", "P", "player", c)
            for i, c in enumerate(contents)
        ],
    )


def test_pattern_contract_names():
    names = pattern_names()
    for expected in ("openai_key", "github_token", "discord_token", "private_key",
                     "credential_assignment", "aws_access_key"):
        assert expected in names


def test_detects_shaped_key():
    t = _ticket("my key: sk-fixtureFakeKeyForTesting1234567890")
    findings = scan_ticket(t)
    assert any(f.pattern == "openai_key" for f in findings)
    # Excerpts never contain the secret itself.
    assert all("sk-fixtureFakeKeyForTesting1234567890" not in f.excerpt for f in findings)


def test_removal_redacts_value_and_verifies_clean():
    t = _ticket("my api key: sk-fixtureFakeKeyForTesting1234567890 please help")
    cleaned, report = remove_secrets(t)
    assert report["clean"] is True
    assert report["residual"] == 0
    assert scan_ticket(cleaned) == []
    assert "sk-fixtureFakeKeyForTesting1234567890" not in cleaned.messages[0].content
    assert "[SECRET_REMOVED" in cleaned.messages[0].content


def test_private_key_drops_message():
    t = _ticket(
        "here is context",
        "-----BEGIN RSA PRIVATE KEY-----\nfixturedemo\n-----END RSA PRIVATE KEY-----",
        "more context",
    )
    cleaned, report = remove_secrets(t)
    assert report["dropped_messages"] == 1
    assert report["clean"] is True
    assert len(cleaned.messages) == 2
    assert all("PRIVATE KEY" not in m.content for m in cleaned.messages)


def test_clean_ticket_untouched():
    t = _ticket("hello, I need help with my rank")
    cleaned, report = remove_secrets(t)
    assert report["findings"] == 0 and report["clean"] is True
    assert cleaned.messages[0].content == "hello, I need help with my rank"


def test_github_token_shape():
    t = _ticket("token ghp_fixtureFakeTokenForTesting1234")
    findings = scan_ticket(t)
    assert any(f.pattern == "github_token" for f in findings)
