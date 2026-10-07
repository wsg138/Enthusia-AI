"""Pre-redaction exclusion for severe real-world PII in ticket history.

The historical corpus should not retain doxxing-grade material merely because
individual fields could be redacted. These checks intentionally target explicit,
high-confidence shapes and labels; ordinary usernames, server addresses, and
Minecraft coordinates are left to the normal redaction/quality pipeline.
"""

from __future__ import annotations

import re

from .extract import Ticket

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "social_security_number",
        re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"),
    ),
    (
        "explicit_home_address",
        re.compile(
            r"\b(?:home|residential|physical)\s+address\s*"
            r"(?:is\s+|[:=]\s*)\S+",
            re.I,
        ),
    ),
    (
        "street_address",
        re.compile(
            r"\b\d{1,6}\s+(?:[A-Za-z0-9.'#-]+\s+){1,6}"
            r"(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|"
            r"drive|dr|court|ct|circle|cir|highway|hwy|parkway|pkwy)\b",
            re.I,
        ),
    ),
    (
        "date_of_birth",
        re.compile(
            r"\b(?:date\s+of\s+birth|dob|born\s+on)\s*"
            r"(?:is\s+|[:=]\s*)?"
            r"(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|"
            r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|"
            r"jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|"
            r"nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b",
            re.I,
        ),
    ),
    (
        "full_legal_name",
        re.compile(
            r"\b(?:full\s+legal\s+name|legal\s+name|real\s+name)\s*"
            r"(?:is\s+|[:=]\s*)"
            r"[A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3}\b"
        ),
    ),
)


def severe_pii_exclusion_reason(ticket: Ticket) -> str | None:
    """Return a content-free exclusion reason for high-confidence severe PII."""
    for message in ticket.messages:
        for name, pattern in _PATTERNS:
            if pattern.search(message.content):
                return name
    return None
