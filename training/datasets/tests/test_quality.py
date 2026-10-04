"""Quality metadata tests (spec sections 4 and 10)."""

from enthusia_datasets import assess_quality, validate_record


def _rec(**kw):
    rec = {
        "id": "q-1",
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": "s",
        "messages": [{"role": "user", "content": "q"}],
        "expected_answer": "a" * 50,
    }
    rec.update(kw)
    return validate_record(rec)


def test_clean_record_is_good():
    a = assess_quality(_rec())
    assert a.label == "GOOD"
    assert a.reasons == ()


def test_curated_label_preserved():
    a = assess_quality(_rec(quality="IDEAL"))
    assert a.label == "IDEAL"
    assert "curated_label" in a.reasons


def test_empty_answer_incomplete():
    a = assess_quality(_rec(expected_answer="   "))
    assert a.label == "INCOMPLETE"
    assert "empty_answer" in a.reasons


def test_overlong_usable_with_edit():
    a = assess_quality(_rec(expected_answer="x" * 5000))
    assert a.label == "USABLE_WITH_EDIT"
    assert "overlong_example" in a.reasons


def test_broken_tool_trace_incomplete():
    rec = _rec(
        messages=[
            {"role": "user", "content": "q"},
            {"role": "tool", "content": "result without a declared tool"},
        ]
    )
    a = assess_quality(rec)
    assert a.label == "INCOMPLETE"
    assert "broken_tool_trace" in a.reasons


def test_tool_action_referencing_unknown_tool():
    rec = _rec(
        tools=["rank_lookup"],
        expected_actions=["tool:nonexistent_tool"],
    )
    a = assess_quality(rec)
    assert "broken_tool_trace" in a.reasons


def test_unsupported_facts_usable_with_edit():
    rec = _rec(facts=[{"claim": "c", "source": "", "source_version": "v"}])
    a = assess_quality(rec)
    assert a.label == "USABLE_WITH_EDIT"
    assert "unsupported_facts" in a.reasons


def test_private_visibility_excluded():
    a = assess_quality(_rec(visibility="private"))
    assert a.label == "PRIVATE_EXCLUDE"
    assert "private_content" in a.reasons


def test_stale_tag_outdated():
    a = assess_quality(_rec(tags=["stale-truth"]))
    assert a.label == "OUTDATED"
    assert "stale_tag" in a.reasons


def test_assessment_serializes():
    d = assess_quality(_rec()).to_dict()
    assert set(d) == {"label", "reasons", "checks"}
    assert isinstance(d["reasons"], list)
