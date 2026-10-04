"""Tests for variation forms and the record generators."""

import random

import pytest

from enthusia_generation import adversarial, qa, records, traces, variations
from enthusia_generation.fixtures import FixtureRegistry
from enthusia_generation.records import GENERATOR_NAME, build_record, iter_records
from enthusia_generation.scenarios import get_scenarios


@pytest.fixture(scope="module")
def registry():
    return FixtureRegistry.load()


# --- variations ------------------------------------------------------------

def test_typo_transform_is_deterministic():
    rng1, rng2 = random.Random(42), random.Random(42)
    text = "how do i teleport to my friend quickly"
    assert variations.typo_transform(text, rng1) == variations.typo_transform(text, rng2)


def test_typo_transform_changes_text_but_keeps_words():
    rng = random.Random(7)
    text = "how do i teleport to my friend quickly"
    out = variations.typo_transform(text, rng, rate=0.5)
    assert out != text
    assert len(out.split()) == len(text.split())


def test_new_player_transform_wraps():
    rng = random.Random(3)
    out = variations.new_player_transform("How do I join?", rng)
    assert out.lower().startswith(tuple(o.strip() for o in variations.NEW_PLAYER_OPENERS))
    assert "how do i join?" in out.lower()


def test_render_user_message_rejects_explicit_forms():
    with pytest.raises(ValueError):
        variations.render_user_message("advanced", "hi", random.Random(0))


# --- record rendering ------------------------------------------------------

def _first_qa_scenario():
    return next(s for s in get_scenarios() if s.get("kind", "qa") == "qa")


def test_build_record_w16_fields(registry):
    s = _first_qa_scenario()
    rec = build_record(registry, s, s["forms"][0], "w17-0001", random.Random(1),
                       "2026-10-03T16:00:00Z")
    for field in ("id", "source_type", "visibility", "scenario", "messages",
                  "tools", "expected_actions", "expected_answer", "facts",
                  "tags", "created_at"):
        assert field in rec, field
    assert rec["source_type"] == "synthetic"
    assert rec["template_id"] == s["template_id"]
    assert rec["generator"] == GENERATOR_NAME
    assert rec["messages"][0]["role"] == "user"
    assert rec["messages"][-1]["role"] == "assistant"


def test_iter_records_is_deterministic(registry):
    a = iter_records(registry, "w17", 1, 17017, "2026-10-03T16:00:00Z")
    b = iter_records(registry, "w17", 1, 17017, "2026-10-03T16:00:00Z")
    assert a == b
    c = iter_records(registry, "w17", 1, 999, "2026-10-03T16:00:00Z")
    assert [r["id"] for r in a] == [r["id"] for r in c]  # ids don't depend on seed
    assert a != c  # but typo/new_player wording does


def test_record_ids_unique_and_sequential(registry):
    recs = iter_records(registry, "w17", 1, 17017, "2026-10-03T16:00:00Z")
    ids = [r["id"] for r in recs]
    assert len(ids) == len(set(ids))
    assert ids == [f"w17-{i:04d}" for i in range(1, len(ids) + 1)]
    assert len(recs) >= 100


def test_trace_record_shape(registry):
    s = next(x for x in get_scenarios() if x.get("kind") == "trace")
    rec = build_record(registry, s, s["forms"][0], "w17-0001", random.Random(1),
                       "2026-10-03T16:00:00Z")
    roles = [m["role"] for m in rec["messages"]]
    assert roles[0] == "user" and "tool" in roles and roles[-1] == "assistant"
    assert rec["tools"]
    assert rec["expected_answer"]  # final answer, not the ack


def test_kind_generators_partition_scenarios(registry):
    q = qa.generate_qa(registry)
    t = traces.generate_traces(registry)
    a = adversarial.generate_adversarial(registry)
    assert q and t and a
    assert len(q) + len(t) + len(a) == len(
        iter_records(registry, "w17", 1, 17017, "2026-10-03T16:00:00Z"))


def test_structural_checks_clean(registry):
    recs = {r["id"]: r for r in iter_records(registry, "w17", 1, 17017, "2026-10-03T16:00:00Z")}
    by_kind = {"qa": [], "trace": [], "adversarial": []}
    for r in recs.values():
        if "adversarial" in r["tags"]:
            by_kind["adversarial"].append(r)
        elif any(m["role"] == "tool" for m in r["messages"]):
            by_kind["trace"].append(r)
        else:
            by_kind["qa"].append(r)
    assert not qa.check_qa(by_kind["qa"])
    assert not traces.check_traces(by_kind["trace"])
    assert not adversarial.check_adversarial(by_kind["adversarial"])


def test_adversarial_covers_all_seven_types(registry):
    recs = adversarial.generate_adversarial(registry)
    cov = adversarial.coverage_by_type(recs)
    assert all(v >= 1 for v in cov.values()), cov
