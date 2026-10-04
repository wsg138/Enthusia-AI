"""Dataset record schema per MASTER-SPECIFICATION section 27.

Recommended normalized record:

    {
      "id": "...",
      "source_type": "synthetic|ticket|staff|evaluation",
      "visibility": "public|staff|...",
      "scenario": "...",
      "messages": [...],
      "tools": [...],
      "expected_actions": [...],
      "expected_answer": "...",
      "facts": [{"claim": "...", "source": "...", "source_version": "..."}],
      "tags": [...],
      "quality": "...",
      "created_at": "...",
      "dataset_version": "..."
    }
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone

SOURCE_TYPES = ("synthetic", "ticket", "staff", "evaluation")
VISIBILITIES = ("public", "staff", "private", "owner")

# Candidate labels from TRAINING-AND-EVALUATION-SPEC section 4.
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


class RecordValidationError(ValueError):
    """Raised when a dataset record fails schema validation."""


def _require_str(rec: dict, field: str, rid: str) -> str:
    val = rec.get(field)
    if not isinstance(val, str) or not val.strip():
        raise RecordValidationError(
            f"record {rid!r}: field {field!r} must be a non-empty string"
        )
    return val


def _require_enum(rec: dict, field: str, allowed: tuple, rid: str) -> str:
    val = rec.get(field)
    if val not in allowed:
        raise RecordValidationError(
            f"record {rid!r}: field {field!r} must be one of {allowed}, got {val!r}"
        )
    return val


def validate_record(rec: dict) -> dict:
    """Validate a raw record dict against the section 27 schema.

    Returns a normalized deep copy with defaults applied. Extra unknown
    top-level fields (e.g. thread_id, template_id, generator) are preserved
    for dedupe/versioning metadata.
    """
    if not isinstance(rec, dict):
        raise RecordValidationError(f"record must be an object, got {type(rec).__name__}")

    rid = rec.get("id")
    if not isinstance(rid, str) or not rid.strip():
        raise RecordValidationError("record missing required non-empty string field 'id'")

    out: dict = copy.deepcopy(rec)

    _require_enum(rec, "source_type", SOURCE_TYPES, rid)
    _require_enum(rec, "visibility", VISIBILITIES, rid)
    _require_str(rec, "scenario", rid)

    # messages: list of {role, content}
    messages = rec.get("messages")
    if not isinstance(messages, list) or not messages:
        raise RecordValidationError(f"record {rid!r}: 'messages' must be a non-empty list")
    for i, m in enumerate(messages):
        if not isinstance(m, dict):
            raise RecordValidationError(f"record {rid!r}: messages[{i}] must be an object")
        if m.get("role") not in MESSAGE_ROLES:
            raise RecordValidationError(
                f"record {rid!r}: messages[{i}].role must be one of {MESSAGE_ROLES}"
            )
        if not isinstance(m.get("content"), str):
            raise RecordValidationError(
                f"record {rid!r}: messages[{i}].content must be a string"
            )

    # optional list fields with defaults
    for field in ("tools", "expected_actions", "tags"):
        val = out.get(field, [])
        if not isinstance(val, list) or any(not isinstance(x, str) for x in val):
            raise RecordValidationError(
                f"record {rid!r}: field {field!r} must be a list of strings"
            )
        out[field] = val

    # expected_answer: string, may be empty only if expected_actions covers it
    answer = out.get("expected_answer", "")
    if not isinstance(answer, str):
        raise RecordValidationError(f"record {rid!r}: 'expected_answer' must be a string")
    out["expected_answer"] = answer

    # facts: list of {claim, source, source_version}
    facts = out.get("facts", [])
    if not isinstance(facts, list):
        raise RecordValidationError(f"record {rid!r}: 'facts' must be a list")
    for i, f in enumerate(facts):
        if not isinstance(f, dict):
            raise RecordValidationError(f"record {rid!r}: facts[{i}] must be an object")
        for sub in ("claim", "source", "source_version"):
            if not isinstance(f.get(sub), str):
                raise RecordValidationError(
                    f"record {rid!r}: facts[{i}].{sub!r} must be a string"
                )
    out["facts"] = facts

    # quality: curated label or None (auto-assessed later)
    quality = out.get("quality")
    if quality is not None and quality not in QUALITY_LABELS:
        raise RecordValidationError(
            f"record {rid!r}: 'quality' must be one of {QUALITY_LABELS}, got {quality!r}"
        )

    # created_at: ISO-8601 string if present
    created_at = out.get("created_at")
    if created_at is not None:
        if not isinstance(created_at, str):
            raise RecordValidationError(f"record {rid!r}: 'created_at' must be a string")
        try:
            datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise RecordValidationError(
                f"record {rid!r}: 'created_at' must be ISO-8601, got {created_at!r}"
            ) from exc

    # dataset_version: filled by the pipeline; must be str if present
    dv = out.get("dataset_version")
    if dv is not None and not isinstance(dv, str):
        raise RecordValidationError(f"record {rid!r}: 'dataset_version' must be a string")

    # thread_id / template_id / generator: opaque strings when present
    for field in ("thread_id", "template_id", "generator"):
        val = out.get(field)
        if val is not None and not isinstance(val, str):
            raise RecordValidationError(f"record {rid!r}: {field!r} must be a string")

    return out


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
