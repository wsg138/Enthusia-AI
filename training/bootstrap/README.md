# Training Bootstrap

This directory is deliberately isolated from W16–W20 while those workstreams are still being integrated.

Its job is to prepare **source material and hardware/model benchmarking**, not to replace the dataset, synthetic-corpus, ticket-corpus, fine-tune, or evaluation pipelines.

## What can run immediately

1. `pc_preflight.py` — records the local machine's GPU/RAM/disk/software capabilities.
2. `collect_github_sources.py` — shallow-clones one approved repository at a time, streams it into a compressed versioned source-material corpus, and deletes the temporary clone before continuing.
3. Later, W17 can consume the collected source material to generate source-grounded synthetic examples.
4. W16 remains the canonical normalized training-dataset pipeline.

## One-command local start

On the owner's Windows PC, from this repository:

```powershell
python training/bootstrap/pc_preflight.py --output training/bootstrap/artifacts/pc-preflight.json
python training/bootstrap/collect_github_sources.py --manifest training/bootstrap/repositories.json --workspace D:\Enthusia-AI-SourceCache --output training/bootstrap/artifacts/github-source-corpus.jsonl.gz --summary training/bootstrap/artifacts/github-source-summary.json
```

The collector uses the local `gh` CLI for cloning so authentication remains outside the corpus and outside model-visible data.

## Important semantics

- Repository content is **source material**, not automatically a training example.
- Mutable Enthusia facts should remain retrieval/live-tool knowledge.
- Production truth must distinguish Git main from actually deployed versions.
- Staging/test repositories are labelled non-production references.
- Secret/credential paths, build outputs, dependencies, generated binaries, archives, logs, and large assets are excluded.
- The output stores repository + commit SHA + path + content hash for every accepted document.
- No API token is stored in output.
- Real ticket extraction remains under the W18 governance/signoff gate and is not performed here.

## Model candidates

See `model-candidates.json`. The current primary benchmark pair is:

- Qwen3.5-35B-A3B
- Qwen3-30B-A3B

Do not spend rented-GPU budget until the local preflight and baseline benchmark are recorded.

## Low-storage behavior

The default collector is designed for the owner's limited local free space:

- only one repository is cloned at a time;
- clones are shallow and blob-filtered;
- each clone is deleted immediately after harvesting;
- the source corpus is gzip-compressed while it is written;
- build outputs, binaries, logs, databases, backups, and large files are excluded.

Use `--keep-repos` only when there is intentionally enough disk space.


## Training-truth policy

Synthetic examples are not allowed to teach a server fact merely because a model inferred it or an old source mentioned something similar.

Before an example can become training data:

- commands, ranks, permissions, prices, plugin behavior, server addresses, and other mutable Enthusia facts must be directly supported by current authoritative evidence;
- repository `main` is not enough to prove deployed runtime truth when deployment state matters;
- stale/test/staging/historical values must not be promoted as current facts;
- unsupported assumptions must be rejected rather than "made plausible";
- exact evidence + source SHA/path must remain attached through generation and validation;
- generated questions must not ask for a broader fact than the selected evidence actually proves;
- generated answers must not introduce factual paraphrases that strengthen or alter the evidence.

Current owner corrections that must be treated as negative regression cases, not training facts:

- Enthusia does **not** have an `Elite` rank;
- normal players do **not** have a general `/fly` command.

These examples exist specifically to catch hallucinated/stale server knowledge. If future live authoritative evidence changes either fact, the current-source verification layer wins and this bootstrap note must be updated before regenerating training data.
