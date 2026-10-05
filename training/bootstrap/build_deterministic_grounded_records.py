#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
from pathlib import Path

from run_generation_benchmark import _clean_display_line, _split_markdown_table_row

KNOWLEDGE_TOOL = "knowledge.search"

SOURCE_EXTS = {".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}
GENERIC_TABLE_HEADERS = {
    "command", "commands", "permission", "permissions", "description",
    "feature", "features", "setting", "settings", "option", "options",
    "name", "value", "default", "example", "examples", "status",
}


def _strip_markup(text: str) -> str:
    return (
        text.strip()
        .replace("**", "")
        .replace("__", "")
        .replace("`", "")
        .replace("\\|", "|")
    )


def _command_root(text: str) -> str | None:
    match = re.search(r"(?<![A-Za-z0-9_])(/[A-Za-z][A-Za-z0-9_-]*)", text)
    return match.group(1) if match else None


def derive_question(target_line: str, repository: str) -> tuple[str, str, list[str]] | None:
    """Return (question, category, tags) for high-confidence structured lines.

    The function is intentionally conservative. It only handles source shapes
    where the question can be derived mechanically without inventing facts.
    """

    line = target_line.strip()
    lower = line.lower()

    # Markdown command table: command/syntax in first cell, description and
    # optional permission/example in later cells.
    if line.startswith("|") and line.endswith("|"):
        cells = _split_markdown_table_row(line)
        if cells and cells[0].startswith("/"):
            syntax = cells[0]
            return (
                f"What does {syntax} do?",
                "commands",
                ["command", _command_root(syntax).lstrip("/") if _command_root(syntax) else "command"],
            )

        # Two-column glossary/feature tables are safe when the first cell is a
        # short label and the second is explanatory text.
        if len(cells) == 2:
            label = _strip_markup(cells[0]).strip()
            detail = _strip_markup(cells[1]).strip()
            label_lower = label.lower()
            path_like = bool(
                re.search(
                    r"(?:\[[^\]]+\]\(|https?://|[\\/]|\.(?:md|yml|yaml|json|py|ts|java|kt)\b)",
                    label,
                    flags=re.I,
                )
            )
            if (
                2 <= len(label) <= 80
                and 4 <= len(detail) <= 300
                and label_lower not in GENERIC_TABLE_HEADERS
                and not path_like
                and not label.startswith(("http://", "https://"))
            ):
                return (
                    f'What does "{label}" mean in {repository}?',
                    "onboarding",
                    ["feature", "documentation"],
                )

    # plugin.yml / config-style usage lines.
    usage_match = re.match(r"(?i)^usage:\s*(.+)$", line)
    if usage_match:
        usage = _strip_markup(usage_match.group(1)).strip().strip('"').strip("'")
        # Some YAML values embed a second literal "Usage:".
        usage = re.sub(r"(?i)^&[0-9A-FK-OR]*usage:\s*", "", usage).strip()
        usage = re.sub(r"(?i)^usage:\s*", "", usage).strip()
        root = _command_root(usage)
        if root:
            return (
                f"What is the documented usage for {root}?",
                "commands",
                ["command", "usage", root.lstrip("/")],
            )

    # Plain slash-command examples/syntax.
    if line.startswith("/"):
        command_part = line.split("#", 1)[0].strip()
        root = _command_root(command_part)
        if root:
            if "#" in line:
                return (
                    f"What does {command_part} do?",
                    "commands",
                    ["command", root.lstrip("/")],
                )
            return (
                f"What is the documented syntax for {root}?",
                "commands",
                ["command", "syntax", root.lstrip("/")],
            )

    # High-confidence permission requirement sentences.
    if re.search(r"(?i)\brequires?\b", line) and re.search(
        r"\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b", line
    ):
        return (
            f"What permission requirement is documented for {repository}?",
            "permissions",
            ["permission", "documentation"],
        )

    return None


def make_record(job: dict) -> dict | None:
    if Path(job.get("path", "")).suffix.lower() in SOURCE_EXTS:
        return None

    derived = derive_question(job["target_line"], job["repository"])
    if derived is None:
        return None

    user, category, derived_tags = derived
    answer = _clean_display_line(job["target_line"]).rstrip(" ;,")
    if not answer or answer.endswith(":"):
        return None
    if answer[-1] not in ".!?":
        answer += "."
    if "\ufffd" in answer or len(answer) > 800 or len(user) > 220:
        return None

    source_result = {
        "source": job["source_id"],
        "source_version": job["source_version"],
        "repository": job["repository"],
        "path": job["path"],
        "line_number": job.get("line_number"),
        "evidence": job["target_line"],
    }

    digest = hashlib.sha256(
        f'{job["job_id"]}\n{user}\n{answer}'.encode("utf-8")
    ).hexdigest()[:16]

    fact = {
        "claim": answer,
        "source": job["source_id"],
        "source_version": job["source_version"],
        "evidence": job["target_line"],
    }
    if job.get("line_number") is not None:
        fact["line_number"] = job["line_number"]

    tags = list(dict.fromkeys([
        category,
        "grounded",
        "retrieval-grounded",
        "deterministic-source",
        *derived_tags,
    ]))

    return {
        "id": f"det-ground-{digest}",
        "source_type": "synthetic",
        "visibility": job.get("visibility", "staff"),
        "scenario": f"User asks for documented {category} information from {job['repository']}.",
        "messages": [
            {"role": "user", "content": user},
            {
                "role": "assistant",
                "content": "I'll verify that against the current indexed source.",
            },
            {
                "role": "tool",
                "content": json.dumps(
                    {"tool": KNOWLEDGE_TOOL, "result": source_result},
                    ensure_ascii=False,
                    sort_keys=True,
                ),
            },
            {"role": "assistant", "content": answer},
        ],
        "tools": [KNOWLEDGE_TOOL],
        "expected_actions": [f"tool:{KNOWLEDGE_TOOL}"],
        "expected_answer": answer,
        "facts": [fact],
        "tags": tags,
        "quality": None,
        "template_id": f"deterministic-grounded:{job['job_id']}",
        "generator": "deterministic-source-grounding-v1",
        "source_repository": job["repository"],
        "source_path": job["path"],
        "source_id": job["source_id"],
        "source_version": job["source_version"],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--per-repo-cap", type=int, default=30)
    args = ap.parse_args()

    records: list[dict] = []
    seen_pairs: set[tuple[str, str]] = set()
    repos: dict[str, int] = {}
    skipped = 0

    with gzip.open(args.jobs, "rt", encoding="utf-8") as fh:
        for raw in fh:
            job = json.loads(raw)
            record = make_record(job)
            if record is None:
                skipped += 1
                continue
            repo = record["source_repository"]
            if repos.get(repo, 0) >= args.per_repo_cap:
                skipped += 1
                continue
            pair = (record["messages"][0]["content"], record["expected_answer"])
            if pair in seen_pairs:
                skipped += 1
                continue
            seen_pairs.add(pair)
            records.append(record)
            repos[repo] = repos.get(repo, 0) + 1

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as out:
        for record in sorted(records, key=lambda r: r["id"]):
            out.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

    manifest = {
        "schema_version": 1,
        "input_jobs": len(records) + skipped,
        "generated_records": len(records),
        "skipped_or_unstructured": skipped,
        "repositories": len(repos),
        "per_repo_cap": args.per_repo_cap,
        "records_by_repository": dict(
            sorted(repos.items(), key=lambda item: (-item[1], item[0]))
        ),
        "generator": "deterministic-source-grounding-v1",
        "policy": {
            "answers_are_deterministically_derived_from_source": True,
            "tool_trace_is_knowledge_search": True,
            "model_generation_used": False,
            "mutable_truth_remains_conditioned_on_retrieval": True,
        },
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
