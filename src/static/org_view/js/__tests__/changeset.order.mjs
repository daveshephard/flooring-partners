/* The pending changeset's wire ordering.
 *
 * The server walks a batch in the order it arrives and rejects a manager it
 * hasn't seen yet, so an `add` has to reach it before anything that reports to
 * the id that add introduces. Staging order does not guarantee that: add()
 * replaces an existing op *in place*, so a reparent staged before the role
 * existed keeps its old, earlier index when it's re-pointed at the new role.
 *
 * The bug: move someone, create a role, drop them onto the role → the server got
 * "E9 reports to TMP-1" at index 0 and "add TMP-1" at index 1, failed the whole
 * batch with "Manager TMP-1 is not in this census", and the editor re-opened the
 * change log. Reported as "I can't assign direct reports to a role I created"
 * plus "the change log appears a second time".
 *
 * Run: node src/static/org_view/js/__tests__/changeset.order.mjs
 */
import assert from "node:assert/strict";

import { changeset, orderForCommit } from "../changeset.js";

let checks = 0;
function check(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

function reset() {
  changeset.ops = [];
  changeset.storageKey = null;      // keeps persist() out of sessionStorage
  changeset._tmpSeq = 0;
  changeset._subs = [];
}

const addRole = (tmp, sup) => ({
  op: "add", employee_id: tmp,
  after: { job_title: "Ops Director", raw_supervisor_id: sup },
});
const reparent = (eid, to, from) => ({
  op: "reparent", employee_id: eid,
  after: { raw_supervisor_id: to }, _before: { raw_supervisor_id: from },
});

/* ── orderForCommit ──────────────────────────────────────────────── */

check("an untouched batch keeps its staging order", () => {
  const ops = [
    reparent("E3", "E5", "E2"),
    { op: "attribute", employee_id: "E4", after: { job_title: "Lead" } },
    { op: "eliminate", employee_id: "E6", after: {} },
  ];
  assert.deepEqual(orderForCommit(ops), ops, "no adds means nothing to reorder");
});

check("an add is emitted before anything that reports to it", () => {
  const ops = [reparent("E3", "TMP-1", "E2"), addRole("TMP-1", "E1")];
  const out = orderForCommit(ops);
  assert.equal(out[0].op, "add");
  assert.equal(out[1].employee_id, "E3");
});

check("an add under another add stays in creation order", () => {
  // Create a role, then a second role beneath it, then staff the second one.
  const ops = [
    reparent("E4", "TMP-2", "E2"),
    addRole("TMP-1", "E1"),
    addRole("TMP-2", "TMP-1"),
  ];
  const out = orderForCommit(ops).map(o => o.employee_id);
  assert.deepEqual(out, ["TMP-1", "TMP-2", "E4"]);
});

check("a reallocation destination counts as a dependency", () => {
  // Eliminating a manager and sending their team to a role created in the same
  // batch: the role has to exist first or the whole batch is refused.
  const ops = [
    { op: "eliminate", employee_id: "E2", after: { reassign: { E3: "TMP-1", E4: "TMP-1" } } },
    addRole("TMP-1", "E1"),
  ];
  const out = orderForCommit(ops);
  assert.equal(out[0].employee_id, "TMP-1");
  assert.equal(out[1].op, "eliminate");
});

check("ops with no staged dependency keep their relative order", () => {
  const ops = [
    { op: "attribute", employee_id: "E3", after: { city: "Tacoma" } },
    reparent("E4", "TMP-1", "E2"),
    { op: "attribute", employee_id: "E5", after: { city: "Kent" } },
    addRole("TMP-1", "E1"),
  ];
  const out = orderForCommit(ops).map(o => o.employee_id);
  assert.deepEqual(out, ["E3", "E5", "TMP-1", "E4"]);
});

check("nothing is dropped, even in a shape the UI can't produce", () => {
  // Two staged adds each reporting to the other. Unreachable through the chart,
  // but silently discarding an op would be far worse than letting the server
  // rule on it.
  const ops = [addRole("TMP-1", "TMP-2"), addRole("TMP-2", "TMP-1")];
  assert.equal(orderForCommit(ops).length, 2);
});

/* ── The reported sequence, end to end ───────────────────────────── */

check("move, create a role, then move onto the role — add goes first", () => {
  reset();
  changeset.add(reparent("E3", "E5", "E2"));          // an ordinary move
  changeset.add(addRole("TMP-1", "E1"));              // then create the role
  changeset.add(reparent("E3", "TMP-1", "E2"));       // then staff it

  assert.equal(changeset.count(), 2, "the re-pointed move replaces the first one");
  assert.equal(changeset.ops[0].employee_id, "E3",
    "staging order still has the replaced op first — that was the bug");

  const { ops, stagingIndex } = changeset.commitPayload();
  assert.equal(ops[0].op, "add", "the wire order must lead with the add");
  assert.equal(ops[1].after.raw_supervisor_id, "TMP-1");
  assert.deepEqual(stagingIndex, [1, 0], "and errors must map back to staging rows");
});

check("payload() carries no client-only keys", () => {
  reset();
  changeset.add(addRole("TMP-1", "E1"));
  changeset.add(reparent("E3", "TMP-1", "E2"));
  for (const op of changeset.payload()) {
    assert.deepEqual(Object.keys(op).sort(), ["after", "employee_id", "note", "op"]);
  }
});

check("a server error index resolves to the row that caused it", () => {
  reset();
  changeset.add(reparent("E3", "E5", "E2"));
  changeset.add(addRole("TMP-1", "E1"));
  changeset.add(reparent("E3", "TMP-1", "E2"));
  const { ops, stagingIndex } = changeset.commitPayload();
  // The server flags payload index 1 (the reparent); the review list must flag
  // staging index 0, which is where that same op lives.
  assert.equal(ops[1].employee_id, "E3");
  assert.equal(stagingIndex[1], 0);
  assert.equal(changeset.ops[stagingIndex[1]].employee_id, "E3");
});

if (process.exitCode) {
  console.error("changeset ordering tests FAILED");
} else {
  console.log(`changeset ordering OK — ${checks} checks`);
}
