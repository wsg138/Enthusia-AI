"""Executable single-GPU QLoRA/SFT runner for approved Enthusia datasets.

The normal W19 pipeline remains a zero-cost preparation/orchestration layer.
This module is the explicit command that may be copied to an approved GPU host
after budget, dataset, and owner-review gates have passed.

Heavy GPU dependencies are imported lazily so ordinary CI can validate the
input contract and command generation without downloading models or requiring
CUDA.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import config as config_mod

TRAINABLE_QUALITIES = frozenset({"GOOD", "IDEAL"})
TRAINABLE_VISIBILITIES = frozenset({"public", "staff"})
EVALUATION_ONLY_TAGS = frozenset(
    {"golden", "adversarial", "stale-truth", "privacy", "tool-failure"}
)
_ALLOWED_ROLES = frozenset({"system", "user", "assistant", "tool"})


class TrainingInputError(ValueError):
    """Raised when a purported tuning partition is not safe to train on."""


@dataclass(frozen=True)
class TrainingDatasetSummary:
    path: str
    records: int
    sha256: str
    quality_counts: dict[str, int]

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "records": self.records,
            "sha256": self.sha256,
            "quality_counts": dict(sorted(self.quality_counts.items())),
        }


@dataclass(frozen=True)
class PreparedDataset:
    examples: list[dict[str, Any]]
    summary: TrainingDatasetSummary


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_message(message: Any, *, record_id: str, index: int) -> dict[str, str]:
    if not isinstance(message, dict):
        raise TrainingInputError(
            f"{record_id}: messages[{index}] must be an object"
        )
    role = message.get("role")
    content = message.get("content")
    if role not in _ALLOWED_ROLES:
        raise TrainingInputError(
            f"{record_id}: messages[{index}].role must be one of "
            f"{sorted(_ALLOWED_ROLES)}, got {role!r}"
        )
    if not isinstance(content, str) or not content.strip():
        raise TrainingInputError(
            f"{record_id}: messages[{index}].content must be non-empty text"
        )
    return {"role": role, "content": content.strip()}


def _training_example(raw: Any, *, path: str, lineno: int) -> tuple[dict[str, Any], str]:
    if not isinstance(raw, dict):
        raise TrainingInputError(f"{path}:{lineno}: expected a JSON object")

    record_id = raw.get("id")
    if not isinstance(record_id, str) or not record_id.strip():
        raise TrainingInputError(f"{path}:{lineno}: missing non-empty id")

    quality = raw.get("quality")
    if quality not in TRAINABLE_QUALITIES:
        raise TrainingInputError(
            f"{record_id}: quality {quality!r} is not trainable; "
            "only reviewed GOOD/IDEAL records may reach the GPU runner"
        )

    visibility = raw.get("visibility")
    if visibility not in TRAINABLE_VISIBILITIES:
        raise TrainingInputError(
            f"{record_id}: visibility {visibility!r} is not trainable"
        )

    tags = {
        tag.lower()
        for tag in raw.get("tags", [])
        if isinstance(tag, str)
    }
    special = sorted(tags & EVALUATION_ONLY_TAGS)
    if special:
        raise TrainingInputError(
            f"{record_id}: evaluation-only tag(s) cannot be trained: {special}"
        )

    messages_raw = raw.get("messages")
    if not isinstance(messages_raw, list) or not messages_raw:
        raise TrainingInputError(f"{record_id}: messages must be a non-empty list")
    prompt = [
        _normalize_message(message, record_id=record_id, index=index)
        for index, message in enumerate(messages_raw)
    ]

    expected = raw.get("expected_answer")
    if not isinstance(expected, str) or not expected.strip():
        raise TrainingInputError(
            f"{record_id}: expected_answer must be non-empty for SFT"
        )
    expected = expected.strip()

    # W16/W19 records often preserve the answer in both messages and
    # expected_answer. Remove an exact trailing copy so the prompt does not
    # reveal the target immediately before the completion.
    if (
        prompt
        and prompt[-1]["role"] == "assistant"
        and prompt[-1]["content"].strip() == expected
    ):
        prompt = prompt[:-1]

    if not prompt:
        scenario = raw.get("scenario")
        if not isinstance(scenario, str) or not scenario.strip():
            raise TrainingInputError(
                f"{record_id}: removing the duplicated target left no prompt"
            )
        prompt = [{"role": "user", "content": scenario.strip()}]

    # Conversational prompt-completion makes the target boundary explicit.
    # TRL masks the prompt and learns only the assistant completion.
    return {
        "prompt": prompt,
        "completion": [{"role": "assistant", "content": expected}],
    }, quality


def prepare_jsonl(path: str) -> PreparedDataset:
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise TrainingInputError(f"training partition not found: {source}")

    examples: list[dict[str, Any]] = []
    quality_counts: dict[str, int] = {}
    with source.open(encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as exc:
                raise TrainingInputError(
                    f"{source}:{lineno}: invalid JSON: {exc}"
                ) from exc
            example, quality = _training_example(
                raw, path=str(source), lineno=lineno
            )
            examples.append(example)
            quality_counts[quality] = quality_counts.get(quality, 0) + 1

    if not examples:
        raise TrainingInputError(f"training partition is empty: {source}")

    return PreparedDataset(
        examples=examples,
        summary=TrainingDatasetSummary(
            path=str(source),
            records=len(examples),
            sha256=_sha256(source),
            quality_counts=quality_counts,
        ),
    )


def _target_modules(cfg: config_mod.TrainingConfig) -> str | list[str]:
    target = cfg.lora["target_modules"]
    if target == "all-linear":
        return target
    return list(target)


def build_training_plan(
    cfg: config_mod.TrainingConfig,
    *,
    train_json: str,
    validation_json: str | None,
    output_dir: str | None = None,
) -> dict[str, Any]:
    train = prepare_jsonl(train_json)
    validation = prepare_jsonl(validation_json) if validation_json else None
    out = output_dir or cfg.output["adapter_dir"]

    return {
        "model": cfg.base_model,
        "tokenizer": cfg.tokenizer,
        "quantization": cfg.quantization,
        "target_modules": _target_modules(cfg),
        "output_dir": out,
        "train": train.summary.as_dict(),
        "validation": validation.summary.as_dict() if validation else None,
        "training": dict(cfg.training),
        "dataset_version": cfg.dataset["version"],
    }


def _dependency_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for package in (
        "torch",
        "transformers",
        "trl",
        "peft",
        "datasets",
        "accelerate",
        "bitsandbytes",
    ):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "not-installed"
    return versions


def run_training(
    cfg: config_mod.TrainingConfig,
    *,
    train_json: str,
    validation_json: str | None,
    output_dir: str | None = None,
    resume_from_checkpoint: str | None = None,
) -> dict[str, Any]:
    plan = build_training_plan(
        cfg,
        train_json=train_json,
        validation_json=validation_json,
        output_dir=output_dir,
    )

    # Lazy imports: normal CI and prepare-only workflows do not install or load
    # the heavyweight CUDA stack.
    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig
        from transformers import AutoTokenizer, BitsAndBytesConfig
        from trl import SFTConfig, SFTTrainer
    except ImportError as exc:  # pragma: no cover - depends on GPU host
        raise RuntimeError(
            "GPU training dependencies are missing. Install the finetune "
            "package with its 'gpu' extra on the approved training host."
        ) from exc

    if not torch.cuda.is_available():  # pragma: no cover - GPU-host guard
        raise RuntimeError("CUDA GPU is required for this training command")

    train_prepared = prepare_jsonl(train_json)
    validation_prepared = (
        prepare_jsonl(validation_json) if validation_json else None
    )
    train_dataset = Dataset.from_list(train_prepared.examples)
    eval_dataset = (
        Dataset.from_list(validation_prepared.examples)
        if validation_prepared
        else None
    )

    tokenizer = AutoTokenizer.from_pretrained(cfg.tokenizer, use_fast=True)
    if tokenizer.pad_token is None:
        if tokenizer.eos_token is None:
            raise RuntimeError("tokenizer has neither pad_token nor eos_token")
        tokenizer.pad_token = tokenizer.eos_token

    quantization_config = None
    if cfg.quantization == "4bit":
        quantization_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
    elif cfg.quantization == "8bit":
        quantization_config = BitsAndBytesConfig(load_in_8bit=True)

    lora_config = LoraConfig(
        r=cfg.lora["r"],
        lora_alpha=cfg.lora["alpha"],
        lora_dropout=cfg.lora["dropout"],
        target_modules=_target_modules(cfg),
        bias="none",
        task_type="CAUSAL_LM",
    )

    training = cfg.training
    has_eval = eval_dataset is not None and len(eval_dataset) > 0
    effective_batch = max(
        1,
        training["batch_size"] * training["gradient_accumulation"],
    )
    optimizer_steps_per_epoch = max(
        1, (len(train_dataset) + effective_batch - 1) // effective_batch
    )
    checkpoint_steps = max(1, min(50, optimizer_steps_per_epoch))

    args_kwargs: dict[str, Any] = {
        "output_dir": plan["output_dir"],
        "per_device_train_batch_size": training["batch_size"],
        "per_device_eval_batch_size": max(1, training["batch_size"]),
        "gradient_accumulation_steps": training["gradient_accumulation"],
        "learning_rate": training["learning_rate"],
        "optim": training["optimizer"],
        "lr_scheduler_type": training["scheduler"],
        "warmup_ratio": training["warmup_ratio"],
        "max_length": training["max_seq_length"],
        "seed": training["seed"],
        "data_seed": training["seed"],
        "bf16": True,
        "tf32": True,
        "gradient_checkpointing": True,
        "completion_only_loss": True,
        "packing": False,
        "report_to": "none",
        "logging_steps": 1,
        "save_strategy": "steps",
        "save_steps": checkpoint_steps,
        "save_total_limit": 2,
        "eval_strategy": "steps" if has_eval else "no",
        "eval_steps": checkpoint_steps if has_eval else None,
        "load_best_model_at_end": has_eval,
        "metric_for_best_model": "eval_loss" if has_eval else None,
        "greater_is_better": False if has_eval else None,
        "model_init_kwargs": {"dtype": torch.bfloat16},
    }
    if training["epochs"] is not None:
        args_kwargs["num_train_epochs"] = training["epochs"]
    if training["max_steps"] is not None:
        args_kwargs["max_steps"] = training["max_steps"]

    sft_args = SFTConfig(**args_kwargs)
    trainer = SFTTrainer(
        model=cfg.base_model,
        args=sft_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        processing_class=tokenizer,
        quantization_config=quantization_config,
        peft_config=lora_config,
    )

    train_result = trainer.train(resume_from_checkpoint=resume_from_checkpoint)
    trainer.save_model(plan["output_dir"])
    tokenizer.save_pretrained(plan["output_dir"])

    eval_metrics = trainer.evaluate() if has_eval else {}
    manifest = {
        "status": "completed",
        "config": cfg.artifact_summary(),
        "dataset_version": cfg.dataset["version"],
        "train": train_prepared.summary.as_dict(),
        "validation": (
            validation_prepared.summary.as_dict()
            if validation_prepared
            else None
        ),
        "output_dir": plan["output_dir"],
        "resume_from_checkpoint": resume_from_checkpoint,
        "gpu": {
            "count": torch.cuda.device_count(),
            "name": torch.cuda.get_device_name(torch.cuda.current_device()),
        },
        "dependencies": _dependency_versions(),
        "train_metrics": dict(train_result.metrics),
        "eval_metrics": dict(eval_metrics),
    }
    os.makedirs(plan["output_dir"], exist_ok=True)
    manifest_path = os.path.join(plan["output_dir"], "training-manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True, default=str)
        handle.write("\n")
    manifest["manifest_path"] = manifest_path
    return manifest


def build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="enthusia-sft",
        description="Run approved Enthusia QLoRA/SFT training on a CUDA GPU host.",
    )
    parser.add_argument("--config", required=True)
    parser.add_argument("--train-json", required=True)
    parser.add_argument("--validation-json")
    parser.add_argument("--output-dir")
    parser.add_argument("--resume-from-checkpoint")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate the config/datasets and print the plan without importing CUDA libraries.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_cli().parse_args(argv)
    cfg = config_mod.load_and_validate(args.config)
    plan = build_training_plan(
        cfg,
        train_json=args.train_json,
        validation_json=args.validation_json,
        output_dir=args.output_dir,
    )
    if args.dry_run:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0

    manifest = run_training(
        cfg,
        train_json=args.train_json,
        validation_json=args.validation_json,
        output_dir=args.output_dir,
        resume_from_checkpoint=args.resume_from_checkpoint,
    )
    print(json.dumps(manifest, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
