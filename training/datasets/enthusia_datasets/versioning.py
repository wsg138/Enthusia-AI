"""Immutable dataset versioning per TRAINING-AND-EVALUATION-SPEC section 9.

Every immutable release gets an ID such as:

    enthusia-ai-dataset-2026.10.03-v1

The manifest includes: source sets, counts, filters, generator model/version,
preprocessing commit, exclusions, and hashes. Never silently change a dataset
used for a benchmark/training run: bump the version instead.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone

from .normalize import canonical_json

_VERSION_RE = re.compile(r"^enthusia-ai-dataset-(\d{4}\.\d{2}\.\d{2})-v(\d+)$")
MANIFEST_FILENAME = "manifest.json"


def dataset_version_id(date_str: str, n: int) -> str:
    """Build a version id like enthusia-ai-dataset-2026.10.03-v1."""
    if not re.fullmatch(r"\d{4}\.\d{2}\.\d{2}", date_str):
        raise ValueError(f"date must be YYYY.MM.DD, got {date_str!r}")
    if n < 1:
        raise ValueError(f"version number must be >= 1, got {n}")
    return f"enthusia-ai-dataset-{date_str}-v{n}"


def parse_version_id(version_id: str) -> tuple[str, int]:
    m = _VERSION_RE.fullmatch(version_id)
    if not m:
        raise ValueError(f"invalid dataset version id: {version_id!r}")
    return m.group(1), int(m.group(2))


def next_version_number(date_str: str, manifests_dir: str) -> int:
    """Next vN for a date, scanning existing manifests (1 if none)."""
    best = 0
    if os.path.isdir(manifests_dir):
        for name in sorted(os.listdir(manifests_dir)):
            path = os.path.join(manifests_dir, name, MANIFEST_FILENAME)
            if not os.path.isfile(path):
                continue
            try:
                with open(path, encoding="utf-8") as fh:
                    manifest = json.load(fh)
                vdate, vn = parse_version_id(manifest["dataset_version"])
            except (KeyError, ValueError, json.JSONDecodeError):
                continue
            if vdate == date_str:
                best = max(best, vn)
    return best + 1


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest(
    *,
    dataset_version: str,
    seed: int,
    split_config: dict,
    source_sets: list[str],
    counts: dict[str, int],
    filters: dict,
    generator: dict,
    preprocessing_commit: str,
    exclusions: dict,
    file_hashes: dict[str, str],
    frozen_partitions: list[str],
    created_at: str | None = None,
) -> dict:
    """Build the immutable release manifest (deterministically ordered)."""
    parse_version_id(dataset_version)  # validate shape
    manifest = {
        "dataset_version": dataset_version,
        "created_at": created_at
        or datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        ),
        "seed": seed,
        "split_config": dict(sorted(split_config.items())),
        "source_sets": sorted(source_sets),
        "counts": dict(sorted(counts.items())),
        "filters": dict(sorted(filters.items())),
        "generator": dict(sorted(generator.items())),
        "preprocessing_commit": preprocessing_commit,
        "exclusions": dict(sorted(exclusions.items())),
        "frozen_partitions": sorted(frozen_partitions),
        "hashes": dict(sorted(file_hashes.items())),
    }
    return manifest


def write_manifest(manifest: dict, path: str) -> str:
    """Write manifest as canonical JSON. Returns the sha256 of the file."""
    text = canonical_json(manifest) + "\n"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return sha256_file(path)
