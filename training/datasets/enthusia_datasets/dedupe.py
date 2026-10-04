"""Deduplication per TRAINING-AND-EVALUATION-SPEC section 8.

Near-duplicate scenarios must not cross train/test splits. Dedupe keys:

- normalized text (exact canonical hash);
- semantic similarity (placeholder scorer: deterministic char-trigram
  Jaccard; swap in an embedding scorer later via the SimilarityScorer
  protocol without changing the pipeline);
- shared source (same source_type + thread_id);
- same synthetic template (same template_id + high similarity).

Records are processed in sorted id order so "first wins" is deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .normalize import canonical_hash, canonical_text, sha256_text


class SimilarityScorer(Protocol):
    """Pluggable semantic-similarity scorer.

    The default implementation is a deterministic char-trigram Jaccard
    placeholder. A future embedding-based scorer implements the same
    interface: score(a, b) in [0.0, 1.0].
    """

    def score(self, a: str, b: str) -> float: ...


class TrigramSimilarity:
    """Deterministic character-trigram Jaccard similarity (placeholder).

    Fast, dependency-free, and stable across runs. Not a true semantic
    measure: it is the stand-in until an embedding scorer is wired in.
    """

    def __init__(self, threshold: float = 0.85):
        if not 0.0 < threshold <= 1.0:
            raise ValueError("threshold must be in (0, 1]")
        self.threshold = threshold

    @staticmethod
    def _trigrams(text: str) -> set[str]:
        padded = f"  {text}  "
        return {padded[i : i + 3] for i in range(len(padded) - 2)}

    def score(self, a: str, b: str) -> float:
        ta, tb = self._trigrams(a), self._trigrams(b)
        if not ta and not tb:
            return 1.0
        if not ta or not tb:
            return 0.0
        return len(ta & tb) / len(ta | tb)

    def is_duplicate(self, a: str, b: str) -> bool:
        return self.score(a, b) >= self.threshold


@dataclass(frozen=True)
class DuplicateInfo:
    id: str
    duplicate_of: str
    reason: str  # exact_text | shared_source | near_duplicate


def leak_group_key(rec: dict) -> str:
    """Scenario-group key used to keep near-duplicates in one split.

    Priority: explicit template_id, then thread_id, then a hash of the
    scenario text. Records sharing a key are assigned to the same partition
    so near-duplicate scenarios never leak across train/test.
    """
    if rec.get("template_id"):
        return f"template:{rec['template_id']}"
    if rec.get("thread_id"):
        return f"thread:{rec['source_type']}:{rec['thread_id']}"
    scenario_hash = sha256_text(canonical_text({"scenario": rec.get("scenario", "")}))
    return f"scenario:{scenario_hash[:16]}"


def dedupe_records(
    records: list[dict],
    scorer: SimilarityScorer | None = None,
) -> tuple[list[dict], list[DuplicateInfo]]:
    """Deduplicate records. Returns (kept, duplicates) in deterministic order.

    Checks, in order:
    1. exact normalized-text hash match -> reason 'exact_text'
    2. same (source_type, thread_id) -> reason 'shared_source'
    3. same template_id with trigram similarity >= threshold -> 'near_duplicate'
    """
    scorer = scorer or TrigramSimilarity()
    ordered = sorted(records, key=lambda r: r["id"])

    kept: list[dict] = []
    duplicates: list[DuplicateInfo] = []
    seen_hashes: dict[str, str] = {}          # canonical hash -> id
    seen_threads: dict[tuple, str] = {}       # (source_type, thread_id) -> id
    template_texts: dict[str, list[tuple[str, str]]] = {}  # template_id -> [(id, text)]

    for rec in ordered:
        rid = rec["id"]
        text = canonical_text(rec)
        h = canonical_hash(rec)

        # 1. exact normalized text
        if h in seen_hashes:
            duplicates.append(DuplicateInfo(rid, seen_hashes[h], "exact_text"))
            continue

        # 2. shared source (ticket/thread)
        thread_id = rec.get("thread_id")
        if thread_id:
            tkey = (rec.get("source_type"), thread_id)
            if tkey in seen_threads:
                duplicates.append(DuplicateInfo(rid, seen_threads[tkey], "shared_source"))
                continue

        # 3. same synthetic template + high similarity
        template_id = rec.get("template_id")
        if template_id:
            dup_of = None
            for other_id, other_text in template_texts.get(template_id, []):
                if scorer.score(text, other_text) >= getattr(scorer, "threshold", 0.85):
                    dup_of = other_id
                    break
            if dup_of is not None:
                duplicates.append(DuplicateInfo(rid, dup_of, "near_duplicate"))
                continue
            template_texts.setdefault(template_id, []).append((rid, text))

        seen_hashes[h] = rid
        if thread_id:
            seen_threads[(rec.get("source_type"), thread_id)] = rid
        kept.append(rec)

    return kept, duplicates
