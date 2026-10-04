"""Enthusia AI dataset foundation (W16).

Deterministic preprocessing pipeline for normalized training datasets:

- schema validation per MASTER-SPECIFICATION section 27
- secret scanning (credential patterns are REJECTED, never trained on)
- deduplication (normalized text, semantic-similarity placeholder, shared source)
- deterministic train/validation/test splits with frozen-partition guards
- quality metadata (spec section 4 candidate labels)
- immutable dataset versioning with hash manifests

All steps are deterministic: same input + same seed/config -> byte-identical output.
"""

from .record import (
    SOURCE_TYPES,
    VISIBILITIES,
    QUALITY_LABELS,
    MESSAGE_ROLES,
    RecordValidationError,
    validate_record,
)
from .normalize import canonical_text, normalize_record, canonical_json, sha256_text
from .secret_scan import SecretFinding, scan_record, record_has_secrets
from .dedupe import (
    SimilarityScorer,
    TrigramSimilarity,
    leak_group_key,
    canonical_hash,
    dedupe_records,
)
from .quality import assess_quality, QUALITY_REASONS
from .splits import (
    FROZEN_PARTITIONS,
    FrozenPartitionError,
    SplitConfig,
    assert_not_frozen,
    split_records,
    build_special_partitions,
    tune_guard,
)
from .versioning import (
    dataset_version_id,
    next_version_number,
    parse_version_id,
    sha256_file,
    build_manifest,
    write_manifest,
)
from .pipeline import build_dataset, PipelineConfig, PipelineResult

__all__ = [
    "SOURCE_TYPES",
    "VISIBILITIES",
    "QUALITY_LABELS",
    "MESSAGE_ROLES",
    "RecordValidationError",
    "validate_record",
    "canonical_text",
    "normalize_record",
    "canonical_json",
    "sha256_text",
    "SecretFinding",
    "scan_record",
    "record_has_secrets",
    "SimilarityScorer",
    "TrigramSimilarity",
    "leak_group_key",
    "canonical_hash",
    "dedupe_records",
    "assess_quality",
    "QUALITY_REASONS",
    "FROZEN_PARTITIONS",
    "FrozenPartitionError",
    "SplitConfig",
    "assert_not_frozen",
    "split_records",
    "build_special_partitions",
    "dataset_version_id",
    "next_version_number",
    "parse_version_id",
    "sha256_file",
    "build_manifest",
    "write_manifest",
    "build_dataset",
    "PipelineConfig",
    "PipelineResult",
]
