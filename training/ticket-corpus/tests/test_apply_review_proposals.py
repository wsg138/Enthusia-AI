"""Synthetic-only tests for immutable editorial review derivatives."""
from __future__ import annotations
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
from apply_review_proposals import (
    apply_proposals,digest_target,replace_refs,resolution_pairs
)


def target(id, prompt, answer):
    return {"id":id,"candidate_id":id,"quality":"USABLE_WITH_EDIT",
            "family_group":"source-family-1","worker_origin":"ticket_worker_v1",
            "source_candidate_id":"W01-0001",
            "messages":prompt,"expected_answer":answer,
            "source_candidate_sha256":"a"*64,
            "source_file_sha256":"b"*64}


def fixtures():
    player={"role":"user","content":"I lost credits"}
    first="I found your bank transfer in the database."
    follow={"role":"user","content":"I don't have a screenshot"}
    a=target("W01-0001-a01",[player],first)
    b=target("W01-0001-a02",
             [player,{"role":"assistant","content":first},follow],
             "That does not prove the transaction was yours.")
    drafts=[a,b]
    ref="wsg138/Demo@main:docs/guide.md#readme"
    refs=[{"kind":"path","ref":ref}]
    metas=[{"draft_id":row["id"],
            "source_candidate_id":"W01-0001",
            "source_refs":deepcopy(refs),
            "family_group":row["family_group"],
            "source_filename":"W01-synthetic.jsonl","source_line":1,
            "review_status":"HOLD","training_eligible":False} for row in drafts]
    entries=[{"candidate_id":row["id"],"record_sha256":digest_target(row),
              "family_group":"source-family-1","review_status":"HOLD",
              "approved_uses":[],"split":"none",
              "rights_cleared":False,"privacy_cleared":False,
              "staff_visibility_reviewed":False} for row in drafts]
    manifest={"schema":"enthusia-ticket-review-admission/v1",
              "manifest_id":"fixture-all-hold","entries":entries}
    proposal={"draft_id":"W01-0001-a01","suggested_player_safe_answer":
              "I can check the guild bank history once we know which account.",
              "approval_status":"HOLD","training_eligible":False}
    fixes={"wsg138/Demo@main:docs/guide.md":
           "wsg138/Demo@"+"c"*40+":docs/guide.md"}
    return drafts,metas,manifest,[proposal],fixes


class EditorialDerivativeTests(unittest.TestCase):
    def test_earlier_turn_replay_updates_followup(self):
        d,i,m,p,f=fixtures()
        rows,idx,adm,changes,report=apply_proposals(d,i,m,p,f,lambda x:x)
        self.assertEqual(report["proposed_target_rewrites"],1)
        self.assertEqual(report["prior_assistant_context_updates"],1)
        self.assertEqual(report["source_reference_occurrences_revised"],2)
        self.assertEqual(rows[1]["messages"][1]["content"],rows[0]["expected_answer"])
        self.assertEqual(rows[1]["expected_answer"],d[1]["expected_answer"])
        self.assertEqual(rows[0]["messages"],d[0]["messages"])
        self.assertEqual(adm["entries"][1]["record_sha256"],digest_target(rows[1]))
        self.assertNotEqual(adm["entries"][1]["record_sha256"],
                            m["entries"][1]["record_sha256"])
        self.assertEqual(report["approved_records"],0)

    def test_originals_unchanged(self):
        d,i,m,p,f=fixtures()
        before=json.dumps([d,i,m,p,f],sort_keys=True)
        apply_proposals(d,i,m,p,f,lambda x:x)
        self.assertEqual(json.dumps([d,i,m,p,f],sort_keys=True),before)

    def test_source_fragment_pins_without_path_rewrite(self):
        d,i,m,p,f=fixtures()
        _,idx,_,_,_=apply_proposals(d,i,m,p,f,lambda x:x)
        self.assertEqual(idx[0]["source_refs"][0]["ref"],
                         f["wsg138/Demo@main:docs/guide.md"]+"#readme")

    def test_unknown_id_rejected(self):
        d,i,m,p,f=fixtures()
        p[0]["draft_id"]="W22-9999-a01"
        with self.assertRaisesRegex(ValueError,"unknown"):
            apply_proposals(d,i,m,p,f,lambda x:x)

    def test_proposal_cannot_self_approve(self):
        d,i,m,p,f=fixtures()
        p[0]["approval_status"]="APPROVED"
        with self.assertRaisesRegex(ValueError,"training eligibility"):
            apply_proposals(d,i,m,p,f,lambda x:x)

    def test_malformed_or_duplicate_source_resolution_rejected(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            file=Path(td)/"fixes.json"
            file.write_text(json.dumps({"entries":[{
                "original_prefix":"wsg138/Demo@main:docs/readme.md",
                "pinned_ref":"wsg138/Other@"+"c"*40+":docs/readme.md",
                "exists_at_pinned_commit":True}]}))
            with self.assertRaisesRegex(ValueError,"repository"):
                resolution_pairs([file])

    def test_unverified_resolution_rejected(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            file=Path(td)/"fixes.json"
            file.write_text(json.dumps({"entries":[{
                "original_prefix":"wsg138/Demo@main:docs/readme.md",
                "pinned_ref":"wsg138/Demo@"+"c"*40+":docs/readme.md",
                "exists_at_pinned_commit":False}]}))
            with self.assertRaisesRegex(ValueError,"not verified"):
                resolution_pairs([file])

    def test_invalid_staged_content_rejected(self):
        d,i,m,p,f=fixtures()
        m["entries"][1]["record_sha256"]="a"*64
        with self.assertRaisesRegex(ValueError,"digest"):
            apply_proposals(d,i,m,p,f,lambda x:x)


if __name__=="__main__":
    unittest.main()
