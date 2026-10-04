"""Tests for the GGUF export planner and the eval-hook runner."""

from __future__ import annotations

import json
import os
import stat

import pytest

from enthusia_finetune import eval_hooks, export
from enthusia_finetune.eval_hooks import EvalHookError, compare, run_suite
from enthusia_finetune.export import ExportError, plan_export, run_export


def test_plan_has_three_commands():
    plan = plan_export(
        base_model="org/model",
        adapter_dir="runs/x/adapter",
        out_gguf="runs/x/model.Q4_K_M.gguf",
        quant="Q4_K_M",
        llamacpp_dir="llama.cpp",
    )
    assert len(plan.commands) == 3
    text = "\n".join(plan.commands)
    assert "merge_adapter" in text
    assert "convert_hf_to_gguf.py" in text
    assert "llama-quantize" in text
    assert "Q4_K_M" in text


def test_plan_rejects_bad_quant():
    with pytest.raises(ExportError, match="quant"):
        plan_export(base_model="m", adapter_dir="a", out_gguf="o.gguf", quant="FP64")


def test_plan_rejects_missing_inputs():
    with pytest.raises(ExportError):
        plan_export(base_model="", adapter_dir="a", out_gguf="o.gguf")


def test_dry_run_does_not_execute(tmp_path, capsys):
    adapter = tmp_path / "adapter"
    adapter.mkdir()
    plan = plan_export(
        base_model="org/model",
        adapter_dir=str(adapter),
        out_gguf=str(tmp_path / "model.gguf"),
    )
    result = run_export(plan, dry_run=True)
    assert result["dry_run"] is True
    assert result["executed"] == []
    out = capsys.readouterr().out
    assert "dry-run" in out
    assert not (tmp_path / "model.gguf").exists()


def test_export_requires_adapter_dir(tmp_path):
    plan = plan_export(
        base_model="org/model",
        adapter_dir=str(tmp_path / "nope"),
        out_gguf=str(tmp_path / "model.gguf"),
    )
    with pytest.raises(ExportError, match="adapter dir not found"):
        run_export(plan, dry_run=True)


def test_export_executes_commands_when_not_dry_run(tmp_path):
    adapter = tmp_path / "adapter"
    adapter.mkdir()
    out_gguf = tmp_path / "model.gguf"
    plan = plan_export(
        base_model="org/model", adapter_dir=str(adapter), out_gguf=str(out_gguf)
    )
    # Replace real commands with a harmless one that creates the output.
    plan.commands = [f"touch {out_gguf}"]
    (tmp_path / "llama.cpp").mkdir()
    open(tmp_path / "llama.cpp" / "convert_hf_to_gguf.py", "w").close()
    (tmp_path / "llama.cpp" / "build" / "bin").mkdir(parents=True)
    open(tmp_path / "llama.cpp" / "build" / "bin" / "llama-quantize", "w").close()
    plan.llamacpp_dir = str(tmp_path / "llama.cpp")
    result = run_export(plan, dry_run=False)
    assert result["executed"][0]["returncode"] == 0
    assert "gguf_sha256" in result


def test_eval_hook_runs_command_and_reads_report(tmp_path):
    eval_dir = tmp_path / "evalpkg"
    eval_dir.mkdir()
    report = tmp_path / "r.json"
    script = tmp_path / "fake-eval.py"
    script.write_text(
        "import json, sys\n"
        "out = sys.argv[sys.argv.index('--out') + 1]\n"
        "json.dump({'dataset': {'name': 'golden', 'version': 'v1', 'frozen': True}, 'passed': 7, 'failed': 1, 'pass_rate': 0.875}, open(out, 'w'))\n",
        encoding="utf-8",
    )
    res = run_suite(
        eval_dir=str(eval_dir),
        report_path=str(report),
        phase="before",
        eval_cmd=("python3", str(script)),
    )
    assert res.phase == "before"
    assert res.summary["pass_rate"] == 0.875
    assert json.loads(report.read_text())["passed"] == 7


def test_eval_hook_rejects_unfrozen_report(tmp_path):
    eval_dir = tmp_path / "evalpkg"
    eval_dir.mkdir()
    report = tmp_path / "seed.json"
    script = tmp_path / "fake-seed-eval.py"
    script.write_text(
        "import json, sys\n"
        "out = sys.argv[sys.argv.index('--out') + 1]\n"
        "json.dump({'dataset': {'name': 'golden', 'version': 'seed', 'frozen': False}}, open(out, 'w'))\n",
        encoding="utf-8",
    )
    with pytest.raises(EvalHookError, match="not from a frozen golden dataset"):
        run_suite(
            eval_dir=str(eval_dir),
            report_path=str(report),
            phase="before",
            eval_cmd=("python3", str(script)),
        )


def test_eval_hook_rejects_bad_phase(tmp_path):
    with pytest.raises(EvalHookError, match="phase"):
        run_suite(eval_dir=str(tmp_path), report_path="x", phase="during")


def test_eval_hook_missing_eval_dir():
    with pytest.raises(EvalHookError, match="not found"):
        run_suite(eval_dir="/nonexistent", report_path="x", phase="before")


def test_compare_deltas():
    before = eval_hooks.EvalResult("before", "b.json", {"pass_rate": 0.5, "passed": 5})
    after = eval_hooks.EvalResult("after", "a.json", {"pass_rate": 0.75, "passed": 6})
    cmp = compare(before, after)
    assert cmp["deltas"]["pass_rate"]["delta"] == pytest.approx(0.25)
    assert cmp["deltas"]["passed"]["delta"] == 1


def test_eval_hook_failing_command(tmp_path):
    script = tmp_path / "fail.py"
    script.write_text("import sys; sys.exit(3)", encoding="utf-8")
    with pytest.raises(EvalHookError, match="rc=3"):
        run_suite(
            eval_dir=str(tmp_path),
            report_path=str(tmp_path / "r.json"),
            phase="after",
            eval_cmd=("python3", str(script)),
        )
