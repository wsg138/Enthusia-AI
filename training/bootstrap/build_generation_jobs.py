#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import re
from pathlib import Path

CATEGORIES = [
    "onboarding", "commands", "permissions", "rank", "economy", "tickets",
    "rules", "bugs", "account linking", "ambiguity", "escalation",
    "stale data", "conflicting evidence", "privacy",
]

DOC_EXTS = {".md", ".txt", ".rst"}
CONFIG_EXTS = {".yml", ".yaml", ".json", ".toml", ".properties", ".ini", ".cfg", ".xml"}
SOURCE_EXTS = {".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}

STAFF_SOURCE_ROLES = {
    "staff_system",
    "infrastructure",
    "infrastructure_docs",
    "network_configuration",
    "staging_reference",
    "moderation_system",
    "ai_system",
    "infrastructure_test",
    "support_system",
}

USEFUL_TERMS = (
    "command", "permission", "usage", "rank", "role", "rule", "price", "cost",
    "cooldown", "limit", "requires", "required", "allowed", "denied", "toggle",
    "enable", "disable", "join", "link", "unlink", "ticket", "mail", "claim",
    "guild", "home", "teleport", "vote", "tag", "market", "currency", "balance",
    "staff", "ban", "mute", "warn", "report", "appeal", "autoclick", "event",
)

CODE_PREFIXES = (
    "import ", "package ", "class ", "public class ", "private ", "protected ",
    "def ", "function ", "const ", "let ", "var ", "interface ", "type ",
    "return ", "throw ", "if (", "for (", "while (",
)

STAFF_PATH_TOKENS = (
    "/src/", "/internal/", "/config/", "config.", "config-", "/audit",
    "/admins/", "/admin/",
)
STAFF_LINE_TOKENS = (
    "/punish", "/ban ", "/ban<", "/mute ", "/mute<", "/kick ",
    "blacklist", "administrator", "admin permission",
    ".admin", "staff-only", "staff only",
)
STAFF_LINE_PATTERNS = (
    re.compile(r"(?:^|\s)/\S+\s+reload\b"),
    re.compile(r"\b(?:reload|debug|admin|adminview|breakothers|freeze|unfreeze)\b"),
    re.compile(
        r"(?:^|\s)/(?:ee|estaff|startupguardian|gatekeeper|tppos|warzone|shopmarket|ekoth)\b"
    ),
    re.compile(r"(?:^|\s)/pearlglitchblocker\b"),
    re.compile(r"(?:^|\s)/warzone\s+modifier\b"),
)
EXCLUDED_PATH_MARKERS = (
    "test_rollout", "test-rollout", "/test_setup", "/test-setup",
    "owner_retest", "owner-retest", "/retest", "acceptance-harness",
    "acceptance_harness", "component-metadata", "wiki-maintenance",
    "workspace-state", "codacy-evidence", "codacy_evidence",
)
EXCLUDED_ROOTED_PATHS = ("/legacy/", "/handoffs/", "/ai-agents/")
EXCLUDED_PREFIXES = ("legacy/", "handoffs/", "ai-agents/")
HIGH_VALUE_PATH_TOKENS = (
    "/docs/", "/wiki/", "readme", "commands", "permissions", "rules",
    "config", "plugin.yml", "paper-plugin.yml", "server.properties",
    "messages", "help", "support", "link", "rank", "econom", "ticket",
)
CURRENT_SERVER_PREFIXES = tuple(
    f"network-snapshot/{server}/current/"
    for server in ("smp", "hub", "velocity", "sentinel")
)


def _path_is_staff(path: str) -> bool:
    lower = path.lower()
    ext = Path(path).suffix.lower()
    name = Path(path).name.lower()
    if ext in SOURCE_EXTS:
        return True
    if ext in CONFIG_EXTS and name not in {"plugin.yml", "paper-plugin.yml"}:
        return True
    return any(token in lower for token in STAFF_PATH_TOKENS)


def _line_is_staff(line: str) -> bool:
    lower = line.lower()
    if any(token in lower for token in STAFF_LINE_TOKENS):
        return True
    if STAFF_LINE_PATTERNS[1].search(lower) and "/" not in lower:
        return False
    return any(pattern.search(lower) for pattern in STAFF_LINE_PATTERNS)


def source_visibility(record: dict, line: str = "") -> str:
    if record.get("role") in STAFF_SOURCE_ROLES:
        return "staff"
    path = str(record.get("path", "")).replace("\\", "/")
    return "staff" if _path_is_staff(path) or _line_is_staff(line) else "public"


def _path_is_excluded(lower_path: str) -> bool:
    rooted = "/" + lower_path
    if any(marker in lower_path for marker in EXCLUDED_PATH_MARKERS):
        return True
    if any(marker in rooted for marker in EXCLUDED_ROOTED_PATHS):
        return True
    return lower_path.startswith(EXCLUDED_PREFIXES)


def _base_path_score(path: str) -> int:
    ext = Path(path).suffix.lower()
    if ext in DOC_EXTS:
        return 50
    if ext in CONFIG_EXTS:
        return 35
    return 10 if ext in SOURCE_EXTS else 0


def _is_current_server_path(record: dict, lower: str) -> bool:
    return (
        record["repository"] == "Enthusia-Server"
        and lower.startswith(CURRENT_SERVER_PREFIXES)
    )


def _is_test_path(lower: str) -> bool:
    return any(
        marker in lower
        for marker in ("/test/", "/tests/")
    ) or lower.startswith("tests/")


def _is_github_path(lower: str) -> bool:
    return "/.github/" in "/" + lower or lower.startswith(".github/")


def _path_score_adjustment(record: dict, lower: str) -> int:
    return (
        25 * int(any(token in lower for token in HIGH_VALUE_PATH_TOKENS))
        + 30 * int(_is_current_server_path(record, lower))
        - 45 * int(_is_test_path(lower))
        - 25 * int(_is_github_path(lower))
        - 15 * int("changelog" in lower)
    )


HARD_EXCLUDED_PATH_TOKENS = (
    "cinematic-review",
    "/assets/",
    "config-audit",
)


def _hard_excluded_path(lower: str) -> bool:
    return (
        any(token in lower for token in HARD_EXCLUDED_PATH_TOKENS)
        or lower.endswith("/implementation.md")
    )


def path_score(record: dict) -> int:
    # The AI implementation itself is retrieval/runtime knowledge, not useful
    # SFT truth. Training it back into the model would fossilize architecture.
    path = record["path"].replace("\\", "/")
    lower = path.lower()
    excluded = (
        record.get("role") == "ai_system"
        or _path_is_excluded(lower)
        or _hard_excluded_path(lower)
    )
    return (
        -10_000
        if excluded
        else _base_path_score(path) + _path_score_adjustment(record, lower)
    )


def clean_candidate_line(raw_line: str) -> str:
    return raw_line.rstrip("\r").strip()


def _bad_line_length(line: str) -> bool:
    return not 15 <= len(line) <= 500


def _header_stub(line: str) -> bool:
    stripped = line.strip()
    return (
        stripped.endswith(":")
        and not stripped.startswith(("http://", "https://"))
    )


def _bad_text_marker(line: str, lower: str) -> bool:
    has_shading_marker = "shaded" in lower and "relocated" in lower
    return "\ufffd" in line or has_shading_marker


def _config_comment(line: str, ext: str) -> bool:
    return ext in CONFIG_EXTS and line.lstrip().startswith("#")


def _status_marker(line: str) -> bool:
    return bool(re.search(r"\b[A-Z][A-Z0-9_]{4,}_OK\b", line))


def _missing_alphanumeric(line: str) -> bool:
    return not bool(re.search(r"[A-Za-z0-9]", line))


def _punctuation_only(line: str) -> bool:
    return bool(re.fullmatch(r"[{}\[\](),:;<>/\\|\x60~*#=+_. -]+", line))


def _line_is_rejected(line: str, lower: str, ext: str) -> bool:
    checks = (
        _bad_line_length(line),
        _header_stub(line),
        _bad_text_marker(line, lower),
        _config_comment(line, ext),
        _status_marker(line),
        _missing_alphanumeric(line),
        _punctuation_only(line),
    )
    return any(checks)


def _source_line_adjustment(line: str, lower: str, ext: str) -> int:
    if ext not in SOURCE_EXTS:
        return 0
    adjustment = -45 if lower.startswith(CODE_PREFIXES) else 0
    return adjustment - 10 if re.search(r"[{};]$", line) else adjustment


def _table_line_adjustment(line: str) -> int:
    if not (line.startswith("|") and line.endswith("|")):
        return 0
    adjustment = 20
    if re.search(r"/[A-Za-z][A-Za-z0-9_-]*", line):
        adjustment += 45
    if re.search(r"[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+){1,}", line):
        adjustment += 30
    return adjustment


COMMAND_LINE_RE = re.compile(r"(^|\s)/[A-Za-z][A-Za-z0-9_-]*")
PERMISSION_NODE_LINE_RE = re.compile(
    r"[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+){1,}"
)


def _semantic_line_adjustment(line: str, lower: str) -> int:
    return (
        35 * int(bool(COMMAND_LINE_RE.search(line)))
        + 15 * int(bool(PERMISSION_NODE_LINE_RE.search(line)))
        + 20 * int(any(term in lower for term in USEFUL_TERMS))
        - 15 * int(lower.startswith(("# ", "## ", "### ")))
        + 5 * int(lower.startswith(("- ", "* ", "+ ")))
    )


def _length_adjustment(line: str) -> int:
    if len(line) <= 220:
        return 10
    return -20 if len(line) > 350 else 0


def line_score(record: dict, line: str, base_score: int) -> int:
    lower = line.lower()
    ext = Path(record["path"]).suffix.lower()
    if _line_is_rejected(line, lower, ext):
        return -10_000
    return (
        base_score
        + _source_line_adjustment(line, lower, ext)
        + _table_line_adjustment(line)
        + _semantic_line_adjustment(line, lower)
        + _length_adjustment(line)
    )


def context_for(lines: list[str], target_index: int, radius: int = 2) -> str:
    start = max(0, target_index - radius)
    end = min(len(lines), target_index + radius + 1)
    rendered: list[str] = []
    for index in range(start, end):
        marker = "TARGET" if index == target_index else "CONTEXT"
        rendered.append(f"[{marker}] {lines[index]}")
    return "\n".join(rendered)


def build_prompt(job: dict) -> str:
    categories = ", ".join(CATEGORIES)
    return f"""You are writing metadata for ONE source-grounded Enthusia AI training example.

The factual answer is fixed by TARGET_LINE below. You are NOT allowed to write or
paraphrase the answer. If TARGET_LINE is not useful for a player-support or staff-assistance
question, output exactly:
{{"skip":true,"reason":"not useful for support training"}}

Otherwise output exactly one JSON object with these keys:
- category: one of [{categories}]
- scenario: at most 18 words describing the support situation
- user: a natural user/player/staff question, at most 30 words
- tags: at most 4 short useful labels

Rules:
1. The user question must be completely answerable by TARGET_LINE alone.
2. Reuse TARGET_LINE terminology for factual nouns, commands, permissions, versions,
   ranks, prices, and behavior. Do not broaden the question beyond the line.
3. CONTEXT lines are only for understanding names/meaning; they are NOT evidence and
   must not introduce additional facts into the question.
4. If TARGET_LINE is repository-development/build/CI detail rather than useful server
   support, player behavior, staff operations, or troubleshooting, return skip.
5. Do not include an assistant answer, claims, evidence IDs, source IDs, SHAs, tool calls,
   visibility, expected actions, chain-of-thought, or hidden reasoning.
6. Never ask for, expose, or reproduce a password, API key, token, private key, database
   credential, SFTP credential, or secret value.
7. Use category "privacy" for secrets, credentials, private data, or unauthorized
   disclosure. Use category "rules" for actual player/server rules.

REPOSITORY_ROLE: {job["role"]}
PATH: {job["path"]}

TARGET_LINE:
<<<
{job["target_line"]}
>>>

NEARBY_CONTEXT:
<<<
{job["context"]}
>>>
"""


def _record_candidates(
    record: dict,
) -> list[tuple[int, dict, int, list[str]]]:
    base = path_score(record)
    if base <= 0:
        return []
    lines = [
        clean_candidate_line(line)
        for line in record.get("content", "").splitlines()
    ]
    scored = (
        (line_score(record, line, base), record, index, lines)
        for index, line in enumerate(lines)
    )
    return [candidate for candidate in scored if candidate[0] > 0]


def _candidate_sort_key(
    item: tuple[int, dict, int, list[str]],
) -> tuple[int, str, str, int]:
    return (
        -item[0],
        item[1]["repository"],
        item[1]["path"],
        item[2],
    )


def _load_candidates(input_path: str) -> list[tuple[int, dict, int, list[str]]]:
    candidates: list[tuple[int, dict, int, list[str]]] = []
    with gzip.open(input_path, "rt", encoding="utf-8") as fh:
        for raw in fh:
            candidates.extend(_record_candidates(json.loads(raw)))
    candidates.sort(key=_candidate_sort_key)
    return candidates


def _job_from_candidate(
    score: int,
    record: dict,
    line_index: int,
    lines: list[str],
) -> dict:
    repo = record["repository"]
    target_line = lines[line_index]
    digest = hashlib.sha256(
        (
            f'{repo}\n{record["commit_sha"]}\n{record["path"]}\n'
            f'{line_index}\n{target_line}'
        ).encode("utf-8")
    ).hexdigest()[:16]
    source_id = (
        f'github:wsg138/{repo}@{record["commit_sha"]}:'
        f'{record["path"]}#line-{line_index + 1}'
    )
    job = {
        "job_id": f"ground-{digest}",
        "source_id": source_id,
        "source_version": record["commit_sha"],
        "repository": repo,
        "role": record.get("role"),
        "visibility": source_visibility(record, target_line),
        "path": record["path"],
        "line_number": line_index + 1,
        "source_score": score,
        "target_line": target_line,
        "context": context_for(lines, line_index),
    }
    job["prompt"] = build_prompt(job)
    return job


def _select_jobs(
    candidates: list[tuple[int, dict, int, list[str]]],
    max_jobs: int,
    per_repo_cap: int,
) -> tuple[list[dict], collections.Counter, set[tuple[str, str]]]:
    repo_counts: collections.Counter = collections.Counter()
    jobs: list[dict] = []
    source_files: set[tuple[str, str]] = set()
    seen_content: set[tuple[str, str]] = set()

    for score, record, line_index, lines in candidates:
        repo = record["repository"]
        target_line = lines[line_index]
        dedupe_key = (repo, target_line)
        if repo_counts[repo] >= per_repo_cap or dedupe_key in seen_content:
            continue

        seen_content.add(dedupe_key)
        jobs.append(_job_from_candidate(score, record, line_index, lines))
        repo_counts[repo] += 1
        source_files.add((repo, record["path"]))
        if len(jobs) >= max_jobs:
            break
    return jobs, repo_counts, source_files


def _write_jobs(output_path: str, jobs: list[dict]) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8") as out:
        for job in jobs:
            out.write(json.dumps(job, ensure_ascii=False) + "\n")


def _build_manifest(
    jobs: list[dict],
    source_files: set[tuple[str, str]],
    repo_counts: collections.Counter,
    max_jobs: int,
    per_repo_cap: int,
) -> dict:
    return {
        "schema_version": 2,
        "selection": "deterministic-high-value-source-line",
        "job_count": len(jobs),
        "source_file_count": len(source_files),
        "repositories": len(repo_counts),
        "jobs_by_repository": dict(repo_counts.most_common()),
        "max_jobs": max_jobs,
        "per_repo_cap": per_repo_cap,
        "generator_contract": {
            "one_fixed_evidence_line_per_job": True,
            "model_does_not_write_answer": True,
            "model_does_not_choose_evidence": True,
            "model_does_not_choose_visibility": True,
            "skip_allowed": True,
            "chain_of_thought_forbidden": True,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--max-jobs", type=int, default=1200)
    ap.add_argument("--per-repo-cap", type=int, default=80)
    args = ap.parse_args()

    candidates = _load_candidates(args.input)
    jobs, repo_counts, source_files = _select_jobs(
        candidates,
        args.max_jobs,
        args.per_repo_cap,
    )
    _write_jobs(args.output, jobs)
    manifest = _build_manifest(
        jobs,
        source_files,
        repo_counts,
        args.max_jobs,
        args.per_repo_cap,
    )
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
