"""Tests for the fixture source registry."""

import pytest

from enthusia_generation.fixtures import FixtureRegistry


@pytest.fixture(scope="module")
def registry():
    return FixtureRegistry.load()


def test_registry_loads_expected_source_count(registry):
    assert len(registry.source_ids()) >= 20


def test_every_source_has_version_and_claims(registry):
    for sid in registry.source_ids():
        src = registry.get(sid)
        assert src.version, sid
        assert len(src.claims) >= 1, sid
        for claim in src.claims:
            assert claim.strip(), sid


def test_fact_builds_w16_shape(registry):
    fact = registry.fact("docs:ranks/store.md", 0)
    assert set(fact) == {"claim", "source", "source_version"}
    assert fact["source"] == "docs:ranks/store.md"
    assert fact["source_version"] == registry.get("docs:ranks/store.md").version
    assert fact["claim"]


def test_is_traceable_exact_match(registry):
    src = registry.get("docs:commands/fly.md")
    claim = src.claims[0]
    assert registry.is_traceable(claim, src.id, src.version)
    assert not registry.is_traceable(claim + " (edited)", src.id, src.version)
    assert not registry.is_traceable(claim, src.id, "1900.01")
    assert not registry.is_traceable(claim, "docs:nope.md", src.version)


def test_unknown_source_raises(registry):
    with pytest.raises(KeyError):
        registry.get("docs:does-not-exist.md")
    with pytest.raises(IndexError):
        registry.claim("docs:commands/fly.md", 999)


def test_versions_mapping(registry):
    versions = registry.versions()
    assert versions["docs:archive/ranks-2026-09.md"] == "2026.09"
    assert versions["docs:ranks/store.md"] == "2026.10"
