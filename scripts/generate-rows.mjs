#!/usr/bin/env node
// Generates the four project row panels (light + dark) from one template so the
// rows share identical baselines, gutters and hairline rhythm.
// Standalone only — this is NOT wired into .github/workflows/stats.yml.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "assets");

const W = 1200;
const H = 120;
const LEFT = 72;
const RIGHT = 1128;
const COL = 136; // text column, right of the index gutter

const rows = [
  {
    id: "noti",
    index: "01",
    name: "noti",
    desc: "minimalist windows 11 notes app. local markdown, liquid glass on mica.",
    meta: "winui 3 · .net 8",
    repo: "noti",
  },
  {
    id: "perch",
    index: "02",
    name: "perch",
    desc: "a widget dock for windows.",
    meta: null,
    repo: "perch",
  },
  {
    id: "ben-browser",
    index: "03",
    name: "ben-browser",
    desc: "minimal android browser. webview, glassmorphism, no clutter.",
    meta: "kotlin · jetpack compose · haze",
    repo: "ben-browser",
  },
  {
    id: "anime-gurl",
    index: "04",
    name: "anime-gurl",
    desc: "transparent, always-on-top anime desktop mascot. reacts to music.",
    meta: "electron",
    repo: "anime-gurl",
  },
];

const themes = {
  light: {
    bg: "#faf7f0",
    ink: "#111111",
    body: "#333333",
    muted: "#666666",
    hairline: "#000000",
    hairlineOpacity: "0.12",
    grid: "#000000",
    gridOpacity: "0.05",
  },
  dark: {
    bg: "#0d1117",
    ink: "#e6edf3",
    body: "#c9d1d9",
    muted: "#8b949e",
    hairline: "#ffffff",
    hairlineOpacity: "0.10",
    grid: "#ffffff",
    gridOpacity: "0.035",
  },
};

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/·/g, "&#183;");

function altText(row) {
  const meta = row.meta ? ` ${row.meta}.` : "";
  return `${row.name} — ${row.desc}${meta} github.com/akrram0/${row.repo}`;
}

function svg(row, theme) {
  const t = themes[theme];
  const label = altText(row);
  const metaEl = row.meta
    ? `\n  <text class="mono" x="${RIGHT}" y="54" text-anchor="end" font-size="17" font-weight="500" letter-spacing="1.2" fill="${t.muted}">${esc(row.meta)}</text>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
  <title>project ${row.index}: ${esc(row.name)}</title>
  <defs>
    <style>
      .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    </style>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="${t.grid}" fill-opacity="${t.gridOpacity}"/>
    </pattern>
  </defs>

  <rect x="0" y="0" width="${W}" height="${H}" fill="${t.bg}"/>
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#grid)"/>

  <text class="mono" x="${LEFT}" y="54" font-size="17" font-weight="500" letter-spacing="1.2" fill="${t.muted}">${row.index}</text>
  <text class="mono" x="${COL}" y="54" font-size="34" font-weight="700" letter-spacing="-0.6" fill="${t.ink}">${esc(row.name)}</text>${metaEl}
  <text class="mono" x="${COL}" y="88" font-size="21" font-weight="400" letter-spacing="0.2" fill="${t.body}">${esc(row.desc)}</text>
  <text class="mono" x="${RIGHT}" y="88" text-anchor="end" font-size="20" letter-spacing="0" fill="${t.muted}">&#8599;</text>

  <line x1="${LEFT}" y1="119" x2="${RIGHT}" y2="119" stroke="${t.hairline}" stroke-opacity="${t.hairlineOpacity}" stroke-width="1"/>
</svg>
`;
}

fs.mkdirSync(outDir, { recursive: true });
for (const row of rows) {
  for (const theme of ["light", "dark"]) {
    const file = path.join(outDir, `row-${row.id}-${theme}.svg`);
    fs.writeFileSync(file, svg(row, theme), "utf8");
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
}
