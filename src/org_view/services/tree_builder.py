"""
Org-tree construction and metric calculation engine.

Builds a nested tree from a single DB query, calculates all metrics
bottom-up, and supports subtree extraction for branch-level access.

Performance note: the entire snapshot is loaded once into Python dicts
and the tree is assembled in memory — no recursive DB queries.

# TODO: Add optional caching layer here.  The natural cache key is
# (snapshot_id, root_employee_id).  Store the result of build_tree()
# in CensusSnapshot.metrics_cache (JSONField) or Redis/memcached.
# Invalidate whenever an Employee row in the snapshot is mutated.
"""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from org_view.models import Employee


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_tree(
    snapshot_id: int,
    root_employee_id: str | None = None,
    max_depth: int | None = None,
) -> dict | list[dict]:
    """
    Build a nested org tree for *snapshot_id*.

    Parameters
    ----------
    snapshot_id : int
        PK of the CensusSnapshot.
    root_employee_id : str, optional
        Start the tree from this employee instead of the natural root(s).
        All metrics are scoped to this subtree.
    max_depth : int, optional
        Maximum depth of children to include (None = full tree).

    Returns
    -------
    dict
        A single root node (when root_employee_id is given or there is
        exactly one natural root), **or** a list of root nodes when
        the snapshot has multiple roots and no explicit root is given.
    """
    emp_rows = _fetch_employees(snapshot_id)
    if not emp_rows:
        return []

    emp_dict, children_map, natural_roots = _build_lookups(emp_rows)

    if root_employee_id and root_employee_id in emp_dict:
        roots = [root_employee_id]
    else:
        roots = natural_roots

    nodes = [_build_node(eid, emp_dict, children_map, max_depth, 0) for eid in roots]

    if len(nodes) == 1:
        return nodes[0]
    return nodes


def get_employee_path(snapshot_id: int, target_employee_id: str) -> list[str]:
    """
    Walk up from *target_employee_id* to the root, returning the path
    as a list of employee_ids from root → target (inclusive).
    """
    emp_rows = _fetch_employees(snapshot_id)
    emp_dict = {e["employee_id"]: e for e in emp_rows}
    path: list[str] = []
    current = target_employee_id
    seen: set[str] = set()
    while current and current in emp_dict and current not in seen:
        seen.add(current)
        path.append(current)
        current = emp_dict[current]["raw_supervisor_id"]
    path.reverse()
    return path


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_FIELDS = (
    "employee_id",
    "first_name",
    "last_name",
    "job_title",
    "management_level",
    "department",
    "entity",
    "city",
    "state",
    "site_location",
    "employee_type",
    "pay_type",
    "annual_salary",
    "fully_loaded_cost",
    "is_overhead",
    "revenue_attribution",
    "raw_supervisor_id",
)


def _fetch_employees(snapshot_id: int) -> list[dict]:
    """Single query — returns all employees as plain dicts."""
    return list(
        Employee.objects.filter(snapshot_id=snapshot_id)
        .values(*_FIELDS)
    )


def _build_lookups(emp_rows: list[dict]):
    """
    Returns
    -------
    emp_dict : dict[str, dict]
        employee_id → row dict.
    children_map : dict[str, list[str]]
        parent employee_id → [child employee_ids] (ordered by last name).
    natural_roots : list[str]
        employee_ids with no supervisor.
    """
    emp_dict: dict[str, dict] = {}
    children_map: defaultdict[str, list[str]] = defaultdict(list)
    natural_roots: list[str] = []

    for row in emp_rows:
        eid = row["employee_id"]
        emp_dict[eid] = row
        sup = row["raw_supervisor_id"]
        if sup:
            children_map[sup].append(eid)
        else:
            natural_roots.append(eid)

    return emp_dict, children_map, natural_roots


def _build_node(
    eid: str,
    emp_dict: dict[str, dict],
    children_map: dict[str, list[str]],
    max_depth: int | None,
    current_depth: int,
) -> dict:
    """Recursively build a tree node with bottom-up metrics."""
    emp = emp_dict[eid]
    child_ids = children_map.get(eid, [])
    is_leaf = len(child_ids) == 0

    # Recurse into children (if depth allows)
    children_nodes: list[dict] = []
    if not is_leaf and (max_depth is None or current_depth < max_depth):
        children_nodes = [
            _build_node(cid, emp_dict, children_map, max_depth, current_depth + 1)
            for cid in child_ids
            if cid in emp_dict
        ]

    # ── Aggregate metrics bottom-up ─────────────────────────────────────

    # Self values
    self_salary = _dec(emp["annual_salary"])
    self_revenue = _dec(emp["revenue_attribution"])
    self_overhead = emp["is_overhead"]

    if is_leaf or not children_nodes:
        headcount = 1
        total_labor_cost = self_salary or Decimal(0)
        revenue_managed = self_revenue
        has_any_revenue = self_revenue is not None
        overhead_count = 1 if self_overhead is True else 0
        has_any_overhead_data = self_overhead is not None
        num_layers = 0
        # Span-of-control accumulators
        total_direct_reports = 0
        manager_count = 0
    else:
        headcount = 1
        total_labor_cost = self_salary or Decimal(0)
        revenue_sum = self_revenue or Decimal(0)
        has_any_revenue = self_revenue is not None
        overhead_count = 1 if self_overhead is True else 0
        has_any_overhead_data = self_overhead is not None
        max_child_layers = 0
        total_direct_reports = 0
        manager_count = 0

        for child in children_nodes:
            cm = child["_agg"]
            headcount += cm["headcount"]
            total_labor_cost += cm["total_labor_cost"]
            revenue_sum += cm["revenue_sum"]
            if cm["has_any_revenue"]:
                has_any_revenue = True
            overhead_count += cm["overhead_count"]
            if cm["has_any_overhead_data"]:
                has_any_overhead_data = True
            if cm["num_layers"] > max_child_layers:
                max_child_layers = cm["num_layers"]
            total_direct_reports += cm["total_direct_reports"]
            manager_count += cm["manager_count"]

        num_layers = max_child_layers + 1
        revenue_managed = revenue_sum if has_any_revenue else None

    # This node is a manager if it has children
    if children_nodes:
        total_direct_reports += len(children_nodes)
        manager_count += 1

    # Compute final derived metrics
    avg_span = (
        round(total_direct_reports / manager_count, 1)
        if manager_count > 0 else None
    )
    overhead_pct = (
        round(float(overhead_count) / headcount * 100, 1)
        if has_any_overhead_data and headcount > 0 else None
    )

    # ── Assemble node ───────────────────────────────────────────────────

    node = {
        "employee_id":      emp["employee_id"],
        "first_name":       emp["first_name"],
        "last_name":        emp["last_name"],
        "full_name":        f'{emp["first_name"]} {emp["last_name"]}'.strip(),
        "job_title":        emp["job_title"],
        "management_level": emp["management_level"],
        "department":       emp["department"],
        "entity":           emp["entity"],
        "city":             emp["city"],
        "state":            emp["state"],
        "metrics": {
            "headcount":            headcount,
            "direct_report_count":  len(children_nodes),
            "total_labor_cost":     float(total_labor_cost),
            "revenue_managed":      float(revenue_managed) if revenue_managed is not None else None,
            "avg_span_of_control":  avg_span,
            "num_layers":           num_layers,
            "overhead_pct":         overhead_pct,
        },
        "children":    children_nodes,
        "is_leaf":     is_leaf and not children_nodes,
        "has_children": bool(children_nodes),
        "child_count": len(children_nodes),
        # Internal aggregation bucket — stripped before JSON serialisation
        "_agg": {
            "headcount":            headcount,
            "total_labor_cost":     total_labor_cost,
            "revenue_sum":          (revenue_managed or Decimal(0)) if not is_leaf else (self_revenue or Decimal(0)),
            "has_any_revenue":      has_any_revenue,
            "overhead_count":       overhead_count,
            "has_any_overhead_data": has_any_overhead_data,
            "num_layers":           num_layers,
            "total_direct_reports": total_direct_reports,
            "manager_count":        manager_count,
        },
    }

    return node


def strip_aggregation(tree):
    """
    Remove the internal ``_agg`` keys from the tree before returning
    to an API consumer.  Mutates in place and returns the tree.
    """
    if isinstance(tree, list):
        for node in tree:
            strip_aggregation(node)
    elif isinstance(tree, dict):
        tree.pop("_agg", None)
        for child in tree.get("children", []):
            strip_aggregation(child)
    return tree


# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------

def _dec(val) -> Decimal | None:
    if val is None:
        return None
    if isinstance(val, Decimal):
        return val
    try:
        return Decimal(str(val))
    except Exception:
        return None
