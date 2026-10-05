#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

GENERATOR = "qwen3.5-35b-a3b-q4_k_m-bounded-grounding-v3"
KNOWLEDGE_TOOL = "knowledge.search"


def _facts(parsed: dict) -> list[dict]:
    facts: list[dict] = []
    for fact in parsed.get("facts", []):
        converted = {
            "claim": fact["claim"],
            "source": fact["source"],
            "source_version": fact["source_version"],
            "evidence": fact.get("evidence", ""),
        }
        if fact.get("line_number") is not None:
            converted["line_number"] = fact["line_number"]
        facts.append(converted)
    return facts


def _tags(parsed: dict) -> list[str]:
    profile = parsed.get("familiarity_profile")
    response_mode = parsed.get("response_mode")
    values = [
        parsed.get("category", "unknown"),
        "grounded",
        "bounded-evidence",
        "github-source",
        response_mode,
        f"familiarity:{profile}" if profile else None,
        *parsed.get("tags", []),
    ]
    return list(dict.fromkeys(value for value in values if isinstance(value, str)))


def _source_result(result: dict) -> dict:
    return {
        "source": result.get("source_id"),
        "source_version": result.get("source_version"),
        "repository": result.get("repository"),
        "path": result.get("path"),
        "target_line_number": result.get("line_number"),
        "target_line": result.get("target_line"),
        "evidence": result.get("evidence", []),
        "evidence_ranges": result.get("evidence_ranges", []),
        "production_authority": result.get("production_authority"),
        "visibility": result.get("visibility"),
    }


def _tool_message(result: dict) -> dict:
    return {
        "role": "tool",
        "content": json.dumps(
            {"tool": KNOWLEDGE_TOOL, "result": _source_result(result)},
            ensure_ascii=False,
            sort_keys=True,
        ),
    }


def convert(result: dict) -> dict | None:
    if result.get("request_error") or result.get("validation_problems"):
        return None
    parsed = result.get("parsed")
    if not isinstance(parsed, dict) or parsed.get("skip") is True:
        return None
    facts = _facts(parsed)
    if not facts:
        return None
    job_id = result["job_id"]
    return {
        "id": f"synth-{job_id}",
        "source_type": "synthetic",
        "visibility": parsed["visibility"],
        "scenario": parsed["scenario"],
        "messages": [
            {"role": "user", "content": parsed["user"]},
            {
                "role": "assistant",
                "content": "I'll verify that against the current indexed source.",
            },
            _tool_message(result),
            {"role": "assistant", "content": parsed["assistant"]},
        ],
        "tools": [KNOWLEDGE_TOOL],
        "expected_actions": [f"tool:{KNOWLEDGE_TOOL}"],
        "expected_answer": parsed["assistant"],
        "facts": facts,
        "tags": _tags(parsed),
        "quality": None,
        "template_id": f"grounded:{job_id}",
        "generator": GENERATOR,
        "source_repository": result.get("repository"),
        "source_path": result.get("path"),
        "source_id": result.get("source_id"),
        "source_version": result.get("source_version"),
        "evidence_ranges": result.get("evidence_ranges", []),
        "familiarity_profile": parsed.get("familiarity_profile"),
        "response_mode": parsed.get("response_mode"),
        "production_authority": result.get("production_authority"),
        "generation_latency_seconds": result.get("latency_seconds"),
        "admission_status": "owner_review_required",
    }


def _load_converted(input_path: str) -> tuple[list[dict], int, int, int]:
    records: list[dict] = []
    skipped = invalid = total = 0
    with open(input_path, encoding="utf-8") as handle:
        for line in handle:
            total += 1
            result = json.loads(line)
            if result.get("validation_problems") or result.get("request_error"):
                invalid += 1
                continue
            parsed = result.get("parsed")
            if isinstance(parsed, dict) and parsed.get("skip") is True:
                skipped += 1
                continue
            record = convert(result)
            if record is None:
                invalid += 1
                continue
            records.append(record)
    return records, skipped, invalid, total


def _write_records(output_path: str, records: list[dict]) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _manifest(total: int, records: list[dict], skipped: int, invalid: int) -> dict:
    return {
        "schema_version": 2,
        "generator": GENERATOR,
        "input_results": total,
        "converted_records": len(records),
        "model_skips": skipped,
        "invalid_or_request_error": invalid,
        "status": "candidate_records_only_owner_review_required",
        "note": (
            "These bounded-evidence candidates are not admitted to W16 or training. "
            "Owner review, W16 normalization, secret scan, dedupe, split isolation, "
            "and downstream quality gates remain required."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()
    records, skipped, invalid, total = _load_converted(args.input)
    _write_records(args.output, records)
    manifest = _manifest(total, records, skipped, invalid)
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
