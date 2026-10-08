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

    def test_test_scenario_phrasing_is_player_visible_artifact(self):
        a,b,c=fixture()
        a["expected_answer"]="I checked the incident evidence in this test scenario."
        result=flag_case(a,b,1)
        self.assertIn("synthetic_artifact_wording_in_target",result["flags"])
        self.assertEqual(result["risk_tier"],"EVIDENCE_OR_SAFETY_REVIEW")

    def test_unmodified_synthetic_and_fixture_wording_is_flagged_in_target(self):
        for phrase in ("synthetic restart", "synthetic deaths", "fixture behaves", "a fixture"):
            with self.subTest(phrase=phrase):
                a, b, _ = fixture()
                a["expected_answer"] = f"The {phrase} is confirmed."
                result = flag_case(a, b, 1)
                self.assertIn("synthetic_artifact_wording_in_target", result["flags"])
                self.assertFalse(result["training_eligible"])

    def test_unverified_staff_action_is_reviewed_in_both_turns(self):
        a, b, _ = fixture()
        a["expected_answer"] = "I'm handing this to staff now."
        a["messages"] = [
            {"role": "user", "content": "lost a tool"},
            {"role": "assistant", "content": "I've escalated the ticket."},
            {"role": "user", "content": "Any update?"},
        ]
        result = flag_case(a, b, 1)
        self.assertIn("unverified_staff_handoff_in_target", result["flags"])
        self.assertIn("unverified_staff_handoff_in_context", result["flags"])

    def test_curly_quotes_in_realistic_handoff_claims(self):
        a, b, _ = fixture()
        a["expected_answer"] = "I’m sending this to staff now."
        a["messages"] = [
            {"role": "user", "content": "Missing item"},
            {"role": "assistant", "content": "I’ve already sent this to staff."},
            {"role": "user", "content": "What now?"},
        ]
        flags = flag_case(a, b, 1)["flags"]
        self.assertIn("unverified_staff_handoff_in_target", flags)
        self.assertIn("unverified_staff_handoff_in_context", flags)

    def test_curly_apostrophe_checked_result_is_reviewed(self):
        a, b, _ = fixture()
        a["expected_answer"] = "I’ve confirmed your transfer."
        self.assertIn("unsupported_verified_result_in_target", flag_case(a, b, 1)["flags"])

    def test_completed_checks_and_evidence_outcome_variants_are_reviewed(self):
        for phrase in (
            "I can confirm the server state.",
            "I finished correlating the timestamps.",
            "I went through the evidence for the report.",
            "The evidence supports the reported loss.",
            "The records still show a death.",
        ):
            with self.subTest(phrase=phrase):
                a, b, _ = fixture()
                a["expected_answer"] = phrase
                result = flag_case(a, b, 1)
                self.assertIn("unsupported_verified_result_in_target", result["flags"])
                self.assertEqual(result["risk_tier"], "EVIDENCE_OR_SAFETY_REVIEW")
                self.assertFalse(result["training_eligible"])

    def test_conditional_evidence_discussion_is_not_verified_result(self):
        a, b, _ = fixture()
        a["expected_answer"] = "If the evidence supports a transfer, staff can consider it."
        self.assertNotIn("unsupported_verified_result_in_target", flag_case(a, b, 1)["flags"])

    def test_unanchored_source_assertions_are_reviewed(self):
        samples = (
            "The server-side evidence supports a real disconnect.",
            "The server timing shows a disconnect.",
            "The available records confirm a transfer.",
            "The latest incident overlaps the restart window.",
        )
        for phrase in samples:
            with self.subTest(phrase=phrase):
                a, b, _ = fixture()
                a["expected_answer"] = phrase
                result = flag_case(a, b, 1)
                self.assertIn("unanchored_source_finding_in_target", result["flags"])
        a, b, _ = fixture()
        a["messages"] = [
            {"role": "user", "content": "lag?"},
            {"role": "assistant", "content": "The available records confirm a server crash."},
            {"role": "user", "content": "What should I send?"},
        ]
        self.assertIn("unanchored_source_finding_in_context", flag_case(a, b, 1)["flags"])

    def test_conditional_or_future_handoff_is_not_a_completed_action(self):
        for phrase in (
            "I can send this to staff if you want.",
            "I'll flag it for staff once you upload a log.",
            "If evidence confirms the loss, staff can investigate.",
            "Please upload the screenshot you mentioned.",
        ):
            with self.subTest(phrase=phrase):
                a, b, _ = fixture()
                a["expected_answer"] = phrase
                flags = flag_case(a, b, 1)["flags"]
                self.assertNotIn("unverified_staff_handoff_in_target", flags)
                self.assertNotIn("unanchored_source_finding_in_target", flags)


    def test_issue_ref_is_reviewed_as_context_not_commit_proof(self):
        a,b,c=fixture()
        b["source_refs"]=[{"ref":"wsg138/Example#91"}]
        flags=flag_case(a,b,1)["flags"]
        self.assertIn("issue_reference_context_only", flags)
        self.assertNotIn("nonversioned_ref_review", flags)

    def test_private_rewrite_alias_remains_reviewable(self):
        for value in ("private ticket-rewrite-14",
                      "private rewritten ticket ticket-rewrite-7"):
            with self.subTest(value=value):
                a,b,c=fixture()
                b["source_refs"]=[{"ref":value}]
                flags=flag_case(a,b,1)["flags"]
                self.assertIn("private_rewrite_alias_review",flags)
                self.assertNotIn("nonversioned_ref_review",flags)
        for value in ("ticket-rewrite-14","private:ticket-rewrite-14"):
            with self.subTest(value=value):
                a,b,c=fixture()
                b["source_refs"]=[{"ref":value}]
                flags=flag_case(a,b,1)["flags"]
                self.assertNotIn("nonversioned_ref_review",flags)
                self.assertNotIn("private_rewrite_alias_review",flags)

    def test_unversioned_repo_file_still_needs_review(self):
        a,b,c=fixture()
        b["source_refs"]=[{"ref":"wsg138/Example:docs/policy.md"}]
        flags=flag_case(a,b,1)["flags"]
        self.assertIn("nonversioned_ref_review", flags)
        self.assertNotIn("issue_reference_context_only",flags)

    def test_mutable_and_repeated_source_are_review_only(self):
        a,b,c=fixture()
        b["source_refs"]=[{"ref":"wsg138/Example@main:README.md"}]
        result=flag_case(a,b,5)
        self.assertIn("mutable_referenced_source",result["flags"])
        self.assertIn("repeated_target_text_4plus",result["flags"])
        self.assertEqual(result["risk_tier"],"STYLE_OR_PROVENANCE_REVIEW")

    def test_future_tool_promise_gets_capability_review(self):
        a, b, _ = fixture()
        a["expected_answer"] = "I'll compare the proxy logs once you give me a time."
        result = flag_case(a, b, 1)
        self.assertIn("unverified_tool_capability_promise_in_target", result["flags"])
        self.assertNotIn("unsupported_verified_result_in_target", result["flags"])
        self.assertEqual(result["risk_tier"], "STYLE_OR_PROVENANCE_REVIEW")

    def test_inherited_tool_warning_without_current_trigger_is_annotated(self):
        a, b, _ = fixture()
        a["review_flags"] = ["unverified_tool_result_claim"]
        a["expected_answer"] = "Please send the exact error and rough time."
        result = flag_case(a, b, 1)
        self.assertIn("unverified_tool_result_claim", result["flags"])
        self.assertIn("inherited_tool_warning_no_lexical_trigger", result["flags"])

    def test_cross_lane_exact_repeat_is_reviewed(self):
        a, b, _ = fixture()
        a["expected_answer"] = "Please send the exact error and rough time."
        result = flag_case(a, b, 1, global_duplicate_frequency=4)
        self.assertIn("cross_lane_repeated_target_text_4plus", result["flags"])
        self.assertNotIn("repeated_target_text_4plus", result["flags"])

    def test_screen_reports_repeat_group_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            stage = base / "stage"
            stage.mkdir()
            cases = []
            for number in range(4):
                row, meta, entry = fixture(f"W01-0001-a{number + 1:02d}")
                row["expected_answer"] = "Please send the exact error and rough time."
                entry["record_sha256"] = candidate_digest(row)
                cases.append((row, meta, entry))
            (stage / "DRAFT-W16-NOT-TRAINABLE.private.jsonl").write_text(
                "\n".join(json.dumps(x[0]) for x in cases) + "\n", encoding="utf-8"
            )
            (stage / "REVIEW-SOURCE-INDEX.private.jsonl").write_text(
                "\n".join(json.dumps(x[1]) for x in cases) + "\n", encoding="utf-8"
            )
            (stage / "REVIEW-MANIFEST-ALL-HOLD.private.json").write_text(
                json.dumps(doc(*cases)), encoding="utf-8"
            )
            report = screen(stage, base / "screen")
            self.assertEqual(report["exact_repeat_groups_4plus"], 1)
            self.assertEqual(report["exact_repeat_rows_4plus"], 4)
            self.assertEqual(report["largest_exact_repeat_group"], 4)
            self.assertEqual(report["cross_lane_exact_repeat_groups_4plus"], 0)

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

    def test_review_sample_covers_all_families_before_extra_risk(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            staging = base/"staging"
            staging.mkdir()
            cases = []
            for number in range(61):
                row, meta, ent = fixture(f"W01-0001-a{number+1:02d}")
                row["expected_answer"] = "I checked the server log already."
                ent["record_sha256"] = candidate_digest(row)
                cases.append((row, meta, ent))
            row, meta, ent = fixture("W02-0002-a01")
            row["family_group"] = "family-b"
            meta["family_group"] = "family-b"
            ent["family_group"] = "family-b"
            ent["record_sha256"] = candidate_digest(row)
            cases.append((row, meta, ent))
            (staging/"DRAFT-W16-NOT-TRAINABLE.private.jsonl").write_text(
                "\n".join(json.dumps(x[0]) for x in cases)+"\n",encoding="utf-8")
            (staging/"REVIEW-SOURCE-INDEX.private.jsonl").write_text(
                "\n".join(json.dumps(x[1]) for x in cases)+"\n",encoding="utf-8")
            (staging/"REVIEW-MANIFEST-ALL-HOLD.private.json").write_text(
                json.dumps(doc(*cases)),encoding="utf-8")
            report = screen(staging,base/"review")
            sample = [json.loads(x) for x in
                (base/"review"/"MANUAL-REVIEW-SAMPLE.private.jsonl").read_text().splitlines()]
            self.assertEqual(report["manual_sample_size"],60)
            self.assertEqual({x["family_group"] for x in sample},
                             {"family-a","family-b"})

    def test_inconsistent_source_file_blocks(self):
        case=fixture()
        with self.assertRaisesRegex(ValueError,"mismatched record counts"):
            verify_staged([case[0]], [], doc(case))


if __name__=="__main__":
    unittest.main()
