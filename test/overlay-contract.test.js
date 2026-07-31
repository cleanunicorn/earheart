// Guards the contract between the overlay renderer script and its markup.
//
// overlay.js binds every element it drives by id at module top level and
// wires the update-prompt buttons with addEventListener before it registers
// overlay:show/hide, the canvas ResizeObserver, the key click handlers and
// the drag implementation — so a dropped or renamed id throws mid-file and
// leaves the card permanently invisible with every mouse control dead, while
// overlay-smoke (which drives the page purely over IPC) stays green. These
// tests parse the files as text — no DOM, no Electron — so a markup redesign
// that breaks the binding contract fails here instead of in the app.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const RENDERER = path.join(ROOT, "renderer");
const html = fs.readFileSync(path.join(RENDERER, "overlay.html"), "utf8");
const js = fs.readFileSync(path.join(RENDERER, "overlay.js"), "utf8");
const css = fs.readFileSync(path.join(RENDERER, "overlay.css"), "utf8");

const htmlIds = new Set([...html.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]));

test("every id overlay.js references exists in overlay.html", () => {
  const referenced = new Set(
    [...js.matchAll(/getElementById\(\s*"([a-z0-9-]+)"\s*\)/g)].map((m) => m[1])
  );
  // The scan going silently empty must fail too: overlay.js binds ~23 ids.
  assert.ok(referenced.size > 20, `expected >20 referenced ids, got ${referenced.size}`);

  const missing = [...referenced].filter((id) => !htmlIds.has(id)).sort();
  assert.deepStrictEqual(missing, [], `overlay.html is missing ids: ${missing.join(", ")}`);
});

test("overlay.css keeps the [hidden]-always-wins rule", () => {
  // overlay.js toggles the update prompt, its bar, its action pills and the
  // transcript through the hidden attribute; components that set their own
  // display (flex rows, the pills) would override it without this rule.
  // Same normalized match as settings-contract's version of this test.
  const flat = css.replace(/\s+/g, " ");
  assert.ok(
    flat.includes("[hidden] { display: none !important"),
    "overlay.css must keep [hidden] { display: none !important }"
  );
});

test("every var() overlay.css uses is defined in its own :root", () => {
  // overlay.css has its OWN token set (it only partially overlaps
  // settings.css's — --ink is shared, --idle/--text-mid/--text-faint are
  // overlay-only), so check it against itself, not the settings tokens.
  // Regexes mirror settings-contract's: digits allowed in token names, and
  // `var(--x` without requiring the closing paren so fallbacks still match.
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(rootBlock, "overlay.css must define a :root block");
  const defined = new Set(
    [...rootBlock[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
  );
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const undefinedVars = [...used].filter((v) => !defined.has(v)).sort();
  assert.deepStrictEqual(
    undefinedVars,
    [],
    `overlay.css uses undefined tokens: ${undefinedVars.join(", ")}`
  );
});

test("reduced motion keeps the warming/paused dot distinction", () => {
  // Under prefers-reduced-motion the status dot's pulse is stilled, and the
  // pulse is the only thing separating "warming up" from "paused" (both are
  // hollow coral rings). The 55%-opacity substitute is that contract's only
  // survivor without motion — a future edit to the reduce block must not
  // silently drop it.
  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}/);
  assert.ok(reduce, "overlay.css must keep a prefers-reduced-motion block");
  const flat = reduce[1].replace(/\s+/g, " ");
  assert.ok(
    flat.includes('[data-status="starting"] #status-dot { opacity: 0.55'),
    "the reduce block must dim the warming dot so it stays distinct from paused"
  );
});

test("the hand-duplicated color constants match their CSS tokens", () => {
  // Two values are deliberately duplicated across file boundaries with
  // keep-in-sync comments; drift is invisible at runtime, so pin them here.
  // WAVE_COLOR paints the canvas waveform and must equal the accent that
  // colors the capture dot and progress fill.
  const waveColor = js.match(/const WAVE_COLOR = "([^"]+)"/);
  const accent = css.match(/--accent:\s*([^;]+);/);
  assert.ok(waveColor && accent, "WAVE_COLOR and --accent must both exist");
  assert.strictEqual(
    waveColor[1].toLowerCase(),
    accent[1].trim().toLowerCase(),
    "overlay.js WAVE_COLOR must equal overlay.css --accent"
  );

  // INK_COLOR pre-paints the framed windows and must equal the ink the
  // stylesheets actually render, or settings/wizard flash the wrong color.
  const windowsJs = fs.readFileSync(path.join(ROOT, "main", "windows.js"), "utf8");
  const settingsCss = fs.readFileSync(path.join(RENDERER, "settings.css"), "utf8");
  const inkConst = windowsJs.match(/const INK_COLOR = "([^"]+)"/);
  const inkToken = settingsCss.match(/--ink:\s*([^;]+);/);
  const overlayInk = css.match(/--ink:\s*([^;]+)\s*;/);
  assert.ok(inkConst && inkToken && overlayInk, "INK_COLOR and both --ink tokens must exist");
  assert.strictEqual(
    inkConst[1].toLowerCase(),
    inkToken[1].trim().split("/*")[0].trim().toLowerCase(),
    "main/windows.js INK_COLOR must equal settings.css --ink"
  );
  assert.strictEqual(
    inkConst[1].toLowerCase(),
    overlayInk[1].trim().split("/*")[0].trim().toLowerCase(),
    "main/windows.js INK_COLOR must equal overlay.css --ink"
  );
});
