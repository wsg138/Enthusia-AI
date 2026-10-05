from __future__ import annotations

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


def _invalid_branch_part(part: str) -> bool:
    if part in {"", ".", ".."}:
        return True
    return part.startswith(".") or part.endswith(".lock")


def _invalid_branch_shape(value: str) -> bool:
    forbidden_marker = any(marker in value for marker in ("..", "@{"))
    bad_ending = value.endswith((".", "/"))
    bad_part = any(_invalid_branch_part(part) for part in value.split("/"))
    return forbidden_marker or bad_ending or bad_part


def validate_git_branch(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid Git branch")
    if not SAFE_BRANCH_RE.fullmatch(value) or _invalid_branch_shape(value):
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


def _path_policy_rejection(relative_path: Path) -> str | None:
    rel = PurePosixPath(relative_path.as_posix())
    if {part.lower() for part in rel.parts} & DENY_PARTS:
        return "denied_path"

    name_lower = relative_path.name.lower()
    if name_lower in DENY_FILENAMES or name_lower.startswith(".env."):
        return "denied_secret_filename"
    if relative_path.suffix.lower() in DENY_SUFFIXES:
        return "denied_binary_or_secret_suffix"

    supported = (
        relative_path.name in ALLOWED_FILENAMES
        or relative_path.suffix.lower() in TEXT_EXTENSIONS
    )
    return None if supported else "unsupported_extension"


def allowed(
    actual_path: Path,
    relative_path: Path,
    max_bytes: int,
) -> tuple[bool, str]:
    rejection = _path_policy_rejection(relative_path)
    if rejection is not None:
        return False, rejection
    try:
        too_large = actual_path.stat().st_size > max_bytes
    except OSError:
        return False, "stat_failed"
    return (False, "too_large") if too_large else (True, "accepted")


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


def _sensitive_config_candidate(relative_path: Path) -> bool:
    allowed_names = {"server.properties", "plugin.yml", "paper-plugin.yml"}
    return (
        relative_path.suffix.lower() in CONFIG_EXTENSIONS
        or relative_path.name.lower() in allowed_names
    )


def _config_key(raw: str) -> str | None:
    stripped = raw.strip()
    if not stripped or stripped.startswith("#"):
        return None
    match = re.match(r'^\s*["\']?([^:="\']+)["\']?\s*[:=]', raw)
    return match.group(1).strip() if match else None


def config_has_sensitive_key(relative_path: Path, text: str) -> bool:
    if not _sensitive_config_candidate(relative_path):
        return False
    for raw in text.splitlines():
        key = _config_key(raw)
        if key is not None and SENSITIVE_CONFIG_KEY.match(key):
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
