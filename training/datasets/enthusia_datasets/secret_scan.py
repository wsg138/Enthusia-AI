"""Secret scanning for dataset records.

Any record containing a credential pattern is REJECTED outright: it never
enters a training partition, never lands in a manifest's counts, and is
reported in the manifest exclusions. Secrets are never redacted-and-kept;
rejection is the only outcome (spec section 10, automated filters).

Scanned fields: scenario, all message contents, expected_answer, tool/action
strings, fact claims/sources/versions, and tags. Record ids are not scanned
(they are pipeline keys).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class SecretFinding:
    pattern: str
    field: str
    # Redacted excerpt: the matched secret itself is never included.
    excerpt: str


# (name, compiled pattern). Patterns match *shapes* of secrets, never real values.
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b")),
    ("github_token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b")),
    ("github_fine_grained_pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("aws_secret_key", re.compile(r"(?i)\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*\S+")),
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("stripe_live_key", re.compile(r"\b[rs]k_live_[A-Za-z0-9]{16,}\b")),
    ("discord_token", re.compile(r"\b[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b")),
    ("bearer_token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{16,}={0,2}\b")),
    (
        "credential_assignment",
        re.compile(
            r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|client[_-]?secret)\b"
            r"\s*[:=]\s*(\S{6,})"
        ),
    ),
    # High-entropy quoted assignment, e.g. "token": "aB3...". Requires both a
    # credential-ish key name and a long mixed token value to avoid flagging
    # ordinary config values.
    (
        "quoted_credential",
        re.compile(
            r"(?i)[\"'](?:token|api[_-]?key|secret|password)[\"']\s*[:=]\s*[\"']"
            r"(?=[\"'][^\"']*[A-Za-z])(?=[\"'][^\"']*[0-9])[^\"']{16,}[\"']"
        ),
    ),
]


def _excerpt(text: str, match: re.Match, radius: int = 24) -> str:
    start = max(0, match.start() - radius)
    end = min(len(text), match.end() + radius)
    snippet = text[start:end]
    # Redact the matched secret itself; show only surrounding context.
    redacted = snippet.replace(match.group(0), "***REDACTED***")
    return " ".join(redacted.split())


def _scannable_fields(rec: dict) -> list[tuple[str, str]]:
    """(field_path, text) pairs to scan. Ids and structural keys are excluded."""
    out: list[tuple[str, str]] = []
    if isinstance(rec.get("scenario"), str):
        out.append(("scenario", rec["scenario"]))
    for i, m in enumerate(rec.get("messages", [])):
        if isinstance(m, dict) and isinstance(m.get("content"), str):
            out.append((f"messages[{i}].content", m["content"]))
    if isinstance(rec.get("expected_answer"), str):
        out.append(("expected_answer", rec["expected_answer"]))
    for field_name in ("tools", "expected_actions"):
        for i, value in enumerate(rec.get(field_name, [])):
            if isinstance(value, str):
                out.append((f"{field_name}[{i}]", value))
    for i, f in enumerate(rec.get("facts", [])):
        if isinstance(f, dict):
            for sub in ("claim", "source", "source_version"):
                if isinstance(f.get(sub), str):
                    out.append((f"facts[{i}].{sub}", f[sub]))
    for i, t in enumerate(rec.get("tags", [])):
        if isinstance(t, str):
            out.append((f"tags[{i}]", t))
    return out


def scan_record(rec: dict) -> list[SecretFinding]:
    """Return all secret findings in a record. Empty list means clean."""
    findings: list[SecretFinding] = []
    for field_path, text in _scannable_fields(rec):
        for name, pattern in _PATTERNS:
            for match in pattern.finditer(text):
                findings.append(
                    SecretFinding(
                        pattern=name,
                        field=field_path,
                        excerpt=_excerpt(text, match),
                    )
                )
    # Deterministic ordering for reports.
    findings.sort(key=lambda f: (f.field, f.pattern, f.excerpt))
    return findings


def record_has_secrets(rec: dict) -> bool:
    return bool(scan_record(rec))


def pattern_names() -> list[str]:
    return [name for name, _ in _PATTERNS]
