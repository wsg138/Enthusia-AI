"""Synthetic-only tests; no historical or private ticket files are opened."""
from __future__ import annotations
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ticket_method_invariants import (
    validate_candidate, leak_components, find_split_leaks,
)


def fixture(i="W01-0001", seed="ticket-rewrite-FIXTURE-A"):
    return {
        "candidate_id": i,
        "lane": "stalls-market-ownership",
        "seed_refs": [seed],
        "source_refs": [{"kind": "repo", "ref": "wsg138/FAKE@revision:example"}],
        "scenario_facts": {"fixture_only": True, "facts": []},
        "conversation": [
            {"role": "user", "content": "my stall says not owner"},
            {"role": "assistant", "content": "Which stall, and any chat error?"},
            {"role": "user", "content": "stall 12, error not owner"},
            {"role": "assistant", "content": "I'll check what the stall records show."},
        ],
        "investigation": [
            {
                "intent": "read synthetic stall owner record",
                "result_summary": "fictional fixture contains different owner",
                "visibility": "staff_only",
                "evidence_kind": "synthetic_fixture",
                "after_turn_index": 2,
                "source_turn_index": 0,
            }
        ],
        "staff_handoff": {
            "needed": True,
            "evidence_summary": "Only synthetic placeholder evidence",
            "recommendation": "Have staff review discrepancy",
            "visibility": "staff_only",
        },
        "quality": {"self_review": "PASS", "risks": []},
        "mutations_performed": False,
    }


class TicketMethodFixtureTests(unittest.TestCase):
    def test_valid_multi_turn(self):
        self.assertEqual(validate_candidate(fixture(), require_multi_turn=True), [])

    def test_short_exchange_fails_full_ticket_gate(self):
        f = fixture()
        f["conversation"] = f["conversation"][:2]
        self.assertNotIn("not_full_multi_turn", validate_candidate(f))
        self.assertIn("not_full_multi_turn", validate_candidate(f, require_multi_turn=True))

    def test_mutation_flag_strict_boolean(self):
        f = fixture()
        f["mutations_performed"] = "false"
        self.assertIn("mutation_not_explicitly_false", validate_candidate(f))

    def test_player_visible_tool_or_staff_role_rejected(self):
        f = fixture()
        f["conversation"][1]["role"] = "tool"
        self.assertIn("invalid_player_visible_role", validate_candidate(f))

    def test_staff_handoff_is_staff_only(self):
        f = fixture()
        f["staff_handoff"]["visibility"] = "player_safe"
        self.assertIn("staff_handoff_not_private", validate_candidate(f))

    def test_fixture_label_is_boolean(self):
        f = fixture()
        f["scenario_facts"]["fixture_only"] = "true"
        self.assertIn("fixture_provenance_missing", validate_candidate(f))

    def test_investigation_requires_kind_and_visibility(self):
        f = fixture()
        f["investigation"][0]["evidence_kind"] = "production_verified"
        f["investigation"][0]["visibility"] = "player_and_staff"
        errs = validate_candidate(f)
        self.assertIn("invalid_evidence_kind", errs)
        self.assertIn("invalid_investigation_visibility", errs)

    def test_source_from_future_turn_rejected(self):
        f = fixture()
        f["investigation"][0]["source_turn_index"] = 3
        self.assertIn("future_tool_context", validate_candidate(f))

    def test_unanchored_source_turn_rejected(self):
        f = fixture()
        f["investigation"][0].pop("after_turn_index")
        self.assertIn("unanchored_tool_context", validate_candidate(f))

    def test_timestamp_order_and_partial_timestamps(self):
        f = fixture()
        f["conversation"][0]["timestamp"] = "2026-10-07T18:00:00Z"
        self.assertIn("partial_timestamps", validate_candidate(f))
        f["conversation"][1]["timestamp"] = "2026-10-07T17:59:00Z"
        f["conversation"][2]["timestamp"] = "2026-10-07T18:03:00Z"
        f["conversation"][3]["timestamp"] = "2026-10-07T18:04:00Z"
        self.assertIn("nonchronological_ticket", validate_candidate(f))

    def test_same_seed_across_splits_is_leak(self):
        a = fixture()
        b = fixture("W02-0002")
        a["split"] = "train"
        b["split"] = "test"
        self.assertEqual(find_split_leaks([a, b]), [["W01-0001", "W02-0002"]])

    def test_transitive_shared_lineage(self):
        a = fixture("W01-0001", "seed-A")
        b = fixture("W02-0002", "seed-A")
        c = fixture("W03-0003", "seed-C")
        b["session_group"] = c["session_group"] = "incident-two"
        components = leak_components([a, b, c])
        self.assertEqual(components, [["W01-0001", "W02-0002", "W03-0003"]])

    def test_augmentation_parent_cannot_cross_splits(self):
        a = fixture("W01-0001", "seed-A")
        b = fixture("W02-0002", "seed-B")
        a["split"], b["split"] = "train", "validation"
        b["parent_ids"] = ["W01-0001"]
        self.assertEqual(len(find_split_leaks([a, b])), 1)

    def test_public_docs_commonality_is_not_leakage(self):
        a = fixture("W01-0001", "seed-A")
        b = fixture("W02-0002", "seed-B")
        a["split"], b["split"] = "train", "test"
        a["source_refs"] = b["source_refs"] = [
            {"kind": "repo", "ref": "wsg138/Enthusia-AI@main:POLICY"}
        ]
        self.assertEqual(find_split_leaks([a, b]), [])

    def test_self_pass_never_assigns_quality(self):
        f = fixture()
        self.assertEqual(validate_candidate(f, require_multi_turn=True), [])
        self.assertNotIn("quality_label", f)


if __name__ == "__main__":
    unittest.main()
