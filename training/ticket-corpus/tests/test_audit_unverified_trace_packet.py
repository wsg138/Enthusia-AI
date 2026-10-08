"""Synthetic-only regressions for private reference-only trace packet QA."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from audit_unverified_trace_packet import _correction_proposal, audit
from screen_review_targets import candidate_digest


def draft(cid: str, answer: str, messages=None):
    messages = messages or [{"role": "user", "content": "Can you check this?"}]
    return {
        "id": cid,
        "candidate_id": cid,
        "worker_origin": "ticket_worker_v1",
        "source_candidate_id": "W01-0001",
        "family_group": "family-a",
        "quality": "USABLE_WITH_EDIT",
        "messages": messages,
        "expected_answer": answer,
        "review_flags": ["unverified_tool_result_claim"],
        "source_candidate_sha256": "a" * 64,
        "source_file_sha256": "b" * 64,
        "source_revision": "fixture-source-v1",
    }


def staging(root: Path, answers: tuple[str, str]):
    stage = root / "stage"
    stage.mkdir()
    rows = [
        draft("W01-0001-a01", answers[0]),
        draft(
            "W01-0001-a02",
            answers[1],
            [
                {"role": "user", "content": "Can you check this?"},
                {"role": "assistant", "content": answers[0]},
                {"role": "user", "content": "Any update?"},
            ],
        ),
    ]
    refs = [{"kind": "repo", "ref": "wsg138/Demo@" + "c" * 40 + ":README.md"}]
    index = [
        {
            "draft_id": row["candidate_id"],
            "source_candidate_id": "W01-0001",
            "source_filename": "fixture.jsonl",
            "source_line": 1,
            "family_group": "family-a",
            "source_refs": refs,
        }
        for row in rows
    ]
    entries = [
        {
            "candidate_id": row["candidate_id"],
            "record_sha256": candidate_digest(row),
            "source_candidate_sha256": "a" * 64,
            "source_file_sha256": "b" * 64,
            "source_revision": "fixture-source-v1",
            "family_group": "family-a",
            "review_status": "HOLD",
            "approved_uses": [],
            "split": "none",
            "rights_cleared": False,
            "privacy_cleared": False,
            "staff_visibility_reviewed": False,
        }
        for row in rows
    ]
    manifest = {
        "schema": "enthusia-ticket-review-admission/v1",
        "manifest_id": "fixture-hold",
        "entries": entries,
    }
    manifest_path = stage / "REVIEW-MANIFEST-ALL-HOLD.private.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    (stage / "DRAFT-W16-NOT-TRAINABLE.private.jsonl").write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8"
    )
    (stage / "REVIEW-SOURCE-INDEX.private.jsonl").write_text(
        "\n".join(json.dumps(row) for row in index) + "\n", encoding="utf-8"
    )
    ledger = {
        "schema": "enthusia-ticket-source-quarantine/v1",
        "source_hold_manifest_sha256": sha256(manifest_path.read_bytes()).hexdigest(),
        "source_count": 1,
        "draft_count": 2,
        "entries": [
            {
                "source_candidate_id": "W01-0001",
                "source_candidate_sha256": "a" * 64,
                "source_file_sha256": "b" * 64,
                "source_revision": "fixture-source-v1",
                "disposition": "REJECT",
                "draft_ids": ["W01-0001-a01", "W01-0001-a02"],
            }
        ],
    }
    ledger_path = root / "quarantine.private.json"
    ledger_path.write_text(json.dumps(ledger), encoding="utf-8")
    return stage, rows, index, entries, refs, ledger_path


def packet_row(row: dict, refs: list[dict], *, rejected=True):
    return {
        "schema": "enthusia-private-unverified-trace-review/v1",
        "candidate_id": row["candidate_id"],
        "source_candidate_id": row["source_candidate_id"],
        "reviewed_target_sha256": candidate_digest(row),
        "source_candidate_sha256": row["source_candidate_sha256"],
        "source_file_sha256": row["source_file_sha256"],
        "source_revision": row["source_revision"],
        "family_group": row["family_group"],
        "source_refs": refs,
        "as_of_turn_messages": row["messages"],
        "proposed_player_visible_answer": row["expected_answer"],
        "reported_flags": ["unverified_tool_result_claim"],
        "source_rejected": rejected,
        "tool_trace_status": "reference_only",
        "recorded_expected_action_count": 0,
        "recorded_tool_count": 0,
        "required_evidence_review": "fixture",
        "review_status": "PENDING_INDEPENDENT",
        "training_eligible": False,
        "rights_cleared": False,
        "privacy_cleared": False,
        "accepted_as_verified": False,
    }


class TracePacketAuditTests(unittest.TestCase):
    def _run(self, first: str, second: str, *, rows=(0, 1)):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        stage, drafts, _, _, refs, ledger = staging(root, (first, second))
        packet = root / "packet.private.jsonl"
        packet.write_text(
            "\n".join(json.dumps(packet_row(drafts[i], refs)) for i in rows) + "\n",
            encoding="utf-8",
        )
        out = root / "qa"
        report = audit(stage, packet, ledger, out)
        annotations = [
            json.loads(line)
            for line in (out / "TRACE-QA-ANNOTATIONS.private.jsonl").read_text().splitlines()
        ]
        return root, stage, packet, ledger, out, report, annotations

    def test_future_check_requires_capability_not_observed_result(self):
        *_, report, annotations = self._run(
            "I'll compare the proxy logs once you give me a time.",
            "I can check the transaction history next.",
            rows=(0,),
        )
        row = annotations[0]
        self.assertIn("PROSPECTIVE_TOOL_CAPABILITY", row["target_claim_classes"])
        self.assertNotIn("COMPLETED_RESULT_CLAIM", row["target_claim_classes"])
        self.assertEqual(
            row["proposed_correction"],
            "NO_EDIT_KEEP_SOURCE_QUARANTINED",
        )
        self.assertEqual(report["approved_records"], 0)

    def test_nonquarantined_capability_annotation_yields_hash_pinned_proposal(self):
        annotation = {
            "candidate_id": "W02-0002-a01",
            "source_candidate_id": "W02-0002",
            "reviewed_target_sha256": "c" * 64,
            "source_candidate_sha256": "d" * 64,
            "source_revision": "fixture-v1",
            "source_rejected": False,
            "proposed_correction": "VERIFY_CAPABILITY_OR_REMOVE_FIRST_PERSON_ACTION_PROMISE",
        }
        proposal = _correction_proposal(annotation)
        self.assertIsNotNone(proposal)
        self.assertEqual(proposal["expected_original_record_sha256"], "c" * 64)
        self.assertEqual(proposal["expected_original_source_sha256"], "d" * 64)
        self.assertEqual(proposal["approval_status"], "HOLD")
        self.assertFalse(proposal["training_eligible"])

    def test_completed_result_requires_observed_evidence(self):
        *_, annotations = self._run(
            "I checked the database and confirmed the transfer.",
            "I can check again later.",
            rows=(0,),
        )
        row = annotations[0]
        self.assertIn("COMPLETED_RESULT_CLAIM", row["target_claim_classes"])
        self.assertIn(
            "OBSERVED_AS_OF_TURN_TOOL_OR_EXTERNAL_EVIDENCE",
            row["required_verification"],
        )

    def test_context_claim_is_not_lost_when_target_is_cautious(self):
        *_, annotations = self._run(
            "I checked the logs and found the restart.",
            "I don't have a verified result yet.",
            rows=(1,),
        )
        row = annotations[0]
        self.assertEqual(row["target_claim_classes"], [])
        self.assertIn("COMPLETED_RESULT_CLAIM", row["context_claim_classes"])

    def test_packet_target_hash_mismatch_fails_closed(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        stage, drafts, _, _, refs, ledger = staging(
            root,
            ("I'll check the logs.", "No result yet."),
        )
        row = packet_row(drafts[0], refs)
        row["reviewed_target_sha256"] = "f" * 64
        packet = root / "packet.private.jsonl"
        packet.write_text(json.dumps(row) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "target hash mismatch"):
            audit(stage, packet, ledger, root / "qa")

    def test_quarantine_marker_mismatch_fails_closed(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        stage, drafts, _, _, refs, ledger = staging(
            root,
            ("I'll check the logs.", "No result yet."),
        )
        row = packet_row(drafts[0], refs, rejected=False)
        packet = root / "packet.private.jsonl"
        packet.write_text(json.dumps(row) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "quarantine status mismatch"):
            audit(stage, packet, ledger, root / "qa")

    def test_source_manifest_digest_mismatch_is_rejected(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        stage, drafts, _, _, refs, ledger = staging(
            root, ("I'll check the logs.", "No result yet.")
        )
        row = packet_row(drafts[0], refs)
        row["source_candidate_sha256"] = "e" * 64
        packet = root / "packet.private.jsonl"
        packet.write_text(json.dumps(row) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "source_candidate_sha256 mismatch"):
            audit(stage, packet, ledger, root / "qa")
        self.assertFalse((root / "qa").exists())

    def test_unverified_actions_fail_before_creating_output(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        stage, drafts, _, _, refs, ledger = staging(
            root, ("I'll check the logs.", "No result yet.")
        )
        drafts[0]["expected_actions"] = [{"tool": "fixture_log_check"}]
        manifest_path = stage / "REVIEW-MANIFEST-ALL-HOLD.private.json"
        doc = json.loads(manifest_path.read_text(encoding="utf-8"))
        doc["entries"][0]["record_sha256"] = candidate_digest(drafts[0])
        manifest_path.write_text(json.dumps(doc), encoding="utf-8")
        ledger_doc = json.loads(ledger.read_text(encoding="utf-8"))
        ledger_doc["source_hold_manifest_sha256"] = sha256(
            manifest_path.read_bytes()
        ).hexdigest()
        ledger.write_text(json.dumps(ledger_doc), encoding="utf-8")
        (stage / "DRAFT-W16-NOT-TRAINABLE.private.jsonl").write_text(
            "\n".join(json.dumps(x) for x in drafts) + "\n", encoding="utf-8"
        )
        row = packet_row(drafts[0], refs)
        packet = root / "packet.private.jsonl"
        packet.write_text(json.dumps(row) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "not reference-only"):
            audit(stage, packet, ledger, root / "qa")
        self.assertFalse((root / "qa").exists())

    def test_duplicate_trace_packet_entry_fails_closed(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        stage, drafts, _, _, refs, ledger = staging(
            root, ("I'll check the logs.", "No result yet.")
        )
        row = packet_row(drafts[0], refs)
        packet = root / "packet.private.jsonl"
        packet.write_text((json.dumps(row) + "\n") * 2, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate or unknown"):
            audit(stage, packet, ledger, root / "qa")
        self.assertFalse((root / "qa").exists())

    def test_output_is_immutable(self):
        _root, stage, packet, ledger, out, *_ = self._run(
            "I'll check the logs.", "No result yet.", rows=(0,)
        )
        with self.assertRaises(FileExistsError):
            audit(stage, packet, ledger, out)


if __name__ == "__main__":
    unittest.main()
