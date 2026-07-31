/* The editing shell — one shell, two persistence targets.
 *
 * Correct mode fixes the real structure through the durable corrections layer;
 * Scenario mode models a what-if against a ScenarioPosition set. They share the
 * drag layer, the side panel, the changeset store, the save bar and the review
 * modal, and differ only in which commit endpoint they hit and which summary
 * strip they show. Building two editors is how the viewer and the old editor
 * diverged in the first place.
 *
 * This module is the page entry point: it also starts the read-only chart, so
 * View mode works exactly as before even if nothing here is ever used.
 */
"use strict";

import * as chart from "./chart.js";
import { changeset, storageKeyFor, OP_BADGE } from "./changeset.js";
import { recomputeMetrics, makeNode } from "./metrics.js";
import {
  installDragLayer, invalidTargetsFor, branchMembers, findNodeIn, findParentIn,
} from "./drag.js";

const CFG = chart.CFG;
const EDIT_MODES = new Set(["correct", "scenario"]);

/* Field whitelists — mirrored from services/corrections.CORRECTABLE_FIELDS (12)
   and services/scenarios.EDITABLE_FIELDS (14). The old form exposed only 7. */
const CORRECTABLE_FIELDS = [
  ["first_name", "First name"], ["last_name", "Last name"],
  ["job_title", "Job title"], ["management_level", "Management level"],
  ["department", "Department"], ["site_location", "Site location"],
  ["city", "City"], ["state", "State"],
  ["employee_status", "Employee status"], ["employee_type", "Employee type"],
  ["pay_type", "Pay type"], ["entity", "Entity"],
];
const PAY_FIELDS = [
  ["annual_salary", "Annual salary"], ["fully_loaded_cost", "Fully loaded cost"],
];
const DATALIST_FIELDS = ["department", "management_level", "entity", "site_location"];

/* ── Page state ──────────────────────────────────────────────────── */
let mode = CFG.mode || "view";
let scenarioId = CFG.scenarioId || null;
let baseRows = [];          // flat node list from the last authoritative fetch
let primaryRootId = null;
let unattached = { orphans: [], excluded: [], counts: {} };
let correctionStats = { active: 0, needsReview: 0 };
let scenarioSummary = null;
let selectedId = null;
let dragLayer = null;
let trayCollapsed = true;
let calloutDismissed = false;

/* ── Elements ────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const $container = $("oc-page");
const $viewport  = $("oc-viewport");
const $modeSwitch = $("oc-mode-switch");
const $saveBar   = $("oc-save-bar");
const $saveCount = $("oc-save-count");
const $btnReview = $("oc-btn-review");
const $btnDiscard = $("oc-btn-discard");
const $btnSave   = $("oc-btn-save");
const $strip     = $("oc-summary-strip");
const $panel     = $("oc-panel");
const $tray      = $("oc-tray");
const $modalHost = $("oc-modal-host");
const $toasts    = $("oc-toasts");
const $recovery  = $("oc-recovery-banner");
const $cycleWarn = $("oc-cycle-banner");

/* ══════════════════════════════════════════════════════════════════
   Small helpers
   ══════════════════════════════════════════════════════════════════ */

const esc = chart.esc;

function toast(msg, kind) {
  if (!$toasts) return;
  const el = document.createElement("div");
  el.className = "oc-toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, options) {
  const opts = Object.assign({ headers: {} }, options);
  if (opts.body) {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["X-CSRFToken"] = CFG.csrfToken;
    opts.method = opts.method || "POST";
  }
  const resp = await fetch(chart.API_BASE + path, opts);
  let data = null;
  try { data = await resp.json(); } catch (e) {}
  return { ok: resp.ok, status: resp.status, data };
}

function isEditing() { return EDIT_MODES.has(mode); }
function whitelist() {
  return mode === "scenario"
    ? CORRECTABLE_FIELDS.concat(CFG.canSeePay ? PAY_FIELDS : [])
    : CORRECTABLE_FIELDS;
}

function fmtMoney(n) {
  if (n == null) return "—";
  return "$" + Math.round(n).toLocaleString();
}

/* ══════════════════════════════════════════════════════════════════
   Optimistic tree — rebuilt from base rows + pending ops
   ══════════════════════════════════════════════════════════════════
   Rebuilding beats incremental patching: removing an op in the review modal
   just re-runs this, so there is no "undo the patch" code path to get wrong. */

function captureBaseRows(tree) {
  baseRows = chart.flattenTree(tree).map(n => ({ ...n, children: undefined }));
  const roots = Array.isArray(tree) ? tree : [tree];
  primaryRootId = roots[0] ? roots[0].employee_id : null;
}

function orphanRow(o) {
  const node = makeNode({
    employee_id: o.employee_id,
    full_name: o.full_name,
    job_title: o.job_title,
    department: o.department,
    site_location: o.site_location,
    raw_supervisor_id: o.raw_supervisor_id,
    self: o.self,
  });
  node._orphan = true;
  node._reason = o.reason;
  node._reason_label = o.reason_label;
  return node;
}

function rebuildTree() {
  const byId = new Map();
  for (const r of baseRows) {
    byId.set(r.employee_id, { ...r, children: [], metrics: { ...(r.metrics || {}) } });
  }
  // Orphans join the pool so attaching one renders it immediately.
  for (const o of unattached.orphans) {
    if (!byId.has(o.employee_id)) byId.set(o.employee_id, orphanRow(o));
    for (const kid of (o.cluster || [])) {
      if (!byId.has(kid.employee_id)) byId.set(kid.employee_id, orphanRow(kid));
    }
  }

  const removed = new Set();
  for (const op of changeset.ops) {
    const eid = op.employee_id;
    if (op.op === "add") {
      byId.set(eid, Object.assign(makeNode({
        employee_id: eid,
        ...op.after,
        full_name: `${op.after.first_name || ""} ${op.after.last_name || ""}`.trim() || "(vacant)",
        self: { cost: Number(op.after.fully_loaded_cost || op.after.annual_salary || 0), revenue: null, is_overhead: null },
      }), { _pendingAdd: true, is_vacant: op.after.is_vacant !== false }));
      continue;
    }
    const node = byId.get(eid);
    if (!node) continue;
    if (op.op === "reparent") node.raw_supervisor_id = op.after.raw_supervisor_id;
    else if (op.op === "set_root") node.raw_supervisor_id = null;
    else if (op.op === "exclude") removed.add(eid);
    else if (op.op === "eliminate") removed.add(eid);
    else if (op.op === "attribute") {
      Object.assign(node, op.after);
      node.full_name = `${node.first_name || ""} ${node.last_name || ""}`.trim() || node.full_name;
      if (op.after.annual_salary != null || op.after.fully_loaded_cost != null) {
        node.self = {
          ...node.self,
          cost: Number(op.after.fully_loaded_cost || op.after.annual_salary || (node.self && node.self.cost) || 0),
        };
      }
    }
  }

  // An eliminated manager's reports move up, matching eliminate_position().
  for (const eid of removed) {
    const gone = byId.get(eid);
    const up = gone ? gone.raw_supervisor_id : null;
    for (const n of byId.values()) {
      if (n.raw_supervisor_id === eid) n.raw_supervisor_id = removed.has(up) ? null : up;
    }
    byId.delete(eid);
  }

  for (const n of byId.values()) n.children = [];
  const roots = [];
  const stranded = new Set();
  for (const n of byId.values()) {
    const sup = n.raw_supervisor_id;
    if (sup && byId.has(sup) && sup !== n.employee_id) {
      byId.get(sup).children.push(n);
    } else if (n.employee_id === primaryRootId || !sup) {
      roots.push(n);
    } else {
      stranded.add(n.employee_id);   // supervisor still missing — stays in the tray
    }
  }
  // Sort siblings the way the server does (last name, then first).
  for (const n of byId.values()) {
    n.children.sort((a, b) =>
      (a.last_name || "").localeCompare(b.last_name || "") ||
      (a.first_name || "").localeCompare(b.first_name || ""));
  }

  roots.sort((a, b) => (a.employee_id === primaryRootId ? -1 : b.employee_id === primaryRootId ? 1 : 0));
  const tree = roots.length === 1 ? roots[0] : roots;
  recomputeMetrics(tree);
  return { tree, stranded, byId };
}

function rerender() {
  const { tree } = rebuildTree();
  chart.refreshTree(tree);
  renderSummaryStrip();
  renderTray();
}

/* ══════════════════════════════════════════════════════════════════
   Mode switching
   ══════════════════════════════════════════════════════════════════ */

function setModeButtons() {
  if (!$modeSwitch) return;
  $modeSwitch.querySelectorAll(".oc-mode-btn").forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function applyModeChrome() {
  CFG.mode = mode;
  setModeButtons();
  $viewport.classList.toggle("oc-editing", isEditing());
  let label = $("oc-mode-label");
  if (isEditing()) {
    if (!label) {
      label = document.createElement("div");
      label.id = "oc-mode-label";
      label.className = "oc-mode-label";
      $viewport.appendChild(label);
    }
    label.textContent = mode === "correct"
      ? "Correcting"
      : "Scenario: " + (CFG.scenarioName || "untitled");
  } else if (label) {
    label.remove();
  }
  $saveBar.hidden = !isEditing();
  $strip.hidden = !isEditing();
  $tray.hidden = mode !== "correct";
  if (!isEditing()) closePanel();
  renderSaveBar();
}

function pushModeToUrl() {
  const url = new URL(window.location.href);
  if (mode === "view") { url.searchParams.delete("mode"); url.searchParams.delete("scenario"); }
  else {
    url.searchParams.set("mode", mode);
    if (mode === "scenario" && scenarioId) url.searchParams.set("scenario", scenarioId);
    else url.searchParams.delete("scenario");
  }
  url.searchParams.delete("focus");
  history.replaceState(null, "", url);
}

async function switchMode(next) {
  if (next === mode) return;
  if (changeset.isDirty()) {
    // Never silently drop pending work, and never carry it across targets —
    // a correction op is not a scenario op.
    const choice = await confirmModal({
      title: "You have unsaved changes",
      body: `${changeset.count()} change(s) are staged in ${mode} mode. `
          + "Switching modes discards them.",
      confirmLabel: "Discard and switch",
      extraLabel: "Save first",
    });
    if (choice === "cancel") return;
    if (choice === "extra") {
      const saved = await save();
      if (!saved) return;
    } else {
      changeset.clear();
      changeset.discardStored();
    }
  }

  if (next === "scenario" && !scenarioId) {
    const chosen = await pickScenario();
    if (!chosen) return;
    scenarioId = chosen;
  }

  mode = next;
  CFG.scenarioId = scenarioId;
  changeset.ops = [];
  changeset.configure({
    target: mode === "scenario" ? "scenario" : "corrections",
    storageKey: storageKeyFor({ ...CFG, mode, scenarioId }),
    snapshotId: CFG.snapshotId,
  });
  pushModeToUrl();
  applyModeChrome();
  await loadForMode();
}

function pickScenario() {
  const list = (CFG.scenarios || []);
  return new Promise(resolve => {
    const body = list.length
      ? '<div class="oc-field"><label for="oc-sc-pick">Scenario</label><select id="oc-sc-pick">'
        + list.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")
        + '</select></div>'
      : '<p style="color:var(--text-muted);font-size:0.85rem;">'
        + 'No scenarios yet — create one to model a reorg.</p>';
    openModal({
      narrow: true,
      title: "Open a scenario",
      body,
      buttons: [
        { label: "Cancel", cls: "btn-secondary", value: null },
        list.length ? { label: "Open", cls: "btn-primary", value: "open" } : null,
        { label: "New scenario…", cls: "btn-secondary", value: "new" },
      ].filter(Boolean),
      onClose(value, root) {
        if (value === "open") {
          resolve(root.querySelector("#oc-sc-pick").value);
        } else if (value === "new") {
          window.location.href = CFG.scenarioListUrl;
          resolve(null);
        } else resolve(null);
      },
    });
  });
}

/* ══════════════════════════════════════════════════════════════════
   Loading
   ══════════════════════════════════════════════════════════════════ */

chart.hooks.treeUrl = () => {
  if (mode === "scenario" && scenarioId) {
    return chart.API_BASE + "/scenarios/" + scenarioId + "/org-tree/";
  }
  return chart.API_BASE + "/org-tree/?snapshot_id=" + chart.getSnapshotId();
};

chart.hooks.onTreeLoaded = data => {
  captureBaseRows(data.tree);
  if (data.scenario_name) CFG.scenarioName = data.scenario_name;
  if (data.base_snapshot_id) CFG.snapshotId = data.base_snapshot_id;
  if (data.summary) scenarioSummary = data.summary;
  if ($cycleWarn) {
    const cycles = data.cycles || [];
    $cycleWarn.hidden = !cycles.length;
    if (cycles.length) {
      $cycleWarn.querySelector(".oc-banner-text").textContent =
        `${cycles.length} circular reporting loop(s) in this census — those branches are `
        + `drawn only as far as the loop. Fix them in Correct mode.`;
    }
  }
};

chart.hooks.cardClass = node => {
  const classes = [];
  if (isEditing() && changeset.forEmployee(node.employee_id)) classes.push("oc-card-dirty");
  if (node.employee_id === selectedId) classes.push("oc-card-selected");
  if (node.is_vacant) classes.push("oc-card-vacant");
  return classes.join(" ");
};

chart.hooks.decorateCard = node => {
  if (!isEditing()) return "";
  const ops = changeset.allForEmployee(node.employee_id);
  if (!ops.length) return "";
  return ops.map(o => {
    const b = OP_BADGE[o.op];
    return b ? `<span class="badge ${b.cls}">${b.label}</span>` : "";
  }).join("");
};

chart.hooks.onCardClick = (eid, node, e) => {
  if (!isEditing()) return false;
  // Collapse stays reachable through the footer toggle; everything else selects.
  if (e.target.closest(".oc-expand-toggle")) {
    chart.toggleCollapse(eid);
    return true;
  }
  openPanel(eid);
  return true;
};

async function loadForMode() {
  await chart.loadTree();
  if (mode === "correct") {
    await Promise.all([refreshUnattached(), refreshCorrectionStats()]);
  } else if (mode === "scenario") {
    unattached = { orphans: [], excluded: [], counts: {} };
  }
  rerender();
  offerRecovery();
}

let trayAutoExpanded = false;

async function refreshUnattached() {
  const r = await api("/unattached/");
  if (r.ok && r.data) unattached = r.data;
  // Auto-expand on first load when there is a problem — the tray is the only
  // place these people exist, so a collapsed tray hides the whole issue.
  if (!trayAutoExpanded && (unattached.counts || {}).orphans > 0) {
    trayAutoExpanded = true;
    trayCollapsed = false;
  }
}

async function refreshCorrectionStats() {
  const r = await api("/corrections/");
  if (!r.ok || !r.data) return;
  const rows = r.data.corrections.filter(c => c.is_active);
  correctionStats = {
    active: rows.length,
    needsReview: rows.filter(c => ["drifted", "conflict"].includes(c.replay_status)).length,
  };
}

/* ══════════════════════════════════════════════════════════════════
   Summary strip
   ══════════════════════════════════════════════════════════════════ */

function tile({ label, value, sub, cls, action }) {
  const tag = action ? "button" : "div";
  const attrs = action ? ` type="button" data-tile="${action}"` : "";
  return `<${tag} class="oc-tile ${cls || ""}"${attrs}>`
    + `<span class="oc-tile-label">${esc(label)}</span>`
    + `<span class="oc-tile-value">${value}</span>`
    + (sub ? `<span class="oc-tile-sub">${sub}</span>` : "")
    + `</${tag}>`;
}

function renderSummaryStrip() {
  if (!isEditing()) { $strip.innerHTML = ""; return; }
  $strip.innerHTML = mode === "correct" ? correctStrip() : scenarioStrip();
}

function correctStrip() {
  const c = unattached.counts || {};
  const total = c.total_employees || 0;
  const rendered = c.rendered || 0;
  const gap = total - rendered - (c.excluded || 0);
  // The most important number in this redesign: it is how someone learns their
  // data has a problem at all.
  return [
    tile({
      label: "On chart",
      value: `${rendered.toLocaleString()} of ${total.toLocaleString()}`,
      cls: gap > 0 ? "alert" : "good",
      sub: gap > 0 ? `${gap} not drawn` : "all accounted for",
    }),
    tile({
      label: "Unattached", value: String(c.orphans || 0),
      cls: (c.orphans || 0) > 0 ? "alert" : "", action: "tray",
    }),
    tile({ label: "Excluded", value: String(c.excluded || 0), action: "excluded" }),
    tile({
      label: "Saved corrections", value: String(correctionStats.active),
      sub: correctionStats.needsReview
        ? `${correctionStats.needsReview} need review` : "all applied",
      cls: correctionStats.needsReview ? "alert" : "",
      action: "corrections",
    }),
  ].join("");
}

function scenarioStrip() {
  const s = scenarioSummary;
  const dirty = changeset.isDirty();
  const root = chart.fullTree && (Array.isArray(chart.fullTree) ? chart.fullTree[0] : chart.fullTree);
  const live = root ? root.metrics : {};
  const mark = dirty ? '<span class="oc-estimated">~</span>' : "";

  function metric(label, now, was, invertGood) {
    let delta = "";
    if (was != null && now != null) {
      const d = now - was;
      const cls = d === 0 ? "flat" : ((d > 0) === !invertGood ? "up" : "down");
      delta = `<span class="oc-delta ${cls}">${d > 0 ? "+" : ""}${round(d)}</span>`;
    }
    return tile({
      label, value: mark + (now == null ? "—" : round(now)),
      sub: was == null ? "" : `was ${round(was)} ${delta}`,
    });
  }

  const parts = [
    metric("Headcount", live.headcount, s && s.baseline.headcount, true),
    metric("Layers", live.num_layers != null ? live.num_layers + 1 : null,
           s && s.baseline.layers, true),
    metric("Avg span", live.avg_span_of_control, s && s.baseline.avg_span, false),
  ];
  if (CFG.canSeePay) {
    parts.push(tile({
      label: "Total loaded cost",
      value: mark + fmtMoney(live.total_labor_cost),
      sub: s ? `was ${fmtMoney(s.baseline.total_cost)}` : "",
    }));
    if (s && s.totals && s.totals.investment != null) {
      parts.push(tile({ label: "Investment", value: "+" + fmtMoney(s.totals.investment) }));
      parts.push(tile({ label: "Savings", value: "−" + fmtMoney(s.totals.savings) }));
      const net = s.totals.net;
      parts.push(tile({
        label: "Net annual impact",
        value: (net > 0 ? "+" : net < 0 ? "−" : "") + fmtMoney(Math.abs(net)),
        sub: net > 0 ? "net investment" : net < 0 ? "net savings" : "cost-neutral",
        cls: net > 0 ? "alert" : net < 0 ? "good" : "",
      }));
    }
  }
  return parts.join("");
}

function round(n) {
  if (n == null) return "—";
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

if ($strip) {
  $strip.addEventListener("click", e => {
    const b = e.target.closest("[data-tile]");
    if (!b) return;
    if (b.dataset.tile === "corrections") window.location.href = CFG.correctionsUrl;
    else { trayCollapsed = false; renderTray(); }
  });
}

/* ══════════════════════════════════════════════════════════════════
   Unattached tray
   ══════════════════════════════════════════════════════════════════ */

function attachedIds() {
  const set = new Set();
  for (const op of changeset.ops) {
    if (op.op === "reparent" || op.op === "set_root") set.add(op.employee_id);
  }
  return set;
}

function renderTray() {
  if (!$tray || mode !== "correct") return;
  const attached = attachedIds();
  const orphans = (unattached.orphans || []).filter(o => !attached.has(o.employee_id));
  const c = unattached.counts || {};
  const total = c.total_employees || 0;
  const rendered = c.rendered || 0;

  const groups = {};
  for (const o of orphans) (groups[o.reason] = groups[o.reason] || []).push(o);

  let body = "";
  const censusOk = total === rendered;
  body += `<div class="oc-tray-census${censusOk ? " good" : ""}">`
        + (censusOk
            ? `all <strong>${total.toLocaleString()}</strong> on chart`
            : `${total.toLocaleString()} in census · <strong>${rendered.toLocaleString()}</strong> on chart`)
        + `</div>`;

  if (orphans.length && !calloutDismissed) {
    body += `<div class="oc-tray-callout">`
          + `${orphans.length} ${orphans.length === 1 ? "person isn't" : "people aren't"} on the chart `
          + `because their manager isn't in this census. Drag them onto a manager to fix.`
          + `<br><button type="button" data-tray="dismiss-callout">Dismiss</button></div>`;
  }

  for (const [reason, rows] of Object.entries(groups)) {
    body += `<div class="oc-tray-group">${esc(rows[0].reason_label || reason)}</div>`;
    for (const o of rows) {
      body += `<div class="oc-tray-row" data-tray-eid="${esc(o.employee_id)}">`
            + `<div class="oc-tray-name">⠿ ${esc(o.full_name)}</div>`
            + `<div class="oc-tray-title2">${esc(o.job_title || "—")}</div>`;
      if (o.reason === "supervisor_not_found") {
        body += `<div class="oc-tray-warn">⚠ supervisor ${esc(o.raw_supervisor_id)} not found</div>`;
      } else if (o.reason === "extra_root") {
        body += `<div class="oc-tray-warn">⚠ no supervisor listed</div>`;
      }
      if (o.subtree_count > 0) {
        body += `<div class="oc-tray-sub">+ ${o.subtree_count} below — moves together</div>`;
      }
      body += `</div>`;
    }
  }

  if (!orphans.length) {
    body += `<div style="color:var(--text-muted);font-size:0.74rem;padding:0.4rem 0.1rem;">`
          + `Nothing needs attention.</div>`;
  }

  const excluded = unattached.excluded || [];
  if (excluded.length) {
    body += `<div class="oc-tray-group">Excluded (${excluded.length})</div>`;
    for (const x of excluded) {
      body += `<div class="oc-tray-row" style="cursor:default;">`
            + `<div class="oc-tray-name">${esc(x.full_name)}</div>`
            + `<div class="oc-tray-title2">${esc(x.job_title || "—")}</div>`
            + `<button type="button" class="btn btn-secondary btn-xs" style="margin-top:0.3rem;"`
            + ` data-unexclude="${esc(x.employee_id)}">Un-exclude</button></div>`;
    }
  }

  $tray.classList.toggle("collapsed", trayCollapsed);
  $tray.innerHTML =
    `<div class="oc-tray-head" data-tray="toggle">`
    + `<span class="oc-tray-title">Unattached</span>`
    + `<span class="oc-tray-badge${orphans.length ? "" : " zero"}">${orphans.length}</span>`
    + `<span style="margin-left:auto;color:var(--text-muted);">${trayCollapsed ? "▸" : "◂"}</span>`
    + `</div><div class="oc-tray-body">${body}</div>`;
}

if ($tray) {
  $tray.addEventListener("click", e => {
    if (e.target.closest('[data-tray="toggle"]')) {
      trayCollapsed = !trayCollapsed;
      renderTray();
      return;
    }
    if (e.target.closest('[data-tray="dismiss-callout"]')) {
      calloutDismissed = true;
      renderTray();
      return;
    }
    const un = e.target.closest("[data-unexclude]");
    if (un) { unexclude(un.dataset.unexclude); return; }
    const row = e.target.closest("[data-tray-eid]");
    if (row) openPanel(row.dataset.trayEid);
  });

  $tray.addEventListener("pointerdown", e => {
    const row = e.target.closest("[data-tray-eid]");
    if (!row || !dragLayer) return;
    dragLayer.beginFromTray(e, row.dataset.trayEid, row);
  });
}

async function unexclude(eid) {
  const r = await api("/corrections/");
  if (!r.ok) return;
  const row = r.data.corrections.find(c => c.employee_id === eid && c.kind === "exclude" && c.is_active);
  if (!row) { toast("No active exclusion found for that row.", "err"); return; }
  const rev = await api(`/corrections/${row.id}/revert/`, { body: "{}" });
  if (!rev.ok) { toast("Couldn't un-exclude that row.", "err"); return; }
  toast("Un-excluded.", "ok");
  await loadForMode();
}

/* ══════════════════════════════════════════════════════════════════
   Side panel
   ══════════════════════════════════════════════════════════════════ */

function nodeFor(eid) {
  return findNodeIn(chart.fullTree, eid)
      || (unattached.orphans || []).map(orphanRow).find(n => n.employee_id === eid)
      || null;
}

function datalistFor(field) {
  const values = new Set();
  for (const n of chart.flattenTree(chart.fullTree)) {
    const v = (n[field] || "").trim();
    if (v) values.add(v);
  }
  if (!values.size) return "";
  return `<datalist id="dl-${field}">`
       + [...values].sort().map(v => `<option value="${esc(v)}"></option>`).join("")
       + `</datalist>`;
}

function openPanel(eid) {
  const node = nodeFor(eid);
  if (!node) return;
  selectedId = eid;

  const parent = findParentIn(chart.fullTree, eid);
  const staged = changeset.allForEmployee(eid);
  const fields = whitelist();

  let html = `<div class="oc-panel-head">`
    + `<button class="oc-panel-close" type="button" aria-label="Close">&times;</button>`
    + `<div class="oc-panel-name">${esc(node.full_name)}</div>`
    + `<div class="oc-panel-sub">${esc(node.job_title || "—")} · ${esc(eid)}</div>`
    + `<div class="oc-panel-sub">Reports to: `
    + (parent
        ? `<a data-goto="${esc(parent.employee_id)}">${esc(parent.full_name)}</a>`
        : node._orphan
          ? `<span style="color:var(--danger);">${esc(node._reason_label || "not on the chart")}</span>`
          : "nobody (top of org)")
    + `</div>`
    + (staged.length
        ? `<div class="oc-card-badges">` + staged.map(o => {
            const b = OP_BADGE[o.op];
            return b ? `<span class="badge ${b.cls}">${b.label}</span>` : "";
          }).join("") + `</div>`
        : "")
    + `</div><div class="oc-panel-body">`;

  html += `<div class="oc-panel-section">Reports to</div>`
    + `<div class="oc-field oc-typeahead-wrap">`
    + `<input type="text" id="oc-ta" placeholder="Search for a manager…" autocomplete="off">`
    + `<div class="oc-typeahead-results" id="oc-ta-res"></div></div>`
    + `<button class="btn btn-secondary btn-xs" type="button" data-act="set-root">Make top of org</button>`;

  html += `<div class="oc-panel-section">Attributes</div>`;
  html += `<div class="oc-field-grid">`;
  for (const [f, label] of fields) {
    const listAttr = DATALIST_FIELDS.includes(f) ? ` list="dl-${f}"` : "";
    const current = currentValue(node, f, staged);
    html += `<div class="oc-field"><label for="fld-${f}">${esc(label)}</label>`
          + `<input id="fld-${f}" data-field="${f}"${listAttr} value="${esc(current)}"></div>`;
  }
  html += `</div>`;
  html += DATALIST_FIELDS.map(datalistFor).join("");

  if (mode === "scenario") {
    html += `<div class="oc-field"><label>`
          + `<input type="checkbox" id="fld-vacant" ${node.is_vacant ? "checked" : ""}> `
          + `Vacant / to-be-hired</label></div>`;
    html += `<button class="btn btn-secondary btn-xs" type="button" data-act="add-report">+ Add report</button>`;
  }

  html += `<div class="oc-panel-section">Note</div>`
    + `<div class="oc-field"><textarea id="fld-note" rows="2" `
    + `placeholder="Why this change?">${esc(staged[0] ? staged[0].note || "" : "")}</textarea></div>`;

  if (mode === "correct") {
    // Loaded on demand — when you're deciding whether a supervisor id is a typo,
    // the original imported row is exactly what you want to see.
    html += `<details class="oc-rawdata" id="oc-rawdata">`
          + `<summary>Data source (as imported)</summary>`
          + `<div class="oc-rawdata-body" style="color:var(--text-muted);">Loading…</div>`
          + `</details>`;
  }

  html += `<div class="oc-danger-zone">`;
  if (mode === "correct") {
    html += `<p>Removes this row from the chart without deleting it. Use for duplicate `
          + `rows or ghost records in the payroll export. Reversible from the Excluded list.</p>`
          + `<button class="btn btn-danger btn-xs" type="button" data-act="exclude">Exclude from chart</button>`;
  } else {
    const kids = (node.children || []).length;
    html += `<p>Eliminate this position?${kids ? ` Its ${kids} direct report(s) will move up `
          + `to report to ${esc(parent ? parent.full_name : "nobody")}.` : ""} `
          + `This is staged — you can remove it from the review list before saving.</p>`
          + `<button class="btn btn-danger btn-xs" type="button" data-act="eliminate">Eliminate position</button>`;
  }
  html += `</div></div>`;

  html += `<div class="oc-panel-foot">`
    + `<span class="oc-panel-hint">Changes are staged until you press Save.</span>`
    + `<button class="btn btn-secondary btn-sm" type="button" data-act="cancel">Cancel</button>`
    + `<button class="btn btn-primary btn-sm" type="button" data-act="apply">Apply</button>`
    + `</div>`;

  $panel.innerHTML = html;
  $panel.hidden = false;
  $panel.setAttribute("role", "dialog");
  $panel.setAttribute("aria-label", "Edit " + node.full_name);
  wirePanel(eid, node, fields);
  rerenderCards();
  const first = $panel.querySelector("input, textarea");
  if (first) first.focus();
}

function currentValue(node, field, staged) {
  const attr = staged.find(o => o.op === "attribute");
  if (attr && field in attr.after) return attr.after[field] ?? "";
  if (field === "annual_salary" || field === "fully_loaded_cost") {
    return node[field] ?? "";
  }
  return node[field] ?? "";
}

function closePanel() {
  if (!$panel) return;
  $panel.hidden = true;
  $panel.innerHTML = "";
  const wasSelected = selectedId;
  selectedId = null;
  if (wasSelected) rerenderCards();
}

function rerenderCards() {
  if (chart.viewRoot) chart.renderTree();
}

function wirePanel(eid, node, fields) {
  $panel.querySelector(".oc-panel-close").addEventListener("click", closePanel);

  $panel.addEventListener("click", e => {
    const goto = e.target.closest("[data-goto]");
    if (goto) { chart.navigateToEmployee(goto.dataset.goto); return; }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "cancel") return closePanel();
    if (act === "apply") return applyPanel(eid, node, fields);
    if (act === "set-root") return stageSetRoot(eid, node);
    if (act === "exclude") return typedConfirm(
      `Exclude ${node.full_name} from the chart?`, "EXCLUDE",
      () => { stage({ op: "exclude", employee_id: eid, after: {}, note: noteValue() }); closePanel(); });
    if (act === "eliminate") return typedConfirm(
      `Eliminate ${node.full_name}'s position?`, "ELIMINATE",
      () => { stage({ op: "eliminate", employee_id: eid, after: {}, note: noteValue() }); closePanel(); });
    if (act === "add-report") return stageAdd(eid);
  });

  $panel.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.stopPropagation(); closePanel(); }
  });

  wireTypeahead(eid, node);
  wireRawData(eid);
}

function wireRawData(eid) {
  const details = $panel.querySelector("#oc-rawdata");
  if (!details) return;
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    loaded = true;
    const body = details.querySelector(".oc-rawdata-body");
    const r = await api(`/employees/${encodeURIComponent(eid)}/raw/`);
    const raw = (r.data && r.data.raw_data) || {};
    const entries = Object.entries(raw);
    body.innerHTML = entries.length
      ? `<table><tbody>` + entries.map(([k, v]) =>
          `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("") + `</tbody></table>`
      : `<span style="color:var(--text-muted);">No source row stored for this person.</span>`;
  });
}

function noteValue() {
  const t = $panel.querySelector("#fld-note");
  return t ? t.value.trim() : "";
}

function applyPanel(eid, node, fields) {
  const after = {};
  for (const [f] of fields) {
    const input = $panel.querySelector(`[data-field="${f}"]`);
    if (!input) continue;
    const val = input.value;
    if (String(node[f] ?? "") !== String(val)) after[f] = val;
  }
  if (mode === "scenario") {
    const vac = $panel.querySelector("#fld-vacant");
    if (vac && !!node.is_vacant !== vac.checked) after.is_vacant = vac.checked;
  }
  if (Object.keys(after).length) {
    const before = {};
    for (const k of Object.keys(after)) before[k] = node[k] ?? "";
    stage({ op: "attribute", employee_id: eid, after, _before: before, note: noteValue() });
  }
  closePanel();
}

function stageSetRoot(eid, node) {
  const below = Math.max(0, (node.metrics && node.metrics.headcount || 1) - 1);
  confirmModal({
    title: "Make top of org?",
    body: `Make ${node.full_name} the top of the organization?`
        + (below ? ` They and their ${below} report(s) will no longer roll up to anyone.` : ""),
    confirmLabel: "Make top of org",
  }).then(v => {
    if (v !== "confirm") return;
    stage({
      op: "set_root", employee_id: eid, after: {},
      _before: { raw_supervisor_id: node.raw_supervisor_id ?? null },
      note: noteValue(),
    });
    closePanel();
  });
}

function stageAdd(supervisorId) {
  const tmp = changeset.nextTempId();
  stage({
    op: "add", employee_id: tmp,
    after: { raw_supervisor_id: supervisorId, is_vacant: true, job_title: "New position" },
    note: "",
  });
  closePanel();
  toast("Vacant position staged — click it to fill in the details.");
}

/* ── Typeahead over api_employee_search ──────────────────────────── */
function wireTypeahead(eid, node) {
  const input = $panel.querySelector("#oc-ta");
  const res = $panel.querySelector("#oc-ta-res");
  if (!input) return;
  let timer = null;
  // Exclude the subject and its descendants client-side, so an invalid move
  // simply can't be selected.
  const bad = invalidTargetsFor(chart.fullTree, eid);
  const branch = CFG.branchRootId;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { res.classList.remove("open"); return; }
    timer = setTimeout(async () => {
      const r = await api("/employees/search/?q=" + encodeURIComponent(q) + "&limit=10");
      const rows = (r.data || []).filter(x => !bad.has(x.employee_id));
      res.innerHTML = rows.length
        ? rows.map(x => `<div class="oc-typeahead-item" data-pick="${esc(x.employee_id)}">`
            + `<div>${esc(x.full_name)}</div>`
            + `<div class="ta-title">${esc(x.job_title || "")} · ${esc(x.employee_id)}</div></div>`).join("")
        : `<div class="oc-typeahead-item" style="color:var(--text-muted);">No valid matches</div>`;
      res.classList.add("open");
    }, 200);
  });

  res.addEventListener("click", e => {
    const item = e.target.closest("[data-pick]");
    if (!item) return;
    const target = item.dataset.pick;
    if (branch) {
      // Mirror the server check so the UI can't offer what the API will reject.
      if (!branchMembers(chart.fullTree, branch).has(target)) {
        toast("That manager is outside the part of the org you can edit.", "err");
        return;
      }
    }
    res.classList.remove("open");
    stage({
      op: "reparent", employee_id: eid, after: { raw_supervisor_id: target },
      _before: { raw_supervisor_id: node.raw_supervisor_id ?? null },
      note: noteValue(),
    });
    closePanel();
    chart.expandNode(target);
    rerender();
    chart.navigateToEmployee(eid);
  });
}

/* ══════════════════════════════════════════════════════════════════
   Staging + save bar
   ══════════════════════════════════════════════════════════════════ */

function stage(op) {
  changeset.add(op);
  rerender();
}

function renderSaveBar() {
  if (!$saveBar) return;
  const n = changeset.count();
  const dirty = n > 0;
  $saveCount.className = "oc-save-count" + (dirty ? " dirty" : "");
  $saveCount.innerHTML = dirty
    ? `<span class="dot">●</span>${n} unsaved change${n === 1 ? "" : "s"}`
    : "No changes yet";
  $btnReview.disabled = !dirty;
  $btnSave.disabled = !dirty;
  $btnDiscard.disabled = !dirty;
}

changeset.subscribe(() => { renderSaveBar(); });

if ($btnReview) $btnReview.addEventListener("click", () => openReview());
if ($btnDiscard) $btnDiscard.addEventListener("click", () => {
  typedConfirm(`Discard all ${changeset.count()} staged change(s)?`, "DISCARD", async () => {
    changeset.clear();
    changeset.discardStored();
    await loadForMode();
  });
});
if ($btnSave) $btnSave.addEventListener("click", () => save());

window.addEventListener("beforeunload", e => {
  if (!changeset.isDirty()) return;
  e.preventDefault();
  e.returnValue = "You have unsaved changes to the org chart.";
  return e.returnValue;
});

async function save() {
  if (!changeset.isDirty()) return false;
  $btnSave.disabled = true;
  const original = $btnSave.textContent;
  $btnSave.textContent = "Saving…";
  try {
    const r = await api("/changeset/commit/", {
      body: JSON.stringify({
        target: changeset.target,
        scenario_id: scenarioId,
        expected_snapshot_id: CFG.snapshotId,
        ops: changeset.payload(),
      }),
    });

    if (r.status === 200) {
      const n = changeset.count();
      changeset.replaceIds(r.data.id_map);
      changeset.clear();
      changeset.discardStored();
      chart.setTree(r.data.tree);
      captureBaseRows(r.data.tree);
      if (mode === "scenario") scenarioSummary = r.data.summary;
      else { unattached = r.data.summary; await refreshCorrectionStats(); }
      rerender();
      toast(`Saved ${n} change${n === 1 ? "" : "s"}.`, "ok");
      return true;
    }
    if (r.status === 422) {
      // Never discard the user's work on a validation failure.
      openReview(r.data.errors || []);
      toast("Some changes were rejected — see the review list.", "err");
      return false;
    }
    if (r.status === 409) {
      openStaleModal();
      return false;
    }
    if (r.status === 403) {
      toast("You no longer have edit access — dropping to view mode.", "err");
      await switchMode("view");
      return false;
    }
    toast((r.data && r.data.error) || "Save failed.", "err");
    return false;
  } catch (err) {
    toast("Couldn't reach the server — your changes are still here.", "err");
    return false;
  } finally {
    $btnSave.textContent = original;
    renderSaveBar();
  }
}

function openStaleModal() {
  openModal({
    narrow: true,
    title: "This census was replaced while you were editing",
    body: "<p>Someone uploaded a new census, so these changes can't be applied to it. "
        + "Download them first if you want to redo them against the new data.</p>",
    buttons: [
      { label: "Download changes as CSV", cls: "btn-secondary", value: "csv", keepOpen: true },
      { label: "Reload", cls: "btn-primary", value: "reload" },
    ],
    onClose(v) {
      if (v === "csv") downloadChangesetCsv();
      else if (v === "reload") window.location.reload();
    },
    onButton(v) { if (v === "csv") downloadChangesetCsv(); },
  });
}

function downloadChangesetCsv() {
  const rows = [["op", "employee_id", "detail", "note"]];
  for (const op of changeset.ops) {
    rows.push([op.op, op.employee_id, JSON.stringify(op.after || {}), op.note || ""]);
  }
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `orgview-unsaved-changes-${CFG.companySlug}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════════════════════════════
   Review / diff modal — this is the undo mechanism
   ══════════════════════════════════════════════════════════════════ */

function describe(op) {
  const node = nodeFor(op.employee_id) || {};
  switch (op.op) {
    case "reparent": {
      const from = (op._before || {}).raw_supervisor_id;
      const to = op.after.raw_supervisor_id;
      return `reports to ${nameOf(from) || "nobody"} → ${nameOf(to) || to}`;
    }
    case "set_root":
      return `reports to ${nameOf((op._before || {}).raw_supervisor_id) || "nobody"} → top of org`;
    case "attribute":
      return Object.entries(op.after).map(([k, v]) => {
        const was = (op._before || {})[k];
        return `${k}: "${was ?? ""}" → "${v ?? ""}"`;
      }).join("; ");
    case "exclude":   return "removed from the chart (row kept, reversible)";
    case "eliminate": return "position eliminated; reports move up a level";
    case "add":       return `new ${op.after.is_vacant === false ? "" : "vacant "}position under `
                           + `${nameOf(op.after.raw_supervisor_id) || "nobody"}`;
    default:          return "";
  }
}

function nameOf(eid) {
  if (!eid) return "";
  const n = nodeFor(eid);
  return n ? `${n.full_name} (${eid})` : eid;
}

async function openReview(presetErrors) {
  let errors = presetErrors;
  if (!errors) {
    // Surface problems before the user commits, not after.
    const r = await api("/changeset/validate/", {
      body: JSON.stringify({
        target: changeset.target, scenario_id: scenarioId, ops: changeset.payload(),
      }),
    });
    errors = (r.data && r.data.errors) || [];
  }
  const byIndex = new Map(errors.map(e => [e.index, e.error]));

  function body() {
    const groups = changeset.grouped();
    if (!groups.length) return '<p style="color:var(--text-muted);">Nothing staged.</p>';
    let html = '<table class="oc-diff-table"><thead><tr>'
      + '<th>Change</th><th>Position</th><th>Detail</th><th>Note</th><th></th>'
      + '</tr></thead><tbody>';
    for (const g of groups) {
      html += `<tr><td class="oc-diff-group" colspan="5">${esc(g.title)}</td></tr>`;
      for (const { op, index } of g.rows) {
        const b = OP_BADGE[op.op];
        const err = byIndex.get(index);
        html += `<tr class="${err ? "invalid" : ""}">`
          + `<td><span class="badge ${b.cls}">${b.label}</span></td>`
          + `<td>${esc(nameOf(op.employee_id) || op.employee_id)}</td>`
          + `<td>${esc(describe(op))}`
          + (err ? `<span class="oc-diff-error">${esc(err)}</span>` : "") + `</td>`
          + `<td><input class="oc-diff-note" data-note-index="${index}" `
          + `value="${esc(op.note || "")}" placeholder="why?"></td>`
          + `<td><button class="btn btn-danger btn-xs" data-remove-index="${index}">Remove</button></td>`
          + `</tr>`;
      }
    }
    html += "</tbody></table>";
    if (mode === "scenario" && CFG.canSeePay && scenarioSummary && scenarioSummary.totals) {
      const t = scenarioSummary.totals;
      html += `<p style="margin-top:0.8rem;font-size:0.85rem;">`
            + `Investment <strong>+${fmtMoney(t.investment)}</strong> · `
            + `Savings <strong>−${fmtMoney(t.savings)}</strong> · `
            + `Net <strong>${fmtMoney(t.net)}</strong> `
            + `<span style="color:var(--text-muted);">(as last saved)</span></p>`;
    }
    return html;
  }

  openModal({
    title: `Review ${changeset.count()} staged change${changeset.count() === 1 ? "" : "s"}`,
    body: body(),
    buttons: [
      { label: "Close", cls: "btn-secondary", value: null },
      { label: "Save changes", cls: "btn-primary", value: "save" },
    ],
    onMount(root) {
      root.addEventListener("click", e => {
        const rm = e.target.closest("[data-remove-index]");
        if (!rm) return;
        changeset.removeAt(parseInt(rm.dataset.removeIndex, 10));
        rerender();
        // Indices shift, so the flagged rows are no longer trustworthy.
        byIndex.clear();
        root.querySelector(".oc-modal-body").innerHTML = body();
      });
      root.addEventListener("change", e => {
        const note = e.target.closest("[data-note-index]");
        if (!note) return;
        const op = changeset.ops[parseInt(note.dataset.noteIndex, 10)];
        if (op) { op.note = note.value; changeset.persist(); }
      });
    },
    onClose(v) { if (v === "save") save(); },
  });
}

/* ══════════════════════════════════════════════════════════════════
   Modals
   ══════════════════════════════════════════════════════════════════ */

function openModal({ title, body, buttons, narrow, onMount, onClose, onButton }) {
  const root = document.createElement("div");
  root.className = "oc-modal-backdrop";
  root.innerHTML =
    `<div class="oc-modal${narrow ? " narrow" : ""}" role="dialog" aria-modal="true">`
    + `<div class="oc-modal-head"><h2>${esc(title)}</h2></div>`
    + `<div class="oc-modal-body">${body}</div>`
    + `<div class="oc-modal-foot"><span class="spacer"></span>`
    + (buttons || []).map((b, i) =>
        `<button class="btn ${b.cls} btn-sm" data-mb="${i}">${esc(b.label)}</button>`).join("")
    + `</div></div>`;
  $modalHost.appendChild(root);

  function close(value) {
    root.remove();
    document.removeEventListener("keydown", onKey, true);
    if (onClose) onClose(value, root);
  }
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); close(null); }
    if (e.key === "Tab") trapFocus(e, root);
  }
  root.addEventListener("click", e => {
    const b = e.target.closest("[data-mb]");
    if (b) {
      const spec = buttons[parseInt(b.dataset.mb, 10)];
      if (spec.keepOpen) { if (onButton) onButton(spec.value, root); return; }
      close(spec.value);
      return;
    }
    if (e.target === root) close(null);
  });
  document.addEventListener("keydown", onKey, true);
  if (onMount) onMount(root);
  const first = root.querySelector("input, select, textarea, button");
  if (first) first.focus();
  return { close };
}

function trapFocus(e, root) {
  const focusable = root.querySelectorAll(
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function confirmModal({ title, body, confirmLabel, extraLabel }) {
  return new Promise(resolve => {
    openModal({
      narrow: true, title, body: `<p>${esc(body)}</p>`,
      buttons: [
        { label: "Cancel", cls: "btn-secondary", value: "cancel" },
        extraLabel ? { label: extraLabel, cls: "btn-secondary", value: "extra" } : null,
        { label: confirmLabel || "Confirm", cls: "btn-primary", value: "confirm" },
      ].filter(Boolean),
      onClose(v) { resolve(v || "cancel"); },
    });
  });
}

/** A typed confirm, not a bare confirm() — these actions are consequential. */
function typedConfirm(question, word, onYes) {
  openModal({
    narrow: true,
    title: question,
    body: `<p>Type <strong>${word}</strong> to confirm.</p>`
        + `<div class="oc-field"><input id="oc-confirm-word" autocomplete="off"></div>`,
    buttons: [
      { label: "Cancel", cls: "btn-secondary", value: null },
      { label: "Confirm", cls: "btn-danger", value: "yes" },
    ],
    onClose(v, root) {
      if (v !== "yes") return;
      const typed = (root.querySelector("#oc-confirm-word") || {}).value || "";
      if (typed.trim().toUpperCase() === word) onYes();
      else toast("Not confirmed — the word didn't match.", "err");
    },
  });
}

/* ══════════════════════════════════════════════════════════════════
   sessionStorage recovery
   ══════════════════════════════════════════════════════════════════ */

function offerRecovery() {
  if (!$recovery || !isEditing() || changeset.isDirty()) return;
  const stored = changeset.peekStored();
  if (!stored) { $recovery.hidden = true; return; }

  $recovery.hidden = false;
  $recovery.innerHTML =
    `<span class="oc-banner-text">You have ${stored.ops.length} unsaved change(s) from a `
    + `previous session.` + (stored.stale
        ? " They were made against a different census, so they can't be restored." : "")
    + `</span><span class="spacer"></span>`
    + (stored.stale ? "" : `<button class="btn btn-primary btn-xs" data-rec="restore">Restore</button>`)
    + `<button class="btn btn-secondary btn-xs" data-rec="discard">Discard</button>`;

  $recovery.onclick = e => {
    const b = e.target.closest("[data-rec]");
    if (!b) return;
    if (b.dataset.rec === "restore") { changeset.restore(stored.ops); rerender(); }
    else changeset.discardStored();
    $recovery.hidden = true;
  };
}

/* ══════════════════════════════════════════════════════════════════
   Drag layer wiring
   ══════════════════════════════════════════════════════════════════ */

function orphanCluster(eid) {
  const o = (unattached.orphans || []).find(x => x.employee_id === eid);
  return o ? o.subtree_count || 0 : 0;
}

function installDrag() {
  dragLayer = installDragLayer({
    viewport: $viewport,
    container: $container,
    getTree: () => chart.fullTree,
    isEditing,
    branchRootId: () => CFG.branchRootId,
    getPan: chart.getPan,
    setPan: chart.setPan,
    applyTransform: chart.applyTransform,
    hideConnectors: chart.hideConnectors,
    drawConnectors: chart.drawConnectors,
    subtreeCount: id => {
      const n = findNodeIn(chart.fullTree, id);
      return n ? Math.max(0, (n.metrics.headcount || 1) - 1) : 0;
    },
    traySubtreeCount: orphanCluster,
    trayNodeFor: id => (unattached.orphans || []).find(o => o.employee_id === id) || { full_name: id },
    onReparent(draggedId, targetId) {
      const node = nodeFor(draggedId);
      stage({
        op: "reparent", employee_id: draggedId,
        after: { raw_supervisor_id: targetId },
        _before: { raw_supervisor_id: node ? node.raw_supervisor_id ?? null : null },
      });
      // Expand the target so the user sees where the person landed.
      chart.expandNode(targetId);
      rerender();
      chart.navigateToEmployee(draggedId);
    },
    onSetRoot(draggedId) {
      const node = nodeFor(draggedId);
      if (!node) return;
      stageSetRootFromDrag(draggedId, node);
    },
  });
}

function stageSetRootFromDrag(eid, node) {
  const below = Math.max(0, (node.metrics && node.metrics.headcount || 1) - 1);
  confirmModal({
    title: "Make top of org?",
    body: `Make ${node.full_name} the top of the organization?`
        + (below ? ` They and their ${below} report(s) will no longer roll up to anyone.` : ""),
    confirmLabel: "Make top of org",
  }).then(v => {
    if (v !== "confirm") return;
    stage({
      op: "set_root", employee_id: eid, after: {},
      _before: { raw_supervisor_id: node.raw_supervisor_id ?? null },
    });
  });
}

/* ══════════════════════════════════════════════════════════════════
   Boot
   ══════════════════════════════════════════════════════════════════ */

async function boot() {
  if (!chart.isReady) return;
  chart.init();

  if ($modeSwitch) {
    $modeSwitch.addEventListener("click", e => {
      const b = e.target.closest(".oc-mode-btn");
      if (b) switchMode(b.dataset.mode);
    });
  }

  changeset.configure({
    target: mode === "scenario" ? "scenario" : "corrections",
    storageKey: storageKeyFor({ ...CFG, mode, scenarioId }),
    snapshotId: CFG.snapshotId,
  });

  applyModeChrome();
  installDrag();

  await loadForMode();

  if (CFG.focusId) chart.navigateToEmployee(CFG.focusId);
}

boot();
