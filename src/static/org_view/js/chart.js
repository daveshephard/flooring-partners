/* Org chart renderer.
 *
 * Lifted verbatim out of company_detail.html's inline IIFE — same functions,
 * same names, same behaviour — and turned into an ES module so the edit shell
 * can build on it instead of growing that template past 3,000 lines.
 *
 * Django template variables can't live in a static file, so config comes from
 * the small inline <script> that sets window.ORG_VIEW.
 */
"use strict";

import { resolveGroups } from "./groups.js";

export const CFG = window.ORG_VIEW || {};

const SLUG      = CFG.companySlug;
export const API_BASE = CFG.apiBase || ("/org-view/api/companies/" + SLUG);
const COMPANY   = CFG.companyName || "";
const DEFAULT_EXPAND_DEPTH = 1;
const MIN_ZOOM  = 0.3;
const MAX_ZOOM  = 2.0;
const ZOOM_STEP = 0.1;

/* ── State ───────────────────────────────────────────────────────── */
export let fullTree    = null;
export let viewRoot    = null;
let focusPath   = [];
let zoom        = 1;
let panX        = 0;
let panY        = 0;
export const expandedSet = new Set();
let snapshotId  = CFG.snapshotId;

/* Filter state: each maps a field to a Set of *checked* values.
   null means "no filter" (all checked). */
let filters = { role: null, location: null, entity: null };
let filterValues = { role: [], location: [], entity: [] };
let customThreshold = null;

/* Hooks the edit shell installs. chart.js never imports it back, so there is
   no circular dependency and the viewer still works if the shell never loads. */
export const hooks = {
  /** (node) => extra HTML injected into the card header. */
  decorateCard: null,
  /** (node) => extra class names for the card. */
  cardClass: null,
  /** (eid, node, event) => true when the shell has handled the click. */
  onCardClick: null,
  /** () => void, after every renderTree(). */
  afterRender: null,
  /** (data) => void, after a successful tree fetch. */
  onTreeLoaded: null,
  /** () => url override for the tree fetch. */
  treeUrl: null,
  /** (groupId) => void, when the gear on a grouping box is clicked. */
  onGroupEdit: null,
};

/* ── DOM refs ────────────────────────────────────────────────────── */
export const $viewport   = document.getElementById("oc-viewport");
export const $canvas     = document.getElementById("oc-canvas");
export const $tree       = document.getElementById("oc-tree");
const $svg        = document.getElementById("oc-connectors");
const $loading    = document.getElementById("oc-loading");
const $breadcrumb = document.getElementById("oc-breadcrumb");
const $zoomLevel  = document.getElementById("oc-zoom-level");
const $search     = document.getElementById("oc-search");
const $searchRes  = document.getElementById("oc-search-results");
const $snapSelect = document.getElementById("oc-snap-select");
const $clearAll   = document.getElementById("oc-clear-filters");
const $thBar      = document.getElementById("oc-threshold-bar");
const $thMetric   = document.getElementById("oc-th-metric");
const $thValue    = document.getElementById("oc-th-value");
const $filterSum  = document.getElementById("oc-filter-summary");

export const isReady = !!$viewport;

/* ── Formatting helpers ──────────────────────────────────────────── */
export function fmtCount(n) {
  if (n == null) return "—";
  return n.toLocaleString();
}

export function fmtCurrency(n) {
  if (n == null) return "N/A";
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(0) + "K";
  return "$" + Math.round(n).toLocaleString();
}

function fmtPct(n) {
  if (n == null) return "—";
  return n.toFixed(1) + "%";
}

function fmtDecimal(n) {
  if (n == null) return "—";
  return n.toFixed(1);
}

function levelAbbrev(level) {
  if (!level) return "";
  const l = level.toUpperCase();
  const map = {
    "CEO": "CEO", "C-SUITE": "C", "PRESIDENT": "PRES",
    "SVP": "SVP", "SENIOR VICE PRESIDENT": "SVP",
    "VP": "VP", "VICE PRESIDENT": "VP",
    "DIRECTOR": "DIR", "SENIOR DIRECTOR": "SDIR",
    "MANAGER": "MGR", "SENIOR MANAGER": "SMGR",
    "SUPERVISOR": "SUP", "LEAD": "LEAD",
    "IC": "IC", "INDIVIDUAL CONTRIBUTOR": "IC",
  };
  for (const [k, v] of Object.entries(map)) {
    if (l.includes(k)) return v;
  }
  return level.length > 5 ? level.substring(0, 4).toUpperCase() : level.toUpperCase();
}

export function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : s;
  return d.innerHTML;
}

/* ══════════════════════════════════════════════════════════════════
   Colour-coding the card header by an attribute
   ══════════════════════════════════════════════════════════════════
   The palette is not a taste call — it was computed and validated.

   Slots are the reference categorical hues re-stepped darker so white text
   clears 4.5:1 on every fill, then re-ordered and re-validated as a set,
   because darkening changes the separations. Six slots is the largest set that
   passes every gate with no warning: worst adjacent CVD ΔE 10.7 (target ≥8) and
   worst normal-vision ΔE 20.1 (floor ≥15) against a light card surface. Seven
   scraped through at 8.3 — on the floor rather than clear of it — and eight
   couldn't clear the normal-vision floor in any of the 40,320 orderings.

   So: six hues, fixed order, never cycled. A seventh value folds into "Other"
   in neutral grey rather than inventing a hue. Identity is never carried by
   colour alone — the legend is always shown, and the value is on the card.

   All header text is pure white: at any alpha below 1 the sub-lines drop under
   4.5:1 on the aqua and orange fills, so the name/title/location hierarchy is
   carried by size and weight instead. */

const COLOR_SLOTS = ["#be542a", "#2974d0", "#15855d", "#4a3aa7", "#ac5b79", "#008300"];
const COLOR_OTHER = "#55595f";      // "Other" / "Not set" — deliberately not a hue
const HEADER_DEFAULT = "#1B3A5C";   // the original navy, when colouring is off

export const COLOR_DIMENSIONS = [
  ["", "No colouring"],
  ["site_location", "Location (site)"],
  ["city", "City"],
  ["state", "State"],
  ["department", "Department"],
  ["management_level", "Management level"],
  ["entity", "Entity"],
  ["employee_type", "Employee type"],
  ["__role", "Manager vs individual contributor"],
  ["__overhead", "Overhead vs frontline"],
];

let colorBy = "";
let colorMap = new Map();   // value -> {color, label, count}

/** The value a node takes for the active dimension, including derived ones. */
function dimensionValue(node, dim) {
  if (dim === "__role") {
    return (node.children && node.children.length) || node.child_count
      ? "Manager" : "Individual contributor";
  }
  if (dim === "__overhead") {
    const v = (node.self || {}).is_overhead;
    return v === true ? "Overhead" : v === false ? "Frontline" : "";
  }
  return (node[dim] || "").trim();
}

/**
 * Assign hues over the *whole* tree, not the visible subtree, so focusing or
 * filtering never repaints the survivors — colour follows the entity, not its
 * rank in whatever happens to be on screen.
 */
function buildColorMap() {
  colorMap = new Map();
  if (!colorBy || !fullTree) return;

  const counts = new Map();
  for (const node of flattenTree(fullTree)) {
    const v = dimensionValue(node, colorBy);
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  ranked.slice(0, COLOR_SLOTS.length).forEach(([value, count], i) => {
    colorMap.set(value, { color: COLOR_SLOTS[i], label: value, count });
  });

  const rest = ranked.slice(COLOR_SLOTS.length);
  if (rest.length) {
    colorMap.set("__other", {
      color: COLOR_OTHER,
      label: `Other (${rest.length} more)`,
      count: rest.reduce((sum, [, c]) => sum + c, 0),
    });
  }
}

export function headerColorFor(node) {
  if (!colorBy) return HEADER_DEFAULT;
  const v = dimensionValue(node, colorBy);
  if (!v) return COLOR_OTHER;
  const hit = colorMap.get(v);
  return hit ? hit.color : (colorMap.has("__other") ? COLOR_OTHER : HEADER_DEFAULT);
}

export function getColorBy() { return colorBy; }

export function colorByLabel() {
  return (COLOR_DIMENSIONS.find(d => d[0] === colorBy) || ["", ""])[1];
}

/** Legend entries for consumers outside the chart — the SVG export needs these
 *  so the encoding travels with the picture. */
export function legendEntries() {
  if (!colorBy) return [];
  const out = [...colorMap.values()].map(v => ({ color: v.color, label: v.label }));
  const unset = flattenTree(fullTree).filter(n => !dimensionValue(n, colorBy)).length;
  if (unset) out.push({ color: COLOR_OTHER, label: "Not set" });
  return out;
}

export function setColorBy(dim) {
  colorBy = dim || "";
  buildColorMap();
  try {
    const key = "orgview:colorby:" + CFG.companySlug;
    if (colorBy) localStorage.setItem(key, colorBy);
    else localStorage.removeItem(key);
  } catch (e) { /* private mode — the choice just won't persist */ }
  renderLegend();
  renderTree();
}

/** A legend is mandatory for ≥2 categories: identity must never be colour alone. */
function renderLegend() {
  const $legend = document.getElementById("oc-legend");
  if (!$legend) return;
  if (!colorBy || colorMap.size < 2) {
    $legend.hidden = true;
    $legend.innerHTML = "";
    return;
  }
  const label = (COLOR_DIMENSIONS.find(d => d[0] === colorBy) || ["", colorBy])[1];
  let html = `<span class="oc-legend-title">${esc(label)}</span>`;
  const unset = flattenTree(fullTree).filter(n => !dimensionValue(n, colorBy)).length;
  for (const { color, label: text, count } of colorMap.values()) {
    html += `<span class="oc-legend-item">`
          + `<span class="oc-legend-swatch" style="background:${color}"></span>`
          + `${esc(text)} <span class="oc-legend-count">${count}</span></span>`;
  }
  if (unset) {
    html += `<span class="oc-legend-item">`
          + `<span class="oc-legend-swatch" style="background:${COLOR_OTHER}"></span>`
          + `Not set <span class="oc-legend-count">${unset}</span></span>`;
  }
  $legend.innerHTML = html;
  $legend.hidden = false;
}

function initColorBy() {
  const $select = document.getElementById("oc-colorby");
  if (!$select) return;
  $select.innerHTML = COLOR_DIMENSIONS
    .map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  try {
    const saved = localStorage.getItem("orgview:colorby:" + CFG.companySlug);
    if (saved && COLOR_DIMENSIONS.some(d => d[0] === saved)) colorBy = saved;
  } catch (e) { /* ignore */ }
  $select.value = colorBy;
  $select.addEventListener("change", () => setColorBy($select.value));
}

/* ── Threshold check ─────────────────────────────────────────────── */
function checkThresholds(metrics) {
  const exceeded = {};
  if (!customThreshold) return exceeded;
  const val = metrics[customThreshold.metric];
  if (val != null && val > customThreshold.value) {
    exceeded[customThreshold.metric] = true;
  }
  return exceeded;
}

/* ── Filter match check ──────────────────────────────────────────── */
function nodeMatchesFilters(node) {
  if (filters.role) {
    const v = (node.management_level || "").trim();
    if (!filters.role.has(v)) return false;
  }
  if (filters.location) {
    const v = (node.state || "").trim();
    if (!filters.location.has(v)) return false;
  }
  if (filters.entity) {
    const v = (node.entity || "").trim();
    if (!filters.entity.has(v)) return false;
  }
  return true;
}

function anyFilterActive() {
  return filters.role !== null || filters.location !== null || filters.entity !== null;
}

/* ── Tree traversal helpers ──────────────────────────────────────── */
export function findNode(tree, employeeId) {
  if (!tree) return null;
  const nodes = Array.isArray(tree) ? tree : [tree];
  for (const node of nodes) {
    if (node.employee_id === employeeId) return node;
    if (node.children) {
      const found = findNode(node.children, employeeId);
      if (found) return found;
    }
  }
  return null;
}

export function findParent(tree, employeeId) {
  const nodes = Array.isArray(tree) ? tree : [tree];
  for (const node of nodes) {
    if (!node || !node.children) continue;
    if (node.children.some(c => c.employee_id === employeeId)) return node;
    const found = findParent(node.children, employeeId);
    if (found) return found;
  }
  return null;
}

export function buildPathTo(tree, targetId) {
  const path = [];
  function walk(node) {
    path.push({ employee_id: node.employee_id, full_name: node.full_name });
    if (node.employee_id === targetId) return true;
    if (node.children) {
      for (const ch of node.children) {
        if (walk(ch)) return true;
      }
    }
    path.pop();
    return false;
  }
  if (!tree) return [];
  const nodes = Array.isArray(tree) ? tree : [tree];
  for (const n of nodes) {
    if (walk(n)) return path;
  }
  return [];
}

/** Site if the census gave one, else the town — "Tacoma, WA" beats a blank line. */
export function locationOf(node) {
  const site = (node.site_location || "").trim();
  if (site) return site;
  const city = (node.city || "").trim();
  const state = (node.state || "").trim();
  return [city, state].filter(Boolean).join(", ");
}

export function subtreeHeadcount(node) {
  return (node.metrics && node.metrics.headcount) || 1;
}

/* Walk entire tree and collect all nodes into a flat array. */
export function flattenTree(tree) {
  const result = [];
  function walk(node) {
    result.push(node);
    if (node.children) node.children.forEach(walk);
  }
  if (!tree) return result;
  const nodes = Array.isArray(tree) ? tree : [tree];
  nodes.forEach(walk);
  return result;
}

/* ── Extract unique filter values ────────────────────────────────── */
function extractFilterValues() {
  if (!fullTree) return;
  const roles = new Set(), locations = new Set(), entities = new Set();
  const all = flattenTree(fullTree);
  for (const n of all) {
    if (n.management_level && n.management_level.trim()) roles.add(n.management_level.trim());
    if (n.state && n.state.trim()) locations.add(n.state.trim());
    if (n.entity && n.entity.trim()) entities.add(n.entity.trim());
  }
  filterValues.role = [...roles].sort();
  filterValues.location = [...locations].sort();
  filterValues.entity = [...entities].sort();
}

/* ── Expand helpers ──────────────────────────────────────────────── */
function autoExpand(node, depth) {
  if (!node || depth <= 0) return;
  expandedSet.add(node.employee_id);
  if (node.children) {
    for (const ch of node.children) autoExpand(ch, depth - 1);
  }
}

/* ── Render card HTML ────────────────────────────────────────────── */
export function renderCard(node) {
  const m = node.metrics || {};
  const exceeded = checkThresholds(m);
  const hasThreshold = Object.keys(exceeded).length > 0;
  const isExpanded = expandedSet.has(node.employee_id);
  const hasKids = node.children && node.children.length > 0;
  const isDimmed = anyFilterActive() && !nodeMatchesFilters(node);

  let cls = "oc-card";
  if (hasThreshold) cls += " threshold";
  if (isDimmed) cls += " dimmed";
  if (hooks.cardClass) {
    const extra = hooks.cardClass(node);
    if (extra) cls += " " + extra;
  }

  const tabbable = CFG.mode && CFG.mode !== "view" ? ' tabindex="0"' : "";
  let html = '<div class="' + cls + '" data-eid="' + esc(node.employee_id) + '"' + tabbable + '>';

  // Header
  html += '<div class="oc-card-header" style="background:' + headerColorFor(node) + '">';
  html += '<div>';
  html += '<div class="oc-card-name">' + esc(node.full_name) + '</div>';
  html += '<div class="oc-card-title">' + esc(node.job_title || "") + '</div>';
  const place = locationOf(node);
  if (place) {
    html += '<div class="oc-card-location"><span aria-hidden="true">◎</span> '
          + esc(place) + '</div>';
  }
  if (hooks.decorateCard) {
    const badges = hooks.decorateCard(node);
    if (badges) html += '<div class="oc-card-badges">' + badges + '</div>';
  }
  html += '</div>';
  if (node.management_level) {
    html += '<span class="oc-level-badge">' + esc(levelAbbrev(node.management_level)) + '</span>';
  }
  html += '</div>';

  // Metrics
  html += '<div class="oc-card-metrics">';
  html += metricCell("Headcount", fmtCount(m.headcount), false, exceeded.headcount);
  html += metricCell("Direct Reports", fmtCount(m.direct_report_count));
  if (window.CAN_SEE_PAY !== false) {
    // "Loaded Cost", not "Labor Cost": tree_builder now rolls up
    // fully_loaded_cost || annual_salary, the same rule the scenario impact
    // panel uses, so the two figures reconcile.
    html += metricCell("Loaded Cost", fmtCurrency(m.total_labor_cost), false, exceeded.total_labor_cost);
    html += metricCell("Revenue", m.revenue_managed != null ? fmtCurrency(m.revenue_managed) : null, true);
  }
  html += metricCell("Avg Span", fmtDecimal(m.avg_span_of_control), false, exceeded.avg_span_of_control);
  html += metricCell("Layers", fmtCount(m.num_layers), false, exceeded.num_layers);

  // Overhead % full-width
  html += '<div class="oc-metric oc-metric-overhead">';
  html += '<span class="oc-metric-label">Overhead %</span>';
  html += '<span class="oc-metric-value' + (exceeded.overhead_pct ? ' threshold-val' : '') + '">' + fmtPct(m.overhead_pct) + '</span>';
  html += '</div>';

  html += '</div>';

  // Footer
  if (hasKids) {
    html += '<div class="oc-card-footer">';
    html += '<span class="oc-expand-toggle" data-eid="' + esc(node.employee_id) + '">';
    html += '<span class="oc-chevron' + (isExpanded ? ' expanded' : '') + '">&#9654;</span> ';
    html += m.direct_report_count + ' direct report' + (m.direct_report_count !== 1 ? 's' : '');
    html += '</span>';
    html += '<button class="oc-focus-btn" data-focus="' + esc(node.employee_id) + '">Focus</button>';
    html += '</div>';
  } else if (!node.is_leaf && node.child_count > 0) {
    html += '<div class="oc-card-footer">';
    html += '<span class="oc-expand-toggle">' + node.child_count + ' reports</span>';
    html += '<button class="oc-focus-btn" data-focus="' + esc(node.employee_id) + '">Focus</button>';
    html += '</div>';
  }

  html += '</div>';

  // Collapse badge
  if (hasKids && !isExpanded) {
    const count = subtreeHeadcount(node) - 1;
    if (count > 0) {
      html += '<div class="oc-collapse-badge"><span class="oc-collapse-pill">' + fmtCount(count) + ' people below</span></div>';
    }
  }

  return html;
}

function metricCell(label, value, isRevenue, isThreshold) {
  let cls = "oc-metric-value";
  if (isRevenue && value == null) {
    return '<div class="oc-metric"><span class="oc-metric-label">' + label + '</span><span class="oc-metric-value na">N/A</span></div>';
  }
  if (isThreshold) cls += " threshold-val";
  return '<div class="oc-metric"><span class="oc-metric-label">' + label + '</span><span class="' + cls + '">' + (value || "—") + '</span></div>';
}

/* ── Render tree ─────────────────────────────────────────────────── */
export function renderTree() {
  if (!viewRoot) {
    if ($tree) $tree.innerHTML = "";
    return;
  }
  // Anchors depend on where people currently sit, so resolve them against the
  // tree as it stands — including any optimistic, still-unsaved moves.
  indexGroups();
  $tree.innerHTML = renderNodeGroup(viewRoot);
  $loading.style.display = "none";
  if (hooks.afterRender) hooks.afterRender();
  requestAnimationFrame(() => {
    drawConnectors();
    applyTransform();
  });
}

function renderNodeGroup(node) {
  const isExpanded = expandedSet.has(node.employee_id);
  const hasKids = node.children && node.children.length > 0;

  let html = '<div class="oc-node-group" data-nid="' + esc(node.employee_id) + '">';
  html += renderCard(node);

  if (hasKids) {
    html += '<div class="oc-children' + (isExpanded ? '' : ' collapsed') + '">';
    html += renderChildren(node);
    html += '</div>';
  }

  html += '</div>';
  return html;
}

/* ── Decorative grouping boxes ───────────────────────────────────── */

let chartGroups = [];
/** Rebuilt on every render: where each box hangs, and who is inside one. */
let groupIndex = { byAnchor: new Map(), memberOf: new Map(), resolved: new Map() };

/** Replace the set of grouping boxes. Purely presentational — no data changes. */
export function setGroups(groups) {
  chartGroups = groups || [];
  for (const g of chartGroups) {
    // Decluttering only helps if the box starts closed.
    if (!g.collapsed_by_default) expandedSet.add(groupKey(g.id));
  }
  indexGroups();
}

export function getGroups() { return chartGroups; }
export function groupKey(id) { return "grp:" + id; }
export function resolvedGroup(id) { return groupIndex.resolved.get(String(id)) || null; }

function indexGroups() {
  groupIndex = resolveGroups(fullTree, chartGroups);
}

export function toggleGroup(id) {
  const key = groupKey(id);
  if (expandedSet.has(key)) expandedSet.delete(key);
  else expandedSet.add(key);
  renderTree();
}

/** A node's children, with grouped people pulled out into boxes. */
function renderChildren(node) {
  const boxes = groupIndex.byAnchor.get(node.employee_id) || [];
  const anyGroups = boxes.length || groupIndex.memberOf.size;
  if (!anyGroups) return node.children.map(renderNodeGroup).join("");

  let html = "";
  for (const g of boxes) {
    // Members can live anywhere in the tree, so look them up globally rather
    // than among this node's children.
    const members = g.memberIds.map(id => findNode(fullTree, id)).filter(Boolean);
    if (members.length) html += renderGroupBox(g, members, node.employee_id);
  }
  // Anyone in a box — this one or another — is drawn there, not here.
  for (const ch of node.children) {
    if (!groupIndex.memberOf.has(ch.employee_id)) html += renderNodeGroup(ch);
  }
  return html;
}

function renderGroupBox(group, members, anchorId) {
  const key = groupKey(group.id);
  const open = expandedSet.has(key);

  let headcount = 0, cost = 0, hasCost = false;
  for (const m of members) {
    const mm = m.metrics || {};
    headcount += mm.headcount || 1;
    if (mm.total_labor_cost != null) { cost += mm.total_labor_cost; hasCost = true; }
  }
  const showCost = hasCost && window.CAN_SEE_PAY !== false;

  // Rendered as a .oc-node-group wrapping a .oc-card so the existing connector
  // maths, hit-testing and collapse machinery all work on it unchanged.
  let html = '<div class="oc-node-group" data-nid="' + esc(key) + '">';
  html += '<div class="oc-card oc-group-card accent-' + esc(group.accent || "sand")
        + '" data-group="' + esc(group.id) + '">';

  html += '<div class="oc-group-header">';
  html += '<span class="oc-group-name">' + esc(group.name) + '</span>';
  if (CFG.canEdit) {
    html += '<button class="oc-group-edit" data-group-edit="' + esc(group.id)
          + '" title="Edit this group" aria-label="Edit group">&#9881;</button>';
  }
  html += '</div>';

  html += '<div class="oc-group-stats">';
  html += '<div class="oc-group-stat"><span class="oc-group-figure">' + fmtCount(headcount)
        + '</span><span class="oc-group-unit">' + (headcount === 1 ? 'person' : 'people')
        + '</span></div>';
  if (showCost) {
    html += '<div class="oc-group-stat"><span class="oc-group-figure">' + fmtCurrency(cost)
          + '</span><span class="oc-group-unit">loaded cost</span></div>';
  }
  html += '</div>';

  // A box is free to hold anyone, which means it can quietly disagree with the
  // reporting lines. Say so on its face rather than letting the chart mislead.
  const elsewhere = members.filter(m => m.raw_supervisor_id !== anchorId).length;
  if (elsewhere) {
    html += '<div class="oc-group-note" title="These people are drawn here but '
          + 'report elsewhere. Grouping changes nothing about reporting lines.">'
          + elsewhere + ' of ' + members.length + ' report elsewhere</div>';
  }

  html += '<div class="oc-card-footer oc-group-footer">';
  html += '<span class="oc-expand-toggle">';
  html += '<span class="oc-chevron' + (open ? ' expanded' : '') + '">&#9654;</span> ';
  html += members.length + (members.length === 1 ? ' person' : ' people');
  html += '</span>';
  html += '<span class="oc-group-hint">' + (open ? 'Collapse' : 'Expand') + '</span>';
  html += '</div>';

  html += '</div>';

  html += '<div class="oc-children' + (open ? '' : ' collapsed') + '">';
  html += members.map(renderNodeGroup).join("");
  html += '</div>';

  html += '</div>';
  return html;
}

/* ── SVG Connectors ──────────────────────────────────────────────── */
export function drawConnectors() {
  const treeRect = $tree.getBoundingClientRect();
  $svg.setAttribute("width", treeRect.width);
  $svg.setAttribute("height", treeRect.height);
  $svg.style.width = treeRect.width + "px";
  $svg.style.height = treeRect.height + "px";
  $svg.style.transformOrigin = "0 0";
  $svg.style.transform = $canvas.style.transform;

  let paths = "";
  const groups = $tree.querySelectorAll(".oc-node-group");
  groups.forEach(group => {
    const childrenContainer = group.querySelector(":scope > .oc-children");
    if (!childrenContainer || childrenContainer.classList.contains("collapsed")) return;

    const parentCard = group.querySelector(":scope > .oc-card");
    if (!parentCard) return;

    const childGroups = childrenContainer.querySelectorAll(":scope > .oc-node-group");
    if (childGroups.length === 0) return;

    const pRect = parentCard.getBoundingClientRect();
    const tRef  = $tree.getBoundingClientRect();

    const px = (pRect.left + pRect.width / 2 - tRef.left) / zoom;
    const py = (pRect.bottom - tRef.top) / zoom;

    const childPoints = [];
    childGroups.forEach(cg => {
      const cCard = cg.querySelector(":scope > .oc-card");
      if (!cCard) return;
      const cRect = cCard.getBoundingClientRect();
      childPoints.push({
        x: (cRect.left + cRect.width / 2 - tRef.left) / zoom,
        y: (cRect.top - tRef.top) / zoom
      });
    });

    if (childPoints.length === 0) return;

    const midY = py + (childPoints[0].y - py) / 2;

    paths += '<path d="M' + px + ' ' + py + ' L' + px + ' ' + midY + '" />';

    if (childPoints.length === 1) {
      paths += '<path d="M' + px + ' ' + midY + ' L' + childPoints[0].x + ' ' + childPoints[0].y + '" />';
    } else {
      const leftX  = Math.min(...childPoints.map(p => p.x));
      const rightX = Math.max(...childPoints.map(p => p.x));
      paths += '<path d="M' + leftX + ' ' + midY + ' L' + rightX + ' ' + midY + '" />';
      childPoints.forEach(cp => {
        paths += '<path d="M' + cp.x + ' ' + midY + ' L' + cp.x + ' ' + cp.y + '" />';
      });
    }
  });

  $svg.innerHTML = '<g fill="none" stroke="#90a4ae" stroke-width="2">' + paths + '</g>';
}

/* ── Transform ───────────────────────────────────────────────────── */
export function applyTransform() {
  const t = "translate(" + panX + "px, " + panY + "px) scale(" + zoom + ")";
  $canvas.style.transform = t;
  $svg.style.transform = t;
  $zoomLevel.textContent = Math.round(zoom * 100) + "%";
}

export function centerView() {
  const vw = $viewport.clientWidth;
  const tw = $tree.offsetWidth * zoom;
  panX = Math.max(0, (vw - tw) / 2);
  panY = 20;
  applyTransform();
}

export function getZoom() { return zoom; }
export function getPan() { return { x: panX, y: panY }; }
export function setPan(x, y) { panX = x; panY = y; }
export function hideConnectors(hide) { $svg.style.visibility = hide ? "hidden" : ""; }

/* ── Zoom controls ───────────────────────────────────────────────── */
function initViewportControls() {
  document.getElementById("oc-zoom-in").addEventListener("click", () => {
    zoom = Math.min(MAX_ZOOM, zoom + ZOOM_STEP);
    applyTransform();
    requestAnimationFrame(drawConnectors);
  });

  document.getElementById("oc-zoom-out").addEventListener("click", () => {
    zoom = Math.max(MIN_ZOOM, zoom - ZOOM_STEP);
    applyTransform();
    requestAnimationFrame(drawConnectors);
  });

  document.getElementById("oc-zoom-fit").addEventListener("click", () => {
    zoom = 1;
    centerView();
    requestAnimationFrame(drawConnectors);
  });

  $viewport.addEventListener("wheel", e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta));
    if (newZoom === zoom) return;

    const rect = $viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const scale = newZoom / zoom;
    panX = mx - scale * (mx - panX);
    panY = my - scale * (my - panY);
    zoom = newZoom;

    applyTransform();
    requestAnimationFrame(drawConnectors);
  }, { passive: false });

  /* ── Pan ───────────────────────────────────────────────────────── */
  /* Unchanged from the pre-edit-shell version, deliberately. The card guard
     below already stops a press on a card from starting a pan, in every mode —
     making it conditional on edit mode would *newly* pan on a View-mode card
     press, which is a regression. */
  let isPanning = false, panStartX, panStartY;

  $viewport.addEventListener("mousedown", e => {
    if (e.target.closest(".oc-card") || e.target.closest(".oc-focus-btn")) return;
    isPanning = true;
    panStartX = e.clientX - panX;
    panStartY = e.clientY - panY;
    $viewport.classList.add("grabbing");
  });

  window.addEventListener("mousemove", e => {
    if (!isPanning) return;
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    applyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (isPanning) {
      isPanning = false;
      $viewport.classList.remove("grabbing");
      requestAnimationFrame(drawConnectors);
    }
  });

  /* ── Click handlers (expand/collapse, focus) ─────────────────────── */
  $tree.addEventListener("click", e => {
    const focusBtn = e.target.closest(".oc-focus-btn");
    if (focusBtn) {
      e.stopPropagation();
      focusOnNode(focusBtn.dataset.focus);
      return;
    }

    // Group boxes come first: they are .oc-card too (so connectors and
    // hit-testing work on them unchanged) but they aren't people.
    const groupCard = e.target.closest(".oc-group-card");
    if (groupCard) {
      const gid = groupCard.dataset.group;
      if (e.target.closest("[data-group-edit]")) {
        e.stopPropagation();
        if (hooks.onGroupEdit) hooks.onGroupEdit(gid);
        return;
      }
      toggleGroup(gid);
      return;
    }

    const card = e.target.closest(".oc-card");
    if (card) {
      const eid = card.dataset.eid;
      const node = findNode(viewRoot, eid);
      // In an edit mode the shell claims the click (selection); it hands the
      // click back only for the footer's expand toggle, so collapse stays
      // reachable. In view mode there is no hook and behaviour is unchanged.
      if (hooks.onCardClick && hooks.onCardClick(eid, node, e)) return;
      if (!node || !node.children || node.children.length === 0) return;

      toggleCollapse(eid);
    }
  });

  // Keyboard path: Tab to a card, Enter to open the panel.
  $tree.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".oc-card");
    if (!card) return;
    e.preventDefault();
    card.click();
  });
}

export function toggleCollapse(eid) {
  const node = findNode(viewRoot, eid);
  if (!node) return;
  if (expandedSet.has(eid)) {
    collapseSubtree(node);
  } else {
    expandedSet.add(eid);
  }
  renderTree();
  requestAnimationFrame(centerView);
}

function collapseSubtree(node) {
  expandedSet.delete(node.employee_id);
  if (node.children) {
    for (const ch of node.children) collapseSubtree(ch);
  }
}

export function expandNode(eid) { expandedSet.add(eid); }

/* ── Re-root (focus) ─────────────────────────────────────────────── */
export function focusOnNode(employeeId) {
  const node = findNode(fullTree, employeeId);
  if (!node) return;
  viewRoot = node;
  focusPath = buildPathTo(fullTree, employeeId);
  expandedSet.clear();
  autoExpand(viewRoot, DEFAULT_EXPAND_DEPTH);
  renderTree();
  renderBreadcrumb();
  requestAnimationFrame(centerView);
}

/* ── Breadcrumb ──────────────────────────────────────────────────── */
function renderBreadcrumb() {
  let html = '<a href="' + esc(CFG.indexUrl) + '">Portfolio</a><span class="sep">/</span>';

  if (focusPath.length === 0) {
    html += '<span class="current">' + esc(COMPANY) + '</span>';
  } else {
    html += '<a href="#" data-bc-reset>' + esc(COMPANY) + '</a>';
    for (let i = 0; i < focusPath.length; i++) {
      html += '<span class="sep">/</span>';
      if (i === focusPath.length - 1) {
        html += '<span class="current">' + esc(focusPath[i].full_name) + '</span>';
      } else {
        html += '<a href="#" data-bc-eid="' + esc(focusPath[i].employee_id) + '">' + esc(focusPath[i].full_name) + '</a>';
      }
    }
  }

  $breadcrumb.innerHTML = html;
}

function initBreadcrumb() {
  $breadcrumb.addEventListener("click", e => {
    const a = e.target.closest("a");
    if (!a) return;
    if (!a.hasAttribute("data-bc-reset") && !a.dataset.bcEid) return;
    e.preventDefault();
    if (a.hasAttribute("data-bc-reset")) resetToRoot();
    else focusOnNode(a.dataset.bcEid);
  });
}

export function resetToRoot() {
  const root = Array.isArray(fullTree) ? fullTree[0] : fullTree;
  viewRoot = root;
  focusPath = [];
  expandedSet.clear();
  autoExpand(viewRoot, DEFAULT_EXPAND_DEPTH);
  renderTree();
  renderBreadcrumb();
  requestAnimationFrame(centerView);
}

/* ══════════════════════════════════════════════════════════════════
   SEARCH — client-side with API fallback
   ══════════════════════════════════════════════════════════════════ */
let searchTimeout = null;

function clientSearch(q) {
  if (!fullTree) return [];
  const lower = q.toLowerCase();
  const all = flattenTree(fullTree);
  const results = [];
  for (const n of all) {
    const haystack = [
      n.full_name || "",
      n.first_name || "",
      n.last_name || "",
      n.job_title || "",
      n.employee_id || ""
    ].join(" ").toLowerCase();
    if (haystack.includes(lower)) {
      results.push(n);
      if (results.length >= 10) break;
    }
  }
  return results;
}

function highlightMatch(text, query) {
  if (!text) return "";
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return esc(text);
  return esc(text.substring(0, idx)) + '<mark>' + esc(text.substring(idx, idx + query.length)) + '</mark>' + esc(text.substring(idx + query.length));
}

function initSearch() {
  $search.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const q = $search.value.trim();
    if (q.length < 2) {
      $searchRes.classList.remove("open");
      return;
    }
    searchTimeout = setTimeout(() => doSearch(q), 150);
  });

  $search.addEventListener("blur", () => {
    setTimeout(() => $searchRes.classList.remove("open"), 200);
  });

  $searchRes.addEventListener("click", e => {
    const item = e.target.closest(".oc-search-result");
    if (!item || !item.dataset.eid) return;
    $search.value = "";
    $searchRes.classList.remove("open");
    navigateToEmployee(item.dataset.eid);
  });
}

function doSearch(q) {
  const results = clientSearch(q);

  if (results.length === 0) {
    // Fallback to API search
    fetch(API_BASE + "/employees/search/?q=" + encodeURIComponent(q) + "&limit=10")
      .then(r => r.ok ? r.json() : [])
      .then(apiResults => {
        if (apiResults.length === 0) {
          $searchRes.innerHTML = '<div class="oc-search-results-header">No results found</div>';
        } else {
          $searchRes.innerHTML = '<div class="oc-search-results-header">Results (server)</div>' +
            apiResults.map(r =>
              '<div class="oc-search-result" data-eid="' + esc(r.employee_id) + '">' +
              '<div class="sr-name">' + esc(r.full_name) + '</div>' +
              '<div class="sr-title">' + esc(r.job_title || r.management_level || "") + '</div>' +
              '</div>'
            ).join("");
        }
        $searchRes.classList.add("open");
      })
      .catch(() => {});
    return;
  }

  let html = '<div class="oc-search-results-header">Results for “' + esc(q) + '”</div>';
  for (const n of results) {
    html += '<div class="oc-search-result" data-eid="' + esc(n.employee_id) + '">';
    html += '<div class="sr-name">' + highlightMatch(n.full_name, q) + '</div>';
    html += '<div class="sr-title">' + highlightMatch(n.job_title || "", q) + '</div>';
    if (n.employee_id.toLowerCase().includes(q.toLowerCase())) {
      html += '<div class="sr-id">ID: ' + highlightMatch(n.employee_id, q) + '</div>';
    }
    html += '</div>';
  }
  $searchRes.innerHTML = html;
  $searchRes.classList.add("open");
}

export function navigateToEmployee(eid) {
  const path = buildPathTo(fullTree, eid);
  if (path.length === 0) return;

  // Expand all ancestors
  for (const p of path) expandedSet.add(p.employee_id);

  // Focus on parent so the target card is visible as a child
  if (path.length >= 2) {
    focusOnNode(path[path.length - 2].employee_id);
    // Re-expand the target too in case focusOnNode cleared it
    for (const p of path) expandedSet.add(p.employee_id);
    renderTree();
    renderBreadcrumb();
  } else {
    focusOnNode(eid);
  }

  // Highlight the target card briefly
  requestAnimationFrame(() => {
    const card = $tree.querySelector('.oc-card[data-eid="' + CSS.escape(eid) + '"]');
    if (card) {
      card.style.boxShadow = "0 0 0 3px var(--accent), 0 0 16px rgba(164,146,117,0.4)";
      card.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      setTimeout(() => { card.style.boxShadow = ""; }, 2500);
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   FILTER DROPDOWNS
   ══════════════════════════════════════════════════════════════════ */
const filterConfig = {
  role:     { dropdown: document.getElementById("oc-fd-role"),     field: "management_level", label: "Role Type" },
  location: { dropdown: document.getElementById("oc-fd-location"), field: "state",            label: "Location" },
  entity:   { dropdown: document.getElementById("oc-fd-entity"),   field: "entity",           label: "Entity" },
};

function buildFilterDropdown(key) {
  const cfg = filterConfig[key];
  const values = filterValues[key];
  const dd = cfg.dropdown;

  if (values.length === 0) {
    dd.innerHTML = '<div style="padding:0.5rem 0.7rem;color:var(--text-muted);font-size:0.78rem;">No values found</div>';
    return;
  }

  let html = '';
  for (const v of values) {
    const checked = filters[key] === null || filters[key].has(v);
    html += '<label><input type="checkbox" data-fkey="' + key + '" value="' + esc(v) + '"' + (checked ? ' checked' : '') + ' /> ' + esc(v || "(blank)") + '</label>';
  }
  html += '<div class="fdd-actions">';
  html += '<button class="fdd-link" data-fdd-action="all" data-fkey="' + key + '">Select All</button>';
  html += '<button class="fdd-link" data-fdd-action="none" data-fkey="' + key + '">Select None</button>';
  html += '</div>';
  dd.innerHTML = html;
}

function buildAllFilterDropdowns() {
  for (const key of Object.keys(filterConfig)) {
    buildFilterDropdown(key);
  }
}

function closeAllDropdowns() {
  for (const key of Object.keys(filterConfig)) {
    filterConfig[key].dropdown.classList.remove("open");
  }
  document.querySelectorAll(".oc-filter-btn[data-filter]").forEach(b => b.classList.remove("active"));
}

function initFilters() {
  document.getElementById("oc-filters").addEventListener("click", e => {
    const btn = e.target.closest(".oc-filter-btn[data-filter]");
    if (!btn) return;

    const key = btn.dataset.filter;
    const dd = filterConfig[key].dropdown;
    const isOpen = dd.classList.contains("open");

    closeAllDropdowns();

    if (!isOpen) {
      dd.classList.add("open");
      btn.classList.add("active");
    }
  });

  document.addEventListener("click", e => {
    if (!e.target.closest(".oc-dropdown-anchor") && !e.target.closest(".oc-filter-btn[data-filter]")) {
      closeAllDropdowns();
    }
  });

  document.getElementById("oc-filters").addEventListener("change", e => {
    const cb = e.target;
    if (cb.type !== "checkbox" || !cb.dataset.fkey) return;
    applyFilterFromCheckboxes(cb.dataset.fkey);
  });

  document.getElementById("oc-filters").addEventListener("click", e => {
    const actionBtn = e.target.closest("[data-fdd-action]");
    if (!actionBtn) return;

    const key = actionBtn.dataset.fkey;
    const dd = filterConfig[key].dropdown;
    const all = actionBtn.dataset.fddAction === "all";

    dd.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = all; });
    applyFilterFromCheckboxes(key);
  });

  $clearAll.addEventListener("click", () => {
    filters.role = null;
    filters.location = null;
    filters.entity = null;
    buildAllFilterDropdowns();
    updateFilterUI();
    renderTree();
    requestAnimationFrame(drawConnectors);
  });
}

function applyFilterFromCheckboxes(key) {
  const dd = filterConfig[key].dropdown;
  const checkboxes = dd.querySelectorAll('input[type="checkbox"]');
  const checked = new Set();
  let allChecked = true;

  checkboxes.forEach(cb => {
    if (cb.checked) checked.add(cb.value);
    else allChecked = false;
  });

  if (allChecked || checked.size === 0) {
    filters[key] = null;  // No filter
  } else {
    filters[key] = checked;
  }

  updateFilterUI();
  renderTree();
  requestAnimationFrame(drawConnectors);
}

function updateFilterUI() {
  for (const key of Object.keys(filterConfig)) {
    const btn = document.querySelector('.oc-filter-btn[data-filter="' + key + '"]');
    const existingBadge = btn.querySelector(".oc-filter-count");
    if (existingBadge) existingBadge.remove();

    if (filters[key]) {
      const badge = document.createElement("span");
      badge.className = "oc-filter-count";
      badge.textContent = filters[key].size;
      btn.appendChild(badge);
    }
  }

  $clearAll.classList.toggle("visible", anyFilterActive());
  updateFilterSummary();
}

function updateFilterSummary() {
  const parts = [];
  if (filters.role) parts.push("<strong>" + [...filters.role].slice(0, 3).join(", ") + (filters.role.size > 3 ? " +" + (filters.role.size - 3) : "") + "</strong>");
  if (filters.location) parts.push("<strong>" + [...filters.location].slice(0, 3).join(", ") + (filters.location.size > 3 ? " +" + (filters.location.size - 3) : "") + "</strong>");
  if (filters.entity) parts.push("<strong>" + [...filters.entity].slice(0, 2).join(", ") + (filters.entity.size > 2 ? " +" + (filters.entity.size - 2) : "") + "</strong>");

  if (parts.length > 0) {
    $filterSum.innerHTML = "Showing: " + parts.join(" &middot; ");
    $filterSum.classList.add("visible");
  } else {
    $filterSum.classList.remove("visible");
  }
}

/* ══════════════════════════════════════════════════════════════════
   THRESHOLD HIGHLIGHTING
   ══════════════════════════════════════════════════════════════════ */
function initThresholds() {
  const $thToggle = document.getElementById("oc-threshold-toggle");

  $thToggle.addEventListener("click", () => {
    closeAllDropdowns();
    const isOpen = $thBar.classList.contains("open");
    if (isOpen) {
      closeThresholdBar();
    } else {
      $thBar.classList.add("open");
      $thToggle.classList.add("active");
    }
  });

  document.getElementById("oc-th-apply").addEventListener("click", () => {
    const metric = $thMetric.value;
    const value = parseFloat($thValue.value);
    if (isNaN(value)) return;

    customThreshold = { metric, value };
    renderTree();
    requestAnimationFrame(drawConnectors);
  });

  document.getElementById("oc-th-close").addEventListener("click", closeThresholdBar);

  function closeThresholdBar() {
    $thBar.classList.remove("open");
    $thToggle.classList.remove("active");
    if (customThreshold) {
      customThreshold = null;
      renderTree();
      requestAnimationFrame(drawConnectors);
    }
  }

  $thMetric.addEventListener("change", () => {
    const defaults = {
      avg_span_of_control: 10,
      headcount: 100,
      num_layers: 5,
      total_labor_cost: 1000000,
      overhead_pct: 25,
    };
    $thValue.value = defaults[$thMetric.value] || 10;
  });
}

/* ── Data loading ────────────────────────────────────────────────── */
export function getSnapshotId() { return snapshotId; }

export function setTree(tree) {
  fullTree = tree;
  const root = Array.isArray(fullTree) ? fullTree[0] : fullTree;
  viewRoot = root;
  focusPath = [];
  expandedSet.clear();
  autoExpand(root, DEFAULT_EXPAND_DEPTH);
  extractFilterValues();
  buildAllFilterDropdowns();
  updateFilterUI();
  buildColorMap();
  renderLegend();
  renderTree();
  renderBreadcrumb();
  requestAnimationFrame(centerView);
}

/** Swap in a re-derived tree while keeping expansion, focus and pan.
 *  Used after every optimistic edit — setTree() would throw the user back to
 *  the root, which is unusable mid-cleanup. */
export function refreshTree(tree) {
  fullTree = tree;
  const roots = Array.isArray(fullTree) ? fullTree : [fullTree];
  const focusedId = viewRoot && viewRoot.employee_id;
  viewRoot = (focusedId && findNode(fullTree, focusedId)) || roots[0] || null;
  if (focusedId && viewRoot && viewRoot.employee_id !== focusedId) focusPath = [];
  else if (focusedId) focusPath = buildPathTo(fullTree, focusedId);
  extractFilterValues();
  // Recomputed against the whole tree, so a staged move can't repaint anyone
  // it didn't touch.
  buildColorMap();
  renderLegend();
  renderTree();
  renderBreadcrumb();
}

export async function loadTree() {
  $loading.style.display = "flex";
  $tree.innerHTML = "";
  document.getElementById("oc-connectors").innerHTML = "";

  try {
    const url = (hooks.treeUrl && hooks.treeUrl())
      || (API_BASE + "/org-tree/?snapshot_id=" + snapshotId);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Failed to load org tree");
    const data = await resp.json();

    window.CAN_SEE_PAY = data.can_see_pay !== false;

    // Reset filters on new data
    filters = { role: null, location: null, entity: null };
    customThreshold = null;

    setTree(data.tree);
    if (hooks.onTreeLoaded) hooks.onTreeLoaded(data);
    return data;
  } catch (err) {
    $loading.innerHTML = '<div class="oc-empty"><p>Failed to load org chart data.</p><a href="'
      + esc(CFG.indexUrl) + '">&larr; Back to Dashboard</a></div>';
    return null;
  }
}

/* ── Init ────────────────────────────────────────────────────────── */
export function init() {
  if (!isReady) return;
  initViewportControls();
  initBreadcrumb();
  initSearch();
  initFilters();
  initThresholds();
  initColorBy();

  if ($snapSelect) {
    $snapSelect.addEventListener("change", () => {
      snapshotId = parseInt($snapSelect.value, 10);
      loadTree();
    });
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawConnectors, 150);
  });
}
