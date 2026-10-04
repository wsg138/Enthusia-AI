"""Deterministic corpus builder (W17 sample corpus).

Renders every defined (scenario, form) pair into W16 records, validates the
result, and writes the corpus JSONL plus a provenance manifest.

The manifest records everything W16's versioning needs in its ``generator``
field: generator name/version, seed, fixture source versions, and the corpus
sha256 — so a dataset built from this corpus is fully reproducible.

CLI:  python -m enthusia_generation.corpus --out training/generation/corpus
      (also installed as the ``generate-corpus`` console script)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

from . import adversarial, qa, traces, validate
from .fixtures import FixtureRegistry
from .records import GENERATOR_NAME, iter_records

DEFAULT_SEED = 17017
DEFAULT_CREATED_AT = "2026-10-03T16:00:00Z"
DEFAULT_PREFIX = "w17"
CORPUS_FILENAME = "w17-sample-corpus.jsonl"
MANIFEST_FILENAME = "corpus-manifest.json"


def build_corpus(
    registry: FixtureRegistry,
    seed: int = DEFAULT_SEED,
    created_at: str = DEFAULT_CREATED_AT,
    record_id_prefix: str = DEFAULT_PREFIX,
) -> list[dict]:
    """Render the full sample corpus deterministically."""
    return iter_records(
        registry,
        record_id_prefix=record_id_prefix,
        start=1,
        seed=seed,
        created_at=created_at,
    )


def kind_of(rec: dict) -> str:
    if "adversarial" in rec.get("tags", []):
        return "adversarial"
    if any(m.get("role") == "tool" for m in rec.get("messages", [])):
        return "trace"
    return "qa"


def build_manifest(
    records: list[dict],
    registry: FixtureRegistry,
    validation_report: dict,
    seed: int,
    created_at: str,
    corpus_sha256: str,
) -> dict:
    by_kind: dict[str, int] = {}
    for rec in records:
        k = kind_of(rec)
        by_kind[k] = by_kind.get(k, 0) + 1
    return {
        "generator": {
            "name": GENERATOR_NAME,
            "seed": seed,
            "created_at": created_at,
            "fixture_source_versions": registry.versions(),
        },
        "corpus_file": CORPUS_FILENAME,
        "corpus_sha256": corpus_sha256,
        "record_count": len(records),
        "counts_by_kind": dict(sorted(by_kind.items())),
        "counts_by_category": validation_report.get("by_category", {}),
        "adversarial_by_type": validation_report.get("adversarial_by_type", {}),
        "quality_labels": validation_report.get("quality_labels", {}),
        "validation": {
            "valid": validation_report.get("valid"),
            "problem_count": len(validation_report.get("problems", [])),
        },
    }


def write_corpus(records: list[dict], out_dir: str) -> tuple[str, str]:
    """Write corpus JSONL deterministically. Returns (path, sha256)."""
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, CORPUS_FILENAME)
    h = hashlib.sha256()
    with open(path, "w", encoding="utf-8") as fh:
        for rec in records:
            line = json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n"
            fh.write(line)
            h.update(line.encode("utf-8"))
    return path, h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate the W17 synthetic sample corpus.")
    ap.add_argument("--out", required=True, help="output directory for corpus + manifest")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--created-at", default=DEFAULT_CREATED_AT)
    ap.add_argument("--prefix", default=DEFAULT_PREFIX, help="record id prefix")
    ap.add_argument("--fixtures", default=None, help="override fixtures/sources.json path")
    args = ap.parse_args(argv)

    registry = (
        FixtureRegistry.load(args.fixtures) if args.fixtures
        else FixtureRegistry.load()
    )
    records = build_corpus(registry, seed=args.seed, created_at=args.created_at,
                           record_id_prefix=args.prefix)

    # Module-level structural checks (kind-specific, fast).
    problems: list[str] = []
    problems.extend(qa.check_qa([r for r in records if kind_of(r) == "qa"]))
    problems.extend(traces.check_traces([r for r in records if kind_of(r) == "trace"]))
    problems.extend(adversarial.check_adversarial([r for r in records if kind_of(r) == "adversarial"]))

    report = validate.validate_corpus(records, registry)
    problems.extend(report["problems"])

    corpus_path, digest = write_corpus(records, args.out)
    manifest = build_manifest(records, registry, report, args.seed, args.created_at, digest)
    manifest["validation"]["structural_problems"] = problems
    manifest_path = os.path.join(args.out, MANIFEST_FILENAME)
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False, sort_keys=True)
        fh.write("\n")

    print(f"records: {len(records)} -> {corpus_path}")
    print(f"manifest: {manifest_path}")
    print(f"valid: {report['valid']}, problems: {len(problems)}")
    for p in problems[:20]:
        print(f"  PROBLEM: {p}")
    return 0 if report["valid"] and not problems else 1


if __name__ == "__main__":
    sys.exit(main())
