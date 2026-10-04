#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

GENERATOR = "qwen3.5-35b-a3b-q4_k_m-grounded-v1"

def convert(result: dict) -> dict | None:
    if result.get("request_error"):
        return None
    if result.get("validation_problems"):
        return None
    parsed = result.get("parsed")
    if not isinstance(parsed, dict) or parsed.get("skip") is True:
        return None

    expected_actions = parsed.get("expected_actions", [])
    tools = [
        action.removeprefix("tool:")
        for action in expected_actions
        if isinstance(action, str) and action.startswith("tool:")
    ]
    tags = list(dict.fromkeys([
        parsed.get("category", "unknown"),
        "grounded",
        "github-source",
        *[tag for tag in parsed.get("tags", []) if isinstance(tag, str)],
    ]))

    facts = []
    for fact in parsed.get("facts", []):
        facts.append({
            "claim": fact["claim"],
            "source": fact["source"],
            "source_version": fact["source_version"],
            "evidence": fact.get("evidence", ""),
        })

    job_id = result["job_id"]
    return {
        "id": f"synth-{job_id}",
        "source_type": "synthetic",
        "visibility": parsed["visibility"],
        "scenario": parsed["scenario"],
        "messages": [
            {"role": "user", "content": parsed["user"]},
            {"role": "assistant", "content": parsed["assistant"]},
        ],
        "tools": tools,
        "expected_actions": expected_actions,
        "expected_answer": parsed["assistant"],
        "facts": facts,
        "tags": tags,
        "quality": None,
        "template_id": f"grounded:{job_id}",
        "generator": GENERATOR,
        "source_repository": result.get("repository"),
        "source_path": result.get("path"),
        "source_id": result.get("source_id"),
        "source_version": result.get("source_version"),
        "generation_latency_seconds": result.get("latency_seconds"),
    }

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--manifest", required=True)
    args = ap.parse_args()

    records = []
    skipped = 0
    invalid = 0
    total = 0
    with open(args.input, encoding="utf-8") as fh:
        for line in fh:
            total += 1
            result = json.loads(line)
            if result.get("validation_problems") or result.get("request_error"):
                invalid += 1
                continue
            if result.get("parsed", {}).get("skip") is True:
                skipped += 1
                continue
            record = convert(result)
            if record is None:
                invalid += 1
                continue
            records.append(record)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

    manifest = {
        "schema_version": 1,
        "generator": GENERATOR,
        "input_results": total,
        "converted_records": len(records),
        "model_skips": skipped,
        "invalid_or_request_error": invalid,
        "status": "candidate_records_only",
        "note": (
            "These records passed deterministic JSON/evidence validation but are "
            "not a released training dataset until W16 normalization, secret scan, "
            "dedupe, split isolation, and quality review accept them."
        ),
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
