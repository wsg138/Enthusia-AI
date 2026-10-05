#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "generation_benchmark",
    HERE / "run_generation_benchmark.py",
)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)



BUILD_SPEC = importlib.util.spec_from_file_location(
    "generation_jobs",
    HERE / "build_generation_jobs.py",
)
assert BUILD_SPEC is not None and BUILD_SPEC.loader is not None
jobs_mod = importlib.util.module_from_spec(BUILD_SPEC)
BUILD_SPEC.loader.exec_module(jobs_mod)


COLLECT_SPEC = importlib.util.spec_from_file_location(
    "collect_github_sources",
    HERE / "collect_github_sources.py",
)
assert COLLECT_SPEC is not None and COLLECT_SPEC.loader is not None
collect_mod = importlib.util.module_from_spec(COLLECT_SPEC)
COLLECT_SPEC.loader.exec_module(collect_mod)


PREFLIGHT_SPEC = importlib.util.spec_from_file_location(
    "pc_preflight",
    HERE / "pc_preflight.py",
)
assert PREFLIGHT_SPEC is not None and PREFLIGHT_SPEC.loader is not None
preflight_mod = importlib.util.module_from_spec(PREFLIGHT_SPEC)
PREFLIGHT_SPEC.loader.exec_module(preflight_mod)


class BootstrapSecurityTests(unittest.TestCase):
    def test_github_coordinates_accept_current_safe_shapes(self) -> None:
        self.assertEqual(collect_mod.validate_github_owner("wsg138"), "wsg138")
        self.assertEqual(
            collect_mod.validate_github_repository("Enthusia-AI"),
            "Enthusia-AI",
        )
        self.assertEqual(
            collect_mod.validate_git_branch("training/bootstrap-data-prep"),
            "training/bootstrap-data-prep",
        )

    def test_github_coordinates_reject_option_and_path_injection(self) -> None:
        invalid_values = [
            (collect_mod.validate_github_owner, "wsg138;echo"),
            (collect_mod.validate_github_repository, "../other"),
            (collect_mod.validate_git_branch, "--upload-pack=evil"),
            (collect_mod.validate_git_branch, "feature/../main"),
        ]
        for validator, value in invalid_values:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    validator(value)

    @mock.patch.object(collect_mod.subprocess, "run")
    def test_collect_subprocess_uses_resolved_argv_without_shell(
        self,
        run_mock: mock.Mock,
    ) -> None:
        run_mock.return_value = mock.Mock(
            returncode=0,
            stdout="ok\n",
            stderr="",
        )
        executable = pathlib.Path(sys.executable).resolve()
        self.assertEqual(
            collect_mod._run_checked(executable, ["--version"]),
            "ok",
        )
        run_mock.assert_called_once_with(
            [str(executable), "--version"],
            cwd=None,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
            shell=False,
        )

    @mock.patch.object(preflight_mod.subprocess, "run")
    def test_preflight_subprocess_uses_resolved_argv_without_shell(
        self,
        run_mock: mock.Mock,
    ) -> None:
        run_mock.return_value = mock.Mock(
            returncode=0,
            stdout="ok\n",
            stderr="",
        )
        executable = pathlib.Path(sys.executable).resolve()
        report = preflight_mod.run_command(executable, ["--version"])
        self.assertTrue(report["ok"])
        run_mock.assert_called_once_with(
            [str(executable), "--version"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            shell=False,
        )


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

    def test_command_table_detects_permission_column_by_shape(self) -> None:
        raw = (
            "| `/guild create <name> [banner]` | "
            "`lumaguilds.guild.create` | Create a new guild | "
            "`/guild create MyGuild diamond_banner` |"
        )
        self.assertEqual(
            mod._clean_display_line(raw),
            "/guild create <name> [banner]: Create a new guild "
            "Permission: lumaguilds.guild.create "
            "Example: /guild create MyGuild diamond_banner",
        )

    def test_yaml_usage_removes_color_codes_and_duplicate_usage(self) -> None:
        self.assertEqual(
            mod._clean_display_line(
                'usage: "&eUsage: /itemshops search <item> [sell|buy|any] [page]"'
            ),
            "Usage: /itemshops search <item> [sell|buy|any] [page]",
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

    def test_rejects_question_with_unsupported_reputation_scope(self) -> None:
        job = {
            "target_line": "| **Good Stall** | Ran a fair/reliable market stall |",
            "repository": "EnthusiaCommend",
            "path": "PLAYER_GUIDE.md",
        }
        parsed = {
            "user": "How can I earn a Good Stall reputation point?"
        }
        self.assertFalse(mod._question_is_grounded(job, parsed))

    def test_trailing_semicolon_does_not_become_semicolon_period(self) -> None:
        job = {
            "target_line": "- the configured permission, normally `startupguardian.bypass`;",
            "source_id": "github:wsg138/StartupGuardian@abc:README.md#line-1",
            "source_version": "abc",
            "line_number": 1,
        }
        _, answer = mod._resolve_evidence(job, {})
        self.assertEqual(
            answer,
            "the configured permission, normally startupguardian.bypass.",
        )




class SourceSelectionTests(unittest.TestCase):
    def test_legacy_docs_are_excluded(self) -> None:
        record = {
            "role": "staff_system",
            "repository": "EnthusiaStaff",
            "path": "docs/wiki/legacy/old/Commands.md",
        }
        self.assertLess(jobs_mod.path_score(record), 0)

    def test_test_rollout_docs_are_excluded(self) -> None:
        record = {
            "role": "support_system",
            "repository": "enthusia-support-bot",
            "path": "docs/ai/TEST_ROLLOUT.md",
        }
        self.assertLess(jobs_mod.path_score(record), 0)

    def test_header_only_line_is_excluded(self) -> None:
        record = {"path": "README.md"}
        self.assertLess(
            jobs_mod.line_score(record, "Enable uploads in config.yml:", 50),
            0,
        )

    def test_admin_reload_line_is_staff_visibility(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "path": "README.md",
        }
        self.assertEqual(
            jobs_mod.source_visibility(record, "/pearlglitchblocker reload"),
            "staff",
        )

    def test_mixed_usage_with_reload_debug_is_staff_visibility(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "path": "src/main/resources/plugin.yml",
        }
        self.assertEqual(
            jobs_mod.source_visibility(
                record,
                "usage: /enthusiadonors <reload|refresh|status|top|debug>",
            ),
            "staff",
        )



    def test_developer_handoff_paths_are_excluded(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "repository": "EnthusiaLoreItems",
            "path": "handoffs/0016-codacy-evidence-blocker.md",
        }
        self.assertLess(jobs_mod.path_score(record), 0)

    def test_ai_agent_workspace_paths_are_excluded(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "repository": "PieCloak",
            "path": "ai-agents/WORKSPACE-STATE.md",
        }
        self.assertLess(jobs_mod.path_score(record), 0)

    def test_warzone_and_shopmarket_commands_are_staff_visibility(self) -> None:
        record = {"role": "minecraft_plugin", "path": "README.md"}
        self.assertEqual(
            jobs_mod.source_visibility(record, "/warzone schedule enable"),
            "staff",
        )
        self.assertEqual(
            jobs_mod.source_visibility(record, "/shopmarket set <radius>"),
            "staff",
        )

    def test_admin_docs_path_is_staff_visibility(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "path": "wiki/docs/admins/permissions.md",
        }
        self.assertEqual(
            jobs_mod.source_visibility(record, "enthusiamarket.shop.help"),
            "staff",
        )

    def test_rule_question_requires_rule_evidence(self) -> None:
        job = {
            "target_line": "| **Gave Items/Money** | Fairly gave items or money |",
            "repository": "EnthusiaCommend",
            "path": "PLAYER_GUIDE.md",
        }
        parsed = {"user": "What does the Gave Items/Money rule mean?"}
        self.assertFalse(mod._question_is_grounded(job, parsed))


if __name__ == "__main__":
    unittest.main()
