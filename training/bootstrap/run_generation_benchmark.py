#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    from training.bootstrap.generation_benchmark_validation import (
        _clean_display_line,
        _question_is_grounded,
        _resolve_evidence,
        _response_schema,
        _split_markdown_table_row,
        _validated_endpoint,
        strip_code_fence,
        validate_output,
    )
except ModuleNotFoundError:
    from generation_benchmark_validation import (
        _clean_display_line,
        _question_is_grounded,
        _resolve_evidence,
        _response_schema,
        _split_markdown_table_row,
        _validated_endpoint,
        strip_code_fence,
        validate_output,
    )

def request_json(
    endpoint: str,
    prompt: str,
    job: dict,
    timeout: int,
    max_tokens: int,
) -> tuple[str, float]:
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
        "response_format": {
            "type": "json_object",
            "schema": _response_schema(job),
        },
    }
    endpoint = _validated_endpoint(endpoint)
    req = urllib.request.Request(
        endpoint + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    # The endpoint is restricted above to explicit HTTP(S); file/custom
    # urllib schemes are rejected before this request is created.
    with urllib.request.urlopen(req, timeout=timeout) as response:  # nosec B310  # nosemgrep
        data = json.loads(response.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"], time.perf_counter() - started

def _existing_job_id(line: str) -> str | None:
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    job_id = parsed.get("job_id")
    return job_id if isinstance(job_id, str) and job_id else None


def load_existing(path: Path) -> set[str]:
    if not path.exists():
        return set()
    done: set[str] = set()
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            job_id = _existing_job_id(line)
            if job_id is not None:
                done.add(job_id)
    return done

def _load_job_buckets(
    jobs_path: str,
    existing: set[str],
) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = collections.defaultdict(list)
    with gzip.open(jobs_path, "rt", encoding="utf-8") as fh:
        for line in fh:
            job = json.loads(line)
            if job["job_id"] not in existing:
                buckets[job["repository"]].append(job)
    return buckets


def _round_robin_select(
    buckets: dict[str, list[dict]],
    limit: int,
) -> list[dict]:
    selected: list[dict] = []
    repository_order = sorted(buckets)
    round_index = 0
    while len(selected) < limit:
        before = len(selected)
        for repository in repository_order:
            jobs = buckets[repository]
            if round_index < len(jobs):
                selected.append(jobs[round_index])
                if len(selected) >= limit:
                    return selected
        if len(selected) == before:
            return selected
        round_index += 1
    return selected


def _initial_stats() -> dict[str, int | float]:
    return {
        "attempted": 0,
        "valid": 0,
        "skipped": 0,
        "invalid": 0,
        "request_errors": 0,
        "latency_seconds_total": 0.0,
    }


def _result_envelope(job: dict) -> dict:
    return {
        "job_id": job["job_id"],
        "repository": job["repository"],
        "path": job["path"],
        "source_id": job["source_id"],
        "source_version": job["source_version"],
        "line_number": job.get("line_number"),
        "target_line": job.get("target_line"),
    }


def _increment_problems(problems: dict[str, int], validation: list[str]) -> None:
    for problem in validation:
        problems[problem] = problems.get(problem, 0) + 1


def _classify_parsed(
    job: dict,
    parsed: dict,
    result: dict,
    stats: dict[str, int | float],
    problems: dict[str, int],
) -> None:
    validation = validate_output(job, parsed)
    if not validation and parsed.get("skip") is not True:
        facts, assistant = _resolve_evidence(job, parsed)
        parsed["visibility"] = job.get("visibility", "staff")
        parsed["facts"] = facts
        parsed["assistant"] = assistant
        parsed["expected_actions"] = []

    result["parsed"] = parsed
    result["validation_problems"] = validation
    if validation:
        stats["invalid"] += 1
        _increment_problems(problems, validation)
    elif parsed.get("skip") is True:
        stats["skipped"] += 1
    else:
        stats["valid"] += 1


def _parse_model_response(
    job: dict,
    raw: str,
    result: dict,
    stats: dict[str, int | float],
    problems: dict[str, int],
) -> None:
    try:
        parsed_value = json.loads(strip_code_fence(raw))
        if not isinstance(parsed_value, dict):
            raise TypeError("model response must be a JSON object")
        _classify_parsed(job, parsed_value, result, stats, problems)
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        result["validation_problems"] = [f"json_parse:{type(exc).__name__}"]
        stats["invalid"] += 1
        problems["json_parse"] = problems.get("json_parse", 0) + 1


def _execute_job(
    args: argparse.Namespace,
    job: dict,
    stats: dict[str, int | float],
    problems: dict[str, int],
) -> tuple[dict, bool]:
    result = _result_envelope(job)
    stats["attempted"] += 1
    try:
        raw, elapsed = request_json(
            args.endpoint,
            job["prompt"],
            job,
            args.timeout,
            args.max_tokens,
        )
    except (
        urllib.error.URLError,
        TimeoutError,
        OSError,
        KeyError,
        json.JSONDecodeError,
    ) as exc:
        result["request_error"] = f"{type(exc).__name__}: {exc}"
        stats["request_errors"] += 1
        return result, False

    stats["latency_seconds_total"] += elapsed
    result["latency_seconds"] = elapsed
    result["raw_response"] = raw
    _parse_model_response(job, raw, result, stats, problems)
    return result, True


def _print_progress(
    index: int,
    total: int,
    job: dict,
    stats: dict[str, int | float],
) -> None:
    print(
        f"[{index}/{total}] {job['job_id']} "
        f"valid={stats['valid']} skip={stats['skipped']} "
        f"invalid={stats['invalid']} errors={stats['request_errors']}"
    )


def _run_selected(
    args: argparse.Namespace,
    output: Path,
    selected: list[dict],
) -> tuple[dict[str, int | float], dict[str, int]]:
    stats = _initial_stats()
    problems: dict[str, int] = {}
    consecutive_request_errors = 0
    with output.open("a", encoding="utf-8") as out:
        for index, job in enumerate(selected, 1):
            result, request_ok = _execute_job(args, job, stats, problems)
            consecutive_request_errors = 0 if request_ok else consecutive_request_errors + 1
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
            out.flush()
            _print_progress(index, len(selected), job, stats)
            if consecutive_request_errors >= 3:
                print(
                    "Aborting benchmark after 3 consecutive request errors; "
                    "local model server is unhealthy."
                )
                break
    return stats, problems


def _build_summary(
    stats: dict[str, int | float],
    problems: dict[str, int],
) -> dict:
    completed = int(stats["valid"] + stats["skipped"] + stats["invalid"])
    return {
        **stats,
        "completed_model_responses": completed,
        "valid_rate_of_model_responses": stats["valid"] / completed if completed else 0.0,
        "skip_rate_of_model_responses": stats["skipped"] / completed if completed else 0.0,
        "invalid_rate_of_model_responses": stats["invalid"] / completed if completed else 0.0,
        "average_latency_seconds": (
            stats["latency_seconds_total"] / completed if completed else None
        ),
        "problem_counts": dict(sorted(problems.items())),
    }


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
    buckets = _load_job_buckets(args.jobs, load_existing(output))
    selected = _round_robin_select(buckets, args.limit)
    stats, problems = _run_selected(args, output, selected)
    summary = _build_summary(stats, problems)
    Path(args.summary).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0 if stats["request_errors"] == 0 else 2

if __name__ == "__main__":
    raise SystemExit(main())
