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


def source_visibility(record: dict) -> str:
    role = record.get("role")
    if role in STAFF_SOURCE_ROLES:
        return "staff"

    path = str(record.get("path", "")).replace("\\", "/")
    lower = path.lower()
    ext = Path(path).suffix.lower()
    name = Path(path).name.lower()

    # Implementation source and mutable/internal configuration are staff
    # context even inside otherwise player-facing plugin repositories.
    if ext in SOURCE_EXTS:
        return "staff"
    if ext in CONFIG_EXTS and name not in {"plugin.yml", "paper-plugin.yml"}:
        return "staff"
    if any(token in lower for token in (
        "/src/", "/internal/", "/config/", "config.", "config-", "/audit",
    )):
        return "staff"

    return "public"


def path_score(record: dict) -> int:
    # The AI implementation itself is retrieval/runtime knowledge, not useful
    # SFT truth. Training it back into the model would fossilize architecture.
    if record.get("role") == "ai_system":
        return -10_000

    path = record["path"].replace("\\", "/")
    lower = path.lower()
    ext = Path(path).suffix.lower()
    score = 0

    if ext in DOC_EXTS:
        score += 50
    elif ext in CONFIG_EXTS:
        score += 35
    elif ext in SOURCE_EXTS:
        score += 10

    if any(token in lower for token in (
        "/docs/", "/wiki/", "readme", "commands", "permissions", "rules",
        "config", "plugin.yml", "paper-plugin.yml", "server.properties",
        "messages", "help", "support", "link", "rank", "econom", "ticket",
    )):
        score += 25

    if record["repository"] == "Enthusia-Server" and any(
        lower.startswith(f"network-snapshot/{server}/current/")
        for server in ("smp", "hub", "velocity", "sentinel")
    ):
        score += 30

    if "/test/" in lower or "/tests/" in lower or lower.startswith("tests/"):
        score -= 45
    if "cinematic-review" in lower or "/assets/" in lower:
        return -10_000
    if "config-audit" in lower or lower.endswith("/implementation.md"):
        return -10_000
    if "/.github/" in "/" + lower or lower.startswith(".github/"):
        score -= 25
    if "changelog" in lower:
        score -= 15
    return score


def clean_candidate_line(raw_line: str) -> str:
    return raw_line.rstrip("\r").strip()


def line_score(record: dict, line: str, base_score: int) -> int:
    lower = line.lower()
    ext = Path(record["path"]).suffix.lower()
    score = base_score

    if not (15 <= len(line) <= 500):
        return -10_000
    if "\ufffd" in line:
        return -10_000
    if ext in CONFIG_EXTS and line.lstrip().startswith("#"):
        return -10_000
    if "shaded" in lower and "relocated" in lower:
        return -10_000
    if re.search(r"\b[A-Z][A-Z0-9_]{4,}_OK\b", line):
        return -10_000
    if not re.search(r"[A-Za-z0-9]", line):
        return -10_000
    if re.fullmatch(r"[{}\[\](),:;<>/\\|\x60~*#=+_. -]+", line):
        return -10_000

    if ext in SOURCE_EXTS and lower.startswith(CODE_PREFIXES):
        score -= 45
    if ext in SOURCE_EXTS and re.search(r"[{};]$", line):
        score -= 10

    if line.startswith("|") and line.endswith("|"):
        score += 20
        if re.search(r"/[A-Za-z][A-Za-z0-9_-]*", line):
            score += 45
        if re.search(r"[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+){1,}", line):
            score += 30

    if re.search(r"(^|\s)/[A-Za-z][A-Za-z0-9_-]*", line):
        score += 35
    if re.search(r"[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+){1,}", line):
        score += 15
    if any(term in lower for term in USEFUL_TERMS):
        score += 20

    if lower.startswith(("# ", "## ", "### ")):
        score -= 15
    if lower.startswith(("- ", "* ", "+ ")):
        score += 5
    if len(line) <= 220:
        score += 10
    elif len(line) > 350:
        score -= 20

    return score


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--max-jobs", type=int, default=1200)
    ap.add_argument("--per-repo-cap", type=int, default=80)
    args = ap.parse_args()

    candidates: list[tuple[int, dict, int, list[str]]] = []
    source_files: set[tuple[str, str]] = set()

    with gzip.open(args.input, "rt", encoding="utf-8") as fh:
        for raw in fh:
            record = json.loads(raw)
            base = path_score(record)
            if base <= 0:
                continue
            lines = [
                clean_candidate_line(line)
                for line in record.get("content", "").splitlines()
            ]
            for index, line in enumerate(lines):
                score = line_score(record, line, base)
                if score <= 0:
                    continue
                candidates.append((score, record, index, lines))

    candidates.sort(
        key=lambda item: (
            -item[0],
            item[1]["repository"],
            item[1]["path"],
            item[2],
        )
    )

    repo_counts = collections.Counter()
    jobs: list[dict] = []
    seen_content: set[tuple[str, str]] = set()

    for score, record, line_index, lines in candidates:
        repo = record["repository"]
        if repo_counts[repo] >= args.per_repo_cap:
            continue

        target_line = lines[line_index]
        dedupe_key = (repo, target_line)
        if dedupe_key in seen_content:
            continue
        seen_content.add(dedupe_key)

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
            "visibility": source_visibility(record),
            "path": record["path"],
            "line_number": line_index + 1,
            "source_score": score,
            "target_line": target_line,
            "context": context_for(lines, line_index),
        }
        job["prompt"] = build_prompt(job)
        jobs.append(job)
        repo_counts[repo] += 1
        source_files.add((repo, record["path"]))

        if len(jobs) >= args.max_jobs:
            break

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8") as out:
        for job in jobs:
            out.write(json.dumps(job, ensure_ascii=False) + "\n")

    manifest = {
        "schema_version": 2,
        "selection": "deterministic-high-value-source-line",
        "job_count": len(jobs),
        "source_file_count": len(source_files),
        "repositories": len(repo_counts),
        "jobs_by_repository": dict(repo_counts.most_common()),
        "max_jobs": args.max_jobs,
        "per_repo_cap": args.per_repo_cap,
        "generator_contract": {
            "one_fixed_evidence_line_per_job": True,
            "model_does_not_write_answer": True,
            "model_does_not_choose_evidence": True,
            "model_does_not_choose_visibility": True,
            "skip_allowed": True,
            "chain_of_thought_forbidden": True,
        },
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
