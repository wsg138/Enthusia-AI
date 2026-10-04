"""Deterministic normalization for dataset records.

All normalization is pure and deterministic: the same input record always
produces the same normalized output, independent of dict ordering, locale,
or Python hash randomization.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata

# Strip ASCII punctuation + common unicode punctuation explicitly,
# using only the stdlib so canonicalization has no extra dependencies.
_UNICODE_PUNCT = (
    "\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00ab\u00bb\u00bf\u00a1"
    "\u3001\u3002\u300c\u300d\uff01\uff1f\uff0c\uff1b\uff1a"
)
_STRIP_TABLE = str.maketrans("", "", ".,!?;:'\"()[]{}<>/-_=+*#$%^&~`|\\@" + _UNICODE_PUNCT)
_WS_RE = re.compile(r"\s+")


def _fold(text: str) -> str:
    """Unicode-fold text for canonical comparison."""
    text = unicodedata.normalize("NFKC", text)
    text = text.casefold()
    text = text.translate(_STRIP_TABLE)
    text = _WS_RE.sub(" ", text).strip()
    return text


def canonical_text(rec: dict) -> str:
    """Canonical comparison text for a record.

    Scenario plus the human-visible conversation content. Tool-result payloads
    are included (they carry scenario-relevant facts); internal reasoning
    fields are not (records must not contain hidden reasoning anyway).
    """
    parts = [str(rec.get("scenario", ""))]
    for m in rec.get("messages", []):
        if isinstance(m, dict):
            parts.append(str(m.get("content", "")))
    parts.append(str(rec.get("expected_answer", "")))
    return _fold("\n".join(parts))


def canonical_hash(rec: dict) -> str:
    """SHA-256 of the record's canonical text (dedupe key)."""
    return sha256_text(canonical_text(rec))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_json(obj) -> str:
    """Deterministic JSON serialization (sorted keys, compact separators)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sort_structure(obj):
    """Recursively sort dict keys; lists of dicts with 'id' sorted by id.

    Used before hashing/writing so output bytes are order-independent.
    """
    if isinstance(obj, dict):
        return {k: sort_structure(obj[k]) for k in sorted(obj)}
    if isinstance(obj, list):
        items = [sort_structure(x) for x in obj]
        if items and all(isinstance(x, dict) and isinstance(x.get("id"), str) for x in items):
            items.sort(key=lambda x: x["id"])
        return items
    return obj


def normalize_record(rec: dict, default_created_at: str | None = None) -> dict:
    """Return a fully normalized, deterministically-ordered copy of a record.

    - deep-copies and sorts structure
    - fills missing created_at with default_created_at (or leaves absent)
    - leaves dataset_version untouched (pipeline stamps it later)
    """
    out = sort_structure(rec)
    if "created_at" not in out and default_created_at is not None:
        out["created_at"] = default_created_at
    return out
