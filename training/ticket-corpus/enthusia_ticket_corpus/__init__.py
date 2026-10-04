"""W18: Historical ticket corpus pipeline (fixtures only).

Implements TRAINING-AND-EVALUATION-SPEC section 4 (stages 1-12) for ticket
transcripts, emitting section-27-conformant training candidates with
source_type "ticket".

GOVERNANCE: real ticket extraction is blocked until
training/datasets/GOVERNANCE-CHECKPOINT.md is signed off. This package only
ever processes synthetic fixture data.
"""

from .extract import Ticket, TicketMessage, classify_category, parse_ticket, problem_statement
from .outdated import MarkedClaim, has_high_risk_claim, markOutdated
from .patterns import (
    DECISION_PATTERNS,
    EVIDENCE_PATTERNS,
    extract_evidence_requests,
    extract_staff_decisions,
)
from .pipeline import CorpusResult, PipelineConfig, load_fixtures, run_pipeline
from .quality import QualityLabel, TicketContext, label_quality
from .redact import RedactionConfig, RedactionRule, Redactor
from .schema import CandidateValidationError, validate_candidate
from .secrets import SecretFinding, pattern_names, remove_secrets, scan_ticket

__all__ = [
    "Ticket",
    "TicketMessage",
    "parse_ticket",
    "problem_statement",
    "classify_category",
    "MarkedClaim",
    "markOutdated",
    "has_high_risk_claim",
    "EVIDENCE_PATTERNS",
    "DECISION_PATTERNS",
    "extract_evidence_requests",
    "extract_staff_decisions",
    "QualityLabel",
    "TicketContext",
    "label_quality",
    "RedactionConfig",
    "RedactionRule",
    "Redactor",
    "CandidateValidationError",
    "validate_candidate",
    "SecretFinding",
    "pattern_names",
    "scan_ticket",
    "remove_secrets",
    "PipelineConfig",
    "CorpusResult",
    "run_pipeline",
    "load_fixtures",
]
