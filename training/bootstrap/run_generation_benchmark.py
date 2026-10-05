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

def _require_http_endpoint(parsed: urllib.parse.SplitResult) -> None:
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("--endpoint must use http:// or https:// with a host")
    if not parsed.hostname:
        raise ValueError("--endpoint must use http:// or https:// with a host")


def _reject_endpoint_credentials(parsed: urllib.parse.SplitResult) -> None:
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("--endpoint must not contain embedded credentials")


def _reject_endpoint_suffix(parsed: urllib.parse.SplitResult) -> None:
    if parsed.query or parsed.fragment:
        raise ValueError("--endpoint must not contain a query string or fragment")


def _validate_endpoint_port(parsed: urllib.parse.SplitResult) -> None:
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("--endpoint contains an invalid port") from exc


def _validated_endpoint(endpoint: str) -> str:
    parsed = urllib.parse.urlsplit(endpoint)
    _require_http_endpoint(parsed)
    _reject_endpoint_credentials(parsed)
    _reject_endpoint_suffix(parsed)
    _validate_endpoint_port(parsed)
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


def _render_command_table(cells: list[str]) -> str:
    command = cells[0]
    rest = list(cells[1:])
    permission = next(
        (
            cell
            for cell in rest
            if re.fullmatch(
                r"[A-Za-z][A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+",
                cell,
            )
        ),
        None,
    )
    if permission is not None:
        rest.remove(permission)

    rendered = command
    if rest:
        rendered += f": {rest.pop(0)}"
    if permission:
        rendered += f" Permission: {permission}"
    for extra in rest:
        label = "Example" if extra.startswith("/") else "Details"
        rendered += f" {label}: {extra}"
    return rendered.strip()


def _render_markdown_table(text: str) -> str | None:
    if not (text.startswith("|") and text.endswith("|")):
        return None
    cells = _split_markdown_table_row(text)
    if len(cells) >= 2 and cells[0].startswith("/"):
        return _render_command_table(cells)
    if len(cells) == 2:
        return f"{cells[0]}: {cells[1]}"
    return "; ".join(cells) if cells else ""


def _clean_plain_display(text: str) -> str:
    text = re.sub(r"^#{1,6}\s+", "", text)
    text = re.sub(r"^[-*+]\s+", "", text)
    text = re.sub(r"^\d+[.)]\s+", "", text)
    text = text.replace("**", "").replace("__", "").replace("`", "")

    command_comment = re.fullmatch(r"(/[^#]+?)\s+#\s+(.+)", text)
    if command_comment:
        return f"{command_comment.group(1).strip()}: {command_comment.group(2).strip()}"

    if text.lower().startswith("usage:"):
        value = text[6:].strip().strip('"').strip("'")
        value = re.sub(r"&[0-9A-FK-ORa-fk-or]", "", value)
        if value.lower().startswith("usage:"):
            value = value[6:].strip()
        return f"Usage: {value}"
    if text.lower().startswith("aliases:"):
        return "Aliases:" + text[8:]
    return text.strip()


def _clean_display_line(line: str) -> str:
    text = line.strip()
    table = _render_markdown_table(text)
    return table if table is not None else _clean_plain_display(text)


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


def _lexeme_variants(token: str) -> set[str]:
    variants = {token}
    if len(token) > 4 and token.endswith("s"):
        variants.add(token[:-1])
    if len(token) > 5 and token.endswith("ing"):
        variants.add(token[:-3])
    if len(token) > 4 and token.endswith("ed"):
        variants.add(token[:-2])
    return variants


def _lexemes(text: str) -> set[str]:
    result: set[str] = set()
    for raw_token in re.findall(r"[A-Za-z0-9_./:+-]+", text.lower()):
        token = raw_token.strip("./:+-")
        if len(token) >= 3 and token not in QUESTION_STOPWORDS:
            result.update(_lexeme_variants(token))
    return result


SEMANTIC_SCOPE_CHECKS = (
    (
        re.compile(r"\brank\b"),
        re.compile(r"\brank\b"),
    ),
    (
        re.compile(r"\b(?:price|cost)\b"),
        re.compile(r"\b(?:price|cost|usd)\b|\$"),
    ),
    ("leaderboard", "leaderboard"),
    ("arena", "arena"),
    ("cooldown", "cooldown"),
    (
        re.compile(r"\brules?\b"),
        re.compile(r"\brules?\b"),
    ),
)
SAFE_ABSTRACT_TERMS = {
    "permission", "permissions", "required", "needed",
    "configuration", "configure", "configured",
    "specific", "available", "current",
}
PERMISSION_NODE_RE = re.compile(r"\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b")
RATE_EVIDENCE_RE = re.compile(
    r"(?:per second|per tick|every tick|interval|cps|rate)"
)


def _contains_pattern(value: str, pattern: str | re.Pattern[str]) -> bool:
    if isinstance(pattern, str):
        return pattern in value
    return bool(pattern.search(value))


def _semantic_scope_supported(question: str, support: str) -> bool:
    return all(
        not _contains_pattern(question, question_pattern)
        or _contains_pattern(support, support_pattern)
        for question_pattern, support_pattern in SEMANTIC_SCOPE_CHECKS
    )


def _permission_support(question: str, support: str) -> tuple[bool, bool]:
    asks_permission = bool(re.search(r"\bpermissions?\b", question))
    has_evidence = bool(
        re.search(r"\bpermissions?\b", support)
        or PERMISSION_NODE_RE.search(support)
    )
    return asks_permission, has_evidence


def _version_supported(question: str, support: str) -> bool:
    if "version" not in question:
        return True
    return "version" in support or bool(re.search(r"\b\d+(?:\.\d+)+", support))


def _semantic_support(
    question: str,
    support: str,
    asks_permission: bool,
    has_permission_evidence: bool,
) -> str:
    result = support
    if asks_permission and has_permission_evidence:
        result += " permission required needed"
    if "speed" in question and RATE_EVIDENCE_RE.search(support):
        result += " speed"
    return result


def _term_supported(term: str, support_terms: set[str]) -> bool:
    if term in support_terms:
        return True
    if len(term) < 5:
        return False
    return any(
        support.startswith(term)
        for support in support_terms
        if len(support) >= len(term)
    )


def _long_terms_supported(
    question_terms: set[str],
    support_terms: set[str],
) -> bool:
    return all(
        len(term) < 8
        or term in SAFE_ABSTRACT_TERMS
        or _term_supported(term, support_terms)
        for term in question_terms
    )


def _question_support(
    job: dict,
    parsed: dict,
) -> tuple[str, str] | None:
    question = parsed.get("user")
    line = job.get("target_line")
    if not isinstance(question, str) or not isinstance(line, str):
        return None
    support = " ".join(
        [
            line,
            str(job.get("repository", "")),
            str(job.get("path", "")),
        ]
    )
    return question.lower(), support.lower()


def _grounding_prerequisites(
    question: str,
    support: str,
) -> tuple[bool, bool, bool]:
    asks_permission, has_permission_evidence = _permission_support(
        question,
        support,
    )
    checks = (
        _semantic_scope_supported(question, support),
        not asks_permission or has_permission_evidence,
        _version_supported(question, support),
    )
    return all(checks), asks_permission, has_permission_evidence


def _grounding_terms_match(question: str, semantic_support: str) -> bool:
    question_terms = _lexemes(question)
    if not question_terms:
        return True
    support_terms = _lexemes(semantic_support)
    if not _long_terms_supported(question_terms, support_terms):
        return False
    matched = sum(
        1 for term in question_terms if _term_supported(term, support_terms)
    )
    return matched / len(question_terms) >= 0.50


def _question_is_grounded(job: dict, parsed: dict) -> bool:
    context = _question_support(job, parsed)
    if context is None:
        return False
    question, support = context
    valid, asks_permission, has_permission_evidence = _grounding_prerequisites(
        question,
        support,
    )
    if not valid:
        return False
    semantic_support = _semantic_support(
        question,
        support,
        asks_permission,
        has_permission_evidence,
    )
    return _grounding_terms_match(question, semantic_support)


def _validate_required_fields(parsed: dict, problems: list[str]) -> None:
    for key in ("category", "scenario", "user", "tags"):
        if key not in parsed:
            problems.append(f"missing:{key}")


def _validate_generated_shape(parsed: dict, problems: list[str]) -> None:
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


def _validate_tags(parsed: dict, problems: list[str]) -> None:
    tags = parsed.get("tags")
    if not isinstance(tags, list):
        problems.append("bad_tags")
        return
    if len(tags) > 4 or any(not isinstance(tag, str) for tag in tags):
        problems.append("bad_tags")


def _validate_target_line(job: dict, problems: list[str]) -> None:
    target_line = job.get("target_line")
    if not isinstance(target_line, str) or not target_line.strip():
        problems.append("missing_target_line")
        return
    if len(target_line) > 500:
        problems.append("target_line_too_long")
        return
    if any(pattern.search(target_line) for pattern in SECRET_PATTERNS):
        problems.append("target_line_secret_pattern")


def _validate_generated_content(
    job: dict,
    parsed: dict,
    problems: list[str],
) -> None:
    if not _question_is_grounded(job, parsed):
        problems.append("question_not_fully_grounded")
    serialized = json.dumps(parsed, ensure_ascii=False)
    if any(pattern.search(serialized) for pattern in SECRET_PATTERNS):
        problems.append("secret_pattern_in_output")
    if {"reasoning", "chain_of_thought", "analysis", "thoughts"}.intersection(parsed):
        problems.append("chain_of_thought_key")


def _validate_resolved_answer(job: dict, parsed: dict, problems: list[str]) -> None:
    if problems:
        return
    facts, assistant = _resolve_evidence(job, parsed)
    if not facts or not assistant:
        problems.append("resolved_answer_empty")
    elif len(assistant.split()) > 80 or len(assistant) > 800:
        problems.append("resolved_answer_too_long")


def validate_output(job: dict, parsed: dict) -> list[str]:
    problems: list[str] = []
    if parsed.get("skip") is True:
        if not isinstance(parsed.get("reason"), str):
            problems.append("skip_missing_reason")
        return problems

    _validate_required_fields(parsed, problems)
    _validate_generated_shape(parsed, problems)
    _validate_tags(parsed, problems)
    _validate_target_line(job, problems)
    _validate_generated_content(job, parsed, problems)
    _validate_resolved_answer(job, parsed, problems)
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
