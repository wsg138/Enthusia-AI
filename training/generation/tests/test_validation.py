"""Tests for quality validation (W16 schema + fact traceability + coverage)."""

import copy

import pytest

from enthusia_generation.corpus import build_corpus
from enthusia_generation.fixtures import FixtureRegistry
from enthusia_generation.records import iter_records
from enthusia_generation.validate import (
    check_coverage,
    check_fact_traceability,
    check_factual_completeness,
    validate_corpus,
)

enthusia_datasets = pytest.importorskip("enthusia_datasets")


@pytest.fixture(scope="module")
def registry():
    return FixtureRegistry.load()


@pytest.fixture(scope="module")
def corpus(registry):
    return build_corpus(registry)


def test_full_corpus_validates_clean(registry, corpus):
    report = validate_corpus(corpus, registry)
    assert report["valid"], report["problems"][:10]
    assert report["record_count"] >= 100


def test_every_record_passes_w16_schema(corpus):
    from enthusia_datasets.record import validate_record
    for rec in corpus:
        validate_record(rec)  # raises on failure


def test_every_factual_record_has_traceable_facts(registry, corpus):
    for rec in corpus:
        for problem in check_factual_completeness(rec):
            raise AssertionError(problem)
        for problem in check_fact_traceability(rec, registry):
            raise AssertionError(problem)


def test_untraceable_fact_is_rejected(registry, corpus):
    bad = copy.deepcopy(corpus[0])
    bad["id"] = "w17-bad-0001"
    bad["facts"] = [{"claim": "made-up claim", "source": "docs:nope.md",
                     "source_version": "2026.10"}]
    problems = check_fact_traceability(bad, registry)
    assert problems


def test_factual_record_without_facts_is_rejected(registry, corpus):
    rec = next(r for r in corpus
               if r.get("expected_answer", "").strip()
               and r.get("quality") != "BAD_RESPONSE"
               and "tool-failure" not in r.get("tags", []))
    bad = copy.deepcopy(rec)
    bad["id"] = "w17-bad-0002"
    bad["facts"] = []
    assert check_factual_completeness(bad)


def test_coverage_requires_all_categories_forms_types(registry, corpus):
    assert not check_coverage(corpus)
    subset = [r for r in corpus if "onboarding" not in r.get("tags", [])]
    assert any("category" in p for p in check_coverage(subset))


def test_secret_scan_clean_on_corpus(corpus):
    from enthusia_datasets.secret_scan import scan_record
    for rec in corpus:
        assert not scan_record(rec), rec["id"]


def test_duplicate_ids_rejected(registry, corpus):
    dupes = corpus[:5] + corpus[:5]
    report = validate_corpus(dupes, registry)
    assert not report["valid"]
    assert any("duplicate record id" in p for p in report["problems"])
