"""End-to-end dataset build pipeline.

Stages (all deterministic):
  1. ingest     - load JSONL records from one or more input files
  2. validate   - schema validation per spec section 27 (invalid -> rejected)
  3. normalize  - deterministic normalization, fill created_at
  4. secret scan- any credential pattern -> REJECTED (never trained on)
  5. dedupe     - normalized text / semantic placeholder / shared source
  6. quality    - automated quality metadata assessment
  7. version    - stamp dataset_version, compute next immutable version id
  8. split      - deterministic train/validation/test + special partitions
  9. manifest   - write partitions as JSONL + manifest.json with sha256 hashes

Same input + same config -> byte-identical output directory.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field

from .dedupe import TrigramSimilarity, dedupe_records
from .normalize import canonical_json, normalize_record, sort_structure
from .quality import assess_quality
from .record import RecordValidationError, utcnow_iso, validate_record
from .secret_scan import pattern_names, scan_record
from .splits import (
    FROZEN_PARTITIONS,
    SplitConfig,
    build_special_partitions,
    split_records,
)
from .versioning import (
    MANIFEST_FILENAME,
    dataset_version_id,
    next_version_number,
    sha256_file,
    write_manifest,
    build_manifest,
)

PARTITION_FILES = {
    "train": "train.jsonl",
    "validation": "validation.jsonl",
    "test": "test.jsonl",
    "owner_golden": "owner_golden.jsonl",
    "adversarial": "adversarial.jsonl",
    "stale_truth": "stale_truth.jsonl",
    "privacy_security": "privacy_security.jsonl",
    "tool_failure": "tool_failure.jsonl",
}

DEFAULT_SEED = 1337


@dataclass
class PipelineConfig:
    inputs: list[str]
    out_dir: str
    manifests_dir: str
    date: str                      # YYYY.MM.DD for the version id
    seed: int = DEFAULT_SEED
    preprocessing_commit: str = "unknown"
    generator: dict = field(default_factory=dict)
    split: SplitConfig = field(default_factory=SplitConfig)
    build_timestamp: str | None = None  # fixed for deterministic re-runs
    similarity_threshold: float = 0.85
    # Quality labels excluded from train/validation (kept in eval partitions).
    exclude_from_train: tuple[str, ...] = ("PRIVATE_EXCLUDE", "BAD_RESPONSE")


@dataclass
class PipelineResult:
    dataset_version: str
    manifest: dict
    manifest_path: str
    counts: dict[str, int]
    rejected: list[dict]
    duplicates: list[dict]


def _load_jsonl(paths: list[str]) -> list[dict]:
    records = []
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
                records.append(obj)
    return records


def _write_jsonl(path: str, records: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for rec in sorted(records, key=lambda r: r["id"]):
            fh.write(canonical_json(sort_structure(rec)) + "\n")


def build_dataset(config: PipelineConfig) -> PipelineResult:
    timestamp = config.build_timestamp or utcnow_iso()
    rejected: list[dict] = []

    # 1-3. ingest, validate, normalize
    raw = _load_jsonl(config.inputs)
    normalized: list[dict] = []
    seen_ids: set[str] = set()
    for obj in raw:
        rid = obj.get("id") if isinstance(obj, dict) else None
        try:
            rec = validate_record(obj)
        except RecordValidationError as exc:
            rejected.append({"id": rid, "reason": "schema_invalid", "detail": str(exc)})
            continue
        if rec["id"] in seen_ids:
            rejected.append(
                {
                    "id": rec["id"],
                    "reason": "duplicate_id",
                    "detail": "record id already appeared earlier in the input corpus",
                }
            )
            continue
        seen_ids.add(rec["id"])
        normalized.append(normalize_record(rec, default_created_at=timestamp))

    # 4. secret scan — REJECT on any finding
    clean: list[dict] = []
    for rec in normalized:
        findings = scan_record(rec)
        if findings:
            rejected.append(
                {
                    "id": rec["id"],
                    "reason": "secret_detected",
                    "detail": sorted({f.pattern for f in findings}),
                }
            )
            continue
        clean.append(rec)

    # 5. dedupe
    kept, duplicates = dedupe_records(
        clean, scorer=TrigramSimilarity(threshold=config.similarity_threshold)
    )
    dup_infos = [
        {"id": d.id, "duplicate_of": d.duplicate_of, "reason": d.reason}
        for d in duplicates
    ]

    # 6. quality metadata
    assessed: list[dict] = []
    for rec in kept:
        assessment = assess_quality(rec)
        rec = dict(rec)
        rec["quality_metadata"] = assessment.to_dict()
        if rec.get("quality") is None:
            rec["quality"] = assessment.label
        assessed.append(rec)

    # 7. version stamp
    version_n = next_version_number(config.date, config.manifests_dir)
    version_id = dataset_version_id(config.date, version_n)
    for rec in assessed:
        rec["dataset_version"] = version_id

    # 8. splits. Evaluation-only records must never also enter the ordinary
    #    train/validation/test assignment. Keep every special-partition tag
    #    isolated so adversarial, stale-truth, privacy, tool-failure, and
    #    owner-golden cases cannot leak into training or tuning.
    evaluation_only_tags = frozenset(
        {"golden", "adversarial", "stale-truth", "privacy", "tool-failure"}
    )

    def is_evaluation_only(record: dict) -> bool:
        tags = {
            tag.lower()
            for tag in record.get("tags", [])
            if isinstance(tag, str)
        }
        return bool(tags & evaluation_only_tags)

    trainable = [
        r
        for r in assessed
        if r["quality"] not in config.exclude_from_train and not is_evaluation_only(r)
    ]
    splits = split_records(trainable, config.split)
    special = build_special_partitions(assessed)

    partitions: dict[str, list[dict]] = {**splits, **special}

    # 9. write outputs + manifest
    os.makedirs(config.out_dir, exist_ok=True)
    file_hashes: dict[str, str] = {}
    counts: dict[str, int] = {}
    source_sets = sorted({r.get("source_type", "?") for r in assessed})
    for partition, filename in PARTITION_FILES.items():
        recs = partitions.get(partition, [])
        path = os.path.join(config.out_dir, filename)
        _write_jsonl(path, recs)
        file_hashes[filename] = sha256_file(path)
        counts[partition] = len(recs)

    exclusions = {
        "rejected_total": len(rejected),
        "rejected_by_reason": {},
        "duplicates_total": len(dup_infos),
        "duplicates_by_reason": {},
        "excluded_from_train_labels": sorted(config.exclude_from_train),
    }
    for r in rejected:
        key = r["reason"]
        exclusions["rejected_by_reason"][key] = (
            exclusions["rejected_by_reason"].get(key, 0) + 1
        )
    for d in dup_infos:
        key = d["reason"]
        exclusions["duplicates_by_reason"][key] = (
            exclusions["duplicates_by_reason"].get(key, 0) + 1
        )

    manifest = build_manifest(
        dataset_version=version_id,
        seed=config.seed,
        split_config={
            "train_ratio": config.split.train_ratio,
            "validation_ratio": config.split.validation_ratio,
            "test_ratio": config.split.test_ratio,
            "split_seed": config.split.seed,
            "similarity_threshold": config.similarity_threshold,
        },
        source_sets=source_sets,
        counts=counts,
        filters={
            "secret_patterns": sorted(pattern_names()),
            "secret_policy": "reject",
            "dedupe": ["exact_text", "shared_source", "near_duplicate"],
        },
        generator=config.generator or {"model": "synthetic-fixtures", "version": "v1"},
        preprocessing_commit=config.preprocessing_commit,
        exclusions=exclusions,
        file_hashes=file_hashes,
        frozen_partitions=sorted(FROZEN_PARTITIONS),
        created_at=timestamp,
    )

    manifest_path = os.path.join(config.out_dir, MANIFEST_FILENAME)
    write_manifest(manifest, manifest_path)
    # Copy the manifest into the manifests registry dir for version numbering.
    registry_dir = os.path.join(config.manifests_dir, version_id)
    os.makedirs(registry_dir, exist_ok=True)
    write_manifest(manifest, os.path.join(registry_dir, MANIFEST_FILENAME))

    return PipelineResult(
        dataset_version=version_id,
        manifest=manifest,
        manifest_path=manifest_path,
        counts=counts,
        rejected=rejected,
        duplicates=dup_infos,
    )


def _parse_args(argv: list[str]) -> PipelineConfig:
    p = argparse.ArgumentParser(
        description="Build a versioned, deterministic Enthusia AI dataset."
    )
    p.add_argument("--input", action="append", required=True, dest="inputs",
                   help="input JSONL file (repeatable)")
    p.add_argument("--out", required=True, dest="out_dir", help="output directory")
    p.add_argument("--manifests-dir", default="manifests", dest="manifests_dir",
                   help="registry dir for issued manifests")
    p.add_argument("--date", required=True, help="version date YYYY.MM.DD")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--split-seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--train-ratio", type=float, default=0.8)
    p.add_argument("--validation-ratio", type=float, default=0.1)
    p.add_argument("--test-ratio", type=float, default=0.1)
    p.add_argument("--similarity-threshold", type=float, default=0.85)
    p.add_argument("--preprocessing-commit", default="unknown")
    p.add_argument("--generator-model", default="synthetic-fixtures")
    p.add_argument("--generator-version", default="v1")
    p.add_argument("--build-timestamp", default=None,
                   help="fixed ISO timestamp (for deterministic re-runs)")
    args = p.parse_args(argv)
    return PipelineConfig(
        inputs=args.inputs,
        out_dir=args.out_dir,
        manifests_dir=args.manifests_dir,
        date=args.date,
        seed=args.seed,
        preprocessing_commit=args.preprocessing_commit,
        generator={"model": args.generator_model, "version": args.generator_version},
        split=SplitConfig(
            train_ratio=args.train_ratio,
            validation_ratio=args.validation_ratio,
            test_ratio=args.test_ratio,
            seed=args.split_seed,
        ),
        build_timestamp=args.build_timestamp,
        similarity_threshold=args.similarity_threshold,
    )


def main(argv: list[str] | None = None) -> int:
    config = _parse_args(argv or sys.argv[1:])
    result = build_dataset(config)
    print(f"dataset_version: {result.dataset_version}")
    for partition in sorted(result.counts):
        print(f"  {partition}: {result.counts[partition]}")
    print(f"rejected: {len(result.rejected)}, duplicates: {len(result.duplicates)}")
    print(f"manifest: {result.manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
