"""Synthetic-only tests for worker-result intake, never training approval."""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"tools"))
from audit_parallel_review_intake import audit, check_result


def assignment(i, slot=1):
    return {"draft_id":f"W01-{i:04d}-a01",
            "source_candidate_id":f"W01-{i:04d}",
            "slot":slot,"record_sha256":"a"*64,"answer_sha256":"b"*64,
            "review_status":"HOLD","training_eligible":False}


def result(item, rec="PROPOSE_REWRITE"):
    return {"draft_id":item["draft_id"],
            "source_candidate_id":item["source_candidate_id"],
            "original_target_hash":item["answer_sha256"],
            "recommendation":rec,
            "review_status":"HOLD","training_eligible":False}


class IntakeTests(unittest.TestCase):
    def test_valid_results_stay_hold(self):
        a,b=assignment(1),assignment(2,slot=2)
        report=audit({1:{a["draft_id"]:a},2:{b["draft_id"]:b}},
                     {1:[result(a)],2:[result(b,"REJECT")]})
        self.assertEqual(report["status"],"HOLD_ONLY_REVIEW_INTAKE_COMPLETE")
        self.assertEqual(report["approved_records"],0)
        self.assertEqual(report["validated_worker_records"],2)

    def test_missing_slot_fails_closed(self):
        a=assignment(1)
        report=audit({1:{a["draft_id"]:a},2:{}},{})
        self.assertEqual(report["validated_worker_records"],0)
        self.assertGreater(report["issue_count"],0)

    def test_duplicate_draft_rejected(self):
        a=assignment(1)
        report=audit({1:{a["draft_id"]:a}}, {1:[result(a),result(a)]})
        self.assertGreater(report["issue_count"],0)

    def test_wrong_slot_rejected(self):
        a=assignment(1)
        report=audit({1:{},2:{a["draft_id"]:a}},
                     {1:[result(a)],2:[]})
        self.assertGreater(report["issue_count"],0)
        self.assertEqual(report["validated_worker_records"],0)

    def test_stale_hash_rejected(self):
        a=assignment(1)
        x=result(a);x["original_target_hash"]="f"*64
        with self.assertRaisesRegex(ValueError,"stale"):
            check_result(x,a)

    def test_false_approval_rejected(self):
        a=assignment(1)
        x=result(a);x["rights_cleared"]=True
        with self.assertRaisesRegex(ValueError,"approval"):
            check_result(x,a)

    def test_non_hold_status_rejected(self):
        a=assignment(1)
        x=result(a);x["review_status"]="APPROVED"
        with self.assertRaisesRegex(ValueError,"promotion"):
            check_result(x,a)

    def test_original_record_sha_is_accepted(self):
        a=assignment(1)
        x=result(a);x["original_target_hash"]=a["record_sha256"]
        self.assertEqual(check_result(x,a),"PROPOSE_REWRITE")

    def test_unknown_action_rejected(self):
        a=assignment(1)
        x=result(a,"APPROVED")
        with self.assertRaisesRegex(ValueError,"recommendation"):
            check_result(x,a)


if __name__ == "__main__":
    unittest.main()
