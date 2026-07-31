/* Static guard: never bind a listener to a long-lived element from a function
 * that runs more than once.
 *
 * This is here because it actually happened. The side panel's click handler was
 * bound inside openPanel(); `$panel` is a persistent element whose innerHTML is
 * swapped on each open, so every open added another live handler. After opening
 * the panel five times a single click on Apply staged five times, and a single
 * click on a button that opens a modal stacked five modals — which looked, from
 * the outside, like the editor "cycling through changes repeatedly".
 *
 * The symptom is miserable to diagnose from the UI and trivial to catch here, so
 * it's caught here. Listeners on these elements must be bound at module scope or
 * from an `init*` function that boot() calls exactly once.
 *
 * Run: node src/static/org_view/js/__tests__/shell.static.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "edit-shell.js");
const src = readFileSync(FILE, "utf8").split(/\r?\n/);

/** Elements that live for the whole page, so their listeners accumulate. */
const PERSISTENT = [
  "$panel", "$tray", "$strip", "$saveBar", "$modalHost", "$toasts",
  "$recovery", "$viewport", "$container", "$modeSwitch", "$addBtn", "$groupsBtn",
  "document", "window",
];

/** Top-level function enclosing a line, or null when at module scope. */
function enclosingFunction(lineNo) {
  for (let i = lineNo; i >= 0; i -= 1) {
    const line = src[i];
    if (/^(async\s+)?function\s+([A-Za-z0-9_]+)/.test(line)) {
      const name = line.match(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)/)[1];
      // Only count it if we're still inside: a line at column 0 that isn't a
      // closing brace ends the previous function body.
      for (let j = i + 1; j < lineNo; j += 1) {
        if (/^\S/.test(src[j]) && !/^\}/.test(src[j])) return null;
        if (/^\}/.test(src[j])) return null;
      }
      return name;
    }
  }
  return null;
}

/** Functions the page runs exactly once, so binding from them is fine. */
const RUNS_ONCE = new Set(["boot", "installDragLayer"]);

/** Source of the top-level function containing `lineNo`, for the paired check. */
function functionBody(lineNo) {
  let start = lineNo;
  while (start >= 0 && !/^(async\s+)?function\s+/.test(src[start])) start -= 1;
  let end = start + 1;
  while (end < src.length && !/^\}/.test(src[end])) end += 1;
  return src.slice(start, end + 1).join("\n");
}

const offenders = [];
src.forEach((line, i) => {
  const m = line.match(/(\$[A-Za-z0-9_]+|document|window)\.addEventListener/);
  if (!m || !PERSISTENT.includes(m[1])) return;
  const fn = enclosingFunction(i);
  if (fn === null) return;              // module scope — bound once
  if (/^init/.test(fn)) return;         // init*() is called once from boot()
  if (RUNS_ONCE.has(fn)) return;
  // A handler that the same function tears down again is balanced, not stacked
  // — openModal adds a document keydown trap and removes it on close.
  if (functionBody(i).includes("removeEventListener")) return;
  offenders.push(`  line ${i + 1}: ${m[1]}.addEventListener inside ${fn}() — `
               + `${fn} can run repeatedly, so this handler stacks.\n      ${line.trim()}`);
});

if (offenders.length) {
  console.error("edit-shell.js binds listeners to persistent elements from "
              + "repeatable functions:\n" + offenders.join("\n"));
  process.exit(1);
}

/* The specific regression: the panel's own handlers live in initPanel(), and
   the per-open function only touches freshly-rendered children. */
const wireStart = src.findIndex(l => /^function wirePanel\(/.test(l));
assert.ok(wireStart > -1, "wirePanel() should still exist");
const wireEnd = src.findIndex((l, i) => i > wireStart && /^\}/.test(l));
const wireBody = src.slice(wireStart, wireEnd).join("\n");
assert.ok(!wireBody.includes("$panel.addEventListener"),
  "wirePanel() runs on every panel open — it must not bind to $panel itself");
assert.ok(src.some(l => /^function initPanel\(/.test(l)),
  "initPanel() should own the panel's delegated handlers");
assert.ok(src.some(l => l.includes("initPanel();")),
  "boot() must call initPanel() so the delegated handlers exist");

console.log(`shell static checks OK — scanned ${src.length} lines, no stacking listeners`);
