"""Fail-closed release authorization for real GPU training.

A dataset being assembled is not enough to authorize training.  The GPU runner
requires a release record that binds the exact W16 train/validation bytes, the
training config, owner-review gates, and the pre-training W20 evaluation state.

The record is deliberately content-free: it stores hashes and approval state,
never ticket text or identities.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass


class TrainingReleaseError(RuntimeError):
    """Raised when a GPU training release is absent, stale, or incomplete."""


@dataclass(frozen=True)
class VerifiedTrainingRelease:
    dataset_version: str
    train_sha256: str
    validation_sha256: str
    config_sha256: str
    w20_report_sha256: str
    release_sha256: str


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _required_bool(obj: dict, key: str, where: str) -> None:
    if obj.get(key) is not True:
        raise TrainingReleaseError(f"{where}.{key} must be explicitly true")


def _required_hash(obj: dict, key: str, where: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or len(value) != 64:
        raise TrainingReleaseError(f"{where}.{key} must be a 64-character SHA-256")
    try:
        int(value, 16)
    except ValueError as exc:
        raise TrainingReleaseError(f"{where}.{key} is not hexadecimal") from exc
    return value.lower()


def verify_training_release(
    *,
    release_path: str,
    dataset_manifest_path: str,
    train_path: str,
    validation_path: str,
    config_path: str,
    w20_report_path: str,
    expected_dataset_version: str,
) -> VerifiedTrainingRelease:
    for label, path in (
        ("release", release_path),
        ("dataset manifest", dataset_manifest_path),
        ("train dataset", train_path),
        ("validation dataset", validation_path),
        ("training config", config_path),
        ("W20 report", w20_report_path),
    ):
        if not os.path.isfile(path):
            raise TrainingReleaseError(f"{label} not found: {path}")

    with open(dataset_manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    with open(release_path, encoding="utf-8") as fh:
        release = json.load(fh)

    if not isinstance(manifest, dict) or not isinstance(release, dict):
        raise TrainingReleaseError("release and dataset manifest must be JSON objects")

    version = manifest.get("dataset_version")
    if version != expected_dataset_version:
        raise TrainingReleaseError(
            f"dataset manifest version {version!r} does not match config "
            f"{expected_dataset_version!r}"
        )
    if release.get("dataset_version") != expected_dataset_version:
        raise TrainingReleaseError("release dataset_version does not match the training config")

    _required_bool(release, "approved_for_gpu_training", "release")

    owner = release.get("owner_review")
    if not isinstance(owner, dict):
        raise TrainingReleaseError("release.owner_review must be an object")
    _required_bool(owner, "exact_10_approved", "release.owner_review")
    _required_bool(owner, "exact_30_approved", "release.owner_review")
    approved_at = owner.get("approved_at")
    if not isinstance(approved_at, str) or not approved_at.strip():
        raise TrainingReleaseError("release.owner_review.approved_at is required")
    reference = owner.get("reference")
    if not isinstance(reference, str) or not reference.strip():
        raise TrainingReleaseError("release.owner_review.reference is required")

    w20 = release.get("w20")
    if not isinstance(w20, dict):
        raise TrainingReleaseError("release.w20 must be an object")
    _required_bool(w20, "baseline_passed", "release.w20")

    actual_train = sha256_file(train_path)
    actual_validation = sha256_file(validation_path)
    actual_config = sha256_file(config_path)
    actual_w20 = sha256_file(w20_report_path)

    outputs = manifest.get("outputs")
    if not isinstance(outputs, dict):
        raise TrainingReleaseError("dataset manifest outputs are missing")
    manifest_train = outputs.get("train")
    manifest_validation = outputs.get("validation")
    if not isinstance(manifest_train, dict) or not isinstance(manifest_validation, dict):
        raise TrainingReleaseError("dataset manifest train/validation outputs are missing")
    if manifest_train.get("sha256") != actual_train:
        raise TrainingReleaseError("train.jsonl hash does not match the W16 manifest")
    if manifest_validation.get("sha256") != actual_validation:
        raise TrainingReleaseError("validation.jsonl hash does not match the W16 manifest")

    expected = {
        "train_sha256": actual_train,
        "validation_sha256": actual_validation,
        "config_sha256": actual_config,
        "w20_report_sha256": actual_w20,
    }
    for key, actual in expected.items():
        if _required_hash(release, key, "release") != actual:
            raise TrainingReleaseError(f"release {key} does not match the current file")

    return VerifiedTrainingRelease(
        dataset_version=expected_dataset_version,
        train_sha256=actual_train,
        validation_sha256=actual_validation,
        config_sha256=actual_config,
        w20_report_sha256=actual_w20,
        release_sha256=sha256_file(release_path),
    )
