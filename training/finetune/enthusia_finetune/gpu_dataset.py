"""Convert canonical W16 records into completion-only SFT examples."""

from __future__ import annotations

import json
from dataclasses import dataclass


class GpuDatasetError(ValueError):
    """Raised when an assembled W16 record is not safe to feed to SFT."""


@dataclass(frozen=True)
class PreparedExample:
    record_id: str
    prompt: list[dict[str, str]]
    completion: list[dict[str, str]]


def prepare_record(raw: dict) -> PreparedExample:
    rid = raw.get("id")
    if not isinstance(rid, str) or not rid.strip():
        raise GpuDatasetError("record is missing a non-empty id")

    messages = raw.get("messages")
    if not isinstance(messages, list) or len(messages) < 2:
        raise GpuDatasetError(f"record {rid!r} needs at least two messages")

    normalized: list[dict[str, str]] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise GpuDatasetError(f"record {rid!r} message {index} is not an object")
        role = message.get("role")
        content = message.get("content")
        if role not in {"system", "user", "assistant", "tool"}:
            raise GpuDatasetError(f"record {rid!r} has unsupported role {role!r}")
        if not isinstance(content, str) or not content.strip():
            raise GpuDatasetError(f"record {rid!r} message {index} has empty content")
        normalized.append({"role": role, "content": content.strip()})

    if normalized[-1]["role"] != "assistant":
        raise GpuDatasetError(
            f"record {rid!r} must end with the assistant answer being supervised"
        )
    if not any(message["role"] == "user" for message in normalized[:-1]):
        raise GpuDatasetError(f"record {rid!r} has no user turn before the answer")

    expected_answer = raw.get("expected_answer")
    if isinstance(expected_answer, str) and expected_answer.strip():
        if expected_answer.strip() != normalized[-1]["content"]:
            raise GpuDatasetError(
                f"record {rid!r} expected_answer differs from final assistant content"
            )

    return PreparedExample(
        record_id=rid,
        prompt=normalized[:-1],
        completion=[normalized[-1]],
    )


def load_prompt_completion_jsonl(path: str) -> tuple[list[dict], list[dict]]:
    examples: list[dict] = []
    rejected: list[dict] = []
    seen: set[str] = set()

    with open(path, encoding="utf-8") as fh:
        for line_number, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
                if not isinstance(raw, dict):
                    raise GpuDatasetError("row must be a JSON object")
                example = prepare_record(raw)
                if example.record_id in seen:
                    raise GpuDatasetError(
                        f"duplicate record id {example.record_id!r} in assembled split"
                    )
                seen.add(example.record_id)
                examples.append(
                    {
                        "prompt": example.prompt,
                        "completion": example.completion,
                        "record_id": example.record_id,
                    }
                )
            except (json.JSONDecodeError, GpuDatasetError) as exc:
                rejected.append({"line": line_number, "reason": str(exc)})

    if rejected:
        raise GpuDatasetError(
            f"{path} contains {len(rejected)} training-shape rejection(s); "
            f"first: line {rejected[0]['line']}: {rejected[0]['reason']}"
        )
    if not examples:
        raise GpuDatasetError(f"{path} produced no training examples")
    return examples, rejected
