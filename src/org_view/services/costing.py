"""The single definition of what a position *costs*.

There used to be two: ``tree_builder`` rolled up ``annual_salary`` only (while
fetching ``fully_loaded_cost`` and never using it), and ``scenarios._cost``
preferred loaded cost. A chart card's cost and a scenario impact panel's cost
were therefore computed from different columns and could not reconcile — which
the editor makes visible by putting both on screen at once.

Everything that adds up money now goes through :func:`cost_of`.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation


def cost_of(row) -> Decimal:
    """Loaded cost if present, else annual salary, else 0 — from a dict or model.

    Accepts either a ``.values()`` dict (tree_builder / scenario rows) or a model
    instance (``Employee`` / ``ScenarioPosition``).
    """
    if isinstance(row, dict):
        val = row.get("fully_loaded_cost") or row.get("annual_salary")
    else:
        val = getattr(row, "fully_loaded_cost", None) or getattr(row, "annual_salary", None)
    return to_decimal(val) or Decimal("0")


def to_decimal(val) -> Decimal | None:
    """Coerce to Decimal, or None when the value is missing/unparseable."""
    if val is None or val == "":
        return None
    if isinstance(val, Decimal):
        return val
    try:
        return Decimal(str(val))
    except (InvalidOperation, ValueError, TypeError):
        return None
