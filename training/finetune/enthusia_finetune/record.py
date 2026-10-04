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

EXCLUDED_QUALITIES = frozenset({"BAD_RESPONSE", "OUTDATED", "PRIVATE_EXCLUDE"})
EXCLUDED_VISIBILITIES = frozenset({"private", "owner"})


def leak_group_key(rec: dict) -> str:
    """Use W16 grouping, with ticket-id grouping as an additional safety fence."""
    ticket_id = rec.get("ticket_id")
    if ticket_id:
        return f"ticket:{rec.get('source_type', '?')}:{ticket_id}"
    return _w16_leak_group_key(rec)


def quality_excluded(rec: dict) -> str | None:
    """Return why a canonical W16 record is ineligible for train/validation."""
    visibility = rec.get("visibility")
    if visibility in EXCLUDED_VISIBILITIES:
        return f"visibility {visibility!r} excluded from training"
    quality = rec.get("quality")
    if quality in EXCLUDED_QUALITIES:
        return f"quality {quality!r} excluded from training"
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
