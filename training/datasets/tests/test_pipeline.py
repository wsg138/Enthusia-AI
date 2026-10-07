"""End-to-end pipeline + determinism tests."""

import json
import os
import shutil

import pytest

from enthusia_datasets import (
    PipelineConfig,
    SplitConfig,
    build_dataset,
    sha256_file,
    validate_record,
)


FIXTURES = os.path.join(os.path.dirname(__file__), "..", "fixtures", "examples.jsonl")
TS = "2026-10-03T16:00:00Z"


def _cfg(out_dir, manifests_dir, **kw):
    args = dict(
        inputs=[FIXTURES],
        out_dir=out_dir,
        manifests_dir=manifests_dir,
        date="2026.10.03",
        preprocessing_commit="8c28252f",
        build_timestamp=TS,
        generator={"model": "synthetic-fixtures", "version": "v1"},
    )
    args.update(kw)
    return PipelineConfig(**args)


def _hashes(directory):
    return {
        f: sha256_file(os.path.join(directory, f))
        for f in sorted(os.listdir(directory))
    }


def test_pipeline_builds_versioned_dataset(tmp_path):
    result = build_dataset(_cfg(str(tmp_path / "out"), str(tmp_path / "man")))
    assert result.dataset_version == "enthusia-ai-dataset-2026.10.03-v1"

    manifest = json.load(open(result.manifest_path, encoding="utf-8"))
    assert manifest["dataset_version"] == result.dataset_version
    assert set(manifest["frozen_partitions"]) == {"test", "owner_golden"}

    # hashes in manifest match the actual files
    for filename, digest in manifest["hashes"].items():
        assert sha256_file(os.path.join(str(tmp_path / "out"), filename)) == digest

    # every emitted record carries the dataset version and valid schema
    for filename in manifest["hashes"]:
        if filename == "manifest.json":
            continue
        for line in open(os.path.join(str(tmp_path / "out"), filename), encoding="utf-8"):
            rec = json.loads(line)
            assert rec["dataset_version"] == result.dataset_version
            validate_record(rec)

    # dedupe exercised on the fixtures
    reasons = {d["reason"] for d in result.duplicates}
    assert "near_duplicate" in reasons
    assert "shared_source" in reasons


def test_pipeline_rejects_secret_records(tmp_path):
    bad = {
        "id": "evil-1",
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": "leak test",
        "messages": [{"role": "user", "content": "my key is " + "sk-" + "Z" * 32}],
        "expected_answer": "ok",
    }
    inp = tmp_path / "bad.jsonl"
    inp.write_text(json.dumps(bad) + "\n", encoding="utf-8")
    cfg = _cfg(str(tmp_path / "out"), str(tmp_path / "man"), inputs=[str(inp)])
    result = build_dataset(cfg)
    assert any(
        r["id"] == "evil-1" and r["reason"] == "secret_detected"
        for r in result.rejected
    )
    assert result.manifest["exclusions"]["rejected_by_reason"]["secret_detected"] == 1
    # rejected record appears in no partition
    for filename, digest in result.manifest["hashes"].items():
        if filename == "manifest.json":
            continue
        text = open(os.path.join(str(tmp_path / "out"), filename), encoding="utf-8").read()
        assert "evil-1" not in text


def test_pipeline_rejects_schema_invalid_records(tmp_path):
    inp = tmp_path / "invalid.jsonl"
    inp.write_text(json.dumps({"id": "broken", "source_type": "nope"}) + "\n",
                   encoding="utf-8")
    cfg = _cfg(str(tmp_path / "out"), str(tmp_path / "man"), inputs=[str(inp)])
    result = build_dataset(cfg)
    assert any(
        r["id"] == "broken" and r["reason"] == "schema_invalid"
        for r in result.rejected
    )


def test_private_exclude_kept_out_of_train(tmp_path):
    result = build_dataset(_cfg(str(tmp_path / "out"), str(tmp_path / "man")))
    train_ids = [
        json.loads(l)["id"]
        for l in open(os.path.join(str(tmp_path / "out"), "train.jsonl"), encoding="utf-8")
    ]
    assert "syn-0014" not in train_ids  # visibility=private -> PRIVATE_EXCLUDE
    assert "syn-0015" not in train_ids  # curated BAD_RESPONSE


def test_only_good_and_ideal_quality_enter_standard_splits(tmp_path):
    qualities = [
        "IDEAL",
        "GOOD",
        "USABLE_WITH_EDIT",
        "BAD_RESPONSE",
        "OUTDATED",
        "INCOMPLETE",
        "PRIVATE_EXCLUDE",
    ]
    records = [
        {
            "id": f"quality-{quality.lower()}",
            "source_type": "ticket",
            "visibility": "staff",
            "scenario": f"quality gate case {quality}",
            "messages": [{"role": "user", "content": f"question {quality}"}],
            "expected_answer": f"answer {quality}",
            "quality": quality,
        }
        for quality in qualities
    ]
    inp = tmp_path / "quality-gate.jsonl"
    inp.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )

    result = build_dataset(
        _cfg(str(tmp_path / "out"), str(tmp_path / "man"), inputs=[str(inp)])
    )
    standard_ids = set()
    for filename in ("train.jsonl", "validation.jsonl", "test.jsonl"):
        standard_ids.update(
            json.loads(line)["id"]
            for line in open(tmp_path / "out" / filename, encoding="utf-8")
        )

    assert standard_ids == {"quality-ideal", "quality-good"}
    assert set(result.manifest["exclusions"]["excluded_from_train_labels"]) == {
        "PRIVATE_EXCLUDE",
        "BAD_RESPONSE",
        "OUTDATED",
        "INCOMPLETE",
        "USABLE_WITH_EDIT",
    }


def test_deterministic_byte_identical_output(tmp_path):
    out1, out2 = str(tmp_path / "out1"), str(tmp_path / "out2")
    man1, man2 = str(tmp_path / "man1"), str(tmp_path / "man2")
    r1 = build_dataset(_cfg(out1, man1))
    r2 = build_dataset(_cfg(out2, man2))
    assert r1.dataset_version == r2.dataset_version
    h1, h2 = _hashes(out1), _hashes(out2)
    assert set(h1) == set(h2)
    for f in h1:
        assert h1[f] == h2[f], f"non-deterministic output: {f}"


def test_version_increments_on_rebuild(tmp_path):
    man = str(tmp_path / "man")
    r1 = build_dataset(_cfg(str(tmp_path / "o1"), man))
    r2 = build_dataset(_cfg(str(tmp_path / "o2"), man))
    assert r1.dataset_version == "enthusia-ai-dataset-2026.10.03-v1"
    assert r2.dataset_version == "enthusia-ai-dataset-2026.10.03-v2"


def test_owner_golden_is_never_assigned_to_standard_tuning_splits(tmp_path):
    golden = {
        "id": "golden-only-1",
        "source_type": "evaluation",
        "visibility": "owner",
        "scenario": "frozen owner case",
        "messages": [{"role": "user", "content": "owner golden question"}],
        "expected_answer": "gold answer",
        "tags": ["golden"],
        "quality": "IDEAL",
    }
    ordinary = [
        {
            "id": f"ordinary-{i}",
            "source_type": "synthetic",
            "visibility": "public",
            "scenario": f"ordinary scenario {i}",
            "messages": [{"role": "user", "content": f"question {i}"}],
            "expected_answer": f"answer {i}",
            "quality": "IDEAL",
        }
        for i in range(20)
    ]
    inp = tmp_path / "golden.jsonl"
    inp.write_text(
        "\n".join(json.dumps(record) for record in [golden, *ordinary]) + "\n",
        encoding="utf-8",
    )

    result = build_dataset(
        _cfg(str(tmp_path / "out"), str(tmp_path / "man"), inputs=[str(inp)])
    )
    assert result.counts["owner_golden"] == 1

    for filename in ("train.jsonl", "validation.jsonl", "test.jsonl"):
        ids = {
            json.loads(line)["id"]
            for line in open(tmp_path / "out" / filename, encoding="utf-8")
        }
        assert "golden-only-1" not in ids

    golden_ids = {
        json.loads(line)["id"]
        for line in open(tmp_path / "out" / "owner_golden.jsonl", encoding="utf-8")
    }
    assert golden_ids == {"golden-only-1"}


def test_special_evaluation_records_never_enter_standard_splits(tmp_path):
    special = [
        ("golden-only", "golden"),
        ("adversarial-only", "adversarial"),
        ("stale-only", "stale-truth"),
        ("privacy-only", "privacy"),
        ("tool-failure-only", "tool-failure"),
    ]
    records = [
        {
            "id": rid,
            "source_type": "evaluation",
            "visibility": "public",
            "scenario": f"{tag} evaluation case",
            "messages": [{"role": "user", "content": f"question for {tag}"}],
            "expected_answer": f"answer for {tag}",
            "tags": [tag],
            "quality": "IDEAL",
        }
        for rid, tag in special
    ]
    records.extend(
        {
            "id": f"ordinary-{i}",
            "source_type": "synthetic",
            "visibility": "public",
            "scenario": f"ordinary scenario {i}",
            "messages": [{"role": "user", "content": f"ordinary question {i}"}],
            "expected_answer": f"ordinary answer {i}",
            "quality": "IDEAL",
        }
        for i in range(20)
    )
    inp = tmp_path / "evaluation-isolation.jsonl"
    inp.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )

    result = build_dataset(
        _cfg(str(tmp_path / "out"), str(tmp_path / "man"), inputs=[str(inp)])
    )
    special_ids = {rid for rid, _ in special}

    for filename in ("train.jsonl", "validation.jsonl", "test.jsonl"):
        ids = {
            json.loads(line)["id"]
            for line in open(tmp_path / "out" / filename, encoding="utf-8")
        }
        assert ids.isdisjoint(special_ids)

    partition_for_tag = {
        "golden": "owner_golden.jsonl",
        "adversarial": "adversarial.jsonl",
        "stale-truth": "stale_truth.jsonl",
        "privacy": "privacy_security.jsonl",
        "tool-failure": "tool_failure.jsonl",
    }
    for rid, tag in special:
        ids = {
            json.loads(line)["id"]
            for line in open(tmp_path / "out" / partition_for_tag[tag], encoding="utf-8")
        }
        assert rid in ids


def test_duplicate_record_ids_are_rejected_before_partitioning(tmp_path):
    records = [
        {
            "id": "same-id",
            "source_type": "synthetic",
            "visibility": "public",
            "scenario": "first scenario",
            "messages": [{"role": "user", "content": "first"}],
            "expected_answer": "first answer",
        },
        {
            "id": "same-id",
            "source_type": "synthetic",
            "visibility": "public",
            "scenario": "different scenario",
            "messages": [{"role": "user", "content": "different"}],
            "expected_answer": "different answer",
        },
    ]
    inp = tmp_path / "duplicate-ids.jsonl"
    inp.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )
    result = build_dataset(
        _cfg(str(tmp_path / "out"), str(tmp_path / "man"), inputs=[str(inp)])
    )

    assert any(
        item["id"] == "same-id" and item["reason"] == "duplicate_id"
        for item in result.rejected
    )
    emitted = 0
    for filename in ("train.jsonl", "validation.jsonl", "test.jsonl"):
        emitted += sum(
            1
            for line in open(tmp_path / "out" / filename, encoding="utf-8")
            if json.loads(line)["id"] == "same-id"
        )
    assert emitted == 1
