#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

CATEGORIES = {
    "onboarding", "commands", "permissions", "rank", "economy", "tickets",
    "rules", "bugs", "account linking", "ambiguity", "escalation",
    "stale data", "conflicting evidence", "privacy"
}

SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/-]{16,}"),
]

def strip_code_fence(text: str) -> str:
    text = text.strip()
    fence = chr(96) * 3
    if text.startswith(fence):
        first_newline = text.find("\n")
        if first_newline >= 0:
            text = text[first_newline + 1:]
        if text.rstrip().endswith(fence):
            text = text.rstrip()[:-3]
    return text.strip()

def _clean_display_line(line: str) -> str:
    text = line.strip()

    # Convert Markdown table rows into readable deterministic prose without
    # inventing facts. Common command tables become:
    #   /command: description Permission: node.
    if text.startswith("|") and text.endswith("|"):
        cells = [
            cell.strip().replace("**", "").replace("__", "").replace("`", "")
            for cell in text.strip("|").split("|")
        ]
        cells = [cell for cell in cells if cell and not re.fullmatch(r":?-{3,}:?", cell)]
        if len(cells) >= 3 and cells[0].startswith("/"):
            rendered = f"{cells[0]}: {cells[1]} Permission: {cells[2]}"
            if len(cells) > 3:
                rendered += " " + " ".join(cells[3:])
            return rendered.strip()
        if cells:
            return "; ".join(cells)

    text = re.sub(r"^#{1,6}\\s+", "", text)
    text = re.sub(r"^[-*+]\\s+", "", text)
    text = re.sub(r"^\\d+[.)]\\s+", "", text)
    text = text.replace("**", "").replace("__", "").replace("`", "")
    return text.strip()


def _resolve_evidence(job: dict, parsed: dict) -> tuple[list[dict], str]:
    facts: list[dict] = []
    answer_parts: list[str] = []
    seen_ids: set[str] = set()
    for group in parsed.get("evidence_groups", []):
        for evidence_id in group.get("evidence_ids", []):
            if evidence_id in seen_ids:
                continue
            seen_ids.add(evidence_id)
            evidence = job["evidence_map"][evidence_id]
            display = _clean_display_line(evidence)
            if display and display[-1] not in ".!?":
                display += "."
            facts.append({
                "claim": display,
                "evidence_ids": [evidence_id],
                "evidence": evidence,
                "source": job["source_id"],
                "source_version": job["source_version"],
            })
            if display:
                answer_parts.append(display)
    return facts, " ".join(answer_parts)


def validate_output(job: dict, parsed: dict) -> list[str]:
    problems: list[str] = []
    if parsed.get("skip") is True:
        if not isinstance(parsed.get("reason"), str):
            problems.append("skip_missing_reason")
        return problems

    for key in ("category", "visibility", "scenario", "user", "evidence_groups", "tags"):
        if key not in parsed:
            problems.append(f"missing:{key}")
    forbidden_generated = {"assistant", "facts", "expected_actions", "tools", "source", "source_version"}
    if forbidden_generated.intersection(parsed):
        problems.append("forbidden_generated_fields")
    if parsed.get("category") not in CATEGORIES:
        problems.append("bad_category")
    if parsed.get("visibility") not in {"public", "private", "staff", "owner"}:
        problems.append("bad_visibility")

    groups = parsed.get("evidence_groups")
    if not isinstance(groups, list) or not (1 <= len(groups) <= 2):
        problems.append("bad_evidence_groups")
        groups = []
    for i, group in enumerate(groups):
        if not isinstance(group, dict) or set(group) != {"evidence_ids"}:
            problems.append(f"group_{i}_shape")
            continue
        ids = group.get("evidence_ids")
        if (
            not isinstance(ids, list)
            or not (1 <= len(ids) <= 2)
            or any(
                not isinstance(evidence_id, str)
                or evidence_id not in job.get("evidence_map", {})
                for evidence_id in (ids if isinstance(ids, list) else [])
            )
        ):
            problems.append(f"group_{i}_bad_evidence_ids")
            continue
        selected_lines = [job["evidence_map"][evidence_id] for evidence_id in ids]
        if sum(len(line) for line in selected_lines) > 500:
            problems.append(f"group_{i}_evidence_too_long")
        selected_serialized = "\\n".join(selected_lines)
        if any(pattern.search(selected_serialized) for pattern in SECRET_PATTERNS):
            problems.append(f"group_{i}_secret_pattern")

    if isinstance(parsed.get("scenario"), str) and len(parsed["scenario"].split()) > 18:
        problems.append("scenario_too_long")
    if isinstance(parsed.get("user"), str) and len(parsed["user"].split()) > 30:
        problems.append("user_too_long")
    tags = parsed.get("tags")
    if not isinstance(tags, list) or len(tags) > 4 or any(
        not isinstance(tag, str) for tag in (tags if isinstance(tags, list) else [])
    ):
        problems.append("bad_tags")

    serialized = json.dumps(parsed, ensure_ascii=False)
    if any(pattern.search(serialized) for pattern in SECRET_PATTERNS):
        problems.append("secret_pattern_in_output")
    if {"reasoning", "chain_of_thought", "analysis", "thoughts"}.intersection(parsed):
        problems.append("chain_of_thought_key")

    if not problems:
        facts, assistant = _resolve_evidence(job, parsed)
        if not facts or not assistant:
            problems.append("resolved_answer_empty")
        elif len(assistant.split()) > 80 or len(assistant) > 800:
            problems.append("resolved_answer_too_long")
    return problems

def request_json(endpoint: str, prompt: str, timeout: int, max_tokens: int) -> tuple[str, float]:
    payload = {
        "model": "local",
        "messages": [
            {
                "role": "system",
                "content": "Return only the requested JSON object. Never include hidden reasoning or chain-of-thought.",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.15,
        "max_tokens": max_tokens,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        endpoint.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"], time.perf_counter() - started

def load_existing(path: Path) -> set[str]:
    if not path.exists():
        return set()
    done = set()
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            try:
                done.add(json.loads(line)["job_id"])
            except Exception:
                continue
    return done

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument("--endpoint", default="http://127.0.0.1:8091")
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--max-tokens", type=int, default=450)
    args = ap.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    existing = load_existing(output)
    buckets: dict[str, list[dict]] = collections.defaultdict(list)
    with gzip.open(args.jobs, "rt", encoding="utf-8") as fh:
        for line in fh:
            job = json.loads(line)
            if job["job_id"] in existing:
                continue
            buckets[job["repository"]].append(job)

    selected = []
    repository_order = sorted(buckets)
    round_index = 0
    while len(selected) < args.limit:
        added = False
        for repository in repository_order:
            jobs = buckets[repository]
            if round_index < len(jobs):
                selected.append(jobs[round_index])
                added = True
                if len(selected) >= args.limit:
                    break
        if not added:
            break
        round_index += 1

    stats = {
        "attempted": 0, "valid": 0, "skipped": 0, "invalid": 0, "request_errors": 0,
        "latency_seconds_total": 0.0,
    }
    problems = {}

    with output.open("a", encoding="utf-8") as out:
        for index, job in enumerate(selected, 1):
            stats["attempted"] += 1
            result = {
                "job_id": job["job_id"],
                "repository": job["repository"],
                "path": job["path"],
                "source_id": job["source_id"],
                "source_version": job["source_version"],
            }
            try:
                raw, elapsed = request_json(args.endpoint, job["prompt"], args.timeout, args.max_tokens)
                stats["latency_seconds_total"] += elapsed
                result["latency_seconds"] = elapsed
                result["raw_response"] = raw
                try:
                    parsed = json.loads(strip_code_fence(raw))
                    validation = validate_output(job, parsed)
                    if not validation and parsed.get("skip") is not True:
                        facts, assistant = _resolve_evidence(job, parsed)
                        parsed["facts"] = facts
                        parsed["assistant"] = assistant
                        parsed["expected_actions"] = []
                    result["parsed"] = parsed
                    result["validation_problems"] = validation
                    if validation:
                        stats["invalid"] += 1
                        for problem in validation:
                            problems[problem] = problems.get(problem, 0) + 1
                    elif parsed.get("skip") is True:
                        stats["skipped"] += 1
                    else:
                        stats["valid"] += 1
                except Exception as exc:
                    result["validation_problems"] = [f"json_parse:{type(exc).__name__}"]
                    stats["invalid"] += 1
                    problems["json_parse"] = problems.get("json_parse", 0) + 1
            except (urllib.error.URLError, TimeoutError, OSError, KeyError, json.JSONDecodeError) as exc:
                result["request_error"] = f"{type(exc).__name__}: {exc}"
                stats["request_errors"] += 1
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
            out.flush()
            print(
                f"[{index}/{len(selected)}] {job['job_id']} "
                f"valid={stats['valid']} skip={stats['skipped']} invalid={stats['invalid']} "
                f"errors={stats['request_errors']}"
            )

    completed = stats["valid"] + stats["skipped"] + stats["invalid"]
    summary = {
        **stats,
        "completed_model_responses": completed,
        "valid_rate_of_model_responses": stats["valid"] / completed if completed else 0.0,
        "skip_rate_of_model_responses": stats["skipped"] / completed if completed else 0.0,
        "invalid_rate_of_model_responses": stats["invalid"] / completed if completed else 0.0,
        "average_latency_seconds": stats["latency_seconds_total"] / completed if completed else None,
        "problem_counts": dict(sorted(problems.items())),
    }
    Path(args.summary).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0 if stats["request_errors"] == 0 else 2

if __name__ == "__main__":
    raise SystemExit(main())
