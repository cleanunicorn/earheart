// The light and dark palettes (#348): renderer/tokens.css declares both, and
// every other renderer file only references them. Guards the couplings a
// theme change can silently break — a token one palette forgets, a colour
// literal that stays one colour in both, the native ink drifting from --ink,
// and a pair falling under its WCAG contrast minimum.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { readPalettes, measure, PAIRS } = require("../scripts/theme-contrast");

const ROOT = path.join(__dirname, "..");
const RENDERER = path.join(ROOT, "renderer");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const listRenderer = (ext) => fs.readdirSync(RENDERER).filter((f) => f.endsWith(ext)).sort();
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const palettes = readPalettes();

test("both palettes declare exactly the same tokens", () => {
  const dark = [...palettes.dark.keys()].sort();
  const light = [...palettes.light.keys()].sort();
  // The parse going silently empty must fail too: 30 tokens today.
  assert.ok(dark.length >= 30, `expected ≥30 dark tokens, got ${dark.length}`);
  assert.deepStrictEqual(light, dark, "a token only one palette sets keeps the other palette's value");
});

test("the light palette really differs where it must", () => {
  for (const token of ["--ink", "--text", "--text-dim", "--accent", "--field", "--fg-rgb", "--caret"]) {
    assert.notStrictEqual(palettes.light.get(token), palettes.dark.get(token), `${token} is the same in both`);
  }
});

test("main's native ink equals --ink in each palette", () => {
  // The framed windows are created painted in this colour, so a mismatch is
  // a flash of the wrong ink before the stylesheet lands.
  const windowsJs = read("main", "windows.js");
  const m = windowsJs.match(/const INK_COLORS = \{\s*dark:\s*"([^"]+)",\s*light:\s*"([^"]+)"\s*\}/);
  assert.ok(m, "main/windows.js must declare INK_COLORS { dark, light }");
  assert.strictEqual(m[1].toLowerCase(), palettes.dark.get("--ink").toLowerCase());
  assert.strictEqual(m[2].toLowerCase(), palettes.light.get("--ink").toLowerCase());
});

test("the select caret is drawn in its palette's --text-dim", () => {
  for (const [name, tokens] of Object.entries(palettes)) {
    const stroke = tokens.get("--caret").match(/stroke="%23([0-9a-f]{6})"/i);
    assert.ok(stroke, `${name} --caret must carry a stroke`);
    assert.strictEqual(`#${stroke[1]}`.toLowerCase(), tokens.get("--text-dim").toLowerCase(), name);
  }
});

test("the overlay waveform reads --accent and follows a scheme change", () => {
  const js = read("renderer", "overlay.js");
  assert.ok(!/WAVE_COLOR/.test(js), "the duplicated WAVE_COLOR constant is gone");
  assert.match(js, /getPropertyValue\("--accent"\)/, "the wave colour comes from the stylesheet");
  assert.match(js, /matchMedia\(\s*"\(prefers-color-scheme: dark\)"\s*\)\s*\.addEventListener\("change"/);
  assert.match(js, /meterCtx\.fillStyle = waveColor;/);
});

// Colour literals: hex, rgb()/hsl() with numbers, a %23-escaped hex in a data:
// URI, and the common named colours. rgb(var(--fg-rgb) / a) is a token use.
const CSS_LITERAL = /#[0-9a-f]{3,8}\b|%23[0-9a-f]{3,8}|\b(?:rgba?|hsla?)\(\s*[\d.]|(?<![-\w])(?:white|black|red|gray|grey|silver)(?![-\w])/i;

test("no colour literal in any renderer sheet outside tokens.css", () => {
  const sheets = listRenderer(".css").filter((f) => f !== "tokens.css");
  assert.ok(sheets.length >= 4, `expected the overlay, settings, wizard and correction sheets, got ${sheets}`);
  const found = [];
  for (const file of sheets) {
    const css = stripComments(fs.readFileSync(path.join(RENDERER, file), "utf8"));
    // Only declaration bodies: selectors such as #cancel may look like hex.
    for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
      for (const decl of body.split(";")) {
        if (CSS_LITERAL.test(decl.replace(/^[^:]*:/, ""))) found.push(`${file}: ${decl.trim()}`);
      }
    }
  }
  assert.deepStrictEqual(found, [], "use a tokens.css token so the colour follows the palette");
});

test("no colour literal in renderer scripts or pages", () => {
  const found = [];
  for (const file of listRenderer(".js")) {
    const src = fs.readFileSync(path.join(RENDERER, file), "utf8");
    for (const m of src.matchAll(/["'`](#[0-9a-f]{3,8}|(?:rgba?|hsla?)\(\s*[\d.][^"'`]*)["'`]/gi)) found.push(`${file}: ${m[1]}`);
  }
  for (const file of listRenderer(".html")) {
    const src = fs.readFileSync(path.join(RENDERER, file), "utf8");
    for (const m of src.matchAll(/(?:style|fill|stroke|color)="([^"]*)"/gi)) {
      if (CSS_LITERAL.test(m[1])) found.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(found, []);
});

test("every var() a renderer sheet uses is declared", () => {
  const declared = new Set(palettes.dark.keys());
  for (const file of listRenderer(".css")) {
    const css = stripComments(fs.readFileSync(path.join(RENDERER, file), "utf8"));
    for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
  }
  const missing = [];
  for (const file of listRenderer(".css")) {
    const css = stripComments(fs.readFileSync(path.join(RENDERER, file), "utf8"));
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) if (!declared.has(m[1])) missing.push(`${file}: ${m[1]}`);
  }
  assert.deepStrictEqual(missing, []);
});

test("every framed page and the overlay load tokens.css", () => {
  for (const file of ["overlay.html", "settings.html", "wizard.html", "correction.html"]) {
    assert.match(read("renderer", file), /href="tokens\.css"/, file);
  }
  // The scheme is declared once, for both palettes, so native controls follow.
  assert.match(stripComments(read("renderer", "tokens.css")), /color-scheme:\s*light dark/);
});

for (const name of ["dark", "light"]) {
  test(`every ${name} text pair meets 4.5:1 and every UI pair 3:1 (WCAG 1.4.3 / 1.4.11)`, () => {
    const rows = measure(palettes[name]);
    assert.ok(rows.length >= PAIRS.length, "every pair is measured");
    const failing = rows
      .filter((r) => r.ratio < r.min)
      .map((r) => `${r.fg} on ${r.on} (${r.use}): ${r.ratio.toFixed(2)} < ${r.min}`);
    assert.deepStrictEqual(failing, []);
  });
}

test("the dark palette is unchanged by the light one (#348 keeps dark as it was)", () => {
  // The values the app shipped before light existed; dark must look identical.
  const before = {
    "--ink": "#18181b",
    "--text": "#f4f4f5",
    "--text-dim": "#a1a1aa",
    "--text-mid": "#d4d4d8",
    "--idle": "#71717a",
    "--accent": "#fb4d5c",
    "--ok": "#34d399",
    "--err": "#f87171",
    "--field": "#101013",
    "--field-edge": "#6b6b74",
    "--text-faint": "rgba(255, 255, 255, 0.28)",
    "--tray": "rgba(0, 0, 0, 0.25)",
    "--fg-rgb": "255 255 255",
    "--accent-rgb": "251 77 92",
    "--err-rgb": "248 113 113",
  };
  for (const [token, value] of Object.entries(before)) assert.strictEqual(palettes.dark.get(token), value, token);
});

test("the composited pairs measured above match what settings.css draws", () => {
  // scripts/theme-contrast.js models these fills at fixed alphas; if the CSS
  // moves, the measured pair no longer describes the screen.
  const flat = stripComments(read("renderer", "settings.css")).replace(/\s+/g, " ");
  const rule = (selector) => {
    const at = flat.indexOf(`${selector} {`);
    assert.notStrictEqual(at, -1, `settings.css must keep ${selector}`);
    return flat.slice(at, flat.indexOf("}", at));
  };
  const capturing = rule("#hotkey.capturing, #pause-hotkey.capturing");
  assert.match(capturing, /border-color: rgb\(var\(--accent-rgb\) \/ 0\.9\)/);
  assert.match(capturing, /background: rgb\(var\(--accent-rgb\) \/ 0\.07\)/);
  assert.match(capturing, /box-shadow: 0 0 0 3px rgb\(var\(--accent-rgb\) \/ 0\.16\)/);
  assert.match(rule(".segmented label:has(input:checked)"), /background: rgb\(var\(--fg-rgb\) \/ 0\.14\)/);
  assert.match(rule(".segmented"), /background: var\(--field\)/);
  assert.match(rule(".option:has(input:checked)"), /background: rgb\(var\(--fg-rgb\) \/ 0\.07\)/);
  assert.match(rule("button"), /background: var\(--wash\)/);
  assert.match(rule("button:hover:not(:disabled)"), /background: rgb\(var\(--fg-rgb\) \/ 0\.14\)/);
  assert.match(rule("button.danger:hover:not(:disabled)"), /background: rgb\(var\(--err-rgb\) \/ 0\.12\)/);
  for (const state of ["private", "external"]) {
    assert.match(rule(`.state-badge-${state}`), new RegExp(`background: color-mix\\(in oklch, var\\(--state-${state}\\) 12%, transparent\\)`));
  }
});

test("the capture edge is painted once, over its own fill, then compared (round-2 regression)", () => {
  // The coral fill runs under the border (no background-clip in settings.css),
  // so the edge's visible colour is accent 0.9 over the fill. That one colour
  // is what meets both the fill inside and the ring outside. Composing it over
  // the ring instead overstated the ring ratio (light 3.17 vs 3.14).
  const css = stripComments(read("renderer", "settings.css"));
  assert.doesNotMatch(css, /background-clip/, "a clipped background would change what the edge is painted over");
  const { parseColor, over, ratio } = require("../scripts/theme-contrast");
  for (const [name, tokens] of Object.entries(palettes)) {
    const channel = (token, a) => {
      const [r, g, b] = tokens.get(token).split(/\s+/).map(Number);
      return { r, g, b, a };
    };
    const card = over(channel("--fg-rgb", 0.04), parseColor(tokens.get("--ink")));
    const fill = over(channel("--accent-rgb", 0.07), card);
    const ring = over(channel("--accent-rgb", 0.16), card);
    const edge = over(channel("--accent-rgb", 0.9), fill);
    const rows = measure(tokens).filter((r) => r.use === "capturing hotkey field edge");
    assert.deepStrictEqual(rows.map((r) => r.on), ["capture fill", "capture ring"], name);
    assert.strictEqual(rows[0].fgHex, rows[1].fgHex, `${name}: one painted edge colour for both comparisons`);
    assert.ok(Math.abs(rows[0].ratio - ratio(edge, fill)) < 1e-9, `${name}: edge vs fill`);
    assert.ok(Math.abs(rows[1].ratio - ratio(edge, ring)) < 1e-9, `${name}: edge vs ring`);
    // The old underlay (edge composited over the ring) gives a different,
    // higher number; this pins that the model no longer does that.
    const wrong = ratio(over(channel("--accent-rgb", 0.9), ring), ring);
    assert.ok(Math.abs(rows[1].ratio - wrong) > 0.01, `${name}: not painted over the ring`);
  }
  assert.strictEqual(measure(palettes.light).find((r) => r.on === "capture ring").ratio.toFixed(2), "3.14");
  assert.strictEqual(measure(palettes.dark).find((r) => r.on === "capture ring").ratio.toFixed(2), "3.44");
});
