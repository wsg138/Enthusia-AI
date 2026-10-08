"""Synthetic-only ticket-method invariants.

This module validates candidate *structure* and grouping; it cannot prove that a
source citation supports a claim or that a response is natural. The tests use
invented fixtures and never read private tickets. Do not silently mark any
candidate GOOD/IDEAL or training-eligible on these checks.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
import re

REQUIRED = (
    "candidate_id", "lane", "seed_refs", "source_refs", "scenario_facts",
    "conversation", "investigation", "staff_handoff", "quality",
    "mutations_performed",
)
EVIDENCE_TYPES = {"source_backed", "synthetic_fixture", "unavailable"}
VISIBILITIES = {"staff_only", "player_safe"}
ROLES = {"user", "assistant"}


def validate_candidate(record: dict, *, require_multi_turn: bool = False) -> list[str]:
    """Fail-closed structural audit. Does not assign a positive quality label."""
    if not isinstance(record, dict):
        return ["not_object"]
    errors = set()
    errors.update("missing_" + key for key in REQUIRED if key not in record)
    rid = record.get("candidate_id")
    if not isinstance(rid, str) or re.fullmatch(r"W[0-9]{2}-[0-9]{4}", rid) is None:
        errors.add("invalid_candidate_id")
    if not isinstance(record.get("lane"), str) or not record["lane"].strip():
        errors.add("missing_lane")
    if record.get("mutations_performed") is not False:
        errors.add("mutation_not_explicitly_false")
    for key in ("seed_refs", "source_refs"):
        refs = record.get(key)
        if not isinstance(refs, list) or not refs:
            errors.add("invalid_" + key)
        elif any(not isinstance(ref, (str, dict)) or not ref for ref in refs):
            errors.add("invalid_" + key + "_entry")

    facts = record.get("scenario_facts")
    if not isinstance(facts, dict) or facts.get("fixture_only") is not True:
        errors.add("fixture_provenance_missing")
    elif not isinstance(facts.get("facts"), list):
        errors.add("fixture_facts_invalid")

    conversation = record.get("conversation")
    if not isinstance(conversation, list) or not conversation:
        errors.add("missing_conversation")
    else:
        speaker_counts = defaultdict(int)
        stamps = []
        for i, message in enumerate(conversation):
            if not isinstance(message, dict):
                errors.add("invalid_message")
                continue
            role = message.get("role")
            if role not in ROLES:
                errors.add("invalid_player_visible_role")
            else:
                speaker_counts[role] += 1
            if not isinstance(message.get("content"), str):
                errors.add("invalid_message_content")
            if "timestamp" in message:
                try:
                    raw = message["timestamp"]
                    if not isinstance(raw, str):
                        raise ValueError("not a timestamp")
                    value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    if value.utcoffset() is None:
                        raise ValueError("timezone required")
                    stamps.append(value.timestamp())
                except (ValueError, TypeError):
                    errors.add("invalid_timestamp")
        if speaker_counts["user"] < 1 or speaker_counts["assistant"] < 1:
            errors.add("missing_player_or_ai")
        if require_multi_turn and (speaker_counts["user"] < 2 or speaker_counts["assistant"] < 2):
            errors.add("not_full_multi_turn")
        if stamps and len(stamps) != len(conversation):
            errors.add("partial_timestamps")
        elif len(stamps) == len(conversation) and stamps != sorted(stamps):
            errors.add("nonchronological_ticket")

    investigation = record.get("investigation")
    if not isinstance(investigation, list):
        errors.add("invalid_investigation")
    else:
        for step in investigation:
            if not isinstance(step, dict):
                errors.add("invalid_investigation_step")
                continue
            if not isinstance(step.get("intent"), str) or not step["intent"].strip():
                errors.add("missing_investigation_intent")
            if not isinstance(step.get("result_summary"), str):
                errors.add("missing_result_summary")
            if step.get("visibility") not in VISIBILITIES:
                errors.add("invalid_investigation_visibility")
            if step.get("evidence_kind") not in EVIDENCE_TYPES:
                errors.add("invalid_evidence_kind")
            # A newly-authored trace may anchor a tool action to a visible
            # message. Do not accept references to messages that have not yet
            # occurred. Legacy traces without anchors are NOT certified causal.
            if "after_turn_index" in step:
                anchor = step["after_turn_index"]
                if (isinstance(anchor, bool) or not isinstance(anchor, int)
                    or not isinstance(conversation, list)
                    or anchor < 0 or anchor >= len(conversation)):
                    errors.add("invalid_tool_anchor")
                else:
                    for key in ("source_turn_index",):
                        if key in step:
                            src = step[key]
                            if (isinstance(src, bool) or not isinstance(src, int)
                                or src < 0 or src > anchor):
                                errors.add("future_tool_context")
            elif "source_turn_index" in step:
                errors.add("unanchored_tool_context")

    handoff = record.get("staff_handoff")
    if not isinstance(handoff, dict) or type(handoff.get("needed")) is not bool:
        errors.add("invalid_staff_handoff")
    else:
        if handoff.get("needed") and handoff.get("visibility") != "staff_only":
            errors.add("staff_handoff_not_private")
        for key in ("evidence_summary", "recommendation"):
            if not isinstance(handoff.get(key), str):
                errors.add("invalid_staff_" + key)

    quality = record.get("quality")
    if not isinstance(quality, dict):
        errors.add("invalid_self_review")
    # Self-report NEVER implies independent acceptance.
    return sorted(errors)


def _group_tokens(record: dict) -> set[tuple[str, str]]:
    """Group incident/lineage refs, never generic public source URLs or phrases."""
    tokens: set[tuple[str, str]] = set()
    for key in ("family_group", "session_group", "canonical_event_id", "incident_id"):
        val = record.get(key)
        if isinstance(val, str) and val:
            tokens.add((key, val))
    for field, kind in (
        ("seed_refs", "seed"), ("source_ticket_ids", "ticket"),
        ("source_message_ids", "source_message"),
    ):
        vals = record.get(field, [])
        if isinstance(vals, list):
            for val in vals:
                if isinstance(val, str) and val:
                    tokens.add((kind, val))
    for val in record.get("parent_ids", []):
        if isinstance(val, str) and val:
            tokens.add(("parent", val))
    return tokens


def leak_components(records: list[dict]) -> list[list[str]]:
    """Union overlapping ticket/seed/session/family/message/augmentation lineage.

    Shared generic policy docs or phrases must NOT create false leak edges.
    Group variants before assigning train/dev/test. Caller must explicitly
    approve or quarantine any ambiguous group mapping.
    """
    parent = list(range(len(records)))
    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a: int, b: int) -> None:
        a, b = find(a), find(b)
        if a != b:
            parent[max(a, b)] = min(a, b)

    owners: dict[tuple[str, str], int] = {}
    ids = {}
    for i, record in enumerate(records):
        rid = record["candidate_id"]
        if rid in ids:
            union(i, ids[rid])
        ids[rid] = i
        for token in _group_tokens(record):
            if token in owners:
                union(i, owners[token])
            else:
                owners[token] = i
    for i, record in enumerate(records):
        for parent_id in record.get("parent_ids", []):
            if parent_id in ids:
                union(i, ids[parent_id])
    components: dict[int, list[str]] = defaultdict(list)
    for i, record in enumerate(records):
        components[find(i)].append(record["candidate_id"])
    return sorted((sorted(members) for members in components.values()),
                  key=lambda members: members[0])


def find_split_leaks(records: list[dict]) -> list[list[str]]:
    """Return family/component IDs that would contaminate two or more splits."""
    splits = {r["candidate_id"]: r.get("split") for r in records}
    return [c for c in leak_components(records)
            if len({splits.get(rid) for rid in c}) > 1]
