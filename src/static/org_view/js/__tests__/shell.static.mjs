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

/* ── The same symptom, reached a second way ───────────────────────────
   Stacking was fixed for $panel's listeners, but nothing stopped two *modals*
   from coexisting in the host. The rail docks beside the chart rather than
   covering it, so the save bar stays clickable while Review is open: press it and
   a second review list lands behind the first, and dismissing the top one reveals
   the other. Reported, again, as the change log appearing twice. */
const openModalStart = src.findIndex(l => /^function openModal\(/.test(l));
assert.ok(openModalStart > -1, "openModal() should still exist");
const openModalEnd = src.findIndex((l, i) => i > openModalStart && /^\}/.test(l));
const openModalBody = src.slice(openModalStart, openModalEnd).join("\n");
assert.match(openModalBody, /if \(liveModal\) liveModal\.close\(/,
  "openModal() must dismiss the modal that is already up, or two can stack");
assert.match(openModalBody, /liveModal = \{ root, close \}/,
  "openModal() must register itself as the live modal");
assert.ok(
  src.some(l => /liveModal\.root === root/.test(l)),
  "close() must clear liveModal, or the next open dismisses an element that's gone");

/* A rejected save has to annotate the list that is already open. Closing it and
   opening an identically-titled replacement is what read as "nothing happened,
   and the log came back". */
assert.ok(
  src.some(l => l.includes('value: "save", keepOpen: true')),
  "the review modal's Save must keep the list open so errors can be shown in place");
assert.ok(
  src.some(l => l.includes("if (reviewCtx) reviewCtx.showErrors(errs)")),
  "a 422 must re-annotate the open review list rather than opening another");
assert.ok(
  src.some(l => l.includes("if (reviewCtx) reviewCtx.close()")),
  "a successful save must close the review list it was launched from");

/* Server errors are indexed by commit order, the review list by staging order.
   They stopped being the same list once adds were hoisted ahead of their
   dependents, so every consumer of a server index has to translate. */
for (const marker of ["/changeset/commit/", "/changeset/validate/"]) {
  const at = src.findIndex(l => l.includes(marker));
  assert.ok(at > -1, `${marker} should still be posted`);
  const window = src.slice(Math.max(0, at - 12), at + 12).join("\n");
  assert.ok(window.includes("commitPayload()"),
    `${marker} must send the dependency-ordered payload, not raw staging order`);
}
assert.ok(
  src.filter(l => /toStagingErrors\(/.test(l)).length >= 3,
  "both the validate and commit paths must translate error indices, and the "
  + "helper must exist");

console.log(`shell static checks OK — scanned ${src.length} lines, no stacking listeners`);
