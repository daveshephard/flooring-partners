/* Client-side metric recompute — a deliberate mirror of
 * services/tree_builder.py::_build_node.
 *
 * After a staged move the card rollups are stale, and refetching the tree on
 * every drag defeats the point of batch editing. So we recompute locally and
 * let the commit response replace the estimate with authoritative numbers.
 *
 * Six of the seven metrics are mirrored. `revenue_managed` deliberately is NOT:
 * the server's `_agg["revenue_sum"]` rollup is flagged unverified (06 §3b), and
 * mirroring logic nobody has confirmed guarantees drift. Revenue keeps whatever
 * the server last said and is marked stale while the changeset is dirty.
 *
 * Guarded by a parity test — see __tests__/metrics.parity.mjs and
 * ChartPageTests.test_client_metrics_match_server.
 */
"use strict";

export const MIRRORED_METRICS = [
  "headcount",
  "direct_report_count",
  "total_labor_cost",
  "avg_span_of_control",
  "num_layers",
  "overhead_pct",
];

/** Mutates node.metrics in place, bottom-up. Returns the tree. */
export function recomputeMetrics(tree) {
  if (!tree) return tree;
  const nodes = Array.isArray(tree) ? tree : [tree];
  nodes.forEach(aggregate);
  return tree;
}

function aggregate(node) {
  const children = node.children || [];
  const isLeaf = children.length === 0;

  const self = node.self || {};
  const selfCost = num(self.cost);
  const selfOverhead = self.is_overhead;

  const agg = children.map(aggregate);

  let headcount = 1;
  let totalLaborCost = selfCost;
  let overheadCount = selfOverhead === true ? 1 : 0;
  // Seeded from the node's own value *before* the child loop — matching
  // has_any_overhead_data in _build_node, so a node with is_overhead set but
  // no descendants that carry it still reports a percentage.
  let hasAnyOverheadData = selfOverhead !== null && selfOverhead !== undefined;
  let numLayers = 0;
  let totalDirectReports = 0;
  let managerCount = 0;

  if (!isLeaf) {
    let maxChildLayers = 0;
    for (const cm of agg) {
      headcount += cm.headcount;
      totalLaborCost += cm.total_labor_cost;
      overheadCount += cm.overhead_count;
      if (cm.has_any_overhead_data) hasAnyOverheadData = true;
      if (cm.num_layers > maxChildLayers) maxChildLayers = cm.num_layers;
      totalDirectReports += cm.total_direct_reports;
      managerCount += cm.manager_count;
    }
    numLayers = maxChildLayers + 1;
    totalDirectReports += children.length;
    managerCount += 1;
  }

  const avgSpan = managerCount > 0
    ? round1(totalDirectReports / managerCount)
    : null;
  const overheadPct = (hasAnyOverheadData && headcount > 0)
    ? round1((overheadCount / headcount) * 100)
    : null;

  const m = node.metrics || (node.metrics = {});
  m.headcount = headcount;
  m.direct_report_count = children.length;
  m.total_labor_cost = totalLaborCost;
  m.avg_span_of_control = avgSpan;
  m.num_layers = numLayers;
  m.overhead_pct = overheadPct;
  // revenue_managed intentionally left as-is — see the module docstring.

  node.is_leaf = isLeaf;
  node.has_children = !isLeaf;
  node.child_count = children.length;

  return {
    headcount,
    total_labor_cost: totalLaborCost,
    overhead_count: overheadCount,
    has_any_overhead_data: hasAnyOverheadData,
    num_layers: numLayers,
    total_direct_reports: totalDirectReports,
    manager_count: managerCount,
  };
}

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

/* Python's round(x, 1) is banker's rounding; JS toFixed is half-away-from-zero.
   The values here are ratios of small integers and percentages, where the two
   agree except on exact .x5 ties — which round() resolves to even. Match that. */
function round1(x) {
  const scaled = x * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded;
  if (Math.abs(diff - 0.5) < 1e-9) {
    rounded = (floor % 2 === 0) ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / 10;
}

/** A tree node shaped like the API's, for a row the chart has never drawn. */
export function makeNode(row) {
  return {
    employee_id: row.employee_id,
    first_name: row.first_name || "",
    last_name: row.last_name || "",
    full_name: row.full_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
    job_title: row.job_title || "",
    management_level: row.management_level || "",
    department: row.department || "",
    entity: row.entity || "",
    city: row.city || "",
    state: row.state || "",
    site_location: row.site_location || "",
    raw_supervisor_id: row.raw_supervisor_id || null,
    self: row.self || { cost: 0, revenue: null, is_overhead: null },
    metrics: {
      headcount: 1, direct_report_count: 0, total_labor_cost: 0,
      revenue_managed: null, avg_span_of_control: null, num_layers: 0,
      overhead_pct: null,
    },
    children: [],
    is_leaf: true,
    has_children: false,
    child_count: 0,
  };
}
