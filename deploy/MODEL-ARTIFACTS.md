# Enthusia AI — Model Artifact Persistence Strategy (W21)

Spec: MASTER-SPECIFICATION.md §64 (model artifact management), §31
(deployment/version awareness). **Prepare only — no artifacts are stored yet.**

---

## 1. Manifest

Each model release gets a manifest entry (YAML) recording every §64 field:

```yaml
id: enthusiasm-support-2026-10-03-q4k
base_model: <name>
base_version: <version>
license: <license id>
training_dataset_version: <id>
training_code_commit: <sha>
hyperparameters: <ref or inline>
adapter_hash: sha256:<hex>
quantization: <method, e.g. Q4_K_M>
artifact_hash: sha256:<hex>
artifact_path: /opt/enthusia-ai/models/enthusiasm-support-2026-10-03-q4k.gguf
evaluation_report: <path or link>
deployment_date: 2026-..-..
deployed_by: <name>
previous_release: <manifest id or null>
```

The manifest is the source of truth for "which model is live" — never infer
it from filenames. The AI must not describe unreleased weights as live
behavior (§31).

## 2. Storage layout

```
/opt/enthusia-ai/models/
  <release-id>.gguf            # content-addressed artifact
  <release-id>.manifest.yaml   # manifest above
  current -> <release-id>      # symlink: what inference loads
  previous -> <release-id>     # symlink: instant rollback target
```

- Keep **current + previous** on disk at all times (rollback without re-download).
- Artifacts are immutable: never overwrite a released file; a new release is a
  new `<release-id>`.
- Verify `artifact_hash` on every download and before every deployment.

## 3. Lifecycle

1. **Stage:** new artifact lands in a staging dir; hash verified against the
   manifest; evaluation report attached.
2. **Promote:** update `current` symlink (atomic `ln -sfn`), record deployment
   per RUNBOOK §6 (repo, commit, artifact, time, runtime version).
3. **Rollback:** repoint `current` to `previous`, restart inference in
   RUNBOOK §2.1 order. The failed release is kept for post-mortem (§32) —
   never deleted as part of a rollback.
4. **Retire:** only after the next release is stable; keep the manifest
   forever (history is append-only, §5.4).

## 4. Runtimes

The inference runtime is swappable (§9.2); today it is llama.cpp server (or
another benchmarked server exposing a stable HTTP/OpenAI-compatible
interface). Requirements the artifact strategy preserves across runtimes:

- quantized model support;
- CPU + RAM inference;
- configurable context;
- configurable concurrency;
- health/readiness endpoints;
- bounded memory;
- controlled thread count;
- graceful shutdown;
- model warmup;
- metrics.

Agent code must not depend on llama.cpp-specific internals — the manifest
records the runtime version alongside the artifact so either can be rolled
back independently.

## 5. Quotas

Disk budget: ~2× the largest model (current + previous). Vector store and
logs have separate quotas (RESOURCE-LIMITS.md §4).
