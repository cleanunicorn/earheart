// The two palettes of renderer/tokens.css, parsed, and the WCAG 2.x contrast
// of every text and UI pair the windows actually draw (#348). Used by
// test/theme-contract.test.js, which fails any pair under its threshold; run
// directly it prints the table as Markdown:
//
//   node scripts/theme-contrast.js > contrast.md
//
// Method: relative luminance from linearised sRGB (0.2126 R + 0.7152 G +
// 0.0722 B), ratio (L1 + 0.05) / (L2 + 0.05). A translucent fill is first
// composited over the surface it sits on, so a pair is judged on the pixels
// that reach the screen.

const fs = require("node:fs");
const path = require("node:path");

const TOKENS = path.join(__dirname, "..", "renderer", "tokens.css");

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// `--name: value;` pairs of one block. Values may hold a quoted data: URI with
// its own semicolons, so quoted runs are consumed whole.
function declarations(block) {
  const out = new Map();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*((?:'[^']*'|"[^"]*"|[^;'"])*);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

// The body of the `{ … }` opened at `open` (the index of its "{").
function blockAt(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced braces in tokens.css");
}

// { dark: Map, light: Map } — dark is the unconditional :root, light the
// :root inside @media (prefers-color-scheme: light).
function readPalettes(source = fs.readFileSync(TOKENS, "utf8")) {
  const css = stripComments(source);
  const media = css.search(/@media\s*\(\s*prefers-color-scheme:\s*light\s*\)\s*\{/);
  if (media === -1) throw new Error("tokens.css has no prefers-color-scheme: light block");
  const darkAt = css.search(/:root\s*\{/);
  if (darkAt === -1 || darkAt > media) throw new Error("tokens.css must open with the dark :root");
  const dark = declarations(blockAt(css, css.indexOf("{", darkAt)));
  const mediaBody = blockAt(css, css.indexOf("{", media));
  const lightRoot = mediaBody.search(/:root\s*\{/);
  if (lightRoot === -1) throw new Error("the light block must set :root");
  const light = declarations(blockAt(mediaBody, mediaBody.indexOf("{", lightRoot)));
  return { dark, light };
}

// "#rgb" | "#rrggbb" | "rgb(a)(r, g, b[, a])" | "rgb(r g b / a)" → {r,g,b,a}.
function parseColor(value) {
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`not a colour: ${value}`);
}

// A colour drawn over an opaque one.
function over(top, under) {
  const mix = (t, u) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function luminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const hex = ({ r, g, b }) => "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

// The surfaces text and controls sit on, per palette. A surface is a token
// (opaque) or a stack of translucent tokens over one, bottom first.
const SURFACES = {
  ink: ["--ink"],
  card: ["--ink", "--wash-faint"], // Settings/wizard cards
  field: ["--field"], // inputs
  hover: ["--ink", "--wash"], // a hovered row or key
  tray: ["--ink", "--wash-faint", "--tray"], // a model tray inside a card
  "err-wash": ["--ink", "err-wash"], // the overlay's discard hover
  "accent-wash": ["--field", "accent-wash"], // a capturing hotkey field
  "filled key": ["--text"], // Save, Done, the primary pill
  "filled key hover": ["--text-strong"],
};

// [foreground, surfaces, minimum, what it is]. 4.5 = text (WCAG 1.4.3),
// 3 = a UI component or state indicator (1.4.11). --text-faint marks disabled
// keys, which 1.4.3 exempts; --edge/--seam hairlines are decorative.
const TEXT = 4.5;
const UI = 3;
const PAIRS = [
  ["--text", ["ink", "card", "field", "hover", "tray", "accent-wash"], TEXT, "primary text"],
  ["--text-mid", ["ink"], TEXT, "overlay status word"],
  ["--text-dim", ["ink", "card", "field", "hover", "tray"], TEXT, "secondary text, hints"],
  ["--accent", ["ink"], TEXT, "recording countdown (text)"],
  ["--accent", ["card", "field"], UI, "capture dot, waveform, progress, capturing edge"],
  ["--ok", ["ink", "card"], TEXT, "success status"],
  ["--err", ["ink", "card", "err-wash"], TEXT, "error status, discard hover"],
  ["--idle", ["ink"], UI, "idle status dot"],
  ["--field-edge", ["ink", "card"], UI, "input boundary"],
  ["--text", ["ink", "card", "field"], UI, "focus outline / focused edge"],
  ["--ink", ["filled key", "filled key hover"], TEXT, "text on a filled key"],
  ["--section-general", ["ink", "card"], TEXT, "section hue"],
  ["--section-live", ["ink", "card"], TEXT, "section hue"],
  ["--section-stt", ["ink", "card"], TEXT, "section hue"],
  ["--section-cleanup", ["ink", "card"], TEXT, "section hue"],
  ["--section-history", ["ink", "card"], TEXT, "section hue"],
  ["--section-advanced", ["ink", "card"], TEXT, "section hue"],
  ["--state-private", ["ink", "card"], TEXT, "engine state (on-device)"],
  ["--state-external", ["ink", "card"], TEXT, "engine state (leaves the device)"],
];

// The washes built from channel tokens in the page sheets, at their alphas.
function channelWash(tokens, channel, alpha) {
  const [r, g, b] = tokens.get(channel).split(/\s+/).map(Number);
  return { r, g, b, a: alpha };
}

function colorOf(tokens, name) {
  if (name === "err-wash") return channelWash(tokens, "--err-rgb", 0.12);
  if (name === "accent-wash") return channelWash(tokens, "--accent-rgb", 0.07);
  if (!tokens.has(name)) throw new Error(`tokens.css does not declare ${name}`);
  return parseColor(tokens.get(name));
}

function surface(tokens, key) {
  const [base, ...layers] = SURFACES[key].map((n) => colorOf(tokens, n));
  return layers.reduce((under, top) => over(top, under), base);
}

// Every pair × surface for one palette: [{ fg, on, min, ratio, use, fgHex, bgHex }].
function measure(tokens) {
  const rows = [];
  for (const [fg, ons, min, use] of PAIRS) {
    for (const on of ons) {
      const bg = surface(tokens, on);
      const color = over(colorOf(tokens, fg), bg);
      rows.push({ fg, on, min, use, ratio: ratio(color, bg), fgHex: hex(color), bgHex: hex(bg) });
    }
  }
  return rows;
}

function report(palettes = readPalettes()) {
  const dark = measure(palettes.dark);
  const light = measure(palettes.light);
  const lines = [
    "| Foreground | On | Use | Need | Dark | Light |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  dark.forEach((d, i) => {
    const l = light[i];
    const cell = (r) => `${r.ratio.toFixed(2)} ${r.ratio >= r.min ? "✓" : "✗"} (${r.fgHex} on ${r.bgHex})`;
    lines.push(`| \`${d.fg}\` | ${d.on} | ${d.use} | ${d.min} | ${cell(d)} | ${cell(l)} |`);
  });
  return lines.join("\n");
}

module.exports = { readPalettes, parseColor, over, ratio, measure, report, PAIRS, SURFACES, TEXT, UI };

if (require.main === module) process.stdout.write(report() + "\n");
