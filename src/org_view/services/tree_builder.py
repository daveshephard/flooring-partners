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
#
# Cache-invalidation hooks live at exactly two write sites:
#   - services/changeset.commit_changeset()
#   - services/corrections.replay_corrections()
# Both carry a comment pointing back here.
"""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from org_view.models import Employee

from .costing import cost_of, to_decimal as _dec


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_tree(
    snapshot_id: int,
    root_employee_id: str | None = None,
    max_depth: int | None = None,
    report: dict | None = None,
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
    report : dict, optional
        If given, is populated in place with structural diagnostics — see
        :func:`build_tree_from_rows`.

    Returns
    -------
    dict
        A single root node (when root_employee_id is given or there is
        exactly one natural root), **or** a list of root nodes when
        the snapshot has multiple roots and no explicit root is given.
    """
    emp_rows = _fetch_employees(snapshot_id)
    return build_tree_from_rows(
        emp_rows, root_employee_id=root_employee_id, max_depth=max_depth, report=report,
    )


def build_tree_from_rows(
    emp_rows: list[dict],
    root_employee_id: str | None = None,
    max_depth: int | None = None,
    report: dict | None = None,
) -> dict | list[dict]:
    """Build a nested org tree from pre-fetched rows.

    Each row must carry the keys in ``_FIELDS`` (``employee_id``,
    ``raw_supervisor_id``, pay/attribute fields, …). This is the reusable core
    behind :func:`build_tree`; scenarios pass ``ScenarioPosition`` rows through
    it so a what-if org renders identically to a snapshot.

    ``report``, when supplied, is filled with:

    ``unreachable``   {employee_id: reason} — rows the chart won't draw, or
                      draws only as an extra root. See :func:`_build_lookups`.
    ``cycles``        list of employee_id lists, one per supervisor loop.
    ``natural_roots`` every root id, in order.
    ``rendered``      how many people the returned tree actually contains.
    """
    if not emp_rows:
        if report is not None:
            report.update({"unreachable": {}, "cycles": [], "natural_roots": [], "rendered": 0})
        return []

    emp_dict, children_map, natural_roots, unreachable = _build_lookups(emp_rows)

    if root_employee_id and root_employee_id in emp_dict:
        roots = [root_employee_id]
    else:
        roots = natural_roots

    nodes = [_build_node(eid, emp_dict, children_map, max_depth, 0) for eid in roots]

    if report is not None:
        report["unreachable"] = unreachable
        report["cycles"] = detect_cycles_in_rows(emp_rows)
        report["natural_roots"] = list(natural_roots)
        report["rendered"] = _count_nodes(nodes[0]) if nodes else 0

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
    """Single query — returns all employees as plain dicts.

    Rows excluded by a correction (``employee_status`` sentinel) are filtered
    out here, which is what keeps them off the chart everywhere at once.
    """
    return list(
        Employee.objects.filter(snapshot_id=snapshot_id)
        .exclude(employee_status=Employee.EXCLUDED_STATUS)
        .values(*_FIELDS)
    )


def detect_cycles_in_rows(emp_rows) -> list[list[str]]:
    """Every supervisor loop in *emp_rows*, each as a list of employee_ids.

    Iterative colour-marking walk — must never recurse, this runs on 800+ rows.
    """
    parent = {row["employee_id"]: (row.get("raw_supervisor_id") or None) for row in emp_rows}
    return detect_cycles(parent)


def detect_cycles(parent_map: dict) -> list[list[str]]:
    """Return each cycle in *parent_map* as a list of employee_ids.

    ``parent_map`` maps employee_id → supervisor_id (or None). Supervisor ids
    that aren't themselves keys terminate the walk. Empty list means acyclic.

    Iterative (white / grey / black colouring) — never recursive, so an 800-node
    chain can't blow the stack.
    """
    WHITE, GREY, BLACK = 0, 1, 2
    colour: dict[str, int] = {k: WHITE for k in parent_map}
    cycles: list[list[str]] = []

    for start in parent_map:
        if colour[start] != WHITE:
            continue
        path: list[str] = []
        index: dict[str, int] = {}
        node = start
        while node is not None and node in parent_map and colour[node] == WHITE:
            colour[node] = GREY
            index[node] = len(path)
            path.append(node)
            node = parent_map.get(node)
        if node is not None and node in colour and colour[node] == GREY and node in index:
            cycles.append(path[index[node]:])
        for n in path:
            colour[n] = BLACK

    return cycles


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
    unreachable : dict[str, str]
        employee_id → reason, for every row the chart cannot draw under the
        primary root. ``reason`` is one of:

        ``supervisor_not_found``  supervisor is set but names nobody in the
                                  census — the commonest census defect, and the
                                  reason these people were previously *invisible*
                                  (they land in ``children_map`` under a parent
                                  that is never visited, and are not added to
                                  ``natural_roots``).
        ``extra_root``            no supervisor, and not the first natural root.
                                  These do build as their own trees, but the
                                  chart only renders the primary root, so from
                                  the user's point of view they are unattached.
        ``self_referential``      ``raw_supervisor_id == employee_id``.
        ``in_cycle``              part of a supervisor loop.

        Only *cluster roots* are listed — a person hanging off an orphan is
        unreachable too, but they travel with their manager and would only
        clutter the tray. Callers that need the whole cluster walk
        ``children_map`` from the listed id.
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

    unreachable: dict[str, str] = {}

    for eid, row in emp_dict.items():
        sup = row["raw_supervisor_id"]
        if sup and sup == eid:
            unreachable[eid] = "self_referential"
        elif sup and sup not in emp_dict:
            unreachable[eid] = "supervisor_not_found"

    for cycle in detect_cycles({e: emp_dict[e]["raw_supervisor_id"] or None for e in emp_dict}):
        for eid in cycle:
            unreachable.setdefault(eid, "in_cycle")

    # Extra roots render as their own trees but never appear on the chart,
    # which only draws the primary root. Surface them for attachment.
    for eid in natural_roots[1:]:
        unreachable.setdefault(eid, "extra_root")

    return emp_dict, children_map, natural_roots, unreachable


def _count_nodes(node) -> int:
    """Number of nodes in an already-built subtree (iterative)."""
    if not node:
        return 0
    total = 0
    stack = [node]
    while stack:
        cur = stack.pop()
        total += 1
        stack.extend(cur.get("children") or [])
    return total


def _build_node(
    eid: str,
    emp_dict: dict[str, dict],
    children_map: dict[str, list[str]],
    max_depth: int | None,
    current_depth: int,
    seen: frozenset[str] = frozenset(),
) -> dict:
    """Recursively build a tree node with bottom-up metrics.

    ``seen`` carries the ancestor chain so a ``raw_supervisor_id`` loop truncates
    instead of recursing forever. A hung worker is a far worse failure mode than
    a partially-drawn branch, so a cycle is flagged, not raised.
    """
    emp = emp_dict[eid]
    child_ids = children_map.get(eid, [])
    is_leaf = len(child_ids) == 0

    # Recurse into children (if depth allows)
    children_nodes: list[dict] = []
    cycle_truncated = False
    if not is_leaf and (max_depth is None or current_depth < max_depth):
        next_seen = seen | {eid}
        for cid in child_ids:
            if cid not in emp_dict:
                continue
            if cid in next_seen:
                cycle_truncated = True
                continue
            children_nodes.append(
                _build_node(cid, emp_dict, children_map, max_depth, current_depth + 1, next_seen)
            )

    # ── Aggregate metrics bottom-up ─────────────────────────────────────

    # Self values
    self_cost = cost_of(emp)
    self_revenue = _dec(emp["revenue_attribution"])
    self_overhead = emp["is_overhead"]

    if is_leaf or not children_nodes:
        headcount = 1
        total_labor_cost = self_cost
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
        total_labor_cost = self_cost
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
        "site_location":    emp["site_location"],
        "raw_supervisor_id": emp["raw_supervisor_id"],
        # The node's own contribution to each rollup. metrics.js needs these to
        # mirror this function client-side after a staged move; without them the
        # browser can only re-render, not re-aggregate.
        "self": {
            "cost":        float(self_cost),
            "revenue":     float(self_revenue) if self_revenue is not None else None,
            "is_overhead": self_overhead,
        },
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

    if cycle_truncated:
        node["_cycle_truncated"] = True

    return node


#: Metric keys that reveal pay / cost and must be hidden from restricted users.
_PAY_METRIC_KEYS = ("total_labor_cost", "revenue_managed")


def redact_pay(tree):
    """Null out pay/cost metrics in every node, in place.

    Used for the ``restricted`` role so salary and cost figures never reach the
    browser — not even as aggregates/rollups on the org chart.
    """
    if isinstance(tree, list):
        for node in tree:
            redact_pay(node)
    elif isinstance(tree, dict):
        metrics = tree.get("metrics")
        if isinstance(metrics, dict):
            for key in _PAY_METRIC_KEYS:
                if key in metrics:
                    metrics[key] = None
        selfvals = tree.get("self")
        if isinstance(selfvals, dict):
            selfvals["cost"] = None
            selfvals["revenue"] = None
        for child in tree.get("children", []):
            redact_pay(child)
    return tree


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
