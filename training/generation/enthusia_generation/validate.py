"""Quality validation for generated corpora (MASTER-SPECIFICATION 42.3).

Checks every generated record against:

1. W16 schema validation (``enthusia_datasets.record.validate_record``) —
   the dataset pipeline's own schema; DO NOT modify W16's code, only use it.
2. W16 secret scan — any credential pattern is a hard failure.
3. W16 quality assessment — recorded per record for the corpus manifest.
4. Fact traceability — every fact's (claim, source, source_version) must
   resolve to an exact claim in the fixture registry. A factual synthetic
   example without a traceable source is rejected.
5. Factual completeness — every record with a non-empty expected answer must
   carry at least one fact, unless it is a curated negative example
   (BAD_RESPONSE) or a tool-failure fallback (no factual claims to source).
6. Coverage — all 14 spec categories, all 7 adversarial types, and all 11
   variation forms must be represented.
"""

from __future__ import annotations

from .adversarial import coverage_by_type
from .fixtures import FixtureRegistry
from .scenarios import ADVERSARIAL_TYPES, CATEGORIES
from .variations import FORMS

MIN_CORPUS_SIZE = 100

# Records exempt from the must-have-facts rule.
_FACTS_EXEMPT_QUALITIES = {"BAD_RESPONSE"}
_FACTS_EXEMPT_TAGS = {"tool-failure"}


def _w16():
    try:
        import enthusia_datasets.record as record
        import enthusia_datasets.secret_scan as secret_scan
        import enthusia_datasets.quality as quality
    except ImportError as exc:
        raise RuntimeError(
            "W16 dataset package 'enthusia_datasets' is required for validation. "
            "Add training/datasets to PYTHONPATH (tests do this via conftest.py)."
        ) from exc
    return record, secret_scan, quality


def check_fact_traceability(rec: dict, registry: FixtureRegistry) -> list[str]:
    problems = []
    for i, fact in enumerate(rec.get("facts", [])):
        if not registry.is_traceable(
            fact.get("claim", ""), fact.get("source", ""), fact.get("source_version", "")
        ):
            problems.append(
                f"{rec['id']}: facts[{i}] not traceable to fixture registry "
                f"(source={fact.get('source')!r} version={fact.get('source_version')!r})"
            )
    return problems


def check_factual_completeness(rec: dict) -> list[str]:
    if rec.get("quality") in _FACTS_EXEMPT_QUALITIES:
        return []
    if _FACTS_EXEMPT_TAGS.intersection(t.lower() for t in rec.get("tags", [])):
        return []
    if rec.get("expected_answer", "").strip() and not rec.get("facts"):
        return [f"{rec['id']}: factual record has no traceable facts"]
    return []


def check_coverage(records: list[dict]) -> list[str]:
    problems = []
    cats = {t for r in records for t in r.get("tags", []) if t in CATEGORIES}
    missing_cats = [c for c in CATEGORIES if c not in cats]
    if missing_cats:
        problems.append(f"category coverage missing: {missing_cats}")
    forms = {r.get("variation_form") for r in records}
    missing_forms = [f for f in FORMS if f not in forms]
    if missing_forms:
        problems.append(f"variation-form coverage missing: {missing_forms}")
    adv = [r for r in records if "adversarial" in r.get("tags", [])]
    missing_adv = [t for t, c in coverage_by_type(adv).items() if c == 0]
    if missing_adv:
        problems.append(f"adversarial-type coverage missing: {missing_adv}")
    if len(records) < MIN_CORPUS_SIZE:
        problems.append(
            f"corpus has {len(records)} records, minimum is {MIN_CORPUS_SIZE}"
        )
    return problems


def validate_corpus(records: list[dict], registry: FixtureRegistry) -> dict:
    """Full validation pass. Returns a report dict with problems + stats."""
    record_mod, secret_scan_mod, quality_mod = _w16()
    problems: list[str] = []
    quality_labels: dict[str, int] = {}
    ids = set()

    for rec in records:
        rid = rec.get("id", "?")
        if rid in ids:
            problems.append(f"duplicate record id: {rid!r}")
        ids.add(rid)
        try:
            record_mod.validate_record(rec)
        except Exception as exc:  # RecordValidationError
            problems.append(f"{rid}: schema invalid: {exc}")
            continue
        findings = secret_scan_mod.scan_record(rec)
        if findings:
            problems.append(
                f"{rid}: secret scan hit: {sorted({f.pattern for f in findings})}"
            )
        problems.extend(check_fact_traceability(rec, registry))
        problems.extend(check_factual_completeness(rec))
        label = quality_mod.assess_quality(rec).label
        quality_labels[label] = quality_labels.get(label, 0) + 1

    problems.extend(check_coverage(records))

    by_category = {}
    for rec in records:
        for tag in rec.get("tags", []):
            if tag in CATEGORIES:
                by_category[tag] = by_category.get(tag, 0) + 1

    return {
        "record_count": len(records),
        "problems": problems,
        "valid": not problems,
        "quality_labels": dict(sorted(quality_labels.items())),
        "by_category": dict(sorted(by_category.items())),
        "adversarial_by_type": coverage_by_type(
            [r for r in records if "adversarial" in r.get("tags", [])]
        ),
    }
