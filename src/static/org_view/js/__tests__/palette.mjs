/* The card-header palette is a computed result, not a taste call — this pins it.
 *
 * The hues are the reference categorical slots re-stepped darker so white text
 * clears 4.5:1 on every fill, then re-ordered and re-validated as a set (which
 * darkening makes necessary, since it moves every separation). Six is the
 * largest warn-free set; seven only reached the CVD floor, and no ordering of
 * eight cleared the normal-vision floor.
 *
 * These assertions restate the gates so that swapping a hex for one that "looks
 * nicer" fails here instead of quietly shipping a chart that colourblind readers
 * — or anyone reading white text on it — can't use.
 *
 * Run: node src/static/org_view/js/__tests__/palette.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "chart.js"), "utf8");

function hexList(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]+)\\]`));
  assert.ok(m, `${name} should be declared in chart.js`);
  return m[1].match(/#[0-9a-fA-F]{6}/g) || [];
}
function hexConst(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*"(#[0-9a-fA-F]{6})"`));
  assert.ok(m, `${name} should be declared in chart.js`);
  return m[1];
}

const SLOTS = hexList("COLOR_SLOTS");
const OTHER = hexConst("COLOR_OTHER");
const DEFAULT_HEADER = hexConst("HEADER_DEFAULT");

/* ── WCAG contrast ───────────────────────────────────────────────── */
const chan = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = h => { const [r, g, b] = rgb(h).map(chan); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/* ── OKLab + CVD, matching the validator ─────────────────────────── */
function oklab(hex) {
  const [r, g, b] = rgb(hex).map(chan);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
/** Brettel-style approximation, same shape the skill's validator uses. */
function simulate(hex, kind) {
  let [r, g, b] = rgb(hex).map(chan);
  if (kind === "protan") { const R = 0.152 * g + 0.884 * b - 0.036 * r; r = R < 0 ? 0 : R; }
  if (kind === "deutan") { const G = 0.367 * r + 0.861 * b - 0.228 * g; g = G < 0 ? 0 : G; }
  const back = c => {
    c = Math.max(0, Math.min(1, c));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  return "#" + [r, g, b].map(c => back(c).toString(16).padStart(2, "0")).join("");
}
const dE = (a, b) => {
  const [l1, a1, b1] = oklab(a), [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
};

let checks = 0;
function check(name, fn) {
  try { fn(); checks += 1; }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

check("six slots — the largest set that validated warn-free", () => {
  assert.equal(SLOTS.length, 6,
    "seven slots only reached the CVD floor and eight failed the normal-vision "
    + "floor in every ordering; a 7th value must fold into Other");
});

check("white body text clears 4.5:1 on every fill", () => {
  for (const hex of [...SLOTS, OTHER, DEFAULT_HEADER]) {
    const c = contrast(hex, "#ffffff");
    assert.ok(c >= 4.5, `${hex} gives white text only ${c.toFixed(2)}:1`);
  }
});

check("every fill is distinguishable from the white card body", () => {
  for (const hex of [...SLOTS, OTHER]) {
    const c = contrast(hex, "#ffffff");
    assert.ok(c >= 3, `${hex} is only ${c.toFixed(2)}:1 against the card`);
  }
});

check("adjacent slots clear the normal-vision floor of 15", () => {
  for (let i = 1; i < SLOTS.length; i += 1) {
    const d = dE(SLOTS[i - 1], SLOTS[i]);
    assert.ok(d >= 15, `${SLOTS[i - 1]}↔${SLOTS[i]} ΔE ${d.toFixed(1)} — below 15`);
  }
});

check("adjacent slots clear the CVD target of 8, not merely the floor", () => {
  for (const kind of ["protan", "deutan"]) {
    for (let i = 1; i < SLOTS.length; i += 1) {
      const d = dE(simulate(SLOTS[i - 1], kind), simulate(SLOTS[i], kind));
      assert.ok(d >= 8,
        `${kind}: ${SLOTS[i - 1]}↔${SLOTS[i]} ΔE ${d.toFixed(1)} — below the 8 target`);
    }
  }
});

check("the neutral is not one of the categorical hues", () => {
  assert.ok(!SLOTS.includes(OTHER), "Other must stay neutral, never a hue");
  assert.ok(!SLOTS.includes(DEFAULT_HEADER), "the default navy is not a slot");
});

check("identity never rests on colour alone", () => {
  assert.ok(src.includes("function renderLegend"),
    "a legend must exist whenever colouring is on");
  assert.ok(/oc-card-location/.test(src),
    "the location is on the card as text, not only as a hue");
});

if (process.exitCode) console.error("palette checks FAILED");
else console.log(`palette OK — ${checks} checks over ${SLOTS.length} slots`);
