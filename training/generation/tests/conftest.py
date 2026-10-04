"""pytest conftest for enthusia_generation.

Makes the package under test importable and, when available, puts W16's
``enthusia_datasets`` package on sys.path. W16's PR (#3) also targets
w01/contracts-scaffold, so on some bases the datasets package is absent:
tests that need it use ``pytest.importorskip("enthusia_datasets")`` and skip
cleanly instead of failing.
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_GENERATION_DIR = os.path.dirname(_HERE)          # training/generation
_REPO_ROOT = os.path.dirname(os.path.dirname(_GENERATION_DIR))  # repo root guess

for candidate in (
    _GENERATION_DIR,
    os.path.join(_REPO_ROOT, "training", "datasets"),
    # Local dev fallback: the W16 workdir checkout used to build this branch.
    os.path.expanduser("~/workspace/enthusia-ai/w16-work/training/datasets"),
):
    if os.path.isdir(candidate) and candidate not in sys.path:
        sys.path.insert(0, candidate)
