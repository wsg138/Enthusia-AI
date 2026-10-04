#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import math
import re
from pathlib import Path

SECRET_PATTERNS = [
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("discord_token", re.compile(r"\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b")),
    ("bearer_token", re.compile(r"(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/-]{16,}")),
    ("password_assignment", re.compile(r"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key)\b\s*[:=]\s*['\"]?([^\s'\"#]{12,})")),
]

NOISE_PATH_PATTERNS = [
    ("coverage_or_report", re.compile(r"(?i)(^|/)(coverage|reports?|test-results?|artifacts?)(/|$)")),
    ("generated_docs", re.compile(r"(?i)(^|/)(generated|site|docs?/_build)(/|$)")),
    ("proof_or_fixture_output", re.compile(r"(?i)(proof|runtime[-_ ]?evidence|fixture[-_ ]?output|snapshot)")),
    ("migration_or_dump", re.compile(r"(?i)(dump|export|migration[-_ ]?output)")),
]

DIRECT_SFT_HINTS = {
    "docs": {".md", ".txt", ".rst"},
    "config": {".yml", ".yaml", ".json", ".toml", ".properties", ".ini", ".cfg", ".xml"},
    "source": {".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sql", ".sh", ".ps1"},
}

def normalized_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()

def suffix(path: str) -> str:
    name = Path(path).name
    if name in {"Dockerfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"}:
        return name
    return Path(path).suffix.lower() or "<none>"

def bucket(path: str) -> str:
    ext = Path(path).suffix.lower()
    for name, exts in DIRECT_SFT_HINTS.items():
        if ext in exts:
            return name
    if Path(path).name in {"Dockerfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"}:
        return "build_config"
    return "other"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--sample-output", required=True)
    ap.add_argument("--sample-per-repo", type=int, default=3)
    args = ap.parse_args()

    corpus_path = Path(args.corpus)
    output_path = Path(args.output)
    sample_path = Path(args.sample_output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sample_path.parent.mkdir(parents=True, exist_ok=True)

    repo_counts = collections.Counter()
    role_counts = collections.Counter()
    ext_counts = collections.Counter()
    bucket_counts = collections.Counter()
    authority_counts = collections.Counter()
    file_sizes = []
    char_total = 0
    line_total = 0
    exact_groups: dict[str, list[dict]] = collections.defaultdict(list)
    normalized_groups: dict[str, list[dict]] = collections.defaultdict(list)
    secret_hits = []
    noise_candidates = []
    per_repo_samples: dict[str, list[dict]] = collections.defaultdict(list)
    path_seen = set()
    duplicate_path_records = []

    with gzip.open(corpus_path, "rt", encoding="utf-8") as fh:
        for line_number, line in enumerate(fh, 1):
            record = json.loads(line)
            text = record.get("content", "")
            repo = record["repository"]
            path = record["path"]
            key = (repo, record.get("commit_sha"), path)
            if key in path_seen:
                duplicate_path_records.append({"repository": repo, "path": path, "line": line_number})
            path_seen.add(key)

            raw_bytes = len(text.encode("utf-8"))
            chars = len(text)
            lines = text.count("\n") + (1 if text else 0)
            repo_counts[repo] += 1
            role_counts[record.get("role", "unknown")] += 1
            ext_counts[suffix(path)] += 1
            bucket_counts[bucket(path)] += 1
            authority_counts[record.get("production_authority", "unknown")] += 1
            file_sizes.append((raw_bytes, repo, path))
            char_total += chars
            line_total += lines

            exact = record.get("content_sha256") or hashlib.sha256(text.encode("utf-8")).hexdigest()
            norm = hashlib.sha256(normalized_text(text).encode("utf-8")).hexdigest()
            meta = {"repository": repo, "path": path, "bytes": raw_bytes}
            exact_groups[exact].append(meta)
            normalized_groups[norm].append(meta)

            for label, pattern in SECRET_PATTERNS:
                match = pattern.search(text)
                if match:
                    context_start = max(0, match.start() - 80)
                    context_end = min(len(text), match.end() + 80)
                    context = text[context_start:context_end]
                    # Never write the matched secret itself into the report.
                    redacted = context[: max(0, match.start()-context_start)] + "[REDACTED]" + context[(match.end()-context_start):]
                    secret_hits.append({
                        "repository": repo,
                        "path": path,
                        "pattern": label,
                        "context_redacted": redacted.replace("\n", "\\n")[:240],
                    })
                    break

            for label, pattern in NOISE_PATH_PATTERNS:
                if pattern.search(path):
                    noise_candidates.append({
                        "repository": repo,
                        "path": path,
                        "reason": label,
                        "bytes": raw_bytes,
                    })
                    break

            samples = per_repo_samples[repo]
            if len(samples) < args.sample_per_repo:
                samples.append({
                    "repository": repo,
                    "role": record.get("role"),
                    "path": path,
                    "bytes": raw_bytes,
                    "content_preview": text[:1200],
                })

    total_files = sum(repo_counts.values())
    unique_exact = len(exact_groups)
    unique_normalized = len(normalized_groups)
    exact_dup_groups = [v for v in exact_groups.values() if len(v) > 1]
    normalized_dup_groups = [v for v in normalized_groups.values() if len(v) > 1]

    exact_duplicate_files = sum(len(g) - 1 for g in exact_dup_groups)
    normalized_duplicate_files = sum(len(g) - 1 for g in normalized_dup_groups)

    largest = sorted(file_sizes, reverse=True)[:100]
    approx_tokens_4 = math.ceil(char_total / 4)
    approx_tokens_3_5 = math.ceil(char_total / 3.5)

    report = {
        "schema_version": 1,
        "corpus": str(corpus_path),
        "totals": {
            "files": total_files,
            "repositories": len(repo_counts),
            "characters": char_total,
            "lines": line_total,
            "approx_tokens_chars_per_4": approx_tokens_4,
            "approx_tokens_chars_per_3_5": approx_tokens_3_5,
            "compressed_bytes": corpus_path.stat().st_size,
        },
        "distribution": {
            "repositories": dict(repo_counts.most_common()),
            "roles": dict(role_counts.most_common()),
            "extensions": dict(ext_counts.most_common()),
            "content_buckets": dict(bucket_counts.most_common()),
            "production_authority": dict(authority_counts.most_common()),
        },
        "duplicates": {
            "unique_exact_contents": unique_exact,
            "exact_duplicate_files_beyond_first": exact_duplicate_files,
            "exact_duplicate_ratio": exact_duplicate_files / total_files if total_files else 0,
            "unique_normalized_contents": unique_normalized,
            "normalized_duplicate_files_beyond_first": normalized_duplicate_files,
            "normalized_duplicate_ratio": normalized_duplicate_files / total_files if total_files else 0,
            "duplicate_path_records": duplicate_path_records[:100],
            "largest_exact_duplicate_groups": sorted(exact_dup_groups, key=len, reverse=True)[:100],
            "largest_normalized_duplicate_groups": sorted(normalized_dup_groups, key=len, reverse=True)[:100],
        },
        "security": {
            "second_pass_secret_hits_count": len(secret_hits),
            "second_pass_secret_hits": secret_hits[:500],
        },
        "noise": {
            "candidate_count": len(noise_candidates),
            "candidates": noise_candidates[:1000],
        },
        "largest_files": [
            {"bytes": size, "repository": repo, "path": path}
            for size, repo, path in largest
        ],
        "recommendation_inputs": {
            "rag_source_files": total_files,
            "direct_sft_files": 0,
            "note": "This source corpus remains RAG/synthetic-grounding material. Synthetic generation should preferentially use docs/config/source evidence with provenance and current-truth rules.",
        },
    }

    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    samples = [item for repo in sorted(per_repo_samples) for item in per_repo_samples[repo]]
    sample_path.write_text(
        "\n".join(json.dumps(item, ensure_ascii=False) for item in samples) + "\n",
        encoding="utf-8",
    )

    print(json.dumps({
        "files": total_files,
        "repos": len(repo_counts),
        "approx_tokens_4": approx_tokens_4,
        "exact_duplicate_files": exact_duplicate_files,
        "normalized_duplicate_files": normalized_duplicate_files,
        "secret_hits": len(secret_hits),
        "noise_candidates": len(noise_candidates),
        "qa_report": str(output_path),
        "sample_output": str(sample_path),
    }, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
