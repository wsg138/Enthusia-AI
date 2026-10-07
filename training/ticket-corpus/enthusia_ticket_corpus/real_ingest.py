"""Governed ingestion of real Support Bot ticket exports.

This module is intentionally separate from fixture tests. It converts a restricted
JSONL export into *review* artifacts only. Nothing emitted here is automatically
admitted to W16 training partitions.

Safety properties:
- requires an explicit governance acknowledgement;
- first pass is limited to closed GENERAL_SUPPORT and BUG_REPORT records;
- refuses input/output paths inside Git worktrees to reduce accidental commits;
- writes into a new output directory with restrictive permissions where supported;
- keeps rejection logs content-free;
- relies on the W18 pipeline for secret removal, PII redaction, stale-fact marking,
  quality labels, and candidate schema validation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from .pipeline import PipelineConfig, load_fixtures, run_pipeline

DIRECT_SCOPE = {"general_support", "bug_report"}
POSITIVE_REVIEW_LABELS = {"IDEAL", "GOOD", "USABLE_WITH_EDIT"}
NEGATIVE_EVAL_LABELS = {"BAD_RESPONSE", "OUTDATED", "INCOMPLETE"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inside_git_worktree(path: Path) -> bool:
    current = path.resolve()
    if current.is_file():
        current = current.parent
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return True
    return False


def _write_new_text(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
    except Exception:
        try:
            path.unlink(missing_ok=True)
        finally:
            raise


def _jsonl(records: list[dict[str, Any]]) -> str:
    return "".join(
        json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
        for record in records
    )


def _scope_filter(raws: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    included: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    for raw in raws:
        ticket_id = str(raw.get("ticket_id", "?"))
        category = str(raw.get("category", "")).strip().lower()
        if category not in DIRECT_SCOPE:
            rejected.append({"ticket_id": ticket_id, "reason": "outside_first_pass_scope"})
            continue
        if not str(raw.get("closed_at", "")).strip():
            rejected.append({"ticket_id": ticket_id, "reason": "ticket_not_closed"})
            continue
        included.append(raw)
    return included, rejected


def _source_period(raws: list[dict[str, Any]]) -> dict[str, str | None]:
    values = sorted(
        {
            str(raw.get(field, "")).strip()
            for raw in raws
            for field in ("created_at", "closed_at")
            if str(raw.get(field, "")).strip()
        }
    )
    return {
        "earliest": values[0] if values else None,
        "latest": values[-1] if values else None,
    }


def run_real_ingest(
    *,
    input_path: str,
    output_dir: str,
    dataset_version: str,
    reference_date: str,
    run_id: str,
    operator: str,
    governance_acknowledged: bool,
    live_facts: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Process one governed real-ticket export into review-only artifacts."""

    if not governance_acknowledged:
        raise ValueError(
            "Real ticket ingestion is blocked until the run-specific governance "
            "checkpoint is complete; pass --ack-governance only after that sign-off."
        )
    if not dataset_version.strip():
        raise ValueError("dataset_version must be non-empty")
    if not reference_date.strip():
        raise ValueError("reference_date must be non-empty")
    try:
        datetime.fromisoformat(reference_date.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("reference_date must be ISO-8601") from exc
    if not run_id.strip():
        raise ValueError("run_id must be non-empty")
    if not operator.strip():
        raise ValueError("operator must be non-empty")

    source_arg = Path(input_path).expanduser()
    if source_arg.is_symlink():
        raise ValueError("input must be a regular, non-symlink JSONL file")
    source = source_arg.resolve()
    target = Path(output_dir).expanduser().resolve()

    if not source.is_file():
        raise ValueError("input must be a regular, non-symlink JSONL file")
    if _inside_git_worktree(source):
        raise ValueError("refusing real-ticket input stored inside a Git worktree")
    if target.exists():
        raise ValueError("output directory must not already exist")
    if _inside_git_worktree(target.parent):
        raise ValueError("refusing real-ticket artifacts inside a Git worktree")

    raws = load_fixtures(str(source))
    in_scope, scope_rejections = _scope_filter(raws)

    config = PipelineConfig(
        reference_date=reference_date,
        live_facts=live_facts or {},
        dataset_version=dataset_version,
        governance_ref="training/datasets/GOVERNANCE-CHECKPOINT.md",
    )
    result = run_pipeline(in_scope, config)

    positive = [
        candidate for candidate in result.candidates
        if candidate.get("quality") in POSITIVE_REVIEW_LABELS
    ]
    negative = [
        candidate for candidate in result.candidates
        if candidate.get("quality") in NEGATIVE_EVAL_LABELS
    ]
    unknown_quality = [
        candidate for candidate in result.candidates
        if candidate.get("quality") not in POSITIVE_REVIEW_LABELS | NEGATIVE_EVAL_LABELS
    ]
    if unknown_quality:
        raise RuntimeError(
            "pipeline produced candidate quality outside the governed review partitions"
        )

    content_free_rejections = scope_rejections + [
        {
            "ticket_id": str(item.get("ticket_id", "?")),
            "reason": str(item.get("reason", "unknown")),
        }
        for item in result.rejected
    ]

    target.mkdir(parents=True, mode=0o700)
    try:
        os.chmod(target, 0o700)
    except OSError:
        pass

    positive_path = target / "positive-review-candidates.jsonl"
    negative_path = target / "negative-eval-candidates.jsonl"
    rejected_path = target / "rejected.jsonl"
    manifest_path = target / "manifest.json"

    _write_new_text(positive_path, _jsonl(positive))
    _write_new_text(negative_path, _jsonl(negative))
    _write_new_text(rejected_path, _jsonl(content_free_rejections))

    quality_counts = Counter(
        str(candidate.get("quality", "UNKNOWN"))
        for candidate in result.candidates
    )
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "status": "review_required_not_admitted",
        "run_id": run_id,
        "operator": operator,
        "dataset_version": dataset_version,
        "reference_date": reference_date,
        "governance_ref": "training/datasets/GOVERNANCE-CHECKPOINT.md",
        "first_pass_ticket_types": sorted(DIRECT_SCOPE),
        "source_period": _source_period(in_scope),
        "raw_retention_policy": "delete raw export within 30 days after successful pipeline consumption",
        "input": {
            "records": len(raws),
            "sha256": _sha256(source),
        },
        "counts": {
            "in_scope": len(in_scope),
            "positive_review_candidates": len(positive),
            "negative_eval_candidates": len(negative),
            "rejected": len(content_free_rejections),
            "quality": dict(sorted(quality_counts.items())),
        },
        "artifacts": {
            positive_path.name: _sha256(positive_path),
            negative_path.name: _sha256(negative_path),
            rejected_path.name: _sha256(rejected_path),
        },
        "next_gate": (
            "Manual real-ticket sample review, then W16 secret scan/dedupe/"
            "leak-group splitting/versioning before any training admission."
        ),
    }
    _write_new_text(
        manifest_path,
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    )
    return manifest


def _load_live_facts(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in raw.items()
    ):
        raise ValueError("--live-facts-json must contain a JSON object of string pairs")
    return raw


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Sanitize a governed Support Bot historical-ticket export into W18 review artifacts."
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--reference-date", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--operator", required=True)
    parser.add_argument("--live-facts-json")
    parser.add_argument("--ack-governance", action="store_true")
    args = parser.parse_args(argv)

    manifest = run_real_ingest(
        input_path=args.input,
        output_dir=args.output_dir,
        dataset_version=args.dataset_version,
        reference_date=args.reference_date,
        run_id=args.run_id,
        operator=args.operator,
        governance_acknowledged=args.ack_governance,
        live_facts=_load_live_facts(args.live_facts_json),
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
