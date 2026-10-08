"""Synthetic regression tests for deterministic six-worker HOLD-only assignments."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
from freeze_parallel_review_assignments import assign_slot, build_ledger, freeze
from screen_review_targets import candidate_digest


def fixture(count=12):
    records, sources, entries, cases = [], [], [], []
    for i in range(count):
        src=f"W01-{i // 2 + 1:04d}"
        rid=f"{src}-a{i % 2 + 1:02d}"
        row={"id":rid,"candidate_id":rid,"source_candidate_id":src,
             "family_group":f"fam-{i//4}",
             "quality":"USABLE_WITH_EDIT",
             "messages":[{"role":"user","content":f"My shop issue {i}"}],
             "expected_answer":f"I'll check case {i}.","review_flags":[]}
        records.append(row)
        sources.append({"draft_id":rid,"source_candidate_id":src,
                        "family_group":row["family_group"],"source_refs":[]})
        entries.append({"candidate_id":rid,"family_group":row["family_group"],
                        "record_sha256":candidate_digest(row),
                        "review_status":"HOLD","approved_uses":[],
                        "rights_cleared":False,"privacy_cleared":False,
                        "staff_visibility_reviewed":False,"split":"none"})
        cases.append({"draft_id":rid,"source_candidate_id":src,
                      "family_group":row["family_group"],
                      "risk_tier":"EVIDENCE_OR_SAFETY_REVIEW",
                      "proposed_answer":row["expected_answer"],
                      "training_eligible":False})
    manifest={"schema":"enthusia-ticket-review-admission/v1",
              "entries":entries}
    return records,sources,manifest,cases


class FreezeAssignmentTests(unittest.TestCase):
    def test_six_slots_exactly_cover_selected(self):
        d,i,m,q=fixture()
        w,s=build_ledger(d,i,m,q,expected_risk_count=12)
        self.assertEqual(sum(map(len,w.values())),12)
        self.assertEqual(s["approved_records"],0)
        self.assertEqual(len({x["draft_id"] for group in w.values() for x in group}),12)

    def test_all_slices_one_original_ticket_one_slot(self):
        d,i,m,q=fixture()
        w,_=build_ledger(d,i,m,q,expected_risk_count=12)
        from collections import defaultdict
        groups=defaultdict(set)
        for slot,records in w.items():
            for record in records:
                groups[record["source_candidate_id"]].add(slot)
        self.assertTrue(all(len(v)==1 for v in groups.values()))

    def test_slot_matches_worker_contract(self):
        d,i,m,q=fixture()
        w,_=build_ledger(d,i,m,q,expected_risk_count=12)
        for slot,records in w.items():
            for row in records:
                self.assertEqual(slot,assign_slot(row["source_candidate_id"]))

    def test_selected_scope_only(self):
        d,i,m,q=fixture()
        q[0]["risk_tier"]="STANDARD_INDEPENDENT_REVIEW"
        w,s=build_ledger(d,i,m,q,expected_risk_count=11)
        self.assertEqual(s["risk_cases_selected"],11)
        self.assertFalse(any(x["draft_id"]==d[0]["id"]
                             for group in w.values() for x in group))

    def test_stale_answer_refused(self):
        d,i,m,q=fixture()
        q[2]["proposed_answer"]="Not same answer."
        with self.assertRaisesRegex(ValueError,"stale"):
            build_ledger(d,i,m,q,expected_risk_count=12)

    def test_duplicate_queue_refused(self):
        d,i,m,q=fixture()
        q[1]["draft_id"]=q[0]["draft_id"]
        with self.assertRaisesRegex(ValueError,"duplicate"):
            build_ledger(d,i,m,q,expected_risk_count=12)

    def test_changed_candidate_id_refused(self):
        d,i,m,q=fixture()
        q[0]["source_candidate_id"]="W02-0000"
        with self.assertRaisesRegex(ValueError,"source candidate mismatch"):
            build_ledger(d,i,m,q,expected_risk_count=12)

    def test_admission_escalation_refused(self):
        d,i,m,q=fixture()
        m["entries"][0]["review_status"]="APPROVED"
        with self.assertRaisesRegex(ValueError,"HOLD"):
            build_ledger(d,i,m,q,expected_risk_count=12)

    def test_wrong_expected_count_refused(self):
        d,i,m,q=fixture()
        with self.assertRaisesRegex(ValueError,"risk queue changed"):
            build_ledger(d,i,m,q,expected_risk_count=71)

    def test_output_nonoverwrite(self):
        d,i,m,q=fixture()
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            staging=root/"staging"
            screen=root/"screen"
            staging.mkdir()
            screen.mkdir()
            for path, rows in [
                ("DRAFT-W16-NOT-TRAINABLE.private.jsonl",d),
                ("REVIEW-SOURCE-INDEX.private.jsonl",i),
            ]:
                (staging/path).write_text(
                    "\n".join(json.dumps(x) for x in rows)+"\n",encoding="utf-8")
            (staging/"REVIEW-MANIFEST-ALL-HOLD.private.json").write_text(
                json.dumps(m),encoding="utf-8")
            (screen/"SCREENING-QUEUE.private.jsonl").write_text(
                "\n".join(json.dumps(x) for x in q)+"\n",encoding="utf-8")
            path=root/"frozen"
            report=freeze(staging,screen,path,expected_risk_count=12)
            self.assertEqual(report["risk_cases_selected"],12)
            self.assertEqual(len(list(path.glob("SLOT-*-ASSIGNMENTS.private.jsonl"))),6)
            with self.assertRaises(FileExistsError):
                freeze(staging,screen,path,expected_risk_count=12)


if __name__ == "__main__":
    unittest.main()
