from __future__ import annotations

import json
import re
import urllib.parse

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
        r"\s*[:=]\s*['\"]?([^\s'\"#]{12,})"
    ),
]
PERMISSION_NODE_RE = re.compile(r"\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b")
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
    r"(?i)\b(?:staging|test(?:ing)?|non[- ]production|not presently installed|"
    r"not currently loaded|when deployed|next deployment)\b"
)
QUALIFIED_DEPLOYMENT_RE = re.compile(
    r"(?i)\b(?:when|if|once) deployed\b|"
    r"\b(?:not|isn't|is not) (?:currently |presently )?(?:live|available|installed|loaded)\b|"
    r"\bcurrently unavailable\b"
)
BACKEND_JARGON_RE = re.compile(
    r"(?i)\b(?:backend|database|sqlite|webhook|internal api|implementation detail|"
    r"service manager|credential|operator permission)\b"
)
MECHANISM_CLAIM_RE = re.compile(
    r"(?i)\b(?:earn|get|gain|receive|awarded?|obtain)\b.{0,60}"
    r"\b(?:by|when|after|for)\b"
)
QUESTION_STOPWORDS = {
    "a", "an", "and", "are", "can", "could", "do", "does", "for", "from",
    "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "the",
    "to", "use", "using", "what", "when", "where", "which", "who", "why",
    "will", "with", "you", "your", "about", "available", "behavior", "command",
    "commands", "definition", "defined", "feature", "features", "frequency",
    "guide", "mean", "means", "plugin", "plugins", "rule", "rules",
    "subcommand", "subcommands", "term", "terms",
}
SAFE_NATURAL_TERMS = {
    "actually", "basically", "can", "could", "directly", "help", "helps",
    "just", "option", "please", "right", "simply", "tell", "that", "that's",
    "thats", "there", "thing", "tool", "try", "use", "want", "yep",
}
SAFE_ABSTRACT_TERMS = {
    "permission", "permissions", "required", "needed", "configuration",
    "configure", "configured", "specific", "available", "current",
}
SEMANTIC_SCOPE_CHECKS = (
    (re.compile(r"\brank\b"), re.compile(r"\brank\b")),
    (re.compile(r"\b(?:price|cost)\b"), re.compile(r"\b(?:price|cost|usd)\b|\$")),
    ("leaderboard", "leaderboard"),
    ("arena", "arena"),
    ("cooldown", "cooldown"),
    (re.compile(r"\brules?\b"), re.compile(r"\brules?\b")),
)
RATE_EVIDENCE_RE = re.compile(r"(?:per second|per tick|every tick|interval|cps|rate)")


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


def _split_markdown_table_row(text: str) -> list[str]:
    inner = text.strip().strip("|")
    cells = re.split(r"(?<!\\)\|", inner)
    cleaned: list[str] = []
    for cell in cells:
        value = (
            cell.strip()
            .replace("\\|", "|")
            .replace("**", "")
            .replace("__", "")
            .replace(chr(96), "")
        )
        if value and not re.fullmatch(r":?-{3,}:?", value):
            cleaned.append(value)
    return cleaned


def _render_command_table(cells: list[str]) -> str:
    command = cells[0]
    rest = list(cells[1:])
    permission = next((cell for cell in rest if PERMISSION_NODE_RE.fullmatch(cell)), None)
    if permission is not None:
        rest.remove(permission)
    rendered = command
    if rest:
        rendered += f": {rest.pop(0)}"
    if permission:
        rendered += f" Permission: {permission}"
    for extra in rest:
        rendered += f" {'Example' if extra.startswith('/') else 'Details'}: {extra}"
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
    text = text.replace("**", "").replace("__", "").replace(chr(96), "")
    command_comment = re.fullmatch(r"(/[^#]+?)\s+#\s+(.+)", text)
    if command_comment:
        return f"{command_comment.group(1).strip()}: {command_comment.group(2).strip()}"
    if text.lower().startswith("usage:"):
        value = re.sub(r"&[0-9A-FK-ORa-fk-or]", "", text[6:].strip().strip('"').strip("'"))
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


def _contains_pattern(value: str, pattern: str | re.Pattern[str]) -> bool:
    return pattern in value if isinstance(pattern, str) else bool(pattern.search(value))


def _semantic_scope_supported(question: str, support: str) -> bool:
    return all(
        not _contains_pattern(question, question_pattern)
        or _contains_pattern(support, support_pattern)
        for question_pattern, support_pattern in SEMANTIC_SCOPE_CHECKS
    )


def _permission_support(question: str, support: str) -> tuple[bool, bool]:
    asks_permission = bool(re.search(r"\bpermissions?\b", question))
    has_evidence = bool(re.search(r"\bpermissions?\b", support) or PERMISSION_NODE_RE.search(support))
    return asks_permission, has_evidence


def _version_supported(question: str, support: str) -> bool:
    return "version" not in question or "version" in support or bool(re.search(r"\b\d+(?:\.\d+)+", support))


def _semantic_support(question: str, support: str, asks_permission: bool, has_permission: bool) -> str:
    result = support
    if asks_permission and has_permission:
        result += " permission required needed"
    if "speed" in question and RATE_EVIDENCE_RE.search(support):
        result += " speed"
    return result


def _term_supported(term: str, support_terms: set[str]) -> bool:
    if term in support_terms:
        return True
    if len(term) < 5:
        return False
    return any(candidate.startswith(term) for candidate in support_terms if len(candidate) >= len(term))


def _long_terms_supported(question_terms: set[str], support_terms: set[str]) -> bool:
    return all(
        len(term) < 8 or term in SAFE_ABSTRACT_TERMS or _term_supported(term, support_terms)
        for term in question_terms
    )


def _grounding_terms_match(question: str, support: str) -> bool:
    question_terms = _lexemes(question)
    if not question_terms:
        return True
    support_terms = _lexemes(support)
    if not _long_terms_supported(question_terms, support_terms):
        return False
    matched = sum(1 for term in question_terms if _term_supported(term, support_terms))
    return matched / len(question_terms) >= 0.50


def _question_is_grounded(job: dict, parsed: dict) -> bool:
    question = parsed.get("user")
    if not isinstance(question, str):
        return False
    support = " ".join((_evidence_text(job), str(job.get("repository", "")), str(job.get("path", "")))).lower()
    lowered = question.lower()
    asks_permission, has_permission = _permission_support(lowered, support)
    if not _semantic_scope_supported(lowered, support):
        return False
    if asks_permission and not has_permission:
        return False
    if not _version_supported(lowered, support):
        return False
    return _grounding_terms_match(
        lowered,
        _semantic_support(lowered, support, asks_permission, has_permission),
    )


def _validate_evidence_window(job: dict, problems: list[str]) -> None:
    entries = _evidence_entries(job)
    if not entries:
        problems.append("missing_evidence")
        return
    if len(entries) > 12 or len(_evidence_text(job)) > 2400:
        problems.append("evidence_window_too_large")
    target = job.get("target_line")
    if isinstance(target, str) and target not in [str(entry.get("text", "")) for entry in entries]:
        problems.append("target_not_in_evidence")
    if job.get("visibility") == "public" and any(entry.get("visibility") == "staff" for entry in entries):
        problems.append("staff_evidence_in_public_window")


def _validate_required_fields(parsed: dict, problems: list[str]) -> None:
    for key in ("category", "scenario", "user", "assistant", "tags"):
        if key not in parsed:
            problems.append(f"missing:{key}")


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
    if isinstance(parsed.get("scenario"), str) and len(parsed["scenario"].split()) > 18:
        problems.append("scenario_too_long")
    if isinstance(parsed.get("user"), str) and len(parsed["user"].split()) > 30:
        problems.append("user_too_long")
    assistant = parsed.get("assistant")
    if isinstance(assistant, str) and len(assistant.split()) > 70:
        problems.append("assistant_too_long")


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


def _critical_literals_supported(assistant: str, support: str, problems: list[str]) -> None:
    support_lower = support.lower()
    for command in set(COMMAND_RE.findall(assistant)):
        if command.lower() not in support_lower:
            problems.append("unsupported_command")
            break
    for number in set(NUMBER_RE.findall(assistant)):
        if number not in support:
            problems.append("unsupported_number")
            break
    for permission in set(PERMISSION_NODE_RE.findall(assistant)):
        if permission.lower() not in support_lower:
            problems.append("unsupported_permission")
            break


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
    if not MECHANISM_CLAIM_RE.search(assistant):
        return True
    return bool(MECHANISM_CLAIM_RE.search(support))


def _validate_boundary(job: dict, parsed: dict, problems: list[str]) -> None:
    if job.get("response_mode") != "player_boundary":
        return
    assistant = str(parsed.get("assistant", ""))
    if COMMAND_RE.search(assistant):
        problems.append("staff_command_leak")
    if PERMISSION_NODE_RE.search(assistant):
        problems.append("staff_permission_leak")
    if BACKEND_JARGON_RE.search(assistant):
        problems.append("staff_backend_jargon_leak")


def _validate_player_jargon(job: dict, parsed: dict, problems: list[str]) -> None:
    if job.get("response_mode") != "player_support":
        return
    user = str(parsed.get("user", ""))
    assistant = str(parsed.get("assistant", ""))
    if PERMISSION_NODE_RE.search(assistant) and not re.search(r"(?i)\bpermissions?\b", user):
        problems.append("unnecessary_permission_node")
    if BACKEND_JARGON_RE.search(assistant) and not BACKEND_JARGON_RE.search(user):
        problems.append("unnecessary_backend_jargon")


def _validate_answer_grounding(job: dict, parsed: dict, problems: list[str]) -> None:
    assistant = parsed.get("assistant")
    if not isinstance(assistant, str) or not assistant.strip():
        problems.append("assistant_empty")
        return
    support = _evidence_text(job)
    _critical_literals_supported(assistant, support, problems)
    if re.search(r"(?i)\belite\b", assistant):
        problems.append("forbidden_elite_rank")
    if job.get("response_mode") == "player_support" and re.search(r"(?i)(?:^|\s)/fly\b", assistant):
        problems.append("forbidden_general_fly")
    if not _production_claim_supported(job, assistant, support):
        problems.append("unsupported_production_claim")
    if not _deployment_qualification_preserved(job, assistant, support):
        problems.append("missing_deployment_qualification")
    if (
        job.get("response_mode") != "player_boundary"
        and not _answer_terms_supported(assistant, support)
    ):
        problems.append("answer_not_fully_grounded")
    if not _mechanism_supported(assistant, support):
        problems.append("unsupported_mechanism_claim")


def _validate_generated_content(job: dict, parsed: dict, problems: list[str]) -> None:
    if not _question_is_grounded(job, parsed):
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
