#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

EXPECTED_ATTEMPTS = 10


def _load_results(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as handle:
        results = [json.loads(line) for line in handle if line.strip()]
    if len(results) != EXPECTED_ATTEMPTS:
        raise ValueError(
            f"owner review requires exactly {EXPECTED_ATTEMPTS} attempted examples; "
            f"found {len(results)}"
        )
    return results


def _status(result: dict) -> str:
    if result.get("request_error") or result.get("validation_problems"):
        return "rejected"
    parsed = result.get("parsed")
    if isinstance(parsed, dict) and parsed.get("skip") is True:
        return "skipped"
    return "accepted"


def _safe_text(value: object, fallback: str = "—") -> str:
    if not isinstance(value, str) or not value.strip():
        return fallback
    return value.strip().replace("\r", " ")


def _question(result: dict) -> str:
    parsed = result.get("parsed")
    if not isinstance(parsed, dict) or parsed.get("content_withheld"):
        return "—"
    return _safe_text(parsed.get("user"))


def _assistant(result: dict) -> str:
    if _status(result) != "accepted":
        return "—"
    parsed = result.get("parsed")
    return _safe_text(parsed.get("assistant")) if isinstance(parsed, dict) else "—"


def _problem_text(result: dict) -> str:
    problems = result.get("validation_problems")
    if isinstance(problems, list) and problems:
        return ", ".join(str(problem) for problem in problems)
    error = result.get("request_error")
    return _safe_text(error) if error else "—"


def _reviewer_note(result: dict) -> str:
    status = _status(result)
    if status == "accepted":
        mode = result.get("response_mode")
        profile = result.get("familiarity_profile")
        return f"Review tone and factual fit ({mode}, {profile})."
    if status == "skipped":
        return "Confirm skipping this evidence is reasonable."
    if result.get("request_error"):
        return "Model request failed; this is not a candidate."
    return "Check validator rejection; regenerate systemically if the problem is recurring."


def _evidence_block(result: dict) -> str:
    entries = result.get("evidence")
    if not isinstance(entries, list) or not entries:
        return "—"
    rendered = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        number = entry.get("line_number", "?")
        text = _safe_text(entry.get("text"))
        rendered.append(f"L{number}: {text}")
    return "\n".join(rendered) if rendered else "—"


def _ranges(result: dict) -> str:
    ranges = result.get("evidence_ranges")
    if not isinstance(ranges, list):
        return "—"
    rendered = []
    for item in ranges:
        if not isinstance(item, dict):
            continue
        start = item.get("start_line")
        end = item.get("end_line")
        rendered.append(f"L{start}" if start == end else f"L{start}-L{end}")
    return ", ".join(rendered) if rendered else "—"


def _render_attempt(index: int, result: dict) -> str:
    fence = chr(96) * 3
    return "\n".join([
        f"## {index}. {_status(result).upper()} — {result.get('repository', 'unknown')}",
        "",
        f"- **Question:** {_question(result)}",
        f"- **Proposed answer:** {_assistant(result)}",
        f"- **Visibility:** {result.get('visibility', '—')}",
        f"- **Response mode / familiarity:** {result.get('response_mode', '—')} / " +
        f"{result.get('familiarity_profile', '—')}",
        f"- **Source:** {result.get('repository', '—')}/{result.get('path', '—')}",
        f"- **Source SHA/version:** {result.get('source_version', '—')}",
        f"- **Evidence ranges:** {_ranges(result)}",
        "- **Exact evidence:**",
        fence + "text",
        _evidence_block(result),
        fence,
        f"- **Validator problems:** {_problem_text(result)}",
        f"- **Reviewer note:** {_reviewer_note(result)}",
        "",
    ])


def render(results: list[dict]) -> str:
    counts = {"accepted": 0, "skipped": 0, "rejected": 0}
    for result in results:
        counts[_status(result)] += 1
    header = [
        "# Enthusia AI — 10-Candidate Owner Review",
        "",
        "> Review-only synthetic candidates. Nothing in this artifact is admitted to " +
        "W16 or training data.",
        "",
        f"Accepted: **{counts['accepted']}** · Skipped: **{counts['skipped']}** · " +
        f"Rejected: **{counts['rejected']}**",
        "",
    ]
    attempts = [
        _render_attempt(index, result)
        for index, result in enumerate(results, 1)
    ]
    return "\n".join([*header, *attempts])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    results = _load_results(args.results)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(results), encoding="utf-8")
    print(
        json.dumps(
            {
                "attempts": len(results),
                "output": str(output),
                "status": "owner_review_only_not_training_data",
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())