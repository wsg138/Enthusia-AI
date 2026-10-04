"""Versioning + manifest tests (spec section 9)."""

import json
import os

import pytest

from enthusia_datasets import (
    build_manifest,
    dataset_version_id,
    next_version_number,
    parse_version_id,
    sha256_file,
    write_manifest,
)


def test_version_id_format():
    assert dataset_version_id("2026.10.03", 1) == "enthusia-ai-dataset-2026.10.03-v1"
    assert dataset_version_id("2026.10.03", 12) == "enthusia-ai-dataset-2026.10.03-v12"


def test_version_id_rejects_bad_date():
    with pytest.raises(ValueError):
        dataset_version_id("2026-10-03", 1)
    with pytest.raises(ValueError):
        dataset_version_id("2026.10.03", 0)


def test_parse_version_id_roundtrip():
    assert parse_version_id("enthusia-ai-dataset-2026.10.03-v7") == ("2026.10.03", 7)
    with pytest.raises(ValueError):
        parse_version_id("v1")


def test_next_version_number_increments_per_date(tmp_path):
    reg = str(tmp_path / "manifests")
    assert next_version_number("2026.10.03", reg) == 1
    for n in (1, 2):
        d = os.path.join(reg, dataset_version_id("2026.10.03", n))
        os.makedirs(d)
        write_manifest(
            build_manifest(
                dataset_version=dataset_version_id("2026.10.03", n),
                seed=1,
                split_config={},
                source_sets=["synthetic"],
                counts={"train": 1},
                filters={},
                generator={},
                preprocessing_commit="abc",
                exclusions={},
                file_hashes={},
                frozen_partitions=["test"],
            ),
            os.path.join(d, "manifest.json"),
        )
    assert next_version_number("2026.10.03", reg) == 3
    # other dates start at 1
    assert next_version_number("2026.10.04", reg) == 1


def test_manifest_contains_required_sections(tmp_path):
    m = build_manifest(
        dataset_version=dataset_version_id("2026.10.03", 1),
        seed=1337,
        split_config={"train_ratio": 0.8},
        source_sets=["synthetic", "ticket"],
        counts={"train": 10, "test": 2},
        filters={"secret_policy": "reject"},
        generator={"model": "synthetic-fixtures", "version": "v1"},
        preprocessing_commit="8c28252f",
        exclusions={"rejected_total": 1},
        file_hashes={"train.jsonl": "abc123"},
        frozen_partitions=["test", "owner_golden"],
        created_at="2026-10-03T16:00:00Z",
    )
    for key in (
        "dataset_version", "created_at", "seed", "source_sets", "counts",
        "filters", "generator", "preprocessing_commit", "exclusions",
        "hashes", "frozen_partitions",
    ):
        assert key in m, key
    assert m["frozen_partitions"] == ["owner_golden", "test"]


def test_manifest_write_is_canonical_and_hashed(tmp_path):
    m = build_manifest(
        dataset_version=dataset_version_id("2026.10.03", 1),
        seed=1, split_config={}, source_sets=[], counts={}, filters={},
        generator={}, preprocessing_commit="x", exclusions={},
        file_hashes={}, frozen_partitions=[],
        created_at="2026-10-03T16:00:00Z",
    )
    p1 = str(tmp_path / "m1.json")
    p2 = str(tmp_path / "m2.json")
    h1 = write_manifest(m, p1)
    h2 = write_manifest(m, p2)
    assert h1 == h2 == sha256_file(p1)
    raw = open(p1, encoding="utf-8").read()
    assert json.loads(raw) == m  # canonical JSON round-trips
    assert raw.endswith("\n")
