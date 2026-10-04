"""Split + frozen-partition tests (spec section 7)."""

import pytest

from enthusia_datasets import (
    FrozenPartitionError,
    SplitConfig,
    assert_not_frozen,
    build_special_partitions,
    split_records,
    tune_guard,
    validate_record,
)


def _rec(rid, **kw):
    rec = {
        "id": rid,
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": f"scenario {rid}",
        "messages": [{"role": "user", "content": f"question {rid}"}],
        "expected_answer": "answer",
    }
    rec.update(kw)
    return validate_record(rec)


def _many(n):
    return [_rec(f"r-{i:03d}") for i in range(n)]


def test_split_ratios_approximately_hold():
    parts = split_records(_many(100), SplitConfig(seed=1))
    assert len(parts["test"]) == 10
    assert len(parts["validation"]) == 10
    assert len(parts["train"]) == 80


def test_split_deterministic_same_seed():
    recs = _many(40)
    a = split_records(recs, SplitConfig(seed=42))
    b = split_records(recs, SplitConfig(seed=42))
    assert {p: [r["id"] for r in a[p]] for p in a} == {
        p: [r["id"] for r in b[p]] for p in b
    }


def test_split_covers_all_records_no_overlap():
    recs = _many(30)
    parts = split_records(recs, SplitConfig(seed=7))
    ids = [r["id"] for p in parts.values() for r in p]
    assert sorted(ids) == sorted(r["id"] for r in recs)


def test_leak_groups_never_cross_partitions():
    recs = []
    for g in range(10):
        # same template => same leak group, different wording
        recs.append(_rec(f"g{g}-a", template_id=f"tpl-{g}", text=f"wording one {g}"))
        recs.append(_rec(f"g{g}-b", template_id=f"tpl-{g}", text=f"wording two {g}"))
    parts = split_records(recs, SplitConfig(seed=3))
    where = {}
    for pname, plist in parts.items():
        for r in plist:
            where.setdefault(r["template_id"], set()).add(pname)
    assert all(len(v) == 1 for v in where.values())


def test_bad_ratios_rejected():
    with pytest.raises(ValueError):
        SplitConfig(train_ratio=0.5, validation_ratio=0.5, test_ratio=0.5)


def test_assert_not_frozen_raises_for_test_and_golden():
    with pytest.raises(FrozenPartitionError):
        assert_not_frozen("test", "tune")
    with pytest.raises(FrozenPartitionError):
        assert_not_frozen("owner_golden", "tune")
    assert_not_frozen("train", "tune")  # no raise
    assert_not_frozen("validation", "tune")


def test_tune_guard_fails_closed_on_frozen_data():
    parts = {"train": _many(5), "test": _many(2), "validation": []}
    with pytest.raises(FrozenPartitionError):
        tune_guard(parts, "hyperparameter search")
    ok = {"train": _many(5), "validation": _many(2)}
    tune_guard(ok, "hyperparameter search")  # no raise


def test_special_partitions_from_tags():
    recs = [
        _rec("a", tags=["golden"]),
        _rec("b", tags=["adversarial"]),
        _rec("c", tags=["stale-truth"]),
        _rec("d", tags=["privacy"]),
        _rec("e", tags=["tool-failure"]),
        _rec("f", tags=["faq"]),
    ]
    special = build_special_partitions(recs)
    assert [r["id"] for r in special["owner_golden"]] == ["a"]
    assert [r["id"] for r in special["adversarial"]] == ["b"]
    assert [r["id"] for r in special["stale_truth"]] == ["c"]
    assert [r["id"] for r in special["privacy_security"]] == ["d"]
    assert [r["id"] for r in special["tool_failure"]] == ["e"]
