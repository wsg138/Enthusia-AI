#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
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
    ".gradle", ".cache", "coverage", "logs", "log", "data", "backups", "backup",
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


def allowed(path: Path, max_bytes: int) -> tuple[bool, str]:
    rel = PurePosixPath(path.as_posix())
    lower_parts = {part.lower() for part in rel.parts}
    if lower_parts & DENY_PARTS:
        return False, "denied_path"
    name_lower = path.name.lower()
    if name_lower in DENY_FILENAMES or name_lower.startswith(".env."):
        return False, "denied_secret_filename"
    if path.suffix.lower() in DENY_SUFFIXES:
        return False, "denied_binary_or_secret_suffix"
    if path.name not in ALLOWED_FILENAMES and path.suffix.lower() not in TEXT_EXTENSIONS:
        return False, "unsupported_extension"
    try:
        if path.stat().st_size > max_bytes:
            return False, "too_large"
    except OSError:
        return False, "stat_failed"
    return True, "accepted"


def looks_sensitive(text: str) -> bool:
    # High-signal guards only. Full dataset secret scanning remains W16's job.
    upper = text.upper()
    private_key_marker = "-----BEGIN " + "PRIVATE KEY-----"
    if private_key_marker in upper:
        return True
    if "DISCORD_TOKEN=" in upper or "DATABASE_URL=" in upper:
        return True
    return False


def ensure_repo(owner: str, name: str, branch: str, root: Path) -> tuple[Path, str]:
    repo_dir = root / name
    if repo_dir.exists():
        shutil.rmtree(repo_dir, ignore_errors=True)
    if not shutil.which("gh"):
        raise RuntimeError("gh CLI is required so GitHub authentication stays outside the corpus")
    # Shallow + blob-filtered keeps temporary repo storage low. The working
    # tree fetches only blobs actually needed for the current checkout.
    run([
        "gh", "repo", "clone", f"{owner}/{name}", str(repo_dir), "--",
        "--depth", "1", "--single-branch", "--branch", branch, "--filter=blob:none"
    ])
    sha = run(["git", "rev-parse", "HEAD"], cwd=repo_dir)
    return repo_dir, sha


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--summary", required=True)
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
                repo_summary.append({
                    "repository": entry["name"],
                    "status": "FAILED",
                    "error": f"{type(exc).__name__}: {exc}",
                })
                print(f"{entry['name']}: FAILED — {type(exc).__name__}: {exc}")
                continue
            accepted = skipped = sensitive = 0
            for path in sorted(repo_dir.rglob("*")):
                if not path.is_file():
                    continue
                rel = path.relative_to(repo_dir)
                ok, reason = allowed(rel, args.max_bytes)
                if not ok:
                    skipped += 1
                    continue
                try:
                    raw = path.read_bytes()
                    text = raw.decode("utf-8")
                except (OSError, UnicodeDecodeError):
                    skipped += 1
                    continue
                if looks_sensitive(text):
                    sensitive += 1
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
            })
            print(f"{entry['name']}: {accepted} accepted, {skipped} skipped, {sensitive} sensitive-rejected")
            if not args.keep_repos:
                shutil.rmtree(repo_dir, ignore_errors=True)

    summary = {
        "schema_version": 1,
        "counts": counts,
        "repositories": repo_summary,
        "output": str(output),
        "note": "Source corpus is for RAG/synthetic grounding. It is not a normalized SFT dataset."
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(summary_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
