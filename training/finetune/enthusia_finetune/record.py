"""W19 adapter to the canonical W16 dataset contract.

W19 consumes W16's validator, canonicalization, split-tag definitions, and
secret scanner directly.  It adds only training-specific exclusion policy and
an extra ticket-id leak group so multiple candidates from one historical
ticket cannot cross train/validation.
"""

from __future__ import annotations

from enthusia_datasets.dedupe import leak_group_key as _w16_leak_group_key
from enthusia_datasets.normalize import canonical_hash, canonical_json
from enthusia_datasets.record import RecordValidationError, validate_record
from enthusia_datasets.secret_scan import scan_record
from enthusia_datasets.splits import SPECIAL_PARTITIONS

TRAINABLE_QUALITIES = frozenset({"GOOD", "IDEAL"})
EXCLUDED_VISIBILITIES = frozenset({"private", "owner"})
# W17's checked-in sample corpus is deliberately generated from plausible
# fixture facts, not authoritative Enthusia production truth. It exercises the
# data/eval pipeline but must never become a production SFT source merely by
# acquiring a GOOD/IDEAL quality label later.
FIXTURE_ONLY_GENERATORS = frozenset({"enthusia-generation-v0.1.0"})


def leak_group_key(rec: dict) -> str:
    """Use W16 grouping, with ticket-id grouping as an additional safety fence."""
    ticket_id = rec.get("ticket_id")
    if ticket_id:
        return f"ticket:{rec.get('source_type', '?')}:{ticket_id}"
    return _w16_leak_group_key(rec)


def quality_excluded(rec: dict) -> str | None:
    """Return why a canonical W16 record is ineligible for train/validation."""
    generator = rec.get("generator")
    if generator in FIXTURE_ONLY_GENERATORS:
        return (
            f"generator {generator!r} is fixture-only and excluded from "
            "production training"
        )
    visibility = rec.get("visibility")
    if visibility in EXCLUDED_VISIBILITIES:
        return f"visibility {visibility!r} excluded from training"
    quality = rec.get("quality")
    if quality not in TRAINABLE_QUALITIES:
        return (
            f"quality {quality!r} is not explicitly trainable; "
            "only reviewed GOOD/IDEAL records may enter training"
        )
    return None


__all__ = [
    "RecordValidationError",
    "SPECIAL_PARTITIONS",
    "canonical_hash",
    "canonical_json",
    "leak_group_key",
    "quality_excluded",
    "scan_record",
    "validate_record",
]
