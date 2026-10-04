"""GGUF export planning and execution wrapper.

The export step merges the LoRA adapter into the base model and converts
to GGUF via llama.cpp for local inference (spec sections 24/25):

    merged (16-bit)  ->  convert to GGUF (F16)  ->  quantize (Q4_K_M default)

This module never assumes a model is present. `plan_export()` builds the
concrete shell commands; `run_export()` executes them unless `dry_run` is
set (the default), in which case it only validates inputs and prints the
plan. Real export happens on the owner's PC or the rented GPU host, where
llama.cpp and the merged weights exist.

`write_artifact_manifest()` records the export artifact per the W19
acceptance list: base model, adapter, dataset version, hyperparameters,
hashes, evaluation report.
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
from dataclasses import dataclass, field

ALLOWED_QUANTS = ("Q4_K_M", "Q5_K_M", "Q8_0", "Q4_0", "Q6_K")


class ExportError(RuntimeError):
    """Raised when export planning or execution fails."""


@dataclass
class ExportPlan:
    base_model: str
    adapter_dir: str
    out_gguf: str
    quant: str
    llamacpp_dir: str
    merged_dir: str
    commands: list[str] = field(default_factory=list)

    def describe(self) -> str:
        lines = [
            f"base model : {self.base_model}",
            f"adapter    : {self.adapter_dir}",
            f"merged dir : {self.merged_dir}",
            f"output     : {self.out_gguf} ({self.quant})",
            f"llama.cpp  : {self.llamacpp_dir}",
            "commands   :",
        ]
        for i, cmd in enumerate(self.commands, 1):
            lines.append(f"  [{i}] {cmd}")
        return "\n".join(lines)


def plan_export(
    *,
    base_model: str,
    adapter_dir: str,
    out_gguf: str,
    quant: str = "Q4_K_M",
    llamacpp_dir: str = "llama.cpp",
    merged_dir: str | None = None,
) -> ExportPlan:
    """Build the export command plan. Raises ExportError on bad inputs."""
    if quant not in ALLOWED_QUANTS:
        raise ExportError(
            f"unsupported quant {quant!r}; choose one of {list(ALLOWED_QUANTS)}"
        )
    if not base_model or not adapter_dir or not out_gguf:
        raise ExportError("base_model, adapter_dir and out_gguf are all required")
    merged = merged_dir or os.path.join(os.path.dirname(out_gguf) or ".", "merged-fp16")
    f16_gguf = out_gguf + ".f16.tmp"

    # 1. Merge LoRA adapter into base weights (HF PEFT; runs on GPU host).
    merge_cmd = " ".join(
        shlex.quote(a)
        for a in (
            "python",
            "-m",
            "enthusia_finetune.merge_adapter",
            "--base",
            base_model,
            "--adapter",
            adapter_dir,
            "--out",
            merged,
        )
    )
    # 2. Convert merged HF model to GGUF (F16).
    convert_cmd = " ".join(
        shlex.quote(a)
        for a in (
            "python",
            os.path.join(llamacpp_dir, "convert_hf_to_gguf.py"),
            merged,
            "--outfile",
            f16_gguf,
            "--outtype",
            "f16",
        )
    )
    # 3. Quantize to the target precision.
    quantize_cmd = " ".join(
        shlex.quote(a)
        for a in (
            os.path.join(llamacpp_dir, "build", "bin", "llama-quantize"),
            f16_gguf,
            out_gguf,
            quant,
        )
    )
    return ExportPlan(
        base_model=base_model,
        adapter_dir=adapter_dir,
        out_gguf=out_gguf,
        quant=quant,
        llamacpp_dir=llamacpp_dir,
        merged_dir=merged,
        commands=[merge_cmd, convert_cmd, quantize_cmd],
    )


def run_export(plan: ExportPlan, *, dry_run: bool = True) -> dict:
    """Validate inputs and (unless dry_run) execute the export commands.

    Always returns a result dict describing what was/would be done.
    Dry-run mode performs every check except executing commands.
    """
    result = {
        "dry_run": dry_run,
        "plan": {
            "base_model": plan.base_model,
            "adapter_dir": plan.adapter_dir,
            "out_gguf": plan.out_gguf,
            "quant": plan.quant,
        },
        "commands": plan.commands,
        "executed": [],
    }
    if not os.path.isdir(plan.adapter_dir):
        raise ExportError(
            f"adapter dir not found: {plan.adapter_dir} "
            "(train the adapter first, or run with --dry-run to only plan)"
        )
    convert_script = os.path.join(plan.llamacpp_dir, "convert_hf_to_gguf.py")
    quantize_bin = os.path.join(plan.llamacpp_dir, "build", "bin", "llama-quantize")
    if not dry_run:
        for path in (convert_script, quantize_bin):
            if not os.path.exists(path):
                raise ExportError(f"llama.cpp tool missing: {path}")

    for cmd in plan.commands:
        if dry_run:
            print(f"[dry-run] {cmd}")
            continue
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        result["executed"].append({"command": cmd, "returncode": proc.returncode})
        if proc.returncode != 0:
            raise ExportError(
                f"export command failed (rc={proc.returncode}): {cmd}\n{proc.stderr[-2000:]}"
            )
    if not dry_run and os.path.isfile(plan.out_gguf):
        result["gguf_sha256"] = _sha256_file(plan.out_gguf)
        result["gguf_bytes"] = os.path.getsize(plan.out_gguf)
    return result


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_dir_meta(adapter_dir: str) -> dict:
    """Best-effort adapter fingerprint: config + weight file names/sizes."""
    files = {}
    for root, _dirs, names in os.walk(adapter_dir):
        for name in sorted(names):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, adapter_dir)
            files[rel] = os.path.getsize(full)
    return files


def write_artifact_manifest(
    *,
    path: str,
    training_config,  # TrainingConfig
    adapter_dir: str,
    gguf_path: str,
    eval_reports: dict | None = None,
) -> dict:
    """Write the export artifact manifest (W19 acceptance artifact).

    Includes base model, adapter, dataset version, hyperparameters,
    hashes, and evaluation report references (spec sections 18/24).
    """
    manifest = {
        "base_model": training_config.base_model,
        "adapter_dir": adapter_dir,
        "adapter_files": _sha256_dir_meta(adapter_dir)
        if os.path.isdir(adapter_dir)
        else None,
        "dataset_version": training_config.dataset["version"],
        "hyperparameters": training_config.artifact_summary(),
        "gguf": {
            "path": gguf_path,
            "quant": training_config.output["quant"],
            "sha256": _sha256_file(gguf_path) if os.path.isfile(gguf_path) else None,
            "bytes": os.path.getsize(gguf_path) if os.path.isfile(gguf_path) else None,
        },
        "evaluation_reports": eval_reports or {},
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return manifest


__all__ = [
    "ALLOWED_QUANTS",
    "ExportError",
    "ExportPlan",
    "plan_export",
    "run_export",
    "write_artifact_manifest",
]
