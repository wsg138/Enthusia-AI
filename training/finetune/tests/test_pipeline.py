"""Tests for the pipeline orchestrator: prepare runs the $0 local stages,
budget gates come first, and training execution is always refused here."""

from __future__ import annotations

import json
import os

import pytest

from enthusia_finetune import config as config_mod
from enthusia_finetune import pipeline as pipe

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "fixtures")
CONFIGS = os.path.join(os.path.dirname(__file__), "..", "configs")
SYNTHETIC = os.path.join(FIXTURES, "synthetic.jsonl")
TICKETS = os.path.join(FIXTURES, "tickets.jsonl")


def _smoke_cfg():
    return config_mod.load_and_validate(os.path.join(CONFIGS, "smoke.yaml"))


def test_prepare_runs_local_stages(tmp_path):
    cfg = _smoke_cfg()
    out_dir = str(tmp_path / "runs" / "smoke")
    result = pipe.prepare(
        cfg,
        corpora=[SYNTHETIC, TICKETS],
        out_dir=out_dir,
        dataset_version="enthusia-ai-dataset-2026.10.03-v1",
        ledger_path=str(tmp_path / "ledger.json"),
        run_eval_before=False,
    )
    assert result.stage == "prepare"
    assert result.budget["estimate"]["total_usd"] == 0.0
    assert result.budget["allowed"] is True
    counts = result.dataset["counts"]
    assert counts["train"] + counts["validation"] == 6
    assert result.training["executed"] is False
    assert "--model_name_or_path" in result.training["command"]
    assert result.export["dry_run_plan"]
    # Run record persisted.
    assert os.path.isfile(os.path.join(out_dir, "prepare.json"))


def test_prepare_refuses_over_budget(tmp_path):
    cfg = config_mod.load_and_validate(os.path.join(CONFIGS, "full-run.yaml"))
    raw = dict(cfg.raw)
    raw["budget"] = dict(raw["budget"])
    raw["budget"]["price_per_hour_usd"] = 5.00  # $120 + $2 > $25
    over = config_mod.validate_config(raw)
    with pytest.raises(Exception, match="REFUSED"):
        pipe.prepare(
            over,
            corpora=[SYNTHETIC],
            out_dir=str(tmp_path / "runs"),
            dataset_version="enthusia-ai-dataset-2026.10.03-v1",
            ledger_path=str(tmp_path / "ledger.json"),
            run_eval_before=False,
        )


def test_train_always_refused(tmp_path):
    cfg = _smoke_cfg()
    with pytest.raises(pipe.TrainingNotPermittedError, match="never starts training"):
        pipe.train(cfg, ledger_path=str(tmp_path / "ledger.json"))


def test_cli_validate_config(capsys):
    rc = pipe.main(["validate-config", "--config", os.path.join(CONFIGS, "smoke.yaml")])
    assert rc == 0
    assert "config OK" in capsys.readouterr().out


def test_cli_check_budget(capsys):
    rc = pipe.main(
        ["check-budget", "--config", os.path.join(CONFIGS, "full-run.yaml"),
         "--ledger", "/tmp/w19-test-ledger-nonexistent.json"]
    )
    assert rc == 0
    assert "within budget" in capsys.readouterr().out


def test_cli_assemble(tmp_path, capsys):
    out_dir = str(tmp_path / "ds")
    rc = pipe.main(
        ["assemble", "--corpora", SYNTHETIC, TICKETS, "--out-dir", out_dir,
         "--dataset-version", "enthusia-ai-dataset-2026.10.03-v1"]
    )
    assert rc == 0
    assert os.path.isfile(os.path.join(out_dir, "manifest.json"))
    assert os.path.isfile(os.path.join(out_dir, "train.jsonl"))


def test_cli_export_plan(capsys):
    rc = pipe.main(["export-plan", "--config", os.path.join(CONFIGS, "smoke.yaml")])
    assert rc == 0
    assert "llama-quantize" in capsys.readouterr().out
