#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import re
from pathlib import Path

CATEGORIES = [
    "onboarding", "commands", "permissions", "rank", "economy", "tickets",
    "rules", "bugs", "account linking", "ambiguity", "escalation",
    "stale data", "conflicting evidence", "privacy",
]
DOC_EXTS = {".md", ".txt", ".rst"}
CONFIG_EXTS = {".yml", ".yaml", ".json", ".toml", ".properties", ".ini", ".cfg", ".xml"}
SOURCE_EXTS = {".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}
STAFF_SOURCE_ROLES = {
    "staff_system", "infrastructure", "infrastructure_docs",
    "network_configuration", "staging_reference", "moderation_system",
    "ai_system", "infrastructure_test", "support_system",
}
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
STAFF_PATH_TOKENS = (
    "/src/", "/internal/", "/config/", "config.", "config-", "/audit",
    "/admins/", "/admin/",
)
STAFF_LINE_TOKENS = (
    "/punish", "/ban ", "/ban<", "/mute ", "/mute<", "/kick ",
    "blacklist", "administrator", "admin permission", ".admin",
    "staff-only", "staff only",
)
STAFF_LINE_PATTERNS = (
    re.compile(r"(?:^|\s)/\S+\s+reload\b"),
    re.compile(r"\b(?:reload|debug|admin|adminview|breakothers|freeze|unfreeze)\b"),
    re.compile(
        r"(?:^|\s)/(?:ee|estaff|startupguardian|gatekeeper|tppos|warzone|"
        r"shopmarket|ekoth)\b"
    ),
    re.compile(r"(?:^|\s)/pearlglitchblocker\b"),
    re.compile(r"(?:^|\s)/warzone\s+modifier\b"),
)
STAFF_HEADING_RE = re.compile(
    r"(?i)\b(?:admin|administrative|staff|operator|internal|backend|moderation|"
    r"developer|recovery|maintenance)\b"
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
COMMAND_LINE_RE = re.compile(r"(^|\s)/[A-Za-z][A-Za-z0-9_-]*")
PERMISSION_NODE_LINE_RE = re.compile(r"[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+){1,}")
GENERIC_TABLE_HEADERS = {
    "command", "commands", "permission", "permissions", "description", "behavior",
    "feature", "features", "setting", "settings", "option", "options", "name",
    "value", "default", "example", "examples", "status", "category", "intended use",
}
MAX_EVIDENCE_LINES = 12
MAX_EVIDENCE_CHARS = 2400
PUBLIC_PROFILES = ("novice", "familiar")


def _path_is_staff(path: str) -> bool:
    lower = path.lower()
    ext = Path(path).suffix.lower()
    name = Path(path).name.lower()
    if ext in SOURCE_EXTS:
        return True
    if ext in CONFIG_EXTS and name not in {"plugin.yml", "paper-plugin.yml"}:
        return True
    return any(token in lower for token in STAFF_PATH_TOKENS)


def _line_is_staff(line: str) -> bool:
    lower = line.lower()
    if any(token in lower for token in STAFF_LINE_TOKENS):
        return True
    if STAFF_LINE_PATTERNS[1].search(lower) and COMMAND_LINE_RE.search(line):
        return True
    return any(
        pattern.search(lower)
        for index, pattern in enumerate(STAFF_LINE_PATTERNS)
        if index != 1
    )


def source_visibility(record: dict, line: str = "") -> str:
    if record.get("role") in STAFF_SOURCE_ROLES:
        return "staff"
    path = str(record.get("path", "")).replace("\\", "/")
    return "staff" if _path_is_staff(path) or _line_is_staff(line) else "public"


def _heading_level(line: str) -> int | None:
    match = re.match(r"^(#{1,6})\s+", line.strip())
    return len(match.group(1)) if match else None


def _nearest_heading(lines: list[str], index: int) -> tuple[int, str] | None:
    for current in range(index, -1, -1):
        if _heading_level(lines[current]) is not None:
            return current, lines[current]
    return None


def contextual_visibility(record: dict, lines: list[str], index: int) -> str:
    base = source_visibility(record, lines[index])
    if base == "staff":
        return base
    heading = _nearest_heading(lines, index)
    if heading and STAFF_HEADING_RE.search(heading[1]):
        return "staff"
    return "public"


def _path_is_excluded(lower_path: str) -> bool:
    rooted = "/" + lower_path
    if any(marker in lower_path for marker in EXCLUDED_PATH_MARKERS):
        return True
    if any(marker in rooted for marker in EXCLUDED_ROOTED_PATHS):
        return True
    return lower_path.startswith(EXCLUDED_PREFIXES)


def _base_path_score(path: str) -> int:
    ext = Path(path).suffix.lower()
    if ext in DOC_EXTS:
        return 50
    if ext in CONFIG_EXTS:
        return 35
    return 10 if ext in SOURCE_EXTS else 0


def _is_current_server_path(record: dict, lower: str) -> bool:
    return record.get("repository") == "Enthusia-Server" and lower.startswith(CURRENT_SERVER_PREFIXES)


def _is_test_path(lower: str) -> bool:
    return any(marker in lower for marker in ("/test/", "/tests/")) or lower.startswith("tests/")


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
    return any(token in lower for token in HARD_EXCLUDED_PATH_TOKENS) or lower.endswith("/implementation.md")


def path_score(record: dict) -> int:
    path = str(record.get("path", "")).replace("\\", "/")
    lower = path.lower()
    excluded = (
        record.get("role") == "ai_system"
        or _path_is_excluded(lower)
        or _hard_excluded_path(lower)
    )
    return -10_000 if excluded else _base_path_score(path) + _path_score_adjustment(record, lower)


def clean_candidate_line(raw_line: str) -> str:
    return raw_line.rstrip("\r").strip()


def _generic_table_header(line: str) -> bool:
    if not (line.startswith("|") and line.endswith("|")):
        return False
    cells = [
        cell.strip().replace("**", "").replace(chr(96), "").lower()
        for cell in line.strip("|").split("|")
    ]
    cells = [cell for cell in cells if cell and not re.fullmatch(r":?-{3,}:?", cell)]
    return bool(cells) and all(cell in GENERIC_TABLE_HEADERS for cell in cells)


def _line_is_rejected(line: str, lower: str, ext: str) -> bool:
    checks = (
        not 15 <= len(line) <= 500,
        bool(_heading_level(line)),
        line.endswith(":") and not line.startswith(("http://", "https://")),
        "\ufffd" in line or ("shaded" in lower and "relocated" in lower),
        ext in CONFIG_EXTS and line.lstrip().startswith("#"),
        bool(re.search(r"\b[A-Z][A-Z0-9_]{4,}_OK\b", line)),
        not bool(re.search(r"[A-Za-z0-9]", line)),
        bool(re.fullmatch(r"[{}\[\](),:;<>/\\|\x60~*#=+_. -]+", line)),
        _generic_table_header(line),
    )
    return any(checks)


def _source_line_adjustment(line: str, lower: str, ext: str) -> int:
    if ext not in SOURCE_EXTS:
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
    ext = Path(str(record.get("path", ""))).suffix.lower()
    if _line_is_rejected(line, lower, ext):
        return -10_000
    return (
        base_score
        + _source_line_adjustment(line, lower, ext)
        + _table_line_adjustment(line)
        + _semantic_line_adjustment(line, lower)
        + _length_adjustment(line)
    )


def context_for(lines: list[str], target_index: int, radius: int = 2) -> str:
    start = max(0, target_index - radius)
    end = min(len(lines), target_index + radius + 1)
    return "\n".join(
        f"[{'TARGET' if index == target_index else 'CONTEXT'}] {lines[index]}"
        for index in range(start, end)
    )


def _heading_chain(lines: list[str], target_index: int) -> list[int]:
    stack: list[tuple[int, int]] = []
    for index in range(target_index + 1):
        level = _heading_level(lines[index])
        if level is None:
            continue
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, index))
    return [index for _, index in stack]


def _section_bounds(lines: list[str], target_index: int) -> tuple[int, int]:
    heading = _nearest_heading(lines, target_index)
    if heading is None:
        return max(0, target_index - 5), min(len(lines), target_index + 6)
    start, heading_line = heading
    level = _heading_level(heading_line) or 6
    end = len(lines)
    for index in range(start + 1, len(lines)):
        next_level = _heading_level(lines[index])
        if next_level is not None and next_level <= level:
            end = index
            break
    return start, end


def _document_intro_indices(lines: list[str]) -> list[int]:
    indices: list[int] = []
    seen_h2 = False
    for index, line in enumerate(lines[:30]):
        level = _heading_level(line)
        if level == 2:
            seen_h2 = True
        if seen_h2:
            break
        if line.strip():
            indices.append(index)
        if len(indices) >= 3:
            break
    return indices


def _target_terms(line: str) -> set[str]:
    return {
        token.lower()
        for token in re.findall(r"[A-Za-z0-9_/.-]+", line)
        if len(token.strip("/.-")) >= 4
    }


def _related_indices(lines: list[str], target_index: int, start: int, end: int) -> list[int]:
    target_terms = _target_terms(lines[target_index])
    scored: list[tuple[int, int]] = []
    for index in range(start, end):
        if index == target_index or not lines[index].strip():
            continue
        terms = _target_terms(lines[index])
        overlap = len(target_terms.intersection(terms))
        command_bonus = 2 if COMMAND_LINE_RE.search(lines[index]) and COMMAND_LINE_RE.search(lines[target_index]) else 0
        proximity = max(0, 4 - abs(index - target_index))
        scored.append((overlap * 4 + command_bonus + proximity, index))
    return [index for score, index in sorted(scored, key=lambda item: (-item[0], item[1])) if score > 0]


def _command_roots(line: str) -> set[str]:
    return {
        match.group(0).lower()
        for match in re.finditer(r"/[A-Za-z][A-Za-z0-9_-]*", line)
    }


def _global_related_indices(lines: list[str], target_index: int) -> list[int]:
    roots = _command_roots(lines[target_index])
    if not roots:
        return []
    matches = [
        index
        for index, line in enumerate(lines)
        if index != target_index and roots.intersection(_command_roots(line))
    ]
    expanded: list[int] = []
    for index in matches[:2]:
        expanded.extend(range(max(0, index - 2), min(len(lines), index + 5)))
    return expanded[:10]


def _priority_indices(lines: list[str], target_index: int) -> list[int]:
    section_start, section_end = _section_bounds(lines, target_index)
    chain = _heading_chain(lines, target_index)
    nearby = list(
        range(max(section_start, target_index - 4), min(section_end, target_index + 5))
    )
    related = _related_indices(lines, target_index, section_start, section_end)
    global_related = _global_related_indices(lines, target_index)
    return [
        target_index,
        *_document_intro_indices(lines),
        *chain,
        *global_related,
        *nearby,
        *related,
    ]


def _append_evidence_index(
    selected: list[int],
    record: dict,
    lines: list[str],
    index: int,
    target_visibility: str,
    char_total: int,
) -> int:
    if index in selected or not lines[index].strip():
        return char_total
    visibility = contextual_visibility(record, lines, index)
    if target_visibility == "public" and visibility != "public":
        return char_total
    projected = char_total + len(lines[index])
    if len(selected) >= MAX_EVIDENCE_LINES or projected > MAX_EVIDENCE_CHARS:
        return char_total
    selected.append(index)
    return projected


def _evidence_ranges(entries: list[dict]) -> list[dict]:
    numbers = [entry["line_number"] for entry in entries if isinstance(entry.get("line_number"), int)]
    if not numbers:
        return []
    ranges: list[dict] = []
    start = previous = numbers[0]
    for number in numbers[1:]:
        if number == previous + 1:
            previous = number
            continue
        ranges.append({"start_line": start, "end_line": previous})
        start = previous = number
    ranges.append({"start_line": start, "end_line": previous})
    return ranges


def build_evidence_window(
    record: dict,
    lines: list[str],
    target_index: int,
) -> tuple[list[dict], list[dict], str]:
    target_visibility = contextual_visibility(record, lines, target_index)
    selected: list[int] = []
    char_total = 0
    for index in _priority_indices(lines, target_index):
        char_total = _append_evidence_index(
            selected, record, lines, index, target_visibility, char_total
        )
    selected.sort()
    entries = [
        {
            "line_number": index + 1,
            "text": lines[index],
            "visibility": contextual_visibility(record, lines, index),
        }
        for index in selected
    ]
    evidence_text = "\n".join(f"L{entry['line_number']}: {entry['text']}" for entry in entries)
    return entries, _evidence_ranges(entries), evidence_text


def _boundary_candidate(line: str) -> bool:
    lower = line.lower()
    return bool(
        COMMAND_LINE_RE.search(line)
        or PERMISSION_NODE_LINE_RE.search(line)
        or any(term in lower for term in ("staff", "admin", "operator", "backend"))
    )


def response_mode_for(record: dict, lines: list[str], target_index: int) -> str | None:
    visibility = contextual_visibility(record, lines, target_index)
    if visibility == "public":
        return "player_support"
    return "player_boundary" if _boundary_candidate(lines[target_index]) else None


def _profiles_for(response_mode: str) -> tuple[str, ...]:
    return PUBLIC_PROFILES if response_mode == "player_support" else ("novice",)


def _profile_instruction(profile: str) -> str:
    if profile == "familiar":
        return "Assume the player has already demonstrated familiarity with this topic. Answer directly without reteaching basics."
    return (
        "Assume the player may be unfamiliar with this topic. If needed, add at most "
        "one short background sentence before the direct answer."
    )


def build_prompt(job: dict) -> str:
    categories = ", ".join(CATEGORIES)
    boundary = job["response_mode"] == "player_boundary"
    mode_instruction = (
        "This is a normal player asking about a staff/internal tool. Do not reveal staff "
        "command syntax, subcommands, permission nodes, backend details, or operational "
        "steps. Briefly state the boundary and invite them to explain their goal so a "
        "player-facing option can be suggested."
        if boundary else
        "Write a normal player-facing answer. Keep it clear, concise, friendly, and "
        "conversational. Do not expose permission nodes or backend jargon unless the "
        "player's question directly requires that information."
    )
    return f"""You are creating ONE source-grounded Enthusia support training candidate.

Use ONLY the bounded EVIDENCE below for factual claims. You may rewrite those facts into
natural language, but you may not strengthen, broaden, or invent them.

If the evidence is not useful enough for a safe support example, output exactly:
{{"skip":true,"reason":"not useful for support training"}}

Otherwise output exactly one JSON object with:
- category: one of [{categories}]
- scenario: at most 18 words
- user: a natural question, at most 30 words
- assistant: the final natural reply, 1-3 short sentences and at most 70 words
- tags: at most 4 short labels

Rules:
1. Question and answer must be completely supported by EVIDENCE.
2. {mode_instruction}
3. {_profile_instruction(job["familiarity_profile"])}
4. Do not mention private memory, account age, prior chats, or why explanation depth changed.
5. Do not claim GitHub/source code proves a feature is live. Preserve staging, retained,
   test, not-deployed, or "when deployed" qualifications exactly when relevant.
6. Do not invent ranks, commands, permissions, prices, numbers, mechanics, tool calls,
   or deployment status. In particular, do not add an Elite rank or general player /fly.
7. Do not output secrets, credentials, hidden reasoning, chain-of-thought, evidence IDs,
   source IDs, SHAs, visibility, or internal validator metadata.

REPOSITORY_ROLE: {job["role"]}
RESPONSE_MODE: {job["response_mode"]}
FAMILIARITY_PROFILE: {job["familiarity_profile"]}
PRODUCTION_AUTHORITY: {job["production_authority"]}
PATH: {job["path"]}

EVIDENCE:
<<<
{job["evidence_text"]}
>>>
"""


def _record_candidates(record: dict) -> list[tuple[int, dict, int, list[str]]]:
    base = path_score(record)
    if base <= 0:
        return []
    lines = [clean_candidate_line(line) for line in record.get("content", "").splitlines()]
    candidates = []
    for index, line in enumerate(lines):
        score = line_score(record, line, base)
        if score > 0 and response_mode_for(record, lines, index) is not None:
            candidates.append((score, record, index, lines))
    return candidates


def _candidate_sort_key(item: tuple[int, dict, int, list[str]]) -> tuple[int, str, str, int]:
    return (-item[0], item[1]["repository"], item[1]["path"], item[2])


def _load_candidates(input_path: str) -> list[tuple[int, dict, int, list[str]]]:
    candidates: list[tuple[int, dict, int, list[str]]] = []
    with gzip.open(input_path, "rt", encoding="utf-8") as fh:
        for raw in fh:
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
    evidence, ranges, evidence_text = build_evidence_window(record, lines, line_index)
    digest = hashlib.sha256(
        (
            f'{repo}\n{record["commit_sha"]}\n{record["path"]}\n'
            f'{line_index}\n{target_line}\n{profile}\n{response_mode}'
        ).encode("utf-8")
    ).hexdigest()[:16]
    source_id = (
        f'github:wsg138/{repo}@{record["commit_sha"]}:'
        f'{record["path"]}#line-{line_index + 1}'
    )
    job = {
        "job_id": f"ground-{digest}",
        "source_id": source_id,
        "source_version": record["commit_sha"],
        "repository": repo,
        "role": record.get("role"),
        "production_authority": record.get(
            "production_authority", "requires_deployment_verification"
        ),
        "visibility": contextual_visibility(record, lines, line_index),
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
    job["prompt"] = build_prompt(job)
    return job


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
    for score, record, line_index, lines in candidates:
        repo = record["repository"]
        if repo_counts[repo] >= per_repo_cap:
            continue
        for job in _jobs_for_candidate(score, record, line_index, lines):
            dedupe = (repo, job["target_line"], job["familiarity_profile"])
            if dedupe in seen_content or repo_counts[repo] >= per_repo_cap:
                continue
            seen_content.add(dedupe)
            jobs.append(job)
            repo_counts[repo] += 1
            source_files.add((repo, record["path"]))
            if len(jobs) >= max_jobs:
                return jobs, repo_counts, source_files
    return jobs, repo_counts, source_files


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
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--max-jobs", type=int, default=1200)
    ap.add_argument("--per-repo-cap", type=int, default=80)
    args = ap.parse_args()
    candidates = _load_candidates(args.input)
    jobs, repo_counts, source_files = _select_jobs(
        candidates, args.max_jobs, args.per_repo_cap
    )
    _write_jobs(args.output, jobs)
    manifest = _build_manifest(
        jobs, source_files, repo_counts, args.max_jobs, args.per_repo_cap
    )
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
