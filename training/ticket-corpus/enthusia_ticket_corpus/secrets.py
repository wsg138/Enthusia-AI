"""Secret detection and removal for ticket transcripts.

Shape-based patterns (matching the W16 secret-scan contract: patterns match
the *shape* of secrets, never real values).

Policy:
  1. scan every message for credential shapes;
  2. remove: redact the matched secret value as [SECRET_REMOVED:<pattern>];
     private-key blocks cause the whole message to be dropped;
  3. verify: re-scan; any residual credential shape -> ticket REJECTED
     (never enters training; reported as exclusion only).

Secrets are never redacted-and-kept as training content.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .extract import Ticket, TicketMessage

_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b")),
    ("github_token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b")),
    ("github_fine_grained_pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    (
        "aws_secret_key",
        re.compile(r"(?i)\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*\S+"),
    ),
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("stripe_live_key", re.compile(r"\b[rs]k_live_[A-Za-z0-9]{16,}\b")),
    ("discord_token", re.compile(r"\b[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b")),
    ("bearer_token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{16,}={0,2}\b")),
    (
        "credential_assignment",
        re.compile(
            r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|client[_-]?secret)\b"
            r"\s*[:=]\s*(\S{6,})"
        ),
    ),
    (
        "quoted_credential",
        re.compile(
            r"(?i)[\"'](?:token|api[_-]?key|secret|password)[\"']\s*[:=]\s*[\"']"
            r"(?=[\"'][^\"']*[A-Za-z])(?=[\"'][^\"']*[0-9])[^\"']{16,}[\"']"
        ),
    ),
]

# Patterns whose match cannot be safely redacted in place: the whole message
# is dropped instead (multi-line key material).
_DROP_MESSAGE_PATTERNS = {"private_key"}


@dataclass(frozen=True)
class SecretFinding:
    pattern: str
    message_id: str
    # Redacted excerpt: the matched secret itself is never included.
    excerpt: str


def pattern_names() -> list[str]:
    return [name for name, _ in _PATTERNS]


def _excerpt(text: str, match: re.Match, radius: int = 24) -> str:
    start = max(0, match.start() - radius)
    end = min(len(text), match.end() + radius)
    snippet = text[start:end].replace(match.group(0), "***REDACTED***")
    return " ".join(snippet.split())


def scan_ticket(ticket: Ticket) -> list[SecretFinding]:
    """All secret findings in a ticket. Empty list means clean."""
    findings: list[SecretFinding] = []
    for m in ticket.messages:
        for name, pattern in _PATTERNS:
            for match in pattern.finditer(m.content):
                findings.append(
                    SecretFinding(
                        pattern=name,
                        message_id=m.message_id,
                        excerpt=_excerpt(m.content, match),
                    )
                )
    findings.sort(key=lambda f: (f.message_id, f.pattern, f.excerpt))
    return findings


def remove_secrets(ticket: Ticket) -> tuple[Ticket, dict]:
    """Scan -> redact values (or drop messages) -> verify.

    Returns (cleaned_ticket, report). report["clean"] is False when a
    residual credential shape remains; the caller must REJECT the ticket.
    """
    findings = scan_ticket(ticket)
    dropped_ids = {
        f.message_id for f in findings if f.pattern in _DROP_MESSAGE_PATTERNS
    }

    new_messages: list[TicketMessage] = []
    removed = 0
    for m in ticket.messages:
        if m.message_id in dropped_ids:
            removed += 1
            continue
        content = m.content
        for name, pattern in _PATTERNS:
            if name in _DROP_MESSAGE_PATTERNS:
                continue
            content, n = pattern.subn(f"[SECRET_REMOVED:{name}]", content)
            removed += n
        new_messages.append(
            TicketMessage(
                message_id=m.message_id,
                author_id=m.author_id,
                author_name=m.author_name,
                role=m.role,
                content=content,
                timestamp=m.timestamp,
            )
        )

    cleaned = Ticket(
        ticket_id=ticket.ticket_id,
        channel_id=ticket.channel_id,
        guild=ticket.guild,
        category=ticket.category,
        created_at=ticket.created_at,
        closed_at=ticket.closed_at,
        flags=dict(ticket.flags),
        messages=new_messages,
    )
    residual = scan_ticket(cleaned)
    report = {
        "ticket_id": ticket.ticket_id,
        "findings": len(findings),
        "removed": removed,
        "dropped_messages": len(dropped_ids),
        "residual": len(residual),
        "clean": not residual,
        "patterns": sorted({f.pattern for f in findings}),
    }
    return cleaned, report
