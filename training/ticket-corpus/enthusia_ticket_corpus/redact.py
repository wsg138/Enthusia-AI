"""Redaction: PII removal and pseudonymization for ticket transcripts.

Config-driven via `redaction.yml`. Deterministic: the same corpus + config
always yields the same pseudonyms and placeholders.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .extract import Ticket, TicketMessage


@dataclass
class RedactionRule:
    name: str
    pattern: re.Pattern
    replacement: str


@dataclass
class RedactionConfig:
    pseudonymize_users: bool = True
    redact_emails: bool = True
    redact_ips: bool = True
    redact_phones: bool = True
    strip_url_queries: bool = True
    redact_snowflakes: bool = True
    custom: list[RedactionRule] = field(default_factory=list)

    @staticmethod
    def from_dict(raw: dict) -> "RedactionConfig":
        custom = []
        for entry in raw.get("custom_patterns", []) or []:
            custom.append(
                RedactionRule(
                    name=str(entry.get("name", "custom")),
                    pattern=re.compile(str(entry["regex"])),
                    replacement=str(entry.get("replacement", "[REDACTED]")),
                )
            )
        return RedactionConfig(
            pseudonymize_users=bool(raw.get("pseudonymize_users", True)),
            redact_emails=bool(raw.get("redact_emails", True)),
            redact_ips=bool(raw.get("redact_ips", True)),
            redact_phones=bool(raw.get("redact_phones", True)),
            strip_url_queries=bool(raw.get("strip_url_queries", True)),
            redact_snowflakes=bool(raw.get("redact_snowflakes", True)),
            custom=custom,
        )


_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_IPV6_RE = re.compile(r"\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b")
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)")
_MENTION_RE = re.compile(r"<@!?(\d{5,25})>")
_SNOWFLAKE_RE = re.compile(r"(?<!\d)\d{17,20}(?!\d)")
_URL_QUERY_RE = re.compile(r"(https?://[^\s?#]+)\?[^\s#]*")


def _pseudonym(author_id: str, role: str, index: dict[str, str]) -> str:
    """Deterministic run-scoped pseudonym without retaining an ID-derived hash."""
    if author_id in index:
        return index[author_id]
    prefix = {"player": "PLAYER", "staff": "STAFF", "bot": "BOT"}.get(role, "USER")
    # Ordinal within role, assigned in first-seen order of the sorted corpus.
    n = sum(1 for value in index.values() if value.startswith(prefix + "_")) + 1
    pseudo = f"{prefix}_{n}"
    index[author_id] = pseudo
    return pseudo


class Redactor:
    def __init__(self, config: RedactionConfig):
        self.config = config
        self._pseudonyms: dict[str, str] = {}
        self.redaction_count = 0

    def pseudonym_for(self, author_id: str, role: str) -> str:
        return _pseudonym(author_id, role, self._pseudonyms)

    def redact_text(self, text: str) -> tuple[str, list[str]]:
        """Redact one text. Returns (redacted_text, [rule names applied])."""
        applied: list[str] = []
        cfg = self.config

        def sub(pattern: re.Pattern, repl: str, name: str, s: str) -> str:
            nonlocal_applied = applied
            new, n = pattern.subn(repl, s)
            if n:
                nonlocal_applied.append(name)
                self.redaction_count += n
            return new

        if cfg.redact_emails:
            text = sub(_EMAIL_RE, "[EMAIL]", "email", text)
        if cfg.redact_ips:
            text = sub(_IPV4_RE, "[IP]", "ipv4", text)
            # IPv6 only when it looks like a real address (has hex letters or ::)
            def _v6(m: re.Match) -> str:
                frag = m.group(0)
                return "[IP]" if (":" in frag and ("::" in frag or re.search(r"[a-fA-F]", frag))) else frag
            new = _IPV6_RE.sub(_v6, text)
            if new != text:
                applied.append("ipv6")
            text = new
        if cfg.redact_phones:
            text = sub(_PHONE_RE, "[PHONE]", "phone", text)
        if cfg.redact_snowflakes:
            text = sub(_MENTION_RE, "[USER]", "mention", text)
            text = sub(_SNOWFLAKE_RE, "[USER]", "snowflake", text)
        if cfg.strip_url_queries:
            text = sub(_URL_QUERY_RE, r"\1", "url_query", text)
        for rule in cfg.custom:
            text = sub(rule.pattern, rule.replacement, f"custom:{rule.name}", text)
        return text, applied

    def redact_ticket(self, ticket: Ticket) -> tuple[Ticket, dict]:
        """Redact a whole ticket: pseudonymize authors, redact message content."""
        report = {"ticket_id": ticket.ticket_id, "redactions": 0, "rules": set()}
        before = self.redaction_count
        new_messages = []
        for m in ticket.messages:
            content, applied = self.redact_text(m.content)
            for rule in applied:
                report["rules"].add(rule)
            name = m.author_name
            aid = m.author_id
            if self.config.pseudonymize_users:
                pseudo = self.pseudonym_for(m.author_id, m.role)
                name, aid = pseudo, pseudo
            new_messages.append(
                TicketMessage(
                    message_id=m.message_id,
                    author_id=aid,
                    author_name=name,
                    role=m.role,
                    content=content,
                    timestamp=m.timestamp,
                )
            )
        report["redactions"] = self.redaction_count - before
        report["rules"] = sorted(report["rules"])
        out = Ticket(
            ticket_id=ticket.ticket_id,
            channel_id=ticket.channel_id,
            guild=ticket.guild,
            category=ticket.category,
            created_at=ticket.created_at,
            closed_at=ticket.closed_at,
            flags=dict(ticket.flags),
            messages=new_messages,
        )
        # Reset per-ticket counter delta for the report; keep global cumulative.
        return out, report
