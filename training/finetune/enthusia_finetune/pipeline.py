"""Fine-tune pipeline orchestrator.

Stages (WORKER-EXECUTION-PLAN section 22):

    prepare  -> budget check -> dataset assembly -> eval-before -> (train) -> eval-after -> export

`prepare` runs fully locally for $0: it validates the config, enforces the
$25 budget cap, assembles the dataset, runs W20's golden suite against the
baseline ("before"), and prints the exact training command to execute on
the approved GPU host. It also writes the export plan in dry-run mode.

The `train` step is deliberately NOT executed by this pipeline in the
current environment:

- Constraint: NO actual training runs, NO GPU usage, NO model downloads.
- Training happens only on the owner's PC or a rented GPU host, started
  explicitly by the owner with the printed command, AFTER the budget
  check passes.

`pipeline train` therefore refuses with TrainingNotPermittedError and
points at the documented command. When the run is performed elsewhere,
the returned artifacts (adapter dir, eval reports) are fed back into
`pipeline export` to produce the GGUF and the artifact manifest.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from dataclasses import dataclass, field

from . import assembly as asm
from . import budget as budget_mod
from . import config as config_mod
from . import eval_hooks
from . import export as export_mod


class TrainingNotPermittedError(RuntimeError):
    """Raised when a training execution is attempted in a non-GPU context."""


@dataclass
class PipelineResult:
    stage: str
    config_name: str
    budget: dict = field(default_factory=dict)
    dataset: dict = field(default_factory=dict)
    eval_before: dict = field(default_factory=dict)
    training: dict = field(default_factory=dict)
    eval_after: dict = field(default_factory=dict)
    export: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "stage": self.stage,
            "config_name": self.config_name,
            "budget": self.budget,
            "dataset": self.dataset,
            "eval_before": self.eval_before,
            "training": self.training,
            "eval_after": self.eval_after,
            "export": self.export,
        }


def _default_out_dir(config_name: str) -> str:
    return os.path.join("runs", config_name)


def _training_command(
    *,
    config_path: str,
    train_path: str,
    validation_path: str | None,
) -> str:
    args = [
        "python",
        "-m",
        "enthusia_finetune.trainer",
        "--config",
        config_path,
        "--train-json",
        train_path,
    ]
    if validation_path:
        args.extend(["--validation-json", validation_path])
    return " ".join(shlex.quote(str(arg)) for arg in args)


def prepare(
    cfg: config_mod.TrainingConfig,
    *,
    corpora: list[str],
    out_dir: str,
    dataset_version: str,
    ledger_path: str,
    run_eval_before: bool = True,
    split_seed: int = 1337,
    ticket_review_manifest: str | None = None,
) -> PipelineResult:
    """Run every $0 local stage: budget -> assembly -> eval-before -> plans."""
    result = PipelineResult(stage="prepare", config_name=cfg.name)

    # 1. Budget gate — refuses before anything else.
    check = budget_mod.check_budget(cfg.raw["budget"], ledger_path)
    result.budget = {
        "estimate": check.estimate.as_dict(),
        "spent_before_usd": check.spent_before_usd,
        "allowed": check.allowed,
        "owner_override": check.owner_override,
        "reason": check.reason,
    }
    if check.owner_override:
        print(f"WARNING: {check.reason}", file=sys.stderr)

    # 2. Dataset assembly.
    dataset_dir = os.path.join(out_dir, "dataset")
    manifest = asm.assemble(
        corpora,
        dataset_dir,
        dataset_version=dataset_version,
        generator=f"enthusia-finetune/{cfg.name}",
        split_config=asm.SplitConfig(seed=split_seed),
        ticket_review_manifest=ticket_review_manifest,
    )
    result.dataset = {
        "version": manifest["dataset_version"],
        "dir": dataset_dir,
        "counts": manifest["counts"],
        "outputs": manifest["outputs"],
    }

    train_path = os.path.join(dataset_dir, manifest["outputs"]["train"]["path"])
    validation_path = os.path.join(
        dataset_dir, manifest["outputs"]["validation"]["path"]
    )
    resolved_raw = dict(cfg.raw)
    resolved_raw["dataset"] = {
        "version": dataset_version,
        "train_path": train_path,
        "validation_path": validation_path,
    }
    resolved_config_path = os.path.join(out_dir, "resolved-training-config.json")
    os.makedirs(out_dir, exist_ok=True)
    with open(resolved_config_path, "w", encoding="utf-8") as handle:
        json.dump(resolved_raw, handle, indent=2, sort_keys=True)
        handle.write("\n")
    # Validate the exact persisted config that the GPU host will consume.
    config_mod.validate_config(resolved_raw)

    # 3. Eval-before (golden suite against the baseline).
    eval_dir = (cfg.eval or {}).get("w20_checkout", "")
    eval_out = os.path.join(out_dir, "evals", "before.json")
    if run_eval_before and eval_dir:
        res = eval_hooks.run_suite(
            eval_dir=eval_dir, report_path=eval_out, phase="before"
        )
        result.eval_before = res.as_dict()
    elif run_eval_before:
        result.eval_before = {
            "skipped": True,
            "reason": "config[eval.w20_checkout] not set; point it at the built W20 package",
        }

    # 4. Real executable training command for the approved GPU host.
    result.training = {
        "executed": False,
        "command": _training_command(
            config_path=resolved_config_path,
            train_path=train_path,
            validation_path=validation_path,
        ),
        "config_path": resolved_config_path,
        "train_path": train_path,
        "validation_path": validation_path,
        "note": "Execute this command on the approved GPU host AFTER the budget "
        "and dataset gates above pass. The prepare pipeline itself never consumes GPU.",
    }

    # 5. Export plan (dry-run).
    plan = export_mod.plan_export(
        base_model=cfg.base_model,
        adapter_dir=cfg.output["adapter_dir"],
        out_gguf=cfg.output["gguf_path"],
        quant=cfg.output["quant"],
    )
    result.export = {"dry_run_plan": plan.describe().splitlines()}

    # Persist the run record.
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "prepare.json"), "w", encoding="utf-8") as fh:
        json.dump(result.as_dict(), fh, indent=2, sort_keys=True)
        fh.write("\n")
    return result


def train(cfg: config_mod.TrainingConfig, *, ledger_path: str) -> PipelineResult:
    """Refuse training execution in this environment (no GPU, no budget spent)."""
    check = budget_mod.check_budget(cfg.raw["budget"], ledger_path)
    raise TrainingNotPermittedError(
        "Training execution is disabled in this pipeline context: NO actual "
        "training runs are permitted here (no GPU usage, no budget spent). "
        "This pipeline never starts training itself.\n"
        f"Budget check for reference: {check.reason}\n"
        "To train: run `finetune pipeline --stage prepare` to validate everything, "
        "then execute the concrete `python -m enthusia_finetune.trainer ...` "
        "command recorded in prepare.json on the approved GPU host."
    )


def export_run(
    cfg: config_mod.TrainingConfig,
    *,
    adapter_dir: str,
    eval_before_path: str | None,
    eval_after_path: str | None,
    out_dir: str,
    dry_run: bool = True,
) -> dict:
    """Plan/execute the GGUF export and write the artifact manifest."""
    plan = export_mod.plan_export(
        base_model=cfg.base_model,
        adapter_dir=adapter_dir,
        out_gguf=cfg.output["gguf_path"],
        quant=cfg.output["quant"],
    )
    exec_result = export_mod.run_export(plan, dry_run=dry_run)

    eval_reports = {}
    for phase, path in (("before", eval_before_path), ("after", eval_after_path)):
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8") as fh:
                report = json.load(fh)
            eval_reports[phase] = {"report_path": path, "summary": report}

    manifest = export_mod.write_artifact_manifest(
        path=os.path.join(out_dir, "artifact-manifest.json"),
        training_config=cfg,
        adapter_dir=adapter_dir,
        gguf_path=cfg.output["gguf_path"],
        eval_reports=eval_reports,
    )
    return {"export": exec_result, "artifact_manifest": manifest}


def build_cli() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="finetune",
        description="Enthusia AI fine-tune/export pipeline (W19).",
    )
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate-config", help="Load and validate a training config.")
    p.add_argument("--config", required=True)

    p = sub.add_parser("check-budget", help="Check a config's estimate against the $25 cap.")
    p.add_argument("--config", required=True)
    p.add_argument("--ledger", default="budget-ledger.json")

    p = sub.add_parser("assemble", help="Assemble train/validation from corpus JSONL files.")
    p.add_argument("--corpora", nargs="+", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--dataset-version", required=True)
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--ticket-review-manifest", default=None,
                   help="private independent review/admission manifest for worker-derived synthetic tickets")

    p = sub.add_parser("export-plan", help="Print the GGUF export plan (dry-run).")
    p.add_argument("--config", required=True)

    p = sub.add_parser("pipeline", help="Run pipeline stages (prepare refuses training).")
    p.add_argument("--config", required=True)
    p.add_argument("--stage", choices=("prepare", "train", "export"), default="prepare")
    p.add_argument("--corpora", nargs="*", default=[])
    p.add_argument("--out-dir", default=None)
    p.add_argument("--dataset-version", default=None)
    p.add_argument("--ledger", default="budget-ledger.json")
    p.add_argument("--ticket-review-manifest", default=None,
                   help="private independently approved ticket record manifest")
    p.add_argument("--adapter-dir", default=None)
    p.add_argument("--eval-before", default=None)
    p.add_argument("--eval-after", default=None)
    p.add_argument("--no-eval-before", action="store_true")
    p.add_argument("--execute-export", action="store_true",
                   help="Actually run export commands (default: dry-run).")
    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_cli()
    args = ap.parse_args(argv)

    if args.command == "validate-config":
        cfg = config_mod.load_and_validate(args.config)
        print(f"config OK: {cfg.name} (est. ${cfg.budget_estimate.total_usd:.2f})")
        return 0

    if args.command == "check-budget":
        cfg = config_mod.load_and_validate(args.config)
        check = budget_mod.check_budget(cfg.raw["budget"], args.ledger)
        print(check.reason)
        return 0

    if args.command == "assemble":
        manifest = asm.assemble(
            args.corpora,
            args.out_dir,
            dataset_version=args.dataset_version,
            split_config=asm.SplitConfig(seed=args.seed),
            ticket_review_manifest=args.ticket_review_manifest,
        )
        print(json.dumps(manifest["counts"], indent=2))
        return 0

    if args.command == "export-plan":
        cfg = config_mod.load_and_validate(args.config)
        plan = export_mod.plan_export(
            base_model=cfg.base_model,
            adapter_dir=cfg.output["adapter_dir"],
            out_gguf=cfg.output["gguf_path"],
            quant=cfg.output["quant"],
        )
        print(plan.describe())
        return 0

    if args.command == "pipeline":
        cfg = config_mod.load_and_validate(args.config)
        out_dir = args.out_dir or _default_out_dir(cfg.name)
        if args.stage == "prepare":
            if not args.corpora:
                print("pipeline prepare needs --corpora", file=sys.stderr)
                return 2
            if not args.dataset_version:
                print("pipeline prepare needs --dataset-version", file=sys.stderr)
                return 2
            result = prepare(
                cfg,
                corpora=args.corpora,
                out_dir=out_dir,
                dataset_version=args.dataset_version,
                ledger_path=args.ledger,
                run_eval_before=not args.no_eval_before,
                ticket_review_manifest=args.ticket_review_manifest,
            )
            print(json.dumps(result.as_dict(), indent=2))
            return 0
        if args.stage == "train":
            train(cfg, ledger_path=args.ledger)
            return 0  # unreachable: train() always raises
        if args.stage == "export":
            if not args.adapter_dir:
                print("pipeline export needs --adapter-dir", file=sys.stderr)
                return 2
            out = export_run(
                cfg,
                adapter_dir=args.adapter_dir,
                eval_before_path=args.eval_before,
                eval_after_path=args.eval_after,
                out_dir=out_dir,
                dry_run=not args.execute_export,
            )
            print(json.dumps(out["artifact_manifest"], indent=2))
            return 0
    return 2


__all__ = ["prepare", "train", "export_run", "build_cli", "main", "PipelineResult",
           "TrainingNotPermittedError"]


if __name__ == "__main__":
    raise SystemExit(main())
