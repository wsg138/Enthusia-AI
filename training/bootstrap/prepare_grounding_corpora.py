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
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def is_noise_path(path: str) -> bool:
    normalized = "/" + path.replace("\\", "/").strip("/")
    lower = normalized.lower()
    markers = (*THIRD_PARTY_ASSET_MARKERS, *NOISE_MARKERS)
    return any(marker.lower() in lower for marker in markers)


def is_nonproduction_snapshot(record: dict) -> bool:
    if record.get("repository") != "Enthusia-Server":
        return False
    path = record.get("path", "").replace("\\", "/")
    return path.startswith(("network-snapshot/test/", "network-snapshot/test2/"))


def _policy_allows(policy: dict | None, capability: str) -> bool:
    if policy is None:
        return True
    return bool(policy.get("include", False) and policy.get(capability, False))


def _common_rejection(
    record: dict,
    policy: dict | None,
    capability: str,
) -> str | None:
    if not _policy_allows(policy, capability):
        return "repository_policy"
    text = record.get("content", "")
    if not text.strip():
        return "empty"
    if is_noise_path(record.get("path", "")):
        return "noise_path"
    if contains_secret(text):
        return "secret_pattern"
    return None


def synthetic_allowed(
    record: dict,
    policy: dict | None = None,
) -> tuple[bool, str]:
    common = _common_rejection(record, policy, "use_for_synthetic_grounding")
    if common is not None:
        return False, common
    if record.get("production_authority") == "non_production_reference":
        return False, "non_production_reference"
    if is_nonproduction_snapshot(record):
        return False, "test_snapshot"
    return True, "accepted"


def rag_allowed(record: dict, policy: dict | None = None) -> tuple[bool, str]:
    rejection = _common_rejection(record, policy, "use_for_rag")
    return (False, rejection) if rejection is not None else (True, "accepted")


def score(record: dict, _synthetic: bool) -> tuple:
    # Higher wins when identical content exists in several places.
    authority = int(
        record.get("production_authority") == "requires_deployment_verification"
    )
    repo = record.get("repository", "")
    path = record.get("path", "")
    current_prefixes = (
        "network-snapshot/SMP/current/",
        "network-snapshot/hub/current/",
        "network-snapshot/velocity/current/",
        "network-snapshot/sentinel/current/",
    )
    prod_snapshot = int(
        repo == "Enthusia-Server" and path.startswith(current_prefixes)
    )
    suffix = Path(path).suffix.lower()
    docs = int(suffix in {".md", ".txt", ".rst"})
    source = int(
        suffix in {".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}
    )
    current_path = int("/current/" in "/" + path.replace("\\", "/"))
    non_staging = int("Staging" not in repo and "Sim" not in repo)
    return (
        authority,
        prod_snapshot,
        non_staging,
        current_path,
        docs,
        source,
        -len(path),
    )

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

def _load_policies(repository_manifest: str | None) -> dict[str, dict]:
    if not repository_manifest:
        return {}
    manifest = json.loads(Path(repository_manifest).read_text(encoding="utf-8"))
    return {entry["name"]: entry for entry in manifest["repositories"]}


def _apply_policy(record: dict, policy: dict | None) -> dict:
    if policy is None:
        return record
    updated = dict(record)
    updated["role"] = policy.get("role", updated.get("role"))
    updated["production_authority"] = policy.get(
        "production_authority",
        updated.get("production_authority"),
    )
    updated["use_for_rag"] = policy.get("use_for_rag", False)
    updated["use_for_synthetic_grounding"] = policy.get(
        "use_for_synthetic_grounding",
        False,
    )
    return updated


def _append_by_policy(
    record: dict,
    policy: dict | None,
    rag_candidates: list[dict],
    synthetic_candidates: list[dict],
    rejected_rag: collections.Counter,
    rejected_synthetic: collections.Counter,
) -> None:
    rag_ok, rag_reason = rag_allowed(record, policy)
    if rag_ok:
        rag_candidates.append(record)
    else:
        rejected_rag[rag_reason] += 1

    synthetic_ok, synthetic_reason = synthetic_allowed(record, policy)
    if synthetic_ok:
        synthetic_candidates.append(record)
    else:
        rejected_synthetic[synthetic_reason] += 1


def _collect_candidates(
    input_path: str,
    policies: dict[str, dict],
) -> tuple[list[dict], list[dict], collections.Counter, collections.Counter, int]:
    rag_candidates: list[dict] = []
    synthetic_candidates: list[dict] = []
    rejected_rag: collections.Counter = collections.Counter()
    rejected_synthetic: collections.Counter = collections.Counter()
    input_count = 0

    with gzip.open(input_path, "rt", encoding="utf-8") as fh:
        for line in fh:
            input_count += 1
            original = json.loads(line)
            policy = policies.get(original.get("repository"))
            record = _apply_policy(original, policy)
            _append_by_policy(
                record,
                policy,
                rag_candidates,
                synthetic_candidates,
                rejected_rag,
                rejected_synthetic,
            )
    return (
        rag_candidates,
        synthetic_candidates,
        rejected_rag,
        rejected_synthetic,
        input_count,
    )


def _summarize(records: list[dict], path: Path) -> dict:
    repos = collections.Counter(record["repository"] for record in records)
    chars = sum(len(record.get("content", "")) for record in records)
    return {
        "files": len(records),
        "repositories": len(repos),
        "characters": chars,
        "approx_tokens_chars_per_4": (chars + 3) // 4,
        "compressed_bytes": path.stat().st_size,
        "top_repositories": dict(repos.most_common(20)),
    }


def _report_section(
    records: list[dict],
    path: Path,
    rejections: collections.Counter,
    dedup: dict,
) -> dict:
    return {
        **_summarize(records, path),
        "rejections": dict(rejections),
        **dedup,
    }


def _build_report(
    input_count: int,
    rag_section: dict,
    synthetic_section: dict,
    repository_manifest: str | None,
) -> dict:
    return {
        "schema_version": 1,
        "input_files": input_count,
        "rag": rag_section,
        "synthetic_grounding": synthetic_section,
        "policy": {
            # Boolean policy evidence, not a credential literal.
            "all_second_pass_secret_pattern_files_excluded": True,  # nosec B105  # nosemgrep
            "exact_content_deduplicated": True,
            "synthetic_excludes_nonproduction_reference": True,
            "synthetic_excludes_test_and_test2_server_snapshots": True,
            "third_party_bundled_assets_excluded": True,
            "direct_sft_from_source_corpus": False,
            "current_repository_manifest_applied": bool(repository_manifest),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--rag-output", required=True)
    ap.add_argument("--synthetic-output", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--repository-manifest", required=False)
    args = ap.parse_args()

    policies = _load_policies(args.repository_manifest)
    (
        rag_candidates,
        synthetic_candidates,
        rejected_rag,
        rejected_synthetic,
        input_count,
    ) = _collect_candidates(args.input, policies)

    rag_records, rag_dedup = select_dedup(rag_candidates, synthetic=False)
    synthetic_records, synth_dedup = select_dedup(
        synthetic_candidates,
        synthetic=True,
    )
    rag_path = Path(args.rag_output)
    synth_path = Path(args.synthetic_output)
    write_gzip(rag_path, rag_records)
    write_gzip(synth_path, synthetic_records)

    rag_section = _report_section(
        rag_records,
        rag_path,
        rejected_rag,
        rag_dedup,
    )
    synthetic_section = _report_section(
        synthetic_records,
        synth_path,
        rejected_synthetic,
        synth_dedup,
    )
    report = _build_report(
        input_count,
        rag_section,
        synthetic_section,
        args.repository_manifest,
    )
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
