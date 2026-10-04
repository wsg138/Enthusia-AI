"""Fixture source registry.

Loads fixtures/sources.json and resolves (source_id, claim_index) references
into W16 ``facts`` entries: {"claim": ..., "source": ..., "source_version": ...}.

The registry is the single authority for traceable synthetic facts. A claim
is traceable iff its exact text appears in the named source at the recorded
version — see validate.check_fact_traceability.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

FIXTURES_PATH = os.path.join(os.path.dirname(__file__), "..", "fixtures", "sources.json")


@dataclass(frozen=True)
class Source:
    id: str
    title: str
    version: str
    claims: tuple[str, ...]
    superseded_by: str | None = None


class FixtureRegistry:
    def __init__(self, sources: list[Source]):
        self._sources: dict[str, Source] = {s.id: s for s in sources}
        if len(self._sources) != len(sources):
            raise ValueError("duplicate fixture source id")

    @classmethod
    def load(cls, path: str = FIXTURES_PATH) -> "FixtureRegistry":
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        sources = [
            Source(
                id=s["id"],
                title=s.get("title", s["id"]),
                version=s["version"],
                claims=tuple(s["claims"]),
                superseded_by=s.get("superseded_by"),
            )
            for s in raw["sources"]
        ]
        return cls(sources)

    def get(self, source_id: str) -> Source:
        try:
            return self._sources[source_id]
        except KeyError:
            raise KeyError(f"unknown fixture source: {source_id!r}") from None

    def claim(self, source_id: str, index: int) -> str:
        src = self.get(source_id)
        try:
            return src.claims[index]
        except IndexError:
            raise IndexError(
                f"source {source_id!r} has {len(src.claims)} claims; index {index} out of range"
            ) from None

    def fact(self, source_id: str, index: int) -> dict:
        """Build a W16 facts entry for (source_id, claim_index)."""
        src = self.get(source_id)
        return {
            "claim": self.claim(source_id, index),
            "source": source_id,
            "source_version": src.version,
        }

    def facts(self, refs: list[tuple[str, int]]) -> list[dict]:
        return [self.fact(sid, idx) for sid, idx in refs]

    def source_ids(self) -> list[str]:
        return sorted(self._sources)

    def versions(self) -> dict[str, str]:
        return {sid: src.version for sid, src in sorted(self._sources.items())}

    def is_traceable(self, claim: str, source_id: str, source_version: str) -> bool:
        """True iff the exact claim text exists in the named source version."""
        src = self._sources.get(source_id)
        if src is None or src.version != source_version:
            return False
        return claim in src.claims
