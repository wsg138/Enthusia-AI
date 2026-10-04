"""Quality metadata per TRAINING-AND-EVALUATION-SPEC sections 4 and 10.

Automated filters flag: malformed records (handled at schema validation),
empty answers, excessively long examples, broken tool traces, unsupported
facts, and private content. Curated `quality` labels are preserved; records
without one get an automatic assessment.

Labels: IDEAL | GOOD | USABLE_WITH_EDIT | BAD_RESPONSE | OUTDATED |
        INCOMPLETE | PRIVATE_EXCLUDE
"""

from __future__ import annotations

from dataclasses import dataclass

QUALITY_REASONS = (
    "empty_answer",
    "overlong_example",
    "broken_tool_trace",
    "unsupported_facts",
    "private_content",
    "curated_label",
    "stale_tag",
    "negative_example",
)

MAX_ANSWER_CHARS = 4000
MAX_RECORD_CHARS = 20000


@dataclass(frozen=True)
class QualityAssessment:
    label: str
    reasons: tuple[str, ...]
    checks: dict

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "reasons": list(self.reasons),
            "checks": dict(self.checks),
        }


def _total_chars(rec: dict) -> int:
    total = len(rec.get("scenario", "")) + len(rec.get("expected_answer", ""))
    for m in rec.get("messages", []):
        if isinstance(m, dict):
            total += len(str(m.get("content", "")))
    return total


def _tool_trace_broken(rec: dict) -> bool:
    """A tool trace is broken when a tool-role message has no declared tool,
    or expected_actions reference tools not present in the tools list."""
    tools = set(rec.get("tools", []))
    has_tool_messages = any(
        isinstance(m, dict) and m.get("role") == "tool" for m in rec.get("messages", [])
    )
    if has_tool_messages and not tools:
        return True
    for action in rec.get("expected_actions", []):
        # expected_actions entries may be free text; only check structured refs.
        if isinstance(action, str) and action.startswith("tool:"):
            name = action.split(":", 1)[1].strip()
            if name and name not in tools:
                return True
    return False


def _unsupported_facts(rec: dict) -> bool:
    return any(
        isinstance(f, dict) and not f.get("source", "").strip()
        for f in rec.get("facts", [])
    )


def assess_quality(rec: dict) -> QualityAssessment:
    """Assess a validated record. Curated labels are preserved verbatim."""
    curated = rec.get("quality")
    reasons: list[str] = []
    checks: dict = {}

    empty_answer = not rec.get("expected_answer", "").strip()
    checks["empty_answer"] = empty_answer
    if empty_answer:
        reasons.append("empty_answer")

    overlong = len(rec.get("expected_answer", "")) > MAX_ANSWER_CHARS or _total_chars(
        rec
    ) > MAX_RECORD_CHARS
    checks["overlong_example"] = overlong
    if overlong:
        reasons.append("overlong_example")

    broken = _tool_trace_broken(rec)
    checks["broken_tool_trace"] = broken
    if broken:
        reasons.append("broken_tool_trace")

    unsupported = _unsupported_facts(rec)
    checks["unsupported_facts"] = unsupported
    if unsupported:
        reasons.append("unsupported_facts")

    private = rec.get("visibility") in ("private", "owner")
    checks["private_content"] = private
    if private:
        reasons.append("private_content")

    tags = [t.lower() for t in rec.get("tags", []) if isinstance(t, str)]
    stale = "stale-truth" in tags or "outdated" in tags
    checks["stale_tag"] = stale
    if stale:
        reasons.append("stale_tag")

    negative = "negative-example" in tags or "adversarial" in tags
    checks["negative_example"] = negative
    if negative:
        reasons.append("negative_example")

    if curated is not None:
        return QualityAssessment(
            label=curated, reasons=tuple(["curated_label", *reasons]), checks=checks
        )

    # Automatic label from checks.
    if private:
        label = "PRIVATE_EXCLUDE"
    elif empty_answer or broken:
        label = "INCOMPLETE"
    elif unsupported:
        label = "USABLE_WITH_EDIT"
    elif overlong:
        label = "USABLE_WITH_EDIT"
    elif stale:
        label = "OUTDATED"
    elif negative:
        # Adversarial/negative examples are valuable as-is for eval sets.
        label = "GOOD"
    else:
        label = "GOOD"

    return QualityAssessment(label=label, reasons=tuple(reasons), checks=checks)
