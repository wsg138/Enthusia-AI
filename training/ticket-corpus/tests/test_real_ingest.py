import json
import tempfile
import unittest
from pathlib import Path

from enthusia_ticket_corpus.real_ingest import run_real_ingest


def _ticket(
    ticket_id: str,
    category: str = "general_support",
    staff_text: str = "I checked this and resolved it.",
) -> dict:
    return {
        "ticket_id": ticket_id,
        "channel_id": f"ticket-{ticket_id}",
        "guild": "Enthusia",
        "category": category,
        "created_at": "2026-09-01T12:00:00Z",
        "closed_at": "2026-09-01T13:00:00Z",
        "flags": {"dm": False, "deleted": False, "private": False},
        "messages": [
            {
                "message_id": f"{ticket_id}-p",
                "author_id": "PLAYER",
                "author_name": "PLAYER",
                "role": "player",
                "content": "How do I fix this server issue?",
                "timestamp": "2026-09-01T12:00:00Z",
            },
            {
                "message_id": f"{ticket_id}-s",
                "author_id": "STAFF_1",
                "author_name": "STAFF_1",
                "role": "staff",
                "content": staff_text,
                "timestamp": "2026-09-01T13:00:00Z",
            },
        ],
    }


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )


class RealIngestTests(unittest.TestCase):
    def _run(
        self,
        source: Path,
        output: Path,
        *,
        acknowledged: bool = True,
    ) -> dict:
        return run_real_ingest(
            input_path=str(source),
            output_dir=str(output),
            dataset_version="ticket-real-test-v1",
            reference_date="2026-10-07T00:00:00Z",
            run_id="test-run",
            operator="test-operator",
            governance_acknowledged=acknowledged,
        )

    def test_requires_governance_ack(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "export.jsonl"
            _write_jsonl(source, [_ticket("1")])
            with self.assertRaisesRegex(ValueError, "governance"):
                self._run(source, root / "out", acknowledged=False)

    def test_writes_review_partitions_and_content_free_rejections(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "export.jsonl"
            _write_jsonl(
                source,
                [
                    _ticket("1"),
                    _ticket("2", staff_text="not my problem, figure it out yourself"),
                    _ticket("3", category="appeal"),
                ],
            )

            manifest = self._run(source, root / "out")
            self.assertEqual(manifest["status"], "review_required_not_admitted")
            self.assertEqual(manifest["counts"]["in_scope"], 2)
            self.assertEqual(manifest["counts"]["positive_review_candidates"], 1)
            self.assertEqual(manifest["counts"]["negative_eval_candidates"], 1)
            self.assertEqual(manifest["counts"]["rejected"], 1)

            positive = (root / "out" / "positive-review-candidates.jsonl").read_text(
                encoding="utf-8"
            )
            negative = (root / "out" / "negative-eval-candidates.jsonl").read_text(
                encoding="utf-8"
            )
            rejected = (root / "out" / "rejected.jsonl").read_text(encoding="utf-8")

            self.assertIn('"quality": "USABLE_WITH_EDIT"', positive)
            self.assertIn('"quality": "BAD_RESPONSE"', negative)
            self.assertEqual(
                json.loads(rejected),
                {"reason": "outside_first_pass_scope", "ticket_id": "3"},
            )
            self.assertNotIn("not my problem", rejected)
            self.assertTrue(
                manifest["next_gate"].startswith("Manual real-ticket sample review")
            )

    def test_redacts_pii_before_review_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "export.jsonl"
            ticket = _ticket(
                "4",
                staff_text="Please send a screenshot, then I can check it.",
            )
            ticket["messages"][0]["content"] = (
                "My email is realperson@example.com and my IP is 192.0.2.55."
            )
            _write_jsonl(source, [ticket])

            self._run(source, root / "out")
            blob = (root / "out" / "positive-review-candidates.jsonl").read_text(
                encoding="utf-8"
            )
            self.assertNotIn("realperson@example.com", blob)
            self.assertNotIn("192.0.2.55", blob)
            self.assertIn("[EMAIL]", blob)
            self.assertIn("[IP]", blob)

    def test_refuses_git_worktree_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "export.jsonl"
            _write_jsonl(source, [_ticket("5")])
            repo = root / "repo"
            repo.mkdir()
            (repo / ".git").mkdir()

            with self.assertRaisesRegex(ValueError, "Git worktree"):
                self._run(source, repo / "private-output")

    def test_refuses_existing_output_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "export.jsonl"
            _write_jsonl(source, [_ticket("6")])
            out = root / "out"
            out.mkdir()

            with self.assertRaisesRegex(ValueError, "must not already exist"):
                self._run(source, out)


if __name__ == "__main__":
    unittest.main()
