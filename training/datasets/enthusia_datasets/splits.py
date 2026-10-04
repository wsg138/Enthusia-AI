"""Deterministic train/validation/test splits with frozen-partition guards.

- Assignment is group-based: records sharing a leak_group_key (same
  template/thread/scenario) always land in the same partition, so
  near-duplicates can never leak across train/test (spec section 8).
- Assignment is deterministic: sorted groups + seeded RNG. Same input,
  seed, and ratios -> same split, every run.
- Frozen partitions (test, owner_golden) may never be used for tuning.
  Any tuning-oriented operation targeting a frozen partition raises
  FrozenPartitionError (spec section 7: do not tune on frozen test data).

Special partitions (spec section 7): owner_golden, adversarial, stale_truth,
privacy_security, tool_failure — built from record tags.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .dedupe import leak_group_key

TRAIN = "train"
VALIDATION = "validation"
TEST = "test"

# Partitions that must never be tuned on once frozen.
FROZEN_PARTITIONS = frozenset({TEST, "owner_golden"})

# tag -> special partition name
SPECIAL_PARTITIONS: dict[str, str] = {
    "golden": "owner_golden",
    "adversarial": "adversarial",
    "stale-truth": "stale_truth",
    "privacy": "privacy_security",
    "tool-failure": "tool_failure",
}


class FrozenPartitionError(RuntimeError):
    """Raised when a tuning operation targets a frozen partition."""


def assert_not_frozen(partition: str, operation: str = "tune") -> None:
    if partition in FROZEN_PARTITIONS:
        raise FrozenPartitionError(
            f"refusing to {operation} on frozen partition {partition!r}: "
            "frozen evaluation data must never be used for tuning"
        )


@dataclass(frozen=True)
class SplitConfig:
    train_ratio: float = 0.8
    validation_ratio: float = 0.1
    test_ratio: float = 0.1
    seed: int = 1337

    def __post_init__(self):
        total = self.train_ratio + self.validation_ratio + self.test_ratio
        if abs(total - 1.0) > 1e-9:
            raise ValueError(f"split ratios must sum to 1.0, got {total}")
        if min(self.train_ratio, self.validation_ratio, self.test_ratio) < 0:
            raise ValueError("split ratios must be non-negative")


def split_records(
    records: list[dict], config: SplitConfig | None = None
) -> dict[str, list[dict]]:
    """Deterministically split records into train/validation/test.

    Groups by leak_group_key so near-duplicate scenarios stay together.
    Returns {partition: [records sorted by id]}.
    """
    config = config or SplitConfig()
    ordered = sorted(records, key=lambda r: r["id"])

    # Group ids by leak key (deterministic group order).
    groups: dict[str, list[dict]] = {}
    for rec in ordered:
        groups.setdefault(leak_group_key(rec), []).append(rec)
    group_keys = sorted(groups)

    rng = random.Random(config.seed)
    shuffled = list(group_keys)
    rng.shuffle(shuffled)

    n = len(shuffled)
    n_test = round(n * config.test_ratio)
    n_val = round(n * config.validation_ratio)
    # Guard against rounding swallowing everything on tiny inputs.
    if n > 0 and config.test_ratio > 0 and n_test == 0:
        n_test = 1
    if n > 1 and config.validation_ratio > 0 and n_val == 0:
        n_val = 1
    n_test = min(n_test, n)
    n_val = min(n_val, n - n_test)

    test_keys = set(shuffled[:n_test])
    val_keys = set(shuffled[n_test : n_test + n_val])

    out: dict[str, list[dict]] = {TRAIN: [], VALIDATION: [], TEST: []}
    for key in group_keys:
        if key in test_keys:
            out[TEST].extend(groups[key])
        elif key in val_keys:
            out[VALIDATION].extend(groups[key])
        else:
            out[TRAIN].extend(groups[key])

    for part in out:
        out[part] = sorted(out[part], key=lambda r: r["id"])
    return out


def build_special_partitions(records: list[dict]) -> dict[str, list[dict]]:
    """Build auxiliary evaluation partitions from record tags.

    owner_golden / adversarial / stale_truth / privacy_security / tool_failure.
    A record may appear in multiple special partitions; these are evaluation
    sets and never merged into train. owner_golden is frozen.
    """
    out: dict[str, list[dict]] = {name: [] for name in SPECIAL_PARTITIONS.values()}
    for rec in sorted(records, key=lambda r: r["id"]):
        tags = {t.lower() for t in rec.get("tags", []) if isinstance(t, str)}
        for tag, partition in SPECIAL_PARTITIONS.items():
            if tag in tags:
                out[partition].append(rec)
    return out


def tune_guard(partitions: dict[str, list[dict]], operation: str = "tune") -> None:
    """Fail closed: raise if any frozen partition is non-empty in a tuning run."""
    for partition in FROZEN_PARTITIONS:
        if partitions.get(partition):
            raise FrozenPartitionError(
                f"refusing to {operation}: frozen partition {partition!r} is present "
                f"({len(partitions[partition])} records) — tuning on frozen "
                "evaluation data is forbidden"
            )
