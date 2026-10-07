"""Tests for the explicit GPU-host SFT runner.

These tests exercise the safety/input contract and dry-run planning only. They
must not import CUDA libraries or download model weights in CI.
"""

from __future__ import annotations

import json

import pytest

from enthusia_finetune import config as config_mod
from enthusia_finetune import trainer


def _config(*, targets="all-linear"):
    return config_mod.validate_config(
        {
            "name": "gpu-test",
            "base_model": "Qwen/Qwen3-0.6B",
            "tokenizer": "Qwen/Qwen3-0.6B",
            "quantization": "4bit",
            "lora": {
                "r": 16,
                "alpha": 32,
                "dropout": 0.05,
                "target_modules": targets,
            },
            "training": {
                "learning_rate": 0.0001,
                "optimizer": "paged_adamw_8bit",
                "scheduler": "cosine",
                "batch_size": 1,
                "gradient_accumulation": 4,
                "max_seq_length": 2048,
                "epochs": 1,
                "seed": 1337,
            },
            "dataset": {
                "version": "enthusia-ai-dataset-2026.10.07-v1",
            },
            "budget": {
                "price_per_hour_usd": 0.0,
                "estimated_hours": 0.0,
                "storage_usd": 0.0,
            },
            "output": {
                "adapter_dir": "runs/test/adapter",
                "gguf_path": "runs/test/model.Q4_K_M.gguf",
                "quant": "Q4_K_M",
            },
        }
    )


def _record(**overrides):
    record = {
        "id": "good-1",
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": "Player asks for help.",
        "messages": [
            {"role": "user", "content": "How do I get help?"},
            {"role": "assistant", "content": "Open a support ticket."},
        ],
        "expected_answer": "Open a support ticket.",
        "facts": [],
        "tags": ["support"],
        "quality": "GOOD",
    }
    record.update(overrides)
    return record


def _write(path, records):
    path.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )


def test_prepare_jsonl_builds_prompt_completion_and_dedupes_target(tmp_path):
    path = tmp_path / "train.jsonl"
    _write(path, [_record()])

    prepared = trainer.prepare_jsonl(str(path))
    assert prepared.summary.records == 1
    assert prepared.summary.quality_counts == {"GOOD": 1}
    assert prepared.examples == [
        {
            "prompt": [{"role": "user", "content": "How do I get help?"}],
            "completion": [
                {"role": "assistant", "content": "Open a support ticket."}
            ],
        }
    ]
    assert len(prepared.summary.sha256) == 64


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("quality", "USABLE_WITH_EDIT", "not trainable"),
        ("quality", "OUTDATED", "not trainable"),
        ("quality", "INCOMPLETE", "not trainable"),
        ("quality", "BAD_RESPONSE", "not trainable"),
        ("visibility", "private", "visibility"),
    ],
)
def test_prepare_jsonl_fails_closed_on_unapproved_records(
    tmp_path, field, value, match
):
    path = tmp_path / "train.jsonl"
    _write(path, [_record(**{field: value})])
    with pytest.raises(trainer.TrainingInputError, match=match):
        trainer.prepare_jsonl(str(path))


def test_prepare_jsonl_rejects_evaluation_only_tags(tmp_path):
    path = tmp_path / "train.jsonl"
    _write(path, [_record(tags=["support", "golden"])])
    with pytest.raises(trainer.TrainingInputError, match="evaluation-only"):
        trainer.prepare_jsonl(str(path))


def test_prepare_jsonl_preserves_prior_assistant_turn_as_masked_prompt_context(
    tmp_path,
):
    path = tmp_path / "train.jsonl"
    record = _record(
        messages=[
            {"role": "user", "content": "My command failed."},
            {"role": "assistant", "content": "What error did you get?"},
            {"role": "user", "content": "It says I lack permission."},
        ],
        expected_answer="Ask staff to verify your current permissions.",
    )
    _write(path, [record])

    prepared = trainer.prepare_jsonl(str(path))
    assert prepared.examples[0]["prompt"][1] == {
        "role": "assistant",
        "content": "What error did you get?",
    }
    assert prepared.examples[0]["completion"] == [
        {
            "role": "assistant",
            "content": "Ask staff to verify your current permissions.",
        }
    ]


def test_build_training_plan_supports_all_linear_qlora(tmp_path):
    train = tmp_path / "train.jsonl"
    validation = tmp_path / "validation.jsonl"
    _write(train, [_record()])
    _write(validation, [_record(id="good-2", quality="IDEAL")])

    plan = trainer.build_training_plan(
        _config(),
        train_json=str(train),
        validation_json=str(validation),
        output_dir="runs/a100/adapter",
    )
    assert plan["target_modules"] == "all-linear"
    assert plan["quantization"] == "4bit"
    assert plan["train"]["records"] == 1
    assert plan["validation"]["quality_counts"] == {"IDEAL": 1}


def test_cli_dry_run_never_imports_gpu_stack(tmp_path, capsys):
    train = tmp_path / "train.jsonl"
    config_path = tmp_path / "config.json"
    _write(train, [_record()])
    cfg = _config()
    config_path.write_text(json.dumps(cfg.raw), encoding="utf-8")

    rc = trainer.main(
        [
            "--config",
            str(config_path),
            "--train-json",
            str(train),
            "--dry-run",
        ]
    )
    assert rc == 0
    output = json.loads(capsys.readouterr().out)
    assert output["train"]["records"] == 1
    assert output["model"] == "Qwen/Qwen3-0.6B"
