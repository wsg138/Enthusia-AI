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

    counts = {
        "repositories": 0,
        "repositories_failed": 0,
        "accepted_files": 0,
        "skipped_files": 0,
        "sensitive_rejected": 0,
    }
    repo_summary = []
    audit = {
        "schema_version": 1,
        "sensitive_rejections": [],
        "repository_failures": [],
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    opener = (
        (lambda: gzip.open(output, "wt", encoding="utf-8"))
        if output.suffix.lower() == ".gz"
        else (lambda: output.open("w", encoding="utf-8"))
    )

    with opener() as out:
        for entry in manifest["repositories"]:
            if not isinstance(entry, dict):
                counts["repositories_failed"] += 1
                failure = {
                    "repository": "<invalid-manifest-entry>",
                    "status": "FAILED",
                    "error": "ValueError: repository manifest entry must be an object",
                }
                repo_summary.append(failure)
                audit["repository_failures"].append(failure)
                print("<invalid-manifest-entry>: FAILED — invalid manifest entry")
                continue
            if not entry.get("include", False):
                continue

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
                counts["repositories_failed"] += 1
                failure = {
                    "repository": display_name,
                    "status": "FAILED",
                    "error": f"{type(exc).__name__}: {exc}",
                }
                repo_summary.append(failure)
                audit["repository_failures"].append(failure)
                print(f"{display_name}: FAILED — {type(exc).__name__}: {exc}")
                continue
            accepted = skipped = sensitive = 0
            skip_reasons: dict[str, int] = {}
            for root, dirnames, filenames in os.walk(repo_dir, topdown=True):
                # Prune generated/secret trees before descending into them.
                dirnames[:] = sorted(
                    dirname
                    for dirname in dirnames
                    if dirname.lower() not in DENY_PARTS
                    and not dirname.lower().startswith(".env")
                )
                root_path = Path(root)
                for filename in sorted(filenames):
                    path = root_path / filename
                    rel = path.relative_to(repo_dir)
                    ok, reason = allowed(path, rel, args.max_bytes)
                    if not ok:
                        skipped += 1
                        skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
                        continue
                    try:
                        raw = path.read_bytes()
                        text = raw.decode("utf-8")
                    except (OSError, UnicodeDecodeError):
                        skipped += 1
                        skip_reasons["read_or_decode_failed"] = (
                            skip_reasons.get("read_or_decode_failed", 0) + 1
                        )
                        continue
                    sensitive_reason = None
                    if config_has_sensitive_key(rel, text):
                        sensitive_reason = "sensitive_config_key"
                    elif looks_sensitive(text):
                        sensitive_reason = "high_signal_secret_pattern"

                    if sensitive_reason is not None:
                        sensitive += 1
                        audit["sensitive_rejections"].append({
                            "repository": name,
                            "commit_sha": sha,
                            "path": rel.as_posix(),
                            "content_sha256": hashlib.sha256(raw).hexdigest(),
                            "reason": sensitive_reason,
                        })
                        continue
                    record = {
                        "schema_version": 1,
                        "kind": "authoritative_source_material",
                        "owner": owner,
                        "repository": name,
                        "role": entry["role"],
                        "default_branch": default_branch,
                        "commit_sha": sha,
                        "path": rel.as_posix(),
                        "content_sha256": hashlib.sha256(raw).hexdigest(),
                        "production_authority": entry["production_authority"],
                        "use_for_rag": entry["use_for_rag"],
                        "use_for_synthetic_grounding": entry["use_for_synthetic_grounding"],
                        "direct_sft": entry["direct_sft"],
                        "content": text,
                    }
                    out.write(json.dumps(record, ensure_ascii=False) + "\n")
                    accepted += 1

            counts["repositories"] += 1
            counts["accepted_files"] += accepted
            counts["skipped_files"] += skipped
            counts["sensitive_rejected"] += sensitive
            repo_summary.append({
                "repository": name,
                "commit_sha": sha,
                "accepted_files": accepted,
                "skipped_files": skipped,
                "sensitive_rejected": sensitive,
                "skip_reasons": skip_reasons,
            })
            reasons = ", ".join(
                f"{name}={count}" for name, count in sorted(skip_reasons.items())
            )
            print(
                f"{name}: {accepted} accepted, {skipped} skipped, "
                f"{sensitive} sensitive-rejected"
                + (f" [{reasons}]" if reasons else "")
            )
            if not args.keep_repos:
                remove_tree(repo_dir)

    summary = {
        "schema_version": 1,
        "counts": counts,
        "repositories": repo_summary,
        "output": str(output),
        "note": "Source corpus is for RAG/synthetic grounding. It is not a normalized SFT dataset."
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if audit_path is not None:
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.write_text(json.dumps(audit, indent=2), encoding="utf-8")
    print(summary_path)
    if audit_path is not None:
        print(audit_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
