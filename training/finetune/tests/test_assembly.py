"""Tests for dataset assembly: combining W16/W17/W18-style corpora,
quality/visibility filtering, dedupe, leak-group splits (no template
leakage), special-partition routing, and the dataset manifest."""

from __future__ import annotations

import json
import os

import pytest

from enthusia_finetune import assembly
from enthusia_finetune.record import leak_group_key

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "fixtures")
SYNTHETIC = os.path.join(FIXTURES, "synthetic.jsonl")
TICKETS = os.path.join(FIXTURES, "tickets.jsonl")
VERSION = "enthusia-ai-dataset-2026.10.03-v1"


def _assemble(tmp_path, seed=1337):
    out = str(tmp_path / "dataset")
    manifest = assembly.assemble(
        [SYNTHETIC, TICKETS],
        out,
        dataset_version=VERSION,
        split_config=assembly.SplitConfig(seed=seed),
    )
    return out, manifest


def _load_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def test_assemble_counts(tmp_path):
    _, manifest = _assemble(tmp_path)
    counts = manifest["counts"]
    assert counts["loaded"] == 17
    assert counts["invalid"] == 1          # fx-tk-07: no messages
    assert counts["excluded"] == 6         # + unreviewed/null quality
    assert counts["duplicates"] == 1       # fx-syn-06 exact dupe of fx-syn-01
    assert counts["special_partitions"] == 3  # golden, adversarial, stale-truth
    assert counts["train"] + counts["validation"] == 6


def test_exclusions_logged(tmp_path):
    _, manifest = _assemble(tmp_path)
    by_id = {e["id"]: e["reason"] for e in manifest["exclusions"]}
    assert "fx-syn-04" in by_id  # OUTDATED
    assert "fx-syn-05" in by_id  # BAD_RESPONSE
    assert "fx-syn-07" not in by_id  # mentioning api_key is not itself a credential
    assert "fx-syn-10" in by_id  # owner visibility
    assert "fx-tk-03" in by_id   # PRIVATE_EXCLUDE
    assert "fx-tk-05" in by_id   # missing/unreviewed quality
    assert "fx-tk-06" in by_id   # private visibility
    assert "fx-tk-07" in by_id   # invalid


def test_finetune_assembly_only_admits_explicit_good_or_ideal(tmp_path):
    qualities = [
        "IDEAL",
        "GOOD",
        "USABLE_WITH_EDIT",
        "BAD_RESPONSE",
        "OUTDATED",
        "INCOMPLETE",
        "PRIVATE_EXCLUDE",
        None,
    ]
    records = [
        {
            "id": f"quality-{str(quality).lower()}",
            "source_type": "ticket",
            "visibility": "staff",
            "scenario": f"quality gate case {quality}",
            "messages": [{"role": "user", "content": f"question {quality}"}],
            "expected_answer": f"answer {quality}",
            "facts": [],
            "tags": [],
            "quality": quality,
        }
        for quality in qualities
    ]
    corpus = tmp_path / "quality-gate.jsonl"
    corpus.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )
    out = str(tmp_path / "out")
    manifest = assembly.assemble([str(corpus)], out, dataset_version=VERSION)

    emitted = {
        record["id"]
        for filename in ("train.jsonl", "validation.jsonl")
        for record in _load_jsonl(os.path.join(out, filename))
    }
    assert emitted == {"quality-ideal", "quality-good"}

    excluded = {item["id"] for item in manifest["exclusions"]}
    assert {
        "quality-usable_with_edit",
        "quality-bad_response",
        "quality-outdated",
        "quality-incomplete",
        "quality-private_exclude",
        "quality-none",
    } <= excluded


def test_no_leak_group_crossing(tmp_path):
    out, _ = _assemble(tmp_path)
    train = _load_jsonl(os.path.join(out, "train.jsonl"))
    val = _load_jsonl(os.path.join(out, "validation.jsonl"))
    train_groups = {leak_group_key(r) for r in train}
    val_groups = {leak_group_key(r) for r in val}
    assert train_groups.isdisjoint(val_groups), "leak group crossed train/validation"
    # The tpl-faq-rank template variants must stay together.
    faq_groups = [g for g in (train_groups | val_groups) if "tpl-faq-rank" in g]
    assert len(faq_groups) == 1
    # The T-1001 ticket thread must stay together.
    t1001 = [r for r in train + val if r.get("ticket_id") == "T-1001"]
    assert len(t1001) == 2
    assert all(r in train for r in t1001) or all(r in val for r in t1001)


def test_split_deterministic(tmp_path):
    out1, _ = _assemble(tmp_path / "a", seed=99)
    out2, _ = _assemble(tmp_path / "b", seed=99)
    for name in ("train.jsonl", "validation.jsonl"):
        with open(os.path.join(out1, name), "rb") as f1, open(
            os.path.join(out2, name), "rb"
        ) as f2:
            assert f1.read() == f2.read()


def test_special_partitions_routed(tmp_path):
    out, manifest = _assemble(tmp_path)
    assert set(manifest["special_outputs"]) == {"owner_golden", "adversarial", "stale_truth"}
    golden = _load_jsonl(os.path.join(out, "owner_golden.jsonl"))
    assert {r["id"] for r in golden} == {"fx-syn-03"}
    adversarial = _load_jsonl(os.path.join(out, "adversarial.jsonl"))
    assert {r["id"] for r in adversarial} == {"fx-syn-08"}
    stale = _load_jsonl(os.path.join(out, "stale_truth.jsonl"))
    assert {r["id"] for r in stale} == {"fx-tk-04"}
    # None of them may appear in train/validation.
    train_ids = {r["id"] for r in _load_jsonl(os.path.join(out, "train.jsonl"))}
    val_ids = {r["id"] for r in _load_jsonl(os.path.join(out, "validation.jsonl"))}
    assert not (train_ids | val_ids) & {"fx-syn-03", "fx-syn-08", "fx-tk-04"}


def test_manifest_has_spec_section_9_fields(tmp_path):
    _, manifest = _assemble(tmp_path)
    assert manifest["dataset_version"] == VERSION
    assert manifest["generator"]
    assert manifest["source_sets"], "must list source sets"
    for src in manifest["source_sets"]:
        assert src["records"] > 0 and src["sha256"]
    assert manifest["counts"]
    assert manifest["filters"], "must list filters"
    assert isinstance(manifest["exclusions"], list)
    for out in manifest["outputs"].values():
        assert out["records"] >= 0 and out["sha256"]


def test_duplicate_info_points_to_kept_record(tmp_path):
    _, manifest = _assemble(tmp_path)
    dup = next(d for d in manifest["duplicates"] if d["id"] == "fx-syn-06")
    assert dup["duplicate_of"] == "fx-syn-01"
    assert dup["reason"] == "exact_text"


def test_split_config_validation():
    with pytest.raises(ValueError):
        assembly.SplitConfig(train_ratio=0.5, validation_ratio=0.6)


def test_load_jsonl_rejects_bad_json(tmp_path):
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"id": "ok", }\n', encoding="utf-8")
    with pytest.raises(ValueError):
        assembly.load_jsonl(str(bad))


def test_actual_w16_secret_shape_is_excluded(tmp_path):
    secret_value = "sk-" + "A" * 32
    record = {
        "id": "secret-shape",
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": "credential leak",
        "messages": [{"role": "user", "content": f"key is {secret_value}"}],
        "expected_answer": "Do not expose credentials.",
        "facts": [],
        "tags": ["security"],
        "quality": "GOOD",
        "created_at": "2026-10-03T12:00:00Z",
    }
    corpus = tmp_path / "secret.jsonl"
    corpus.write_text(json.dumps(record) + "\n", encoding="utf-8")
    manifest = assembly.assemble(
        [str(corpus)],
        str(tmp_path / "out"),
        dataset_version=VERSION,
    )
    assert manifest["counts"]["excluded"] == 1
    exclusion = manifest["exclusions"][0]
    assert exclusion["id"] == "secret-shape"
    assert exclusion["reason"] == "secret detected by W16"
    assert "openai_key" in exclusion["patterns"]


def test_w16_validator_rejects_malformed_fact_contract(tmp_path):
    record = {
        "id": "bad-fact",
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": "bad fact shape",
        "messages": [{"role": "user", "content": "question"}],
        "expected_answer": "answer",
        "facts": [{"claim": "missing source fields"}],
        "tags": [],
        "quality": "GOOD",
    }
    corpus = tmp_path / "bad-fact.jsonl"
    corpus.write_text(json.dumps(record) + "\n", encoding="utf-8")
    manifest = assembly.assemble(
        [str(corpus)],
        str(tmp_path / "out"),
        dataset_version=VERSION,
    )
    assert manifest["counts"]["invalid"] == 1
    assert manifest["counts"]["train"] == 0
    assert manifest["counts"]["validation"] == 0


def test_record_can_belong_to_multiple_eval_partitions(tmp_path):
    record = {
        "id": "multi-eval",
        "source_type": "evaluation",
        "visibility": "public",
        "scenario": "adversarial privacy case",
        "messages": [{"role": "user", "content": "request private data"}],
        "expected_answer": "Refuse.",
        "facts": [],
        "tags": ["adversarial", "privacy"],
        "quality": "GOOD",
    }
    corpus = tmp_path / "multi.jsonl"
    corpus.write_text(json.dumps(record) + "\n", encoding="utf-8")
    out = str(tmp_path / "out")
    manifest = assembly.assemble([str(corpus)], out, dataset_version=VERSION)
    assert set(manifest["special_outputs"]) == {"adversarial", "privacy_security"}
    for filename in ("adversarial.jsonl", "privacy_security.jsonl"):
        assert {r["id"] for r in _load_jsonl(os.path.join(out, filename))} == {"multi-eval"}
    assert manifest["counts"]["train"] == 0
    assert manifest["counts"]["validation"] == 0
