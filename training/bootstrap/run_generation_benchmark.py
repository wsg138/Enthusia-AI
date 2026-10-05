#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import json
import re
import time
import urllib.error
import urllib.parse
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

def _validated_endpoint(endpoint: str) -> str:
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("--endpoint must use http:// or https:// with a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("--endpoint must not contain embedded credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("--endpoint must not contain a query string or fragment")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("--endpoint contains an invalid port") from exc
    return endpoint.rstrip("/")


def _split_markdown_table_row(text: str) -> list[str]:
    inner = text.strip().strip("|")
    # Split only on unescaped table separators. A literal escaped pipe inside
    # command syntax (for example packages\\|letters) remains part of the cell.
    cells = re.split(r"(?<!\\)\|", inner)
    cleaned: list[str] = []
    for cell in cells:
        value = (
            cell.strip()
            .replace("\\|", "|")
            .replace("**", "")
            .replace("__", "")
            .replace("`", "")
        )
        if value and not re.fullmatch(r":?-{3,}:?", value):
            cleaned.append(value)
    return cleaned


def _clean_display_line(line: str) -> str:
    text = line.strip()

    # Convert Markdown command tables to readable prose without changing any
    # factual values. Exact raw evidence remains stored separately.
    if text.startswith("|") and text.endswith("|"):
        cells = _split_markdown_table_row(text)
        if len(cells) >= 2 and cells[0].startswith("/"):
            command = cells[0]
            rest = list(cells[1:])
            permission = None
            for index, cell in enumerate(rest):
                if re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", cell):
                    permission = rest.pop(index)
                    break

            rendered = command
            if rest:
                rendered += f": {rest[0]}"
                rest = rest[1:]
            if permission:
                rendered += f" Permission: {permission}"
            for extra in rest:
                if extra.startswith("/"):
                    rendered += f" Example: {extra}"
                else:
                    rendered += f" Details: {extra}"
            return rendered.strip()
        if len(cells) == 2:
            return f"{cells[0]}: {cells[1]}"
        if cells:
            return "; ".join(cells)

    text = re.sub(r"^#{1,6}\s+", "", text)
    text = re.sub(r"^[-*+]\s+", "", text)
    text = re.sub(r"^\d+[.)]\s+", "", text)
    text = text.replace("**", "").replace("__", "").replace("`", "")

    # Common README examples use "/command  # explanation".
    command_comment = re.fullmatch(r"(/[^#]+?)\s+#\s+(.+)", text)
    if command_comment:
        return f"{command_comment.group(1).strip()}: {command_comment.group(2).strip()}"

    if text.lower().startswith("usage:"):
        value = text[6:].strip().strip('"').strip("'")
        value = re.sub(r"&[0-9A-FK-ORa-fk-or]", "", value)
        if value.lower().startswith("usage:"):
            value = value[6:].strip()
        text = f"Usage: {value}"
    if text.lower().startswith("aliases:"):
        text = "Aliases:" + text[8:]
    return text.strip()

def _resolve_evidence(job: dict, parsed: dict) -> tuple[list[dict], str]:
    evidence = str(job.get("target_line", ""))
    display = _clean_display_line(evidence).rstrip(" ;,")
    if display and display[-1] not in ".!?":
        display += "."
    fact = {
        "claim": display,
        "evidence": evidence,
        "source": job["source_id"],
        "source_version": job["source_version"],
        "line_number": job.get("line_number"),
    }
    return ([fact] if display else []), display


QUESTION_STOPWORDS = {
    "a", "an", "and", "are", "can", "could", "do", "does", "for", "from",
    "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "the",
    "to", "use", "using", "what", "when", "where", "which", "who", "why",
    "will", "with", "you", "your",
    # Query scaffolding that does not add factual scope.
    "about", "available", "behavior", "command", "commands", "definition",
    "defined", "feature", "features", "frequency", "guide", "mean", "means",
    "plugin", "plugins", "rule", "rules", "subcommand", "subcommands", "term",
    "terms",
}


def _lexemes(text: str) -> set[str]:
    raw = re.findall(r"[A-Za-z0-9_./:+-]+", text.lower())
    result: set[str] = set()
    for token in raw:
        token = token.strip("./:+-")
        if len(token) < 3 or token in QUESTION_STOPWORDS:
            continue
        result.add(token)
        if len(token) > 4 and token.endswith("s"):
            result.add(token[:-1])
        if len(token) > 5 and token.endswith("ing"):
            result.add(token[:-3])
        if len(token) > 4 and token.endswith("ed"):
            result.add(token[:-2])
    return result


def _question_is_grounded(job: dict, parsed: dict) -> bool:
    question = parsed.get("user")
    line = job.get("target_line")
    if not isinstance(question, str) or not isinstance(line, str):
        return False

    q_lower = question.lower()
    support_text = " ".join([
        line,
        str(job.get("repository", "")),
        str(job.get("path", "")),
    ])
    support_lower = support_text.lower()

    # Semantic labels that materially change meaning must be explicit.
    if re.search(r"\brank\b", q_lower) and not re.search(r"\brank\b", support_lower):
        return False
    if re.search(r"\b(?:price|cost)\b", q_lower) and not re.search(
        r"\b(?:price|cost|usd)\b|\$", support_lower
    ):
        return False
    if "leaderboard" in q_lower and "leaderboard" not in support_lower:
        return False
    if "arena" in q_lower and "arena" not in support_lower:
        return False
    if "cooldown" in q_lower and "cooldown" not in support_lower:
        return False
    if re.search(r"\brules?\b", q_lower) and not re.search(
        r"\brules?\b", support_lower
    ):
        return False

    # Permission questions require either the word itself or a permission node.
    asks_permission = bool(re.search(r"\bpermissions?\b", q_lower))
    has_permission_evidence = bool(
        re.search(r"\bpermissions?\b", support_lower)
        or re.search(r"\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b", support_lower)
    )
    if asks_permission and not has_permission_evidence:
        return False

    # Version questions require explicit version evidence.
    if "version" in q_lower and not (
        "version" in support_lower
        or re.search(r"\b\d+(?:\.\d+)+", support_lower)
    ):
        return False

    # "speed" is a safe paraphrase for explicit cadence/rate evidence.
    semantic_support = support_lower
    if asks_permission and has_permission_evidence:
        semantic_support += " permission required needed"
    if "speed" in q_lower and re.search(
        r"(?:per second|per tick|every tick|interval|cps|rate)", support_lower
    ):
        semantic_support += " speed"

    question_terms = _lexemes(question)
    if not question_terms:
        return True
    support_terms = _lexemes(semantic_support)

    # Long concrete nouns are usually scope-bearing details. Do not allow the
    # generated question to introduce one that is absent from the evidence.
    # Keep a small allowlist of abstract framing terms that are safe semantic
    # wrappers around explicit source evidence.
    safe_abstract_terms = {
        "permission", "permissions", "required", "needed",
        "configuration", "configure", "configured",
        "specific", "available", "current",
    }
    for term in question_terms:
        if len(term) < 8 or term in safe_abstract_terms:
            continue
        if term in support_terms:
            continue
        if any(
            support.startswith(term)
            for support in support_terms
            if len(support) >= len(term)
        ):
            continue
        return False

    # _lexemes emits simple morphology stems. Match those directly and allow
    # one-way compound prefixes only for long terms. Never let short
    # substrings such as "ran" satisfy "rank".
    matched = sum(
        1 for term in question_terms
        if term in support_terms
        or (
            len(term) >= 5
            and any(
                support.startswith(term)
                for support in support_terms
                if len(support) >= len(term)
            )
        )
    )
    return matched / len(question_terms) >= 0.50


def validate_output(job: dict, parsed: dict) -> list[str]:
    problems: list[str] = []
    if parsed.get("skip") is True:
        if not isinstance(parsed.get("reason"), str):
            problems.append("skip_missing_reason")
        return problems

    for key in ("category", "scenario", "user", "tags"):
        if key not in parsed:
            problems.append(f"missing:{key}")

    forbidden_generated = {
        "assistant", "facts", "expected_actions", "tools", "source",
        "source_version", "visibility", "evidence_groups", "evidence_ids",
    }
    if forbidden_generated.intersection(parsed):
        problems.append("forbidden_generated_fields")

    if parsed.get("category") not in CATEGORIES:
        problems.append("bad_category")
    if isinstance(parsed.get("scenario"), str) and len(parsed["scenario"].split()) > 18:
        problems.append("scenario_too_long")
    if isinstance(parsed.get("user"), str) and len(parsed["user"].split()) > 30:
        problems.append("user_too_long")

    tags = parsed.get("tags")
    if not isinstance(tags, list) or len(tags) > 4 or any(
        not isinstance(tag, str) for tag in (tags if isinstance(tags, list) else [])
    ):
        problems.append("bad_tags")

    target_line = job.get("target_line")
    if not isinstance(target_line, str) or not target_line.strip():
        problems.append("missing_target_line")
    elif len(target_line) > 500:
        problems.append("target_line_too_long")
    elif any(pattern.search(target_line) for pattern in SECRET_PATTERNS):
        problems.append("target_line_secret_pattern")

    if not _question_is_grounded(job, parsed):
        problems.append("question_not_fully_grounded")

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

def _response_schema(job: dict) -> dict:
    skip_shape = {
        "type": "object",
        "properties": {
            "skip": {"const": True},
            "reason": {"type": "string"},
        },
        "required": ["skip", "reason"],
        "additionalProperties": False,
    }
    example_shape = {
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": sorted(CATEGORIES)},
            "scenario": {"type": "string"},
            "user": {"type": "string"},
            "tags": {
                "type": "array",
                "maxItems": 4,
                "items": {"type": "string"},
            },
        },
        "required": ["category", "scenario", "user", "tags"],
        "additionalProperties": False,
    }
    return {"oneOf": [skip_shape, example_shape]}

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
    consecutive_request_errors = 0

    with output.open("a", encoding="utf-8") as out:
        for index, job in enumerate(selected, 1):
            stats["attempted"] += 1
            result = {
                "job_id": job["job_id"],
                "repository": job["repository"],
                "path": job["path"],
                "source_id": job["source_id"],
                "source_version": job["source_version"],
                "line_number": job.get("line_number"),
                "target_line": job.get("target_line"),
            }
            try:
                raw, elapsed = request_json(
                    args.endpoint,
                    job["prompt"],
                    job,
                    args.timeout,
                    args.max_tokens,
                )
                stats["latency_seconds_total"] += elapsed
                result["latency_seconds"] = elapsed
                result["raw_response"] = raw
                try:
                    parsed = json.loads(strip_code_fence(raw))
                    validation = validate_output(job, parsed)
                    if not validation and parsed.get("skip") is not True:
                        facts, assistant = _resolve_evidence(job, parsed)
                        parsed["visibility"] = job.get("visibility", "staff")
                        parsed["facts"] = facts
                        parsed["assistant"] = assistant
                        parsed["expected_actions"] = []
                    result["parsed"] = parsed
                    result["validation_problems"] = validation
                    consecutive_request_errors = 0
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
                consecutive_request_errors += 1
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
            out.flush()
            print(
                f"[{index}/{len(selected)}] {job['job_id']} "
                f"valid={stats['valid']} skip={stats['skipped']} invalid={stats['invalid']} "
                f"errors={stats['request_errors']}"
            )
            if consecutive_request_errors >= 3:
                print(
                    "Aborting benchmark after 3 consecutive request errors; "
                    "local model server is unhealthy."
                )
                break

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
