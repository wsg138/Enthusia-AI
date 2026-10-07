"""Explicit single-A100 LoRA trainer for an approved W19 release.

This module is intentionally separate from the normal W19 pipeline.  Planning
and assembly remain safe/local.  Real GPU execution requires all of:

* an assembled W16 dataset whose file hashes match its manifest;
* a release record binding the exact dataset/config/W20 report;
* both owner-review gates marked approved in that release;
* a passing pre-training W20 report hash;
* the normal $25 budget gate;
* exactly one visible NVIDIA A100 with at least 75 GiB VRAM;
* an explicit --execute flag.

No model download or CUDA initialization occurs in plan mode.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import time
from dataclasses import asdict, dataclass

from . import budget as budget_mod
from . import config as config_mod
from .gpu_dataset import load_prompt_completion_jsonl
from .gpu_release import (
    TrainingReleaseError,
    sha256_file,
    verify_training_release,
)


class GpuTrainingError(RuntimeError):
    """Raised when the dedicated GPU runner cannot safely proceed."""


@dataclass(frozen=True)
class HardwareInfo:
    name: str
    total_vram_gib: float
    cuda_version: str
    torch_version: str
    bf16_supported: bool


def _require_a100() -> tuple[object, HardwareInfo]:
    try:
        import torch
    except ImportError as exc:
        raise GpuTrainingError(
            "PyTorch is not installed. Install the [gpu] extra on the GPU host."
        ) from exc

    if not torch.cuda.is_available():
        raise GpuTrainingError("CUDA is unavailable; refusing GPU training")
    if torch.cuda.device_count() != 1:
        raise GpuTrainingError(
            "Exactly one GPU must be visible. Set CUDA_VISIBLE_DEVICES to one approved GPU."
        )

    props = torch.cuda.get_device_properties(0)
    vram = props.total_memory / (1024 ** 3)
    name = props.name
    bf16 = bool(torch.cuda.is_bf16_supported())
    if "A100" not in name.upper() or vram < 75.0:
        raise GpuTrainingError(
            f"this run is pinned to one A100 80GB-class GPU; found {name!r} "
            f"with {vram:.2f} GiB"
        )
    if not bf16:
        raise GpuTrainingError("approved A100 run requires bf16 support")

    return torch, HardwareInfo(
        name=name,
        total_vram_gib=round(vram, 2),
        cuda_version=str(torch.version.cuda),
        torch_version=str(torch.__version__),
        bf16_supported=bf16,
    )


def _package_versions() -> dict[str, str]:
    versions = {}
    for package in ("transformers", "peft", "trl", "datasets", "accelerate"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError as exc:
            raise GpuTrainingError(
                f"required GPU package {package!r} is not installed"
            ) from exc
    return versions


def _dataset_paths(dataset_dir: str) -> dict[str, str]:
    return {
        "manifest": os.path.join(dataset_dir, "manifest.json"),
        "train": os.path.join(dataset_dir, "train.jsonl"),
        "validation": os.path.join(dataset_dir, "validation.jsonl"),
    }


def _verify_dataset_manifest(paths: dict[str, str], expected_version: str) -> dict:
    for label, path in paths.items():
        if not os.path.isfile(path):
            raise GpuTrainingError(f"dataset {label} file is missing: {path}")

    with open(paths["manifest"], encoding="utf-8") as fh:
        manifest = json.load(fh)
    if not isinstance(manifest, dict):
        raise GpuTrainingError("dataset manifest must be a JSON object")
    if manifest.get("dataset_version") != expected_version:
        raise GpuTrainingError(
            "dataset manifest version does not match the training config"
        )

    outputs = manifest.get("outputs")
    if not isinstance(outputs, dict):
        raise GpuTrainingError("dataset manifest has no outputs object")
    actual = {
        "train": sha256_file(paths["train"]),
        "validation": sha256_file(paths["validation"]),
    }
    for split, digest in actual.items():
        entry = outputs.get(split)
        if not isinstance(entry, dict) or entry.get("sha256") != digest:
            raise GpuTrainingError(
                f"{split}.jsonl does not match the assembled W16 manifest"
            )
    return {
        "version": expected_version,
        "manifest_sha256": sha256_file(paths["manifest"]),
        "train_sha256": actual["train"],
        "validation_sha256": actual["validation"],
        "counts": manifest.get("counts", {}),
    }


def _validate_qwen35_config(cfg: config_mod.TrainingConfig) -> None:
    if cfg.base_model != "Qwen/Qwen3.5-35B-A3B":
        raise GpuTrainingError(
            "the A100 runner is intentionally pinned to Qwen/Qwen3.5-35B-A3B"
        )
    if cfg.quantization != "none":
        raise GpuTrainingError("the approved A100 path is bf16 LoRA, not QLoRA")
    forbidden = {"gate_up_proj"}
    overlap = forbidden.intersection(cfg.lora["target_modules"])
    if overlap:
        raise GpuTrainingError(
            "routed MoE expert parameter tensors are not approved LoRA targets: "
            + ", ".join(sorted(overlap))
        )


def build_plan(
    *,
    config_path: str,
    dataset_dir: str,
    ledger_path: str,
) -> dict:
    cfg = config_mod.load_and_validate(config_path)
    _validate_qwen35_config(cfg)
    budget = budget_mod.check_budget(cfg.raw["budget"], ledger_path)
    paths = _dataset_paths(dataset_dir)
    dataset = _verify_dataset_manifest(paths, cfg.dataset["version"])
    train_rows, _ = load_prompt_completion_jsonl(paths["train"])
    validation_rows, _ = load_prompt_completion_jsonl(paths["validation"])
    return {
        "config": cfg.name,
        "base_model": cfg.base_model,
        "config_sha256": sha256_file(config_path),
        "dataset": dataset,
        "train_examples": len(train_rows),
        "validation_examples": len(validation_rows),
        "budget": {
            "estimate": budget.estimate.as_dict(),
            "spent_before_usd": budget.spent_before_usd,
            "projected_usd": budget.total_projected_usd,
            "owner_override": budget.owner_override,
        },
        "execution": "BLOCKED until --execute plus a verified training release",
    }


def _run_training(
    *,
    cfg: config_mod.TrainingConfig,
    train_examples: list[dict],
    validation_examples: list[dict],
    run_dir: str,
) -> tuple[dict, HardwareInfo]:
    torch, hardware = _require_a100()
    versions = _package_versions()

    try:
        from datasets import Dataset
        from peft import LoraConfig, TaskType
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from trl import SFTConfig, SFTTrainer
    except ImportError as exc:
        raise GpuTrainingError(
            "GPU training libraries are incomplete; install the [gpu] extra"
        ) from exc

    adapter_dir = os.path.abspath(cfg.output["adapter_dir"])
    if os.path.exists(adapter_dir) and os.listdir(adapter_dir):
        raise GpuTrainingError(
            f"adapter output already exists and is non-empty: {adapter_dir}"
        )
    os.makedirs(run_dir, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(
        cfg.tokenizer,
        use_fast=True,
        trust_remote_code=False,
    )
    if tokenizer.pad_token is None:
        if tokenizer.eos_token is None:
            raise GpuTrainingError("tokenizer has neither pad_token nor eos_token")
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        cfg.base_model,
        dtype=torch.bfloat16,
        device_map={"": 0},
        low_cpu_mem_usage=True,
        trust_remote_code=False,
        attn_implementation="sdpa",
    )
    model.config.use_cache = False

    peft_config = LoraConfig(
        r=cfg.lora["r"],
        lora_alpha=cfg.lora["alpha"],
        lora_dropout=cfg.lora["dropout"],
        target_modules=cfg.lora["target_modules"],
        bias="none",
        task_type=TaskType.CAUSAL_LM,
    )

    train_dataset = Dataset.from_list(
        [{"prompt": row["prompt"], "completion": row["completion"]} for row in train_examples]
    )
    eval_dataset = Dataset.from_list(
        [
            {"prompt": row["prompt"], "completion": row["completion"]}
            for row in validation_examples
        ]
    )

    training = cfg.training
    sft_kwargs = {
        "output_dir": run_dir,
        "per_device_train_batch_size": training["batch_size"],
        "gradient_accumulation_steps": training["gradient_accumulation"],
        "learning_rate": training["learning_rate"],
        "warmup_ratio": training["warmup_ratio"],
        "lr_scheduler_type": training["scheduler"],
        "optim": training["optimizer"],
        "max_length": training["max_seq_length"],
        "bf16": True,
        "fp16": False,
        "gradient_checkpointing": True,
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "completion_only_loss": True,
        "packing": False,
        "eval_strategy": "epoch",
        "save_strategy": "epoch",
        "logging_steps": 5,
        "save_total_limit": 2,
        "report_to": "none",
        "seed": training["seed"],
        "data_seed": training["seed"],
    }
    if training["epochs"] is not None:
        sft_kwargs["num_train_epochs"] = training["epochs"]
    if training["max_steps"] is not None:
        sft_kwargs["max_steps"] = training["max_steps"]

    args = SFTConfig(**sft_kwargs)
    trainer = SFTTrainer(
        model=model,
        args=args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        processing_class=tokenizer,
        peft_config=peft_config,
    )
    trainer.model.print_trainable_parameters()

    started = time.time()
    result = trainer.train()
    elapsed = time.time() - started

    trainer.save_model(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)
    eval_metrics = trainer.evaluate()

    return {
        "train_metrics": dict(result.metrics),
        "eval_metrics": dict(eval_metrics),
        "elapsed_seconds": round(elapsed, 2),
        "packages": versions,
        "adapter_dir": adapter_dir,
    }, hardware


def build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fail-closed single-A100 Qwen3.5 LoRA trainer."
    )
    parser.add_argument("--config", required=True)
    parser.add_argument("--dataset-dir", required=True)
    parser.add_argument("--ledger", default="budget-ledger.json")
    parser.add_argument("--release")
    parser.add_argument("--w20-report")
    parser.add_argument("--run-dir")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually initialize CUDA/download the model/train. Omit for a zero-GPU plan.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_cli().parse_args(argv)
    config_path = os.path.abspath(args.config)
    dataset_dir = os.path.abspath(args.dataset_dir)
    ledger_path = os.path.abspath(args.ledger)

    plan = build_plan(
        config_path=config_path,
        dataset_dir=dataset_dir,
        ledger_path=ledger_path,
    )
    if not args.execute:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0

    if not args.release or not args.w20_report:
        raise TrainingReleaseError(
            "--execute requires both --release and --w20-report"
        )

    cfg = config_mod.load_and_validate(config_path)
    paths = _dataset_paths(dataset_dir)
    release = verify_training_release(
        release_path=os.path.abspath(args.release),
        dataset_manifest_path=paths["manifest"],
        train_path=paths["train"],
        validation_path=paths["validation"],
        config_path=config_path,
        w20_report_path=os.path.abspath(args.w20_report),
        expected_dataset_version=cfg.dataset["version"],
    )

    train_examples, _ = load_prompt_completion_jsonl(paths["train"])
    validation_examples, _ = load_prompt_completion_jsonl(paths["validation"])
    run_dir = os.path.abspath(args.run_dir or os.path.join("runs", cfg.name))

    result, hardware = _run_training(
        cfg=cfg,
        train_examples=train_examples,
        validation_examples=validation_examples,
        run_dir=run_dir,
    )

    elapsed_hours = result["elapsed_seconds"] / 3600.0
    price = float(cfg.raw["budget"]["price_per_hour_usd"])
    training_compute_usd = round(elapsed_hours * price, 2)
    budget_mod.record_spend(
        ledger_path,
        run_name=cfg.name,
        spent_usd_amount=training_compute_usd,
        note="Measured Enthusia AI training wall time only; excludes unrelated pod workloads.",
    )

    run_manifest = {
        "schema_version": 1,
        "config_name": cfg.name,
        "base_model": cfg.base_model,
        "dataset_version": cfg.dataset["version"],
        "release": asdict(release),
        "hardware": asdict(hardware),
        "result": result,
        "measured_training_compute_usd": training_compute_usd,
        "finished_at_unix": int(time.time()),
    }
    manifest_path = os.path.join(run_dir, "gpu-run-manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(run_manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(json.dumps(run_manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
