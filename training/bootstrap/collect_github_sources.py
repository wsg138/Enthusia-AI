#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess  # nosec B404 -- required for validated, argv-only gh/git execution.
import tempfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath

TEXT_EXTENSIONS = {
    ".md", ".txt", ".rst", ".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs",
    ".cjs", ".py", ".yml", ".yaml", ".json", ".toml", ".properties", ".xml",
    ".gradle", ".sql", ".sh", ".ps1", ".html", ".css", ".scss", ".ini", ".cfg"
}
ALLOWED_FILENAMES = {
    "Dockerfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle",
    "settings.gradle.kts", "plugin.yml", "paper-plugin.yml", "velocity-plugin.json"
}
DENY_PARTS = {
    ".git", ".idea", ".vscode", "node_modules", "build", "target", "dist", "out",
    ".gradle", ".cache", "coverage", "logs", "backups", "backup",
    ".ssh", "secrets", "credentials", "vendor"
}
DENY_FILENAMES = {
    ".env", ".env.local", ".env.production", ".env.development", "id_rsa", "id_ed25519",
    "credentials.json", "secrets.json"
}
DENY_SUFFIXES = {
    ".jar", ".class", ".zip", ".tar", ".gz", ".7z", ".rar", ".png", ".jpg", ".jpeg",
    ".gif", ".webp", ".mp4", ".mov", ".mp3", ".wav", ".pdf", ".db", ".sqlite",
    ".sqlite3", ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".lock"
}
MAX_BYTES_DEFAULT = 512_000
GITHUB_OWNER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
GITHUB_REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
SAFE_BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$")
COMMIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{40,64}$")


class CommandError(RuntimeError):
    """Raised when a validated local command exits unsuccessfully."""


def validate_github_owner(value: object) -> str:
    if not isinstance(value, str) or not GITHUB_OWNER_RE.fullmatch(value):
        raise ValueError("invalid GitHub owner")
    if value.startswith("-") or value.endswith("-") or "--" in value:
        raise ValueError("invalid GitHub owner")
    return value


def validate_github_repository(value: object) -> str:
    if not isinstance(value, str) or not GITHUB_REPOSITORY_RE.fullmatch(value):
        raise ValueError("invalid GitHub repository")
    if value in {".", ".."} or "/" in value or "\\" in value:
        raise ValueError("invalid GitHub repository")
    return value


def validate_git_branch(value: object) -> str:
    if not isinstance(value, str) or not SAFE_BRANCH_RE.fullmatch(value):
        raise ValueError("invalid Git branch")
    if (
        ".." in value
        or "@{" in value
        or value.endswith((".", "/"))
        or any(
            part in {"", ".", ".."}
            or part.startswith(".")
            or part.endswith(".lock")
            for part in value.split("/")
        )
    ):
        raise ValueError("invalid Git branch")
    return value


def _resolve_executable(name: str) -> Path:
    discovered = shutil.which(name)
    if not discovered:
        raise RuntimeError(f"{name} CLI is required")
    resolved = Path(discovered).resolve()
    if not resolved.is_file():
        raise RuntimeError(f"{name} CLI path is not a file")
    return resolved


def _run_checked(
    executable: Path,
    arguments: list[str],
    cwd: Path | None = None,
    timeout: int = 600,
) -> str:
    command = [str(executable), *arguments]
    # Semgrep cannot prove the executable/arguments were validated above. This
    # exact call is argv-only, shell=False, and receives validated repo/ref data.
    completed = subprocess.run(  # nosec B603  # nosemgrep
        command,  # nosemgrep -- validated argv; Semgrep taint does not model validators.
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        shell=False,
    )
    if completed.returncode != 0:
        # Do not copy stderr into generated audit/corpus metadata. Authentication
        # remains inside gh and process diagnostics must not become model-visible.
        raise CommandError(
            f"{executable.name} failed with exit code {completed.returncode}"
        )
    return completed.stdout.strip()


def allowed(actual_path: Path, relative_path: Path, max_bytes: int) -> tuple[bool, str]:
    rel = PurePosixPath(relative_path.as_posix())
    lower_parts = {part.lower() for part in rel.parts}
    if lower_parts & DENY_PARTS:
        return False, "denied_path"
    name_lower = relative_path.name.lower()
    if name_lower in DENY_FILENAMES or name_lower.startswith(".env."):
        return False, "denied_secret_filename"
    if relative_path.suffix.lower() in DENY_SUFFIXES:
        return False, "denied_binary_or_secret_suffix"
    if (
        relative_path.name not in ALLOWED_FILENAMES
        and relative_path.suffix.lower() not in TEXT_EXTENSIONS
    ):
        return False, "unsupported_extension"
    try:
        if actual_path.stat().st_size > max_bytes:
            return False, "too_large"
    except OSError:
        return False, "stat_failed"
    return True, "accepted"


def looks_sensitive(text: str) -> bool:
    # High-signal guards for source/code text.
    upper = text.upper()
    private_key_marker = "-----BEGIN " + "PRIVATE KEY-----"
    if private_key_marker in upper:
        return True
    if "DISCORD_TOKEN=" in upper or "DATABASE_URL=" in upper:
        return True
    return False


CONFIG_EXTENSIONS = {
    ".yml", ".yaml", ".json", ".toml", ".properties", ".ini", ".cfg", ".xml"
}
SENSITIVE_CONFIG_KEY = re.compile(
    r"(?ix)^\s*(?:"
    r"(?:mysql|db|database|storage)[._-]?password|"
    r"password|passwd|pwd|"
    r"(?:bot|auth|access|refresh|api|control|trigger)[._-]?token|"
    r"botToken|triggerToken|"
    r"api[._-]?key|secret[._-]?key|secret[._-]?access[._-]?key|"
    r"client[._-]?secret|shared[._-]?secret|control[._-]?secret|"
    r"sync[._-]?secret|authority[._-]?secret|"
    r"webhook(?:[._-]?url)?|"
    r"forwarding[._-]?secret(?:[._-]?file)?|"
    r"private[._-]?key|"
    r"database[._-]?url"
    r")\s*$"
)


def config_has_sensitive_key(relative_path: Path, text: str) -> bool:
    ext = relative_path.suffix.lower()
    if ext not in CONFIG_EXTENSIONS and relative_path.name.lower() not in {
        "server.properties", "plugin.yml", "paper-plugin.yml"
    }:
        return False

    # We intentionally reject the entire config document whenever it defines a
    # sensitive credential-bearing key, even if the current value appears blank
    # or templated. The AI does not need these files badly enough to justify
    # risking credential ingestion.
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r'^\s*["\']?([^:=\"\']+)["\']?\s*[:=]', raw)
        if match and SENSITIVE_CONFIG_KEY.match(match.group(1).strip()):
            return True
    return False


def _force_remove_readonly(
    function: Callable[[str], object],
    path: str,
    original_error: BaseException,
) -> None:
    """Make a Windows read-only checkout path writable and retry once."""
    if not isinstance(original_error, PermissionError):
        raise original_error
    os.chmod(path, stat.S_IWRITE)
    function(path)


def remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, onexc=_force_remove_readonly)


def _validated_repo_entry(entry: object) -> tuple[str, str, str]:
    if not isinstance(entry, dict):
        raise ValueError("repository manifest entry must be an object")
    return (
        validate_github_owner(entry.get("owner")),
        validate_github_repository(entry.get("name")),
        validate_git_branch(entry.get("default_branch")),
    )


def ensure_repo(owner: str, name: str, branch: str, root: Path) -> tuple[Path, str]:
    owner = validate_github_owner(owner)
    name = validate_github_repository(name)
    branch = validate_git_branch(branch)
    gh_executable = _resolve_executable("gh")
    git_executable = _resolve_executable("git")

    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    repo_dir = Path(tempfile.mkdtemp(prefix=f"{name}-", dir=root)).resolve()
    remove_tree(repo_dir)

    try:
        _run_checked(
            gh_executable,
            [
                "repo", "clone", f"{owner}/{name}", str(repo_dir), "--",
                "-c", "core.longpaths=true",
                "--depth", "1", "--single-branch", "--branch", branch,
                "--filter=blob:none",
            ],
        )
        sha = _run_checked(git_executable, ["rev-parse", "HEAD"], cwd=repo_dir)
        if not COMMIT_SHA_RE.fullmatch(sha):
            raise CommandError("git returned an invalid commit SHA")
        return repo_dir, sha.lower()
    except (CommandError, OSError, subprocess.SubprocessError, ValueError):
        remove_tree(repo_dir)
        raise


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
    error: str,
    counts: dict[str, int],
    repo_summary: list[dict],
    audit: dict,
) -> None:
    counts["repositories_failed"] += 1
    failure = {
        "repository": repository,
        "status": "FAILED",
        "error": error,
    }
    repo_summary.append(failure)
    audit["repository_failures"].append(failure)
    print(f"{repository}: FAILED — {error}")


def _clone_manifest_entry(
    entry: object,
    workspace: Path,
    counts: dict[str, int],
    repo_summary: list[dict],
    audit: dict,
) -> tuple[dict, str, str, str, Path, str] | None:
    if not isinstance(entry, dict):
        _record_failure(
            "<invalid-manifest-entry>",
            "ValueError: repository manifest entry must be an object",
            counts,
            repo_summary,
            audit,
        )
        return None
    if not entry.get("include", False):
        return None

    display_name = (
        entry.get("name")
        if isinstance(entry.get("name"), str)
        else "<invalid-repository>"
    )
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
        _record_failure(
            display_name,
            f"{type(exc).__name__}: {exc}",
            counts,
            repo_summary,
            audit,
        )
        return None
    return entry, owner, name, default_branch, repo_dir, sha


def _read_utf8(path: Path) -> tuple[bytes, str] | None:
    try:
        raw = path.read_bytes()
        return raw, raw.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _sensitive_reason(relative_path: Path, text: str) -> str | None:
    if config_has_sensitive_key(relative_path, text):
        return "sensitive_config_key"
    if looks_sensitive(text):
        return "high_signal_secret_pattern"
    return None


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


def _process_source_file(
    path: Path,
    relative_path: Path,
    max_bytes: int,
    metadata: tuple[dict, str, str, str, str],
) -> tuple[str, str | None, dict | None, dict | None]:
    ok, reason = allowed(path, relative_path, max_bytes)
    if not ok:
        return "skipped", reason, None, None

    content = _read_utf8(path)
    if content is None:
        return "skipped", "read_or_decode_failed", None, None
    raw, text = content

    sensitive_reason = _sensitive_reason(relative_path, text)
    entry, owner, name, default_branch, sha = metadata
    if sensitive_reason is not None:
        rejection = {
            "repository": name,
            "commit_sha": sha,
            "path": relative_path.as_posix(),
            "content_sha256": hashlib.sha256(raw).hexdigest(),
            "reason": sensitive_reason,
        }
        return "sensitive", sensitive_reason, None, rejection

    record = _source_record(
        entry,
        owner,
        name,
        default_branch,
        sha,
        relative_path,
        raw,
        text,
    )
    return "accepted", None, record, None


def _prune_directories(dirnames: list[str]) -> None:
    dirnames[:] = sorted(
        dirname
        for dirname in dirnames
        if dirname.lower() not in DENY_PARTS
        and not dirname.lower().startswith(".env")
    )


def _harvest_repo(
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
            relative_path = path.relative_to(repo_dir)
            status, reason, record, rejection = _process_source_file(
                path,
                relative_path,
                max_bytes,
                metadata,
            )
            if status == "accepted":
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                accepted += 1
            elif status == "sensitive":
                audit["sensitive_rejections"].append(rejection)
                sensitive += 1
            else:
                skipped += 1
                assert reason is not None
                skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
    return accepted, skipped, sensitive, skip_reasons


def _record_repo_success(
    name: str,
    sha: str,
    accepted: int,
    skipped: int,
    sensitive: int,
    skip_reasons: dict[str, int],
    counts: dict[str, int],
    repo_summary: list[dict],
) -> None:
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


def _write_summary(
    summary_path: Path,
    output: Path,
    counts: dict[str, int],
    repo_summary: list[dict],
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


def _write_audit(audit_path: Path | None, audit: dict) -> None:
    if audit_path is None:
        return
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(json.dumps(audit, indent=2), encoding="utf-8")
    print(audit_path)


def main() -> int:
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
            cloned = _clone_manifest_entry(
                entry,
                workspace,
                counts,
                repo_summary,
                audit,
            )
            if cloned is None:
                continue
            manifest_entry, owner, name, default_branch, repo_dir, sha = cloned
            metadata = (manifest_entry, owner, name, default_branch, sha)
            try:
                accepted, skipped, sensitive, skip_reasons = _harvest_repo(
                    repo_dir,
                    metadata,
                    args.max_bytes,
                    out,
                    audit,
                )
            finally:
                if not args.keep_repos:
                    remove_tree(repo_dir)
            _record_repo_success(
                name,
                sha,
                accepted,
                skipped,
                sensitive,
                skip_reasons,
                counts,
                repo_summary,
            )

    _write_summary(summary_path, output, counts, repo_summary)
    _write_audit(audit_path, audit)
    print(summary_path)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
