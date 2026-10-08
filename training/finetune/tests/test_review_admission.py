"""All data here is invented. No private ticket data or GPU operations."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from enthusia_datasets.record import validate_record
from enthusia_finetune import assembly
from enthusia_finetune.review_admission import (
    AdmissionError, ReviewAdmission, record_digest, worker_derived, SCHEMA
)


def worker_record(cid="W01-0001", *, family="family-A", seed="fake-seed-A"):
    return {
        "id": cid,
        "candidate_id": cid,
        "worker_origin": "ticket_worker_v1",
        "source_candidate_sha256": "a" * 64,
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": "Fictional ticket about a stall",
        "messages": [
            {"role": "user", "content": "my stall isn't working"},
            {"role": "assistant", "content": "Which stall and what error?"},
            {"role": "user", "content": "stall 3, no access"},
        ],
        "expected_answer": f"I'll check the available ownership evidence for {cid}.",
        "quality": "GOOD",
        "family_group": family,
        "seed_refs": [seed],
        "tool_trace_status": "reference_only",
        "generator": "enthusia-synthetic-ticket-worker-v1",
        "expected_actions": [],
        "tools": [],
    }


def entry(record, split="train", **kw):
    out = {
        "candidate_id": record["candidate_id"],
        "record_sha256": record_digest(validate_record(record)),
        "source_candidate_sha256": record["source_candidate_sha256"],
        "source_file_sha256": "b" * 64,
        "source_revision": "synthetic-private-fixture-revision",
        "family_group": record["family_group"],
        "seed_refs": record["seed_refs"],
        "independent_reviewer_id": "fixture-reviewer",
        "generator_id": "fixture-generator",
        "review_status": "APPROVED",
        "approved_uses": ["train"],
        "split": split,
        "rights_cleared": True,
        "privacy_cleared": True,
        "staff_visibility_reviewed": True,
        "source_withdrawn": False,
        "tool_trace_status": record["tool_trace_status"],
    }
    out.update(kw)
    return out


def manifest(*entries):
    return {
        "schema": SCHEMA,
        "manifest_id": "fixture-review-v1",
        "review_protocol_revision": "independent-review-v1",
        "entries": list(entries),
    }


def save(path: Path, data):
    path.write_text(json.dumps(data, sort_keys=True), encoding="utf-8")
    return path


class ManifestAdmissionTests(unittest.TestCase):
    def test_worker_record_detected(self):
        self.assertTrue(worker_derived(worker_record()))

    def test_missing_reviewer_rejected(self):
        r = worker_record()
        e = entry(r)
        e.pop("independent_reviewer_id")
        with self.assertRaises(AdmissionError):
            ReviewAdmission(manifest(e), digest="a"*64)

    def test_worker_cannot_review_self(self):
        r = worker_record()
        with self.assertRaises(AdmissionError):
            ReviewAdmission(manifest(entry(r, generator_id="fixture-reviewer")), digest="a"*64)

    def test_wrong_record_hash_is_hold(self):
        r = worker_record()
        gate = ReviewAdmission(manifest(entry(r)), digest="a"*64)
        r["expected_answer"] = "Actually, you should run some other command."
        split, why = gate.eligible_split(validate_record(r))
        self.assertIsNone(split)
        self.assertIn("digest mismatch", why)

    def test_source_digest_mismatch(self):
        r = worker_record()
        gate = ReviewAdmission(manifest(entry(r)), digest="a"*64)
        r["source_candidate_sha256"] = "c"*64
        split, why = gate.eligible_split(validate_record(r))
        self.assertIsNone(split)
        self.assertIn("digest mismatch", why)

    def test_privacy_clearance_required(self):
        r = worker_record()
        gate = ReviewAdmission(manifest(entry(r, privacy_cleared=False)), digest="a"*64)
        split, why = gate.eligible_split(validate_record(r))
        self.assertIsNone(split)
        self.assertIn("privacy not cleared", why)

    def test_source_withdrawal_rejects(self):
        r = worker_record()
        gate = ReviewAdmission(manifest(entry(r, source_withdrawn=True)), digest="a"*64)
        split, why = gate.eligible_split(validate_record(r))
        self.assertIsNone(split)
        self.assertIn("withdrawn", why)

    def test_hold_and_unapproved_use_reject(self):
        r = worker_record()
        for change in (
            {"review_status": "HOLD"},
            {"approved_uses": ["evaluation"]},
            {"split": "holdout"},
        ):
            with self.subTest(change=change):
                gate = ReviewAdmission(manifest(entry(r, **change)), digest="a"*64)
                split, why = gate.eligible_split(validate_record(r))
                self.assertIsNone(split)
                self.assertIsInstance(why, str)

    def test_staff_only_material_never_included(self):
        r = worker_record()
        r["staff_handoff"] = {"secret": "fictional private staff note"}
        gate = ReviewAdmission(manifest(entry(r)), digest="a"*64)
        split, why = gate.eligible_split(validate_record(r))
        self.assertIsNone(split)
        self.assertIn("staff-only", why)

    def test_unverified_tool_trace_cannot_train_tool_actions(self):
        r = worker_record()
        r["expected_actions"] = ["read server logs"]
        gate = ReviewAdmission(manifest(entry(r)), digest="a"*64)
        split, why = gate.eligible_split(validate_record(r))
        self.assertIsNone(split)
        self.assertIn("unverified tool traces", why)

    def test_family_crosses_splits_fail_closed(self):
        a = worker_record("W01-0001", family="incident-1")
        b = worker_record("W01-0002", family="incident-1")
        with self.assertRaisesRegex(AdmissionError, "crosses train and validation"):
            ReviewAdmission(manifest(entry(a, "train"), entry(b, "validation")), digest="a"*64)

    def test_transitive_lineage_crosses_splits(self):
        a = worker_record("W01-0001", family="a", seed="s1")
        b = worker_record("W01-0002", family="b", seed="s1")
        c = worker_record("W01-0003", family="b", seed="s3")
        with self.assertRaisesRegex(AdmissionError, "crosses"):
            ReviewAdmission(manifest(entry(a, "train"),entry(b, "train"),entry(c, "validation")), digest="a"*64)

    def test_generic_policy_doc_is_not_lineage(self):
        a = worker_record("W01-0001", family="a", seed="s1")
        b = worker_record("W02-0002", family="b", seed="s2")
        shared = [{"kind": "repo", "ref": "wsg138/Fake@main:POLICY.md"}]
        a["source_refs"] = b["source_refs"] = shared
        ReviewAdmission(manifest(entry(a, "train"), entry(b, "validation")), digest="a"*64)

    def test_good_worker_is_excluded_without_manifest(self):
        r = worker_record()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inp = root / "candidates.jsonl"
            inp.write_text(json.dumps(r)+"\n", encoding="utf-8")
            result = assembly.assemble(
                [str(inp)], str(root/"out"), dataset_version="fixture-v1"
            )
            self.assertEqual(result["counts"]["train"], 0)
            self.assertEqual(result["counts"]["validation"], 0)
            self.assertIn("independent ticket review manifest", result["exclusions"][0]["reason"])

    def test_exactly_approved_records_are_assembled(self):
        a = worker_record("W01-0001",family="family-a",seed="seed-a")
        b = worker_record("W02-0001",family="family-b",seed="seed-b")
        c = worker_record("W03-0001",family="family-c",seed="seed-c")
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            inp=root/"candidates.jsonl"
            inp.write_text("\n".join(json.dumps(x) for x in (a,b,c))+"\n",encoding="utf-8")
            man=save(root/"approved.json",manifest(
                entry(a, "train"),entry(b, "validation"),entry(c, "train", review_status="HOLD")
            ))
            result=assembly.assemble([str(inp)],str(root/"out"),
                 dataset_version="fixture-v1", ticket_review_manifest=str(man))
            self.assertEqual(result["counts"]["train"],1)
            self.assertEqual(result["counts"]["validation"],1)
            train=[json.loads(x) for x in (root/"out"/"train.jsonl").read_text().splitlines()]
            val=[json.loads(x) for x in (root/"out"/"validation.jsonl").read_text().splitlines()]
            self.assertEqual([x["id"] for x in train], ["W01-0001"])
            self.assertEqual([x["id"] for x in val], ["W02-0001"])
            self.assertEqual(result["ticket_review_admission"]["manifest_id"],"fixture-review-v1")
            self.assertTrue(any("not independently approved" in x["reason"] for x in result["exclusions"]))

    def test_no_manifest_record_dropped_even_if_quality_ideal(self):
        a = worker_record("W01-0001",family="a",seed="s1")
        b = worker_record("W01-0002",family="b",seed="s2")
        b["quality"]="IDEAL"
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            inp=root/"candidates.jsonl"
            inp.write_text("\n".join(json.dumps(x) for x in (a,b))+"\n",encoding="utf-8")
            man=save(root/"approved.json",manifest(entry(a)))
            report=assembly.assemble([str(inp)],str(root/"out"),dataset_version="fixture-v1",ticket_review_manifest=str(man))
            self.assertEqual(report["counts"]["train"],1)
            self.assertTrue(any("missing from independent" in x["reason"] for x in report["exclusions"]))


if __name__ == "__main__":
    unittest.main()
