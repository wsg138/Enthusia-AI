"""Structured extraction from ticket transcripts.

Stage 1 (extract), 4 (speaker roles), 5 (problem), 6-8 (evidence / staff
actions / outcome) of TRAINING-AND-EVALUATION-SPEC section 4.

Input tickets are dicts in the fixture transcript format:

    {
      "ticket_id": "...", "channel_id": "...", "guild": "Enthusia"|None,
      "category": "support", "created_at": "...", "closed_at": "...",
      "flags": {"dm": False, "deleted": False, "private": False},
      "messages": [
        {"message_id": "...", "author_id": "...", "author_name": "...",
         "role": "player"|"staff"|"bot", "content": "...", "timestamp": "..."},
        ...
      ],
    }

Only fixture data is ever processed (see GOVERNANCE-CHECKPOINT.md).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

SPEAKER_ROLES = ("player", "staff", "bot")

_WS_RE = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """Deterministic transcript normalization: collapse whitespace, strip."""
    return _WS_RE.sub(" ", text).strip()


@dataclass
class TicketMessage:
    message_id: str
    author_id: str
    author_name: str
    role: str  # player | staff | bot
    content: str
    timestamp: str = ""

    def normalized(self) -> "TicketMessage":
        return TicketMessage(
            message_id=self.message_id,
            author_id=self.author_id,
            author_name=self.author_name,
            role=self.role,
            content=normalize_text(self.content),
            timestamp=self.timestamp,
        )


@dataclass
class Ticket:
    ticket_id: str
    channel_id: str = ""
    guild: str | None = None
    category: str = "support"
    created_at: str = ""
    closed_at: str = ""
    flags: dict = field(default_factory=dict)
    messages: list[TicketMessage] = field(default_factory=list)

    def player_messages(self) -> list[TicketMessage]:
        return [m for m in self.messages if m.role == "player"]

    def staff_messages(self) -> list[TicketMessage]:
        return [m for m in self.messages if m.role == "staff"]

    def is_excluded_source(self) -> tuple[bool, str]:
        """Pre-redaction source exclusions (governance checkpoint section 5)."""
        if self.flags.get("dm"):
            return True, "dm_channel"
        if self.flags.get("deleted"):
            return True, "deleted_ticket"
        if self.flags.get("private"):
            return True, "private_channel"
        if self.guild is None:
            return True, "no_guild_dm"
        return False, ""


def parse_ticket(raw: dict) -> Ticket:
    """Parse a raw transcript dict into a Ticket. Raises ValueError on shape errors."""
    if not isinstance(raw, dict):
        raise ValueError(f"ticket must be an object, got {type(raw).__name__}")
    tid = raw.get("ticket_id")
    if not isinstance(tid, str) or not tid.strip():
        raise ValueError("ticket missing required non-empty 'ticket_id'")

    messages: list[TicketMessage] = []
    raw_messages = raw.get("messages", [])
    if not isinstance(raw_messages, list):
        raise ValueError("ticket 'messages' must be a list")
    for i, m in enumerate(raw_messages):
        if not isinstance(m, dict):
            raise ValueError(f"ticket {tid!r}: messages[{i}] must be an object")
        role = m.get("role", "player")
        if role not in SPEAKER_ROLES:
            raise ValueError(
                f"ticket {tid!r}: messages[{i}].role must be one of {SPEAKER_ROLES}"
            )
        messages.append(
            TicketMessage(
                message_id=str(m.get("message_id", f"m{i}")),
                author_id=str(m.get("author_id", "unknown")),
                author_name=str(m.get("author_name", "unknown")),
                role=role,
                content=str(m.get("content", "")),
                timestamp=str(m.get("timestamp", "")),
            ).normalized()
        )

    flags = raw.get("flags", {})
    if not isinstance(flags, dict):
        raise ValueError(f"ticket {tid!r}: 'flags' must be an object")

    return Ticket(
        ticket_id=tid,
        channel_id=str(raw.get("channel_id", "")),
        guild=raw.get("guild"),
        category=str(raw.get("category", "support")),
        created_at=str(raw.get("created_at", "")),
        closed_at=str(raw.get("closed_at", "")),
        flags=flags,
        messages=messages,
    )


# --- Problem identification (stage 5) --------------------------------------

_CATEGORY_RULES: list[tuple[str, re.Pattern]] = [
    ("grief-theft", re.compile(r"\b(grief|griefed|stole|stolen|raided|robbed)\b", re.I)),
    ("lost-items", re.compile(r"\b(lost|disappeared|missing|deleted|despawn)\b.{0,40}\b(item|inventory|stuff|gear|diamond|netherite)\b|\b(item|inventory|stuff|gear)\b.{0,40}\b(lost|disappeared|missing|gone)\b", re.I)),
    ("rank-perks", re.compile(r"\b(rank|donor|devotee|avid|perk|kit)\b", re.I)),
    ("punishment-appeal", re.compile(r"\b(ban|banned|mute|muted|kick|kicked|appeal|unban|unmute|false ban)\b", re.I)),
    ("bug-report", re.compile(r"\b(bug|glitch|broken|doesn'?t work|error|crash)\b", re.I)),
    ("harassment", re.compile(r"\b(harass|bully|threat|dox|toxic|slur)\b", re.I)),
    ("account-link", re.compile(r"\b(link|discord|minecraft account|java|bedrock)\b", re.I)),
    ("question", re.compile(r"\b(how (do|can|to)|what (is|are|does)|where|when does|why)\b", re.I)),
]


def classify_category(text: str) -> str:
    """Keyword-rule problem classification. Returns 'other' when nothing matches."""
    for category, pattern in _CATEGORY_RULES:
        if pattern.search(text):
            return category
    return "other"


def problem_statement(ticket: Ticket, max_messages: int = 3) -> str:
    """The player's opening description: first N player messages joined."""
    parts = [m.content for m in ticket.player_messages()[:max_messages] if m.content]
    return "\n".join(parts)
