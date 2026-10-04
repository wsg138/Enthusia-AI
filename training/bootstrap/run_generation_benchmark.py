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

ALLOWED_EXPECTED_ACTIONS = {
    "verify:live",
    "escalate:human-staff",
    "escalate:openai",
}

STOPWORDS = {
    "a","an","and","are","as","at","be","by","can","do","for","from","has","have",
    "how","i","if","in","is","it","of","on","or","that","the","their","this","to",
    "use","using","was","what","when","where","which","who","will","with","you","your",
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

def content_tokens(text: str) -> set[str]:
    tokens = {
        token.lower()
        for token in re.findall(r"[A-Za-z0-9_./:+-]+", text)
        if len(token) >= 3
    }
    return {token for token in tokens if token not in STOPWORDS}


def unsupported_assistant_sentences(parsed: dict, job: dict) -> list[str]:
    assistant = parsed.get("assistant")
    facts = parsed.get("facts")
    if not isinstance(assistant, str) or not isinstance(facts, list):
        return []
    support_parts: list[str] = []
    for fact in facts:
        if not isinstance(fact, dict):
            continue
        claim = fact.get("claim")
        if isinstance(claim, str):
            support_parts.append(claim)
        ids = fact.get("evidence_ids")
        if isinstance(ids, list):
            for evidence_id in ids:
                line = job.get("evidence_map", {}).get(evidence_id)
                if isinstance(line, str):
                    support_parts.append(line)
    support = "\n".join(support_parts)
    support_tokens = content_tokens(support)
    unsupported: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", assistant.strip()):
        tokens = content_tokens(sentence)
        if len(tokens) < 4:
            continue
        overlap = len(tokens & support_tokens) / len(tokens)
        if overlap < 0.28:
            unsupported.append(sentence)
            continue
        # Commands, versions/numbers, URLs/domains, and permission-like nodes
        # are high-risk details: require a literal anchor in the selected facts.
        risky = []
        risky.extend(re.findall(r"/[A-Za-z][A-Za-z0-9_-]*", sentence))
        risky.extend(re.findall(r"\b\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.]+)?\b", sentence))
        risky.extend(re.findall(r"https?://\S+|\b[A-Za-z0-9.-]+\.(?:com|net|org|gg|io)\b", sentence))
        risky.extend(re.findall(r"\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+){1,}\b", sentence))
        support_lower = support.lower()
        if any(item.lower().rstrip(".,)") not in support_lower for item in risky):
            unsupported.append(sentence)
    return unsupported


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
    if parsed.get("visibility") not in {"public", "private", "staff", "owner"}:
        problems.append("bad_visibility")
    actions = parsed.get("expected_actions")
    if not isinstance(actions, list) or any(
        not isinstance(action, str) or action not in ALLOWED_EXPECTED_ACTIONS
        for action in (actions if isinstance(actions, list) else [])
    ):
        problems.append("bad_expected_actions")

    facts = parsed.get("facts")
    if not isinstance(facts, list) or not facts:
        problems.append("facts_empty")
        facts = []
    for i, fact in enumerate(facts):
        if not isinstance(fact, dict):
            problems.append(f"fact_{i}_not_object")
            continue
        claim = fact.get("claim")
        if not isinstance(claim, str) or not claim.strip():
            problems.append(f"fact_{i}_claim_missing")
        elif len(claim.split()) > 24:
            problems.append(f"fact_{i}_claim_too_long")
        evidence_ids = fact.get("evidence_ids")
        if (
            not isinstance(evidence_ids, list)
            or not (1 <= len(evidence_ids) <= 2)
            or any(
                not isinstance(evidence_id, str)
                or evidence_id not in job.get("evidence_map", {})
                for evidence_id in (evidence_ids if isinstance(evidence_ids, list) else [])
            )
        ):
            problems.append(f"fact_{i}_bad_evidence_ids")
    if isinstance(facts, list) and len(facts) > 2:
        problems.append("too_many_facts")
    if isinstance(parsed.get("scenario"), str) and len(parsed["scenario"].split()) > 18:
        problems.append("scenario_too_long")
    if isinstance(parsed.get("user"), str) and len(parsed["user"].split()) > 30:
        problems.append("user_too_long")
    if isinstance(parsed.get("assistant"), str) and len(parsed["assistant"].split()) > 80:
        problems.append("assistant_too_long")
    tags = parsed.get("tags")
    if not isinstance(tags, list) or len(tags) > 4 or any(not isinstance(tag, str) for tag in (tags if isinstance(tags, list) else [])):
        problems.append("bad_tags")
    unsupported = unsupported_assistant_sentences(parsed, job)
    if unsupported:
        problems.append("assistant_not_fully_fact_grounded")

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
                        # Provenance is deterministic input metadata; do not waste
                        # model tokens asking it to repeat source IDs and SHAs.
                        for fact in parsed.get("facts", []):
                            evidence_ids = list(fact.get("evidence_ids", []))
                            fact["evidence"] = "\n".join(
                                job["evidence_map"][evidence_id]
                                for evidence_id in evidence_ids
                            )
                            fact["source"] = job["source_id"]
                            fact["source_version"] = job["source_version"]
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
