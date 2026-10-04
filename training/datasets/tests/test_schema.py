"""Schema validation tests (spec section 27)."""

import pytest

from enthusia_datasets import RecordValidationError, validate_record


def _base(**overrides):
    rec = {
        "id": "t-1",
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": "test scenario",
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [],
        "expected_actions": [],
        "expected_answer": "hello",
        "facts": [{"claim": "c", "source": "s", "source_version": "v"}],
        "tags": ["faq"],
        "created_at": "2026-10-03T12:00:00Z",
    }
    rec.update(overrides)
    return rec


def test_valid_record_passes_with_defaults():
    rec = _base()
    del rec["tools"]
    del rec["facts"]
    out = validate_record(rec)
    assert out["tools"] == []
    assert out["facts"] == []
    assert out["id"] == "t-1"


def test_missing_id_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(id=""))


def test_bad_source_type_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(source_type="blog"))


def test_bad_visibility_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(visibility="everyone"))


def test_empty_messages_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(messages=[]))


def test_bad_message_role_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(messages=[{"role": "narrator", "content": "x"}]))


def test_non_string_message_content_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(messages=[{"role": "user", "content": 42}]))


def test_fact_missing_source_version_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(facts=[{"claim": "c", "source": "s"}]))


def test_bad_quality_label_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(quality="PERFECT"))


def test_curated_quality_label_accepted():
    out = validate_record(_base(quality="IDEAL"))
    assert out["quality"] == "IDEAL"


def test_bad_created_at_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(_base(created_at="yesterday"))


def test_extra_fields_preserved():
    out = validate_record(_base(thread_id="th-1", template_id="tpl-1"))
    assert out["thread_id"] == "th-1"
    assert out["template_id"] == "tpl-1"


def test_non_dict_rejected():
    with pytest.raises(RecordValidationError):
        validate_record(["not", "a", "dict"])
