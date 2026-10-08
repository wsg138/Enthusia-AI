"""Immutable private source-ticket quarantine for W19 multi-slice admission.

This ledger is evidence of a previous REJECT recommendation, not an
independent approval. It blocks *every* assistant slice from the source.
Never store private ledgers or rejection notes in GitHub.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

SCHEMA = "enthusia-ticket-source-quarantine/v1"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SLICE_ID = re.compile(r"^(W[0-9]{2}-[0-9]{4})-a([0-9]{2})$")


class QuarantineError(ValueError):
    """Invalid, incomplete or tampered source-quarantine ledger."""


class SourceQuarantine:
    def __init__(self, doc: dict, *, digest: str):
        if not isinstance(doc, dict) or doc.get("schema") != SCHEMA:
            raise QuarantineError("unrecognized source quarantine schema")
        cohort = doc.get("source_hold_manifest_sha256")
        if not isinstance(cohort, str) or not SHA256.fullmatch(cohort):
            raise QuarantineError("missing source HOLD release SHA-256")
        rows = doc.get("entries")
        if not isinstance(rows, list) or not rows:
            raise QuarantineError("empty or missing rejection source entries")
        self.sha256 = digest
        self.source_hold_manifest_sha256 = cohort
        self.sources = {}
        seen_slices = set()
        for row in rows:
            if not isinstance(row, dict):
                raise QuarantineError("source entry must be an object")
            source = row.get("source_candidate_id")
            if not isinstance(source, str) or not re.fullmatch(r"W[0-9]{2}-[0-9]{4}", source):
                raise QuarantineError("invalid rejected source_candidate_id")
            if source in self.sources:
                raise QuarantineError("duplicate rejected source_candidate_id")
            for name in ("source_candidate_sha256", "source_file_sha256"):
                value = row.get(name)
                if not isinstance(value, str) or not SHA256.fullmatch(value):
                    raise QuarantineError(f"{source}: invalid {name}")
            if not isinstance(row.get("source_revision"), str) or not row["source_revision"]:
                raise QuarantineError(f"{source}: missing source revision")
            if row.get("disposition") != "REJECT":
                raise QuarantineError(f"{source}: only REJECT recommendations may quarantine")
            slices = row.get("draft_ids")
            if slices != [f"{source}-a01", f"{source}-a02"]:
                raise QuarantineError(f"{source}: both known assistant slices are required")
            if seen_slices.intersection(slices):
                raise QuarantineError("duplicate quarantined draft ID")
            seen_slices.update(slices)
            self.sources[source] = row
        if doc.get("source_count") != len(self.sources) or doc.get("draft_count") != len(seen_slices):
            raise QuarantineError("quarantine count mismatch")

    @classmethod
    def from_path(cls, path: str | Path) -> "SourceQuarantine":
        raw = Path(path).read_bytes()
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise QuarantineError("invalid UTF-8/JSON private quarantine ledger") from exc
        return cls(doc, digest=hashlib.sha256(raw).hexdigest())

    def reason(self, record: dict) -> str | None:
        cid = record.get("candidate_id")
        matched = SLICE_ID.fullmatch(cid) if isinstance(cid, str) else None
        from_id = matched.group(1) if matched else None
        source = record.get("source_candidate_id")
        if from_id is not None and source != from_id:
            return "source-ticket lineage mismatch"
        # Source provenance, not a mutable draft suffix, is the quarantine
        # authority. Detect mislabeled or renamed derivatives too.
        if not isinstance(source, str) or not source:
            return "missing source-ticket provenance"
        hashes = {
            row["source_candidate_sha256"]: sid
            for sid, row in self.sources.items()
        }
        blocked_source = hashes.get(record.get("source_candidate_sha256"))
        if blocked_source is not None and blocked_source != source:
            return "quarantined source identity mismatch"
        blocked = self.sources.get(source)
        if blocked is None:
            return None
        for field in ("source_candidate_sha256", "source_file_sha256", "source_revision"):
            if record.get(field) != blocked[field]:
                return "quarantined source provenance mismatch"
        return "source-ticket quarantine: independent reconsideration required"


__all__ = ["SourceQuarantine", "QuarantineError", "SLICE_ID", "SCHEMA"]
