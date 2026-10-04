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
    "stale data", "conflicting evidence", "privacy"
]

DOC_EXTS = {".md", ".txt", ".rst"}
CONFIG_EXTS = {".yml", ".yaml", ".json", ".toml", ".properties", ".ini", ".cfg", ".xml"}
SOURCE_EXTS = {".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}

def path_score(record: dict) -> int:
    path = record["path"].replace("\\", "/")
    lower = path.lower()
    ext = Path(path).suffix.lower()
    name = Path(path).name.lower()
    score = 0
    if ext in DOC_EXTS:
        score += 40
    elif ext in CONFIG_EXTS:
        score += 25
    elif ext in SOURCE_EXTS:
        score += 10

    if any(token in lower for token in (
        "/docs/", "/wiki/", "readme", "commands", "permissions", "rules",
        "config", "plugin.yml", "paper-plugin.yml", "server.properties",
        "messages", "help", "support", "link", "rank", "econom", "ticket",
    )):
        score += 20
    if record["repository"] == "Enthusia-Server" and any(
        lower.startswith(f"network-snapshot/{server}/current/")
        for server in ("smp", "hub", "velocity", "sentinel")
    ):
        score += 25
    if "/test/" in lower or "/tests/" in lower or lower.startswith("tests/"):
        score -= 35
    if "/.github/" in "/" + lower or lower.startswith(".github/"):
        score -= 15
    if "changelog" in lower:
        score -= 10
    if len(record.get("content", "")) < 120:
        score -= 50
    return score

def chunks(text: str, max_chars: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    paras = re.split(r"\n\s*\n", text)
    out, current = [], []
    size = 0
    for para in paras:
        para = para.strip()
        if not para:
            continue
        if len(para) > max_chars:
            # Hard-split oversized generated/config blocks.
            if current:
                out.append("\n\n".join(current))
                current, size = [], 0
            for i in range(0, len(para), max_chars):
                out.append(para[i:i+max_chars])
            continue
        extra = len(para) + (2 if current else 0)
        if current and size + extra > max_chars:
            out.append("\n\n".join(current))
            current, size = [], 0
        current.append(para)
        size += extra
    if current:
        out.append("\n\n".join(current))
    return out

def build_prompt(job: dict) -> str:
    categories = ", ".join(CATEGORIES)
    return f"""You are generating ONE grounded Enthusia AI training example.

Use ONLY the supplied source excerpt. Do not use outside knowledge. Do not infer mutable
server facts that are not directly supported. If this excerpt does not contain a useful
player-support or staff-assistance fact, output exactly:
{{"skip":true,"reason":"not useful for support training"}}

Otherwise output exactly one JSON object with these keys:
- category: one of [{categories}]
- visibility: "public", "private", or "staff"
- scenario: one short sentence describing the support situation
- user: a natural user/player/staff question
- assistant: the ideal concise answer
- facts: array of 1-4 objects, each with:
    claim: concise supported factual claim
    evidence: VERBATIM short substring copied from SOURCE_EXCERPT
    source: exactly SOURCE_ID below
    source_version: exactly SOURCE_VERSION below
- expected_actions: array of zero or more high-level actions such as
  "verify:live", "tool:player_identity", "tool:permission_lookup",
  "escalate:human-staff", or "escalate:openai"
- tags: short array of useful labels

Rules:
1. Every factual sentence in assistant must be supported by at least one fact/evidence item.\n2. Use visibility "private" for player-self/account-specific context.
2. evidence must occur verbatim in SOURCE_EXCERPT.
3. Never output passwords, API keys, tokens, private keys, database credentials, SFTP
   credentials, or secret-looking values even if source text contains them.
5. Do not teach Git main == production. If deployment state matters, require verification.
6. For mutable facts (rank, permissions, balance, status, ticket state, punishments), prefer
   an answer that says to verify live rather than memorizing the supplied value.
7. Do not include chain-of-thought or hidden reasoning.
8. Do not invent commands, permissions, prices, policies, or server behavior.

SOURCE_ID: {job["source_id"]}
SOURCE_VERSION: {job["source_version"]}
REPOSITORY_ROLE: {job["role"]}
PATH: {job["path"]}

SOURCE_EXCERPT:
<<<
{job["excerpt"]}
>>>
"""

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--max-jobs", type=int, default=1200)
    ap.add_argument("--per-repo-cap", type=int, default=80)
    ap.add_argument("--max-chars", type=int, default=9000)
    args = ap.parse_args()

    records = []
    with gzip.open(args.input, "rt", encoding="utf-8") as fh:
        for line in fh:
            record = json.loads(line)
            score = path_score(record)
            if score <= 0:
                continue
            records.append((score, record))

    records.sort(key=lambda item: (-item[0], item[1]["repository"], item[1]["path"]))
    repo_counts = collections.Counter()
    jobs = []
    source_files = set()

    for score, record in records:
        repo = record["repository"]
        if repo_counts[repo] >= args.per_repo_cap:
            continue
        parts = chunks(record.get("content", ""), args.max_chars)
        if not parts:
            continue
        # At most two chunks from any one file in the initial seed batch.
        for index, excerpt in enumerate(parts[:2]):
            digest = hashlib.sha256(
                f'{repo}\n{record["commit_sha"]}\n{record["path"]}\n{index}'.encode("utf-8")
            ).hexdigest()[:16]
            source_id = f'github:wsg138/{repo}@{record["commit_sha"]}:{record["path"]}'
            job = {
                "job_id": f"ground-{digest}",
                "source_id": source_id,
                "source_version": record["commit_sha"],
                "repository": repo,
                "role": record.get("role"),
                "path": record["path"],
                "chunk_index": index,
                "source_score": score,
                "excerpt": excerpt,
            }
            job["prompt"] = build_prompt(job)
            jobs.append(job)
            repo_counts[repo] += 1
            source_files.add((repo, record["path"]))
            if len(jobs) >= args.max_jobs:
                break
        if len(jobs) >= args.max_jobs:
            break

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8") as out:
        for job in jobs:
            out.write(json.dumps(job, ensure_ascii=False) + "\n")

    manifest = {
        "schema_version": 1,
        "job_count": len(jobs),
        "source_file_count": len(source_files),
        "repositories": len(repo_counts),
        "jobs_by_repository": dict(repo_counts.most_common()),
        "max_jobs": args.max_jobs,
        "per_repo_cap": args.per_repo_cap,
        "max_source_chars": args.max_chars,
        "generator_contract": {
            "one_example_per_job": True,
            "verbatim_evidence_required": True,
            "skip_allowed": True,
            "chain_of_thought_forbidden": True,
            "mutable_facts_require_live_verification": True,
        },
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
