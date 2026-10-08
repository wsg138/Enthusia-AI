"""Synthetic-only quarantine admission tests: no private ticket text or IDs."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from enthusia_datasets.record import validate_record
from enthusia_finetune.review_admission import ReviewAdmission, AdmissionError, record_digest
from enthusia_finetune.source_quarantine import SourceQuarantine, QuarantineError


def draft(suffix):
    source = "W01-0123"
    return {
        "id": source + suffix,
        "candidate_id": source + suffix,
        "source_candidate_id": source,
        "worker_origin": "ticket_worker_v1",
        "source_candidate_sha256": "a" * 64,
        "source_file_sha256": "b" * 64,
        "source_revision": "fixture-revision",
        "family_group": "fake-family",
        "seed_refs": ["fake-seed"],
        "source_type": "synthetic",
        "visibility": "public",
        "messages": [{"role": "user", "content": "Fictional help request"}],
        "expected_answer": "What time did it happen?",
        "quality": "GOOD",
        "tool_trace_status": "reference_only",
        "generator": "ticket-worker-synthetic",
        "expected_actions": [],
        "tools": [],
    }


def approval(row, status="APPROVED"):
    return {
        "candidate_id": row["candidate_id"],
        "record_sha256": record_digest(validate_record(row)),
        "source_candidate_sha256": row["source_candidate_sha256"],
        "source_file_sha256": row["source_file_sha256"],
        "source_revision": row["source_revision"],
        "family_group": row["family_group"],
        "seed_refs": row["seed_refs"],
        "independent_reviewer_id": "fake-independent-reviewer",
        "generator_id": "fake-generator",
        "review_status": status,
        "approved_uses": ["train"] if status == "APPROVED" else [],
        "split": "train" if status == "APPROVED" else "none",
        "rights_cleared": status == "APPROVED",
        "privacy_cleared": status == "APPROVED",
        "staff_visibility_reviewed": status == "APPROVED",
        "source_withdrawn": False,
        "tool_trace_status": "reference_only",
    }


def ledger():
    return {
        "schema": "enthusia-ticket-source-quarantine/v1",
        "source_hold_manifest_sha256": "f" * 64,
        "source_count": 1,
        "draft_count": 2,
        "entries": [{
            "source_candidate_id": "W01-0123",
            "source_candidate_sha256": "a" * 64,
            "source_file_sha256": "b" * 64,
            "source_revision": "fixture-revision",
            "disposition": "REJECT",
            "draft_ids": ["W01-0123-a01", "W01-0123-a02"],
        }],
    }


def gate(*rows, quarantine=None):
    doc = {
        "schema": "enthusia-ticket-review-admission/v1",
        "manifest_id": "fake-manifest",
        "review_protocol_revision": "fake-rubric",
        "entries": [approval(r) for r in rows],
    }
    if quarantine is not None:
        doc["quarantine_ledger_sha256"] = quarantine.sha256
        doc["source_hold_manifest_sha256"] = quarantine.source_hold_manifest_sha256
    return ReviewAdmission(doc, digest="e" * 64, quarantine=quarantine)


class QuarantineTests(unittest.TestCase):
    def test_both_siblings_blocked_despite_individual_approval(self):
        quarantine = SourceQuarantine(ledger(), digest="c" * 64)
        first, second = draft("-a01"), draft("-a02")
        admission = gate(first, second, quarantine=quarantine)
        for row in (first, second):
            with self.subTest(cid=row["candidate_id"]):
                split, why = admission.eligible_split(validate_record(row))
                self.assertIsNone(split)
                self.assertIn("source-ticket quarantine", why)

    def test_missing_ledger_fails_closed_for_multi_slice(self):
        row = draft("-a01")
        split, why = gate(row).eligible_split(validate_record(row))
        self.assertIsNone(split)
        self.assertIn("requires private source quarantine", why)

    def test_unreviewed_hold_remains_hold_without_ledger(self):
        row = draft("-a01")
        doc = {"schema": "enthusia-ticket-review-admission/v1",
               "manifest_id": "hold", "review_protocol_revision": "fake",
               "entries": [approval(row, "HOLD")]}
        split, why = ReviewAdmission(doc, digest="e"*64).eligible_split(validate_record(row))
        self.assertIsNone(split)
        self.assertEqual(why, "not independently approved")

    def test_non_rejected_source_can_use_pinned_ledger_after_review(self):
        quarantine = SourceQuarantine(ledger(), digest="c"*64)
        row = draft("-a01")
        row["id"] = row["candidate_id"] = "W02-0001-a01"
        row["source_candidate_id"] = "W02-0001"
        row["family_group"] = "fake-other-family"
        split, why = gate(row, quarantine=quarantine).eligible_split(validate_record(row))
        self.assertEqual((split, why), ("train", None))

    def test_wrong_release_and_ledger_hash_are_rejected(self):
        quarantine = SourceQuarantine(ledger(), digest="c"*64)
        row = draft("-a01")
        for key, bad in (("source_hold_manifest_sha256", "e"*64),
                         ("quarantine_ledger_sha256", "a"*64)):
            with self.subTest(key=key):
                doc = {"schema": "enthusia-ticket-review-admission/v1",
                       "manifest_id": "fixture", "review_protocol_revision": "fake",
                       "entries": [approval(row)],
                       "source_hold_manifest_sha256": quarantine.source_hold_manifest_sha256,
                       "quarantine_ledger_sha256": quarantine.sha256}
                doc[key] = bad
                with self.assertRaises(AdmissionError):
                    ReviewAdmission(doc, digest="e"*64, quarantine=quarantine)

    def test_modified_source_hash_fails_closed(self):
        wrong = draft("-a01")
        wrong["source_candidate_sha256"] = "d"*64
        quarantine = SourceQuarantine(ledger(), digest="c"*64)
        split, why = gate(wrong, quarantine=quarantine).eligible_split(validate_record(wrong))
        self.assertIsNone(split)
        self.assertIn("quarantined source provenance mismatch", why)

    def test_wrong_source_id_fails_closed(self):
        row = draft("-a01")
        row["source_candidate_id"] = "W02-0123"
        quarantine = SourceQuarantine(ledger(), digest="c"*64)
        split, why = gate(row, quarantine=quarantine).eligible_split(validate_record(row))
        self.assertIsNone(split)
        self.assertIn("lineage mismatch", why)

    def test_duplicate_source_and_missing_sibling_fail_closed(self):
        for bad in ("duplicate", "missing"):
            with self.subTest(bad=bad):
                doc = ledger()
                if bad == "duplicate":
                    doc["entries"].append(copy.deepcopy(doc["entries"][0]))
                    doc["source_count"] = 2
                    doc["draft_count"] = 4
                else:
                    doc["entries"][0]["draft_ids"] = ["W01-0123-a02"]
                    doc["draft_count"] = 1
                with self.assertRaises(QuarantineError):
                    SourceQuarantine(doc, digest="c"*64)

    def test_invalid_ledger_and_hash_binding_from_disk(self):
        row = draft("-a01")
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)
            (path/"ledger.json").write_text(json.dumps(ledger()), encoding="utf-8")
            raw = (path/"ledger.json").read_bytes()
            doc = {"schema": "enthusia-ticket-review-admission/v1",
                   "manifest_id": "fake", "review_protocol_revision": "fake",
                   "entries": [approval(row)],
                   "quarantine_ledger_file": "ledger.json",
                   "quarantine_ledger_sha256": hashlib.sha256(raw).hexdigest(),
                   "source_hold_manifest_sha256": "f"*64}
            (path/"manifest.json").write_text(json.dumps(doc), encoding="utf-8")
            admission = ReviewAdmission.from_path(path/"manifest.json")
            self.assertIn("quarantine", admission.eligible_split(validate_record(row))[1])
            doc["quarantine_ledger_sha256"] = "a"*64
            (path/"manifest.json").write_text(json.dumps(doc), encoding="utf-8")
            with self.assertRaises(AdmissionError):
                ReviewAdmission.from_path(path/"manifest.json")


if __name__ == "__main__":
    unittest.main()
