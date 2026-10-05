from __future__ import annotations

import re
from pathlib import Path

MAX_EVIDENCE_LINES = 12
MAX_EVIDENCE_CHARS = 2400

CONFIG_EXTS = {
    ".yml", ".yaml", ".json", ".toml", ".properties", ".ini", ".cfg", ".xml",
}
SOURCE_EXTS = {
    ".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py",
}
STAFF_SOURCE_ROLES = {
    "staff_system",
    "infrastructure",
    "infrastructure_docs",
    "network_configuration",
    "staging_reference",
    "moderation_system",
    "ai_system",
    "infrastructure_test",
    "support_system",
}
STAFF_PATH_TOKENS = (
    "/src/", "/internal/", "/config/", "config.", "config-", "/audit",
    "/admins/", "/admin/",
)
STAFF_LINE_TOKENS = (
    "/punish", "/ban ", "/ban<", "/mute ", "/mute<", "/kick ",
    "blacklist", "administrator", "admin permission", ".admin",
    "staff-only", "staff only",
)
COMMAND_LINE_RE = re.compile(r"(^|\s)/[A-Za-z][A-Za-z0-9_-]*")
STAFF_RELOAD_RE = re.compile(r"(?:^|\s)/\S+\s+reload\b")
STAFF_GENERIC_TERM_RE = re.compile(
    r"\b(?:reload|debug|admin|adminview|breakothers|freeze|unfreeze)\b"
)
STAFF_COMMAND_ROOT_RE = re.compile(
    r"(?:^|\s)/(?:ee|estaff|startupguardian|gatekeeper|tppos|warzone|"
    r"shopmarket|ekoth)\b"
)
STAFF_PEARL_RE = re.compile(r"(?:^|\s)/pearlglitchblocker\b")
STAFF_WARZONE_MODIFIER_RE = re.compile(r"(?:^|\s)/warzone\s+modifier\b")
STAFF_HEADING_RE = re.compile(
    r"(?i)\b(?:admin|administrative|staff|operator|internal|backend|moderation|"
    r"developer|recovery|maintenance)\b"
)


def _path_is_staff(path: str) -> bool:
    lower = path.lower()
    extension = Path(path).suffix.lower()
    name = Path(path).name.lower()
    if extension in SOURCE_EXTS:
        return True
    if extension in CONFIG_EXTS and name not in {"plugin.yml", "paper-plugin.yml"}:
        return True
    return any(token in lower for token in STAFF_PATH_TOKENS)


def _staff_pattern_matches(lower: str) -> bool:
    patterns = (
        STAFF_RELOAD_RE,
        STAFF_COMMAND_ROOT_RE,
        STAFF_PEARL_RE,
        STAFF_WARZONE_MODIFIER_RE,
    )
    return any(pattern.search(lower) for pattern in patterns)


def _line_is_staff(line: str) -> bool:
    lower = line.lower()
    if any(token in lower for token in STAFF_LINE_TOKENS):
        return True
    if STAFF_GENERIC_TERM_RE.search(lower) and COMMAND_LINE_RE.search(line):
        return True
    return _staff_pattern_matches(lower)


def source_visibility(record: dict, line: str = "") -> str:
    if record.get("role") in STAFF_SOURCE_ROLES:
        return "staff"
    path = str(record.get("path", "")).replace("\\", "/")
    return "staff" if _path_is_staff(path) or _line_is_staff(line) else "public"


def _heading_level(line: str) -> int | None:
    match = re.match(r"^(#{1,6})\s+", line.strip())
    return len(match.group(1)) if match else None


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


def contextual_visibility(record: dict, lines: list[str], index: int) -> str:
    if source_visibility(record, lines[index]) == "staff":
        return "staff"
    headings = _heading_chain(lines, index)
    if any(STAFF_HEADING_RE.search(lines[heading]) for heading in headings):
        return "staff"
    return "public"


def context_for(lines: list[str], target_index: int, radius: int = 2) -> str:
    start = max(0, target_index - radius)
    end = min(len(lines), target_index + radius + 1)
    rendered = []
    for index in range(start, end):
        marker = "TARGET" if index == target_index else "CONTEXT"
        rendered.append(f"[{marker}] {lines[index]}")
    return "\n".join(rendered)


def _nearest_heading(lines: list[str], index: int) -> tuple[int, str] | None:
    chain = _heading_chain(lines, index)
    if not chain:
        return None
    heading_index = chain[-1]
    return heading_index, lines[heading_index]


def _section_bounds(lines: list[str], target_index: int) -> tuple[int, int]:
    heading = _nearest_heading(lines, target_index)
    if heading is None:
        return max(0, target_index - 5), min(len(lines), target_index + 6)
    start, heading_line = heading
    level = _heading_level(heading_line) or 6
    end = _section_end(lines, start, level)
    return start, end


def _section_end(lines: list[str], start: int, level: int) -> int:
    for index in range(start + 1, len(lines)):
        next_level = _heading_level(lines[index])
        if next_level is not None and next_level <= level:
            return index
    return len(lines)


def _document_intro_indices(lines: list[str]) -> list[int]:
    indices: list[int] = []
    for index, line in enumerate(lines[:30]):
        if _heading_level(line) == 2:
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


def _related_score(
    lines: list[str],
    target_index: int,
    candidate_index: int,
    target_terms: set[str],
) -> int:
    candidate = lines[candidate_index]
    overlap = len(target_terms.intersection(_target_terms(candidate)))
    both_commands = (
        COMMAND_LINE_RE.search(candidate) is not None
        and COMMAND_LINE_RE.search(lines[target_index]) is not None
    )
    proximity = max(0, 4 - abs(candidate_index - target_index))
    return overlap * 4 + 2 * int(both_commands) + proximity


def _related_indices(
    lines: list[str],
    target_index: int,
    start: int,
    end: int,
) -> list[int]:
    target_terms = _target_terms(lines[target_index])
    scored = [
        (_related_score(lines, target_index, index, target_terms), index)
        for index in range(start, end)
        if index != target_index and lines[index].strip()
    ]
    ranked = sorted(scored, key=lambda item: (-item[0], item[1]))
    return [index for score, index in ranked if score > 0]


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
    nearby = range(
        max(section_start, target_index - 4),
        min(section_end, target_index + 5),
    )
    return [
        target_index,
        *_document_intro_indices(lines),
        *_heading_chain(lines, target_index),
        *_global_related_indices(lines, target_index),
        *nearby,
        *_related_indices(lines, target_index, section_start, section_end),
    ]


def _can_append(
    selected: list[int],
    lines: list[str],
    index: int,
    char_total: int,
) -> bool:
    if index in selected or not lines[index].strip():
        return False
    if len(selected) >= MAX_EVIDENCE_LINES:
        return False
    rendered_length = len(f"L{index + 1}: {lines[index]}")
    return char_total + rendered_length + int(bool(selected)) <= MAX_EVIDENCE_CHARS


def _append_evidence_index(
    selected: list[int],
    record: dict,
    lines: list[str],
    index: int,
    target_visibility: str,
    char_total: int,
) -> int:
    if not _can_append(selected, lines, index, char_total):
        return char_total
    visibility = contextual_visibility(record, lines, index)
    if target_visibility == "public" and visibility != "public":
        return char_total
    selected.append(index)
    return char_total + len(f"L{index + 1}: {lines[index]}") + int(len(selected) > 1)


def _evidence_ranges(entries: list[dict]) -> list[dict]:
    numbers = [
        entry["line_number"]
        for entry in entries
        if isinstance(entry.get("line_number"), int)
    ]
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
            selected,
            record,
            lines,
            index,
            target_visibility,
            char_total,
        )
    entries = _render_entries(record, lines, selected)
    evidence_text = "\n".join(
        f"L{entry['line_number']}: {entry['text']}" for entry in entries
    )
    return entries, _evidence_ranges(entries), evidence_text


def _render_entries(
    record: dict,
    lines: list[str],
    selected: list[int],
) -> list[dict]:
    return [
        {
            "line_number": index + 1,
            "text": lines[index],
            "visibility": contextual_visibility(record, lines, index),
        }
        for index in sorted(selected)
    ]