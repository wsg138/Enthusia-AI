from __future__ import annotations

import json
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REGISTRY = HERE / "repositories.json"


class SourceRegistryAuthorityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        cls.repositories = {
            entry["name"]: entry
            for entry in cls.registry["repositories"]
            if entry.get("include")
        }

    def test_verified_stale_forks_use_canonical_upstreams(self) -> None:
        expected = {
            "Enthusia-Express": ("FainNeito", "main"),
            "LumaGuilds": ("BadgersMC", "main"),
            "EnthusiaMarket": ("BadgersMC", "main"),
        }
        for name, (owner, branch) in expected.items():
            self.assertEqual(self.repositories[name]["owner"], owner)
            self.assertEqual(self.repositories[name]["default_branch"], branch)

    def test_live_audit_missing_repositories_are_registered(self) -> None:
        expected = {
            "EnthusiaAdvancements": ("BadgersMC", "main"),
            "EnthusiaBiomes": ("BadgersMC", "master"),
            "EnthusiaGiveaway": ("BadgersMC", "main"),
            "LumaTrivia": ("BadgersMC", "main"),
        }
        for name, (owner, branch) in expected.items():
            entry = self.repositories[name]
            self.assertEqual((entry["owner"], entry["default_branch"]), (owner, branch))
            self.assertTrue(entry["use_for_rag"])
            self.assertTrue(entry["use_for_synthetic_grounding"])
            self.assertFalse(entry["direct_sft"])

    def test_unresolved_plugins_are_explicit_and_denied_from_source_corpora(self) -> None:
        unresolved = {
            entry["plugin"]: entry
            for entry in self.registry["unresolved_sources"]
        }
        self.assertEqual(set(unresolved), {"EnthusiaDisplay", "EnthusiaMapShields"})
        for entry in unresolved.values():
            self.assertEqual(entry["status"], "source_unresolved")
            self.assertFalse(entry["include_in_github_collection"])
            self.assertFalse(entry["use_for_rag"])
            self.assertFalse(entry["use_for_synthetic_grounding"])


if __name__ == "__main__":
    unittest.main()
