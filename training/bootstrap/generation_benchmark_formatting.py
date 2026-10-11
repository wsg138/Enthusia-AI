from __future__ import annotations

import re

PERMISSION_NODE_RE = re.compile(r"\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b")


def strip_code_fence(text: str) -> str:
    text = text.strip()
    fence = chr(96) * 3
    if text.startswith(fence):
        first_newline = text.find("\n")
        if first_newline >= 0:
            text = text[first_newline + 1:]
        if text.rstrip().endswith(fence):
            text = text.rstrip()[:-3]
    return text.strip()


def _split_markdown_table_row(text: str) -> list[str]:
    inner = text.strip().strip("|")
    cells = re.split(r"(?<!\\)\|", inner)
    cleaned: list[str] = []
    for cell in cells:
        value = (
            cell.strip()
            .replace("\\|", "|")
            .replace("**", "")
            .replace("__", "")
            .replace(chr(96), "")
        )
        if value and not re.fullmatch(r":?-{3,}:?", value):
            cleaned.append(value)
    return cleaned


def _render_command_table(cells: list[str]) -> str:
    command = cells[0]
    rest = list(cells[1:])
    permission = next((cell for cell in rest if PERMISSION_NODE_RE.fullmatch(cell)), None)
    if permission is not None:
        rest.remove(permission)
    rendered = command
    if rest:
        rendered += f": {rest.pop(0)}"
    if permission:
        rendered += f" Permission: {permission}"
    for extra in rest:
        rendered += f" {'Example' if extra.startswith('/') else 'Details'}: {extra}"
    return rendered.strip()


def _render_markdown_table(text: str) -> str | None:
    if not (text.startswith("|") and text.endswith("|")):
        return None
    cells = _split_markdown_table_row(text)
    if len(cells) >= 2 and cells[0].startswith("/"):
        return _render_command_table(cells)
    if len(cells) == 2:
        return f"{cells[0]}: {cells[1]}"
    return "; ".join(cells) if cells else ""


def _clean_plain_display(text: str) -> str:
    text = re.sub(r"^#{1,6}\s+", "", text)
    text = re.sub(r"^[-*+]\s+", "", text)
    text = re.sub(r"^\d+[.)]\s+", "", text)
    text = text.replace("**", "").replace("__", "").replace(chr(96), "")
    command_comment = re.fullmatch(r"(/[^#]+?)\s+#\s+(.+)", text)
    if command_comment:
        return f"{command_comment.group(1).strip()}: {command_comment.group(2).strip()}"
    if text.lower().startswith("usage:"):
        value = re.sub(r"&[0-9A-FK-ORa-fk-or]", "", text[6:].strip().strip('"').strip("'"))
        if value.lower().startswith("usage:"):
            value = value[6:].strip()
        return f"Usage: {value}"
    if text.lower().startswith("aliases:"):
        return "Aliases:" + text[8:]
    return text.strip()


def _clean_display_line(line: str) -> str:
    text = line.strip()
    table = _render_markdown_table(text)
    return table if table is not None else _clean_plain_display(text)
