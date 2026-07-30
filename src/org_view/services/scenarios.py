"""Scenario planning engine.

A :class:`~org_view.models.Scenario` is an editable clone of a company's org,
taken from a :class:`~org_view.models.CensusSnapshot`. This module handles:

- cloning a snapshot into ``ScenarioPosition`` rows,
- the four structural edits (reassign manager, edit attributes, add position,
  eliminate position),
- rendering the scenario org tree (reusing the snapshot tree-builder), and
- the comparison summary + change ledger with cost impact
  (eliminations = savings, additions = investment, edits = delta).
"""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from django.db import transaction

from ..models import CensusSnapshot, Employee, Scenario, ScenarioPosition
from .tree_builder import _FIELDS as TREE_FIELDS
from .tree_builder import build_tree_from_rows

# Fields copied verbatim from an Employee into a ScenarioPosition on clone.
_COPY_FIELDS = (
    "employee_id", "first_name", "last_name", "raw_supervisor_id", "job_title",
    "management_level", "department", "site_location", "city", "state",
    "employee_status", "employee_type", "pay_type", "annual_salary",
    "fully_loaded_cost", "is_overhead", "hire_date", "revenue_attribution",
    "cost_center", "entity", "union_affiliation", "flsa_status",
)

# Attribute fields an editor may change on a position (excludes identity/links).
EDITABLE_FIELDS = (
    "first_name", "last_name", "job_title", "management_level", "department",
    "site_location", "city", "state", "employee_status", "employee_type",
    "pay_type", "annual_salary", "fully_loaded_cost", "entity",
)


def _cost(row) -> Decimal:
    """Loaded cost if present, else annual salary, else 0 — from a dict or model."""
    if isinstance(row, dict):
        val = row.get("fully_loaded_cost") or row.get("annual_salary")
    else:
        val = row.fully_loaded_cost or row.annual_salary
    return val if isinstance(val, Decimal) else (Decimal(str(val)) if val else Decimal("0"))


# ---------------------------------------------------------------------------
# Creation
# ---------------------------------------------------------------------------

@transaction.atomic
def create_scenario(*, company, base_snapshot: CensusSnapshot, name: str,
                    description: str = "", user=None) -> Scenario:
    """Create a scenario and clone every employee in *base_snapshot* into it."""
    scenario = Scenario.objects.create(
        company=company,
        base_snapshot=base_snapshot,
        name=name.strip() or "Untitled scenario",
        description=description.strip(),
        created_by=user,
    )
    positions = []
    for emp in Employee.objects.filter(snapshot=base_snapshot).values(*_COPY_FIELDS):
        positions.append(ScenarioPosition(
            scenario=scenario,
            source_employee_id=emp["employee_id"],
            change_type=ScenarioPosition.ChangeType.UNCHANGED,
            baseline_cost=_cost(emp),
            **emp,
        ))
    ScenarioPosition.objects.bulk_create(positions, batch_size=500)
    return scenario


# ---------------------------------------------------------------------------
# Tree rendering (reuses the snapshot tree-builder)
# ---------------------------------------------------------------------------

def active_position_rows(scenario: Scenario) -> list[dict]:
    """Rows for the tree-builder — everything except eliminated positions."""
    return list(
        scenario.positions
        .exclude(change_type=ScenarioPosition.ChangeType.REMOVED)
        .values(*TREE_FIELDS)
    )


def build_scenario_tree(scenario: Scenario, root_employee_id=None, max_depth=None):
    return build_tree_from_rows(
        active_position_rows(scenario),
        root_employee_id=root_employee_id,
        max_depth=max_depth,
    )


# ---------------------------------------------------------------------------
# Structural edits
# ---------------------------------------------------------------------------

def _touch(position: ScenarioPosition, moved_only=False):
    """Bump change_type for an edit, preserving ADDED/REMOVED."""
    ct = ScenarioPosition.ChangeType
    if position.change_type == ct.UNCHANGED:
        position.change_type = ct.MOVED if moved_only else ct.MODIFIED
    elif position.change_type == ct.MOVED and not moved_only:
        position.change_type = ct.MODIFIED


def _descendant_ids(scenario: Scenario, root_id: str) -> set[str]:
    """employee_ids in the subtree under *root_id* (active positions only)."""
    children: dict[str, list[str]] = defaultdict(list)
    for r in active_position_rows(scenario):
        sup = r.get("raw_supervisor_id")
        if sup:
            children[sup].append(r["employee_id"])
    out: set[str] = set()
    stack = list(children.get(root_id, []))
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


def reassign_manager(position: ScenarioPosition, new_supervisor_id: str | None):
    """Point *position* at a new manager (by employee_id within the scenario).

    Raises ValueError if the move would make a position report to itself or
    into its own subtree (a reporting loop).
    """
    new_sup = (new_supervisor_id or "").strip() or None
    if new_sup == position.employee_id:
        raise ValueError("A position cannot report to itself.")
    if new_sup and new_sup in _descendant_ids(position.scenario, position.employee_id):
        raise ValueError("That reassignment would create a reporting loop.")
    position.raw_supervisor_id = new_sup
    _touch(position, moved_only=True)
    position.save()
    return position


def edit_position(position: ScenarioPosition, changes: dict):
    """Apply attribute edits from *changes* (only EDITABLE_FIELDS are honoured)."""
    for field in EDITABLE_FIELDS:
        if field in changes:
            setattr(position, field, changes[field])
    if "is_vacant" in changes:
        position.is_vacant = bool(changes["is_vacant"])
    if "note" in changes:
        position.note = changes["note"]
    _touch(position)
    position.save()
    return position


def next_new_id(scenario: Scenario) -> str:
    """A unique 'NEW-n' employee_id for an added position."""
    existing = set(
        scenario.positions.filter(employee_id__startswith="NEW-")
        .values_list("employee_id", flat=True)
    )
    n = 1
    while f"NEW-{n}" in existing:
        n += 1
    return f"NEW-{n}"


@transaction.atomic
def add_position(scenario: Scenario, *, supervisor_id: str | None = None,
                 is_vacant: bool = True, note: str = "", **fields) -> ScenarioPosition:
    """Create a brand-new (usually vacant / to-be-hired) position."""
    allowed = {k: v for k, v in fields.items() if k in EDITABLE_FIELDS}
    pos = ScenarioPosition.objects.create(
        scenario=scenario,
        employee_id=next_new_id(scenario),
        source_employee_id="",
        change_type=ScenarioPosition.ChangeType.ADDED,
        raw_supervisor_id=(supervisor_id or "").strip() or None,
        is_vacant=is_vacant,
        note=note,
        baseline_cost=Decimal("0"),
        **allowed,
    )
    return pos


@transaction.atomic
def eliminate_position(position: ScenarioPosition):
    """Eliminate a role; reparent its direct reports to its manager."""
    ct = ScenarioPosition.ChangeType
    scenario = position.scenario
    new_parent = position.raw_supervisor_id  # may be None (its reports become roots)

    reports = scenario.positions.exclude(change_type=ct.REMOVED).filter(
        raw_supervisor_id=position.employee_id,
    )
    for child in reports:
        child.raw_supervisor_id = new_parent
        _touch(child, moved_only=True)
        child.save(update_fields=["raw_supervisor_id", "change_type", "updated_at"])

    if position.change_type == ct.ADDED:
        # A position added then removed in the same scenario just disappears.
        position.delete()
        return None

    position.change_type = ct.REMOVED
    position.save(update_fields=["change_type", "updated_at"])
    return position


# ---------------------------------------------------------------------------
# Comparison summary + cost-impact ledger
# ---------------------------------------------------------------------------

def _aggregate(rows: list[dict]) -> dict:
    """Headcount / cost / layers / span / cost-by-department for a row set."""
    rows = list(rows)
    by_id = {r["employee_id"]: r for r in rows}
    children: dict[str, list[str]] = defaultdict(list)
    roots: list[str] = []
    for r in rows:
        sup = r.get("raw_supervisor_id")
        if sup and sup in by_id:
            children[sup].append(r["employee_id"])
        else:
            roots.append(r["employee_id"])

    def depth(eid, seen):
        if eid in seen:
            return 0
        seen.add(eid)
        kids = children.get(eid, [])
        return 1 + max((depth(k, seen) for k in kids), default=0)

    layers = max((depth(r, set()) for r in roots), default=0)
    manager_ids = [eid for eid, kids in children.items() if kids]
    total_reports = sum(len(children[m]) for m in manager_ids)
    avg_span = round(total_reports / len(manager_ids), 1) if manager_ids else None

    cost_by_dept: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    total_cost = Decimal("0")
    for r in rows:
        c = _cost(r)
        total_cost += c
        cost_by_dept[(r.get("department") or "—")] += c

    return {
        "headcount": len(rows),
        "total_cost": total_cost,
        "layers": layers,
        "avg_span": avg_span,
        "manager_count": len(manager_ids),
        "cost_by_department": dict(cost_by_dept),
    }


def scenario_summary(scenario: Scenario) -> dict:
    """Baseline-vs-scenario metrics, deltas, and the cost-impact change ledger."""
    ct = ScenarioPosition.ChangeType

    if scenario.base_snapshot_id:
        base_rows = list(
            Employee.objects.filter(snapshot_id=scenario.base_snapshot_id).values(*TREE_FIELDS)
        )
    else:
        base_rows = []
    base = _aggregate(base_rows)
    scen = _aggregate(active_position_rows(scenario))

    def _num_delta(a, b):
        if a is None or b is None:
            return None
        return round(b - a, 1) if isinstance(a, float) or isinstance(b, float) else b - a

    deltas = {
        "headcount": scen["headcount"] - base["headcount"],
        "total_cost": scen["total_cost"] - base["total_cost"],
        "layers": scen["layers"] - base["layers"],
        "avg_span": _num_delta(base["avg_span"], scen["avg_span"]),
    }

    ledger = []
    investment = Decimal("0")
    savings = Decimal("0")
    for p in scenario.positions.all():
        impact = Decimal("0")
        if p.change_type == ct.ADDED:
            impact = _cost(p)
        elif p.change_type == ct.REMOVED:
            impact = -(p.baseline_cost or Decimal("0"))
        elif p.change_type == ct.MODIFIED:
            impact = _cost(p) - (p.baseline_cost or Decimal("0"))
        elif p.change_type == ct.MOVED:
            impact = Decimal("0")
        else:  # UNCHANGED
            continue

        if impact > 0:
            investment += impact
        elif impact < 0:
            savings += -impact

        ledger.append({
            "employee_id": p.employee_id,
            "name": p.full_name,
            "job_title": p.job_title,
            "department": p.department,
            "change_type": p.change_type,
            "change_label": p.get_change_type_display(),
            "is_vacant": p.is_vacant,
            "cost_impact": impact,
            "note": p.note,
        })

    # Order ledger: eliminations, additions, modifications, moves.
    order = {ct.REMOVED: 0, ct.ADDED: 1, ct.MODIFIED: 2, ct.MOVED: 3}
    ledger.sort(key=lambda x: (order.get(x["change_type"], 9), x["name"]))

    return {
        "baseline": base,
        "scenario": scen,
        "deltas": deltas,
        "ledger": ledger,
        "totals": {
            "investment": investment,
            "savings": savings,
            "net": investment - savings,  # >0 net investment, <0 net savings
        },
    }
