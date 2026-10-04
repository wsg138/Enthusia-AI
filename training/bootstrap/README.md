# Training Bootstrap

This directory is deliberately isolated from W16–W20 while those workstreams are still being integrated.

Its job is to prepare **source material and hardware/model benchmarking**, not to replace the dataset, synthetic-corpus, ticket-corpus, fine-tune, or evaluation pipelines.

## What can run immediately

1. `pc_preflight.py` — records the local machine's GPU/RAM/disk/software capabilities.
2. `collect_github_sources.py` — clones/fetches approved Enthusia repositories and emits a versioned source-material JSONL corpus.
3. Later, W17 can consume the collected source material to generate source-grounded synthetic examples.
4. W16 remains the canonical normalized training-dataset pipeline.

## One-command local start

On the owner's Windows PC, from this repository:

```powershell
python training/bootstrap/pc_preflight.py --output training/bootstrap/artifacts/pc-preflight.json
python training/bootstrap/collect_github_sources.py --manifest training/bootstrap/repositories.json --workspace D:\Enthusia-AI-SourceCache --output training/bootstrap/artifacts/github-source-corpus.jsonl --summary training/bootstrap/artifacts/github-source-summary.json
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
