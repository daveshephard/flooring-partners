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
import { chartToSvg, downloadSvg, downloadPng } from "./export.js";

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
const $addBtn    = $("oc-add-btn");
const $addLabel  = $("oc-add-label");
const $groupsBtn = $("oc-groups-btn");
const $saveBar   = $("oc-save-bar");
const $saveCount = $("oc-save-count");
const $btnReview = $("oc-btn-review");
const $btnDiscard = $("oc-btn-discard");
const $btnSave   = $("oc-btn-save");
const $strip     = $("oc-summary-strip");
const $panel     = $("oc-panel");
const $rail      = $("oc-rail");
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
      const vacant = op.after.is_vacant === true;
      const named = `${op.after.first_name || ""} ${op.after.last_name || ""}`.trim();
      byId.set(eid, Object.assign(makeNode({
        employee_id: eid,
        ...op.after,
        // A Correct-mode add is a real person, so fall back to their title or
        // badge — "(vacant)" only ever means a scenario's to-be-hired role.
        full_name: named || (vacant ? "(vacant)" : (op.after.job_title || op.after.employee_id || eid)),
        self: {
          cost: Number(op.after.fully_loaded_cost || op.after.annual_salary || 0),
          revenue: null, is_overhead: null,
        },
      }), { _pendingAdd: true, is_vacant: vacant }));
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
  if ($addBtn) {
    $addBtn.hidden = !isEditing();
    $addLabel.textContent = mode === "correct" ? "Add missing person" : "Add position";
  }
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
  // Groups are a reading aid, so they load in every mode including View.
  await refreshGroups();
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

/** Distinct existing values for a field — a free consistency win on messy imports. */
function datalistFor(field, prefix = "dl-") {
  const values = new Set();
  for (const n of chart.flattenTree(chart.fullTree)) {
    const v = (n[field] || "").trim();
    if (v) values.add(v);
  }
  if (!values.size) return "";
  return `<datalist id="${prefix}${field}">`
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

  // Grouping sits above the attribute fields, not below them — it was previously
  // twelve inputs down the panel, where nobody found it.
  const kidCount = (node.children || []).length;
  const mine = chart.getGroups().filter(g => {
    const r = chart.resolvedGroup(g.id);
    return (r && r.anchor === eid) || (g.member_ids || []).includes(eid);
  });
  if (kidCount > 1 || mine.length) {
    html += `<div class="oc-panel-section">Team boxes</div><div class="oc-field">`;
    if (kidCount > 1) {
      html += `<button class="btn btn-secondary btn-xs" type="button" data-act="group">`
            + `Box up ${kidCount} reports…</button> `;
    }
    if (mine.length) {
      html += `<div class="oc-panel-hint" style="margin-top:0.35rem;">In: `
            + mine.map(g => `<a data-edit-group="${esc(g.id)}">${esc(g.name)}</a>`).join(", ")
            + `</div>`;
    }
    html += `</div>`;
  }

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
  }
  html += `<button class="btn btn-secondary btn-xs" type="button" data-act="add-report">`
        + (mode === "correct" ? "+ Add a missing report" : "+ Add report") + `</button>`;

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

  const kids = (node.children || []).length;
  html += `<div class="oc-danger-zone">`;
  html += `<p>`
        + (kids
            ? `This person has ${kids} direct report(s) — you'll choose where each one goes. `
            : "")
        + `Staged, so you can remove it from the review list before saving.</p>`;
  html += `<button class="btn btn-danger btn-xs" type="button" data-act="eliminate">`
        + `Eliminate position</button>`;
  if (mode === "correct") {
    html += ` <button class="btn btn-danger btn-xs" type="button" data-act="exclude">`
          + `Exclude from chart</button>`
          + `<p style="margin-top:0.4rem;">Eliminate when the role is gone. Exclude when the `
          + `row shouldn't be here at all — a duplicate or a ghost record in the export. `
          + `Both are reversible from the Corrections page.</p>`;
  }
  html += `</div></div>`;

  html += `<div class="oc-panel-foot">`
    + `<span class="oc-panel-hint">Changes are staged until you press Save.</span>`
    + `<button class="btn btn-secondary btn-sm" type="button" data-act="cancel">Cancel</button>`
    + `<button class="btn btn-primary btn-sm" type="button" data-act="apply">Apply</button>`
    + `</div>`;

  $panel.innerHTML = html;
  $panel.hidden = false;
  syncRail();
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

/** The rail is only present when something is docked in it, so the chart gets
 *  the full width back the moment you're done. */
function syncRail() {
  if (!$rail) return;
  const modal = $modalHost && $modalHost.querySelector(".oc-modal-backdrop");
  const panelOpen = $panel && !$panel.hidden;
  $rail.hidden = !panelOpen && !modal;
  $rail.classList.toggle("has-modal", !!modal);
  $rail.classList.toggle("wide", !!(modal && modal.classList.contains("wide")));
}

function closePanel() {
  if (!$panel) return;
  $panel.hidden = true;
  $panel.innerHTML = "";
  panelCtx = null;
  const wasSelected = selectedId;
  selectedId = null;
  syncRail();
  if (wasSelected) rerenderCards();
}

function rerenderCards() {
  if (chart.viewRoot) chart.renderTree();
}

/* What the open panel is about. Held in module state rather than captured in a
   closure, because the panel's handlers are bound once — see below. */
let panelCtx = null;

/**
 * The panel's click/keydown handlers are bound **once**, at load.
 *
 * `$panel` is a persistent element whose innerHTML is swapped on each open, so
 * binding inside openPanel() stacked a fresh handler every time and left the
 * old ones live: after opening the panel five times, one click on Apply staged
 * five times and one click on a button that opens a modal stacked five modals.
 * Delegation plus `panelCtx` is what keeps a click meaning exactly one thing.
 */
function initPanel() {
  if (!$panel) return;

  $panel.addEventListener("click", e => {
    if (e.target.closest(".oc-panel-close")) return closePanel();

    const goto = e.target.closest("[data-goto]");
    if (goto) { chart.navigateToEmployee(goto.dataset.goto); return; }

    const editGroup = e.target.closest("[data-edit-group]");
    if (editGroup) {
      const id = editGroup.dataset.editGroup;
      closePanel();
      return openGroupForm({ groupId: id });
    }

    const btn = e.target.closest("[data-act]");
    if (!btn || !panelCtx) return;
    const { eid, node, fields } = panelCtx;
    switch (btn.dataset.act) {
      case "cancel":     return closePanel();
      case "apply":      return applyPanel(eid, node, fields);
      case "set-root":   return stageSetRoot(eid, node);
      case "exclude":    return openRemovalForm(eid, node, "exclude");
      case "eliminate":  return openRemovalForm(eid, node, "eliminate");
      case "add-report": closePanel(); return openAddForm(eid);
      case "group":      closePanel(); return openGroupForm({ parentId: eid });
    }
  });

  $panel.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.stopPropagation(); closePanel(); }
  });
}

function wirePanel(eid, node, fields) {
  // Only the freshly-rendered children get their own listeners; the panel's own
  // are bound once in initPanel().
  panelCtx = { eid, node, fields };
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

/* ══════════════════════════════════════════════════════════════════
   Decorative grouping boxes
   ══════════════════════════════════════════════════════════════════
   A manager with thirty direct reports is unreadable. Grouping folds some of
   them into a named box showing headcount and cost, which expands to the
   ordinary cards underneath.

   Groups change no reporting line and no stored field, so they save immediately
   rather than joining the pending changeset — there'd be nothing for the review
   modal to review. They're visible in every mode, including View, because
   decluttering is a reading problem before it's an editing one. */

const ACCENTS = [
  ["sand", "Sand"], ["sage", "Sage"], ["slate", "Slate"], ["plum", "Plum"],
];

async function refreshGroups() {
  const r = await api("/groups/");
  if (r.ok && r.data) chart.setGroups(r.data.groups);
  updateGroupsButton();
}

function updateGroupsButton() {
  const badge = $("oc-groups-count");
  if (!badge) return;
  const n = chart.getGroups().length;
  badge.hidden = n === 0;
  badge.textContent = n;
}

/**
 * The home for grouping.
 *
 * It used to be reachable only from a card's side panel, which meant you had to
 * be in an edit mode, know to click a card, and scroll past twelve attribute
 * fields to find it — and in View mode there was no way in at all, despite
 * groups being a reading aid. This is the discoverable entry point: every box,
 * from anywhere, in any mode.
 */
function openGroupManager() {
  const groups = chart.getGroups();

  let body;
  if (!groups.length) {
    body = `<p>A team box folds several people into one collapsible card showing `
         + `headcount and cost — useful when a manager has more direct reports `
         + `than you can read at once.</p>`
         + `<p class="oc-panel-hint" style="margin-top:0.5rem;">Boxes are `
         + `decorative: they change no reporting line, and everyone can see them.</p>`;
  } else {
    body = `<table class="oc-diff-table"><thead><tr>`
         + `<th>Team</th><th>People</th><th>Sits under</th><th></th></tr></thead><tbody>`;
    for (const g of groups) {
      const r = chart.resolvedGroup(g.id);
      const anchor = r ? nodeFor(r.anchor) : null;
      const drawn = r ? r.memberIds.length : 0;
      const total = (g.member_ids || []).length;
      body += `<tr>`
        + `<td><span class="oc-swatch accent-${esc(g.accent)}"></span>${esc(g.name)}</td>`
        + `<td>${drawn}${drawn !== total ? ` <span class="oc-panel-hint">of ${total} on chart</span>` : ""}</td>`
        + `<td>${anchor ? esc(anchor.full_name) : `<span class="oc-panel-hint">not on the chart</span>`}</td>`
        + `<td style="white-space:nowrap;">`
        + `<button class="btn btn-secondary btn-xs" data-goto-group="${esc(g.id)}">Show</button> `
        + `<button class="btn btn-secondary btn-xs" data-open-group="${esc(g.id)}">Edit</button>`
        + `</td></tr>`;
    }
    body += `</tbody></table>`;
  }

  openModal({
    title: "Team boxes",
    body,
    buttons: [
      { label: "Close", cls: "btn-secondary", value: null },
      { label: "New team…", cls: "btn-primary", value: "new" },
    ],
    onMount(root, close) {
      root.addEventListener("click", e => {
        const open = e.target.closest("[data-open-group]");
        if (open) {
          const id = open.dataset.openGroup;
          close(null);
          return openGroupForm({ groupId: id });
        }
        const show = e.target.closest("[data-goto-group]");
        if (show) {
          const r = chart.resolvedGroup(show.dataset.gotoGroup);
          close(null);
          if (r && r.memberIds.length) {
            chart.expandNode(r.anchor);
            chart.renderTree();
            chart.navigateToEmployee(r.memberIds[0]);
          } else {
            toast("None of that team's members are on the chart right now.", "err");
          }
        }
      });
    },
    onClose(value) {
      // Seed from the selected card when there is one, so "New team" from a
      // manager's card still offers their reports in one click.
      if (value === "new") openGroupForm({ parentId: selectedId });
    },
  });
}

function groupById(id) {
  return chart.getGroups().find(g => String(g.id) === String(id)) || null;
}

/**
 * Open the editor for an existing group, or start a new one.
 *
 * Membership is free-form — search for anyone and add them. `parentId`, when
 * given, just seeds the picker with that manager's direct reports, which is the
 * common case (box the CEO's five commercial reps under the CEO). Where the box
 * *hangs* is worked out from the members unless you override it.
 */
function openGroupForm({ groupId = null, parentId = null, preselect = [] } = {}) {
  const group = groupId ? groupById(groupId) : null;
  const seedFrom = nodeFor(group ? group.parent_employee_id : parentId);

  // One box per person, so anyone already spoken for is off the table.
  const takenElsewhere = new Map();
  for (const g of chart.getGroups()) {
    if (group && String(g.id) === String(group.id)) continue;
    for (const m of g.member_ids || []) takenElsewhere.set(m, g.name);
  }

  const chosen = new Map();   // employee_id -> label
  for (const id of (group ? group.member_ids : preselect)) {
    const n = nodeFor(id);
    chosen.set(id, n ? `${n.full_name} (${id})` : id);
  }
  let placeUnder = group ? (group.parent_employee_id || "") : "";

  let body = `<div class="oc-field"><label for="grp-name">Group name</label>`
    + `<input id="grp-name" value="${esc(group ? group.name : "")}" `
    + `placeholder="e.g. Commercial Sales" autocomplete="off"></div>`;

  body += `<div class="oc-field"><label>Color</label><div class="oc-accent-row">`
    + ACCENTS.map(([key, label]) =>
        `<label class="oc-accent accent-${key}">`
        + `<input type="radio" name="grp-accent" value="${key}"`
        + ((group ? group.accent : "sand") === key ? " checked" : "") + `>`
        + `<span>${esc(label)}</span></label>`).join("")
    + `</div></div>`;

  body += `<div class="oc-panel-section">Who's in it</div>`;
  body += typeaheadMarkup("grp-ta", "Search for anyone to add…", "");
  if (seedFrom && (seedFrom.children || []).length) {
    body += `<button type="button" class="btn btn-secondary btn-xs" id="grp-add-reports">`
          + `Add all ${seedFrom.children.length} of ${esc(seedFrom.full_name)}'s reports`
          + `</button>`;
  }
  body += `<div class="oc-chips" id="grp-chips"></div>`;

  body += `<div class="oc-panel-section">Where it sits</div>`;
  body += typeaheadMarkup("grp-place", "Choose a manager (optional)",
                          placeUnder ? (nodeFor(placeUnder) || {}).full_name || placeUnder : "");
  body += `<p class="oc-panel-hint">Leave blank and the box hangs under whoever the `
        + `members report to. People in the box are drawn there instead of their `
        + `usual spot — reporting lines don't change, and the box says so when its `
        + `members report elsewhere.</p>`;

  body += `<label class="oc-panel-hint" style="display:flex;gap:0.35rem;align-items:center;margin-top:0.5rem;">`
    + `<input type="checkbox" id="grp-collapsed"`
    + ((group ? group.collapsed_by_default : true) ? " checked" : "")
    + `> Start collapsed</label>`;
  body += `<p class="oc-panel-hint" style="margin-top:0.4rem;">`
    + `Grouping is decorative and saves straight away — it isn't part of your `
    + `unsaved changes.</p>`;

  const buttons = [{ label: "Cancel", cls: "btn-secondary", value: null }];
  if (group) buttons.push({ label: "Ungroup", cls: "btn-danger", value: "delete" });
  buttons.push({ label: group ? "Save group" : "Create group", cls: "btn-primary", value: "save" });

  openModal({
    title: group ? `Edit “${group.name}”` : "New group",
    body,
    buttons,
    onMount(root) {
      const $chips = root.querySelector("#grp-chips");

      function drawChips() {
        $chips.innerHTML = chosen.size
          ? [...chosen].map(([id, label]) =>
              `<span class="oc-chip">${esc(label)}`
              + `<button type="button" data-drop="${esc(id)}" aria-label="Remove">&times;</button>`
              + `</span>`).join("")
          : `<span class="oc-panel-hint">Nobody yet — search above, or add a `
            + `manager's reports in one go.</span>`;
      }
      drawChips();

      $chips.addEventListener("click", e => {
        const b = e.target.closest("[data-drop]");
        if (!b) return;
        chosen.delete(b.dataset.drop);
        drawChips();
      });

      function addPerson(id) {
        if (chosen.has(id)) return;
        const taken = takenElsewhere.get(id);
        if (taken) return toast(`Already in “${taken}” — remove them from it first.`, "err");
        const n = nodeFor(id);
        chosen.set(id, n ? `${n.full_name} (${id})` : id);
        drawChips();
      }

      attachTypeahead(root, "grp-ta", {
        exclude: new Set(takenElsewhere.keys()),
        onPick(target) {
          addPerson(target);
          root.querySelector("#grp-ta").value = "";
        },
      });
      attachTypeahead(root, "grp-place", {
        exclude: new Set(),
        onPick(target) { placeUnder = target; },
      });
      const $place = root.querySelector("#grp-place");
      $place.addEventListener("input", () => {
        if (!$place.value.trim()) placeUnder = "";
      });

      const addAll = root.querySelector("#grp-add-reports");
      if (addAll) {
        addAll.addEventListener("click", () => {
          for (const c of seedFrom.children) addPerson(c.employee_id);
        });
      }
      root.querySelector("#grp-name").focus();
    },
    async onClose(value, root) {
      if (value === "delete") return deleteGroup(group.id, group.name);
      if (value !== "save") return;

      const name = (root.querySelector("#grp-name").value || "").trim();
      const members = [...chosen.keys()];
      const accent = (root.querySelector("[name=grp-accent]:checked") || {}).value || "sand";

      if (!name) return toast("Give the group a name.", "err");
      if (!members.length) return toast("Pick at least one person for the group.", "err");

      const r = await api("/groups/save/", {
        body: JSON.stringify({
          id: group ? group.id : null,
          parent_employee_id: placeUnder,
          name, member_ids: members, accent,
          collapsed_by_default: root.querySelector("#grp-collapsed").checked,
        }),
      });
      if (!r.ok) return toast((r.data && r.data.error) || "Couldn't save the group.", "err");
      chart.setGroups(r.data.groups);
      updateGroupsButton();
      chart.renderTree();
      toast(group ? "Team updated." : `Boxed ${members.length} into “${name}”.`, "ok");
    },
  });
}

/** No typed confirm here: nothing is lost, and re-making the box is a minute's
 *  work. Ceremony should match consequence. */
async function deleteGroup(id, name) {
  const answer = await confirmModal({
    title: `Ungroup “${name}”?`,
    body: "The box disappears and its members go back to being ordinary cards. "
        + "Nobody's reporting line changes, and no data is lost.",
    confirmLabel: "Ungroup",
  });
  if (answer !== "confirm") return;
  const r = await api(`/groups/${id}/delete/`, { body: "{}" });
  if (!r.ok) return toast("Couldn't ungroup.", "err");
  chart.setGroups(r.data.groups);
  updateGroupsButton();
  chart.renderTree();
  toast("Ungrouped — the members are back as ordinary cards.", "ok");
}

chart.hooks.onGroupEdit = gid => openGroupForm({ groupId: gid });

/** Dropping a card onto a group box files them into it — visually only. */
async function addToGroup(employeeId, groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const members = new Set(group.member_ids || []);
  if (members.has(employeeId)) return;

  const taken = chart.getGroups().find(
    g => String(g.id) !== String(groupId) && (g.member_ids || []).includes(employeeId));
  if (taken) {
    toast(`Already in “${taken.name}” — remove them from that group first.`, "err");
    return;
  }

  members.add(employeeId);
  const r = await api("/groups/save/", {
    body: JSON.stringify({
      id: group.id, parent_employee_id: group.parent_employee_id,
      name: group.name, member_ids: [...members], accent: group.accent,
      collapsed_by_default: group.collapsed_by_default,
    }),
  });
  if (!r.ok) return toast((r.data && r.data.error) || "Couldn't add to that group.", "err");
  chart.setGroups(r.data.groups);
  updateGroupsButton();
  rerender();
  toast(`Added to “${group.name}”.`, "ok");
}

/* ══════════════════════════════════════════════════════════════════
   Removing someone — and deciding where their team goes
   ══════════════════════════════════════════════════════════════════
   Removing a manager is really two decisions, and the old tool only ever asked
   about the first. Everyone underneath was silently pulled up to the departing
   manager's own boss, which is rarely what a real reorg does — a disbanded team
   usually gets split across several people. So the reports are allocated here,
   in the same gesture, with a lookup per person.

   For someone with no reports there is nothing to allocate, so that case keeps
   the typed confirm. For a manager, choosing destinations *is* the deliberate
   act; making you also type a word on top would be ceremony, not safety. */

function openRemovalForm(eid, node, kind) {
  const reports = (node.children || []).slice();
  const parent = findParentIn(chart.fullTree, eid);
  const eliminating = kind === "eliminate";
  const verb = eliminating ? "Eliminate" : "Exclude";

  if (!reports.length) {
    const body = eliminating
      ? `Eliminate ${node.full_name}'s position? They have no direct reports.`
      : `Remove ${node.full_name} from the chart? The row is kept and stays `
        + `reversible from the Excluded list — use this for duplicate rows or `
        + `ghost records in the payroll export.`;
    return typedConfirm(`${verb} ${node.full_name}?`, verb.toUpperCase(), () => {
      stage({ op: kind, employee_id: eid, after: {}, note: noteValue() });
      closePanel();
    }, body);
  }

  const fallback = parent
    ? `${parent.full_name} (${parent.employee_id})`
    : "the top of the org";
  const dest = new Map();   // child employee_id -> chosen manager id (or "")

  let body = `<p style="margin-bottom:0.7rem;">`
    + `${esc(node.full_name)} has <strong>${reports.length}</strong> direct report`
    + `${reports.length === 1 ? "" : "s"}. Choose where each one goes. `
    + `Anything left blank moves up to ${esc(fallback)}.</p>`;

  body += `<div class="oc-realloc-bulk">`
    + `<span>Move everyone to</span>`
    + typeaheadMarkup("rm-ta-all", "Search for a manager…", "")
    + `</div>`;

  body += `<table class="oc-diff-table"><tbody>`;
  reports.forEach((child, idx) => {
    const below = Math.max(0, (child.metrics.headcount || 1) - 1);
    body += `<tr><td style="width:45%;">`
      + `<div>${esc(child.full_name)}</div>`
      + `<div class="ta-title">${esc(child.job_title || "—")}`
      + (below ? ` · brings ${below} with them` : "") + `</div></td>`
      + `<td>${typeaheadMarkup("rm-ta-" + idx, "→ " + fallback, "")}</td></tr>`;
  });
  body += `</tbody></table>`;

  openModal({
    title: `${verb} ${node.full_name}'s position?`,
    body,
    buttons: [
      { label: "Cancel", cls: "btn-secondary", value: null },
      { label: verb, cls: "btn-danger", value: "go" },
    ],
    onMount(root) {
      // A destination may not be the person being removed, nor the report
      // themselves, nor anyone beneath that report — all three would strand them.
      const subtree = invalidTargetsFor(chart.fullTree, eid);
      attachTypeahead(root, "rm-ta-all", {
        exclude: subtree,
        local: true,
        onPick(target) {
          reports.forEach((child, idx) => {
            if (child.employee_id === target) return;
            dest.set(child.employee_id, target);
            const input = root.querySelector("#rm-ta-" + idx);
            if (input) input.value = nameOf(target);
          });
        },
      });
      reports.forEach((child, idx) => {
        const bad = invalidTargetsFor(chart.fullTree, child.employee_id);
        bad.add(eid);
        attachTypeahead(root, "rm-ta-" + idx, {
          exclude: bad,
          local: true,
          onPick(target) { dest.set(child.employee_id, target); },
        });
        const input = root.querySelector("#rm-ta-" + idx);
        input.addEventListener("input", () => {
          if (!input.value.trim()) dest.delete(child.employee_id);
        });
      });
    },
    onClose(value) {
      if (value !== "go") return;
      const reassign = {};
      for (const [child, target] of dest) if (target) reassign[child] = target;
      stage({ op: kind, employee_id: eid, after: { reassign }, note: noteValue() });
      closePanel();
      for (const target of Object.values(reassign)) chart.expandNode(target);
      rerender();
    },
  });
}

/* ══════════════════════════════════════════════════════════════════
   Add a person / role
   ══════════════════════════════════════════════════════════════════
   One form, both modes, because the gesture is the same even though the
   meaning isn't:

   Correct mode  — someone who genuinely works here that the export missed.
                   The badge number matters: it's what next month's file has to
                   match for the correction to retire itself rather than create
                   a duplicate. No pay fields (payroll owns those), no vacancy.
   Scenario mode — a role you're proposing. Vacant by default, pay editable,
                   and the server assigns the NEW-n id.

   The form stages a fully-populated op. The earlier flow dropped a blank
   "New position" card on the chart and told you to go find it. */

function openAddForm(supervisorId) {
  const correcting = mode === "correct";
  const parent = supervisorId ? nodeFor(supervisorId) : null;
  const fields = correcting
    ? CORRECTABLE_FIELDS
    : CORRECTABLE_FIELDS.concat(CFG.canSeePay ? PAY_FIELDS : []);

  let body = "";
  if (correcting) {
    body += `<div class="oc-field"><label for="add-eid">Employee ID (badge number)</label>`
          + `<input id="add-eid" autocomplete="off" placeholder="e.g. 51234">`
          + `<span class="oc-panel-hint" style="display:block;margin-top:0.2rem;">`
          + `Use their real ID if you know it — that's how this fix retires itself `
          + `once the export starts including them. Leave blank and one is generated.`
          + `</span></div>`;
  }

  body += `<div class="oc-panel-section">Reports to</div>`;
  body += typeaheadMarkup("add-ta", "Search for a manager…",
                          parent ? parent.full_name : "");
  body += `<label class="oc-panel-hint" style="display:flex;gap:0.35rem;align-items:center;">`
        + `<input type="checkbox" id="add-root"> Top of org — reports to nobody</label>`;

  body += `<div class="oc-panel-section">Details</div><div class="oc-field-grid">`;
  for (const [f, label] of fields) {
    const listAttr = DATALIST_FIELDS.includes(f) ? ` list="dl-add-${f}"` : "";
    body += `<div class="oc-field"><label for="add-${f}">${esc(label)}</label>`
          + `<input id="add-${f}" data-add-field="${f}"${listAttr}></div>`;
  }
  body += `</div>`;
  body += DATALIST_FIELDS.map(f => datalistFor(f, "dl-add-")).join("");

  if (!correcting) {
    body += `<div class="oc-field"><label>`
          + `<input type="checkbox" id="add-vacant" checked> Vacant / to-be-hired</label></div>`;
  }
  body += `<div class="oc-field"><label for="add-note">Note</label>`
        + `<textarea id="add-note" rows="2" placeholder="${correcting
            ? "Why is this person missing from the export?"
            : "Why this role?"}"></textarea></div>`;

  let chosenSupervisor = supervisorId || null;

  openModal({
    title: correcting ? "Add a person the census missed" : "Add a position",
    body,
    buttons: [
      { label: "Cancel", cls: "btn-secondary", value: null },
      { label: "Add", cls: "btn-primary", value: "add" },
    ],
    onMount(root) {
      attachTypeahead(root, "add-ta", {
        exclude: new Set(),
        local: true,
        onPick(target) {
          chosenSupervisor = target;
          root.querySelector("#add-root").checked = false;
        },
      });
      root.querySelector("#add-root").addEventListener("change", e => {
        if (e.target.checked) {
          chosenSupervisor = null;
          root.querySelector("#add-ta").value = "";
        }
      });
      const focusField = root.querySelector(correcting ? "#add-eid" : "#add-job_title");
      if (focusField) focusField.focus();
    },
    onClose(value, root) {
      if (value !== "add") return;

      const after = {};
      for (const [f] of fields) {
        const v = (root.querySelector(`[data-add-field="${f}"]`) || {}).value || "";
        if (v.trim()) after[f] = v.trim();
      }
      const isRoot = root.querySelector("#add-root").checked;
      after.raw_supervisor_id = isRoot ? "" : (chosenSupervisor || "");

      if (correcting) {
        const eid = (root.querySelector("#add-eid").value || "").trim();
        if (eid) after.employee_id = eid;
        if (!after.first_name && !after.last_name && !after.job_title) {
          toast("Give the person at least a name or a job title.", "err");
          return;
        }
        if (!isRoot && !chosenSupervisor) {
          toast("Pick a manager, or tick 'Top of org'.", "err");
          return;
        }
      } else {
        after.is_vacant = root.querySelector("#add-vacant").checked;
        if (!after.job_title) {
          toast("Give the position a job title.", "err");
          return;
        }
      }

      const tmp = changeset.nextTempId();
      stage({
        op: "add", employee_id: tmp, after,
        note: (root.querySelector("#add-note").value || "").trim(),
      });
      if (chosenSupervisor) chart.expandNode(chosenSupervisor);
      rerender();
      chart.revealInPlace(tmp);
      toast(correcting ? "Person staged — press Save to add them."
                       : "Position staged — press Save to add it.");
    },
  });
}

/* ── Typeahead over api_employee_search ──────────────────────────── */

/** Markup for a manager picker. Shared by the side panel and the add form. */
function typeaheadMarkup(id, placeholder, value) {
  return `<div class="oc-field oc-typeahead-wrap">`
       + `<input type="text" id="${id}" placeholder="${esc(placeholder)}" autocomplete="off"`
       + ` value="${esc(value || "")}">`
       + `<div class="oc-typeahead-results" id="${id}-res"></div></div>`;
}

/**
 * Everyone the *client* knows about, shaped like an api_employee_search row.
 *
 * api_employee_search queries Employee rows, so it cannot see a person or role
 * that is still only staged — which meant a role you had just created was
 * unpickable as a manager in every typeahead on the page. You could drop a card
 * onto it, but the side panel's "Reports to" search, the add form's manager
 * picker and the reallocation pickers all came back "No valid matches", so from
 * the outside the new role simply refused to take reports.
 *
 * The optimistic tree already holds the staged additions, so it is the right
 * source; `staged` marks the ones payroll has never heard of.
 */
function localMatches(query, exclude) {
  const q = query.toLowerCase();
  const out = [];
  for (const n of chart.flattenTree(chart.fullTree)) {
    if (!n || !n.employee_id || exclude.has(n.employee_id)) continue;
    const haystack = [n.full_name, n.job_title, n.employee_id].join(" ").toLowerCase();
    if (!haystack.includes(q)) continue;
    out.push({
      employee_id: n.employee_id,
      full_name: n.full_name || n.employee_id,
      job_title: n.job_title || "",
      management_level: n.management_level || "",
      staged: !!n._pendingAdd,
    });
  }
  // Staged first: a role you created seconds ago is the one you're looking for.
  out.sort((a, b) => (b.staged ? 1 : 0) - (a.staged ? 1 : 0));
  return out;
}

function typeaheadRow(x) {
  // The pick handler reads the first inner <div> as the label, so full_name has
  // to stay first and alone in it.
  return `<div class="oc-typeahead-item" data-pick="${esc(x.employee_id)}">`
       + `<div>${esc(x.full_name)}</div>`
       + `<div class="ta-title">${esc(x.job_title || "")} · ${esc(x.employee_id)}`
       + (x.staged ? ` · <em>unsaved</em>` : "") + `</div></div>`;
}

/**
 * @param root      element containing the input
 * @param exclude   Set of employee_ids that can't be picked (self + descendants)
 * @param onPick    (employee_id, row) => void
 * @param local     include staged, not-yet-saved people. On for manager pickers;
 *                  off for the group form, whose endpoint validates member ids
 *                  against the census and would reject a staged id.
 */
function attachTypeahead(root, id, { exclude, onPick, local = false }) {
  const input = root.querySelector("#" + id);
  const res = root.querySelector("#" + id + "-res");
  if (!input) return;
  let timer = null;
  const bad = exclude || new Set();

  function draw(rows) {
    res.innerHTML = rows.length
      ? rows.slice(0, 10).map(typeaheadRow).join("")
      : `<div class="oc-typeahead-item" style="color:var(--text-muted);">No valid matches</div>`;
    res.classList.add("open");
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { res.classList.remove("open"); return; }
    // Local hits render immediately; the server's arrive when they arrive.
    const mine = local ? localMatches(q, bad) : [];
    if (mine.length) draw(mine);
    timer = setTimeout(async () => {
      const r = await api("/employees/search/?q=" + encodeURIComponent(q) + "&limit=10");
      const seen = new Set(mine.map(x => x.employee_id));
      const rows = mine.concat(
        (r.data || []).filter(x => !bad.has(x.employee_id) && !seen.has(x.employee_id)));
      draw(rows);
    }, 200);
  });

  res.addEventListener("click", e => {
    const item = e.target.closest("[data-pick]");
    if (!item) return;
    const target = item.dataset.pick;
    // Mirror the server's branch check so the UI can't offer what the API rejects.
    if (CFG.branchRootId && !branchMembers(chart.fullTree, CFG.branchRootId).has(target)) {
      toast("That manager is outside the part of the org you can edit.", "err");
      return;
    }
    res.classList.remove("open");
    input.value = item.querySelector("div").textContent;
    onPick(target);
  });
}

function wireTypeahead(eid, node) {
  attachTypeahead($panel, "oc-ta", {
    // Exclude the subject and its descendants, so an invalid move simply can't
    // be selected in the first place.
    exclude: invalidTargetsFor(chart.fullTree, eid),
    local: true,
    onPick(target) {
      stage(reparentOp(eid, target, node, noteValue()));
      closePanel();
      chart.expandNode(target);
      rerender();
      chart.revealInPlace(eid);
    },
  });
}

function reparentOp(eid, target, node, note) {
  return {
    op: "reparent", employee_id: eid, after: { raw_supervisor_id: target },
    _before: { raw_supervisor_id: node ? node.raw_supervisor_id ?? null : null },
    note: note || "",
  };
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
    const { ops, stagingIndex } = changeset.commitPayload();
    const r = await api("/changeset/commit/", {
      body: JSON.stringify({
        target: changeset.target,
        scenario_id: scenarioId,
        expected_snapshot_id: CFG.snapshotId,
        ops,
      }),
    });

    if (r.status === 200) {
      const n = changeset.count();
      changeset.replaceIds(r.data.id_map);
      changeset.clear();
      changeset.discardStored();
      if (reviewCtx) reviewCtx.close();
      chart.setTree(r.data.tree);
      captureBaseRows(r.data.tree);
      if (mode === "scenario") scenarioSummary = r.data.summary;
      else { unattached = r.data.summary; await refreshCorrectionStats(); }
      rerender();
      toast(`Saved ${n} change${n === 1 ? "" : "s"}.`, "ok");
      return true;
    }
    if (r.status === 422) {
      // Never discard the user's work on a validation failure. Annotate the list
      // that's already open rather than replacing it with an identical one.
      const errs = toStagingErrors(r.data.errors || [], stagingIndex);
      if (reviewCtx) reviewCtx.showErrors(errs);
      else openReview(errs);
      const n = errs.length;
      toast(`${n} change${n === 1 ? "" : "s"} rejected — nothing was saved. `
            + `See the review list.`, "err");
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
    case "exclude":
    case "eliminate": {
      const head = op.op === "exclude"
        ? "removed from the chart (row kept, reversible)"
        : "position eliminated";
      const alloc = Object.entries(op.after.reassign || {});
      if (!alloc.length) {
        const kids = (node.children || []).length;
        return kids ? `${head}; ${kids} report(s) move up a level` : head;
      }
      return head + "; " + alloc.map(([c, m]) => `${nameOf(c)} → ${nameOf(m)}`).join(", ");
    }
    case "add": {
      const who = `${op.after.first_name || ""} ${op.after.last_name || ""}`.trim()
                || op.after.job_title || "new position";
      const under = nameOf(op.after.raw_supervisor_id) || "nobody (top of org)";
      if (mode === "correct") {
        const badge = op.after.employee_id ? ` as ${op.after.employee_id}` : " (id generated)";
        return `missing from the census → added${badge}, reporting to ${under}`;
      }
      return `new ${op.after.is_vacant === false ? "" : "vacant "}position `
           + `"${who}" under ${under}`;
    }
    default:          return "";
  }
}

function nameOf(eid) {
  if (!eid) return "";
  const n = nodeFor(eid);
  return n ? `${n.full_name} (${eid})` : eid;
}

/* The review list while it is up.
 *
 * A rejected save used to close this modal and open a brand-new one carrying the
 * error annotations. Same title, same rows, so pressing "Save changes" looked
 * like it had simply redrawn the change log a second time and done nothing —
 * which is how it was reported. The list now stays put and annotates itself. */
let reviewCtx = null;

/**
 * Server errors are indexed by *commit* order; this list works in *staging*
 * order. Translate before an error is shown against a row, or the red flag lands
 * on the wrong change.
 */
function toStagingErrors(errors, stagingIndex) {
  return (errors || []).map(e => ({
    ...e,
    index: stagingIndex && stagingIndex[e.index] != null ? stagingIndex[e.index] : e.index,
  }));
}

async function openReview(presetErrors) {
  let errors = presetErrors;
  if (!errors) {
    // Surface problems before the user commits, not after.
    const { ops, stagingIndex } = changeset.commitPayload();
    const r = await api("/changeset/validate/", {
      body: JSON.stringify({
        target: changeset.target, scenario_id: scenarioId, ops,
      }),
    });
    errors = toStagingErrors((r.data && r.data.errors) || [], stagingIndex);
  }
  let byIndex = new Map(errors.map(e => [e.index, e.error]));
  let rootEl = null;
  let closeMe = null;

  function body() {
    const groups = changeset.grouped();
    if (!groups.length) return '<p style="color:var(--text-muted);">Nothing staged.</p>';
    let html = "";
    if (byIndex.size) {
      // Say plainly that nothing was written. Without this the annotated list is
      // indistinguishable from the one you were just looking at.
      html += `<p class="oc-review-rejected">${byIndex.size} change`
            + `${byIndex.size === 1 ? " was" : "s were"} rejected, so <strong>nothing `
            + `was saved</strong>. Fix or remove the flagged rows, then save again.</p>`;
    }
    html += '<table class="oc-diff-table"><thead><tr>'
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

  function redraw() {
    if (!rootEl) return;
    const b = rootEl.querySelector(".oc-modal-body");
    if (b) b.innerHTML = body();
    const head = rootEl.querySelector(".oc-modal-head h2");
    if (head) head.textContent = reviewTitle();
  }

  openModal({
    wide: true,
    title: reviewTitle(),
    body: body(),
    buttons: [
      { label: "Close", cls: "btn-secondary", value: null },
      // keepOpen: the list has to survive a rejected save so the errors can be
      // shown against the rows the user is already reading. save() closes it on
      // success.
      { label: "Save changes", cls: "btn-primary", value: "save", keepOpen: true },
    ],
    onMount(root, close) {
      rootEl = root;
      closeMe = close;
      root.addEventListener("click", e => {
        const rm = e.target.closest("[data-remove-index]");
        if (!rm) return;
        changeset.removeAt(parseInt(rm.dataset.removeIndex, 10));
        rerender();
        // Indices shift, so the flagged rows are no longer trustworthy.
        byIndex.clear();
        redraw();
      });
      root.addEventListener("change", e => {
        const note = e.target.closest("[data-note-index]");
        if (!note) return;
        const op = changeset.ops[parseInt(note.dataset.noteIndex, 10)];
        if (op) { op.note = note.value; changeset.persist(); }
      });
    },
    onClose() { reviewCtx = null; },
    onButton(v) { if (v === "save") save(); },
  });

  reviewCtx = {
    /** Annotate the list in place after a rejected save. */
    showErrors(errs) {
      byIndex = new Map(errs.map(e => [e.index, e.error]));
      redraw();
    },
    close() { if (closeMe) closeMe(null); },
  };
}

function reviewTitle() {
  const n = changeset.count();
  return `Review ${n} staged change${n === 1 ? "" : "s"}`;
}

/* ══════════════════════════════════════════════════════════════════
   Modals
   ══════════════════════════════════════════════════════════════════ */

/* The one modal that is currently up, so a second can't stack behind it.
 *
 * The rail docks *beside* the chart rather than covering it (aria-modal="false"),
 * which is deliberate — you can still read the chart you're editing — but it
 * leaves the toolbar and the save bar clickable while a modal is open. Opening
 * Review and then pressing the save bar's Save put two review lists in the host,
 * one behind the other, and dismissing the top one revealed the second: the
 * change log "appearing a second time". */
let liveModal = null;

function openModal({ title, body, buttons, wide, onMount, onClose, onButton }) {
  // Close through the existing modal's own teardown, not by removing the
  // element: confirmModal() and pickScenario() are awaited, and a promise that
  // never resolves would wedge switchMode() forever.
  if (liveModal) liveModal.close(null);

  const root = document.createElement("div");
  root.className = "oc-modal-backdrop" + (wide ? " wide" : "");
  root.innerHTML =
    `<div class="oc-modal" role="dialog" aria-modal="false" aria-label="${esc(title)}">`
    + `<div class="oc-modal-head"><h2>${esc(title)}</h2></div>`
    + `<div class="oc-modal-body">${body}</div>`
    + `<div class="oc-modal-foot"><span class="spacer"></span>`
    + (buttons || []).map((b, i) =>
        `<button class="btn ${b.cls} btn-sm" data-mb="${i}">${esc(b.label)}</button>`).join("")
    + `</div></div>`;
  $modalHost.appendChild(root);
  syncRail();

  function close(value) {
    if (liveModal && liveModal.root === root) liveModal = null;
    root.remove();
    document.removeEventListener("keydown", onKey, true);
    syncRail();
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
  });
  document.addEventListener("keydown", onKey, true);
  liveModal = { root, close };
  // onMount gets `close` so a handler can dismiss the modal through its own
  // teardown — removing the element directly would leak the keydown listener.
  if (onMount) onMount(root, close);
  const first = root.querySelector("input, select, textarea, button");
  if (first) first.focus();
  return { root, close };
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
      title, body: `<p>${esc(body)}</p>`,
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
function typedConfirm(question, word, onYes, explanation) {
  openModal({
        title: question,
    body: (explanation ? `<p style="margin-bottom:0.6rem;">${esc(explanation)}</p>` : "")
        + `<p>Type <strong>${word}</strong> to confirm.</p>`
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
      // Expand the target so the person is visible where they landed — but do
      // not re-root onto it. A cross-branch move used to jump the whole view to
      // the new manager's branch, which reads as the edit having failed.
      chart.expandNode(targetId);
      rerender();
      chart.revealInPlace(draggedId);
      const to = nodeFor(targetId);
      toast(`${node ? node.full_name : draggedId} → ${to ? to.full_name : targetId}`
            + " · staged, press Save", "ok");
    },
    onSetRoot(draggedId) {
      const node = nodeFor(draggedId);
      if (!node) return;
      stageSetRootFromDrag(draggedId, node);
    },
    onDropIntoGroup(draggedId, groupId) {
      addToGroup(draggedId, groupId);
    },
    onRejected(reason) {
      if (reason) toast(reason, "err");
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
   Chart picture export
   ══════════════════════════════════════════════════════════════════ */

function buildChartSvg() {
  return chartToSvg(chart.$tree, chart.getZoom(), {
    title: CFG.companyName,
    subtitle: [
      CFG.snapshotLabel || "",
      mode === "scenario" ? `Scenario: ${CFG.scenarioName || ""}` : "",
      changeset.isDirty() ? `${changeset.count()} unsaved change(s) shown` : "",
      CFG.canSeePay ? "" : "Pay figures hidden",
    ].filter(Boolean).join("  ·  "),
    canSeePay: CFG.canSeePay,
    lookup: eid => findNodeIn(chart.fullTree, eid),
    headerColor: chart.headerColorFor,
    locationOf: chart.locationOf,
    legendTitle: chart.colorByLabel(),
    legend: chart.legendEntries(),
    groupLabel(el) {
      const g = chart.resolvedGroup(el.dataset.group) || {};
      const members = (g.memberIds || []).map(id => findNodeIn(chart.fullTree, id)).filter(Boolean);
      let heads = 0, cost = 0, anyCost = false;
      for (const m of members) {
        heads += (m.metrics.headcount || 1);
        if (m.metrics.total_labor_cost != null) { cost += m.metrics.total_labor_cost; anyCost = true; }
      }
      const figures = [{ value: heads.toLocaleString(), label: heads === 1 ? "person" : "people" }];
      if (anyCost && CFG.canSeePay) {
        figures.push({ value: fmtMoney(cost), label: "loaded cost" });
      }
      const accent = (el.className.match(/accent-(\w+)/) || [])[1] || "sand";
      return { name: g.name || "Group", accent, figures };
    },
  });
}

function chartFilename() {
  const bits = [CFG.companySlug, "org-chart"];
  if (mode === "scenario" && CFG.scenarioName) bits.push(CFG.scenarioName);
  return bits.join("-").replace(/[^\w.-]+/g, "-").toLowerCase();
}

function initExportMenu() {
  const btn = $("oc-export-btn");
  const menu = $("oc-export-menu");
  if (!btn || !menu) return;

  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = menu.classList.toggle("open");
    btn.classList.toggle("active", open);
  });
  document.addEventListener("click", e => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.classList.remove("open");
      btn.classList.remove("active");
    }
  });

  menu.addEventListener("click", async e => {
    const item = e.target.closest("[data-export]");
    if (!item) {
      // A plain link — let it download and just close the menu.
      if (e.target.closest("a")) { menu.classList.remove("open"); btn.classList.remove("active"); }
      return;
    }
    menu.classList.remove("open");
    btn.classList.remove("active");

    const svg = buildChartSvg();
    if (!svg) return toast("Nothing on the chart to export yet.", "err");
    try {
      if (item.dataset.export === "svg") {
        downloadSvg(svg, chartFilename());
        toast("Chart exported as SVG.", "ok");
      } else {
        await downloadPng(svg, chartFilename());
        toast("Chart exported as PNG.", "ok");
      }
    } catch (err) {
      toast(err.message || "Couldn't export the chart.", "err");
    }
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

  // Toolbar add: no card need be selected first. Pre-fills the manager from the
  // current selection when there is one.
  if ($addBtn) $addBtn.addEventListener("click", () => openAddForm(selectedId));
  if ($groupsBtn) $groupsBtn.addEventListener("click", openGroupManager);

  changeset.configure({
    target: mode === "scenario" ? "scenario" : "corrections",
    storageKey: storageKeyFor({ ...CFG, mode, scenarioId }),
    snapshotId: CFG.snapshotId,
  });

  applyModeChrome();
  initPanel();
  installDrag();
  initExportMenu();

  await loadForMode();

  if (CFG.focusId) chart.navigateToEmployee(CFG.focusId);
}

boot();
