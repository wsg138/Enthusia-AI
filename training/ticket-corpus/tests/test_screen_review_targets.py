"""Synthetic-only regression tests for the HOLD-first private review screener."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from screen_review_targets import (
    candidate_digest, flag_case, screen, verify_staged,
)


def fixture(i="W01-0001-a01"):
    row={
        "id":i,"candidate_id":i,"worker_origin":"ticket_worker_v1",
        "source_candidate_id":"W01-0001",
        "family_group":"family-a",
        "quality":"USABLE_WITH_EDIT",
        "messages":[{"role":"user","content":"stall wont open"}],
        "expected_answer":"Which stall do you mean?",
        "review_flags":[],
    }
    meta={"draft_id":i,"source_candidate_id":"W01-0001",
          "source_filename":"W01-stalls-market-ownership.jsonl",
          "source_line":1,"family_group":"family-a","source_refs":[]}
    approval={"candidate_id":i,"record_sha256":candidate_digest(row),
              "family_group":"family-a","review_status":"HOLD",
              "approved_uses":[],"split":"none","rights_cleared":False,
              "privacy_cleared":False,"staff_visibility_reviewed":False}
    return row, meta, approval


def doc(*items):
    return {"schema":"enthusia-ticket-review-admission/v1",
            "entries":[x[2] for x in items]}


class ReviewScreenTests(unittest.TestCase):
    def test_valid_hold_manifest_matches(self):
        case=fixture()
        a,b,c=verify_staged([case[0]],[case[1]],doc(case))
        self.assertEqual(set(a),{case[0]["id"]})

    def test_good_label_is_refused(self):
        a,b,c=fixture()
        a["quality"]="GOOD"
        with self.assertRaisesRegex(ValueError,"trainable quality"):
            verify_staged([a],[b],doc((a,b,c)))

    def test_manifest_approval_is_refused(self):
        a,b,c=fixture()
        c["review_status"]="APPROVED"
        with self.assertRaisesRegex(ValueError,"HOLD-only"):
            verify_staged([a],[b],doc((a,b,c)))

    def test_tampered_target_hash_fails(self):
        a,b,c=fixture()
        a["expected_answer"]="new answer"
        with self.assertRaisesRegex(ValueError,"digest"):
            verify_staged([a],[b],doc((a,b,c)))

    def test_existence_not_authorized(self):
        a,b,c=fixture()
        a["expected_answer"]="I checked your player database; the transfer is approved."
        result=flag_case(a,b,1)
        self.assertIn("unsupported_verified_result_in_target",result["flags"])
        self.assertEqual(result["risk_tier"],"EVIDENCE_OR_SAFETY_REVIEW")
        self.assertFalse(result["training_eligible"])

    def test_synthetic_history_is_flagged(self):
        a,b,c=fixture()
        a["messages"]=[
            {"role":"user","content":"lost item"},
            {"role":"assistant","content":"I checked logs and it is fine."},
            {"role":"user","content":"are you sure?"}
        ]
        result=flag_case(a,b,1)
        self.assertIn("unsupported_verified_result_in_context",result["flags"])

    def test_mutable_and_repeated_source_are_review_only(self):
        a,b,c=fixture()
        b["source_refs"]=[{"ref":"wsg138/Example@main:README.md"}]
        result=flag_case(a,b,5)
        self.assertIn("mutable_referenced_source",result["flags"])
        self.assertIn("repeated_target_text_4plus",result["flags"])
        self.assertEqual(result["risk_tier"],"STYLE_OR_PROVENANCE_REVIEW")

    def test_private_output_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            stage=base/"stage"
            stage.mkdir()
            case=fixture()
            (stage/"DRAFT-W16-NOT-TRAINABLE.private.jsonl").write_text(
                json.dumps(case[0])+"\n",encoding="utf-8")
            (stage/"REVIEW-SOURCE-INDEX.private.jsonl").write_text(
                json.dumps(case[1])+"\n",encoding="utf-8")
            (stage/"REVIEW-MANIFEST-ALL-HOLD.private.json").write_text(
                json.dumps(doc(case)),encoding="utf-8")
            out=base/"screen"
            report=screen(stage,out)
            self.assertEqual(report["approved_records"],0)
            self.assertEqual(report["drafts"],1)
            self.assertEqual(report["manual_sample_size"],1)
            with self.assertRaises(FileExistsError):
                screen(stage,out)

    def test_inconsistent_source_file_blocks(self):
        case=fixture()
        with self.assertRaisesRegex(ValueError,"mismatched record counts"):
            verify_staged([case[0]], [], doc(case))


if __name__=="__main__":
    unittest.main()
