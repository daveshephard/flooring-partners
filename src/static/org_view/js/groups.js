/* Resolving decorative grouping boxes against the tree.
 *
 * Membership is free-form: a box may hold anyone, and the people in it are
 * drawn inside the box rather than at their usual position. Three things have
 * to be settled before the renderer can draw anything, and all three are pure
 * functions of (tree, groups) — which is why they live here rather than in
 * chart.js, and are unit-tested from __tests__/drag.logic.mjs.
 *
 *   1. Where each box hangs. An explicit parent wins. Otherwise it is the
 *      members' shared manager, or failing that their lowest common ancestor —
 *      so boxing five of the CEO's reps lands under the CEO with no decision
 *      required of the user.
 *   2. Who is actually in it. Members who left the census, or who a
 *      higher-priority box already claimed, are dropped: a person can only be
 *      drawn once.
 *   3. Members that would swallow their own anchor. A box whose member is an
 *      ancestor of its anchor would be rendered inside itself, forever.
 */
"use strict";

export function buildParentMap(tree) {
  const parentOf = new Map();
  const present = new Set();
  const stack = Array.isArray(tree) ? [...tree] : (tree ? [tree] : []);
  while (stack.length) {
    const node = stack.pop();
    present.add(node.employee_id);
    for (const child of node.children || []) {
      parentOf.set(child.employee_id, node.employee_id);
      stack.push(child);
    }
  }
  return { parentOf, present };
}

/** Root → id, guarding against a malformed parent chain. */
export function pathTo(parentOf, id) {
  const path = [];
  const seen = new Set();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.unshift(cur);
    cur = parentOf.get(cur);
  }
  return path;
}

export function lowestCommonAncestor(parentOf, ids) {
  if (!ids.length) return null;
  let common = pathTo(parentOf, ids[0]);
  for (const id of ids.slice(1)) {
    const path = pathTo(parentOf, id);
    let i = 0;
    while (i < common.length && i < path.length && common[i] === path[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.length ? common[common.length - 1] : null;
}

/**
 * @returns {{byAnchor: Map<string, object[]>, memberOf: Map<string,string>,
 *            resolved: Map<string, object>}}
 */
export function resolveGroups(tree, groups) {
  const index = { byAnchor: new Map(), memberOf: new Map(), resolved: new Map() };
  if (!tree || !groups || !groups.length) return index;

  const { parentOf, present } = buildParentMap(tree);
  const isAncestor = (a, b) => a !== b && pathTo(parentOf, b).includes(a);

  const claimed = new Set();
  for (const g of groups) {
    const members = (g.member_ids || []).filter(m => present.has(m) && !claimed.has(m));
    if (!members.length) continue;

    let anchor = String(g.parent_employee_id || "").trim();
    if (!anchor || !present.has(anchor)) {
      const parents = members.map(m => parentOf.get(m)).filter(Boolean);
      const unique = [...new Set(parents)];
      anchor = unique.length === 1 ? unique[0] : lowestCommonAncestor(parentOf, parents);
    }
    if (!anchor || !present.has(anchor)) continue;

    const safe = members.filter(m => m !== anchor && !isAncestor(m, anchor));
    if (!safe.length) continue;

    safe.forEach(m => { claimed.add(m); index.memberOf.set(m, String(g.id)); });
    const resolved = { ...g, anchor, memberIds: safe };
    index.resolved.set(String(g.id), resolved);
    if (!index.byAnchor.has(anchor)) index.byAnchor.set(anchor, []);
    index.byAnchor.get(anchor).push(resolved);
  }
  return index;
}
