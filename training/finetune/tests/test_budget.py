"""Tests for the $25 GPU budget cap: estimation, hard-cap refusal,
ledger accumulation, and the owner-override escape hatch."""

from __future__ import annotations

import pytest

from enthusia_finetune import budget
from enthusia_finetune.budget import (
    BUDGET_CAP_USD,
    BudgetCapExceeded,
    BudgetConfigError,
    check_budget,
    estimate_cost,
    record_spend,
)


def _cfg(price, hours, storage=0.0, **extra):
    cfg = {
        "price_per_hour_usd": price,
        "estimated_hours": hours,
        "storage_usd": storage,
    }
    cfg.update(extra)
    return cfg


def test_cap_is_25():
    assert BUDGET_CAP_USD == 25.00


def test_estimate_math():
    est = estimate_cost(_cfg(0.90, 24, 2.00))
    assert est.total_usd == pytest.approx(23.60)


def test_estimate_rejects_non_numeric():
    with pytest.raises(BudgetConfigError):
        estimate_cost({"price_per_hour_usd": "cheap", "estimated_hours": 1})


def test_estimate_rejects_negative():
    with pytest.raises(BudgetConfigError):
        estimate_cost(_cfg(-1.0, 1))


def test_zero_price_config_is_free():
    est = estimate_cost(_cfg(0.0, 0.0, 0.0))
    assert est.total_usd == 0.0


def test_within_budget_allowed(tmp_path):
    check = check_budget(_cfg(0.90, 24, 2.00), str(tmp_path / "ledger.json"))
    assert check.allowed and not check.owner_override


def test_over_budget_refused(tmp_path):
    with pytest.raises(BudgetCapExceeded, match="REFUSED"):
        check_budget(_cfg(2.00, 20, 0.0), str(tmp_path / "ledger.json"))


def test_spend_accumulates_across_runs(tmp_path):
    ledger = str(tmp_path / "ledger.json")
    check_budget(_cfg(0.90, 10, 0.0), ledger)          # $9.00 projected, ok
    record_spend(ledger, run_name="smoke", spent_usd_amount=9.00)
    # A second $20 run would push the total to $29 > $25: refused.
    with pytest.raises(BudgetCapExceeded):
        check_budget(_cfg(2.00, 10, 0.0), ledger)
    # A $15 run still fits: $9 + $15 = $24.
    check = check_budget(_cfg(1.50, 10, 0.0), ledger)
    assert check.allowed


def test_owner_override_allows_with_reason(tmp_path):
    cfg = _cfg(
        2.00,
        20,
        owner_approved_override=True,
        owner_approval_reason="Owner approved $40 for the full run in chat on 2026-10-03.",
    )
    check = check_budget(cfg, str(tmp_path / "ledger.json"))
    assert check.allowed and check.owner_override
    assert "OWNER OVERRIDE" in check.reason


def test_owner_override_requires_reason(tmp_path):
    with pytest.raises(BudgetConfigError, match="reason"):
        check_budget(_cfg(2.00, 20, owner_approved_override=True),
                     str(tmp_path / "ledger.json"))


def test_ledger_round_trip(tmp_path):
    ledger = str(tmp_path / "ledger.json")
    record_spend(ledger, run_name="r1", spent_usd_amount=5.25, note="test")
    data = budget.read_ledger(ledger)
    assert budget.spent_usd(data) == pytest.approx(5.25)
    assert data["entries"][0]["run_name"] == "r1"


def test_missing_ledger_counts_as_zero(tmp_path):
    data = budget.read_ledger(str(tmp_path / "does-not-exist.json"))
    assert budget.spent_usd(data) == 0.0


def test_estimate_rejects_non_finite_values():
    with pytest.raises(BudgetConfigError, match="finite"):
        estimate_cost(_cfg(float("nan"), 1))
    with pytest.raises(BudgetConfigError, match="finite"):
        estimate_cost(_cfg(1, float("inf")))


def test_negative_spend_cannot_reduce_ledger_total(tmp_path):
    ledger = str(tmp_path / "ledger.json")
    with pytest.raises(BudgetConfigError, match="non-negative"):
        record_spend(ledger, run_name="refund-shaped-bypass", spent_usd_amount=-10)


def test_malformed_ledger_entry_fails_closed(tmp_path):
    ledger = tmp_path / "ledger.json"
    ledger.write_text(
        '{"entries":[{"run_name":"bad","spent_usd":"not-a-number"}]}',
        encoding="utf-8",
    )
    with pytest.raises(BudgetConfigError, match="non-numeric"):
        check_budget(_cfg(1, 1), str(ledger))


def test_non_finite_ledger_entry_fails_closed(tmp_path):
    ledger = tmp_path / "ledger.json"
    ledger.write_text(
        '{"entries":[{"run_name":"bad","spent_usd":"NaN"}]}',
        encoding="utf-8",
    )
    with pytest.raises(BudgetConfigError, match="finite"):
        check_budget(_cfg(1, 1), str(ledger))


def test_invalid_budget_cap_rejected(tmp_path):
    with pytest.raises(BudgetConfigError, match="cap"):
        check_budget(_cfg(1, 1), str(tmp_path / "ledger.json"), cap_usd=0)
