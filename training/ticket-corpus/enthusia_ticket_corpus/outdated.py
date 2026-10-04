"""Outdated-answer marking.

CRITICAL RULE (WORKER-EXECUTION-PLAN section 21):
    Historical ticket facts do NOT outrank current live facts.
    A historical decision can teach process while its old configuration fact
    is stale.

`markOutdated()` flags factual claims extracted from historical tickets that
may be stale, so the training stack can keep historical behavior separate
from current truth.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

# Volatile-fact shapes: claims matching these are *risky* regardless of age.
_VOLATILE_RULES: list[tuple[str, str, re.Pattern]] = [
    (
        "high",
        "ip_or_hostname",
        re.compile(
            r"\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:play|mc|server|hub|smp)\.[a-z0-9.-]+\.[a-z]{2,}\b",
            re.I,
        ),
    ),
    (
        "high",
        "permission_node",
        re.compile(r"\b[a-z0-9_]+(?:\.[a-z0-9_]+){2,}\b"),
    ),
    (
        "high",
        "plugin_version",
        re.compile(r"\bv?\d+\.\d+(?:\.\d+)?(?:-SNAPSHOT)?\b"),
    ),
    (
        "medium",
        "price",
        re.compile(r"\$\s?\d+(?:\.\d{1,2})?|\b\d+\s?(?:USD|dollars)\b", re.I),
    ),
    (
        "medium",
        "temporal_claim",
        re.compile(r"\b(currently|right now|as of (today|now)|at the moment)\b", re.I),
    ),
    (
        "medium",
        "command_syntax",
        re.compile(r"(?m)^\s*/[a-z][a-z0-9_-]*(?:\s+\S+)+"),
    ),
]


@dataclass(frozen=True)
class MarkedClaim:
    claim: str
    stale_risk: str  # low | medium | high
    reason: str


def _parse_date(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def markOutdated(
    claims: list[str],
    *,
    ticket_date: str = "",
    live_facts: dict[str, str] | None = None,
    reference_date: str = "",
    max_age_days: int = 365,
) -> list[MarkedClaim]:
    """Flag factual claims that may be stale.

    Args:
        claims: factual claim strings extracted from a ticket.
        ticket_date: ISO-8601 date the ticket was closed (provenance).
        live_facts: mapping of normalized topic -> current live claim.
            A claim contradicting the live fact for its topic is HIGH risk.
        reference_date: "today" for age computation (defaults to now, UTC).
        max_age_days: claims from tickets older than this get elevated risk.

    Returns one MarkedClaim per input claim, in order.
    """
    live_facts = live_facts or {}
    ref = _parse_date(reference_date) or datetime.now(timezone.utc)
    tdate = _parse_date(ticket_date)
    age_days = (ref - tdate).days if tdate else 0
    aged = age_days > max_age_days

    # Normalize live facts for contradiction checks.
    live_norm = {k.strip().casefold(): v for k, v in live_facts.items()}

    out: list[MarkedClaim] = []
    for claim in claims:
        text = claim.strip()
        folded = text.casefold()

        # 1. Direct contradiction with a live fact -> HIGH, always.
        contradicted = [
            topic
            for topic, live in live_norm.items()
            if topic and topic in folded and live.strip().casefold() not in folded
        ]
        if contradicted:
            out.append(
                MarkedClaim(
                    claim=text,
                    stale_risk="high",
                    reason=(
                        "contradicts live fact for topic(s): "
                        + ", ".join(sorted(contradicted))
                    ),
                )
            )
            continue

        # 2. Volatile shapes -> intrinsic risk.
        hit: tuple[str, str] | None = None
        for risk, name, pattern in _VOLATILE_RULES:
            if pattern.search(text):
                hit = (risk, name)
                break
        if hit:
            risk, name = hit
            reason = f"volatile fact shape: {name}"
            if aged and risk == "medium":
                risk, reason = "high", f"{reason}; ticket is {age_days}d old"
            elif aged:
                reason = f"{reason}; ticket is {age_days}d old"
            out.append(MarkedClaim(claim=text, stale_risk=risk, reason=reason))
            continue

        # 3. Otherwise: age alone elevates to medium, never high.
        if aged:
            out.append(
                MarkedClaim(
                    claim=text,
                    stale_risk="medium",
                    reason=f"ticket is {age_days}d old; claim not re-verified",
                )
            )
        else:
            out.append(
                MarkedClaim(claim=text, stale_risk="low", reason="no staleness signals")
            )
    return out


def has_high_risk_claim(marked: list[MarkedClaim]) -> bool:
    return any(m.stale_risk == "high" for m in marked)
