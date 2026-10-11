#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import json
import time
import urllib.error
import urllib.request
import uuid
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

__all__ = (
    "_clean_display_line",
    "_question_is_grounded",
    "_resolve_evidence",
    "_response_schema",
    "_split_markdown_table_row",
    "_validated_endpoint",
    "strip_code_fence",
    "validate_output",
)

SAFE_EXAMPLE_FIELDS = ("category", "scenario", "user", "assistant", "tags")


def _request_structured_json(
    endpoint: str,
    prompt: str,
    schema: dict,
    timeout: int,
    max_tokens: int,
    temperature: float,
) -> tuple[str, float]:
    payload = {
        "model": "local",
        "messages": [
            {
                "role": "system",
                "content": (
                    "Return only the requested JSON object. Never include hidden "
                    "reasoning or chain-of-thought."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
        "response_format": {
            "type": "json_object",
            "schema": schema,
        },
    }
    endpoint = _validated_endpoint(endpoint)
    request = urllib.request.Request(
        endpoint + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:  # nosec B310  # nosemgrep
        data = json.loads(response.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"], time.perf_counter() - started


def request_json(
    endpoint: str,
    prompt: str,
    job: dict,
    timeout: int,
    max_tokens: int,
) -> tuple[str, float]:
    return _request_structured_json(
        endpoint,
        prompt,
        _response_schema(job),
        timeout,
        max_tokens,
        0.15,
    )


NATURAL_REWRITE_SCHEMA = {
    "type": "object",
    "properties": {"assistant": {"type": "string"}},
    "required": ["assistant"],
    "additionalProperties": False,
}


def _natural_rewrite_prompt(job: dict, parsed: dict) -> str:
    profile = str(job.get("familiarity_profile", "novice"))
    profile_rule = (
        "Assume this player already understands the topic; be direct and do not reteach basics."
        if profile == "familiar"
        else (
            "Assume this player may be new to this server-specific topic. When EVIDENCE "
            "supports it, add at most one short plain-language context sentence before the "
            "direct answer. Do not invent how a system works."
        )
    )
    return f"""Rewrite ONLY the assistant reply below so it sounds like a helpful real
Enthusia server assistant instead of documentation.

Keep the exact same factual meaning. You may use EVIDENCE to make the wording clearer, but
you may not add a new mechanic, command, permission, number, rank, requirement, deployment
claim, or causal relationship. Preserve commands, numbers, rates, and deployment
qualifications. Do not expose permission nodes or backend jargon.

{profile_rule}

Style:
- 1-3 short sentences, at most 70 words.
- Use simple everyday wording and natural contractions.
- Lead with the useful answer.
- Avoid "You can do X by using Y"; prefer direct wording such as "Run Y to do X."
- Avoid formal filler like "Please check back later once..." when a direct sentence works.
- If the evidence only defines a reputation category, explain what the category is for.
  Do NOT say it adds to, increases, boosts, earns, gives, or improves reputation unless
  EVIDENCE explicitly states that mechanism.
- For a novice reputation-category question, briefly explain that the system has positive
  categories describing different kinds of behavior, when EVIDENCE supports that context.
- Friendly and context-aware, but not overly excited.

USER:
{parsed.get("user", "")}

DRAFT_REPLY:
{parsed.get("assistant", "")}

EVIDENCE:
<<<
{job.get("evidence_text", "")}
>>>

Return exactly:
{{"assistant":"..."}}
"""


def _naturalize_public(
    args: argparse.Namespace,
    job: dict,
    parsed: dict,
) -> tuple[dict, float]:
    if parsed.get("skip") is True or job.get("response_mode") != "player_support":
        return parsed, 0.0
    raw, elapsed = _request_structured_json(
        args.endpoint,
        _natural_rewrite_prompt(job, parsed),
        NATURAL_REWRITE_SCHEMA,
        args.timeout,
        min(args.max_tokens, 220),
        0.20,
    )
    value = json.loads(strip_code_fence(raw))
    if not isinstance(value, dict) or not isinstance(value.get("assistant"), str):
        raise ValueError("natural rewrite returned invalid JSON shape")
    rewritten = dict(parsed)
    rewritten["assistant"] = value["assistant"].strip()
    return rewritten, elapsed


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
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            job_id = _existing_job_id(line)
            if job_id is not None:
                done.add(job_id)
    return done


def _load_job_buckets(
    jobs_path: str,
    existing: set[str],
) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = collections.defaultdict(list)
    with gzip.open(jobs_path, "rt", encoding="utf-8") as handle:
        for line in handle:
            job = json.loads(line)
            if job["job_id"] not in existing:
                buckets[job["repository"]].append(job)
    return buckets


def _round_robin_select(
    buckets: dict[str, list[dict]],
    limit: int,
) -> list[dict]:
    selected: list[dict] = []
    repositories = sorted(buckets)
    round_index = 0
    while len(selected) < limit:
        before = len(selected)
        for repository in repositories:
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
        "rewrite_errors": 0,
        "latency_seconds_total": 0.0,
        "rewrite_latency_seconds_total": 0.0,
    }


def _result_envelope(job: dict) -> dict:
    keys = (
        "job_id", "repository", "path", "source_id", "source_version",
        "line_number", "target_line", "visibility", "response_mode",
        "familiarity_profile", "production_authority", "evidence",
        "evidence_ranges", "evidence_text",
    )
    return {key: job.get(key) for key in keys}


def _increment_problems(problems: dict[str, int], validation: list[str]) -> None:
    for problem in validation:
        problems[problem] = problems.get(problem, 0) + 1


def _unsafe_generated_content(validation: list[str]) -> bool:
    unsafe = {
        "secret_pattern_in_output",
        "forbidden_generated_fields",
    }
    return bool(unsafe.intersection(validation))


def _safe_parsed(parsed: dict, validation: list[str]) -> dict:
    if _unsafe_generated_content(validation):
        return {"rejected": True, "content_withheld": True}
    if parsed.get("skip") is True:
        reason = parsed.get("reason")
        return {
            "skip": True,
            "reason": reason if isinstance(reason, str) else "invalid skip",
        }
    return {
        key: parsed[key]
        for key in SAFE_EXAMPLE_FIELDS
        if key in parsed
    }


def _attach_validated_fields(job: dict, parsed: dict) -> dict:
    resolved = dict(parsed)
    facts, assistant = _resolve_evidence(job, parsed)
    resolved["visibility"] = job.get("visibility", "staff")
    resolved["response_mode"] = job.get("response_mode")
    resolved["familiarity_profile"] = job.get("familiarity_profile")
    resolved["facts"] = facts
    resolved["assistant"] = assistant
    resolved["expected_actions"] = []
    return resolved


BOUNDARY_SAFE_ASSISTANT = (
    "That's a staff-only server control, so normal players don't need access to it. "
    "Tell me what you're trying to do and I'll help you find a normal player option."
)


def _apply_response_policy(job: dict, parsed: dict) -> dict:
    if parsed.get("skip") is True or job.get("response_mode") != "player_boundary":
        return parsed
    resolved = dict(parsed)
    resolved["assistant"] = BOUNDARY_SAFE_ASSISTANT
    return resolved


def _classify_parsed(
    job: dict,
    parsed: dict,
    result: dict,
    stats: dict[str, int | float],
    problems: dict[str, int],
) -> None:
    policy_parsed = _apply_response_policy(job, parsed)
    validation = validate_output(job, policy_parsed)
    safe = _safe_parsed(policy_parsed, validation)
    if not validation and policy_parsed.get("skip") is not True:
        safe = _attach_validated_fields(job, safe)
    result["parsed"] = safe
    result["validation_problems"] = validation
    if validation:
        stats["invalid"] += 1
        _increment_problems(problems, validation)
    elif policy_parsed.get("skip") is True:
        stats["skipped"] += 1
    else:
        stats["valid"] += 1


def _parse_model_response(
    args: argparse.Namespace,
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
        parsed_value, rewrite_elapsed = _naturalize_public(args, job, parsed_value)
        if rewrite_elapsed:
            result["rewrite_latency_seconds"] = rewrite_elapsed
            stats["rewrite_latency_seconds_total"] += rewrite_elapsed
        _classify_parsed(job, parsed_value, result, stats, problems)
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        result["validation_problems"] = [f"json_parse:{type(exc).__name__}"]
        result["parsed"] = {"rejected": True, "content_withheld": True}
        stats["invalid"] += 1
        problems["json_parse"] = problems.get("json_parse", 0) + 1
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        result["validation_problems"] = [f"rewrite_request:{type(exc).__name__}"]
        result["parsed"] = {"rejected": True, "content_withheld": True}
        stats["invalid"] += 1
        stats["rewrite_errors"] += 1
        problems["rewrite_request"] = problems.get("rewrite_request", 0) + 1


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
    result["model_response_chars"] = len(raw)
    _parse_model_response(args, job, raw, result, stats, problems)
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


def _prepare_output(output: Path, resume: bool) -> set[str]:
    if resume:
        return load_existing(output)
    output.write_text("", encoding="utf-8")
    return set()


def _run_selected(
    args: argparse.Namespace,
    output: Path,
    selected: list[dict],
    run_id: str,
) -> tuple[dict[str, int | float], dict[str, int]]:
    stats = _initial_stats()
    problems: dict[str, int] = {}
    consecutive_errors = 0
    with output.open("a", encoding="utf-8") as handle:
        for index, job in enumerate(selected, 1):
            result, request_ok = _execute_job(args, job, stats, problems)
            result["benchmark_run_id"] = run_id
            consecutive_errors = 0 if request_ok else consecutive_errors + 1
            handle.write(json.dumps(result, ensure_ascii=False) + "\n")
            handle.flush()
            _print_progress(index, len(selected), job, stats)
            if consecutive_errors >= 3:
                print(
                    "Aborting benchmark after 3 consecutive request errors; "
                    "local model server is unhealthy."
                )
                break
    return stats, problems


def _build_summary(
    stats: dict[str, int | float],
    problems: dict[str, int],
    run_id: str,
) -> dict:
    completed = int(stats["valid"] + stats["skipped"] + stats["invalid"])
    return {
        "benchmark_run_id": run_id,
        **stats,
        "completed_model_responses": completed,
        "valid_rate_of_model_responses": stats["valid"] / completed if completed else 0.0,
        "skip_rate_of_model_responses": stats["skipped"] / completed if completed else 0.0,
        "invalid_rate_of_model_responses": stats["invalid"] / completed if completed else 0.0,
        "average_latency_seconds": (
            stats["latency_seconds_total"] / completed if completed else None
        ),
        "problem_counts": dict(sorted(problems.items())),
        "raw_model_responses_persisted": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8091")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--max-tokens", type=int, default=550)
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Append while skipping job IDs already present in --output. "
        "Without this flag, --output is replaced for a clean benchmark run.",
    )
    args = parser.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    existing_ids = _prepare_output(output, args.resume)
    buckets = _load_job_buckets(args.jobs, existing_ids)
    selected = _round_robin_select(buckets, args.limit)
    run_id = uuid.uuid4().hex
    stats, problems = _run_selected(args, output, selected, run_id)
    summary = _build_summary(stats, problems, run_id)
    Path(args.summary).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0 if stats["request_errors"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())