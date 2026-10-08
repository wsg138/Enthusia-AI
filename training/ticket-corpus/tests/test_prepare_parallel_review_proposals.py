"""Synthetic tests for worker review HOLD-only normalization and quarantine."""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
from prepare_parallel_review_proposals import prepare


def item(n,slot=1):
    return {"draft_id":f"W01-{n:04d}-a02",
            "source_candidate_id":f"W01-{n:04d}",
            "family_group":"family-one","slot":slot,
            "record_sha256":"a"*64,"answer_sha256":"b"*64,
            "review_status":"HOLD","training_eligible":False}


def response(a,action):
    v={"draft_id":a["draft_id"],"source_candidate_id":a["source_candidate_id"],
       "original_target_hash":a["answer_sha256"],
       "recommendation":action,"review_status":"HOLD",
       "training_eligible":False}
    if action=="PROPOSE_REWRITE":
        v["proposed_corrected_response"]="I can check the available records first."
    return v


class NormalizeTests(unittest.TestCase):
    def test_rewrite_and_quarantine_separated(self):
        a,b=item(1),item(2)
        p,q,k,r=prepare({1:{a["draft_id"]:a,b["draft_id"]:b}},
                        {1:[response(a,"PROPOSE_REWRITE"),response(b,"REJECT")]})
        self.assertEqual(r["proposed_rewrites"],1)
        self.assertEqual(r["quarantine_recommendations"],1)
        self.assertEqual(r["approved_records"],0)
        self.assertEqual(p[0]["approval_status"],"HOLD")
        self.assertFalse(q[0]["training_eligible"])

    def test_missing_worker_fails_closed(self):
        a=item(1)
        with self.assertRaisesRegex(ValueError,"incomplete"):
            prepare({1:{a["draft_id"]:a}},{})

    def test_empty_rewrite_rejected(self):
        a=item(1)
        x=response(a,"PROPOSE_REWRITE")
        x["proposed_corrected_response"]=""
        with self.assertRaisesRegex(ValueError,"missing proposed"):
            prepare({1:{a["draft_id"]:a}},{1:[x]})

    def test_unmodified_answer_hash_rejected(self):
        from hashlib import sha256
        a=item(1)
        x=response(a,"PROPOSE_REWRITE")
        a["answer_sha256"]=sha256(x["proposed_corrected_response"].encode()).hexdigest()
        x["original_target_hash"]=a["answer_sha256"]
        with self.assertRaisesRegex(ValueError,"unchanged"):
            prepare({1:{a["draft_id"]:a}},{1:[x]})

    def test_no_self_approval_even_if_worker_asks(self):
        a=item(1)
        x=response(a,"PROPOSE_REWRITE")
        x["approved_for_training"]=True
        with self.assertRaisesRegex(ValueError,"incomplete"):
            prepare({1:{a["draft_id"]:a}},{1:[x]})


if __name__=="__main__":
    unittest.main()
