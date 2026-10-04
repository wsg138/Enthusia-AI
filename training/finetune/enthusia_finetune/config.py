"""Training-config loading and validation.

Covers TRAINING-AND-EVALUATION-SPEC section 18 (hyperparameter tracking):
base model, tokenizer, quantization, LoRA rank/alpha/dropout/target
modules, learning rate, optimizer, batch size, gradient accumulation,
sequence length, epochs/steps, scheduler, seed — plus W19's mandatory
budget estimate and dataset references.

Every run config must declare `budget` with a cost estimate; the pipeline
refuses configs without one.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import yaml

from . import budget as budget_mod


class ConfigError(ValueError):
    """Raised when a training config is missing or invalid."""


REQUIRED_TOP_LEVEL = ("name", "base_model", "lora", "training", "dataset", "budget", "output")
OPTIONAL_TOP_LEVEL = ("description", "eval", "notes", "quantization", "tokenizer")

_ALLOWED_OPTIMIZERS = ("adamw", "adamw_8bit", "adamw_torch", "paged_adamw_8bit", "sgd")
_ALLOWED_SCHEDULERS = ("cosine", "linear", "constant", "constant_with_warmup")
_ALLOWED_QUANT = ("4bit", "8bit", "none")
_ALLOWED_OUTPUT_QUANTS = ("Q4_K_M", "Q5_K_M", "Q8_0", "Q4_0", "Q6_K")


def _get(cfg: dict, key: str, where: str):
    if key not in cfg:
        raise ConfigError(f"config[{where}]: missing required key {key!r}")
    return cfg[key]


def load_config(path: str) -> dict:
    """Load a YAML training config file."""
    if not os.path.isfile(path):
        raise ConfigError(f"config file not found: {path}")
    try:
        with open(path, encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        raise ConfigError(f"config {path!r} is not valid YAML: {exc}") from exc
    if not isinstance(cfg, dict):
        raise ConfigError(f"config {path!r} must be a YAML mapping at the top level")
    return cfg


def validate_lora(lora: dict) -> dict:
    if not isinstance(lora, dict):
        raise ConfigError("config[lora] must be a mapping")
    r = _get(lora, "r", "lora")
    alpha = _get(lora, "alpha", "lora")
    dropout = float(lora.get("dropout", 0.0))
    targets = _get(lora, "target_modules", "lora")
    if not isinstance(r, int) or r <= 0:
        raise ConfigError(f"config[lora.r] must be a positive int, got {r!r}")
    if not isinstance(alpha, (int, float)) or alpha <= 0:
        raise ConfigError(f"config[lora.alpha] must be positive, got {alpha!r}")
    if not 0.0 <= dropout < 1.0:
        raise ConfigError(f"config[lora.dropout] must be in [0, 1), got {dropout!r}")
    if not isinstance(targets, list) or not targets or not all(
        isinstance(t, str) and t for t in targets
    ):
        raise ConfigError("config[lora.target_modules] must be a non-empty list of strings")
    return {"r": r, "alpha": alpha, "dropout": dropout, "target_modules": list(targets)}


def validate_training(training: dict) -> dict:
    if not isinstance(training, dict):
        raise ConfigError("config[training] must be a mapping")
    lr = _get(training, "learning_rate", "training")
    if not isinstance(lr, (int, float)) or not 1e-7 <= lr <= 1e-2:
        raise ConfigError(f"config[training.learning_rate] out of sane range, got {lr!r}")
    optimizer = str(_get(training, "optimizer", "training")).lower()
    if optimizer not in _ALLOWED_OPTIMIZERS:
        raise ConfigError(
            f"config[training.optimizer] must be one of {sorted(_ALLOWED_OPTIMIZERS)}, got {optimizer!r}"
        )
    scheduler = str(training.get("scheduler", "cosine")).lower()
    if scheduler not in _ALLOWED_SCHEDULERS:
        raise ConfigError(
            f"config[training.scheduler] must be one of {sorted(_ALLOWED_SCHEDULERS)}, got {scheduler!r}"
        )
    batch = _get(training, "batch_size", "training")
    accum = int(training.get("gradient_accumulation", 1))
    seq_len = _get(training, "max_seq_length", "training")
    if not isinstance(batch, int) or batch <= 0:
        raise ConfigError(f"config[training.batch_size] must be a positive int, got {batch!r}")
    if accum <= 0:
        raise ConfigError(f"config[training.gradient_accumulation] must be >= 1, got {accum!r}")
    if not isinstance(seq_len, int) or seq_len <= 0:
        raise ConfigError(f"config[training.max_seq_length] must be a positive int, got {seq_len!r}")
    epochs = training.get("epochs")
    max_steps = training.get("max_steps")
    if epochs is None and max_steps is None:
        raise ConfigError("config[training] needs at least one of 'epochs' or 'max_steps'")
    if epochs is not None and not (isinstance(epochs, (int, float)) and epochs > 0):
        raise ConfigError(f"config[training.epochs] must be positive, got {epochs!r}")
    if max_steps is not None and not (isinstance(max_steps, int) and max_steps > 0):
        raise ConfigError(f"config[training.max_steps] must be a positive int, got {max_steps!r}")
    seed = int(training.get("seed", 42))
    return {
        "learning_rate": float(lr),
        "optimizer": optimizer,
        "scheduler": scheduler,
        "batch_size": batch,
        "gradient_accumulation": accum,
        "max_seq_length": seq_len,
        "epochs": epochs,
        "max_steps": max_steps,
        "seed": seed,
        "warmup_ratio": float(training.get("warmup_ratio", 0.03)),
    }


def validate_dataset(dataset: dict) -> dict:
    if not isinstance(dataset, dict):
        raise ConfigError("config[dataset] must be a mapping")
    version = _get(dataset, "version", "dataset")
    if not isinstance(version, str) or not version.startswith("enthusia-ai-dataset-"):
        raise ConfigError(
            f"config[dataset.version] must be a dataset version id like "
            f"'enthusia-ai-dataset-YYYY.MM.DD-vN', got {version!r}"
        )
    return {
        "version": version,
        "train_path": dataset.get("train_path", ""),
        "validation_path": dataset.get("validation_path", ""),
    }


def validate_output(output: dict) -> dict:
    if not isinstance(output, dict):
        raise ConfigError("config[output] must be a mapping")
    adapter_dir = _get(output, "adapter_dir", "output")
    gguf_path = _get(output, "gguf_path", "output")
    quant = str(output.get("quant", "Q4_K_M"))
    if quant not in _ALLOWED_OUTPUT_QUANTS:
        raise ConfigError(
            f"config[output.quant] must be one of {sorted(_ALLOWED_OUTPUT_QUANTS)}, got {quant!r}"
        )
    return {"adapter_dir": adapter_dir, "gguf_path": gguf_path, "quant": quant}


@dataclass(frozen=True)
class TrainingConfig:
    """A fully validated training run configuration."""

    name: str
    base_model: str
    tokenizer: str
    quantization: str
    lora: dict
    training: dict
    dataset: dict
    budget_estimate: budget_mod.BudgetEstimate
    output: dict
    eval: dict
    raw: dict

    def artifact_summary(self) -> dict:
        """Spec section 18/24 artifact fields derived from this config."""
        return {
            "base_model": self.base_model,
            "tokenizer": self.tokenizer,
            "quantization": self.quantization,
            "lora": self.lora,
            "training": self.training,
            "dataset_version": self.dataset["version"],
            "budget_estimate_usd": self.budget_estimate.total_usd,
        }


def validate_config(cfg: dict) -> TrainingConfig:
    """Validate a loaded config mapping; returns a TrainingConfig."""
    if not isinstance(cfg, dict):
        raise ConfigError("config must be a mapping")
    unknown = set(cfg) - set(REQUIRED_TOP_LEVEL) - set(OPTIONAL_TOP_LEVEL)
    if unknown:
        raise ConfigError(f"config has unknown top-level keys: {sorted(unknown)}")
    for key in REQUIRED_TOP_LEVEL:
        _get(cfg, key, "config")

    base_model = _get(cfg, "base_model", "config")
    if not isinstance(base_model, str) or not base_model.strip():
        raise ConfigError("config[base_model] must be a non-empty string")

    quant = str(cfg.get("quantization", "4bit")).lower()
    if quant not in _ALLOWED_QUANT:
        raise ConfigError(
            f"config[quantization] must be one of {sorted(_ALLOWED_QUANT)}, got {quant!r}"
        )

    lora = validate_lora(cfg["lora"])
    training = validate_training(cfg["training"])
    dataset = validate_dataset(cfg["dataset"])
    output = validate_output(cfg["output"])

    # Budget is mandatory: the pipeline refuses to plan a run without a
    # declared cost estimate.
    try:
        estimate = budget_mod.estimate_cost(cfg["budget"])
    except budget_mod.BudgetConfigError as exc:
        raise ConfigError(f"config[budget]: {exc}") from exc

    eval_cfg = cfg.get("eval", {}) or {}
    if not isinstance(eval_cfg, dict):
        raise ConfigError("config[eval] must be a mapping if present")

    return TrainingConfig(
        name=str(cfg["name"]),
        base_model=base_model.strip(),
        tokenizer=str(cfg.get("tokenizer", base_model)).strip(),
        quantization=quant,
        lora=lora,
        training=training,
        dataset=dataset,
        budget_estimate=estimate,
        output=output,
        eval=eval_cfg,
        raw=cfg,
    )


def load_and_validate(path: str) -> TrainingConfig:
    """Load a YAML config file and validate it end to end."""
    return validate_config(load_config(path))
