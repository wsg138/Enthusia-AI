"""Tests for the scenario template library."""

import pytest

from enthusia_generation import scenarios
from enthusia_generation.fixtures import FixtureRegistry
from enthusia_generation.scenarios import ADVERSARIAL_TYPES, CATEGORIES, get_scenarios
from enthusia_generation.variations import ALGORITHMIC_FORMS, FORMS


@pytest.fixture(scope="module")
def registry():
    return FixtureRegistry.load()


def test_template_ids_unique():
    ids = [s["template_id"] for s in get_scenarios()]
    assert len(ids) == len(set(ids)) > 40


def test_categories_valid_and_complete():
    cats = {s["category"] for s in get_scenarios()}
    assert cats == set(CATEGORIES), f"missing: {set(CATEGORIES) - cats}"


def test_kinds_and_adversarial_types_valid():
    for s in get_scenarios():
        assert s.get("kind", "qa") in ("qa", "trace", "adversarial"), s["template_id"]
        atype = s.get("adversarial_type")
        if s.get("kind") == "adversarial":
            assert atype in ADVERSARIAL_TYPES, s["template_id"]
        else:
            assert atype is None, s["template_id"]


def test_forms_valid_and_variants_defined():
    for s in get_scenarios():
        forms = s.get("forms", ["faq"])
        assert forms, s["template_id"]
        for form in forms:
            assert form in FORMS, (s["template_id"], form)
        for form in forms[1:]:
            if form not in ALGORITHMIC_FORMS:
                assert form in s.get("variants", {}), (s["template_id"], form)


def test_fact_refs_resolve(registry):
    for s in get_scenarios():
        for sid, idx in s.get("fact_refs", []):
            registry.claim(sid, idx)  # raises on bad ref
        for form, variant in s.get("variants", {}).items():
            for sid, idx in variant.get("fact_refs", []):
                registry.claim(sid, idx)


def test_trace_scenarios_have_flows():
    traces = [s for s in get_scenarios() if s.get("kind") == "trace"]
    assert len(traces) >= 4
    for s in traces:
        assert s.get("tool_flow"), s["template_id"]
        assert s.get("final_answer"), s["template_id"]
        flow_tools = [e["tool"] for e in s["tool_flow"]]
        for t in flow_tools:
            assert t in s.get("tools", []), (s["template_id"], t)


def test_visibility_values_valid():
    for s in get_scenarios():
        assert s.get("visibility", "public") in ("public", "staff", "private", "owner")


def test_no_secret_shaped_strings():
    """Scenario content must never contain credential-shaped strings."""
    import json
    import re
    for s in get_scenarios():
        blob = json.dumps(s)
        assert not re.search(r"\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b", blob), s["template_id"]
        assert not re.search(r"\bgh[pou]_[A-Za-z0-9]{20,}\b", blob), s["template_id"]
        assert "BEGIN PRIVATE KEY" not in blob, s["template_id"]
