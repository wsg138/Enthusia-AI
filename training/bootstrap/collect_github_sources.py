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
import subprocess
import tempfile
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


def run(cmd: list[str], cwd: Path | None = None) -> str:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=600, check=False)
    if p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr[-2000:]}")
    return p.stdout.strip()


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


def _force_remove_readonly(func, path, exc_info) -> None:
    """Windows Git checkouts can contain read-only files; make them writable and retry."""
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        raise exc_info[1]


def remove_tree(path: Path) -> None:
    if not path.exists():
        return
    # Python 3.12+ supports onexc; fall back to onerror for older interpreters.
    try:
        shutil.rmtree(path, onexc=_force_remove_readonly)
    except TypeError:
        shutil.rmtree(path, onerror=_force_remove_readonly)


def ensure_repo(owner: str, name: str, branch: str, root: Path) -> tuple[Path, str]:
    root.mkdir(parents=True, exist_ok=True)
    # Always clone into a fresh unique directory. A previous interrupted run
    # can therefore never block the next run with a stale non-empty checkout.
    repo_dir = Path(tempfile.mkdtemp(prefix=f"{name}-", dir=root))
    # gh repo clone requires the destination not to exist, so remove the empty
    # directory created by mkdtemp and immediately reuse its unique pathname.
    remove_tree(repo_dir)

    if not shutil.which("gh"):
        raise RuntimeError("gh CLI is required so GitHub authentication stays outside the corpus")
    try:
        # Shallow + blob-filtered keeps temporary repo storage low. The working
        # tree fetches only blobs actually needed for the current checkout.
        run([
            "gh", "repo", "clone", f"{owner}/{name}", str(repo_dir), "--",
            "-c", "core.longpaths=true",
            "--depth", "1", "--single-branch", "--branch", branch, "--filter=blob:none"
        ])
        sha = run(["git", "rev-parse", "HEAD"], cwd=repo_dir)
        return repo_dir, sha
    except Exception:
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
            if not entry.get("include", False):
                continue
            try:
                repo_dir, sha = ensure_repo(
                    entry["owner"], entry["name"], entry["default_branch"], workspace
                )
            except Exception as exc:
                counts["repositories_failed"] += 1
                failure = {
                    "repository": entry["name"],
                    "status": "FAILED",
                    "error": f"{type(exc).__name__}: {exc}",
                }
                repo_summary.append(failure)
                audit["repository_failures"].append(failure)
                print(f"{entry['name']}: FAILED — {type(exc).__name__}: {exc}")
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
                            "repository": entry["name"],
                            "commit_sha": sha,
                            "path": rel.as_posix(),
                            "content_sha256": hashlib.sha256(raw).hexdigest(),
                            "reason": sensitive_reason,
                        })
                        continue
                    record = {
                        "schema_version": 1,
                        "kind": "authoritative_source_material",
                        "owner": entry["owner"],
                        "repository": entry["name"],
                        "role": entry["role"],
                        "default_branch": entry["default_branch"],
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
                "repository": entry["name"],
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
                f"{entry['name']}: {accepted} accepted, {skipped} skipped, "
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
