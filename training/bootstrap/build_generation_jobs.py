#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import re
from pathlib import Path

try:
    from training.bootstrap.generation_evidence import (
        COMMAND_LINE_RE,
        CONFIG_EXTS,
        MAX_EVIDENCE_CHARS,
        MAX_EVIDENCE_LINES,
        SOURCE_EXTS,
        build_evidence_window,
        context_for,
        contextual_visibility,
        source_visibility,
    )
    from training.bootstrap.generation_prompt import build_prompt, profiles_for
except ModuleNotFoundError:
    from generation_evidence import (
        COMMAND_LINE_RE,
        CONFIG_EXTS,
        MAX_EVIDENCE_CHARS,
        MAX_EVIDENCE_LINES,
        SOURCE_EXTS,
        build_evidence_window,
        context_for,
        contextual_visibility,
        source_visibility,
    )
    from generation_prompt import build_prompt, profiles_for

DOC_EXTS = {".md", ".txt", ".rst"}
USEFUL_TERMS = (
    "command", "permission", "usage", "rank", "role", "rule", "price", "cost",
    "cooldown", "limit", "requires", "required", "allowed", "denied", "toggle",
    "enable", "disable", "join", "link", "unlink", "ticket", "mail", "claim",
    "guild", "home", "teleport", "vote", "tag", "market", "currency", "balance",
    "staff", "ban", "mute", "warn", "report", "appeal", "autoclick", "event",
)
CODE_PREFIXES = (
    "import ", "package ", "class ", "public class ", "private ", "protected ",
    "def ", "function ", "const ", "let ", "var ", "interface ", "type ",
    "return ", "throw ", "if (", "for (", "while (",
)
EXCLUDED_PATH_MARKERS = (
    "test_rollout", "test-rollout", "/test_setup", "/test-setup",
    "owner_retest", "owner-retest", "/retest", "acceptance-harness",
    "acceptance_harness", "component-metadata", "wiki-maintenance",
    "workspace-state", "codacy-evidence", "codacy_evidence",
)
EXCLUDED_ROOTED_PATHS = ("/legacy/", "/handoffs/", "/ai-agents/")
EXCLUDED_PREFIXES = ("legacy/", "handoffs/", "ai-agents/")
HIGH_VALUE_PATH_TOKENS = (
    "/docs/", "/wiki/", "readme", "player_guide", "commands", "permissions",
    "rules", "config", "plugin.yml", "paper-plugin.yml", "server.properties",
    "messages", "help", "support", "link", "rank", "econom", "ticket",
)
CURRENT_SERVER_PREFIXES = tuple(
    f"network-snapshot/{server}/current/"
    for server in ("smp", "hub", "velocity", "sentinel")
)
HARD_EXCLUDED_PATH_TOKENS = ("cinematic-review", "/assets/", "config-audit")
PERMISSION_NODE_LINE_RE = re.compile(r"[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+){1,}")
GENERIC_TABLE_HEADERS = {
    "command", "commands", "permission", "permissions", "description", "behavior",
    "feature", "features", "setting", "settings", "option", "options", "name",
    "value", "default", "example", "examples", "status", "category", "intended use",
}
PUBLIC_PROFILES = ("novice", "familiar")


def _path_is_excluded(lower_path: str) -> bool:
    rooted = "/" + lower_path
    if any(marker in lower_path for marker in EXCLUDED_PATH_MARKERS):
        return True
    if any(marker in rooted for marker in EXCLUDED_ROOTED_PATHS):
        return True
    return lower_path.startswith(EXCLUDED_PREFIXES)


def _base_path_score(path: str) -> int:
    extension = Path(path).suffix.lower()
    if extension in DOC_EXTS:
        return 50
    if extension in CONFIG_EXTS:
        return 35
    return 10 if extension in SOURCE_EXTS else 0


def _is_current_server_path(record: dict, lower: str) -> bool:
    return (
        record.get("repository") == "Enthusia-Server"
        and lower.startswith(CURRENT_SERVER_PREFIXES)
    )


def _is_test_path(lower: str) -> bool:
    return (
        any(marker in lower for marker in ("/test/", "/tests/"))
        or lower.startswith("tests/")
    )


def _is_github_path(lower: str) -> bool:
    return "/.github/" in "/" + lower or lower.startswith(".github/")


def _path_score_adjustment(record: dict, lower: str) -> int:
    return (
        25 * int(any(token in lower for token in HIGH_VALUE_PATH_TOKENS))
        + 30 * int(_is_current_server_path(record, lower))
        - 45 * int(_is_test_path(lower))
        - 25 * int(_is_github_path(lower))
        - 15 * int("changelog" in lower)
    )


def _hard_excluded_path(lower: str) -> bool:
    has_marker = any(token in lower for token in HARD_EXCLUDED_PATH_TOKENS)
    return has_marker or lower.endswith("/implementation.md")


def path_score(record: dict) -> int:
    path = str(record.get("path", "")).replace("\\", "/")
    lower = path.lower()
    excluded = (
        record.get("role") == "ai_system"
        or _path_is_excluded(lower)
        or _hard_excluded_path(lower)
    )
    return -10_000 if excluded else _base_path_score(path) + _path_score_adjustment(
        record, lower
    )


def clean_candidate_line(raw_line: str) -> str:
    return raw_line.rstrip("\r")


def _table_header_cells(line: str) -> list[str]:
    if not (line.startswith("|") and line.endswith("|")):
        return []
    cells = [
        cell.strip().replace("**", "").replace(chr(96), "").lower()
        for cell in line.strip("|").split("|")
    ]
    return [
        cell
        for cell in cells
        if cell and not re.fullmatch(r":?-{3,}:?", cell)
    ]


def _generic_table_header(line: str) -> bool:
    cells = _table_header_cells(line)
    return bool(cells) and set(cells).issubset(GENERIC_TABLE_HEADERS)


def _line_is_rejected(line: str, lower: str, extension: str) -> bool:
    checks = (
        not 15 <= len(line) <= 500,
        line.startswith("#"),
        line.endswith(":") and not line.startswith(("http://", "https://")),
        "\ufffd" in line or ("shaded" in lower and "relocated" in lower),
        extension in CONFIG_EXTS and line.lstrip().startswith("#"),
        bool(re.search(r"\b[A-Z][A-Z0-9_]{4,}_OK\b", line)),
        not bool(re.search(r"[A-Za-z0-9]", line)),
        bool(re.fullmatch(r"[{}\[\](),:;<>/\\|\x60~*#=+_. -]+", line)),
        _generic_table_header(line),
    )
    return any(checks)


def _source_line_adjustment(line: str, lower: str, extension: str) -> int:
    if extension not in SOURCE_EXTS:
        return 0
    adjustment = -45 if lower.startswith(CODE_PREFIXES) else 0
    return adjustment - 10 if re.search(r"[{};]$", line) else adjustment


def _table_line_adjustment(line: str) -> int:
    if not (line.startswith("|") and line.endswith("|")):
        return 0
    adjustment = 20
    adjustment += 45 * int(bool(re.search(r"/[A-Za-z][A-Za-z0-9_-]*", line)))
    adjustment += 30 * int(bool(PERMISSION_NODE_LINE_RE.search(line)))
    return adjustment


def _semantic_line_adjustment(line: str, lower: str) -> int:
    return (
        35 * int(bool(COMMAND_LINE_RE.search(line)))
        + 15 * int(bool(PERMISSION_NODE_LINE_RE.search(line)))
        + 20 * int(any(term in lower for term in USEFUL_TERMS))
        + 5 * int(lower.startswith(("- ", "* ", "+ ")))
    )


def _length_adjustment(line: str) -> int:
    if len(line) <= 220:
        return 10
    return -20 if len(line) > 350 else 0


def line_score(record: dict, line: str, base_score: int) -> int:
    lower = line.lower()
    extension = Path(str(record.get("path", ""))).suffix.lower()
    if _line_is_rejected(line, lower, extension):
        return -10_000
    return (
        base_score
        + _source_line_adjustment(line, lower, extension)
        + _table_line_adjustment(line)
        + _semantic_line_adjustment(line, lower)
        + _length_adjustment(line)
    )


def _boundary_candidate(line: str) -> bool:
    lower = line.lower()
    has_command = COMMAND_LINE_RE.search(line) is not None
    has_permission = PERMISSION_NODE_LINE_RE.search(line) is not None
    has_boundary_term = any(
        term in lower for term in ("staff", "admin", "operator", "backend")
    )
    return has_command or has_permission or has_boundary_term


def response_mode_for(
    record: dict,
    lines: list[str],
    target_index: int,
) -> str | None:
    visibility = contextual_visibility(record, lines, target_index)
    if visibility == "public":
        return "player_support"
    return "player_boundary" if _boundary_candidate(lines[target_index]) else None


def _profiles_for(response_mode: str) -> tuple[str, ...]:
    return profiles_for(response_mode)


def production_authority_for(record: dict) -> str:
    path = str(record.get("path", "")).replace("\\", "/").lower()
    repository = str(record.get("repository", "")).lower()
    role = str(record.get("role", "")).lower()
    nonproduction = (
        role in {"staging_reference", "infrastructure_test"}
        or any(token in repository for token in ("staging", "-sim"))
        or any(token in f"/{path}" for token in (
            "/staging/", "/test/", "/tests/", "/history/", "/historical/",
            "/retained/", "/archive/", "/snapshots/", "/legacy/",
        ))
        or record.get("production_authority") == "non_production_reference"
    )
    return "non_production_reference" if nonproduction else "requires_deployment_verification"


def _record_candidates(
    record: dict,
) -> list[tuple[int, dict, int, list[str]]]:
    base = path_score(record)
    if base <= 0:
        return []
    if record.get("use_for_synthetic_grounding") is False:
        return []
    lines = [
        clean_candidate_line(line)
        for line in record.get("content", "").splitlines()
    ]
    candidates = []
    for index, line in enumerate(lines):
        score = line_score(record, line.strip(), base)
        if score > 0 and response_mode_for(record, lines, index) is not None:
            candidates.append((score, record, index, lines))
    return candidates


def _candidate_sort_key(
    item: tuple[int, dict, int, list[str]],
) -> tuple[int, str, str, int]:
    return (-item[0], item[1]["repository"], item[1]["path"], item[2])


def _load_candidates(
    input_path: str,
) -> list[tuple[int, dict, int, list[str]]]:
    candidates: list[tuple[int, dict, int, list[str]]] = []
    with gzip.open(input_path, "rt", encoding="utf-8") as handle:
        for raw in handle:
            candidates.extend(_record_candidates(json.loads(raw)))
    candidates.sort(key=_candidate_sort_key)
    return candidates


def _job_from_candidate(
    score: int,
    record: dict,
    line_index: int,
    lines: list[str],
    profile: str,
) -> dict:
    repo = record["repository"]
    target_line = lines[line_index]
    response_mode = response_mode_for(record, lines, line_index)
    evidence, ranges, evidence_text = build_evidence_window(
        record, lines, line_index
    )
    digest = _job_digest(
        repo, record, line_index, target_line, profile, response_mode
    )
    job = _job_payload(
        score,
        record,
        line_index,
        target_line,
        profile,
        response_mode,
        evidence,
        ranges,
        evidence_text,
        digest,
        contextual_visibility(record, lines, line_index),
        lines,
    )
    job["prompt"] = build_prompt(job)
    return job


def _job_digest(
    repo: str,
    record: dict,
    line_index: int,
    target_line: str,
    profile: str,
    response_mode: str | None,
) -> str:
    material = (
        f'{repo}\n{record["commit_sha"]}\n{record["path"]}\n'
        f"{line_index}\n{target_line}\n{profile}\n{response_mode}"
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _job_payload(
    score: int,
    record: dict,
    line_index: int,
    target_line: str,
    profile: str,
    response_mode: str | None,
    evidence: list[dict],
    ranges: list[dict],
    evidence_text: str,
    digest: str,
    visibility: str,
    lines: list[str],
) -> dict:
    repo = record["repository"]
    source_id = (
        f'github:wsg138/{repo}@{record["commit_sha"]}:'
        f'{record["path"]}#line-{line_index + 1}'
    )
    return {
        "job_id": f"ground-{digest}",
        "source_id": source_id,
        "source_version": record["commit_sha"],
        "repository": repo,
        "role": record.get("role"),
        "production_authority": production_authority_for(record),
        "visibility": visibility,
        "response_mode": response_mode,
        "familiarity_profile": profile,
        "path": record["path"],
        "line_number": line_index + 1,
        "source_score": score,
        "target_line": target_line,
        "evidence": evidence,
        "evidence_ranges": ranges,
        "evidence_text": evidence_text,
        "context": context_for(lines, line_index),
    }


def _jobs_for_candidate(
    score: int,
    record: dict,
    line_index: int,
    lines: list[str],
) -> list[dict]:
    response_mode = response_mode_for(record, lines, line_index)
    if response_mode is None:
        return []
    return [
        _job_from_candidate(score, record, line_index, lines, profile)
        for profile in _profiles_for(response_mode)
    ]


def _select_jobs(
    candidates: list[tuple[int, dict, int, list[str]]],
    max_jobs: int,
    per_repo_cap: int,
) -> tuple[list[dict], collections.Counter, set[tuple[str, str]]]:
    repo_counts: collections.Counter = collections.Counter()
    jobs: list[dict] = []
    source_files: set[tuple[str, str]] = set()
    seen_content: set[tuple[str, str, str]] = set()
    for candidate in candidates:
        if _candidate_exhausted(candidate, repo_counts, per_repo_cap):
            continue
        score, record, line_index, lines = candidate
        for job in _jobs_for_candidate(score, record, line_index, lines):
            if _job_can_be_selected(job, repo_counts, seen_content, per_repo_cap):
                _select_job(job, jobs, repo_counts, source_files, seen_content)
                if len(jobs) >= max_jobs:
                    return jobs, repo_counts, source_files
    return jobs, repo_counts, source_files


def _candidate_exhausted(
    candidate: tuple[int, dict, int, list[str]],
    repo_counts: collections.Counter,
    per_repo_cap: int,
) -> bool:
    return repo_counts[candidate[1]["repository"]] >= per_repo_cap


def _job_can_be_selected(
    job: dict,
    repo_counts: collections.Counter,
    seen_content: set[tuple[str, str, str]],
    per_repo_cap: int,
) -> bool:
    repo = job["repository"]
    dedupe = (repo, job["target_line"], job["familiarity_profile"])
    return repo_counts[repo] < per_repo_cap and dedupe not in seen_content


def _select_job(
    job: dict,
    jobs: list[dict],
    repo_counts: collections.Counter,
    source_files: set[tuple[str, str]],
    seen_content: set[tuple[str, str, str]],
) -> None:
    repo = job["repository"]
    dedupe = (repo, job["target_line"], job["familiarity_profile"])
    seen_content.add(dedupe)
    jobs.append(job)
    repo_counts[repo] += 1
    source_files.add((repo, job["path"]))


def _write_jobs(output_path: str, jobs: list[dict]) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8") as out:
        for job in jobs:
            out.write(json.dumps(job, ensure_ascii=False) + "\n")


def _build_manifest(
    jobs: list[dict],
    source_files: set[tuple[str, str]],
    repo_counts: collections.Counter,
    max_jobs: int,
    per_repo_cap: int,
) -> dict:
    return {
        "schema_version": 3,
        "selection": "deterministic-bounded-coherent-evidence-window",
        "job_count": len(jobs),
        "source_file_count": len(source_files),
        "repositories": len(repo_counts),
        "jobs_by_repository": dict(repo_counts.most_common()),
        "max_jobs": max_jobs,
        "per_repo_cap": per_repo_cap,
        "generator_contract": {
            "bounded_evidence_max_lines": MAX_EVIDENCE_LINES,
            "bounded_evidence_max_chars": MAX_EVIDENCE_CHARS,
            "model_writes_natural_answer": True,
            "model_does_not_choose_evidence": True,
            "model_does_not_choose_visibility": True,
            "model_does_not_choose_production_authority": True,
            "provenance_preserved": True,
            "public_staff_evidence_isolation": True,
            "novice_familiar_style_profiles": True,
            "skip_allowed": True,
            "chain_of_thought_forbidden": True,
            "owner_review_required_before_admission": True,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--max-jobs", type=int, default=1200)
    parser.add_argument("--per-repo-cap", type=int, default=80)
    args = parser.parse_args()
    candidates = _load_candidates(args.input)
    jobs, repo_counts, source_files = _select_jobs(
        candidates, args.max_jobs, args.per_repo_cap
    )
    _write_jobs(args.output, jobs)
    manifest = _build_manifest(
        jobs, source_files, repo_counts, args.max_jobs, args.per_repo_cap
    )
    Path(args.manifest).write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())