# Training datasets — dataset foundation (W16)

Versioned, normalized training-dataset infrastructure for Enthusia AI.
Implements [TRAINING-AND-EVALUATION-SPEC](../../docs/TRAINING-AND-EVALUATION-SPEC.md)
sections 2–10 and [MASTER-SPECIFICATION](../../docs/MASTER-SPECIFICATION.md)
sections 26–27.

Training stack is Python (spec §9.3).

## Layout

```
training/datasets/
├── enthusia_datasets/      # the pipeline package
│   ├── record.py           # schema validation (spec §27 record format)
│   ├── normalize.py        # deterministic normalization / canonical text+JSON
│   ├── secret_scan.py      # credential-pattern scan — matches REJECT records
│   ├── dedupe.py           # normalized-text / similarity-placeholder / shared-source dedupe
│   ├── quality.py          # quality metadata (spec §4 candidate labels)
│   ├── splits.py           # deterministic train/validation/test + frozen guards
│   ├── versioning.py       # immutable version ids + hash manifests (spec §9)
│   └── pipeline.py         # end-to-end build orchestration + CLI
├── fixtures/
│   └── examples.jsonl      # 24 synthetic example records (NO real ticket data)
├── tests/                  # pytest suite (62 tests)
├── manifests/              # registry of issued manifests (version numbering)
└── pyproject.toml
```

## Record format (spec §27)

```json
{
  "id": "...",
  "source_type": "synthetic|ticket|staff|evaluation",
  "visibility": "public|staff|private|owner",
  "scenario": "...",
  "messages": [{"role": "user|assistant|system|tool", "content": "..."}],
  "tools": [...],
  "expected_actions": [...],
  "expected_answer": "...",
  "facts": [{"claim": "...", "source": "...", "source_version": "..."}],
  "tags": [...],
  "quality": "IDEAL|GOOD|USABLE_WITH_EDIT|BAD_RESPONSE|OUTDATED|INCOMPLETE|PRIVATE_EXCLUDE",
  "created_at": "ISO-8601",
  "dataset_version": "enthusia-ai-dataset-YYYY.MM.DD-vN"
}
```

Optional dedupe/versioning metadata: `thread_id`, `template_id`, `generator`.
The pipeline stamps `dataset_version` and adds `quality_metadata`.

## Build a dataset

```bash
cd training/datasets
python3 -m enthusia_datasets build \
  --input fixtures/examples.jsonl \
  --out /tmp/dataset-out \
  --manifests-dir manifests \
  --date 2026.10.03 \
  --preprocessing-commit <git-sha>
```

Pipeline stages: ingest → validate → normalize → **secret scan (reject)** →
dedupe → quality assessment → version stamp → split → write partitions + manifest.

Output: `train.jsonl`, `validation.jsonl`, `test.jsonl`,
`owner_golden.jsonl`, `adversarial.jsonl`, `stale_truth.jsonl`,
`privacy_security.jsonl`, `tool_failure.jsonl`, `manifest.json`.

## Frozen partitions

`test` and `owner_golden` are **frozen**: tuning on them is forbidden.
`assert_not_frozen()` / `tune_guard()` raise `FrozenPartitionError` if a tuning
operation targets them (spec §7: do not tune on frozen test data).
Only reviewed `IDEAL` and `GOOD` records enter the ordinary train/validation/test split.
`USABLE_WITH_EDIT`, `BAD_RESPONSE`, `OUTDATED`, `INCOMPLETE`, and
`PRIVATE_EXCLUDE` remain review/evaluation-only until corrected and explicitly
relabeled. This prevents historical or partially curated material from silently
becoming imitation targets.

## Secret policy

Any record matching a credential pattern (API keys, tokens, passwords,
private keys, …) is **rejected** — never redacted-and-kept, never trained on.
Rejections are counted by reason in the manifest `exclusions`.

## Versioning

Immutable version ids: `enthusia-ai-dataset-YYYY.MM.DD-vN`, incrementing per
date from the `manifests/` registry. The manifest records source sets, counts,
filters, generator model/version, preprocessing commit, exclusions, frozen
partitions, and sha256 hashes of every output file. Never silently change a
released dataset — bump the version.

## Determinism

Same input + same seed/config → byte-identical output: sorted iteration,
seeded RNG, canonical JSON, fixed timestamps via `--build-timestamp`.
Covered by `test_deterministic_byte_identical_output`.

## Tests

```bash
python3 -m pytest tests/ -q
```
