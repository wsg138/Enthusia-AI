"""Evidence-request and staff-decision pattern extraction.

Two pattern libraries the training stack cares about (spec section 26.2):
  - what evidence staff actually request;
  - what decisions staff actually make and how they phrase them.
"""

from __future__ import annotations

import re

from .extract import TicketMessage

# evidence_type -> patterns matched against staff messages.
EVIDENCE_PATTERNS: dict[str, list[re.Pattern]] = {
    "screenshot": [
        re.compile(r"\b(screenshot|screen ?shot|send (a |me )?(pic|picture|image|photo))\b", re.I),
        re.compile(r"\bF2\b"),
    ],
    "coordinates": [
        re.compile(r"\b(coord|coordinates|location|where (was|is) (this|it)|/tps\b)", re.I),
        re.compile(r"\bx\s*[:=]?\s*-?\d+", re.I),
    ],
    "timestamp": [
        re.compile(r"\b(when|what time|date|how long ago|timestamp)\b", re.I),
    ],
    "item_list": [
        re.compile(r"\b(what items?|list (your|the) (items?|gear|stuff)|item names?)\b", re.I),
    ],
    "logs": [
        re.compile(r"\b(log|console|latest\.log|debug|stack ?trace)\b", re.I),
    ],
    "video": [
        re.compile(r"\b(video|clip|recording|record it)\b", re.I),
    ],
    "account_name": [
        re.compile(r"\b(ign|username|minecraft name|account name|who (is|was) (it|the player))\b", re.I),
    ],
    "transaction": [
        re.compile(r"\b(transaction|payment|receipt|order ?id|tebex)\b", re.I),
    ],
    "repro_steps": [
        re.compile(r"\b(steps to reproduce|how to reproduce|what were you doing|reproduce)\b", re.I),
    ],
}

# decision -> patterns matched against staff messages.
DECISION_PATTERNS: dict[str, list[re.Pattern]] = {
    "warn": [re.compile(r"\bwarn(ed|ing)?\b", re.I)],
    "mute": [re.compile(r"\bmut(e|ed|ing)\b", re.I)],
    "ban": [re.compile(r"\bban(ned|ning)?\b", re.I)],
    "unban": [re.compile(r"\bunban(ned|ning)?\b", re.I)],
    "unmute": [re.compile(r"\bunmut(e|ed|ing)\b", re.I)],
    "kick": [re.compile(r"\bkick(ed|ing)?\b", re.I)],
    "refund": [re.compile(r"\brefund(ed|ing)?\b", re.I)],
    "compensate": [re.compile(r"\bcompensat\w*\b", re.I)],
    "teleport": [re.compile(r"\bteleport(ed|ing)?\b", re.I)],
    "escalate": [re.compile(r"\bescalat\w*\b|\b(pass\w* (this |it )?(up|to (an? )?(admin|mod)))\b", re.I)],
    "deny": [re.compile(r"\bden(y|ied|ying)\b|\bappeal (denied|rejected)\b", re.I)],
    "close": [re.compile(r"\bclos(e|ed|ing) (this |the )?ticket\b", re.I)],
}

_DURATION_RE = re.compile(
    r"\b(\d+\s*(?:second|minute|hour|day|week|month|year)s?|permanent(?:ly)?)\b", re.I
)


def _excerpt(text: str, match: re.Match, radius: int = 40) -> str:
    start = max(0, match.start() - radius)
    end = min(len(text), match.end() + radius)
    return " ".join(text[start:end].split())


def extract_evidence_requests(messages: list[TicketMessage]) -> list[dict]:
    """Evidence staff asked for: [{evidence_type, message_id, excerpt}]."""
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for m in messages:
        if m.role != "staff":
            continue
        for etype, patterns in EVIDENCE_PATTERNS.items():
            for pattern in patterns:
                match = pattern.search(m.content)
                if match and (etype, m.message_id) not in seen:
                    seen.add((etype, m.message_id))
                    out.append(
                        {
                            "evidence_type": etype,
                            "message_id": m.message_id,
                            "excerpt": _excerpt(m.content, match),
                        }
                    )
    out.sort(key=lambda d: (d["message_id"], d["evidence_type"]))
    return out


def extract_staff_decisions(messages: list[TicketMessage]) -> list[dict]:
    """Staff decisions: [{decision, message_id, duration, excerpt}]."""
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for m in messages:
        if m.role != "staff":
            continue
        for decision, patterns in DECISION_PATTERNS.items():
            for pattern in patterns:
                match = pattern.search(m.content)
                if match and (decision, m.message_id) not in seen:
                    seen.add((decision, m.message_id))
                    dur = _DURATION_RE.search(m.content)
                    out.append(
                        {
                            "decision": decision,
                            "message_id": m.message_id,
                            "duration": dur.group(0) if dur else "",
                            "excerpt": _excerpt(m.content, match),
                        }
                    )
    out.sort(key=lambda d: (d["message_id"], d["decision"]))
    return out
