"""Evaluation hooks: run W20's golden suite before and after a fine-tune.

W20 owns the evaluation harness (`training/evaluation`, PR #9). This
module wires it into the fine-tune pipeline:

- `run_before(config)` — run the golden suite against the base model /
  baseline system BEFORE training. Frozen partitions (test, owner_golden)
  are evaluation-only; the hook never trains on them (spec section 7).
- `run_after(config)` — run the same suite against the fine-tuned model
  AFTER training/export.
- `compare(before, after)` — score deltas for the run report.

The hook invokes a configurable eval command (default: the W20 CLI in a
checked-out workstream tree). For a real model, W20's harness must be
pointed at the model endpoint — that adapter lives in W20, not here; this
module just runs the command and records the reports.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass

DEFAULT_EVAL_CMD = ("node", "dist/cli.js")


class EvalHookError(RuntimeError):
    """Raised when an evaluation hook fails."""


@dataclass(frozen=True)
class EvalResult:
    phase: str  # "before" | "after"
    report_path: str
    summary: dict

    def as_dict(self) -> dict:
        return {"phase": self.phase, "report_path": self.report_path, **self.summary}


def _summarize_report(report: dict) -> dict:
    """Best-effort summary: pass rates and totals from a W20 report."""
    summary: dict = {}
    for key in ("pass_rate", "passed", "failed", "total", "score", "scores"):
        if key in report:
            summary[key] = report[key]
    # Recurse one level for nested suite results.
    for key, val in report.items():
        if isinstance(val, dict) and key not in summary:
            sub = {k: v for k, v in val.items() if isinstance(v, (int, float, str))}
            if sub:
                summary[key] = sub
    return summary


def run_suite(
    *,
    eval_dir: str,
    report_path: str,
    phase: str,
    eval_cmd: tuple[str, ...] | list[str] = DEFAULT_EVAL_CMD,
    extra_args: list[str] | None = None,
    timeout_s: int = 600,
    require_frozen: bool = True,
) -> EvalResult:
    """Run the W20 golden suite once and record the report.

    eval_dir: directory containing the built W20 evaluation package
              (with dist/cli.js after `npm run build`).
    report_path: where to write the JSON report.
    phase: "before" or "after".
    eval_cmd: command template; the report path is appended as the last
              `--out <report>` argument for the default W20 CLI.
    """
    if phase not in ("before", "after"):
        raise EvalHookError(f"phase must be 'before' or 'after', got {phase!r}")
    if not os.path.isdir(eval_dir):
        raise EvalHookError(f"evaluation dir not found: {eval_dir}")

    cmd = list(eval_cmd)
    # The W20 CLI writes its JSON report with `--out <file>`.
    cmd += ["--out", report_path, *(extra_args or [])]
    os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)

    try:
        proc = subprocess.run(
            cmd, cwd=eval_dir, capture_output=True, text=True, timeout=timeout_s
        )
    except FileNotFoundError as exc:
        raise EvalHookError(
            f"eval command not runnable in {eval_dir!r}: {exc}. "
            "Build W20's evaluation package first (`npm run build`)."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise EvalHookError(f"eval suite timed out after {timeout_s}s") from exc

    if proc.returncode != 0:
        raise EvalHookError(
            f"eval suite failed (rc={proc.returncode}):\n{proc.stderr[-2000:]}"
        )
    if not os.path.isfile(report_path):
        raise EvalHookError(
            f"eval suite exited 0 but wrote no report at {report_path!r}"
        )
    with open(report_path, encoding="utf-8") as fh:
        report = json.load(fh)
    if require_frozen:
        dataset = report.get("dataset")
        if not isinstance(dataset, dict) or dataset.get("frozen") is not True:
            raise EvalHookError(
                "evaluation report is not from a frozen golden dataset; "
                "fine-tune before/after comparisons must not use seed or mutable cases"
            )
    return EvalResult(
        phase=phase, report_path=report_path, summary=_summarize_report(report)
    )


def compare(before: EvalResult, after: EvalResult) -> dict:
    """Compute simple before/after deltas for numeric top-level scores."""
    deltas: dict = {}
    keys = set(before.summary) & set(after.summary)
    for key in sorted(keys):
        b, a = before.summary[key], after.summary[key]
        if isinstance(b, (int, float)) and isinstance(a, (int, float)):
            deltas[key] = {"before": b, "after": a, "delta": a - b}
    return {
        "before": before.as_dict(),
        "after": after.as_dict(),
        "deltas": deltas,
    }


__all__ = [
    "DEFAULT_EVAL_CMD",
    "EvalHookError",
    "EvalResult",
    "run_suite",
    "compare",
]
