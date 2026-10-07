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
_LOW_SIGNAL_STAFF_RE = re.compile(
    r"^(?:given|done|fixed|resolved|closed|ok(?:ay)?|k|yes|yeah|yep|no|nope|"
    r"thanks?|thank you|np|h+m+|ah that explains it|try (?:now|again))?[!. ]*$",
    re.I,
)
_META_OR_DEFERRAL_RE = re.compile(
    r"\b(?:did you mean to leave (?:the |this )?ticket open|"
    r"someone will get to (?:this|it)|"
    r"i(?:'|’)m off for (?:the )?night|"
    r"wait for (?:the )?(?:owner|admin|staff|big dogs?)|"
    r"we are just the goons|"
    r"i(?:'|’)ll (?:look|check|get to) (?:this|it)|"
    r"we(?:'|’)ll (?:look|check|get to) (?:this|it)|"
    r"i can give you this in \d+ (?:minute|minutes|hour|hours))\b",
    re.I,
)
_UNSAFE_ENCOURAGEMENT_RE = re.compile(
    r"(?<!don(?:'|’)t )(?<!do not )\b(?:nah\s+)?(?:go ahead(?: and)?\s+|feel free to\s+)?(?:abuse|exploit)\s+(?:it|this|that)\b",
    re.I,
)
_CURRENT_STATE_RE = re.compile(
    r"\b(?:known bug|being worked on|working on (?:it|this)|"
    r"aware of (?:it|this)|fix (?:it|this) later|fix this next time|"
    r"next time i(?:'|’)m on|when i(?:'|’)m home|will be fixed|"
    r"we are fixing|i can fix this later)\b",
    re.I,
)
_PUNISHMENT_CONTEXT_RE = re.compile(
    r"\b(?:ban(?:ned|ning)?|mute(?:d|ing)?|unban(?:ned|ning)?|"
    r"unmute(?:d|ing)?|appeal|punishment|ban evasion|warn(?:ed|ing)?)\b",
    re.I,
)


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


def _meaningful_staff_messages(ctx: TicketContext) -> list[str]:
    return [
        m.content.strip()
        for m in ctx.ticket.staff_messages()
        if m.content.strip() and not _LOW_SIGNAL_STAFF_RE.fullmatch(m.content.strip())
    ]


def _staff_is_only_meta_or_deferral(ctx: TicketContext) -> bool:
    meaningful = _meaningful_staff_messages(ctx)
    return bool(meaningful) and all(_META_OR_DEFERRAL_RE.search(text) for text in meaningful)


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
    meaningful_staff = _meaningful_staff_messages(ctx)
    if not meaningful_staff:
        return QualityLabel("INCOMPLETE", ("low_signal_staff_response",))
    meaningful_staff_text = " ".join(meaningful_staff)
    if (
        len(meaningful_staff_text) < 12
        and not ctx.staff_decisions
        and not ctx.evidence_requests
    ):
        return QualityLabel("INCOMPLETE", ("staff_response_too_thin",))
    if _staff_is_only_meta_or_deferral(ctx):
        return QualityLabel("INCOMPLETE", ("staff_only_deferred_or_managed_ticket",))

    # 3. Bad staff response: abusive/dismissive/unsafe, or wrong-info markers.
    staff_text = _staff_text(ctx)
    if _PROFANITY_RE.search(staff_text):
        reasons.append("staff_profanity")
        return QualityLabel("BAD_RESPONSE", tuple(reasons))
    if _DISMISSIVE_RE.search(staff_text):
        reasons.append("staff_dismissive")
        return QualityLabel("BAD_RESPONSE", tuple(reasons))
    if _UNSAFE_ENCOURAGEMENT_RE.search(staff_text):
        reasons.append("staff_encourages_abuse_or_exploit")
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
    if ctx.category == "punishment-appeal" or _PUNISHMENT_CONTEXT_RE.search(text):
        reasons.append("human_decision_like_content")
    if len(ctx.ticket.messages) > 80:
        reasons.append("long_conversation_to_trim")
    if ctx.staff_decisions:
        reasons.append("staff_action_claim_requires_context")
    if any(m.stale_risk == "medium" for m in ctx.marked_claims):
        reasons.append("volatile_claim_requires_verification")
    if _CURRENT_STATE_RE.search(staff_text):
        reasons.append("current_state_claim_requires_verification")
    if len(meaningful_staff_text) < 40:
        reasons.append("thin_staff_response")
    if reasons:
        return QualityLabel("USABLE_WITH_EDIT", tuple(reasons))

    # 6. Good: substantive, clean, and reusable without action/fact rewriting.
    return QualityLabel("GOOD", ("clean_conversation",))
