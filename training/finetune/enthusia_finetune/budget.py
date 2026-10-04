"""GPU budget tracking and hard-cap enforcement.

TRAINING-AND-EVALUATION-SPEC section 14: initial hard cap **USD $25 total**.
Do not exceed without owner approval.

The pipeline must track estimated GPU cost and REFUSE to start a run that
would exceed the budget. That refusal is implemented here and exercised by
`enthusia_finetune.pipeline` before any training step is even considered.

Rules:
- Every run config must declare a cost estimate (hours x price/hour +
  storage). `estimate_cost(config)` computes it.
- `check_budget(config, ledger_path)` raises `BudgetCapExceeded` when
  estimate + already-spent would pass the cap.
- A `budget-ledger.json` file records approved/spent amounts so a second
  run cannot silently push the total over $25.
- The ONLY escape hatch is an explicit owner override recorded in the
  config (`owner_approved_override: true` with a written reason). W19's
  pipeline never sets this itself; the owner does, by editing the config.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass

# TRAINING-AND-EVALUATION-SPEC section 14: initial hard cap, USD.
BUDGET_CAP_USD = 25.00


class BudgetCapExceeded(RuntimeError):
    """Raised when a run would exceed the $25 GPU budget cap."""


class BudgetConfigError(ValueError):
    """Raised when a config's budget section is missing or malformed."""


@dataclass(frozen=True)
class BudgetEstimate:
    price_per_hour_usd: float
    estimated_hours: float
    storage_usd: float
    total_usd: float

    def as_dict(self) -> dict:
        return {
            "price_per_hour_usd": self.price_per_hour_usd,
            "estimated_hours": self.estimated_hours,
            "storage_usd": self.storage_usd,
            "total_usd": round(self.total_usd, 2),
            "cap_usd": BUDGET_CAP_USD,
            "remaining_after_usd": round(BUDGET_CAP_USD - self.total_usd, 2),
        }


def estimate_cost(budget_cfg: dict) -> BudgetEstimate:
    """Compute a run's estimated cost from its budget config block.

    Expected keys: price_per_hour_usd, estimated_hours, storage_usd
    (storage defaults to 0.0).
    """
    if not isinstance(budget_cfg, dict):
        raise BudgetConfigError("config 'budget' section must be a mapping")
    try:
        price = float(budget_cfg.get("price_per_hour_usd", 0.0))
        hours = float(budget_cfg.get("estimated_hours", 0.0))
        storage = float(budget_cfg.get("storage_usd", 0.0))
    except (TypeError, ValueError) as exc:
        raise BudgetConfigError(f"budget figures must be numeric: {exc}") from exc
    if not all(math.isfinite(value) for value in (price, hours, storage)):
        raise BudgetConfigError("budget figures must be finite")
    if price < 0 or hours < 0 or storage < 0:
        raise BudgetConfigError("budget figures must be non-negative")
    if hours == 0 and (price > 0 or storage > 0):
        raise BudgetConfigError(
            "estimated_hours is 0 but a price or storage cost is set; "
            "declare real hours for any paid run"
        )
    return BudgetEstimate(
        price_per_hour_usd=price,
        estimated_hours=hours,
        storage_usd=storage,
        total_usd=round(price * hours + storage, 2),
    )


def read_ledger(ledger_path: str) -> dict:
    """Read the spend ledger; returns {'entries': [...]} (empty if missing)."""
    if not os.path.isfile(ledger_path):
        return {"entries": []}
    try:
        with open(ledger_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        raise BudgetConfigError(f"ledger {ledger_path!r} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise BudgetConfigError(f"ledger {ledger_path!r} must be {{'entries': [...]}}")
    return data


def spent_usd(ledger: dict) -> float:
    """Total recorded spend, failing closed on malformed ledger entries."""
    total = 0.0
    for index, entry in enumerate(ledger["entries"]):
        if not isinstance(entry, dict) or "spent_usd" not in entry:
            raise BudgetConfigError(f"ledger entry {index} is missing a valid spent_usd")
        try:
            amount = float(entry["spent_usd"])
        except (TypeError, ValueError) as exc:
            raise BudgetConfigError(
                f"ledger entry {index} has non-numeric spent_usd"
            ) from exc
        if not math.isfinite(amount) or amount < 0:
            raise BudgetConfigError(
                f"ledger entry {index} spent_usd must be finite and non-negative"
            )
        total += amount
    return round(total, 2)


def record_spend(
    ledger_path: str,
    *,
    run_name: str,
    spent_usd_amount: float,
    note: str = "",
) -> dict:
    """Append a spend entry to the ledger. Returns the updated ledger."""
    ledger = read_ledger(ledger_path)
    if not isinstance(run_name, str) or not run_name.strip():
        raise BudgetConfigError("run_name must be a non-empty string")
    try:
        amount = float(spent_usd_amount)
    except (TypeError, ValueError) as exc:
        raise BudgetConfigError("spent_usd_amount must be numeric") from exc
    if not math.isfinite(amount) or amount < 0:
        raise BudgetConfigError("spent_usd_amount must be finite and non-negative")
    entry = {
        "run_name": run_name.strip(),
        "spent_usd": round(amount, 2),
        "note": note,
    }
    ledger["entries"].append(entry)
    os.makedirs(os.path.dirname(os.path.abspath(ledger_path)), exist_ok=True)
    with open(ledger_path, "w", encoding="utf-8") as fh:
        json.dump(ledger, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return ledger


@dataclass(frozen=True)
class BudgetCheck:
    estimate: BudgetEstimate
    spent_before_usd: float
    total_projected_usd: float
    allowed: bool
    owner_override: bool
    reason: str


def check_budget(
    budget_cfg: dict,
    ledger_path: str,
    *,
    cap_usd: float = BUDGET_CAP_USD,
) -> BudgetCheck:
    """Check a run's estimate against the hard cap.

    Returns a BudgetCheck (allowed=True) or raises BudgetCapExceeded.
    An explicit owner override (`owner_approved_override: true` plus a
    non-empty `owner_approval_reason`) permits exceeding the cap and is
    recorded in the returned check — the pipeline logs it loudly.
    """
    if not math.isfinite(cap_usd) or cap_usd <= 0:
        raise BudgetConfigError("budget cap must be finite and positive")
    estimate = estimate_cost(budget_cfg)
    spent = spent_usd(read_ledger(ledger_path))
    projected = round(estimate.total_usd + spent, 2)

    override = bool(budget_cfg.get("owner_approved_override", False))
    if override:
        reason = str(budget_cfg.get("owner_approval_reason", "") or "").strip()
        if not reason:
            raise BudgetConfigError(
                "owner_approved_override is true but 'owner_approval_reason' is empty; "
                "overrides require a written reason"
            )
        return BudgetCheck(
            estimate=estimate,
            spent_before_usd=spent,
            total_projected_usd=projected,
            allowed=True,
            owner_override=True,
            reason=f"OWNER OVERRIDE: {reason} (projected total ${projected:.2f} vs cap ${cap_usd:.2f})",
        )

    if projected > cap_usd:
        raise BudgetCapExceeded(
            f"run REFUSED: estimated ${estimate.total_usd:.2f} + already spent "
            f"${spent:.2f} = ${projected:.2f} exceeds the ${cap_usd:.2f} GPU budget cap "
            f"(TRAINING-AND-EVALUATION-SPEC section 14). Reduce hours/price or obtain "
            f"explicit owner approval (owner_approved_override + reason)."
        )
    return BudgetCheck(
        estimate=estimate,
        spent_before_usd=spent,
        total_projected_usd=projected,
        allowed=True,
        owner_override=False,
        reason=(
            f"within budget: estimated ${estimate.total_usd:.2f} + spent ${spent:.2f} "
            f"= ${projected:.2f} of ${cap_usd:.2f} cap"
        ),
    )
