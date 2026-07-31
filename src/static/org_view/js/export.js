/* Exporting the chart as a picture.
 *
 * The renderer lays cards out with flexbox and draws connectors from measured
 * rects, which means the browser has already solved the hard problem: after a
 * render, every card's position is known. So this walks the rendered DOM, reads
 * those positions, and re-emits them as a standalone SVG — vector, so it scales
 * in a deck, and self-contained, so it opens anywhere.
 *
 * SVG rather than a screenshot library: there is no build step and no npm here,
 * and a rasterised screenshot of a pan/zoom canvas is the wrong artefact for a
 * board pack anyway. PNG is offered too, by rasterising this same SVG through a
 * canvas — no external references means the canvas never taints.
 *
 * What you export is what's on screen: the current root, the current expansion.
 */
"use strict";

const CARD_W = 240;
const PAD = 40;
const TITLE_H = 64;

/** Read the laid-out chart back out of the DOM as plain geometry. */
function collect($tree, zoom) {
  const treeRect = $tree.getBoundingClientRect();
  const cards = [];

  for (const el of $tree.querySelectorAll(".oc-card")) {
    const r = el.getBoundingClientRect();
    cards.push({
      el,
      isGroup: el.classList.contains("oc-group-card"),
      eid: el.dataset.eid || null,
      x: (r.left - treeRect.left) / zoom,
      y: (r.top - treeRect.top) / zoom,
      w: r.width / zoom,
      h: r.height / zoom,
    });
  }

  // Connectors, using the same parent/child geometry drawConnectors() uses.
  const links = [];
  for (const group of $tree.querySelectorAll(".oc-node-group")) {
    const kids = group.querySelector(":scope > .oc-children");
    if (!kids || kids.classList.contains("collapsed")) continue;
    const parentCard = group.querySelector(":scope > .oc-card");
    if (!parentCard) continue;
    const pr = parentCard.getBoundingClientRect();
    const px = (pr.left + pr.width / 2 - treeRect.left) / zoom;
    const py = (pr.bottom - treeRect.top) / zoom;

    const points = [];
    for (const kg of kids.querySelectorAll(":scope > .oc-node-group")) {
      const kc = kg.querySelector(":scope > .oc-card");
      if (!kc) continue;
      const kr = kc.getBoundingClientRect();
      points.push({
        x: (kr.left + kr.width / 2 - treeRect.left) / zoom,
        y: (kr.top - treeRect.top) / zoom,
      });
    }
    if (points.length) links.push({ px, py, points });
  }

  return { cards, links, width: treeRect.width / zoom, height: treeRect.height / zoom };
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Cheap ellipsis — the cards are a known width and the font is known-ish. */
function clip(text, maxChars) {
  const s = String(text == null ? "" : text);
  return s.length > maxChars ? s.slice(0, maxChars - 1) + "…" : s;
}

function textNode(x, y, str, { size = 11, weight = 400, fill = "#1B3A5C",
                               anchor = "start", upper = false } = {}) {
  if (!str) return "";
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" `
       + `font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"`
       + (upper ? ` letter-spacing="0.6"` : "") + `>${esc(str)}</text>`;
}

/**
 * @param opts.title      company name
 * @param opts.subtitle   census label / date / mode
 * @param opts.lookup     (employeeId) => node, for card content
 * @param opts.groupLabel (element) => {name, figures[]} for a group box
 * @param opts.canSeePay  include cost figures
 */
export function chartToSvg($tree, zoom, opts) {
  const { cards, links, width, height } = collect($tree, zoom);
  if (!cards.length) return null;

  const W = Math.ceil(width + PAD * 2);
  const H = Math.ceil(height + PAD * 2 + TITLE_H);
  const ox = PAD;
  const oy = PAD + TITLE_H;

  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" `
    + `viewBox="0 0 ${W} ${H}" font-family="Lato, Segoe UI, Helvetica, Arial, sans-serif">`;
  out += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;

  out += textNode(PAD, 34, opts.title, { size: 22, weight: 700, fill: "#1B3A5C" });
  out += textNode(PAD, 52, opts.subtitle, { size: 12, fill: "#667" });

  // Connectors underneath the cards.
  out += `<g fill="none" stroke="#90a4ae" stroke-width="2">`;
  for (const { px, py, points } of links) {
    const midY = py + (points[0].y - py) / 2;
    out += `<path d="M${(px + ox).toFixed(1)} ${(py + oy).toFixed(1)} `
         + `L${(px + ox).toFixed(1)} ${(midY + oy).toFixed(1)}"/>`;
    if (points.length === 1) {
      out += `<path d="M${(px + ox).toFixed(1)} ${(midY + oy).toFixed(1)} `
           + `L${(points[0].x + ox).toFixed(1)} ${(points[0].y + oy).toFixed(1)}"/>`;
    } else {
      const left = Math.min(...points.map(p => p.x)) + ox;
      const right = Math.max(...points.map(p => p.x)) + ox;
      out += `<path d="M${left.toFixed(1)} ${(midY + oy).toFixed(1)} `
           + `L${right.toFixed(1)} ${(midY + oy).toFixed(1)}"/>`;
      for (const p of points) {
        out += `<path d="M${(p.x + ox).toFixed(1)} ${(midY + oy).toFixed(1)} `
             + `L${(p.x + ox).toFixed(1)} ${(p.y + oy).toFixed(1)}"/>`;
      }
    }
  }
  out += `</g>`;

  for (const card of cards) {
    out += card.isGroup
      ? groupSvg(card, ox, oy, opts)
      : personSvg(card, ox, oy, opts);
  }

  out += `</svg>`;
  return out;
}

function personSvg(card, ox, oy, opts) {
  const node = opts.lookup(card.eid);
  const x = card.x + ox, y = card.y + oy;
  const w = card.w || CARD_W;
  const headH = 40;

  let g = `<g>`;
  g += `<rect x="${x}" y="${y}" width="${w}" height="${card.h}" rx="6" `
     + `fill="#ffffff" stroke="#dde1e6"/>`;
  g += `<path d="M${x} ${y + 6} a6 6 0 0 1 6 -6 h${w - 12} a6 6 0 0 1 6 6 `
     + `v${headH - 6} h-${w} z" fill="#1B3A5C"/>`;

  if (!node) return g + `</g>`;

  g += textNode(x + 11, y + 18, clip(node.full_name, 26),
                { size: 12, weight: 700, fill: "#ffffff" });
  g += textNode(x + 11, y + 32, clip(node.job_title || "", 32),
                { size: 10, fill: "#a8c4dc" });

  const m = node.metrics || {};
  const row1 = y + headH + 18;
  const row2 = row1 + 26;
  g += textNode(x + 11, row1 - 9, "HEADCOUNT", { size: 6.5, fill: "#8a8a8a", upper: true });
  g += textNode(x + 11, row1 + 2, fmtNum(m.headcount), { size: 12, weight: 700 });
  g += textNode(x + w / 2 + 4, row1 - 9, "DIRECT REPORTS",
                { size: 6.5, fill: "#8a8a8a", upper: true });
  g += textNode(x + w / 2 + 4, row1 + 2, fmtNum(m.direct_report_count),
                { size: 12, weight: 700 });

  if (opts.canSeePay && m.total_labor_cost != null) {
    g += textNode(x + 11, row2 - 9, "LOADED COST", { size: 6.5, fill: "#8a8a8a", upper: true });
    g += textNode(x + 11, row2 + 2, fmtMoney(m.total_labor_cost), { size: 12, weight: 700 });
  }
  if (m.avg_span_of_control != null) {
    g += textNode(x + w / 2 + 4, row2 - 9, "AVG SPAN",
                  { size: 6.5, fill: "#8a8a8a", upper: true });
    g += textNode(x + w / 2 + 4, row2 + 2, m.avg_span_of_control.toFixed(1),
                  { size: 12, weight: 700 });
  }
  return g + `</g>`;
}

const GROUP_COLOURS = {
  sand:  { head: "#8A7659", body: "#F3EDE2", edge: "#C9B79A", ink: "#4A3F2E" },
  sage:  { head: "#5F7A5C", body: "#EAF0E7", edge: "#AFC4A8", ink: "#33452F" },
  slate: { head: "#4E6472", body: "#E8EEF2", edge: "#A6BAC7", ink: "#2B3A44" },
  plum:  { head: "#7A5A6E", body: "#F2E9EE", edge: "#C7A9BA", ink: "#452F3C" },
};

function groupSvg(card, ox, oy, opts) {
  const info = opts.groupLabel(card.el);
  const c = GROUP_COLOURS[info.accent] || GROUP_COLOURS.sand;
  const x = card.x + ox, y = card.y + oy;
  const w = card.w || CARD_W;
  const headH = 34;

  let g = `<g>`;
  g += `<rect x="${x}" y="${y}" width="${w}" height="${card.h}" rx="6" `
     + `fill="${c.body}" stroke="${c.edge}" stroke-width="2"/>`;
  g += `<path d="M${x} ${y + 6} a6 6 0 0 1 6 -6 h${w - 12} a6 6 0 0 1 6 6 `
     + `v${headH - 6} h-${w} z" fill="${c.head}"/>`;
  g += textNode(x + 11, y + 22, clip(info.name.toUpperCase(), 26),
                { size: 11, weight: 700, fill: "#ffffff", upper: true });

  let fx = x + 11;
  for (const fig of info.figures) {
    g += textNode(fx, y + headH + 24, fig.value, { size: 18, weight: 700, fill: c.ink });
    g += textNode(fx, y + headH + 36, fig.label.toUpperCase(),
                  { size: 6.5, fill: c.head, upper: true });
    fx += 92;
  }
  return g + `</g>`;
}

function fmtNum(n) { return n == null ? "—" : n.toLocaleString(); }
function fmtMoney(n) {
  if (n == null) return "—";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + Math.round(n).toLocaleString();
}

/* ── Download helpers ────────────────────────────────────────────── */

export function downloadSvg(svg, filename) {
  triggerDownload(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), filename + ".svg");
}

/** Rasterise the same SVG. 2× so it stays sharp when scaled up in a deck. */
export function downloadPng(svg, filename, scale = 2) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error("Could not rasterise the chart."));
        triggerDownload(blob, filename + ".png");
        resolve();
      }, "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not load the chart image.")); };
    img.src = url;
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
