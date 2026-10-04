"""Dedupe tests (spec section 8)."""

from enthusia_datasets import (
    TrigramSimilarity,
    canonical_hash,
    dedupe_records,
    leak_group_key,
    validate_record,
)


def _rec(rid, scenario="base scenario", text="hello world", **kw):
    rec = {
        "id": rid,
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": scenario,
        "messages": [{"role": "user", "content": text}],
        "expected_answer": "answer",
    }
    rec.update(kw)
    return validate_record(rec)


def test_exact_text_duplicate():
    a = _rec("a", text="identical content here")
    b = _rec("b", text="identical content here")  # same scenario+text, new id
    kept, dups = dedupe_records([b, a])  # reversed input order
    assert [r["id"] for r in kept] == ["a"]  # first by id wins, deterministic
    assert len(dups) == 1
    assert dups[0].id == "b" and dups[0].duplicate_of == "a"
    assert dups[0].reason == "exact_text"


def test_shared_source_duplicate():
    a = _rec("a", source_type="ticket", thread_id="th-9", text="first message")
    b = _rec("b", source_type="ticket", thread_id="th-9", text="totally different follow-up")
    kept, dups = dedupe_records([a, b])
    assert [r["id"] for r in kept] == ["a"]
    assert dups[0].reason == "shared_source"


def test_different_threads_not_duplicates():
    a = _rec("a", source_type="ticket", thread_id="th-1",
             scenario="chest permission issue", text="cannot open chests")
    b = _rec("b", source_type="ticket", thread_id="th-2",
             scenario="fly command issue", text="fly does not work")
    kept, dups = dedupe_records([a, b])
    assert len(kept) == 2 and not dups


def test_near_duplicate_same_template():
    a = _rec("a", template_id="tpl-x",
             text="what does the avid donor rank give me, please explain in detail")
    b = _rec("b", template_id="tpl-x",
             text="what does the avid donor rank give me, please explain with detail")
    kept, dups = dedupe_records([a, b])
    assert len(kept) == 1
    assert dups[0].reason == "near_duplicate"


def test_dissimilar_same_template_kept():
    a = _rec("a", template_id="tpl-x", text="what does the avid rank give me")
    b = _rec("b", template_id="tpl-x", text="how do I completely reset my island base")
    kept, dups = dedupe_records([a, b])
    assert len(kept) == 2 and not dups


def test_canonical_hash_stable():
    a = _rec("a", text="  Hello,   WORLD! ")
    b = _rec("b", text="hello world")
    assert canonical_hash(a) == canonical_hash(b)


def test_leak_group_key_prefers_template_then_thread():
    r = _rec("a", template_id="tpl-1", thread_id="th-1")
    assert leak_group_key(r) == "template:tpl-1"
    r2 = _rec("b", thread_id="th-1")
    assert leak_group_key(r2) == "thread:synthetic:th-1"
    r3 = _rec("c")
    r4 = _rec("d", scenario="base scenario")
    assert leak_group_key(r3) == leak_group_key(r4)


def test_trigram_scorer_placeholder_contract():
    s = TrigramSimilarity(threshold=0.9)
    assert s.score("abc", "abc") == 1.0
    assert 0.0 <= s.score("abc", "xyz") <= 1.0
    assert s.is_duplicate("same text here", "same text here")
    assert not s.is_duplicate("totally unrelated", "something else entirely")
