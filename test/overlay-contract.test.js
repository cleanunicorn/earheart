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
// The shared palette (--ink, --accent, …) lives in tokens.css, loaded before
// overlay.css; the overlay's own derivatives stay in overlay.css's :root.
const tokensCss = fs.readFileSync(path.join(RENDERER, "tokens.css"), "utf8");

function rootTokens(source, file) {
  const block = source.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(block, `${file} must define a :root block`);
  return new Set([...block[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

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

test("every var() overlay.css uses is defined in tokens.css or its own :root", () => {
  // overlay.css sees the shared palette from tokens.css plus its own
  // overlay-only tokens (--idle/--text-mid/--text-faint) — never the
  // settings-window derivatives, so it is not checked against settings.css.
  // Regexes mirror settings-contract's: digits allowed in token names, and
  // `var(--x` without requiring the closing paren so fallbacks still match.
  const defined = new Set([
    ...rootTokens(tokensCss, "tokens.css"),
    ...rootTokens(css, "overlay.css"),
  ]);
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const undefinedVars = [...used].filter((v) => !defined.has(v)).sort();
  assert.deepStrictEqual(
    undefinedVars,
    [],
    `overlay.css uses undefined tokens: ${undefinedVars.join(", ")}`
  );
});

test("overlay.html loads tokens.css before overlay.css", () => {
  const tokensAt = html.indexOf('href="tokens.css"');
  const sheetAt = html.indexOf('href="overlay.css"');
  assert.ok(tokensAt !== -1, "overlay.html must load tokens.css");
  assert.ok(sheetAt > tokensAt, "tokens.css must load before overlay.css");
});

test("the shared palette is declared only in tokens.css", () => {
  // A token redeclared in a page sheet silently overrides tokens.css and
  // re-opens the two-copies drift this file exists to prevent.
  const shared = rootTokens(tokensCss, "tokens.css");
  assert.ok(shared.has("--ink") && shared.has("--accent"), "tokens.css must declare --ink and --accent");
  const settingsCss = fs.readFileSync(path.join(RENDERER, "settings.css"), "utf8");
  const wizardCss = fs.readFileSync(path.join(RENDERER, "wizard.css"), "utf8");
  for (const [file, source] of [["overlay.css", css], ["settings.css", settingsCss], ["wizard.css", wizardCss]]) {
    const redeclared = [...source.matchAll(/(--[a-z0-9-]+)\s*:/g)]
      .map((m) => m[1])
      .filter((t) => shared.has(t));
    assert.deepStrictEqual(redeclared, [], `${file} redeclares shared tokens: ${redeclared.join(", ")}`);
  }
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
  const accent = tokensCss.match(/--accent:\s*([^;/]+)/);
  assert.ok(waveColor && accent, "WAVE_COLOR and --accent must both exist");
  assert.strictEqual(
    waveColor[1].toLowerCase(),
    accent[1].trim().toLowerCase(),
    "overlay.js WAVE_COLOR must equal tokens.css --accent"
  );

  // INK_COLOR pre-paints the framed windows and must equal the ink the
  // stylesheets actually render, or settings/wizard flash the wrong color.
  // Both the overlay and the framed windows read --ink from tokens.css.
  const windowsJs = fs.readFileSync(path.join(ROOT, "main", "windows.js"), "utf8");
  const inkConst = windowsJs.match(/const INK_COLOR = "([^"]+)"/);
  const inkToken = tokensCss.match(/--ink:\s*([^;/]+)/);
  assert.ok(inkConst && inkToken, "INK_COLOR and the --ink token must both exist");
  assert.strictEqual(
    inkConst[1].toLowerCase(),
    inkToken[1].trim().toLowerCase(),
    "main/windows.js INK_COLOR must equal tokens.css --ink"
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
// an absurd one never fired (#210). recordingCapSeconds()'s own cases run in
// settings-contract.test.js, beside the field range it must match.
test("startRecording takes its cap through recordingCapSeconds", () => {
  // Both timer sites (first samples, resume) read recording.maxSeconds, so the
  // one validated assignment covers them.
  assert.match(js, /maxSeconds:\s*recordingCapSeconds\(maxSeconds\)/);
  assert.doesNotMatch(js, /maxSeconds:\s*maxSeconds\s*\|\|/);
});
