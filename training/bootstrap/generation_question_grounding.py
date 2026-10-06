from __future__ import annotations

import re

try:
    from training.bootstrap import generation_benchmark_formatting as _formatting
except ModuleNotFoundError:
    import generation_benchmark_formatting as _formatting

PERMISSION_NODE_RE = _formatting.PERMISSION_NODE_RE

QUESTION_STOPWORDS = {
    "a", "an", "and", "are", "can", "could", "do", "does", "for", "from",
    "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "the",
    "to", "use", "using", "what", "when", "where", "which", "who", "why",
    "will", "with", "you", "your", "about", "available", "behavior", "command",
    "commands", "definition", "defined", "feature", "features", "frequency",
    "check", "checking", "happening", "see", "show",
    "guide", "mean", "means", "plugin", "plugins", "rule", "rules", "status",
    "subcommand", "subcommands", "term", "terms",
}
SAFE_NATURAL_TERMS = {
    "actually", "access", "accomplish", "accomplishing", "basically", "can",
    "control", "controls", "could", "directly", "goal", "help", "helps",
    "internal", "just", "manage", "managing", "management", "normal", "option",
    "player", "players", "please", "right", "safe", "server", "simply", "staff",
    "tell", "that", "that's", "thats", "there", "thing", "tool", "try",
    "trying", "use", "want", "yep",
}
SAFE_ABSTRACT_TERMS = {
    "permission", "permissions", "required", "needed", "configuration",
    "configurations", "configure", "configured", "specific", "available",
    "current",
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


def _suffix_variant(
    token: str,
    suffix: str,
    replacement: str,
    minimum_length: int,
) -> str | None:
    if len(token) <= minimum_length or not token.endswith(suffix):
        return None
    return token[:-len(suffix)] + replacement


def _lexeme_variants(token: str) -> set[str]:
    candidates = (
        _suffix_variant(token, "ies", "y", 5),
        _suffix_variant(token, "s", "", 4),
        _suffix_variant(token, "ing", "", 5),
        _suffix_variant(token, "ed", "", 4),
    )
    return {token, *(candidate for candidate in candidates if candidate is not None)}


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
    has_evidence = bool(
        re.search(r"\bpermissions?\b", support)
        or PERMISSION_NODE_RE.search(support)
    )
    return asks_permission, has_evidence


def _version_supported(question: str, support: str) -> bool:
    return (
        "version" not in question
        or "version" in support
        or bool(re.search(r"\b\d+(?:\.\d+)+", support))
    )


def _semantic_support(
    question: str,
    support: str,
    asks_permission: bool,
    has_permission: bool,
) -> str:
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
    return any(
        candidate.startswith(term)
        for candidate in support_terms
        if len(candidate) >= len(term)
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


def _grounding_terms_match(question: str, support: str) -> bool:
    question_terms = _lexemes(question)
    if not question_terms:
        return True
    support_terms = _lexemes(support)
    if not _long_terms_supported(question_terms, support_terms):
        return False
    matched = sum(
        1 for term in question_terms if _term_supported(term, support_terms)
    )
    return matched / len(question_terms) >= 0.50


def _job_evidence_text(job: dict) -> str:
    explicit = job.get("evidence_text")
    if isinstance(explicit, str) and explicit.strip():
        return explicit
    entries = job.get("evidence")
    if isinstance(entries, list):
        return "\n".join(
            str(entry.get("text", ""))
            for entry in entries
            if isinstance(entry, dict)
        )
    line = job.get("target_line")
    return line if isinstance(line, str) else ""


def _question_is_grounded(job: dict, parsed: dict) -> bool:
    question = parsed.get("user")
    if not isinstance(question, str):
        return False
    support = " ".join(
        (
            _job_evidence_text(job),
            str(job.get("repository", "")),
            str(job.get("path", "")),
        )
    ).lower()
    lowered = question.lower()
    asks_permission, has_permission = _permission_support(lowered, support)
    if not _semantic_scope_supported(lowered, support):
        return False
    if asks_permission and not has_permission:
        return False
    if not _version_supported(lowered, support):
        return False
    semantic_support = _semantic_support(
        lowered, support, asks_permission, has_permission
    )
    return _grounding_terms_match(lowered, semantic_support)
