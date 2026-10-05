#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent


def _load_module(name: str, filename: str) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load bootstrap module: {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_module("generation_benchmark", "run_generation_benchmark.py")
jobs_mod = _load_module("generation_jobs", "build_generation_jobs.py")
collect_mod = _load_module("collect_github_sources", "collect_github_sources.py")
preflight_mod = _load_module("pc_preflight", "pc_preflight.py")
review_mod = _load_module("owner_review", "render_owner_review.py")
convert_mod = _load_module("validated_converter", "convert_validated_generation.py")


def _job(
    evidence_lines: list[str],
    *,
    visibility: str = "public",
    response_mode: str = "player_support",
    profile: str = "novice",
    authority: str = "requires_deployment_verification",
    repository: str = "Example",
    path: str = "PLAYER_GUIDE.md",
    target: int = 0,
) -> dict:
    entries = [
        {"line_number": index + 1, "text": line, "visibility": visibility}
        for index, line in enumerate(evidence_lines)
    ]
    return {
        "job_id": "ground-test",
        "source_id": f"github:wsg138/{repository}@abc:{path}#line-{target + 1}",
        "source_version": "abc",
        "repository": repository,
        "path": path,
        "line_number": target + 1,
        "target_line": evidence_lines[target],
        "visibility": visibility,
        "response_mode": response_mode,
        "familiarity_profile": profile,
        "production_authority": authority,
        "evidence": entries,
        "evidence_ranges": [{"start_line": 1, "end_line": len(entries)}],
        "evidence_text": "\n".join(
            f"L{entry['line_number']}: {entry['text']}" for entry in entries
        ),
    }


def _parsed(user: str, assistant: str, category: str = "commands") -> dict:
    return {
        "category": category,
        "scenario": "Player asks for server help",
        "user": user,
        "assistant": assistant,
        "tags": ["support"],
    }


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

    def test_generation_endpoint_rejects_unsafe_schemes_and_credentials(self) -> None:
        self.assertEqual(
            mod._validated_endpoint("http://127.0.0.1:8091"),
            "http://127.0.0.1:8091",
        )
        self.assertEqual(
            mod._validated_endpoint("https://model.example.test:8443"),
            "https://model.example.test:8443",
        )
        for endpoint in (
            "file:///tmp/model.sock",
            "ftp://model.example.test",
            "https://user:secret@model.example.test",
        ):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(ValueError):
                    mod._validated_endpoint(endpoint)

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
        run_mock.return_value = mock.Mock(returncode=0, stdout="ok\n", stderr="")
        executable = pathlib.Path(sys.executable).resolve()
        self.assertEqual(collect_mod._run_checked(executable, ["--version"]), "ok")
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
        run_mock.return_value = mock.Mock(returncode=0, stdout="ok\n", stderr="")
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
            "| /mail inbox [packages\\|letters\\|announcements] "
            "| Open the mailbox. | enthusiaexpress.inbox |"
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
            "| /guild create <name> [banner] | lumaguilds.guild.create | "
            "Create a new guild | /guild create MyGuild diamond_banner |"
        )
        self.assertEqual(
            mod._clean_display_line(raw),
            "/guild create <name> [banner]: Create a new guild "
            "Permission: lumaguilds.guild.create "
            "Example: /guild create MyGuild diamond_banner",
        )

    def test_resolve_evidence_preserves_model_answer_and_provenance(self) -> None:
        job = _job(["/autoclick # toggle attacks"])
        facts, answer = mod._resolve_evidence(
            job,
            {"assistant": "Use /autoclick to toggle attacks."},
        )
        self.assertEqual(answer, "Use /autoclick to toggle attacks.")
        self.assertEqual(facts[0]["evidence"], "/autoclick # toggle attacks")
        self.assertEqual(facts[0]["source"], job["source_id"])
        self.assertEqual(facts[0]["line_number"], 1)


class QuestionGroundingTests(unittest.TestCase):
    def test_rejects_question_broader_than_evidence(self) -> None:
        job = _job([
            "| /mail send <player> | Open a shipping inventory. | "
            "enthusiaexpress.packages.send |"
        ])
        parsed = {"user": "What permissions are required for sending mail or announcements?"}
        self.assertFalse(mod._question_is_grounded(job, parsed))

    def test_accepts_specific_permission_question(self) -> None:
        job = _job([
            "| /mail send <player> | Open a shipping inventory. | "
            "enthusiaexpress.packages.send |"
        ])
        parsed = {"user": "What permission is required for /mail send?"}
        self.assertTrue(mod._question_is_grounded(job, parsed))

    def test_rejects_question_with_unsupported_reputation_scope(self) -> None:
        job = _job(
            ["| Good Stall | Ran a fair/reliable market stall |"],
            repository="EnthusiaCommend",
        )
        parsed = {"user": "How can I earn a Good Stall reputation point?"}
        self.assertFalse(mod._question_is_grounded(job, parsed))

    def test_current_phase_is_not_treated_as_deployment_claim(self) -> None:
        job = _job(["| /event | Shows the current event and phase. |"])
        parsed = _parsed(
            "What does /event show?",
            "Use /event to see the current event and phase.",
        )
        self.assertNotIn("unsupported_production_claim", mod.validate_output(job, parsed))


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

    def test_generic_table_header_is_not_a_target(self) -> None:
        record = {"path": "PLAYER_GUIDE.md"}
        self.assertLess(
            jobs_mod.line_score(record, "| Command | Behavior |", 50),
            0,
        )

    def test_admin_reload_line_is_staff_visibility(self) -> None:
        record = {"role": "minecraft_plugin", "path": "README.md"}
        self.assertEqual(
            jobs_mod.source_visibility(record, "/pearlglitchblocker reload"),
            "staff",
        )

    def test_staff_heading_marks_context_staff(self) -> None:
        record = {"role": "minecraft_plugin", "path": "PLAYER_GUIDE.md"}
        lines = ["## Administrative command", "Reloads configuration."]
        self.assertEqual(jobs_mod.contextual_visibility(record, lines, 1), "staff")

    def test_good_stall_window_includes_intro_and_category_context(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "repository": "EnthusiaCommend",
            "path": "PLAYER_GUIDE.md",
        }
        lines = [
            "# EnthusiaCommend — SMP Player Guide",
            "",
            "This file documents the current player-facing reputation system on Enthusia SMP.",
            "",
            "## Reputation categories",
            "The defaults below apply to new votes.",
            "",
            "### Positive (default +1)",
            "| Category | Intended use |",
            "| --- | --- |",
            "| Good Stall | Ran a fair/reliable market stall |",
        ]
        entries, ranges, text = jobs_mod.build_evidence_window(record, lines, 10)
        self.assertIn("player-facing reputation system", text)
        self.assertIn("Good Stall", text)
        self.assertLessEqual(len(entries), 12)
        self.assertTrue(ranges)

    def test_baltop_window_captures_command_and_gui_behavior(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "repository": "EnthusiaCurrency",
            "path": "PLAYER_GUIDE.md",
        }
        lines = [
            "# EnthusiaCurrency — SMP Player Guide",
            "Values checked against the live production configuration.",
            "## Balance leaderboard",
            "/baltop [page]",
            "opens the production balance leaderboard GUI.",
            "The current GUI is enabled and refreshes about every 15 seconds.",
        ]
        _, _, text = jobs_mod.build_evidence_window(record, lines, 3)
        self.assertIn("/baltop [page]", text)
        self.assertIn("balance leaderboard GUI", text)
        self.assertLessEqual(len(text), jobs_mod.MAX_EVIDENCE_CHARS)

    def test_public_window_does_not_absorb_staff_section(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "repository": "Example",
            "path": "PLAYER_GUIDE.md",
        }
        lines = [
            "## Player command",
            "/mail opens your mailbox and shows letters.",
            "## Administrative command",
            "/mail reload reloads internal configuration.",
        ]
        entries, _, _ = jobs_mod.build_evidence_window(record, lines, 1)
        self.assertTrue(all(entry["visibility"] == "public" for entry in entries))
        self.assertFalse(any("reload" in entry["text"] for entry in entries))

    def test_public_candidate_builds_novice_and_familiar_variants(self) -> None:
        record = {
            "role": "minecraft_plugin",
            "repository": "Example",
            "path": "PLAYER_GUIDE.md",
            "commit_sha": "abc",
            "production_authority": "requires_deployment_verification",
        }
        lines = ["/mail opens the player mailbox."]
        variants = jobs_mod._jobs_for_candidate(100, record, 0, lines)
        self.assertEqual(
            [variant["familiarity_profile"] for variant in variants],
            ["novice", "familiar"],
        )
        self.assertEqual(variants[0]["evidence"], variants[1]["evidence"])


class NaturalResponseRegressionTests(unittest.TestCase):
    def test_mail_is_natural_and_permission_node_free(self) -> None:
        job = _job([
            "/mail opens your mailbox. Arrows change pages; tabs change categories: "
            "packages, letters, announcements. Permission: enthusiaexpress.inbox"
        ], repository="Enthusia-Express")
        parsed = _parsed(
            "How do I open and use my mailbox?",
            "Yep! Just type /mail to open your mailbox. Use the arrows to change pages, "
            "and the tabs to switch between packages, letters, and announcements.",
        )
        self.assertEqual(mod.validate_output(job, parsed), [])

    def test_event_answer_is_concise_and_grounded(self) -> None:
        job = _job([
            "When deployed, /event shows the current event and phase, or reports that "
            "no event is running."
        ], repository="EnthusiaEvents")
        parsed = _parsed(
            "What does /event do?",
            "When deployed, /event shows the current event and phase, or tells you "
            "when no event is running.",
        )
        self.assertEqual(mod.validate_output(job, parsed), [])

    def test_event_requires_deployment_qualification(self) -> None:
        job = _job([
            "When deployed, /event shows the current event and phase, or reports that "
            "no event is running."
        ], repository="EnthusiaEvents")
        parsed = _parsed(
            "What does /event do?",
            "/event shows the current event and phase.",
        )
        self.assertIn(
            "missing_deployment_qualification",
            mod.validate_output(job, parsed),
        )

    def test_autoclick_one_is_human_readable(self) -> None:
        job = _job([
            "| /autoclick 1 | every tick / up to 20 attempts per second |"
        ], repository="EnthusiaAutoClicker")
        parsed = _parsed(
            "How fast is /autoclick 1?",
            "/autoclick 1 can try up to about 20 times per second.",
        )
        self.assertEqual(mod.validate_output(job, parsed), [])

    def test_staff_backend_command_redirect_does_not_expose_syntax(self) -> None:
        job = _job(
            ["Staff-only command: /ee reload reloads event configuration."],
            visibility="staff",
            response_mode="player_boundary",
            repository="EnthusiaEvents",
        )
        parsed = _parsed(
            "What does the staff event reload command do?",
            "That's a staff-only tool, so you don't need those commands. "
            "Tell me what you're trying to do and I can help you find the player option.",
        )
        self.assertEqual(mod.validate_output(job, parsed), [])

    def test_staff_boundary_rejects_command_leak(self) -> None:
        job = _job(
            ["Staff-only command: /ee reload reloads event configuration."],
            visibility="staff",
            response_mode="player_boundary",
        )
        parsed = _parsed(
            "How do staff reload events?",
            "Use /ee reload to reload the configuration.",
        )
        self.assertIn("staff_command_leak", mod.validate_output(job, parsed))

    def test_good_stall_uses_context_without_inventing_earning_mechanism(self) -> None:
        job = _job([
            "This guide documents Enthusia's player-facing reputation system.",
            "### Positive reputation options",
            "| Good Stall | Ran a fair and reliable market stall |",
        ], repository="EnthusiaCommend", target=2)
        parsed = _parsed(
            "What is Good Stall?",
            "Enthusia has a player reputation system. Good Stall is a positive option "
            "meant for a fair and reliable market stall.",
            category="onboarding",
        )
        self.assertEqual(mod.validate_output(job, parsed), [])

    def test_good_stall_rejects_invented_earning_mechanism(self) -> None:
        job = _job([
            "This guide documents Enthusia's player-facing reputation system.",
            "| Good Stall | Ran a fair and reliable market stall |",
        ], repository="EnthusiaCommend", target=1)
        parsed = _parsed(
            "What is Good Stall?",
            "You earn Good Stall when you run a fair market stall.",
            category="onboarding",
        )
        self.assertIn("unsupported_mechanism_claim", mod.validate_output(job, parsed))

    def test_unsupported_fact_fails_validation(self) -> None:
        job = _job(["/baltop opens the balance leaderboard GUI."])
        parsed = _parsed(
            "What does /baltop do?",
            "/baltop opens the leaderboard and costs 500 diamonds.",
        )
        problems = mod.validate_output(job, parsed)
        self.assertTrue(
            {"unsupported_number", "answer_not_fully_grounded"}.intersection(problems)
        )

    def test_unnecessary_permission_node_fails(self) -> None:
        job = _job([
            "/mail opens the mailbox. Permission: enthusiaexpress.inbox"
        ])
        parsed = _parsed(
            "How do I open my mailbox?",
            "Use /mail. The permission is enthusiaexpress.inbox.",
        )
        self.assertIn("unnecessary_permission_node", mod.validate_output(job, parsed))

    def test_elite_rank_is_rejected(self) -> None:
        job = _job(["Ranks include Member and Supporter."], path="RANKS.md")
        parsed = _parsed(
            "What rank is above Member?",
            "Elite is above Member.",
            category="rank",
        )
        self.assertIn("forbidden_elite_rank", mod.validate_output(job, parsed))

    def test_general_player_fly_is_rejected(self) -> None:
        job = _job(["Players can use /spawn to return to spawn."])
        parsed = _parsed(
            "How do I get around?",
            "Normal players can use /fly anywhere.",
        )
        self.assertIn("forbidden_general_fly", mod.validate_output(job, parsed))

    def test_secret_material_is_rejected(self) -> None:
        job = _job(["The support command opens a help menu."])
        parsed = _parsed(
            "How do I get support?",
            "Use the menu. password=SuperSecretValue123",
        )
        self.assertIn("secret_pattern_in_output", mod.validate_output(job, parsed))

    def test_nonproduction_evidence_cannot_become_live_truth(self) -> None:
        job = _job(
            ["Staging reference: /event is available for testing."],
            authority="non_production_reference",
        )
        parsed = _parsed(
            "Is /event available?",
            "/event is live on the server right now.",
        )
        self.assertIn("unsupported_production_claim", mod.validate_output(job, parsed))

    def test_public_job_rejects_staff_evidence_mixed_into_window(self) -> None:
        job = _job(["/mail opens your mailbox."])
        job["evidence"].append({
            "line_number": 2,
            "text": "/mail reload is a staff-only command.",
            "visibility": "staff",
        })
        job["evidence_text"] += "\nL2: /mail reload is a staff-only command."
        parsed = _parsed("How do I open mail?", "Use /mail to open your mailbox.")
        self.assertIn("staff_evidence_in_public_window", mod.validate_output(job, parsed))


class PersistenceAndReviewTests(unittest.TestCase):
    def test_runner_result_envelope_preserves_bounded_provenance(self) -> None:
        job = _job(["/mail opens your mailbox."])
        envelope = mod._result_envelope(job)
        self.assertEqual(envelope["evidence"], job["evidence"])
        self.assertEqual(envelope["evidence_ranges"], job["evidence_ranges"])
        self.assertNotIn("prompt", envelope)

    def test_owner_review_requires_exactly_ten_attempts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = pathlib.Path(temp_dir) / "results.jsonl"
            path.write_text(json.dumps({"job_id": "one"}) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                review_mod._load_results(str(path))

    def test_converter_preserves_profile_mode_and_review_gate(self) -> None:
        job = _job(["/mail opens your mailbox."])
        parsed = _parsed("How do I open mail?", "Use /mail to open your mailbox.")
        parsed = mod._attach_validated_fields(job, parsed)
        result = {**mod._result_envelope(job), "parsed": parsed, "validation_problems": []}
        record = convert_mod.convert(result)
        self.assertIsNotNone(record)
        self.assertEqual(record["familiarity_profile"], "novice")
        self.assertEqual(record["response_mode"], "player_support")
        self.assertEqual(record["admission_status"], "owner_review_required")


if __name__ == "__main__":
    unittest.main()
