"""Source-grounded Q&A generation (spec sections 5, 42.1).

Renders kind="qa" scenarios: for each feature/system, the scenario library
provides a base FAQ plus explicit variants (advanced, wrong_assumption,
missing_evidence, conflicting_evidence, historical, staff_only, escalation),
while typo/new_player forms are rendered algorithmically.
"""

from __future__ import annotations

from .records import iter_records


def generate_qa(registry, record_id_prefix="w17", start=1, seed=17017,
                created_at="2026-10-03T16:00:00Z", scenarios=None) -> list[dict]:
    return iter_records(
        registry, record_id_prefix, start, seed, created_at,
        kinds=("qa",), scenarios=scenarios,
    )


def check_qa(records: list[dict]) -> list[str]:
    """Q&A-specific structural checks. Returns a list of problem strings."""
    problems = []
    for rec in records:
        roles = [m["role"] for m in rec["messages"]]
        if any(r == "tool" for r in roles):
            problems.append(f"{rec['id']}: qa record must not contain tool messages")
        if len(rec["messages"]) != 2:
            problems.append(
                f"{rec['id']}: qa record must have exactly 2 messages, got {len(roles)}"
            )
        if rec["messages"][0]["role"] != "user" or rec["messages"][-1]["role"] != "assistant":
            problems.append(f"{rec['id']}: qa messages must be user then assistant")
    return problems
