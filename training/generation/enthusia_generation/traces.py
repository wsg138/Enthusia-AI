"""Tool-use trace generation (TRAINING-AND-EVALUATION-SPEC section 6).

Trains tool selection explicitly. Every trace follows the spec skeleton:

    User asks a question.
    Agent resolves identity / reads live state / searches docs via tools.
    Agent compares expected versus actual.
    Agent answers or escalates.

Message shape: user -> assistant (ack) -> tool result(s) -> assistant (final).
``expected_actions`` carries ordered ``tool:<name>`` entries so W16's quality
check can verify the trace isn't broken.
"""

from __future__ import annotations

from .records import iter_records


def generate_traces(registry, record_id_prefix="w17", start=1, seed=17017,
                    created_at="2026-10-03T16:00:00Z", scenarios=None) -> list[dict]:
    return iter_records(
        registry, record_id_prefix, start, seed, created_at,
        kinds=("trace",), scenarios=scenarios,
    )


def check_traces(records: list[dict]) -> list[str]:
    """Trace-specific structural checks. Returns a list of problem strings."""
    problems = []
    for rec in records:
        roles = [m["role"] for m in rec["messages"]]
        if "tool" not in roles:
            problems.append(f"{rec['id']}: trace record has no tool messages")
        if not rec.get("tools"):
            problems.append(f"{rec['id']}: trace record has empty tools list")
        for action in rec.get("expected_actions", []):
            if isinstance(action, str) and action.startswith("tool:"):
                name = action.split(":", 1)[1].strip()
                if name and name not in rec.get("tools", []):
                    problems.append(
                        f"{rec['id']}: expected_action references undeclared tool {name!r}"
                    )
        # final assistant message must differ from the ack (no echo traces)
        assistants = [m["content"] for m in rec["messages"] if m["role"] == "assistant"]
        if len(assistants) >= 2 and assistants[0] == assistants[-1]:
            problems.append(f"{rec['id']}: trace ack and final answer are identical")
    return problems
