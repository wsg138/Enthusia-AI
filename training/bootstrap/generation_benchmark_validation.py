from __future__ import annotations

import re
import urllib.parse

try:
    from training.bootstrap import generation_benchmark_formatting as _formatting
except ModuleNotFoundError:
    import generation_benchmark_formatting as _formatting

try:
    from training.bootstrap.generation_question_grounding import (
        SAFE_ABSTRACT_TERMS,
        SAFE_NATURAL_TERMS,
        _lexemes,
        _question_is_grounded,
        _term_supported,
    )
except ModuleNotFoundError:
    from generation_question_grounding import (
        SAFE_ABSTRACT_TERMS,
        SAFE_NATURAL_TERMS,
        _lexemes,
        _question_is_grounded,
        _term_supported,
    )

PERMISSION_NODE_RE = _formatting.PERMISSION_NODE_RE
_clean_display_line = _formatting._clean_display_line
_split_markdown_table_row = _formatting._split_markdown_table_row
strip_code_fence = _formatting.strip_code_fence

CATEGORIES = {
    "onboarding", "commands", "permissions", "rank", "economy", "tickets",
    "rules", "bugs", "account linking", "ambiguity", "escalation",
    "stale data", "conflicting evidence", "privacy",
}
SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/-]{16,}"),
    re.compile(
        r"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key)\b"
        + r"\s*[:=]\s*['\"]?([^\s'\"#]{12,})"
    ),
]
COMMAND_RE = re.compile(r"(?<![A-Za-z0-9_])/[A-Za-z][A-Za-z0-9_-]*")
NUMBER_RE = re.compile(r"(?<![A-Za-z])\d+(?:\.\d+)?%?")
DEPLOYMENT_CLAIM_RE = re.compile(
    r"(?i)\b(?:live|production|deployed|presently installed|currently available|"
    r"available right now|right now|on (?:the )?server now|running in production)\b"
)
EXPLICIT_PRODUCTION_RE = re.compile(
    r"(?i)\b(?:checked against (?:the )?live production|current production|"
    r"production (?:configuration|leaderboard|server|snapshot)|live server|"
    r"active production)\b"
)
NONPRODUCTION_RE = re.compile(
    r"(?i)\b(?:non[- ]production|"
    r"not (?:presently |currently )?(?:installed|loaded|active|available)|"
    r"not active in production|when deployed|next deployment|"
    r"retained (?:data|deployment|configuration))\b"
)
QUALIFIED_DEPLOYMENT_RE = re.compile(
    r"(?i)\b(?:when|if|once) deployed\b|"
    r"\b(?:not|isn't|is not) (?:currently |presently )?"
    r"(?:live|active|available|installed|loaded)\b|"
    r"\bcurrently unavailable\b"
)
BACKEND_JARGON_RE = re.compile(
    r"(?i)\b(?:backend|database|sqlite|webhook|internal api|implementation detail|"
    r"service manager|credential|operator permission)\b"
)
STAFF_SUBCOMMAND_RE = re.compile(
    r"(?i)(?<![\w/])/[a-z][a-z0-9_-]*\s+([a-z][a-z0-9_-]*)\b"
)
MECHANISM_CLAIM_RE = re.compile(
    r"(?i)\b(?:earn|get|gain|receive|awarded?|obtain)\b.{0,60}"
    r"\b(?:by|when|after|for)\b"
)
REPUTATION_EFFECT_RE = re.compile(
    r"(?i)\b(?:add(?:s|ed)? to|increase(?:s|d)?|boost(?:s|ed)?|"
    r"improve(?:s|d)?|raise(?:s|d)?|count(?:s|ed)? toward)\b"
    r".{0,50}\breputation\b"
)
TICK_RATE_EQUIVALENCE_RE = re.compile(
    r"(?i)\b\d+(?:\.\d+)?\s+ticks?\s+(?:equals?|is)\s+"
    r"(?:up to\s+)?\d+(?:\.\d+)?\s+"
    r"(?:attempts?|attacks?|times?)\s+per\s+second\b"
)
RESTRICTED_AUTHORITY_RE = re.compile(
    r"(?i)(?:\|\s*(?:op|operator|admin|staff)\s*\||"
    r"\b(?:op|operator|admin|staff)[ -]only\b|"
    r"\b(?:permission|requires?|restricted)\b.{0,48}"
    r"\b(?:op|operator|admin|staff)\b)"
)
PLAYER_ACCESS_CLAIM_RE = re.compile(
    r"(?i)\b(?:you|players?|normal players?)\s+"
    r"(?:can|may|are able to)\s+"
    r"(?:use|run|type|apply|set|change|manage|access|execute)\b"
)
EXPLICIT_PLAYER_ACCESS_RE = re.compile(
    r"(?i)\b(?:players?|normal players?)\s+"
    r"(?:can|may|are able to|do not need|don't need)\b.{0,64}"
    r"\b(?:use|run|type|apply|set|change|manage|access|execute|client mod)\b|"
    r"\bworks? for (?:both )?(?:java|bedrock|players?)\b"
)
def _require_http_endpoint(parsed: urllib.parse.SplitResult) -> None:
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
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


def _evidence_entries(job: dict) -> list[dict]:
    entries = job.get("evidence")
    if isinstance(entries, list):
        return [entry for entry in entries if isinstance(entry, dict)]
    line = job.get("target_line")
    if not isinstance(line, str):
        return []
    return [{
        "line_number": job.get("line_number"),
        "text": line,
        "visibility": job.get("visibility", "staff"),
    }]


def _evidence_text(job: dict) -> str:
    explicit = job.get("evidence_text")
    if isinstance(explicit, str) and explicit.strip():
        return explicit
    return "\n".join(str(entry.get("text", "")) for entry in _evidence_entries(job))


def _resolve_evidence(job: dict, parsed: dict) -> tuple[list[dict], str]:
    facts: list[dict] = []
    fence = chr(96) * 3
    for entry in _evidence_entries(job):
        raw = str(entry.get("text", ""))
        claim = _clean_display_line(raw).rstrip(" ;,")
        if not claim or claim.startswith(fence) or claim.startswith("#"):
            continue
        if claim[-1] not in ".!?":
            claim += "."
        facts.append({
            "claim": claim,
            "evidence": raw,
            "source": job["source_id"],
            "source_version": job["source_version"],
            "line_number": entry.get("line_number"),
        })
    assistant = parsed.get("assistant")
    return facts, assistant.strip() if isinstance(assistant, str) else ""


def _render_evidence_entries(entries: list[dict]) -> str:
    return "\n".join(
        f"L{entry.get('line_number')}: {entry.get('text', '')}"
        for entry in entries
    )


def _validated_line_numbers(entries: list[dict]) -> list[int] | None:
    numbers: list[int] = []
    for entry in entries:
        number = entry.get("line_number")
        if not isinstance(number, int) or number < 1:
            return None
        numbers.append(number)
    return numbers


def _validate_evidence_size(
    entries: list[dict], rendered: str, problems: list[str]
) -> None:
    if len(entries) > 12 or len(rendered) > 2400:
        problems.append("evidence_window_too_large")


def _validate_evidence_rendering(
    job: dict, rendered: str, problems: list[str]
) -> None:
    explicit = job.get("evidence_text")
    if explicit and explicit != rendered:
        problems.append("evidence_text_mismatch")


def _validate_evidence_lines(
    job: dict, entries: list[dict], problems: list[str]
) -> None:
    numbers = _validated_line_numbers(entries)
    if numbers is None or numbers != sorted(set(numbers)):
        problems.append("invalid_evidence_lines")
        return
    if job.get("line_number") not in numbers:
        problems.append("target_line_number_missing")


def _validate_evidence_source(job: dict, problems: list[str]) -> None:
    source_version = job.get("source_version")
    if not isinstance(source_version, str) or not source_version:
        problems.append("missing_source_sha")
    path = job.get("path")
    if not isinstance(path, str) or not path:
        problems.append("missing_source_path")


def _validate_evidence_target(
    job: dict, entries: list[dict], problems: list[str]
) -> None:
    target = job.get("target_line")
    evidence_lines = [str(entry.get("text", "")) for entry in entries]
    if isinstance(target, str) and target not in evidence_lines:
        problems.append("target_not_in_evidence")


def _validate_evidence_visibility(
    job: dict, entries: list[dict], problems: list[str]
) -> None:
    if job.get("visibility") != "public":
        return
    if any(entry.get("visibility") == "staff" for entry in entries):
        problems.append("staff_evidence_in_public_window")


def _validate_evidence_window(job: dict, problems: list[str]) -> None:
    entries = _evidence_entries(job)
    if not entries:
        problems.append("missing_evidence")
        return
    rendered = _render_evidence_entries(entries)
    _validate_evidence_size(entries, rendered, problems)
    _validate_evidence_rendering(job, rendered, problems)
    _validate_evidence_lines(job, entries, problems)
    _validate_evidence_source(job, problems)
    _validate_evidence_target(job, entries, problems)
    _validate_evidence_visibility(job, entries, problems)

def _validate_required_fields(parsed: dict, problems: list[str]) -> None:
    for key in ("category", "scenario", "user", "assistant", "tags"):
        if key not in parsed:
            problems.append(f"missing:{key}")


def _validate_generated_lengths(parsed: dict, problems: list[str]) -> None:
    limits = (("scenario", 18), ("user", 30), ("assistant", 70))
    for key, limit in limits:
        value = parsed.get(key)
        if isinstance(value, str) and len(value.split()) > limit:
            problems.append(f"{key}_too_long")


def _validate_generated_shape(parsed: dict, problems: list[str]) -> None:
    forbidden = {
        "facts", "expected_actions", "tools", "source", "source_version",
        "visibility", "evidence_groups", "evidence_ids", "reasoning",
        "chain_of_thought", "analysis", "thoughts",
    }
    if forbidden.intersection(parsed):
        problems.append("forbidden_generated_fields")
    if parsed.get("category") not in CATEGORIES:
        problems.append("bad_category")
    _validate_generated_lengths(parsed, problems)

def _validate_tags(parsed: dict, problems: list[str]) -> None:
    tags = parsed.get("tags")
    if not isinstance(tags, list) or len(tags) > 4 or any(not isinstance(tag, str) for tag in tags):
        problems.append("bad_tags")


def _generated_text(parsed: dict) -> str:
    values: list[str] = []
    for key in ("reason", "scenario", "user", "assistant"):
        value = parsed.get(key)
        if isinstance(value, str):
            values.append(value)
    tags = parsed.get("tags")
    if isinstance(tags, list):
        values.extend(tag for tag in tags if isinstance(tag, str))
    return "\n".join(values)


def _validate_secrets(parsed: dict, problems: list[str]) -> None:
    if any(pattern.search(_generated_text(parsed)) for pattern in SECRET_PATTERNS):
        problems.append("secret_pattern_in_output")


def _literal_values(pattern: re.Pattern[str], text: str) -> set[str]:
    return {value.lower() for value in pattern.findall(text)}


def _append_unsupported_literal(
    pattern: re.Pattern[str],
    assistant: str,
    support: str,
    problem: str,
    problems: list[str],
) -> None:
    available = _literal_values(pattern, support)
    requested = _literal_values(pattern, assistant)
    if requested - available:
        problems.append(problem)


def _critical_literals_supported(
    assistant: str, support: str, problems: list[str]
) -> None:
    _append_unsupported_literal(
        COMMAND_RE, assistant, support, "unsupported_command", problems
    )
    _append_unsupported_literal(
        NUMBER_RE, assistant, support, "unsupported_number", problems
    )
    _append_unsupported_literal(
        PERMISSION_NODE_RE, assistant, support, "unsupported_permission", problems
    )

def _requires_deployment_qualification(job: dict, support: str) -> bool:
    authority = str(job.get("production_authority", "")).lower()
    return authority == "non_production_reference" or bool(NONPRODUCTION_RE.search(support))


def _production_claim_supported(job: dict, assistant: str, support: str) -> bool:
    if QUALIFIED_DEPLOYMENT_RE.search(assistant):
        return True
    if not DEPLOYMENT_CLAIM_RE.search(assistant):
        return True
    if _requires_deployment_qualification(job, support):
        return False
    return bool(EXPLICIT_PRODUCTION_RE.search(support))


def _deployment_qualification_preserved(job: dict, assistant: str, support: str) -> bool:
    if not _requires_deployment_qualification(job, support):
        return True
    return bool(QUALIFIED_DEPLOYMENT_RE.search(assistant))


def _answer_terms_supported(assistant: str, support: str) -> bool:
    answer_terms = _lexemes(assistant)
    support_terms = _lexemes(support)
    material = [
        term for term in answer_terms
        if len(term) >= 5 and term not in SAFE_NATURAL_TERMS and term not in SAFE_ABSTRACT_TERMS
    ]
    if not material:
        return True
    matched = sum(1 for term in material if _term_supported(term, support_terms))
    return matched / len(material) >= 0.45


def _mechanism_supported(assistant: str, support: str) -> bool:
    earning_claim = MECHANISM_CLAIM_RE.search(assistant)
    reputation_effect = REPUTATION_EFFECT_RE.search(assistant)
    if not earning_claim and not reputation_effect:
        return True
    earning_supported = not earning_claim or bool(MECHANISM_CLAIM_RE.search(support))
    effect_supported = (
        not reputation_effect or bool(REPUTATION_EFFECT_RE.search(support))
    )
    return earning_supported and effect_supported


def _player_access_claim_supported(assistant: str, support: str) -> bool:
    """Do not turn capability evidence into normal-player authorization."""
    if not PLAYER_ACCESS_CLAIM_RE.search(assistant):
        return True
    if not RESTRICTED_AUTHORITY_RE.search(support):
        return True
    return bool(EXPLICIT_PLAYER_ACCESS_RE.search(support))


def _teaches_staff_subcommand(
    assistant: str,
    user: str,
    subcommand: str,
) -> bool:
    term = re.escape(subcommand)
    if not re.search(rf"(?i)\b{term}\b", assistant):
        return False
    if not re.search(rf"(?i)\b{term}\b", user):
        return True
    instruction = re.compile(
        rf"(?i)\b(?:use|run|type|enter|execute|invoke|try)\s+"
        rf"(?:the\s+)?(?:\w+\s+)?{term}\b"
    )
    return bool(instruction.search(assistant))


def _append_boundary_literal_problems(
    assistant: str,
    problems: list[str],
) -> None:
    checks = (
        (COMMAND_RE.search(assistant), "staff_command_leak"),
        (PERMISSION_NODE_RE.search(assistant), "staff_permission_leak"),
        (BACKEND_JARGON_RE.search(assistant), "staff_backend_jargon_leak"),
    )
    problems.extend(problem for match, problem in checks if match)


def _boundary_subcommands(job: dict) -> set[str]:
    return {
        match.group(1).lower()
        for match in STAFF_SUBCOMMAND_RE.finditer(_evidence_text(job))
    }


def _append_boundary_subcommand_problem(
    job: dict,
    user: str,
    assistant: str,
    problems: list[str],
) -> None:
    teaches = any(
        _teaches_staff_subcommand(assistant, user, term)
        for term in _boundary_subcommands(job)
    )
    if teaches:
        problems.append("staff_subcommand_leak")


def _append_missing_boundary_problem(
    assistant: str,
    problems: list[str],
) -> None:
    has_boundary = re.search(
        r"(?i)\b(?:staff|internal|admin|operator)\b",
        assistant,
    )
    if not has_boundary:
        problems.append("missing_staff_boundary")


def _validate_boundary(job: dict, parsed: dict, problems: list[str]) -> None:
    if job.get("response_mode") != "player_boundary":
        return
    assistant = str(parsed.get("assistant", ""))
    user = str(parsed.get("user", ""))
    _append_boundary_literal_problems(assistant, problems)
    _append_boundary_subcommand_problem(job, user, assistant, problems)
    _append_missing_boundary_problem(assistant, problems)


def _validate_player_jargon(job: dict, parsed: dict, problems: list[str]) -> None:
    if job.get("response_mode") != "player_support":
        return
    user = str(parsed.get("user", ""))
    assistant = str(parsed.get("assistant", ""))
    if PERMISSION_NODE_RE.search(assistant) and not re.search(r"(?i)\bpermissions?\b", user):
        problems.append("unnecessary_permission_node")
    if BACKEND_JARGON_RE.search(assistant) and not BACKEND_JARGON_RE.search(user):
        problems.append("unnecessary_backend_jargon")


def _validate_owner_truth_negatives(
    job: dict, assistant: str, problems: list[str]
) -> None:
    if re.search(r"(?i)\belite\b", assistant):
        problems.append("forbidden_elite_rank")
    if job.get("response_mode") == "player_support" and re.search(
        r"(?i)(?:^|\s)/fly\b", assistant
    ):
        problems.append("forbidden_general_fly")


def _validate_deployment_grounding(
    job: dict, assistant: str, support: str, problems: list[str]
) -> None:
    if not _production_claim_supported(job, assistant, support):
        problems.append("unsupported_production_claim")
    if not _deployment_qualification_preserved(job, assistant, support):
        problems.append("missing_deployment_qualification")


def _validate_semantic_grounding(
    job: dict, assistant: str, support: str, problems: list[str]
) -> None:
    is_boundary = job.get("response_mode") == "player_boundary"
    if not is_boundary and not _answer_terms_supported(assistant, support):
        problems.append("answer_not_fully_grounded")
    if not is_boundary and not _mechanism_supported(assistant, support):
        problems.append("unsupported_mechanism_claim")
    if (
        not is_boundary
        and not _player_access_claim_supported(assistant, support)
    ):
        problems.append("unsupported_player_authorization")
    if TICK_RATE_EQUIVALENCE_RE.search(assistant):
        problems.append("invalid_tick_rate_equivalence")


def _validate_answer_grounding(job: dict, parsed: dict, problems: list[str]) -> None:
    assistant = parsed.get("assistant")
    if not isinstance(assistant, str) or not assistant.strip():
        problems.append("assistant_empty")
        return
    support = _evidence_text(job)
    _critical_literals_supported(assistant, support, problems)
    _validate_owner_truth_negatives(job, assistant, problems)
    _validate_deployment_grounding(job, assistant, support, problems)
    _validate_semantic_grounding(job, assistant, support, problems)

def _validate_generated_content(job: dict, parsed: dict, problems: list[str]) -> None:
    is_boundary = job.get("response_mode") == "player_boundary"
    if not is_boundary and not _question_is_grounded(job, parsed):
        problems.append("question_not_fully_grounded")
    _validate_secrets(parsed, problems)
    _validate_boundary(job, parsed, problems)
    _validate_player_jargon(job, parsed, problems)
    _validate_answer_grounding(job, parsed, problems)


def _validate_skip(parsed: dict) -> list[str]:
    problems: list[str] = []
    if not isinstance(parsed.get("reason"), str):
        problems.append("skip_missing_reason")
    _validate_secrets(parsed, problems)
    return problems


def validate_output(job: dict, parsed: dict) -> list[str]:
    if parsed.get("skip") is True:
        return _validate_skip(parsed)
    problems: list[str] = []
    _validate_evidence_window(job, problems)
    _validate_required_fields(parsed, problems)
    _validate_generated_shape(parsed, problems)
    _validate_tags(parsed, problems)
    if not problems:
        _validate_generated_content(job, parsed, problems)
    if not problems:
        facts, assistant = _resolve_evidence(job, parsed)
        if not facts or not assistant:
            problems.append("resolved_answer_empty")
    return problems


def _response_schema(_job: dict) -> dict:
    skip_shape = {
        "type": "object",
        "properties": {"skip": {"const": True}, "reason": {"type": "string"}},
        "required": ["skip", "reason"],
        "additionalProperties": False,
    }
    example_shape = {
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": sorted(CATEGORIES)},
            "scenario": {"type": "string"},
            "user": {"type": "string"},
            "assistant": {"type": "string"},
            "tags": {"type": "array", "maxItems": 4, "items": {"type": "string"}},
        },
        "required": ["category", "scenario", "user", "assistant", "tags"],
        "additionalProperties": False,
    }
    return {"oneOf": [skip_shape, example_shape]}
