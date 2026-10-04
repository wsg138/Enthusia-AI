"""Quality labeling for ticket-derived training candidates.

Labels (TRAINING-AND-EVALUATION-SPEC section 4):
    IDEAL | GOOD | USABLE_WITH_EDIT | BAD_RESPONSE | OUTDATED |
    INCOMPLETE | PRIVATE_EXCLUDE

Precedence (first match wins):
    PRIVATE_EXCLUDE > INCOMPLETE > BAD_RESPONSE > OUTDATED >
    USABLE_WITH_EDIT > GOOD

IDEAL is never auto-assigned: it requires human curation. The auto-labeler
caps at GOOD.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .extract import Ticket
from .outdated import MarkedClaim

_DISMISSIVE_RE = re.compile(
    r"\b(not my problem|figure it out yourself|stop (bother|asking)|"
    r"don'?t care|skill issue|cope)\b",
    re.I,
)
_PROFANITY_RE = re.compile(
    r"\b(fuck|shit|bitch|asshole|dickhead)\b", re.I
)
_CHATTER_RE = re.compile(r"\b(lol|lmao|xd|brb|omw)\b", re.I)


@dataclass
class TicketContext:
    ticket: Ticket
    category: str
    problem: str
    marked_claims: list[MarkedClaim] = field(default_factory=list)
    secret_report: dict = field(default_factory=dict)
    source_excluded: bool = False
    source_exclusion_reason: str = ""
    evidence_requests: list[dict] = field(default_factory=list)
    staff_decisions: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class QualityLabel:
    label: str
    reasons: tuple[str, ...]


def _staff_text(ctx: TicketContext) -> str:
    return "\n".join(m.content for m in ctx.ticket.staff_messages())


def _all_text(ctx: TicketContext) -> str:
    return "\n".join(m.content for m in ctx.ticket.messages)


def label_quality(ctx: TicketContext) -> QualityLabel:
    """Assign a quality label to a processed ticket. Deterministic."""
    reasons: list[str] = []

    # 1. Privacy exclusions.
    if ctx.source_excluded:
        return QualityLabel(
            "PRIVATE_EXCLUDE", (f"source_excluded:{ctx.source_exclusion_reason}",)
        )
    if ctx.secret_report.get("clean") is False:
        return QualityLabel("PRIVATE_EXCLUDE", ("secret_residual",))

    staff = ctx.ticket.staff_messages()
    player = ctx.ticket.player_messages()

    # 2. Incomplete: no staff engagement or no substantive content.
    if not staff:
        return QualityLabel("INCOMPLETE", ("no_staff_response",))
    if not player or not ctx.problem.strip():
        return QualityLabel("INCOMPLETE", ("no_problem_statement",))
    if len(ctx.ticket.messages) < 2:
        return QualityLabel("INCOMPLETE", ("single_message",))

    # 3. Bad staff response: abusive/dismissive, or wrong-info markers.
    staff_text = _staff_text(ctx)
    if _PROFANITY_RE.search(staff_text):
        reasons.append("staff_profanity")
        return QualityLabel("BAD_RESPONSE", tuple(reasons))
    if _DISMISSIVE_RE.search(staff_text):
        reasons.append("staff_dismissive")
        return QualityLabel("BAD_RESPONSE", tuple(reasons))

    # 4. Outdated: a high-risk stale claim in the staff answer.
    if any(m.stale_risk == "high" for m in ctx.marked_claims):
        reasons.append("high_stale_risk_claim")
        return QualityLabel("OUTDATED", tuple(reasons))

    # 5. Usable with edit: chatter to trim, redactions present, or thin evidence.
    text = _all_text(ctx)
    if _CHATTER_RE.search(text):
        reasons.append("chatter_to_trim")
    if "[EMAIL]" in text or "[IP]" in text or "[PHONE]" in text:
        reasons.append("contains_redactions")
    if "[SECRET_REMOVED" in text:
        reasons.append("secret_redacted")
    if ctx.category in ("lost-items", "grief-theft", "bug-report") and not ctx.evidence_requests:
        reasons.append("missing_evidence_request")
    if reasons:
        return QualityLabel("USABLE_WITH_EDIT", tuple(reasons))

    # 6. Good: resolved-looking, clean, evidence gathered where expected.
    if ctx.staff_decisions or "resolved" in staff_text.casefold():
        reasons.append("staff_decision_present")
    else:
        reasons.append("clean_conversation")
    return QualityLabel("GOOD", tuple(reasons))
