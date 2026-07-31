/* Parity test: metrics.js must agree with services/tree_builder.py::_build_node.
 *
 * The fixture's `expected` block is the *server's* own output, so this catches
 * drift in either direction. Its Django twin is
 * ChartPageTests.test_client_metrics_match_server, which asserts the server
 * still produces that same `expected` from the same rows.
 *
 * No npm packages — run it with:  node src/static/org_view/js/__tests__/metrics.parity.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { recomputeMetrics, MIRRORED_METRICS } from "../metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixture.tree.json"), "utf8"));

/* Blank every metric so nothing can pass by simply being left alone. */
function blank(node) {
  node.metrics = { revenue_managed: node.metrics.revenue_managed };
  (node.children || []).forEach(blank);
  return node;
}

const tree = blank(JSON.parse(JSON.stringify(fixture.tree)));
recomputeMetrics(tree);

let checked = 0;
const failures = [];

(function walk(node) {
  const want = fixture.expected[node.employee_id];
  assert.ok(want, `fixture is missing expected metrics for ${node.employee_id}`);
  for (const key of MIRRORED_METRICS) {
    const got = node.metrics[key];
    checked += 1;
    const same = want[key] === null || want[key] === undefined
      ? (got === null || got === undefined)
      : Math.abs(Number(got) - Number(want[key])) < 1e-6;
    if (!same) {
      failures.push(`${node.employee_id}.${key}: client ${got} !== server ${want[key]}`);
    }
  }
  (node.children || []).forEach(walk);
})(tree);

if (failures.length) {
  console.error("metrics parity FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}

/* revenue_managed is deliberately NOT mirrored (see metrics.js) — assert we
   left the server's value alone rather than silently zeroing it. */
assert.equal(tree.metrics.revenue_managed, fixture.expected.E1.revenue_managed,
  "recomputeMetrics must leave revenue_managed untouched");

console.log(`metrics parity OK — ${checked} metric values across ${Object.keys(fixture.expected).length} nodes`);
