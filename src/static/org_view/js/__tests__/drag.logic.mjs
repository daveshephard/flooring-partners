/* Unit tests for the pure logic in drag.js and the changeset op-collapsing
 * rules in changeset.js.
 *
 * Pointer dragging itself isn't worth a browser harness here; the decision
 * functions are, because they are where the bugs would be silent.
 *
 * No npm packages — run it with:  node src/static/org_view/js/__tests__/drag.logic.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  invalidTargetsFor, isValidDrop, edgePanDelta, branchMembers,
  EDGE_ZONE, MAX_PAN_SPEED,
} from "../drag.js";

/* changeset.js touches sessionStorage; stub it before importing. */
globalThis.sessionStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, v); },
  removeItem(k) { this._d.delete(k); },
};
const { changeset } = await import("../changeset.js");

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixture.tree.json"), "utf8"));
const tree = fixture.tree;

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

/* ── invalidTargetsFor ───────────────────────────────────────────── */
check("invalidTargetsFor returns self + all descendants, nothing else", () => {
  // E5 (Supervisor) has E6 and E7 under them.
  const bad = invalidTargetsFor(tree, "E5");
  assert.deepEqual([...bad].sort(), ["E5", "E6", "E7"]);

  const leaf = invalidTargetsFor(tree, "E9");
  assert.deepEqual([...leaf], ["E9"]);

  const root = invalidTargetsFor(tree, "E1");
  assert.equal(root.size, 9, "the root's invalid set is the whole org");
});

/* ── isValidDrop ─────────────────────────────────────────────────── */
check("isValidDrop rejects self", () => {
  assert.equal(isValidDrop(tree, "E5", "E5", null), false);
});

check("isValidDrop rejects a descendant (a reporting loop)", () => {
  assert.equal(isValidDrop(tree, "E2", "E6", null), false);
  assert.equal(isValidDrop(tree, "E5", "E7", null), false);
});

check("isValidDrop rejects the current parent (a no-op, not an error)", () => {
  assert.equal(isValidDrop(tree, "E6", "E5", null), false);
});

check("isValidDrop accepts a genuine move", () => {
  assert.equal(isValidDrop(tree, "E6", "E2", null), true);
  assert.equal(isValidDrop(tree, "E9", "E1", null), true);
  assert.equal(isValidDrop(tree, "E3", "E8", null), true);
});

check("isValidDrop rejects out-of-branch for a restricted editor", () => {
  // A branch admin rooted at E2 may move E3 under E5, but not under E8.
  assert.equal(branchMembers(tree, "E2").size, 6);
  assert.equal(isValidDrop(tree, "E3", "E5", "E2"), true);
  assert.equal(isValidDrop(tree, "E3", "E8", "E2"), false);
});

/* ── edgePanDelta ────────────────────────────────────────────────── */
const rect = { left: 0, top: 0, right: 1000, bottom: 800 };

check("edgePanDelta is 0 outside the edge zone", () => {
  const { dx, dy } = edgePanDelta({ x: 500, y: 400 }, rect);
  assert.equal(dx, 0);
  assert.equal(dy, 0);
});

check("edgePanDelta ramps to MAX_PAN_SPEED at the edge, with the right sign", () => {
  // Pointer at the left edge → pan content right → positive dx.
  assert.equal(edgePanDelta({ x: 0, y: 400 }, rect).dx, MAX_PAN_SPEED);
  // Pointer at the right edge → negative dx.
  assert.equal(edgePanDelta({ x: 1000, y: 400 }, rect).dx, -MAX_PAN_SPEED);
  assert.equal(edgePanDelta({ x: 500, y: 0 }, rect).dy, MAX_PAN_SPEED);
  assert.equal(edgePanDelta({ x: 500, y: 800 }, rect).dy, -MAX_PAN_SPEED);
  // Exactly at the zone boundary → 0.
  assert.equal(edgePanDelta({ x: EDGE_ZONE, y: 400 }, rect).dx, 0);
  // Halfway in → half speed.
  const half = edgePanDelta({ x: EDGE_ZONE / 2, y: 400 }, rect).dx;
  assert.ok(Math.abs(half - MAX_PAN_SPEED / 2) < 1e-9, `expected half speed, got ${half}`);
});

/* ── changeset op collapsing ─────────────────────────────────────── */
function reparent(id, to, from) {
  return { op: "reparent", employee_id: id, after: { raw_supervisor_id: to },
           _before: { raw_supervisor_id: from } };
}

check("dragging A→B then B→A leaves 0 pending ops", () => {
  changeset.ops = [];
  changeset.storageKey = null;
  changeset.add(reparent("E6", "E2", "E5"));
  assert.equal(changeset.count(), 1);
  changeset.add(reparent("E6", "E5", "E5"));
  assert.equal(changeset.count(), 0, "move-and-back must cancel out");
});

check("moving the same person twice collapses to one op, keeping the original _before", () => {
  changeset.ops = [];
  changeset.add(reparent("E6", "E2", "E5"));
  changeset.add(reparent("E6", "E8", "E2"));
  assert.equal(changeset.count(), 1);
  assert.equal(changeset.ops[0].after.raw_supervisor_id, "E8");
  assert.equal(changeset.ops[0]._before.raw_supervisor_id, "E5",
    "_before must stay the original supervisor so restore-detection works");
});

check("attribute edits on one person merge into a single op", () => {
  changeset.ops = [];
  changeset.add({ op: "attribute", employee_id: "E3", after: { job_title: "Lead Tech" },
                  _before: { job_title: "Technician" } });
  changeset.add({ op: "attribute", employee_id: "E3", after: { department: "Service" },
                  _before: { department: "Ops" } });
  assert.equal(changeset.count(), 1);
  assert.deepEqual(changeset.ops[0].after, { job_title: "Lead Tech", department: "Service" });
  assert.deepEqual(changeset.ops[0]._before, { job_title: "Technician", department: "Ops" });
});

check("eliminating a staged TMP- addition removes both ops", () => {
  changeset.ops = [];
  const tmp = changeset.nextTempId();
  changeset.add({ op: "add", employee_id: tmp, after: { raw_supervisor_id: "E1", job_title: "New" } });
  changeset.add({ op: "eliminate", employee_id: tmp, after: {} });
  assert.equal(changeset.count(), 0);
});

check("removing an add op also removes ops that referenced its temp id", () => {
  changeset.ops = [];
  const tmp = changeset.nextTempId();
  changeset.add({ op: "add", employee_id: tmp, after: { raw_supervisor_id: "E1" } });
  changeset.add(reparent("E9", tmp, "E8"));
  assert.equal(changeset.count(), 2);
  changeset.removeAt(0);
  assert.equal(changeset.count(), 0, "the dangling reparent must go too");
});

if (process.exitCode) {
  console.error("drag logic tests FAILED");
} else {
  console.log(`drag logic OK — ${passed} checks`);
}
