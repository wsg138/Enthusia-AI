"""Adapter-merge helper for the export step.

Run on the GPU host (or the owner's PC) where the base model and the
trained LoRA adapter exist:

    python -m enthusia_finetune.merge_adapter --base <model-id-or-path> \
        --adapter <adapter-dir> --out <merged-dir>

Requires `transformers` and `peft`. This module is intentionally NOT
imported by the rest of the package at import time, so the pipeline
planning tools work without GPU/ML dependencies installed.
"""

from __future__ import annotations

import argparse
import os


def merge(base: str, adapter: str, out: str) -> str:
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from peft import PeftModel
    except ImportError as exc:  # pragma: no cover - needs ML deps
        raise SystemExit(
            "merge_adapter needs `transformers` and `peft` installed "
            f"on the training/export host: {exc}"
        )

    print(f"loading base model: {base}")
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype="auto")
    print(f"loading adapter: {adapter}")
    model = PeftModel.from_pretrained(model, adapter)
    print("merging adapter into base weights...")
    merged = model.merge_and_unload()
    os.makedirs(out, exist_ok=True)
    merged.save_pretrained(out)
    tok = AutoTokenizer.from_pretrained(base)
    tok.save_pretrained(out)
    print(f"merged model written to {out}")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Merge a LoRA adapter into its base model.")
    ap.add_argument("--base", required=True, help="base model id or local path")
    ap.add_argument("--adapter", required=True, help="trained LoRA adapter directory")
    ap.add_argument("--out", required=True, help="output dir for merged FP16 model")
    args = ap.parse_args(argv)
    merge(args.base, args.adapter, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
