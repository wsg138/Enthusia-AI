from __future__ import annotations

import json
import re
import urllib.parse

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
