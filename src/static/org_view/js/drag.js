/* Pointer-event drag layer for reparenting.
 *
 * NOT the HTML5 drag-and-drop API. The canvas is
 * `transform: translate(panX, panY) scale(zoom)`; HTML5 DnD computes its drag
 * image and hit-testing outside that transform, so the ghost renders at the
 * wrong size, drop targets mis-hit at any zoom other than 1.0, and there is no
 * reliable way to auto-scroll. pointerdown/move/up with setPointerCapture also
 * gives us touch and pen for free.
 *
 * A drop produces exactly the same `reparent` op the side panel produces — this
 * module adds no persistence of its own. If drag breaks, the panel still works.
 *
 * The pure functions at the top are unit-tested from __tests__/drag.logic.mjs.
 */
"use strict";

export const DRAG_THRESHOLD = 6;    // px of *screen* movement before it's a drag
export const EDGE_ZONE      = 70;   // px from the viewport edge
export const MAX_PAN_SPEED  = 18;   // px per frame at the very edge

/* ══════════════════════════════════════════════════════════════════
   Pure logic — no DOM
   ══════════════════════════════════════════════════════════════════ */

function walk(node, fn) {
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

export function findNodeIn(tree, id) {
  if (!tree) return null;
  const roots = Array.isArray(tree) ? tree : [tree];
  for (const r of roots) {
    let hit = null;
    walk(r, n => { if (!hit && n.employee_id === id) hit = n; });
    if (hit) return hit;
  }
  return null;
}

export function findParentIn(tree, id) {
  if (!tree) return null;
  const roots = Array.isArray(tree) ? tree : [tree];
  for (const r of roots) {
    let hit = null;
    walk(r, n => {
      if (!hit && (n.children || []).some(c => c.employee_id === id)) hit = n;
    });
    if (hit) return hit;
  }
  return null;
}

/** Self plus every descendant — the targets a move onto would be a loop. */
export function invalidTargetsFor(tree, employeeId) {
  const bad = new Set([employeeId]);
  const node = findNodeIn(tree, employeeId);
  if (node) {
    for (const child of node.children || []) walk(child, n => bad.add(n.employee_id));
  }
  return bad;
}

/** Everyone at or below branchRootId — what a branch-restricted editor may touch. */
export function branchMembers(tree, branchRootId) {
  if (!branchRootId) return null;
  const root = findNodeIn(tree, branchRootId);
  if (!root) return new Set();
  const members = new Set();
  walk(root, n => members.add(n.employee_id));
  return members;
}

/**
 * Can `draggedId` be dropped onto `targetId`?
 * False for self, own descendants, the current parent (a no-op, treated as a
 * cancel rather than an error), and anything outside a restricted branch.
 * The server re-validates all of this; client checks are feedback only.
 */
export function isValidDrop(tree, draggedId, targetId, branchRootId) {
  // A drop back onto the current parent changes nothing, so it is a cancel — not
  // a valid move. Keeping it out of here is what stops the drag layer staging a
  // no-op reparent and announcing it as staged.
  if (isNoOpDrop(tree, draggedId, targetId)) return false;
  return dropRejection(tree, draggedId, targetId, branchRootId) === null;
}

/**
 * Why a drop can't be made, or null when it can.
 *
 * Separate from isValidDrop so a refused drop can say what was wrong. Silently
 * doing nothing is indistinguishable from the feature being broken — which is
 * exactly how it was reported.
 *
 * Note what is deliberately *not* here: a person's location, department, site
 * or entity never restrict where they can report. Moving someone across sites
 * is a normal reorg, not an error.
 */
export function dropRejection(tree, draggedId, targetId, branchRootId) {
  if (!draggedId || !targetId) return "Dropped outside a card — nothing changed.";
  if (draggedId === targetId) return "A person can't report to themselves.";
  if (invalidTargetsFor(tree, draggedId).has(targetId)) {
    return "That would put someone under their own report.";
  }
  const parent = findParentIn(tree, draggedId);
  if (parent && parent.employee_id === targetId) return null;   // no-op, not an error
  if (branchRootId) {
    const members = branchMembers(tree, branchRootId);
    if (!members.has(targetId)) {
      return "That manager is outside the part of the org you can edit.";
    }
    if (findNodeIn(tree, draggedId) && !members.has(draggedId)) {
      return "That person is outside the part of the org you can edit.";
    }
  }
  return null;
}

/** True when the drop is a no-op rather than a refusal. */
export function isNoOpDrop(tree, draggedId, targetId) {
  const parent = findParentIn(tree, draggedId);
  return !!parent && parent.employee_id === targetId;
}

/**
 * How far to pan this frame when the pointer sits near a viewport edge.
 * 0 outside the zone, ramping linearly to MAX_PAN_SPEED at the edge itself.
 * Panning right (content moves left) is a negative dx, matching panX semantics.
 */
export function edgePanDelta(pointer, rect, zone = EDGE_ZONE, maxSpeed = MAX_PAN_SPEED) {
  let dx = 0, dy = 0;
  const left = pointer.x - rect.left;
  const right = rect.right - pointer.x;
  const top = pointer.y - rect.top;
  const bottom = rect.bottom - pointer.y;

  if (left < zone) dx = ramp(left, zone, maxSpeed);
  else if (right < zone) dx = -ramp(right, zone, maxSpeed);
  if (top < zone) dy = ramp(top, zone, maxSpeed);
  else if (bottom < zone) dy = -ramp(bottom, zone, maxSpeed);

  return { dx, dy };
}

function ramp(distance, zone, maxSpeed) {
  const d = Math.max(0, Math.min(zone, distance));
  return ((zone - d) / zone) * maxSpeed;
}

/* ══════════════════════════════════════════════════════════════════
   The pointer layer
   ══════════════════════════════════════════════════════════════════ */

/**
 * @param {object} api  supplied by edit-shell so drag.js stays free of imports
 *   getTree()            -> the full tree
 *   isEditing()          -> boolean
 *   branchRootId()       -> string|null
 *   onReparent(id, target)
 *   onSetRoot(id)
 *   viewport, container  -> elements
 *   getPan/setPan/applyTransform/hideConnectors/drawConnectors
 *   subtreeCount(id)     -> number below
 *   trayNodeFor(id)      -> a node for a tray row (not in the tree)
 */
export function installDragLayer(api) {
  const { viewport, container } = api;
  if (!viewport || !container) return;

  const pill = document.createElement("div");
  pill.className = "oc-drag-pill";
  pill.hidden = true;
  pill.innerHTML = '<span class="oc-drag-pill-name"></span><span class="oc-drag-pill-count"></span>';
  container.appendChild(pill);

  let pending = null;    // {id, startX, startY, fromTray, el, pointerId}
  let drag = null;       // {id, fromTray, invalid, el}
  let pointer = { x: 0, y: 0 };
  let currentTarget = null;
  let rootHot = false;
  let rafId = null;

  function begin(e, id, el, fromTray) {
    pending = { id, el, fromTray, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId };
    pointer = { x: e.clientX, y: e.clientY };
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    if (fromTray) startDrag();   // tray rows have no competing click behaviour
  }

  function startDrag() {
    if (!pending) return;
    const { id, el, fromTray } = pending;
    // Computed once, here — flattening a large subtree inside pointermove stutters.
    drag = { id, el, fromTray, invalid: invalidTargetsFor(api.getTree(), id) };
    if (el.classList) el.classList.add("oc-dragging");
    document.body.classList.add("oc-drag-active");

    const node = fromTray ? api.trayNodeFor(id) : findNodeIn(api.getTree(), id);
    const below = fromTray ? api.traySubtreeCount(id) : api.subtreeCount(id);
    pill.querySelector(".oc-drag-pill-name").textContent =
      (node && (node.full_name || node.employee_id)) || id;
    // People consistently forget a move takes the whole subtree with it.
    pill.querySelector(".oc-drag-pill-count").textContent = below > 0 ? `+ ${below} below` : "";
    pill.hidden = false;

    // drawConnectors() reads getBoundingClientRect() for every node group and is
    // far too expensive to run mid-drag. Hide the layer, redraw on drop.
    api.hideConnectors(true);
    loop();
  }

  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!drag) return;

    pill.style.transform = `translate(${pointer.x + 14}px, ${pointer.y + 14}px)`;

    const rect = viewport.getBoundingClientRect();
    const { dx, dy } = edgePanDelta(pointer, rect);
    if (dx || dy) {
      const pan = api.getPan();
      api.setPan(pan.x + dx, pan.y + dy);
      api.applyTransform();
    }

    hitTest();
  }

  function hitTest() {
    // elementFromPoint takes viewport coordinates and accounts for CSS
    // transforms, so this is accurate at any zoom or pan with no manual math.
    const el = document.elementFromPoint(pointer.x, pointer.y);
    const rawCard = el && el.closest ? el.closest(".oc-card") : null;
    const inViewport = el && el.closest && el.closest("#oc-viewport");

    // A grouping box is a valid target — dropping onto it files the person into
    // that team — but it is not a person, so it never takes the card path.
    const groupBox = rawCard && rawCard.classList.contains("oc-group-card") ? rawCard : null;
    if (groupBox) {
      if (currentTarget !== groupBox) {
        clearTarget();
        currentTarget = groupBox;
        groupBox.classList.add("oc-drop-valid");
      }
      setRootHot(false);
      return;
    }

    const card = rawCard;
    const targetId = card ? card.dataset.eid : null;
    if (targetId === (currentTarget && currentTarget.dataset.eid)) {
      if (!card) clearTarget();
      setRootHot(!card && !!inViewport);
      return;
    }

    clearTarget();
    setRootHot(!card && !!inViewport);
    if (!card || targetId === drag.id) return;

    currentTarget = card;
    const ok = drag.fromTray
      ? !drag.invalid.has(targetId) && inBranch(targetId)
      : isValidDrop(api.getTree(), drag.id, targetId, api.branchRootId());

    if (ok) card.classList.add("oc-drop-valid");
    else if (isCurrentParent(targetId)) currentTarget = null;   // no highlight; will cancel
    else card.classList.add("oc-drop-invalid");
  }

  function inBranch(id) {
    const root = api.branchRootId();
    if (!root) return true;
    return branchMembers(api.getTree(), root).has(id);
  }

  function isCurrentParent(targetId) {
    if (drag.fromTray) return false;
    const parent = findParentIn(api.getTree(), drag.id);
    return !!parent && parent.employee_id === targetId;
  }

  function clearTarget() {
    if (currentTarget) {
      currentTarget.classList.remove("oc-drop-valid", "oc-drop-invalid");
      currentTarget = null;
    }
  }

  function setRootHot(on) {
    if (on === rootHot) return;
    rootHot = on;
    viewport.classList.toggle("oc-drop-root", on);
  }

  /** The single exit path. Half-cleaned drag state is the classic bug here. */
  function endDrag(committed) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    clearTarget();
    setRootHot(false);
    pill.hidden = true;
    document.body.classList.remove("oc-drag-active");
    if (drag && drag.el && drag.el.classList) drag.el.classList.remove("oc-dragging");
    drag = null;
    pending = null;
    api.hideConnectors(false);
    if (!committed) requestAnimationFrame(api.drawConnectors);
  }

  /* ── Wiring ─────────────────────────────────────────────────────── */

  viewport.addEventListener("pointerdown", e => {
    if (!api.isEditing() || e.button !== 0) return;
    if (e.target.closest(".oc-focus-btn") || e.target.closest(".oc-expand-toggle")) return;
    const card = e.target.closest(".oc-card");
    // Group boxes are drop targets, never drag sources — they have no reporting
    // line of their own to move.
    if (!card || card.classList.contains("oc-group-card") || !card.dataset.eid) return;
    begin(e, card.dataset.eid, card, false);
  });

  document.addEventListener("pointermove", e => {
    if (!pending && !drag) return;
    pointer = { x: e.clientX, y: e.clientY };
    if (!drag) {
      const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
      if (dist < DRAG_THRESHOLD) return;   // still a click, not a drag
      e.preventDefault();
      startDrag();
    }
  }, { passive: false });

  document.addEventListener("pointerup", e => {
    if (!pending && !drag) return;
    if (!drag) { pending = null; return; }   // never crossed the threshold → a click

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const rawCard = el && el.closest ? el.closest(".oc-card") : null;
    const inViewport = el && el.closest && el.closest("#oc-viewport");
    const draggedId = drag.id;
    const fromTray = drag.fromTray;

    if (rawCard && rawCard.classList.contains("oc-group-card")) {
      const groupId = rawCard.dataset.group;
      endDrag(true);
      api.onDropIntoGroup(draggedId, groupId);
      return;
    }

    const card = rawCard;
    const targetId = card ? card.dataset.eid : null;

    const valid = targetId && (fromTray
      ? !drag.invalid.has(targetId) && inBranch(targetId)
      : isValidDrop(api.getTree(), draggedId, targetId, api.branchRootId()));
    const wantsRoot = !card && !!inViewport;

    endDrag(true);

    if (valid) {
      api.onReparent(draggedId, targetId, fromTray);
    } else if (wantsRoot) {
      api.onSetRoot(draggedId, fromTray);
    } else {
      requestAnimationFrame(api.drawConnectors);
      // Say why. A refused drop that looks identical to a broken one is how
      // "the edit doesn't process" gets reported.
      if (targetId && isNoOpDrop(api.getTree(), draggedId, targetId)) {
        api.onRejected("They already report there — nothing to change.");
      } else if (api.onRejected) {
        api.onRejected(dropRejection(
          api.getTree(), draggedId, targetId, api.branchRootId()));
      }
    }
  });

  document.addEventListener("pointercancel", () => { if (drag || pending) endDrag(false); });
  document.addEventListener("lostpointercapture", () => { if (drag) endDrag(false); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && (drag || pending)) endDrag(false);
  });

  return {
    /** Tray rows share the drag layer with a different source. */
    beginFromTray(e, employeeId, el) {
      if (!api.isEditing()) return;
      begin(e, employeeId, el, true);
    },
    endDrag,
  };
}
