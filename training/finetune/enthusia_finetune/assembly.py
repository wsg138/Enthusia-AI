"""Dataset assembly for fine-tuning.

Combines the W16/W17/W18 corpora into train/validation splits:

1. Load each corpus JSONL (records follow the MASTER-SPEC section 27
   contract; see `record.py`).
2. Validate records; invalid records are excluded with a logged reason.
3. Quality/visibility filter: only explicitly reviewed GOOD/IDEAL records
   with trainable visibility may enter training data (spec sections 4/10).
4. Deduplicate by exact canonical text (keep earliest id), reporting dupes.
5. Split by leak-group — records sharing a template_id / ticket_id /
   thread_id / scenario hash always land in the same partition, so
   near-duplicates and template variants can never leak across
   train/validation (TRAINING-AND-EVALUATION-SPEC section 8). Assignment is
   deterministic: sorted groups + seeded shuffle.
6. Route special-partition tags (golden, adversarial, stale-truth,
   privacy, tool-failure) out of train/validation into their own files —
   they belong to evaluation, never tuning (spec section 7).
7. Write train.jsonl, validation.jsonl, the special-partition files, and
   manifest.json with source sets, counts, filters, generator info,
   exclusions and hashes (spec section 9).
"""

from __future__ import annotations

import hashlib
import json
import os
import random
from dataclasses import dataclass

from .record import (
    SPECIAL_PARTITIONS,
    RecordValidationError,
    canonical_hash,
    canonical_json,
    leak_group_key,
    quality_excluded,
    scan_record,
    validate_record,
)


@dataclass(frozen=True)
class SplitConfig:
    train_ratio: float = 0.85
    validation_ratio: float = 0.15
    seed: int = 1337

    def __post_init__(self):
        total = self.train_ratio + self.validation_ratio
        if abs(total - 1.0) > 1e-9:
            raise ValueError(f"split ratios must sum to 1.0, got {total}")
        if min(self.train_ratio, self.validation_ratio) < 0:
            raise ValueError("split ratios must be non-negative")


@dataclass
class AssemblyStats:
    loaded: int = 0
    invalid: int = 0
    excluded: int = 0
    duplicates: int = 0
    special: int = 0
    train: int = 0
    validation: int = 0
    exclusions: list = None  # type: ignore[assignment]
    duplicates_info: list = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.exclusions is None:
            self.exclusions = []
        if self.duplicates_info is None:
            self.duplicates_info = []


def load_jsonl(path: str) -> list[dict]:
    records = []
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
            if not isinstance(obj, dict):
                raise ValueError(f"{path}:{lineno}: expected a JSON object")
            records.append(obj)
    return records


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def split_by_leak_group(
    records: list[dict], config: SplitConfig | None = None
) -> tuple[list[dict], list[dict]]:
    """Deterministic train/validation split; whole leak groups stay together."""
    config = config or SplitConfig()
    groups: dict[str, list[dict]] = {}
    for rec in sorted(records, key=lambda r: r["id"]):
        groups.setdefault(leak_group_key(rec), []).append(rec)

    group_keys = sorted(groups)
    rng = random.Random(config.seed)
    shuffled = list(group_keys)
    rng.shuffle(shuffled)

    n = len(shuffled)
    n_val = round(n * config.validation_ratio)
    if n > 1 and config.validation_ratio > 0 and n_val == 0:
        n_val = 1
    n_val = min(n_val, n)
    val_keys = set(shuffled[:n_val])

    train, validation = [], []
    for key in shuffled:
        (validation if key in val_keys else train).extend(groups[key])
    return train, validation


def assemble(
    corpus_paths: list[str],
    out_dir: str,
    *,
    dataset_version: str,
    generator: str = "enthusia-finetune-assemble",
    split_config: SplitConfig | None = None,
    corpus_labels: dict[str, str] | None = None,
) -> dict:
    """Assemble train/validation datasets from corpus JSONL files.

    Returns the manifest dict (also written to out_dir/manifest.json).
    """
    split_config = split_config or SplitConfig()
    stats = AssemblyStats()
    sources: list[dict] = []

    validated: list[dict] = []
    for path in corpus_paths:
        label = (corpus_labels or {}).get(path, os.path.basename(path))
        raw_records = load_jsonl(path)
        stats.loaded += len(raw_records)
        sources.append(
            {
                "label": label,
                "path": path,
                "records": len(raw_records),
                "sha256": _hash_file(path),
            }
        )
        for raw in raw_records:
            try:
                rec = validate_record(raw)
            except RecordValidationError as exc:
                stats.invalid += 1
                stats.exclusions.append({"id": raw.get("id"), "reason": f"invalid: {exc}"})
                continue
            reason = quality_excluded(rec)
            if reason:
                stats.excluded += 1
                stats.exclusions.append({"id": rec["id"], "reason": reason})
                continue
            findings = scan_record(rec)
            if findings:
                stats.excluded += 1
                stats.exclusions.append(
                    {
                        "id": rec["id"],
                        "reason": "secret detected by W16",
                        "patterns": sorted({finding.pattern for finding in findings}),
                    }
                )
                continue
            validated.append(rec)

    # Dedupe by exact canonical text (keep lowest id).
    seen: dict[str, str] = {}
    deduped: list[dict] = []
    for rec in sorted(validated, key=lambda r: r["id"]):
        h = canonical_hash(rec)
        if h in seen:
            stats.duplicates += 1
            stats.duplicates_info.append(
                {"id": rec["id"], "duplicate_of": seen[h], "reason": "exact_text"}
            )
            continue
        seen[h] = rec["id"]
        deduped.append(rec)

    # Route special-partition tags out of training data. A record may belong
    # to more than one evaluation partition (for example adversarial+privacy);
    # preserve every canonical W16 membership instead of dropping all but one.
    special: dict[str, list[dict]] = {}
    trainable: list[dict] = []
    for rec in deduped:
        partitions = {
            SPECIAL_PARTITIONS[tag.lower()]
            for tag in rec.get("tags", [])
            if isinstance(tag, str) and tag.lower() in SPECIAL_PARTITIONS
        }
        if partitions:
            for partition in sorted(partitions):
                special.setdefault(partition, []).append(rec)
            stats.special += 1
        else:
            trainable.append(rec)

    train, validation = split_by_leak_group(trainable, split_config)
    stats.train = len(train)
    stats.validation = len(validation)

    # Write outputs.
    os.makedirs(out_dir, exist_ok=True)

    def _write(name: str, records: list[dict]) -> dict:
        path = os.path.join(out_dir, name)
        ordered = sorted(records, key=lambda r: r["id"])
        with open(path, "w", encoding="utf-8") as fh:
            for rec in ordered:
                fh.write(canonical_json(rec) + "\n")
        return {"path": name, "records": len(ordered), "sha256": _hash_file(path)}

    outputs = {
        "train": _write("train.jsonl", train),
        "validation": _write("validation.jsonl", validation),
    }
    special_outputs = {}
    for part, recs in sorted(special.items()):
        special_outputs[part] = _write(f"{part}.jsonl", recs)

    manifest = {
        "dataset_version": dataset_version,
        "generator": generator,
        "split": {
            "train_ratio": split_config.train_ratio,
            "validation_ratio": split_config.validation_ratio,
            "seed": split_config.seed,
            "method": "leak_group",
        },
        "source_sets": sources,
        "counts": {
            "loaded": stats.loaded,
            "invalid": stats.invalid,
            "excluded": stats.excluded,
            "duplicates": stats.duplicates,
            "special_partitions": stats.special,
            "train": stats.train,
            "validation": stats.validation,
        },
        "filters": [
            "only explicit quality in {GOOD, IDEAL} admitted to training",
            "visibility in {private, owner} excluded",
            "W16 secret-scan findings excluded",
            "exact-text duplicates removed (keep lowest id)",
            "special-partition tags routed out of train/validation",
        ],
        "exclusions": stats.exclusions,
        "duplicates": stats.duplicates_info,
        "outputs": outputs,
        "special_outputs": special_outputs,
    }
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return manifest


__all__ = [
    "SplitConfig",
    "AssemblyStats",
    "load_jsonl",
    "split_by_leak_group",
    "assemble",
]
