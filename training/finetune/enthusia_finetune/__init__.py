"""W19 fine-tune/export pipeline.

Submodules are loaded lazily so the standalone GPU trainer can run with only
its own runtime dependencies. In particular, importing
enthusia_finetune.trainer must not eagerly import dataset assembly (and
therefore the sibling W16 enthusia_datasets package).
"""

from __future__ import annotations

import importlib

__all__ = ["assembly", "budget", "config", "eval_hooks", "export", "pipeline", "record", "trainer"]

__version__ = "0.1.0"


def __getattr__(name: str):
    if name in __all__:
        module = importlib.import_module(f"{__name__}.{name}")
        globals()[name] = module
        return module
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
