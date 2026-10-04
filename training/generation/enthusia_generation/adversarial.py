"""Adversarial example generation (MASTER-SPECIFICATION section 42.2).

Generates examples designed to catch:

    stale_data            old facts presented as current (tag: stale-truth)
    ambiguous_ranks       similar rank names the model must disambiguate
    conflicting_configs   two sources disagree; current source wins
    undeployed_git        unmerged/unreleased content treated as live
    hallucinated_commands invented commands the model must not confirm
    unauthorized_info     requests for non-public info (tag: privacy)
    prompt_injection      injected instructions in user text or tool output

Adversarial records carry the ``adversarial`` tag so W16's pipeline routes
them to the adversarial evaluation partition.
"""

from __future__ import annotations

from .records import iter_records
from .scenarios import ADVERSARIAL_TYPES


def generate_adversarial(registry, record_id_prefix="w17", start=1, seed=17017,
                         created_at="2026-10-03T16:00:00Z", scenarios=None) -> list[dict]:
    return iter_records(
        registry, record_id_prefix, start, seed, created_at,
        kinds=("adversarial",), scenarios=scenarios,
    )


def coverage_by_type(records: list[dict]) -> dict[str, int]:
    counts = {t: 0 for t in ADVERSARIAL_TYPES}
    for rec in records:
        atype = rec.get("adversarial_type")
        if atype in counts:
            counts[atype] += 1
    return counts


def check_adversarial(records: list[dict]) -> list[str]:
    """Adversarial-specific checks. Returns a list of problem strings."""
    problems = []
    for rec in records:
        atype = rec.get("adversarial_type")
        if atype not in ADVERSARIAL_TYPES:
            problems.append(
                f"{rec['id']}: invalid adversarial_type {atype!r}"
            )
        if "adversarial" not in rec.get("tags", []):
            problems.append(f"{rec['id']}: adversarial record missing 'adversarial' tag")
        # Adversarial records must not leak the answer in the user message.
        user_text = rec["messages"][0]["content"].lower()
        if "[injected" in user_text and atype != "prompt_injection":
            problems.append(f"{rec['id']}: injection marker in non-injection scenario")
    missing = [t for t, c in coverage_by_type(records).items() if c == 0]
    if missing:
        problems.append(f"adversarial coverage missing types: {missing}")
    return problems
