#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import subprocess
from pathlib import Path

try:
    from training.bootstrap.github_source_policy import (
        DENY_PARTS,
        MAX_BYTES_DEFAULT,
        _run_checked,
        _validated_repo_entry,
        allowed,
        config_has_sensitive_key,
        ensure_repo,
        looks_sensitive,
        remove_tree,
        validate_git_branch,
        validate_github_owner,
        validate_github_repository,
    )
except ModuleNotFoundError:
    from github_source_policy import (
        DENY_PARTS,
        MAX_BYTES_DEFAULT,
        _run_checked,
        _validated_repo_entry,
        allowed,
        config_has_sensitive_key,
        ensure_repo,
        looks_sensitive,
        remove_tree,
        validate_git_branch,
        validate_github_owner,
        validate_github_repository,
    )

def _initial_counts() -> dict[str, int]:
    return {
        "repositories": 0,
        "repositories_failed": 0,
        "accepted_files": 0,
        "skipped_files": 0,
        "sensitive_rejected": 0,
    }


def _initial_audit() -> dict:
    return {
        "schema_version": 1,
        "sensitive_rejections": [],
        "repository_failures": [],
    }


def _record_failure(
    repository: str,
    exc: BaseException,
    counts: dict[str, int],
    repo_summary: list[dict],
    audit: dict,
) -> None:
    counts["repositories_failed"] += 1
    failure = {
        "repository": repository,
        "status": "FAILED",
        "error": f"{type(exc).__name__}: {exc}",
    }
    repo_summary.append(failure)
    audit["repository_failures"].append(failure)
    print(f"{repository}: FAILED — {type(exc).__name__}: {exc}")


def _clone_entry(
    entry: object,
    workspace: Path,
    counts: dict[str, int],
    repo_summary: list[dict],
    audit: dict,
) -> tuple[dict, str, str, str, Path, str] | None:
    if not isinstance(entry, dict):
        error = ValueError("repository manifest entry must be an object")
        _record_failure("<invalid-manifest-entry>", error, counts, repo_summary, audit)
        return None
    if not entry.get("include", False):
        return None

    display_name = entry.get("name")
    if not isinstance(display_name, str):
        display_name = "<invalid-repository>"
    try:
        owner, name, default_branch = _validated_repo_entry(entry)
        repo_dir, sha = ensure_repo(owner, name, default_branch, workspace)
    except (
        KeyError,
        TypeError,
        ValueError,
        RuntimeError,
        OSError,
        subprocess.SubprocessError,
    ) as exc:
        _record_failure(display_name, exc, counts, repo_summary, audit)
        return None
    return entry, owner, name, default_branch, repo_dir, sha


def _read_source(path: Path) -> tuple[bytes, str] | None:
    try:
        raw = path.read_bytes()
        return raw, raw.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _sensitive_reason(relative_path: Path, text: str) -> str | None:
    if config_has_sensitive_key(relative_path, text):
        return "sensitive_config_key"
    return "high_signal_secret_pattern" if looks_sensitive(text) else None


def _source_record(
    entry: dict,
    owner: str,
    name: str,
    default_branch: str,
    sha: str,
    relative_path: Path,
    raw: bytes,
    text: str,
) -> dict:
    return {
        "schema_version": 1,
        "kind": "authoritative_source_material",
        "owner": owner,
        "repository": name,
        "role": entry["role"],
        "default_branch": default_branch,
        "commit_sha": sha,
        "path": relative_path.as_posix(),
        "content_sha256": hashlib.sha256(raw).hexdigest(),
        "production_authority": entry["production_authority"],
        "use_for_rag": entry["use_for_rag"],
        "use_for_synthetic_grounding": entry["use_for_synthetic_grounding"],
        "direct_sft": entry["direct_sft"],
        "content": text,
    }


def _process_file(
    path: Path,
    relative_path: Path,
    max_bytes: int,
    metadata: tuple[dict, str, str, str, str],
) -> tuple[str, str | None, dict | None]:
    ok, reason = allowed(path, relative_path, max_bytes)
    if not ok:
        return "skipped", reason, None
    content = _read_source(path)
    if content is None:
        return "skipped", "read_or_decode_failed", None

    raw, text = content
    entry, owner, name, default_branch, sha = metadata
    sensitive_reason = _sensitive_reason(relative_path, text)
    if sensitive_reason is not None:
        return "sensitive", sensitive_reason, {
            "repository": name,
            "commit_sha": sha,
            "path": relative_path.as_posix(),
            "content_sha256": hashlib.sha256(raw).hexdigest(),
            "reason": sensitive_reason,
        }
    return "accepted", None, _source_record(
        entry,
        owner,
        name,
        default_branch,
        sha,
        relative_path,
        raw,
        text,
    )


def _prune_directories(dirnames: list[str]) -> None:
    dirnames[:] = sorted(
        dirname
        for dirname in dirnames
        if dirname.lower() not in DENY_PARTS
        and not dirname.lower().startswith(".env")
    )


def _harvest_repository(
    repo_dir: Path,
    metadata: tuple[dict, str, str, str, str],
    max_bytes: int,
    out,
    audit: dict,
) -> tuple[int, int, int, dict[str, int]]:
    accepted = skipped = sensitive = 0
    skip_reasons: dict[str, int] = {}
    for root, dirnames, filenames in os.walk(repo_dir, topdown=True):
        _prune_directories(dirnames)
        root_path = Path(root)
        for filename in sorted(filenames):
            path = root_path / filename
            status, reason, payload = _process_file(
                path,
                path.relative_to(repo_dir),
                max_bytes,
                metadata,
            )
            if status == "accepted":
                out.write(json.dumps(payload, ensure_ascii=False) + "\n")
                accepted += 1
            elif status == "sensitive":
                audit["sensitive_rejections"].append(payload)
                sensitive += 1
            else:
                skipped += 1
                if reason is None:
                    raise RuntimeError("skipped source file missing rejection reason")
                skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
    return accepted, skipped, sensitive, skip_reasons


def _record_success(
    name: str,
    sha: str,
    result: tuple[int, int, int, dict[str, int]],
    counts: dict[str, int],
    repo_summary: list[dict],
) -> None:
    accepted, skipped, sensitive, skip_reasons = result
    counts["repositories"] += 1
    counts["accepted_files"] += accepted
    counts["skipped_files"] += skipped
    counts["sensitive_rejected"] += sensitive
    repo_summary.append(
        {
            "repository": name,
            "commit_sha": sha,
            "accepted_files": accepted,
            "skipped_files": skipped,
            "sensitive_rejected": sensitive,
            "skip_reasons": skip_reasons,
        }
    )
    reasons = ", ".join(
        f"{reason}={count}" for reason, count in sorted(skip_reasons.items())
    )
    suffix = f" [{reasons}]" if reasons else ""
    print(
        f"{name}: {accepted} accepted, {skipped} skipped, "
        f"{sensitive} sensitive-rejected{suffix}"
    )


def _open_output(output: Path):
    if output.suffix.lower() == ".gz":
        return gzip.open(output, "wt", encoding="utf-8")
    return output.open("w", encoding="utf-8")


def _write_outputs(
    summary_path: Path,
    audit_path: Path | None,
    output: Path,
    counts: dict[str, int],
    repo_summary: list[dict],
    audit: dict,
) -> None:
    summary = {
        "schema_version": 1,
        "counts": counts,
        "repositories": repo_summary,
        "output": str(output),
        "note": (
            "Source corpus is for RAG/synthetic grounding. "
            "It is not a normalized SFT dataset."
        ),
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if audit_path is not None:
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.write_text(json.dumps(audit, indent=2), encoding="utf-8")
        print(audit_path)
    print(summary_path)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument(
        "--audit",
        required=False,
        help="Optional JSON audit manifest for rejected/sensitive paths; never stores file contents.",
    )
    ap.add_argument("--max-bytes", type=int, default=MAX_BYTES_DEFAULT)
    ap.add_argument(
        "--keep-repos",
        action="store_true",
        help="Keep temporary clones after harvesting. Default deletes each repo immediately.",
    )
    args = ap.parse_args()
    if args.max_bytes <= 0:
        ap.error("--max-bytes must be greater than zero")
    return args


def main() -> int:
    args = _parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    workspace = Path(args.workspace)
    output = Path(args.output)
    summary_path = Path(args.summary)
    audit_path = Path(args.audit) if args.audit else None
    workspace.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)

    counts = _initial_counts()
    repo_summary: list[dict] = []
    audit = _initial_audit()
    with _open_output(output) as out:
        for entry in manifest["repositories"]:
            cloned = _clone_entry(entry, workspace, counts, repo_summary, audit)
            if cloned is None:
                continue
            manifest_entry, owner, name, default_branch, repo_dir, sha = cloned
            metadata = (manifest_entry, owner, name, default_branch, sha)
            try:
                result = _harvest_repository(
                    repo_dir,
                    metadata,
                    args.max_bytes,
                    out,
                    audit,
                )
            finally:
                if not args.keep_repos:
                    remove_tree(repo_dir)
            _record_success(name, sha, result, counts, repo_summary)

    _write_outputs(
        summary_path,
        audit_path,
        output,
        counts,
        repo_summary,
        audit,
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
