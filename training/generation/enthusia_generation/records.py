"""Record construction: render (scenario, form) pairs into W16 records.

Shared by qa.py, traces.py, and adversarial.py. Deterministic: all randomness
flows through the caller-supplied ``random.Random`` instance.
"""

from __future__ import annotations

import json
import random

from . import variations
from .fixtures import FixtureRegistry
from .scenarios import get_scenarios

GENERATOR_NAME = "enthusia-generation-v0.1.0"


def _resolve_form_content(scenario: dict, form: str, rng: random.Random) -> dict:
    """Return the {user, assistant, ...} content for a (scenario, form) pair."""
    forms = scenario.get("forms", ["faq"])
    if form not in forms:
        raise ValueError(
            f"scenario {scenario['template_id']!r} does not define form {form!r}"
        )
    base = {
        "user": scenario["user"],
        "assistant": scenario["assistant"],
        "fact_refs": scenario.get("fact_refs", []),
        "expected_actions": scenario.get("expected_actions", []),
        "tags": list(scenario.get("tags", [])),
        "visibility": scenario.get("visibility", "public"),
        "tools": list(scenario.get("tools", [])),
        "tool_flow": list(scenario.get("tool_flow", [])),
        "final_answer": scenario.get("final_answer"),
    }
    if form == forms[0]:
        return base
    if form in variations.ALGORITHMIC_FORMS:
        content = dict(base)
        content["user"] = variations.render_user_message(form, scenario["user"], rng)
        return content
    variant = scenario.get("variants", {}).get(form)
    if variant is None:
        raise ValueError(
            f"scenario {scenario['template_id']!r}: form {form!r} needs an explicit variant"
        )
    content = dict(base)
    for key in ("user", "assistant", "fact_refs", "expected_actions", "tags",
                "visibility", "tools", "tool_flow", "final_answer"):
        if key in variant:
            content[key] = variant[key]
    return content


def _tool_message(entry: dict) -> dict:
    payload = {"tool": entry["tool"]}
    if "error" in entry:
        payload["error"] = entry["error"]
    else:
        payload["result"] = entry["result"]
    return {"role": "tool", "content": json.dumps(payload)}


def build_record(
    registry: FixtureRegistry,
    scenario: dict,
    form: str,
    record_id: str,
    rng: random.Random,
    created_at: str,
) -> dict:
    """Render one W16 record for a (scenario, form) pair."""
    content = _resolve_form_content(scenario, form, rng)
    facts = registry.facts(content["fact_refs"])

    has_tools = bool(content["tool_flow"])
    if has_tools:
        if not content["final_answer"]:
            raise ValueError(
                f"scenario {scenario['template_id']!r}: tool flow requires final_answer"
            )
        messages = [
            {"role": "user", "content": content["user"]},
            {"role": "assistant", "content": content["assistant"]},
            *(_tool_message(e) for e in content["tool_flow"]),
            {"role": "assistant", "content": content["final_answer"]},
        ]
        expected_answer = content["final_answer"]
    else:
        messages = [
            {"role": "user", "content": content["user"]},
            {"role": "assistant", "content": content["assistant"]},
        ]
        expected_answer = content["assistant"]

    tags = [scenario["category"], variations.FORM_TAGS[form], *content["tags"]]
    # de-dupe tags, preserve order
    tags = list(dict.fromkeys(tags))

    return {
        "id": record_id,
        "source_type": "synthetic",
        "visibility": content["visibility"],
        "scenario": scenario["scenario"],
        "template_id": scenario["template_id"],
        "generator": GENERATOR_NAME,
        "messages": messages,
        "tools": content["tools"],
        "expected_actions": content["expected_actions"],
        "expected_answer": expected_answer,
        "facts": facts,
        "tags": tags,
        "quality": scenario.get("quality"),
        "created_at": created_at,
        "adversarial_type": scenario.get("adversarial_type"),
        "variation_form": form,
    }


def iter_records(
    registry: FixtureRegistry,
    record_id_prefix: str,
    start: int,
    seed: int,
    created_at: str,
    kinds: tuple[str, ...] | None = None,
    scenarios: list[dict] | None = None,
) -> list[dict]:
    """Render every defined (scenario, form) pair, deterministically.

    Records are emitted in scenario-definition order; forms in listed order.
    """
    rng = random.Random(seed)
    out: list[dict] = []
    n = start
    for scenario in scenarios if scenarios is not None else get_scenarios():
        if kinds is not None and scenario.get("kind", "qa") not in kinds:
            continue
        for form in scenario.get("forms", ["faq"]):
            record_id = f"{record_id_prefix}-{n:04d}"
            out.append(build_record(registry, scenario, form, record_id, rng, created_at))
            n += 1
    return out
