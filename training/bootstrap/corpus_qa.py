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

def _new_state() -> dict:
    return {
        "repo_counts": collections.Counter(),
        "role_counts": collections.Counter(),
        "ext_counts": collections.Counter(),
        "bucket_counts": collections.Counter(),
        "authority_counts": collections.Counter(),
        "file_sizes": [],
        "char_total": 0,
        "line_total": 0,
        "exact_groups": collections.defaultdict(list),
        "normalized_groups": collections.defaultdict(list),
        "secret_hits": [],
        "noise_candidates": [],
        "per_repo_samples": collections.defaultdict(list),
        "path_seen": set(),
        "duplicate_path_records": [],
    }


def _record_duplicate_path(
    state: dict,
    key: tuple,
    repository: str,
    path: str,
    line_number: int,
) -> None:
    if key in state["path_seen"]:
        state["duplicate_path_records"].append(
            {
                "repository": repository,
                "path": path,
                "line": line_number,
            }
        )
    state["path_seen"].add(key)


def _update_distributions(
    state: dict,
    record: dict,
    text: str,
    repository: str,
    path: str,
) -> int:
    raw_bytes = len(text.encode("utf-8"))
    state["repo_counts"][repository] += 1
    state["role_counts"][record.get("role", "unknown")] += 1
    state["ext_counts"][suffix(path)] += 1
    state["bucket_counts"][bucket(path)] += 1
    state["authority_counts"][record.get("production_authority", "unknown")] += 1
    state["file_sizes"].append((raw_bytes, repository, path))
    state["char_total"] += len(text)
    state["line_total"] += text.count("\n") + (1 if text else 0)
    return raw_bytes


def _update_duplicate_groups(
    state: dict,
    record: dict,
    text: str,
    repository: str,
    path: str,
    raw_bytes: int,
) -> None:
    exact_hash = record.get("content_sha256") or hashlib.sha256(
        text.encode("utf-8")
    ).hexdigest()
    normalized_hash = hashlib.sha256(
        normalized_text(text).encode("utf-8")
    ).hexdigest()
    meta = {"repository": repository, "path": path, "bytes": raw_bytes}
    state["exact_groups"][exact_hash].append(meta)
    state["normalized_groups"][normalized_hash].append(meta)


def _secret_hit(text: str, repository: str, path: str) -> dict | None:
    for label, pattern in SECRET_PATTERNS:
        match = pattern.search(text)
        if match is None:
            continue
        context_start = max(0, match.start() - 80)
        context_end = min(len(text), match.end() + 80)
        context = text[context_start:context_end]
        before = context[: max(0, match.start() - context_start)]
        after = context[match.end() - context_start :]
        return {
            "repository": repository,
            "path": path,
            "pattern": label,
            "context_redacted": (before + "[REDACTED]" + after)
            .replace("\n", "\\n")[:240],
        }
    return None


def _noise_candidate(
    path: str,
    repository: str,
    raw_bytes: int,
) -> dict | None:
    for label, pattern in NOISE_PATH_PATTERNS:
        if pattern.search(path):
            return {
                "repository": repository,
                "path": path,
                "reason": label,
                "bytes": raw_bytes,
            }
    return None


def _append_sample(
    state: dict,
    record: dict,
    text: str,
    repository: str,
    path: str,
    raw_bytes: int,
    sample_per_repo: int,
) -> None:
    samples = state["per_repo_samples"][repository]
    if len(samples) >= sample_per_repo:
        return
    samples.append(
        {
            "repository": repository,
            "role": record.get("role"),
            "path": path,
            "bytes": raw_bytes,
            "content_preview": text[:1200],
        }
    )


def _analyze_record(
    state: dict,
    record: dict,
    line_number: int,
    sample_per_repo: int,
) -> None:
    text = record.get("content", "")
    repository = record["repository"]
    path = record["path"]
    key = (repository, record.get("commit_sha"), path)
    _record_duplicate_path(state, key, repository, path, line_number)
    raw_bytes = _update_distributions(state, record, text, repository, path)
    _update_duplicate_groups(
        state,
        record,
        text,
        repository,
        path,
        raw_bytes,
    )

    secret = _secret_hit(text, repository, path)
    if secret is not None:
        state["secret_hits"].append(secret)
    noise = _noise_candidate(path, repository, raw_bytes)
    if noise is not None:
        state["noise_candidates"].append(noise)
    _append_sample(
        state,
        record,
        text,
        repository,
        path,
        raw_bytes,
        sample_per_repo,
    )


def _duplicate_groups(groups: dict[str, list[dict]]) -> list[list[dict]]:
    return [group for group in groups.values() if len(group) > 1]


def _duplicate_summary(state: dict, total_files: int) -> dict:
    exact_groups = _duplicate_groups(state["exact_groups"])
    normalized_groups = _duplicate_groups(state["normalized_groups"])
    exact_files = sum(len(group) - 1 for group in exact_groups)
    normalized_files = sum(len(group) - 1 for group in normalized_groups)
    return {
        "unique_exact_contents": len(state["exact_groups"]),
        "exact_duplicate_files_beyond_first": exact_files,
        "exact_duplicate_ratio": exact_files / total_files if total_files else 0,
        "unique_normalized_contents": len(state["normalized_groups"]),
        "normalized_duplicate_files_beyond_first": normalized_files,
        "normalized_duplicate_ratio": (
            normalized_files / total_files if total_files else 0
        ),
        "duplicate_path_records": state["duplicate_path_records"][:100],
        "largest_exact_duplicate_groups": sorted(
            exact_groups,
            key=len,
            reverse=True,
        )[:100],
        "largest_normalized_duplicate_groups": sorted(
            normalized_groups,
            key=len,
            reverse=True,
        )[:100],
    }


def _build_report(corpus_path: Path, state: dict) -> dict:
    total_files = sum(state["repo_counts"].values())
    char_total = state["char_total"]
    largest = sorted(state["file_sizes"], reverse=True)[:100]
    return {
        "schema_version": 1,
        "corpus": str(corpus_path),
        "totals": {
            "files": total_files,
            "repositories": len(state["repo_counts"]),
            "characters": char_total,
            "lines": state["line_total"],
            "approx_tokens_chars_per_4": math.ceil(char_total / 4),
            "approx_tokens_chars_per_3_5": math.ceil(char_total / 3.5),
            "compressed_bytes": corpus_path.stat().st_size,
        },
        "distribution": {
            "repositories": dict(state["repo_counts"].most_common()),
            "roles": dict(state["role_counts"].most_common()),
            "extensions": dict(state["ext_counts"].most_common()),
            "content_buckets": dict(state["bucket_counts"].most_common()),
            "production_authority": dict(state["authority_counts"].most_common()),
        },
        "duplicates": _duplicate_summary(state, total_files),
        "security": {
            "second_pass_secret_hits_count": len(state["secret_hits"]),
            "second_pass_secret_hits": state["secret_hits"][:500],
        },
        "noise": {
            "candidate_count": len(state["noise_candidates"]),
            "candidates": state["noise_candidates"][:1000],
        },
        "largest_files": [
            {"bytes": size, "repository": repository, "path": path}
            for size, repository, path in largest
        ],
        "recommendation_inputs": {
            "rag_source_files": total_files,
            "direct_sft_files": 0,
            "note": (
                "This source corpus remains RAG/synthetic-grounding material. "
                "Synthetic generation should preferentially use docs/config/source "
                "evidence with provenance and current-truth rules."
            ),
        },
    }


def _write_samples(sample_path: Path, per_repo_samples: dict) -> None:
    samples = [
        item
        for repository in sorted(per_repo_samples)
        for item in per_repo_samples[repository]
    ]
    sample_path.write_text(
        "\n".join(json.dumps(item, ensure_ascii=False) for item in samples) + "\n",
        encoding="utf-8",
    )


def _print_summary(
    report: dict,
    output_path: Path,
    sample_path: Path,
) -> None:
    duplicates = report["duplicates"]
    print(
        json.dumps(
            {
                "files": report["totals"]["files"],
                "repos": report["totals"]["repositories"],
                "approx_tokens_4": report["totals"]["approx_tokens_chars_per_4"],
                "exact_duplicate_files": duplicates[
                    "exact_duplicate_files_beyond_first"
                ],
                "normalized_duplicate_files": duplicates[
                    "normalized_duplicate_files_beyond_first"
                ],
                "secret_hits": report["security"]["second_pass_secret_hits_count"],
                "noise_candidates": report["noise"]["candidate_count"],
                "qa_report": str(output_path),
                "sample_output": str(sample_path),
            },
            indent=2,
        )
    )


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

    state = _new_state()
    with gzip.open(corpus_path, "rt", encoding="utf-8") as fh:
        for line_number, line in enumerate(fh, 1):
            _analyze_record(
                state,
                json.loads(line),
                line_number,
                args.sample_per_repo,
            )

    report = _build_report(corpus_path, state)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    _write_samples(sample_path, state["per_repo_samples"])
    _print_summary(report, output_path, sample_path)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
