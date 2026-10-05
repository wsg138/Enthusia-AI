#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "generation_benchmark",
    HERE / "run_generation_benchmark.py",
)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class FormatterTests(unittest.TestCase):
    def test_markdown_table_preserves_escaped_pipes(self) -> None:
        raw = (
            "| `/mail inbox [packages\\|letters\\|announcements]` "
            "| Open the mailbox. | `enthusiaexpress.inbox` |"
        )
        self.assertEqual(
            mod._clean_display_line(raw),
            "/mail inbox [packages|letters|announcements]: "
            "Open the mailbox. Permission: enthusiaexpress.inbox",
        )

    def test_command_comment_becomes_readable(self) -> None:
        self.assertEqual(
            mod._clean_display_line(
                "/autoclick                 # toggle normal cooldown-based attacks"
            ),
            "/autoclick: toggle normal cooldown-based attacks",
        )

    def test_resolve_evidence_keeps_raw_provenance(self) -> None:
        job = {
            "target_line": "/autoclick # toggle attacks",
            "source_id": "github:wsg138/example@abc:README.md#line-4",
            "source_version": "abc",
            "line_number": 4,
        }
        facts, answer = mod._resolve_evidence(job, {})
        self.assertEqual(answer, "/autoclick: toggle attacks.")
        self.assertEqual(facts[0]["evidence"], "/autoclick # toggle attacks")
        self.assertEqual(facts[0]["source"], job["source_id"])
        self.assertEqual(facts[0]["source_version"], "abc")
        self.assertEqual(facts[0]["line_number"], 4)


class QuestionGroundingTests(unittest.TestCase):
    def test_rejects_question_broader_than_target_line(self) -> None:
        job = {
            "target_line": (
                "| `/mail send <player>` | Open a shipping inventory. "
                "| `enthusiaexpress.packages.send` |"
            ),
            "repository": "Enthusia-Express",
            "path": "README.md",
        }
        parsed = {
            "user": "What permissions are required for sending mail or announcements?"
        }
        self.assertFalse(mod._question_is_grounded(job, parsed))

    def test_accepts_specific_permission_question(self) -> None:
        job = {
            "target_line": (
                "| `/mail send <player>` | Open a shipping inventory. "
                "| `enthusiaexpress.packages.send` |"
            ),
            "repository": "Enthusia-Express",
            "path": "README.md",
        }
        parsed = {
            "user": "What permission is required for /mail send?"
        }
        self.assertTrue(mod._question_is_grounded(job, parsed))


if __name__ == "__main__":
    unittest.main()
