"""Synthetic-only staged review tests; never read private ticket archives."""
from __future__ import annotations

import json
from pathlib import Path
import os
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from stage_ticket_review_targets import (
    make_draft_targets, stage, _digest, record_digest
)


def fake(cid="W01-0001"):
    return {
        "candidate_id": cid,
        "lane": "stalls-market-ownership",
        "seed_refs": ["fixture-seed-a"],
        "source_refs": [{"ref": "fictional-source"}],
        "scenario_facts": {"fixture_only": True, "facts": []},
        "conversation": [
            {"role": "user", "content": "stall 3 gives permission denied"},
            {"role": "assistant", "content": "Which account owns the stall?"},
            {"role": "user", "content": "my guild owns it"},
            {"role": "assistant", "content": "I checked the ownership; need staff to fix it."},
        ],
        "investigation": [{
            "intent": "fictional staff-only diagnosis",
            "result_summary": "DO NOT SHOW private synthetic detail",
            "visibility": "staff_only",
            "evidence_kind": "synthetic_fixture"
        }],
        "staff_handoff": {
            "needed": True,
            "evidence_summary": "DO NOT SHOW",
            "recommendation": "staff decision",
            "visibility": "staff_only"
        },
        "quality": {"self_review": "PASS", "risks": []},
        "mutations_performed": False,
    }


def make_audit(folder: Path, cid: str):
    audit = folder/"audit"
    audit.mkdir()
    (audit/"triage-index.jsonl").write_text(
        json.dumps({"candidate_id": cid, "bucket": "PRIORITY_INDEPENDENT_REVIEW"})+"\n",
        encoding="utf-8",
    )
    (audit/"quality-probes-index.jsonl").write_text("", encoding="utf-8")
    (audit/"method-v2-lineage-groups.json").write_text(
        json.dumps([{"ids": [cid]}]), encoding="utf-8",
    )
    return audit


class StagingFixtureTests(unittest.TestCase):
    def validate(self, row):
        # Minimal structural stub for pure-function tests.
        assert row["messages"] and row["quality"] == "USABLE_WITH_EDIT"
        return row

    def test_only_as_of_prefix_is_used_and_staff_notes_excluded(self):
        f = fake()
        pairs = make_draft_targets(f, "a"*64, "b"*64, "seed-component-0000", self.validate)
        self.assertEqual(len(pairs), 2)
        first, meta = pairs[0]
        self.assertEqual(first["messages"], [f["conversation"][0]])
        self.assertEqual(first["expected_answer"], f["conversation"][1]["content"])
        self.assertEqual(meta["review_status"], "HOLD")
        self.assertEqual(meta["approved_uses"], [])
        self.assertNotIn("investigation", first)
        self.assertNotIn("staff_handoff", first)
        self.assertNotIn("DO NOT SHOW", json.dumps(first))

    def test_later_turn_uses_prior_user_assistant_exchanges(self):
        pairs = make_draft_targets(fake(), "a"*64, "b"*64,
                                   "seed-component-0000", self.validate)
        row, meta = pairs[1]
        self.assertEqual(len(row["messages"]), 3)
        self.assertEqual(row["messages"][-1]["role"], "user")
        self.assertIn("unverified_tool_result_claim", row["review_flags"])
        self.assertEqual(meta["review_status"], "HOLD")

    def test_no_slices_for_single_exchange(self):
        f = fake()
        f["conversation"] = f["conversation"][:2]
        self.assertEqual(make_draft_targets(f, "a"*64, "b"*64,
                                            "family", self.validate), [])

    def test_no_assistant_target_without_immediate_user(self):
        f = fake()
        f["conversation"].insert(3, {
            "role": "assistant", "content": "This is a second bot message"
        })
        result = make_draft_targets(f,"a"*64,"b"*64,"family",self.validate)
        self.assertEqual(len(result), 2)

    def test_end_to_end_all_hold_and_non_overwrite(self):
        from enthusia_datasets.record import validate_record
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root/"outputs"
            output.mkdir()
            original = fake()
            text = json.dumps(original, ensure_ascii=False)
            (output/"W01-stalls-market-ownership.jsonl").write_text(text+"\n",encoding="utf-8")
            audit = make_audit(root,original["candidate_id"])
            staged = root/"staged"
            # The same validator as W16 is loaded by stage().
            w16_root = Path(os.environ["ENTHUSIA_W16_ROOT"]) if "ENTHUSIA_W16_ROOT" in os.environ else Path(__file__).resolve().parents[2]/"datasets"
            report = stage(output,audit,staged,w16_root)
            self.assertEqual(report["approved_training_records"],0)
            self.assertEqual(report["draft_prompt_completion_slices"],2)
            drafts = [json.loads(l) for l in (staged/"DRAFT-W16-NOT-TRAINABLE.private.jsonl").read_text().splitlines()]
            manifest = json.loads((staged/"REVIEW-MANIFEST-ALL-HOLD.private.json").read_text())
            self.assertEqual({d["quality"] for d in drafts},{"USABLE_WITH_EDIT"})
            self.assertEqual({e["review_status"] for e in manifest["entries"]},{"HOLD"})
            self.assertEqual(len({d["candidate_id"] for d in drafts}),2)
            self.assertEqual([e["record_sha256"] for e in manifest["entries"]],
                             [record_digest(validate_record(d)) for d in drafts])
            with self.assertRaises(FileExistsError):
                stage(output,audit,staged,w16_root)

    def test_missing_review_filter_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root/"outputs";source.mkdir()
            w16_root = Path(os.environ["ENTHUSIA_W16_ROOT"]) if "ENTHUSIA_W16_ROOT" in os.environ else Path(__file__).resolve().parents[2]/"datasets"
            with self.assertRaises(FileNotFoundError):
                stage(source,root,root/"staged",w16_root)


if __name__ == "__main__":
    unittest.main()
