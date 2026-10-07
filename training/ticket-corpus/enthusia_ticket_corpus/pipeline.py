"""End-to-end ticket corpus pipeline.

Stages (TRAINING-AND-EVALUATION-SPEC section 4):
   1. extract            5. identify problem       9.  label quality
   2. normalize          6. identify evidence      10. mark stale facts
   3. remove secrets     7. identify staff actions 11. build candidates
   4. mark speaker roles 8. identify outcome      12. review/filter

Deterministic: same fixtures + config -> identical output.
Only fixture data is processed (see GOVERNANCE-CHECKPOINT.md).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .extract import (
    Ticket,
    classify_category,
    parse_ticket,
    problem_statement,
)
from .outdated import markOutdated
from .patterns import extract_evidence_requests, extract_staff_decisions
from .privacy import severe_pii_exclusion_reason
from .quality import TicketContext, label_quality
from .redact import RedactionConfig, Redactor
from .schema import validate_candidate
from .secrets import remove_secrets

_CLAIM_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _extract_claims(text: str) -> list[str]:
    """Naive factual-claim splitter: sentences from staff answers."""
    return [s.strip() for s in _CLAIM_SPLIT_RE.split(text) if len(s.strip()) > 12]


@dataclass
class PipelineConfig:
    redaction: RedactionConfig = field(default_factory=RedactionConfig)
    max_age_days: int = 365
    reference_date: str = ""  # fixed "today" for deterministic runs; "" = now
    live_facts: dict[str, str] = field(default_factory=dict)
    dataset_version: str = "ticket-corpus-fixture-v1"
    governance_ref: str = "training/datasets/GOVERNANCE-CHECKPOINT.md"


@dataclass
class CorpusResult:
    candidates: list[dict]
    rejected: list[dict]  # {ticket_id, reason, detail} — content-free
    stats: dict


def _build_candidate(
    ticket: Ticket,
    ctx: TicketContext,
    label: str,
    reasons: tuple[str, ...],
    config: PipelineConfig,
) -> dict:
    scenario = (
        f"[{ctx.category}] {ctx.problem[:500]}"
        if ctx.problem
        else f"[{ctx.category}] (no problem statement)"
    )
    messages = [
        {
            "role": {"player": "user", "staff": "assistant", "bot": "tool"}[m.role],
            "content": f"{m.author_name}: {m.content}",
        }
        for m in ticket.messages
    ]
    staff_answer = "\n".join(m.content for m in ticket.staff_messages())
    facts = [
        {
            "claim": mc.claim,
            "source": f"ticket:{ticket.ticket_id}",
            "source_version": ticket.closed_at or ticket.created_at or "unknown",
        }
        for mc in ctx.marked_claims
    ]
    tags = [ctx.category, "ticket-corpus"]
    tags.extend(sorted({e["evidence_type"] for e in ctx.evidence_requests}))
    tags.extend(sorted({f"decision:{d['decision']}" for d in ctx.staff_decisions}))
    if any(mc.stale_risk == "high" for mc in ctx.marked_claims):
        tags.append("stale-truth")

    rec = {
        "id": f"ticket-{ticket.ticket_id}",
        "source_type": "ticket",
        # Ticket transcripts are staff-visible, never public (governance section 3).
        "visibility": "staff",
        "scenario": scenario,
        "messages": messages,
        "tools": [],
        "expected_actions": [],
        "expected_answer": staff_answer,
        "facts": facts,
        "tags": tags,
        "quality": label,
        "created_at": ticket.closed_at or ticket.created_at or config.reference_date,
        "dataset_version": config.dataset_version,
        # W18 provenance extras (preserved by W16's validator as unknown fields).
        "ticket_id": ticket.ticket_id,
        "quality_reasons": list(reasons),
        "evidence_requests": ctx.evidence_requests,
        "staff_decisions": ctx.staff_decisions,
        "stale_claims": [
            {"claim": mc.claim, "stale_risk": mc.stale_risk, "reason": mc.reason}
            for mc in ctx.marked_claims
        ],
        "governance_ref": config.governance_ref,
    }
    return validate_candidate(rec)


def run_pipeline(tickets: list[dict], config: PipelineConfig) -> CorpusResult:
    """Run all 12 stages over raw ticket dicts."""
    redactor = Redactor(config.redaction)
    candidates: list[dict] = []
    rejected: list[dict] = []
    label_counts: dict[str, int] = {}
    evidence_totals: dict[str, int] = {}
    decision_totals: dict[str, int] = {}

    # Deterministic order regardless of input ordering.
    raws = sorted(tickets, key=lambda r: str(r.get("ticket_id", "")))

    for raw in raws:
        tid = str(raw.get("ticket_id", "?"))
        try:
            ticket = parse_ticket(raw)
        except ValueError as exc:
            rejected.append({"ticket_id": tid, "reason": "parse_error", "detail": str(exc)})
            continue

        # Stage: source exclusions BEFORE redaction (governance section 5).
        excluded, reason = ticket.is_excluded_source()
        if excluded:
            rejected.append({"ticket_id": tid, "reason": "source_excluded", "detail": reason})
            continue

        severe_pii = severe_pii_exclusion_reason(ticket)
        if severe_pii:
            rejected.append({
                "ticket_id": tid,
                "reason": "source_excluded",
                "detail": f"severe_pii:{severe_pii}",
            })
            continue

        # Stages 3: secrets -> 2/privacy: redaction.
        ticket, secret_report = remove_secrets(ticket)
        if not secret_report["clean"]:
            rejected.append(
                {
                    "ticket_id": tid,
                    "reason": "secret_residual",
                    "detail": f"patterns={secret_report['patterns']}",
                }
            )
            continue
        ticket, _redact_report = redactor.redact_ticket(ticket)

        # Stages 5-8: problem, evidence, decisions.
        problem = problem_statement(ticket)
        category = classify_category(problem)
        evidence = extract_evidence_requests(ticket.messages)
        decisions = extract_staff_decisions(ticket.messages)

        # Stage 10: stale-fact marking on staff answer claims.
        staff_text = "\n".join(m.content for m in ticket.staff_messages())
        marked = markOutdated(
            _extract_claims(staff_text),
            ticket_date=ticket.closed_at or ticket.created_at,
            live_facts=config.live_facts,
            reference_date=config.reference_date,
            max_age_days=config.max_age_days,
        )

        ctx = TicketContext(
            ticket=ticket,
            category=category,
            problem=problem,
            marked_claims=marked,
            secret_report=secret_report,
            evidence_requests=evidence,
            staff_decisions=decisions,
        )
        qlabel = label_quality(ctx)
        label_counts[qlabel.label] = label_counts.get(qlabel.label, 0) + 1
        for e in evidence:
            evidence_totals[e["evidence_type"]] = evidence_totals.get(e["evidence_type"], 0) + 1
        for d in decisions:
            decision_totals[d["decision"]] = decision_totals.get(d["decision"], 0) + 1

        # Stage 12: review/filter — PRIVATE_EXCLUDE never becomes a candidate.
        if qlabel.label == "PRIVATE_EXCLUDE":
            rejected.append(
                {
                    "ticket_id": tid,
                    "reason": "private_exclude",
                    "detail": ",".join(qlabel.reasons),
                }
            )
            continue

        candidates.append(
            _build_candidate(ticket, ctx, qlabel.label, qlabel.reasons, config)
        )

    stats = {
        "tickets_in": len(raws),
        "candidates": len(candidates),
        "rejected": len(rejected),
        "labels": label_counts,
        "evidence_types": evidence_totals,
        "decisions": decision_totals,
    }
    return CorpusResult(candidates=candidates, rejected=rejected, stats=stats)


def load_fixtures(path: str) -> list[dict]:
    """Load fixture tickets from a JSONL file (ignores # comment lines)."""
    tickets = []
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                tickets.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
    return tickets


__all__ = ["PipelineConfig", "CorpusResult", "run_pipeline", "load_fixtures"]
