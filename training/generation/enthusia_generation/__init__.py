"""W17 — Synthetic corpus generation for Enthusia AI.

Generates large, high-quality synthetic training material from the fixture
knowledge base (fixtures/sources.json). NO real Enthusia production data is
used; every factual example cites traceable fixture sources via the W16
record ``facts`` field (claim/source/source_version).

Modules:
    fixtures     - fixture source registry (load/lookup/claim resolution)
    scenarios    - scenario template library across the 14 spec categories
    variations   - linguistic variation forms (spec section 5)
    qa           - source-grounded Q&A generation
    traces       - tool-use trace generation (spec section 6 skeleton)
    adversarial  - adversarial example generation (spec section 42.2)
    validate     - quality validation against W16 schema + fact traceability
    corpus       - deterministic corpus builder + manifest (CLI: generate-corpus)
"""

from __future__ import annotations

__version__ = "0.1.0"
__all__ = [
    "fixtures",
    "scenarios",
    "variations",
    "records",
    "qa",
    "traces",
    "adversarial",
    "validate",
    "corpus",
]
