"""Local record-schema contract for ticket-derived training candidates.

The canonical schema is MASTER-SPECIFICATION section 27, embodied by W16's
dataset pipeline (`enthusia_datasets.record`). W16's PR (#3) targets `main`
and is not merged into this branch's base (`w01/contracts-scaffold`), so this
module re-states the section 27 contract locally instead of importing W16's
code (which this workstream must not modify and must not duplicate into its
own PR).

When W16 merges, its `validate_record` is the authority; candidates produced
here are designed to pass it unchanged (see tests/test_schema.py for the
cross-check, which runs when W16's package is importable).
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone

# --- Contract constants (mirror MASTER-SPEC section 27 / W16 record.py) ---
SOURCE_TYPES = ("synthetic", "ticket", "staff", "evaluation")
VISIBILITIES = ("public", "staff", "private", "owner")
QUALITY_LABELS = (
    "IDEAL",
    "GOOD",
    "USABLE_WITH_EDIT",
    "BAD_RESPONSE",
    "OUTDATED",
    "INCOMPLETE",
    "PRIVATE_EXCLUDE",
)
MESSAGE_ROLES = ("user", "assistant", "system", "tool")
REQUIRED_FIELDS = ("id", "source_type", "visibility", "scenario", "messages")


class CandidateValidationError(ValueError):
    """Raised when a ticket-derived candidate fails the section 27 contract."""


def validate_candidate(rec: dict) -> dict:
    """Validate a candidate dict against the section 27 contract.

    Returns a normalized deep copy with defaults applied. Extra ticket-level
    metadata (ticket_id, extracted patterns, governance reference, …) is
    preserved.
    """
    if not isinstance(rec, dict):
        raise CandidateValidationError(
            f"candidate must be an object, got {type(rec).__name__}"
        )
    rid = rec.get("id")
    if not isinstance(rid, str) or not rid.strip():
        raise CandidateValidationError("candidate missing required non-empty 'id'")

    out: dict = copy.deepcopy(rec)

    for field, allowed in (
        ("source_type", SOURCE_TYPES),
        ("visibility", VISIBILITIES),
    ):
        if rec.get(field) not in allowed:
            raise CandidateValidationError(
                f"candidate {rid!r}: {field!r} must be one of {allowed}, "
                f"got {rec.get(field)!r}"
            )

    if not isinstance(rec.get("scenario"), str) or not rec["scenario"].strip():
        raise CandidateValidationError(
            f"candidate {rid!r}: 'scenario' must be a non-empty string"
        )

    messages = rec.get("messages")
    if not isinstance(messages, list) or not messages:
        raise CandidateValidationError(
            f"candidate {rid!r}: 'messages' must be a non-empty list"
        )
    for i, m in enumerate(messages):
        if not isinstance(m, dict):
            raise CandidateValidationError(
                f"candidate {rid!r}: messages[{i}] must be an object"
            )
        if m.get("role") not in MESSAGE_ROLES:
            raise CandidateValidationError(
                f"candidate {rid!r}: messages[{i}].role must be one of "
                f"{MESSAGE_ROLES}"
            )
        if not isinstance(m.get("content"), str):
            raise CandidateValidationError(
                f"candidate {rid!r}: messages[{i}].content must be a string"
            )

    for field in ("tools", "expected_actions", "tags"):
        val = out.get(field, [])
        if not isinstance(val, list) or any(not isinstance(x, str) for x in val):
            raise CandidateValidationError(
                f"candidate {rid!r}: {field!r} must be a list of strings"
            )
        out[field] = val

    if not isinstance(out.get("expected_answer", ""), str):
        raise CandidateValidationError(
            f"candidate {rid!r}: 'expected_answer' must be a string"
        )

    facts = out.get("facts", [])
    if not isinstance(facts, list):
        raise CandidateValidationError(f"candidate {rid!r}: 'facts' must be a list")
    for i, f in enumerate(facts):
        if not isinstance(f, dict):
            raise CandidateValidationError(
                f"candidate {rid!r}: facts[{i}] must be an object"
            )
        for sub in ("claim", "source", "source_version"):
            if not isinstance(f.get(sub), str):
                raise CandidateValidationError(
                    f"candidate {rid!r}: facts[{i}].{sub!r} must be a string"
                )
    out["facts"] = facts

    quality = out.get("quality")
    if quality is not None and quality not in QUALITY_LABELS:
        raise CandidateValidationError(
            f"candidate {rid!r}: 'quality' must be one of {QUALITY_LABELS}, "
            f"got {quality!r}"
        )

    created_at = out.get("created_at")
    if created_at is not None:
        if not isinstance(created_at, str):
            raise CandidateValidationError(
                f"candidate {rid!r}: 'created_at' must be a string"
            )
        try:
            datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise CandidateValidationError(
                f"candidate {rid!r}: 'created_at' must be ISO-8601"
            ) from exc

    return out


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
