"""Fail-closed independent review admission for worker-derived ticket SFT records.

This is a deliberately narrow gate for synthetic ticket *workers*, not a
general-purpose replacement for W16. The approver manifest is a PRIVATE input
and cannot be inferred from worker self_review/quality labels.

An approval pins the exact normalized W16 record bytes (except downstream
dataset_version/quality_metadata), the original candidate content digest
carried by its converter, identity of an independent reviewer, rights/privacy,
and an immutable split. Every cohort is checked for transitive lineage leaks.

A manifest is a record of adjudication, NOT a generator of approvals.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

from .source_quarantine import SourceQuarantine, QuarantineError, SLICE_ID

SCHEMA = "enthusia-ticket-review-admission/v1"
HEX64 = re.compile(r"^[a-f0-9]{64}$")
APPROVED_SPLITS = frozenset({"train", "validation"})


class AdmissionError(ValueError):
    """An invalid or internally contradictory approval manifest."""


def record_digest(record: dict) -> str:
    """SHA-256 of the reviewed normalized W16 target, before W19 build metadata.

    Call *after* canonical W16 validate_record/default application.
    In particular, the reviewed target includes player-visible messages and
    expected_answer, tool actions, quality, staff visibility metadata etc.
    """
    data = dict(record)
    data.pop("dataset_version", None)
    data.pop("quality_metadata", None)
    blob = json.dumps(data, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def worker_derived(record: dict) -> bool:
    """Conservative W19 signal, not a trust assertion.

    Any converter of the private worker JSONL MUST preserve worker_origin,
    candidate_id and source_candidate_sha256. Other fields are fallback guards
    for accidentally importing partially converted work.
    """
    generator = record.get("generator")
    return (
        "candidate_id" in record
        or record.get("worker_origin") == "ticket_worker_v1"
        or isinstance(generator, str) and (
            generator.startswith("enthusia-synthetic-ticket-worker")
            or generator.startswith("ticket-worker")
        )
    )


def _str(entry: dict, field: str, where: str) -> str:
    value = entry.get(field)
    if not isinstance(value, str) or not value.strip():
        raise AdmissionError(f"{where}: {field} must be nonempty string")
    return value


def _hash(entry: dict, field: str, where: str) -> str:
    value = _str(entry, field, where)
    if not HEX64.fullmatch(value):
        raise AdmissionError(f"{where}: {field} must be lowercase hex SHA-256")
    return value


def _tokens(entry: dict) -> set[tuple[str, str]]:
    """Only incident/source lineage; NEVER generic shared repo policy refs."""
    links: set[tuple[str, str]] = set()
    for key in ("family_group", "session_group", "incident_id",
                "canonical_event_id"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            links.add((key, value))
    for field, kind in (
        ("seed_refs", "seed"), ("source_ticket_ids", "ticket"),
        ("source_message_ids", "source_message"),
    ):
        values = entry.get(field, [])
        for item in values:
            if isinstance(item, str) and item.strip():
                links.add((kind, item))
    return links


class ReviewAdmission:
    def __init__(self, doc: dict, *, digest: str, quarantine: SourceQuarantine | None = None):
        if not isinstance(doc, dict) or doc.get("schema") != SCHEMA:
            raise AdmissionError("unrecognized ticket review manifest schema")
        self.manifest_id = _str(doc, "manifest_id", "manifest")
        self.review_protocol_revision = _str(
            doc, "review_protocol_revision", "manifest"
        )
        entries = doc.get("entries")
        if not isinstance(entries, list) or not entries:
            raise AdmissionError("manifest must have nonempty entries")
        self.manifest_sha256 = digest
        self.quarantine = quarantine
        if quarantine is not None:
            if doc.get("quarantine_ledger_sha256") != quarantine.sha256:
                raise AdmissionError("private quarantine ledger SHA-256 mismatch")
            if doc.get("source_hold_manifest_sha256") != quarantine.source_hold_manifest_sha256:
                raise AdmissionError("quarantine ledger belongs to a different source HOLD release")
        self.entries: dict[str, dict] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise AdmissionError("manifest entries must be objects")
            cid = _str(entry, "candidate_id", "entry")
            if cid in self.entries:
                raise AdmissionError(f"duplicate manifest candidate_id {cid}")
            where = f"entry {cid}"
            _hash(entry, "record_sha256", where)
            _hash(entry, "source_candidate_sha256", where)
            _hash(entry, "source_file_sha256", where)
            _str(entry, "source_revision", where)
            _str(entry, "family_group", where)
            reviewer = _str(entry, "independent_reviewer_id", where)
            generator = _str(entry, "generator_id", where)
            if reviewer == generator:
                raise AdmissionError(f"{where}: generator cannot self-approve")
            if entry.get("review_status") not in (
                "APPROVED", "HOLD", "REJECTED"
            ):
                raise AdmissionError(f"{where}: unknown review_status")
            if entry.get("split") not in (*APPROVED_SPLITS, "holdout", "none"):
                raise AdmissionError(f"{where}: invalid split")
            if not isinstance(entry.get("approved_uses"), list):
                raise AdmissionError(f"{where}: approved_uses must be a list")
            if not isinstance(entry.get("seed_refs"), list):
                raise AdmissionError(f"{where}: seed_refs must be a list")
            if any(not isinstance(s, str) or not s for s in entry["seed_refs"]):
                raise AdmissionError(f"{where}: invalid seed ref")
            if not isinstance(entry.get("parent_ids", []), list):
                raise AdmissionError(f"{where}: invalid parent_ids")
            for key in ("rights_cleared", "privacy_cleared",
                        "staff_visibility_reviewed", "source_withdrawn"):
                if type(entry.get(key)) is not bool:
                    raise AdmissionError(f"{where}: {key} must be boolean")
            if entry.get("tool_trace_status") not in (
                "reference_only", "as_of_verified"
            ):
                raise AdmissionError(f"{where}: invalid tool_trace_status")
            self.entries[cid] = entry
        self._validate_lineage_splits()

    @classmethod
    def from_path(cls, path: str | Path) -> "ReviewAdmission":
        source = Path(path).read_bytes()
        try:
            doc = json.loads(source.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise AdmissionError("invalid UTF-8/JSON review manifest") from exc
        quarantine = None
        ledger_file = doc.get("quarantine_ledger_file")
        if ledger_file is not None:
            if not isinstance(ledger_file, str) or not ledger_file.strip():
                raise AdmissionError("invalid private quarantine ledger path")
            location = Path(ledger_file)
            if not location.is_absolute():
                location = Path(path).parent / location
            try:
                quarantine = SourceQuarantine.from_path(location)
            except (OSError, QuarantineError) as exc:
                raise AdmissionError("missing or invalid private quarantine ledger") from exc
        return cls(doc, digest=hashlib.sha256(source).hexdigest(), quarantine=quarantine)

    def _validate_lineage_splits(self) -> None:
        """Reject any transitive connected source family crossing split."""
        keys = list(self.entries)
        parents = list(range(len(keys)))
        index = {cid: i for i, cid in enumerate(keys)}

        def find(i: int) -> int:
            while parents[i] != i:
                parents[i] = parents[parents[i]]
                i = parents[i]
            return i

        def union(i: int, j: int) -> None:
            a, b = find(i), find(j)
            if a != b:
                parents[max(a, b)] = min(a, b)

        owners: dict[tuple[str, str], int] = {}
        for i, cid in enumerate(keys):
            entry = self.entries[cid]
            for token in _tokens(entry):
                if token in owners:
                    union(i, owners[token])
                else:
                    owners[token] = i
            for parent_id in entry.get("parent_ids", []):
                if not isinstance(parent_id, str) or not parent_id:
                    raise AdmissionError(f"entry {cid}: invalid parent id")
                if parent_id in index:
                    union(i, index[parent_id])

        by_component: dict[int, set[str]] = defaultdict(set)
        for i, cid in enumerate(keys):
            entry = self.entries[cid]
            # Any independently approved held-out or training cohort is
            # protected. A holdout that shares lineage with train/validation
            # would otherwise compromise supposedly frozen evaluation.
            if entry["review_status"] == "APPROVED" and entry["split"] in (
                "train", "validation", "holdout"
            ):
                by_component[find(i)].add(entry["split"])
        if any(len(splits) > 1 for splits in by_component.values()):
            raise AdmissionError("related source/incident family crosses approved data splits")

    def eligible_split(self, record: dict) -> tuple[str | None, str | None]:
        """Return (approved split, rejection reason), never infer approval."""
        cid = record.get("candidate_id")
        if not isinstance(cid, str):
            return None, "missing worker candidate_id"
        entry = self.entries.get(cid)
        if entry is None:
            return None, "candidate missing from independent review manifest"
        if record.get("worker_origin") != "ticket_worker_v1":
            return None, "missing worker_origin provenance"
        if record.get("source_candidate_sha256") != entry["source_candidate_sha256"]:
            return None, "source candidate digest mismatch"
        if record.get("source_file_sha256") != entry["source_file_sha256"]:
            return None, "source file digest mismatch"
        if record.get("source_revision") != entry["source_revision"]:
            return None, "source revision mismatch"
        if record_digest(record) != entry["record_sha256"]:
            return None, "reviewed training target digest mismatch"
        if entry["review_status"] != "APPROVED":
            return None, "not independently approved"
        # A source-level worker rejection is never cleared by approving one
        # draft slice. Multi-slice admissions require a pinned PRIVATE ledger,
        # even if the approved target hash, reviewer and rights are plausible.
        if SLICE_ID.fullmatch(cid) or "source_candidate_id" in record:
            if self.quarantine is None:
                return None, "source-ticket candidate requires private source quarantine ledger"
            blocked = self.quarantine.reason(record)
            if blocked is not None:
                return None, blocked
        if entry["split"] not in APPROVED_SPLITS:
            return None, "holdout or unassigned split"
        if "train" not in entry["approved_uses"]:
            return None, "training use not approved"
        if entry["source_withdrawn"]:
            return None, "source withdrawn"
        if not entry["rights_cleared"]:
            return None, "source rights not cleared"
        if not entry["privacy_cleared"]:
            return None, "privacy not cleared"
        if not entry["staff_visibility_reviewed"]:
            return None, "staff visibility not independently reviewed"
        if record.get("family_group") != entry["family_group"]:
            return None, "family group mismatch"
        if record.get("seed_refs") != entry["seed_refs"]:
            return None, "source seed lineage mismatch"
        if record.get("staff_handoff") is not None:
            return None, "staff-only handoff embedded in trainable target"
        if record.get("investigation") is not None:
            return None, "unverified internal investigation embedded in trainable target"
        if record.get("tool_trace_status") != entry["tool_trace_status"]:
            return None, "tool trace review status mismatch"
        if entry["tool_trace_status"] == "reference_only" and (
            record.get("expected_actions") or record.get("tools")
        ):
            return None, "unverified tool traces cannot be trained as tool actions"
        return entry["split"], None
