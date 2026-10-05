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


def _command_table_question(cells: list[str]) -> tuple[str, str, list[str]] | None:
    if not cells or not cells[0].startswith("/"):
        return None
    syntax = cells[0]
    command_root = _command_root(syntax)
    command_tag = command_root.lstrip("/") if command_root else "command"
    return (
        f"What does {syntax} do?",
        "commands",
        ["command", command_tag],
    )


def _glossary_table_question(
    cells: list[str],
    repository: str,
) -> tuple[str, str, list[str]] | None:
    if len(cells) != 2:
        return None
    label = _strip_markup(cells[0]).strip()
    detail = _strip_markup(cells[1]).strip()
    path_like = bool(
        re.search(
            r"(?:\[[^\]]+\]\(|https?://|[\\/]|\.(?:md|yml|yaml|json|py|ts|java|kt)\b)",
            label,
            flags=re.I,
        )
    )
    valid_label = (
        2 <= len(label) <= 80
        and label.lower() not in GENERIC_TABLE_HEADERS
        and not path_like
        and not label.startswith(("http://", "https://"))
    )
    if not valid_label or not 4 <= len(detail) <= 300:
        return None
    return (
        f'What does "{label}" mean in {repository}?',
        "onboarding",
        ["feature", "documentation"],
    )


def _markdown_table_question(
    line: str,
    repository: str,
) -> tuple[str, str, list[str]] | None:
    if not (line.startswith("|") and line.endswith("|")):
        return None
    cells = _split_markdown_table_row(line)
    return _command_table_question(cells) or _glossary_table_question(
        cells,
        repository,
    )


def _usage_question(
    line: str,
    _repository: str,
) -> tuple[str, str, list[str]] | None:
    match = re.match(r"(?i)^usage:\s*(.+)$", line)
    if not match:
        return None
    usage = _strip_markup(match.group(1)).strip().strip('"').strip("'")
    usage = re.sub(r"(?i)^&[0-9A-FK-OR]*usage:\s*", "", usage).strip()
    usage = re.sub(r"(?i)^usage:\s*", "", usage).strip()
    root = _command_root(usage)
    if not root:
        return None
    return (
        f"What is the documented usage for {root}?",
        "commands",
        ["command", "usage", root.lstrip("/")],
    )


def _plain_command_question(
    line: str,
    _repository: str,
) -> tuple[str, str, list[str]] | None:
    if not line.startswith("/"):
        return None
    command_part = line.split("#", 1)[0].strip()
    root = _command_root(command_part)
    if not root:
        return None
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


def _permission_question(
    line: str,
    repository: str,
) -> tuple[str, str, list[str]] | None:
    has_requirement = bool(re.search(r"(?i)\brequires?\b", line))
    has_permission_node = bool(
        re.search(r"\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b", line)
    )
    if not (has_requirement and has_permission_node):
        return None
    return (
        f"What permission requirement is documented for {repository}?",
        "permissions",
        ["permission", "documentation"],
    )


QUESTION_DERIVERS = (
    _markdown_table_question,
    _usage_question,
    _plain_command_question,
    _permission_question,
)


def derive_question(
    target_line: str,
    repository: str,
) -> tuple[str, str, list[str]] | None:
    """Derive a question only from high-confidence source shapes."""
    line = target_line.strip()
    for derive in QUESTION_DERIVERS:
        result = derive(line, repository)
        if result is not None:
            return result
    return None


def _normalized_answer(target_line: str, user: str) -> str | None:
    answer = _clean_display_line(target_line).rstrip(" ;,")
    if not answer or answer.endswith(":"):
        return None
    if answer[-1] not in ".!?":
        answer += "."
    if "\ufffd" in answer or len(answer) > 800 or len(user) > 220:
        return None
    return answer


def _source_result(job: dict) -> dict:
    return {
        "source": job["source_id"],
        "source_version": job["source_version"],
        "repository": job["repository"],
        "path": job["path"],
        "line_number": job.get("line_number"),
        "evidence": job["target_line"],
    }


def _fact(job: dict, answer: str) -> dict:
    fact = {
        "claim": answer,
        "source": job["source_id"],
        "source_version": job["source_version"],
        "evidence": job["target_line"],
    }
    if job.get("line_number") is not None:
        fact["line_number"] = job["line_number"]
    return fact


def _record_tags(category: str, derived_tags: list[str]) -> list[str]:
    return list(
        dict.fromkeys(
            [
                category,
                "grounded",
                "retrieval-grounded",
                "deterministic-source",
                *derived_tags,
            ]
        )
    )


def _record_messages(user: str, answer: str, source_result: dict) -> list[dict]:
    return [
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
    ]


def _record_payload(
    job: dict,
    user: str,
    category: str,
    derived_tags: list[str],
    answer: str,
) -> dict:
    digest = hashlib.sha256(
        f'{job["job_id"]}\n{user}\n{answer}'.encode("utf-8")
    ).hexdigest()[:16]
    return {
        "id": f"det-ground-{digest}",
        "source_type": "synthetic",
        "visibility": job.get("visibility", "staff"),
        "scenario": f"User asks for documented {category} information from {job['repository']}.",
        "messages": _record_messages(user, answer, _source_result(job)),
        "tools": [KNOWLEDGE_TOOL],
        "expected_actions": [f"tool:{KNOWLEDGE_TOOL}"],
        "expected_answer": answer,
        "facts": [_fact(job, answer)],
        "tags": _record_tags(category, derived_tags),
        "quality": None,
        "template_id": f"deterministic-grounded:{job['job_id']}",
        "generator": "deterministic-source-grounding-v1",
        "source_repository": job["repository"],
        "source_path": job["path"],
        "source_id": job["source_id"],
        "source_version": job["source_version"],
    }


def make_record(job: dict) -> dict | None:
    if Path(job.get("path", "")).suffix.lower() in SOURCE_EXTS:
        return None
    derived = derive_question(job["target_line"], job["repository"])
    if derived is None:
        return None
    user, category, derived_tags = derived
    answer = _normalized_answer(job["target_line"], user)
    if answer is None:
        return None
    return _record_payload(job, user, category, derived_tags, answer)


def _collect_records(
    jobs_path: str,
    per_repo_cap: int,
) -> tuple[list[dict], dict[str, int], int]:
    records: list[dict] = []
    seen_pairs: set[tuple[str, str]] = set()
    repos: dict[str, int] = {}
    skipped = 0

    with gzip.open(jobs_path, "rt", encoding="utf-8") as fh:
        for raw in fh:
            record = make_record(json.loads(raw))
            if record is None:
                skipped += 1
                continue
            repo = record["source_repository"]
            pair = (record["messages"][0]["content"], record["expected_answer"])
            if repos.get(repo, 0) >= per_repo_cap or pair in seen_pairs:
                skipped += 1
                continue
            seen_pairs.add(pair)
            records.append(record)
            repos[repo] = repos.get(repo, 0) + 1
    return records, repos, skipped


def _write_records(output_path: str, records: list[dict]) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as out:
        for record in sorted(records, key=lambda item: item["id"]):
            out.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _manifest(
    records: list[dict],
    repos: dict[str, int],
    skipped: int,
    per_repo_cap: int,
) -> dict:
    return {
        "schema_version": 1,
        "input_jobs": len(records) + skipped,
        "generated_records": len(records),
        "skipped_or_unstructured": skipped,
        "repositories": len(repos),
        "per_repo_cap": per_repo_cap,
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--per-repo-cap", type=int, default=30)
    args = ap.parse_args()

    records, repos, skipped = _collect_records(args.jobs, args.per_repo_cap)
    _write_records(args.output, records)
    manifest = _manifest(records, repos, skipped, args.per_repo_cap)
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
