"""Tests for training-config loading and validation (spec section 18
hyperparameter tracking + mandatory budget estimate)."""

from __future__ import annotations

import copy
import os

import pytest

from enthusia_finetune import config as config_mod
from enthusia_finetune.config import ConfigError, load_and_validate

CONFIGS = os.path.join(os.path.dirname(__file__), "..", "configs")


def _base():
    return {
        "name": "test",
        "base_model": "some-org/some-model",
        "quantization": "4bit",
        "lora": {"r": 16, "alpha": 32, "dropout": 0.05,
                 "target_modules": ["q_proj", "v_proj"]},
        "training": {
            "learning_rate": 0.0002,
            "optimizer": "adamw",
            "scheduler": "cosine",
            "batch_size": 2,
            "gradient_accumulation": 4,
            "max_seq_length": 2048,
            "epochs": 1,
            "seed": 42,
        },
        "dataset": {"version": "enthusia-ai-dataset-2026.10.03-v1"},
        "budget": {"price_per_hour_usd": 0.9, "estimated_hours": 24, "storage_usd": 2.0},
        "output": {
            "adapter_dir": "runs/test/adapter",
            "gguf_path": "runs/test/model.Q4_K_M.gguf",
            "quant": "Q4_K_M",
        },
    }


@pytest.mark.parametrize("name", ["smoke.yaml", "small-adapter.yaml", "full-run.yaml"])
def test_shipped_configs_validate(name):
    cfg = load_and_validate(os.path.join(CONFIGS, name))
    assert cfg.name
    assert cfg.budget_estimate.total_usd <= 25.00
    assert cfg.lora["r"] > 0


def test_full_run_estimate_under_cap():
    cfg = load_and_validate(os.path.join(CONFIGS, "full-run.yaml"))
    assert cfg.budget_estimate.total_usd == pytest.approx(23.60)


def test_valid_config_passes():
    cfg = config_mod.validate_config(_base())
    assert cfg.training["optimizer"] == "adamw"
    assert cfg.output["quant"] == "Q4_K_M"
    summary = cfg.artifact_summary()
    assert summary["lora"]["r"] == 16
    assert summary["dataset_version"].startswith("enthusia-ai-dataset-")


def test_missing_budget_rejected():
    bad = _base()
    del bad["budget"]
    with pytest.raises(ConfigError, match="budget"):
        config_mod.validate_config(bad)


def test_missing_top_level_key_rejected():
    bad = _base()
    del bad["output"]
    with pytest.raises(ConfigError, match="output"):
        config_mod.validate_config(bad)


def test_unknown_key_rejected():
    bad = _base()
    bad["surprise"] = 1
    with pytest.raises(ConfigError, match="unknown"):
        config_mod.validate_config(bad)


def test_all_linear_qlora_targets_are_supported():
    cfg = _base()
    cfg["lora"] = copy.deepcopy(cfg["lora"])
    cfg["lora"]["target_modules"] = "all-linear"
    validated = config_mod.validate_config(cfg)
    assert validated.lora["target_modules"] == "all-linear"


def test_invalid_lora_target_modules_rejected():
    cfg = _base()
    cfg["lora"] = copy.deepcopy(cfg["lora"])
    cfg["lora"]["target_modules"] = []
    with pytest.raises(ConfigError, match="target_modules"):
        config_mod.validate_config(cfg)


def test_lora_r_must_be_positive():
    bad = _base()
    bad["lora"] = copy.deepcopy(bad["lora"])
    bad["lora"]["r"] = 0
    with pytest.raises(ConfigError, match="lora.r"):
        config_mod.validate_config(bad)


def test_learning_rate_range():
    bad = _base()
    bad["training"] = copy.deepcopy(bad["training"])
    bad["training"]["learning_rate"] = 5.0
    with pytest.raises(ConfigError, match="learning_rate"):
        config_mod.validate_config(bad)


def test_bad_optimizer_rejected():
    bad = _base()
    bad["training"] = copy.deepcopy(bad["training"])
    bad["training"]["optimizer"] = "rmsprop"
    with pytest.raises(ConfigError, match="optimizer"):
        config_mod.validate_config(bad)


def test_epochs_or_steps_required():
    bad = _base()
    bad["training"] = copy.deepcopy(bad["training"])
    del bad["training"]["epochs"]
    with pytest.raises(ConfigError, match="epochs"):
        config_mod.validate_config(bad)


def test_bad_dataset_version_rejected():
    bad = _base()
    bad["dataset"] = {"version": "v1"}
    with pytest.raises(ConfigError, match="dataset.version"):
        config_mod.validate_config(bad)


def test_missing_config_file(tmp_path):
    with pytest.raises(ConfigError, match="not found"):
        load_and_validate(str(tmp_path / "nope.yaml"))


def test_invalid_yaml(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("name: [unclosed\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="YAML"):
        load_and_validate(str(p))
