from __future__ import annotations

import unittest

from training.bootstrap.test_generation_helpers import _job, _parsed, mod


class NaturalResponseRegressionTests(unittest.TestCase):
    def test_mail_is_natural_and_permission_node_free(self) -> None:
        job = _job([
            "/mail opens your mailbox. Arrows change pages; tabs change categories: " +
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
            "When deployed, /event shows the current event and phase, or reports that " +
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
            "When deployed, /event shows the current event and phase, or reports that " +
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
            "Can I use the staff event tool?",
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

    def test_staff_boundary_rejects_subcommand_without_slash(self) -> None:
        job = _job(
            ["Staff-only command: /ee reload reloads event configuration."],
            visibility="staff", response_mode="player_boundary",
        )
        parsed = _parsed(
            "Can I use the staff event tool?",
            "That reload action is for staff. Tell me your player goal.",
        )
        self.assertIn("staff_subcommand_leak", mod.validate_output(job, parsed))

    def test_staff_boundary_rejects_syntax_in_question(self) -> None:
        job = _job(
            ["Staff-only command: /ee reload reloads event configuration."],
            visibility="staff", response_mode="player_boundary",
        )
        parsed = _parsed("Can I use /ee reload?", "That is staff-only.")
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

    def test_command_and_number_must_match_complete_literals(self) -> None:
        job = _job(["/mailbox opens the mailbox after 10 seconds."])
        parsed = _parsed("How do I open the mailbox?", "Use /mail after 1 second.")
        problems = mod.validate_output(job, parsed)
        self.assertIn("unsupported_command", problems)
        self.assertIn("unsupported_number", problems)

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


if __name__ == "__main__":
    unittest.main()
