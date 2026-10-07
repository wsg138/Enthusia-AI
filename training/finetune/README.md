# W19 — Fine-tune and export pipeline

Builds the Enthusia AI fine-tuning pipeline: dataset assembly from the
W16/W17/W18 corpora, budget-gated training configs, GGUF export, and
evaluation hooks. Per TRAINING-AND-EVALUATION-SPEC §14, §17–§19, §24–§25
and WORKER-EXECUTION-PLAN §22.

**Constraints (hard):** no actual training runs, no GPU usage, no model
downloads. This workstream delivers the *pipeline* — configs, assembly,
budget enforcement, export planning, eval hooks — and validates it with
54 unit tests. Training itself runs later on the owner's PC or an
approved rented GPU host, using the exact command this pipeline prints.

## $25 GPU budget cap (critical)

TRAINING-AND-EVALUATION-SPEC §14: initial rented-GPU spend must not
exceed **USD $25 total** without explicit owner approval.

Enforcement (`enthusia_finetune/budget.py`):

1. Every training config **must** declare a `budget` block:
   `price_per_hour_usd`, `estimated_hours`, `storage_usd`. Configs
   without a declared estimate are rejected at validation time.
2. Before *anything* else runs, the pipeline computes
   `estimate = hours × price/hour + storage` and checks it against the
   cap **plus** the recorded spend in `budget-ledger.json` (so a second
   run can't silently push the total over $25).
3. Over-cap runs raise `BudgetCapExceeded` and the pipeline **refuses to
   start**. The message tells the operator exactly what to do (reduce
   hours/price or get owner approval).
4. The only escape hatch is an explicit owner override in the config:
   `owner_approved_override: true` **plus** a written
   `owner_approval_reason`. The override is logged loudly in the run
   record. W19's tooling never sets this itself.
5. After a paid run, record the real spend:
   `finetune` has no spend command by design — append to the ledger via
   `enthusia_finetune.budget.record_spend()` so future runs stay honest.

Check any config any time:

```
finetune check-budget --config configs/full-run.yaml --ledger budget-ledger.json
```

## Pipeline stages

```
prepare  ->  budget gate -> dataset assembly -> eval-before -> [TRAIN on GPU host] -> eval-after -> export
```

- `finetune pipeline --stage prepare ...` — runs every $0 local stage:
  validates the config, enforces the budget cap, assembles the dataset,
  runs W20's golden suite against the baseline ("before"), prints the
  exact training command for the GPU host, and prints the export plan in
  dry-run mode. Writes `runs/<name>/prepare.json`.
- `finetune pipeline --stage train ...` — **always refuses** in the
  preparation environment (`TrainingNotPermittedError`). `prepare` now
  writes a resolved config and prints a real
  `python -m enthusia_finetune.trainer ...` command for the approved GPU host.
- `python -m enthusia_finetune.trainer --config ... --train-json ...` —
  the explicit GPU-host runner. It re-validates every input record, refuses
  anything not reviewed `GOOD`/`IDEAL`, converts the record into
  conversational prompt-completion format, and trains only on
  `expected_answer` rather than historical assistant context.
- `finetune pipeline --stage export --adapter-dir ...` — plans (dry-run)
  or executes the GGUF export and writes `artifact-manifest.json`
  (base model, adapter, dataset version, hyperparameters, hashes,
  evaluation reports) per WORKER-EXECUTION-PLAN §22 acceptance.

## Dataset assembly

`enthusia_finetune/assembly.py` combines W16/W17/W18 corpus JSONL files
(records follow MASTER-SPEC §27; the contract is re-stated locally in
`record.py` — W16's package is not importable from this branch's base,
and this workstream must not modify W16/W17/W18 code):

1. **Validate** every record; invalid ones are excluded with a reason.
2. **Filter**: only explicitly reviewed `GOOD` or `IDEAL` records with
   trainable visibility may enter training data. `USABLE_WITH_EDIT`,
   `INCOMPLETE`, `OUTDATED`, `BAD_RESPONSE`, `PRIVATE_EXCLUDE`, and
   missing/unreviewed quality are excluded until corrected and relabeled.
   `private`/`owner` visibility and secret-like content are also excluded.
3. **Dedupe** by exact canonical text (keep lowest id), reporting dupes.
4. **Split by leak-group** (spec §8): records sharing a `template_id`
   (same synthetic template), `ticket_id`/`thread_id` (same thread), or
   scenario hash always land in the **same** train/validation partition —
   no template variants or near-duplicates leak across splits.
   Deterministic: sorted groups + seeded shuffle.
5. **Route special partitions out** of training data (spec §7):
   `golden` → `owner_golden.jsonl`, `adversarial` → `adversarial.jsonl`,
   `stale-truth` → `stale_truth.jsonl`, `privacy` → `privacy_security.jsonl`,
   `tool-failure` → `tool_failure.jsonl`. These belong to evaluation and
   are never tuned on.
6. **Write** `train.jsonl`, `validation.jsonl`, the special-partition
   files, and `manifest.json` with source sets, counts, filters,
   generator info, exclusions, and hashes (spec §9).

```
finetune assemble --corpora /path/to/w17.jsonl /path/to/w18.jsonl \
    --out-dir dataset-v1 --dataset-version enthusia-ai-dataset-2026.10.03-v1
```

Test fixtures in `fixtures/` (W17-style synthetic + W18-style ticket
records, 17 records) exercise every filter, the dedupe path, leak-group
integrity, and special-partition routing.

## Fixture/sample corpus policy

The checked-in W17 `w17-sample-corpus.jsonl` is a deterministic pipeline
fixture built from **plausible synthetic facts**, not authoritative Enthusia
production truth. It is useful for generator, schema, dedupe, and evaluation
tests, but it is **not a production fine-tuning source**.

W19 therefore fails closed on records whose generator is
`enthusia-generation-v0.1.0`, even if such a record is later stamped
`GOOD` or `IDEAL`. Production synthetic training data must be regenerated
from current authoritative Enthusia sources under a separate approved
generator/version rather than relabeling the fixture sample.

## Training configs

`configs/` — one YAML per run stage (spec §18 hyperparameter tracking:
base model, tokenizer, quantization, LoRA rank/alpha/dropout/target
modules, LR, optimizer, batch, accumulation, seq length, epochs/steps,
scheduler, seed — plus dataset version, budget estimate, output paths,
and eval checkout):

| Config | Purpose | Est. cost |
|---|---|---|
| `smoke.yaml` | 10-step local CPU smoke; catches config/assembly errors | $0.00 |
| `small-adapter.yaml` | QLoRA 3B on the owner's RTX 4060 Ti 8 GB; end-to-end proof | $0.00 |
| `full-run.yaml` | Legacy dense 8B QLoRA reference config | **$23.60** (example pricing) |
| `a100-qwen3-30b-a3b.yaml` | Qwen3 30B-A3B MoE QLoRA on one A100 80 GB | **$9.20** (example pricing; replace with actual rate) |\n| `a100-qwen3-30b-a3b-ticket-smoke.yaml` | Two-step Qwen3 A100 path proof on reviewed ticket data | **$0.80** estimate at the observed $1.59/hr rate |

`full-run.yaml` uses *example* rental pricing (24 h × $0.90 + $2
storage). **Replace with the actual rental quote** and re-run
`finetune check-budget` before renting. Conservative LoRA defaults
(LR 2e-4, cosine schedule) per spec §17; full-model training is out of
scope for the initial budget.


### GPU-host runner

The executable runner deliberately lives outside `pipeline train` so normal
CI/preparation cannot accidentally consume GPU time. Install a CUDA-compatible
PyTorch build supplied by the GPU host, then install the pinned user-space stack:

```bash
python -m pip install -e 'training/finetune[gpu]'
```

Pinned by the `gpu` extra: Transformers 5.19.0, PEFT 0.21.2, TRL 1.14.2,
Datasets 5.1.0, Accelerate 1.15.0, and bitsandbytes 0.50.2. PyTorch is left
host-managed so its CUDA build matches the rented image.

The package initializer is lazy: the standalone GPU runner does not import the
W16 assembly stack just to start. Install `training/datasets` separately only
when dataset assembly itself is being run on that host. The runner also
translates the repository-level `warmup_ratio` into integer `warmup_steps`
because the pinned Transformers 5.19.0 API removed `warmup_ratio`; this
translation is computed after the real train-set size and effective batch are
known and is regression-tested.

The runner uses conversational prompt-completion records. Existing historical
assistant turns may remain in the prompt as context, but the completion is
always the reviewed `expected_answer`, so those historical responses do not
receive SFT loss. The runner independently rejects non-GOOD/IDEAL quality,
private/owner visibility, and evaluation-only tags even if an upstream
assembly mistake occurs.

For Qwen3-MoE, routed experts are fused parameters rather than ordinary
`nn.Linear` modules. The A100 config therefore combines attention
`target_modules` with PEFT `target_parameters` for
`mlp.experts.gate_up_proj` / `mlp.experts.down_proj`, using rank 1 for expert
parameters to keep the adapter budget bounded.

A no-CUDA validation pass is available with `--dry-run`; it validates the exact
config and partitions without importing the GPU stack.

## Export (GGUF)

`enthusia_finetune/export.py` plans the export chain:

1. `python -m enthusia_finetune.merge_adapter --base ... --adapter ... --out merged/`
   (merges the LoRA adapter into the base weights; needs `transformers`+`peft` on the export host)
2. `llama.cpp/convert_hf_to_gguf.py merged/ --outfile model.f16.gguf --outtype f16`
3. `llama-quantize model.f16.gguf model.Q4_K_M.gguf Q4_K_M` (default quant; Q5_K_M/Q8_0 also supported)

`finetune export-plan --config ...` prints the plan (dry-run, no model
needed). Execution requires the adapter dir and a llama.cpp checkout;
dry-run validates everything else. The artifact manifest records base
model, adapter files, dataset version, hyperparameters, GGUF hash, and
eval report paths.

## Evaluation hooks

`enthusia_finetune/eval_hooks.py` runs W20's golden suite before and
after a fine-tune (spec §§20–23). It invokes the W20 evaluation CLI
(`node dist/cli.js --out report.json` in a built W20 checkout, set via
`config.eval.w20_checkout`) and records `evals/before.json` /
`evals/after.json`, plus score deltas. Frozen partitions (test,
owner_golden) are evaluation-only — the hook never trains on them.
Wiring a real model into W20's harness is W20's side; this module just
runs the suite and files the reports.

## CLI reference

```
finetune validate-config --config configs/smoke.yaml
finetune check-budget    --config configs/full-run.yaml --ledger budget-ledger.json
finetune assemble        --corpora A.jsonl B.jsonl --out-dir dataset-v1 \
                         --dataset-version enthusia-ai-dataset-2026.10.03-v1 [--seed 1337]
finetune export-plan     --config configs/small-adapter.yaml
finetune pipeline --stage prepare --config ... --corpora ... \
                         --dataset-version ... --out-dir runs/smoke [--ledger ...]
finetune pipeline --stage export --config ... --adapter-dir runs/x/adapter \
                         [--eval-before evals/before.json --eval-after evals/after.json] \
                         [--execute-export]
```

## Testing

```
cd training/finetune
python -m pytest tests/ -q        # 54 tests
```

Covers: assembly counts/filters/dedupe/leak-group integrity/special
routing/manifest, budget math/refusal/ledger/override, config
validation, export planning/dry-run, eval-hook subprocess plumbing, and
the full CLI.

## Layout

```
training/finetune/
├── README.md                 # this file
├── pyproject.toml            # package + `finetune` console script + pytest config
├── configs/                  # smoke / small-adapter / full-run YAML
├── enthusia_finetune/
│   ├── __init__.py
│   ├── record.py             # local §27 contract restatement + quality policy
│   ├── assembly.py           # dataset assembly (W16/W17/W18 corpora -> train/val)
│   ├── budget.py             # $25 hard-cap tracking + refusal
│   ├── config.py             # YAML load + validation (§18 hyperparameters)
│   ├── eval_hooks.py         # W20 golden-suite before/after hooks
│   ├── export.py             # GGUF export planning/execution + artifact manifest
│   ├── merge_adapter.py      # LoRA->base merge (runs on the export host)
│   └── pipeline.py           # orchestrator + `finetune` CLI
├── fixtures/                 # 17-record fixture corpora (synthetic + tickets)
└── tests/                    # 54 pytest tests
```

## Spec traceability

- TRAINING-AND-EVALUATION-SPEC §7 partitions → assembly routing + frozen-partition guard in eval hooks
- §8 leakage prevention → leak-group train/validation split, no template leakage
- §9 dataset versioning → manifest.json (source sets, counts, filters, hashes)
- §14 $25 budget cap → budget.py hard refusal + ledger
- §17–§19 method/hyperparameters/checkpoints → configs + config.py validation
- §20–§23 evaluation → eval_hooks.py (W20 golden suite before/after)
- §24–§25 artifact/quantization → export.py + artifact-manifest.json
- WORKER-EXECUTION-PLAN §22 → pipeline stages + acceptance artifact list
- MASTER-SPEC §43 → behavior targets documented in configs; §27 → record.py contract
