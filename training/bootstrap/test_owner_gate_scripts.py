from pathlib import Path
import unittest


BOOTSTRAP = Path(__file__).resolve().parent


class OwnerGateScriptTests(unittest.TestCase):
    def test_exact_ten_wrapper_is_bounded_and_renders_review(self) -> None:
        text = (BOOTSTRAP / "Run-Qwen35-Owner-Review-10.cmd").read_text(
            encoding="utf-8"
        )
        self.assertIn("--limit 10", text)
        self.assertIn("render_owner_review.py", text)
        self.assertIn("STOP HERE", text)
        self.assertNotIn("--limit 30", text)
        self.assertIn("Refusing to kill or reuse an unidentified listener", text)

    def test_shared_launcher_refuses_occupied_port(self) -> None:
        text = (BOOTSTRAP / "Start-Qwen35-Baseline.cmd").read_text(encoding="utf-8")
        self.assertIn("port 8091 is already in use", text)
        self.assertNotIn("taskkill /PID %%P", text)

    def test_generic_thirty_runner_requires_explicit_opt_in(self) -> None:
        generic = (BOOTSTRAP / "Run-Baseline-Generation-Benchmark.cmd").read_text(
            encoding="utf-8"
        )
        explicit = (BOOTSTRAP / "Run-Qwen35-Baseline-30.cmd").read_text(
            encoding="utf-8"
        )
        self.assertIn("--limit 30", generic)
        self.assertIn('ENTHUSIA_ALLOW_30%"=="YES', generic)
        self.assertIn('set "ENTHUSIA_ALLOW_30=YES"', explicit)


if __name__ == "__main__":
    unittest.main()
