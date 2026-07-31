/* The pending changeset — every staged edit, before it reaches the server.
 *
 * Ops accumulate here, the chart re-renders optimistically, and nothing is
 * written until Save. The review modal's per-row Remove is the undo mechanism.
 *
 * Op shape matches the server vocabulary exactly (02-editing-api §1):
 *   { op, employee_id, after, note, _before, _label }
 * `_`-prefixed keys are client-only and stripped before POSTing.
 */
"use strict";

const SAVE_DEBOUNCE_MS = 300;

export const OP_BADGE = {
  reparent:  { cls: "b-moved",    label: "Moved" },
  set_root:  { cls: "b-root",     label: "New root" },
  attribute: { cls: "b-modified", label: "Modified" },
  exclude:   { cls: "b-excluded", label: "Excluded" },
  add:       { cls: "b-added",    label: "Added" },
  eliminate: { cls: "b-removed",  label: "Eliminated" },
};

/** Diff-modal grouping order — the same order the scenario ledger already uses. */
const GROUP_ORDER = ["eliminate", "add", "reparent", "set_root", "exclude", "attribute"];
const GROUP_TITLE = {
  eliminate: "Eliminations",
  add: "Additions",
  reparent: "Moves",
  set_root: "New roots",
  exclude: "Exclusions",
  attribute: "Attribute changes",
};

export const changeset = {
  ops: [],
  target: "corrections",
  storageKey: null,
  snapshotId: null,
  _subs: [],
  _saveTimer: null,
  _tmpSeq: 0,

  configure({ target, storageKey, snapshotId }) {
    this.target = target;
    this.storageKey = storageKey;
    this.snapshotId = snapshotId;
  },

  nextTempId() {
    this._tmpSeq += 1;
    return "TMP-" + this._tmpSeq;
  },

  count() { return this.ops.length; },
  isDirty() { return this.ops.length > 0; },

  forEmployee(eid) {
    // Attribute + reparent can coexist on one person; the badge shows the most
    // structural of them, which is the earliest in GROUP_ORDER.
    const mine = this.ops.filter(o => o.employee_id === eid);
    if (!mine.length) return null;
    mine.sort((a, b) => GROUP_ORDER.indexOf(a.op) - GROUP_ORDER.indexOf(b.op));
    return mine[0];
  },

  allForEmployee(eid) {
    return this.ops.filter(o => o.employee_id === eid);
  },

  add(op) {
    const i = this.ops.findIndex(o => o.op === op.op && o.employee_id === op.employee_id);

    if (op.op === "attribute" && i >= 0) {
      // Editing title then department is one op with two fields, not two ops.
      const existing = this.ops[i];
      existing.after = { ...existing.after, ...op.after };
      existing._before = { ...(op._before || {}), ...(existing._before || {}) };
      if (op.note) existing.note = op.note;
      if (!Object.keys(existing.after).length) this.ops.splice(i, 1);
      return this._changed();
    }

    if (op.op === "eliminate" && String(op.employee_id).startsWith("TMP-")) {
      // Adding then eliminating a to-be-hired role leaves nothing behind.
      this.ops = this.ops.filter(o => o.employee_id !== op.employee_id);
      return this._changed();
    }

    if (op.op === "reparent") {
      const original = (op._before || {}).raw_supervisor_id ?? null;
      const target = (op.after || {}).raw_supervisor_id ?? null;
      if (norm(original) === norm(target)) {
        // Dragged away and back — leave zero pending changes, not two.
        if (i >= 0) this.ops.splice(i, 1);
        this.ops = this.ops.filter(
          o => !(o.op === "set_root" && o.employee_id === op.employee_id));
        return this._changed();
      }
      // A reparent supersedes a staged set_root for the same person, and vice versa.
      this.ops = this.ops.filter(
        o => !(o.op === "set_root" && o.employee_id === op.employee_id));
    }

    if (op.op === "set_root") {
      this.ops = this.ops.filter(
        o => !(o.op === "reparent" && o.employee_id === op.employee_id));
      const original = (op._before || {}).raw_supervisor_id ?? null;
      if (norm(original) === "") {
        const j = this.ops.findIndex(o => o.op === "set_root" && o.employee_id === op.employee_id);
        if (j >= 0) this.ops.splice(j, 1);
        return this._changed();
      }
    }

    const at = this.ops.findIndex(o => o.op === op.op && o.employee_id === op.employee_id);
    if (at >= 0) {
      // Same op, same person — replace. Moving Jane A→B→C is one reparent to C,
      // keeping the *original* _before so the restore-check still works.
      op._before = this.ops[at]._before || op._before;
      this.ops[at] = op;
    } else {
      this.ops.push(op);
    }
    return this._changed();
  },

  removeAt(i) {
    if (i < 0 || i >= this.ops.length) return;
    const [removed] = this.ops.splice(i, 1);
    if (removed.op === "add") {
      // Anything that referenced the removed temp id goes with it.
      this.ops = this.ops.filter(o => {
        if (o.employee_id === removed.employee_id) return false;
        const sup = (o.after || {}).raw_supervisor_id;
        return sup !== removed.employee_id;
      });
    }
    this._changed(removed);
  },

  removeFor(eid, opName) {
    const i = this.ops.findIndex(o => o.employee_id === eid && (!opName || o.op === opName));
    if (i >= 0) this.removeAt(i);
  },

  clear() {
    const had = this.ops;
    this.ops = [];
    this._changed(null, had);
  },

  replaceIds(idMap) {
    if (!idMap) return;
    for (const op of this.ops) {
      if (idMap[op.employee_id]) op.employee_id = idMap[op.employee_id];
      const sup = (op.after || {}).raw_supervisor_id;
      if (sup && idMap[sup]) op.after.raw_supervisor_id = idMap[sup];
    }
  },

  /** Ops as the server wants them — client-only keys stripped. */
  payload() {
    return this.ops.map(({ op, employee_id, after, note }) => ({
      op, employee_id, after: after || {}, note: note || "",
    }));
  },

  /** Grouped for the review modal. */
  grouped() {
    const out = [];
    for (const name of GROUP_ORDER) {
      const rows = this.ops
        .map((op, index) => ({ op, index }))
        .filter(r => r.op.op === name);
      if (rows.length) out.push({ name, title: GROUP_TITLE[name], rows });
    }
    return out;
  },

  subscribe(fn) { this._subs.push(fn); return () => {
    this._subs = this._subs.filter(f => f !== fn);
  }; },

  _changed(removed, cleared) {
    this.persist();
    for (const fn of this._subs) {
      try { fn(this, { removed, cleared }); } catch (e) { console.error(e); }
    }
  },

  /* ── sessionStorage mirroring ─────────────────────────────────────
     Batch save means a closed tab can lose work. Mitigating it is cheap. */
  persist() {
    if (!this.storageKey) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        if (!this.ops.length) {
          sessionStorage.removeItem(this.storageKey);
        } else {
          sessionStorage.setItem(this.storageKey, JSON.stringify({
            snapshotId: this.snapshotId,
            target: this.target,
            ops: this.ops,
            savedAt: Date.now(),
          }));
        }
      } catch (e) { /* private mode / quota — recovery is best-effort */ }
    }, SAVE_DEBOUNCE_MS);
  },

  /** {ops, snapshotId, stale} for a stored changeset, or null. */
  peekStored() {
    if (!this.storageKey) return null;
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      if (!raw) return null;
      const blob = JSON.parse(raw);
      if (!blob || !Array.isArray(blob.ops) || !blob.ops.length) return null;
      return { ...blob, stale: blob.snapshotId !== this.snapshotId };
    } catch (e) { return null; }
  },

  restore(ops) {
    this.ops = ops.slice();
    let maxTmp = 0;
    for (const o of this.ops) {
      const m = /^TMP-(\d+)$/.exec(o.employee_id || "");
      if (m) maxTmp = Math.max(maxTmp, parseInt(m[1], 10));
    }
    this._tmpSeq = maxTmp;
    this._changed();
  },

  discardStored() {
    if (!this.storageKey) return;
    try { sessionStorage.removeItem(this.storageKey); } catch (e) {}
  },
};

function norm(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

export function storageKeyFor(cfg) {
  const scope = cfg.mode === "scenario"
    ? "scenario-" + (cfg.scenarioId || "none")
    : "snapshot-" + (cfg.snapshotId || "none");
  return `orgview:changeset:${cfg.companySlug}:${cfg.mode}:${scope}`;
}
