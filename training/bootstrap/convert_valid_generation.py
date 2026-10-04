#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--generator", required=True)
    ap.add_argument("--created-at", default="2026-10-04T00:00:00Z")
    args = ap.parse_args()

    records = []
    seen_ids = set()
    with open(args.results, encoding="utf-8") as fh:
        for line in fh:
            result = json.loads(line)
            if result.get("request_error"):
                continue
            if result.get("validation_problems"):
                continue
            parsed = result.get("parsed")
            if not isinstance(parsed, dict) or parsed.get("skip") is True:
                continue

            rid = "sourcegen-" + hashlib.sha256(
                result["job_id"].encode("utf-8")
            ).hexdigest()[:20]
            if rid in seen_ids:
                continue
            seen_ids.add(rid)

            expected_actions = parsed.get("expected_actions", [])
            tools = [
                action.split(":", 1)[1]
                for action in expected_actions
                if isinstance(action, str) and action.startswith("tool:")
            ]
            facts = []
            for fact in parsed.get("facts", []):
                facts.append({
                    "claim": fact["claim"],
                    "source": fact["source"],
                    "source_version": fact["source_version"],
                    "evidence": fact.get("evidence", ""),
                })

            records.append({
                "id": rid,
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
                "tags": list(dict.fromkeys([
                    "source-grounded",
                    parsed["category"],
                    *parsed.get("tags", []),
                ])),
                "quality": "GOOD",
                "created_at": args.created_at,
                "template_id": result["job_id"],
                "generator": args.generator,
                "source_repository": result.get("repository"),
                "source_path": result.get("path"),
            })

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as out:
        for record in records:
            out.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

    print(json.dumps({
        "records_written": len(records),
        "output": str(output),
        "quality": "GOOD",
        "note": "Candidates still require W16/W20 validation before training.",
    }, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
