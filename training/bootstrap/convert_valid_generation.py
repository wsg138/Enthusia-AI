#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

def _eligible_parsed(result: dict) -> dict | None:
    if result.get("request_error") or result.get("validation_problems"):
        return None
    parsed = result.get("parsed")
    if not isinstance(parsed, dict) or parsed.get("skip") is True:
        return None
    return parsed


def _facts(parsed: dict) -> list[dict]:
    return [
        {
            "claim": fact["claim"],
            "source": fact["source"],
            "source_version": fact["source_version"],
            "evidence": fact.get("evidence", ""),
        }
        for fact in parsed.get("facts", [])
    ]


def _tools_from_actions(expected_actions: list[object]) -> list[str]:
    return [
        action.split(":", 1)[1]
        for action in expected_actions
        if isinstance(action, str) and action.startswith("tool:")
    ]


def _candidate_record(
    result: dict,
    parsed: dict,
    generator: str,
    created_at: str,
) -> dict:
    record_id = "sourcegen-" + hashlib.sha256(
        result["job_id"].encode("utf-8")
    ).hexdigest()[:20]
    expected_actions = parsed.get("expected_actions", [])
    return {
        "id": record_id,
        "source_type": "synthetic",
        "visibility": parsed["visibility"],
        "scenario": parsed["scenario"],
        "messages": [
            {"role": "user", "content": parsed["user"]},
            {"role": "assistant", "content": parsed["assistant"]},
        ],
        "tools": _tools_from_actions(expected_actions),
        "expected_actions": expected_actions,
        "expected_answer": parsed["assistant"],
        "facts": _facts(parsed),
        "tags": list(
            dict.fromkeys(
                [
                    "source-grounded",
                    parsed["category"],
                    *parsed.get("tags", []),
                ]
            )
        ),
        "quality": "GOOD",
        "created_at": created_at,
        "template_id": result["job_id"],
        "generator": generator,
        "source_repository": result.get("repository"),
        "source_path": result.get("path"),
    }


def _load_records(results_path: str, generator: str, created_at: str) -> list[dict]:
    records: list[dict] = []
    seen_ids: set[str] = set()
    with open(results_path, encoding="utf-8") as fh:
        for line in fh:
            result = json.loads(line)
            parsed = _eligible_parsed(result)
            if parsed is None:
                continue
            record = _candidate_record(result, parsed, generator, created_at)
            if record["id"] in seen_ids:
                continue
            seen_ids.add(record["id"])
            records.append(record)
    return records


def _write_records(output_path: str, records: list[dict]) -> Path:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as out:
        for record in records:
            out.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    return output


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--generator", required=True)
    ap.add_argument("--created-at", default="2026-10-04T00:00:00Z")
    args = ap.parse_args()

    records = _load_records(args.results, args.generator, args.created_at)
    output = _write_records(args.output, records)
    print(
        json.dumps(
            {
                "records_written": len(records),
                "output": str(output),
                "quality": "GOOD",
                "note": "Candidates still require W16/W20 validation before training.",
            },
            indent=2,
        )
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
