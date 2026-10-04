#!/usr/bin/env python3
from __future__ import annotations

import argparse
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

def validate_output(job: dict, parsed: dict) -> list[str]:
    problems = []
    if parsed.get("skip") is True:
        if not isinstance(parsed.get("reason"), str):
            problems.append("skip_missing_reason")
        return problems
    for key in ("category", "visibility", "scenario", "user", "assistant", "facts", "expected_actions", "tags"):
        if key not in parsed:
            problems.append(f"missing:{key}")
    if parsed.get("category") not in CATEGORIES:
        problems.append("bad_category")
    if parsed.get("visibility") not in {"public", "player_self", "staff"}:
        problems.append("bad_visibility")
    facts = parsed.get("facts")
    if not isinstance(facts, list) or not facts:
        problems.append("facts_empty")
        facts = []
    for i, fact in enumerate(facts):
        if not isinstance(fact, dict):
            problems.append(f"fact_{i}_not_object")
            continue
        if fact.get("source") != job["source_id"]:
            problems.append(f"fact_{i}_source_mismatch")
        if fact.get("source_version") != job["source_version"]:
            problems.append(f"fact_{i}_version_mismatch")
        evidence = fact.get("evidence")
        if not isinstance(evidence, str) or not evidence.strip():
            problems.append(f"fact_{i}_evidence_missing")
        elif evidence not in job["excerpt"]:
            problems.append(f"fact_{i}_evidence_not_verbatim")
    serialized = json.dumps(parsed, ensure_ascii=False)
    if any(pattern.search(serialized) for pattern in SECRET_PATTERNS):
        problems.append("secret_pattern_in_output")
    if {"reasoning", "chain_of_thought", "analysis", "thoughts"}.intersection(parsed):
        problems.append("chain_of_thought_key")
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
    ap.add_argument("--max-tokens", type=int, default=900)
    args = ap.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    existing = load_existing(output)
    selected = []
    with gzip.open(args.jobs, "rt", encoding="utf-8") as fh:
        for line in fh:
            job = json.loads(line)
            if job["job_id"] in existing:
                continue
            selected.append(job)
            if len(selected) >= args.limit:
                break

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
                    result["parsed"] = parsed
                    validation = validate_output(job, parsed)
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
