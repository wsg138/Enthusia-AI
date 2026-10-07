"""Build a reference-only rewrite queue from governed W18 positive candidates.

Historical ticket conversations are valuable because they preserve real player
phrasing, follow-up structure, evidence requests, and operational context.
Historical staff replies are not automatically suitable imitation targets.

This module therefore creates a second, explicit gate:
- every historical assistant message and expected_answer is reference-only;
- target_answer starts null;
- training_eligible is always false;
- a later review/rewrite step must author a verified target and relabel the
  finished record GOOD/IDEAL before W16/W19 can admit it.

No real-ticket artifact may be written inside a Git worktree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any

REWRITE_INPUT_QUALITIES = frozenset({"IDEAL", "GOOD", "USABLE_WITH_EDIT"})
REFERENCE_ONLY_NOTICE = (
    "Historical staff text is context/reference only and must not be copied "
    "as a training target without rewrite and current verification."
)


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
    return any((candidate / ".git").exists() for candidate in (current, *current.parents))


def _write_new_text(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
    except (OSError, UnicodeError):
        path.unlink(missing_ok=True)
        raise


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{lineno}: expected a JSON object")
            records.append(value)
    return records


def _rewrite_requirements(record: dict[str, Any]) -> list[str]:
    reasons = {
        str(reason)
        for reason in record.get("quality_reasons", [])
        if isinstance(reason, str)
    }
    requirements = [
        "Answer the player's actual problem clearly and concisely.",
        "Use current verified facts/tools for mutable server state.",
        "Do not copy historical staff shorthand, insults, guesses, or uncertainty.",
        "Do not claim an action happened unless the final example contains explicit tool/result evidence for that action.",
        "Escalate or ask for missing evidence when the assistant lacks authority or sufficient proof.",
    ]
    if reasons & {
        "volatile_claim_requires_verification",
        "current_state_claim_requires_verification",
        "high_stale_risk_claim",
    }:
        requirements.append(
            "Re-verify commands, permissions, prices, versions, configuration, and bug status before writing the target."
        )
    if "staff_action_claim_requires_context" in reasons:
        requirements.append(
            "Rewrite one-off staff actions as a safe process/next-step answer unless a tool trace proves the same action."
        )
    if "human_decision_like_content" in reasons:
        requirements.append(
            "Do not teach a prior punishment/appeal outcome as policy; preserve only reusable process guidance."
        )
    if "missing_evidence_request" in reasons:
        requirements.append(
            "Add the minimal evidence request needed to resolve the case safely."
        )
    if "thin_staff_response" in reasons:
        requirements.append(
            "Replace the thin historical reply with a complete standalone answer."
        )
    if "chatter_to_trim" in reasons:
        requirements.append("Remove social chatter that does not help solve the problem.")
    if "contains_redactions" in reasons or "secret_redacted" in reasons:
        requirements.append(
            "Do not reconstruct or infer redacted private/secret information."
        )
    return requirements


def _build_case(record: dict[str, Any]) -> dict[str, Any]:
    rid = record.get("id")
    if not isinstance(rid, str) or not rid.strip():
        raise ValueError("candidate missing non-empty id")

    quality = record.get("quality")
    if quality not in REWRITE_INPUT_QUALITIES:
        raise ValueError(
            f"{rid}: rewrite queue accepts only {sorted(REWRITE_INPUT_QUALITIES)}, "
            f"got {quality!r}"
        )

    messages = record.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError(f"{rid}: messages must be a non-empty list")

    reference_transcript: list[dict[str, str]] = []
    player_context: list[str] = []
    historical_staff_reference: list[str] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise ValueError(f"{rid}: messages[{index}] must be an object")
        role = message.get("role")
        content = message.get("content")
        if role not in {"user", "assistant", "system", "tool"}:
            raise ValueError(f"{rid}: unsupported role {role!r}")
        if not isinstance(content, str):
            raise ValueError(f"{rid}: messages[{index}].content must be text")
        reference_transcript.append({"role": role, "content": content})
        if role == "user":
            player_context.append(content)
        elif role == "assistant":
            historical_staff_reference.append(content)

    expected = record.get("expected_answer", "")
    if not isinstance(expected, str):
        raise ValueError(f"{rid}: expected_answer must be text")

    return {
        "case_id": rid,
        "ticket_id": str(record.get("ticket_id", "")),
        "source_type": "historical_ticket",
        "scenario": str(record.get("scenario", "")),
        "historical_quality": quality,
        "historical_quality_reasons": list(record.get("quality_reasons", [])),
        "tags": list(record.get("tags", [])),
        "player_context": player_context,
        "reference_transcript": reference_transcript,
        "historical_staff_reference": historical_staff_reference,
        "historical_expected_answer_reference": expected,
        "evidence_requests": list(record.get("evidence_requests", [])),
        "staff_decisions_reference_only": list(record.get("staff_decisions", [])),
        "stale_claims_reference_only": list(record.get("stale_claims", [])),
        "reference_only_notice": REFERENCE_ONLY_NOTICE,
        "rewrite_requirements": _rewrite_requirements(record),
        "target_answer": None,
        "target_quality": "UNREVIEWED",
        "training_eligible": False,
    }


def build_rewrite_queue(*, input_path: str, output_dir: str) -> dict[str, Any]:
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

    records = _load_jsonl(source)
    cases = [_build_case(record) for record in records]
    cases.sort(key=lambda item: item["case_id"])

    target.mkdir(parents=True, mode=0o700)
    queue_path = target / "rewrite-queue.jsonl"
    manifest_path = target / "manifest.json"
    _write_new_text(
        queue_path,
        "".join(
            json.dumps(case, ensure_ascii=False, sort_keys=True) + "\n"
            for case in cases
        ),
    )

    counts = Counter(case["historical_quality"] for case in cases)
    manifest = {
        "schema_version": 1,
        "status": "rewrite_required_not_admitted",
        "input": {
            "path": str(source),
            "records": len(records),
            "sha256": _sha256(source),
        },
        "counts": {
            "rewrite_cases": len(cases),
            "historical_quality": dict(sorted(counts.items())),
            "training_eligible": 0,
        },
        "policy": {
            "historical_staff_responses": "reference_only",
            "direct_training_from_historical_answers": False,
            "admission_requires": "rewritten + verified + reviewed GOOD/IDEAL target",
        },
        "artifacts": {
            queue_path.name: _sha256(queue_path),
        },
        "next_gate": (
            "Generate or author target_answer using current grounded evidence, "
            "review the target, then create a separate W16 candidate. This "
            "rewrite queue itself is never trainable."
        ),
    }
    _write_new_text(
        manifest_path,
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build a reference-only rewrite queue from W18 positive review candidates."
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)

    manifest = build_rewrite_queue(
        input_path=args.input,
        output_dir=args.output_dir,
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
