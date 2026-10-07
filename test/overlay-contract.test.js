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

// overlay.js calls into its sibling renderer scripts (transcript.js for the
// two-layer paint, speech-probe.js for the committed-chunk verdict) as plain
// globals. A script tag dropped from the markup, or a file renamed, throws a
// ReferenceError deep inside a commit — the preview goes blank and the final
// pass quietly falls back to a full decode, with overlay-smoke still green.
test("overlay.html loads every sibling script overlay.js calls into", () => {
  const loaded = [...html.matchAll(/<script src="([a-z0-9.-]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(loaded.includes("overlay.js"), "overlay.html must load overlay.js");

  for (const src of loaded) {
    assert.ok(fs.existsSync(path.join(RENDERER, src)), `overlay.html loads a missing ${src}`);
  }
  // Globals must be defined before overlay.js runs, so their tags come first.
  const helpers = loaded.slice(0, loaded.indexOf("overlay.js"));
  for (const { file, fn } of [
    { file: "chunk-boundary.js", fn: "quietestOffset" },
    { file: "microphone.js", fn: "microphoneConstraints" },
    { file: "transcript.js", fn: "reconcileTranscript" },
    { file: "speech-probe.js", fn: "chunkSpeechVerdict" },
  ]) {
    assert.ok(new RegExp(`\\b${fn}\\(`).test(js), `overlay.js should call ${fn}()`);
    assert.ok(helpers.includes(file), `overlay.html must load ${file} before overlay.js`);
  }
});

test("overlay.css keeps the [hidden]-always-wins rule", () => {
  // overlay.js toggles the update prompt, its bar, its action pills and the
  // transcript through the hidden attribute; components that set their own
  // display (flex rows, the pills) would override it without this rule.
  // Identical whitespace-tolerant match to settings-contract's version.
  assert.match(
    css.replace(/\s+/g, " "),
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    "overlay.css must keep [hidden] { display: none !important }"
  );
});

test("the update overflow note uses readable secondary text", () => {
  const rule = css.match(/#update-notes li\.more\s*\{([^}]*)\}/);
  assert.ok(rule, "the update overflow note keeps an explicit style");
  assert.match(rule[1], /color:\s*var\(--text-dim\)/);
  assert.doesNotMatch(rule[1], /text-faint/);
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
  // Non-greedy to the block's own column-0 closing brace, so a rule added
  // AFTER the media query can't smuggle the assertion outside the block.
  const reduce = css.match(
    /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/
  );
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

test("the overlay and the decode splitter share one silence level", () => {
  // The overlay commits a live chunk at a pause below QUIET_RMS, and
  // main/util/split-silence.js cuts decodes at pauses below its own copy of
  // it (overlay.js is a DOM script with nothing to import). Tuning one alone
  // would split live and final pause policy without any other test noticing.
  const m = js.match(/^const QUIET_RMS = ([0-9.]+);/m);
  assert.ok(m, "overlay.js defines QUIET_RMS as a numeric literal");
  const { QUIET_RMS } = require("../main/util/split-silence");
  assert.strictEqual(Number(m[1]), QUIET_RMS);
});

// The max-recording cap arrives over IPC and arms setTimeout(stopRecording,
// cap * 1000). A non-positive cap fired the instant "Listening…" appeared and
// an absurd one never fired (#210), so the overlay validates it once per
// session and falls back to the 300 s default.
function recordingCap() {
  const start = js.search(/function recordingCapSeconds\s*\(/);
  assert.notStrictEqual(start, -1, "overlay.js must define recordingCapSeconds()");
  let depth = 0;
  let end = js.indexOf("{", start);
  for (; end < js.length; end++) {
    if (js[end] === "{") depth++;
    else if (js[end] === "}" && --depth === 0) break;
  }
  const context = {};
  require("node:vm").runInNewContext(
    `${js.slice(start, end + 1)}; this.cap = recordingCapSeconds;`,
    context
  );
  return context.cap;
}

test("the recording cap falls back to 300 s for an unusable value", () => {
  const cap = recordingCap();
  for (const bad of [-5, 0, 1, 9, 99999, NaN, Infinity, -Infinity, "300", null, undefined]) {
    assert.strictEqual(cap(bad), 300, `cap(${String(bad)})`);
  }
  for (const good of [10, 300, 3600]) assert.strictEqual(cap(good), good);
  assert.strictEqual(cap(10.6), 11);
  // Rejects, not clamps, just outside the range — main has already clamped.
  assert.strictEqual(cap(9.4), 300);
});

test("startRecording takes its cap through recordingCapSeconds", () => {
  // Both timer sites (first samples, resume) read recording.maxSeconds, so the
  // one validated assignment covers them.
  assert.match(js, /maxSeconds:\s*recordingCapSeconds\(maxSeconds\)/);
  assert.doesNotMatch(js, /maxSeconds:\s*maxSeconds\s*\|\|/);
});
