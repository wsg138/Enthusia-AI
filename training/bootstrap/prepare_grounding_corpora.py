#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import re
from pathlib import Path

SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b"),
    re.compile(r"(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/-]{16,}"),
    re.compile(r"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key)\b\s*[:=]\s*['\"]?([^\s'\"#]{12,})"),
]

THIRD_PARTY_ASSET_MARKERS = (
    "/built-in/Default/assets/",
    "/assets/minecraft/",
    "/models/interactivechatdiscordsrvaddon/",
)

NOISE_MARKERS = (
    "/coverage/",
    "/test-results/",
    "/reports/",
    "/artifacts/",
    "/generated/",
)

def contains_secret(text: str) -> bool:
    return any(p.search(text) for p in SECRET_PATTERNS)

def is_noise_path(path: str) -> bool:
    p = "/" + path.replace("\\", "/").strip("/")
    if any(marker.lower() in p.lower() for marker in THIRD_PARTY_ASSET_MARKERS):
        return True
    if any(marker.lower() in p.lower() for marker in NOISE_MARKERS):
        return True
    return False

def is_nonproduction_snapshot(record: dict) -> bool:
    if record.get("repository") != "Enthusia-Server":
        return False
    p = record.get("path", "").replace("\\", "/")
    return p.startswith("network-snapshot/test/") or p.startswith("network-snapshot/test2/")

def synthetic_allowed(record: dict, policy: dict | None = None) -> tuple[bool, str]:
    if policy is not None and (
        not policy.get("include", False)
        or not policy.get("use_for_synthetic_grounding", False)
    ):
        return False, "repository_policy"
    text = record.get("content", "")
    if not text.strip():
        return False, "empty"
    if record.get("production_authority") == "non_production_reference":
        return False, "non_production_reference"
    if is_nonproduction_snapshot(record):
        return False, "test_snapshot"
    if is_noise_path(record.get("path", "")):
        return False, "noise_path"
    if contains_secret(text):
        return False, "secret_pattern"
    return True, "accepted"

def rag_allowed(record: dict, policy: dict | None = None) -> tuple[bool, str]:
    if policy is not None and (
        not policy.get("include", False)
        or not policy.get("use_for_rag", False)
    ):
        return False, "repository_policy"
    text = record.get("content", "")
    if not text.strip():
        return False, "empty"
    if is_noise_path(record.get("path", "")):
        return False, "noise_path"
    if contains_secret(text):
        return False, "secret_pattern"
    return True, "accepted"

def score(record: dict, synthetic: bool) -> tuple:
    # Higher wins when identical content exists in several places.
    authority = 1 if record.get("production_authority") == "requires_deployment_verification" else 0
    repo = record.get("repository", "")
    path = record.get("path", "")
    prod_snapshot = 1 if repo == "Enthusia-Server" and (
        path.startswith("network-snapshot/SMP/current/")
        or path.startswith("network-snapshot/hub/current/")
        or path.startswith("network-snapshot/velocity/current/")
        or path.startswith("network-snapshot/sentinel/current/")
    ) else 0
    docs = 1 if Path(path).suffix.lower() in {".md", ".txt", ".rst"} else 0
    source = 1 if Path(path).suffix.lower() in {".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"} else 0
    current_path = 1 if "/current/" in "/" + path.replace("\\", "/") else 0
    non_staging = 0 if "Staging" in repo or "Sim" in repo else 1
    return (authority, prod_snapshot, non_staging, current_path, docs, source, -len(path))

def select_dedup(records: list[dict], synthetic: bool) -> tuple[list[dict], dict]:
    by_hash: dict[str, dict] = {}
    duplicates = 0
    replaced = 0
    for record in records:
        h = record.get("content_sha256") or hashlib.sha256(record.get("content","").encode("utf-8")).hexdigest()
        current = by_hash.get(h)
        if current is None:
            by_hash[h] = record
            continue
        duplicates += 1
        if score(record, synthetic) > score(current, synthetic):
            by_hash[h] = record
            replaced += 1
    return list(by_hash.values()), {"duplicates_removed": duplicates, "preferred_replacements": replaced}

def write_gzip(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as out:
        for record in sorted(records, key=lambda r: (r.get("repository",""), r.get("path",""))):
            out.write(json.dumps(record, ensure_ascii=False) + "\n")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--rag-output", required=True)
    ap.add_argument("--synthetic-output", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--repository-manifest", required=False)
    args = ap.parse_args()

    policies = {}
    if args.repository_manifest:
        manifest = json.loads(Path(args.repository_manifest).read_text(encoding="utf-8"))
        policies = {entry["name"]: entry for entry in manifest["repositories"]}

    rag_candidates = []
    synthetic_candidates = []
    rejected_rag = collections.Counter()
    rejected_synthetic = collections.Counter()
    input_count = 0

    with gzip.open(args.input, "rt", encoding="utf-8") as fh:
        for line in fh:
            input_count += 1
            record = json.loads(line)
            policy = policies.get(record.get("repository"))
            if policy is not None:
                record = dict(record)
                record["role"] = policy.get("role", record.get("role"))
                record["production_authority"] = policy.get(
                    "production_authority", record.get("production_authority")
                )
                record["use_for_rag"] = policy.get("use_for_rag", False)
                record["use_for_synthetic_grounding"] = policy.get(
                    "use_for_synthetic_grounding", False
                )
            ok, reason = rag_allowed(record, policy)
            if ok:
                rag_candidates.append(record)
            else:
                rejected_rag[reason] += 1
            ok, reason = synthetic_allowed(record, policy)
            if ok:
                synthetic_candidates.append(record)
            else:
                rejected_synthetic[reason] += 1

    rag_records, rag_dedup = select_dedup(rag_candidates, synthetic=False)
    synthetic_records, synth_dedup = select_dedup(synthetic_candidates, synthetic=True)

    rag_path = Path(args.rag_output)
    synth_path = Path(args.synthetic_output)
    write_gzip(rag_path, rag_records)
    write_gzip(synth_path, synthetic_records)

    def summarize(records: list[dict], path: Path) -> dict:
        repos = collections.Counter(r["repository"] for r in records)
        chars = sum(len(r.get("content","")) for r in records)
        return {
            "files": len(records),
            "repositories": len(repos),
            "characters": chars,
            "approx_tokens_chars_per_4": (chars + 3) // 4,
            "compressed_bytes": path.stat().st_size,
            "top_repositories": dict(repos.most_common(20)),
        }

    report = {
        "schema_version": 1,
        "input_files": input_count,
        "rag": {
            **summarize(rag_records, rag_path),
            "rejections": dict(rejected_rag),
            **rag_dedup,
        },
        "synthetic_grounding": {
            **summarize(synthetic_records, synth_path),
            "rejections": dict(rejected_synthetic),
            **synth_dedup,
        },
        "policy": {
            # Boolean policy evidence, not a credential literal.
            "all_second_pass_secret_pattern_files_excluded": True,  # nosec B105  # nosemgrep
            "exact_content_deduplicated": True,
            "synthetic_excludes_nonproduction_reference": True,
            "synthetic_excludes_test_and_test2_server_snapshots": True,
            "third_party_bundled_assets_excluded": True,
            "direct_sft_from_source_corpus": False,
            "current_repository_manifest_applied": bool(args.repository_manifest),
        },
    }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
