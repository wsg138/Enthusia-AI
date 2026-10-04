"""Acceptance test: the generated corpus survives W16's full dataset pipeline.

Builds the sample corpus, then runs it through enthusia_datasets'
end-to-end build (validate -> secret scan -> dedupe -> quality -> version ->
split -> manifest).

Two configurations are exercised:

1. Default similarity threshold (0.85): no record may be REJECTED. Duplicates
   are expected and must all be ``near_duplicate`` within the same
   template_id — i.e. the pipeline collapses high-similarity linguistic
   variants (faq/typo/new_player renderings of one scenario) to a canonical
   record per template, which is W16's specified behavior. All adversarial /
   privacy / tool-failure evaluation records are single-form templates and
   must survive.
2. Threshold 1.0 (exact-text only): the full corpus, every linguistic
   variant, must be kept — proving the corpus is fully usable when the
   consumer wants all variation.
"""

import json
import os

import pytest

from enthusia_generation.corpus import build_corpus
from enthusia_generation.fixtures import FixtureRegistry

enthusia_datasets = pytest.importorskip("enthusia_datasets")
from enthusia_datasets.pipeline import PipelineConfig, build_dataset  # noqa: E402
from enthusia_datasets.splits import SplitConfig  # noqa: E402


@pytest.fixture(scope="module")
def registry():
    return FixtureRegistry.load()


@pytest.fixture(scope="module")
def corpus_path(registry, tmp_path_factory):
    tmp = tmp_path_factory.mktemp("w17-corpus")
    path = tmp / "corpus.jsonl"
    with open(path, "w", encoding="utf-8") as fh:
        for rec in build_corpus(registry):
            fh.write(json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n")
    return tmp, str(path)


def _config(corpus_path, tmp, threshold):
    out_dir = tmp / f"out-{threshold}"
    return PipelineConfig(
        inputs=[corpus_path],
        out_dir=str(out_dir),
        manifests_dir=str(tmp / f"manifests-{threshold}"),
        date="2026.10.03",
        seed=17017,
        preprocessing_commit="w17-test",
        generator={"model": "enthusia-generation", "version": "v0.1.0"},
        split=SplitConfig(train_ratio=0.8, validation_ratio=0.1, test_ratio=0.1, seed=17017),
        build_timestamp="2026-10-03T16:00:00Z",
        similarity_threshold=threshold,
    )


def test_pipeline_default_threshold_no_rejections(corpus_path):
    tmp, path = corpus_path
    result = build_dataset(_config(path, tmp, 0.85))
    assert not result.rejected, result.rejected[:5]
    # Every duplicate must be a within-template linguistic variant collapse.
    assert result.duplicates, "expected linguistic variants to dedupe"
    assert {d["reason"] for d in result.duplicates} == {"near_duplicate"}
    # Eval-critical single-form records must survive dedupe.
    kept_ids = set()
    for name in ("adversarial.jsonl", "privacy_security.jsonl", "tool_failure.jsonl",
                 "stale_truth.jsonl"):
        p = os.path.join(str(tmp / "out-0.85"), name)
        with open(p, encoding="utf-8") as fh:
            kept_ids.update(json.loads(line)["id"] for line in fh if line.strip())
    assert len(kept_ids) >= 14 + 2 + 1 + 2, kept_ids
    # Manifest records the generator provenance.
    with open(result.manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    assert manifest["generator"] == {"model": "enthusia-generation", "version": "v0.1.0"}
    assert manifest["dataset_version"].startswith("enthusia-ai-dataset-2026.10.03-v")
    assert manifest["exclusions"]["rejected_total"] == 0


def test_pipeline_exact_threshold_keeps_all_variants(corpus_path, registry):
    tmp, path = corpus_path
    result = build_dataset(_config(path, tmp, 1.0))
    assert not result.rejected, result.rejected[:5]
    assert not result.duplicates, result.duplicates[:5]
    records = build_corpus(registry)
    evaluation_only_tags = {
        "golden", "adversarial", "stale-truth", "privacy", "tool-failure"
    }
    ordinary_eligible = [
        record
        for record in records
        if record.get("quality") not in ("PRIVATE_EXCLUDE", "BAD_RESPONSE")
        and not evaluation_only_tags.intersection(
            tag.lower()
            for tag in record.get("tags", [])
            if isinstance(tag, str)
        )
    ]
    kept = (
        result.counts["train"]
        + result.counts["validation"]
        + result.counts["test"]
    )
    assert kept == len(ordinary_eligible), (kept, len(ordinary_eligible))
    # Evaluation-only cases survive in dedicated partitions without leaking
    # back into ordinary train/validation/test.
    assert result.counts["privacy_security"] >= 1
    assert result.counts["adversarial"] >= 1
    assert result.counts["stale_truth"] >= 1
    assert result.counts["tool_failure"] >= 1
