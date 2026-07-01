// Guards the contract between the settings renderer script and its markup, and
// the settings/wizard shared-stylesheet coupling.
//
// settings.js drives the UI entirely by element id and radio-group name, so a
// markup redesign that drops or renames an element breaks the window silently
// (the script throws at runtime, not at load). wizard.html layers wizard.css on
// top of settings.css and reuses its :root tokens, so a token rename breaks the
// wizard just as silently. These tests parse the files as text — no DOM, no
// Electron — and assert those contracts hold, so a regression fails here instead
// of in the app.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER = path.join(__dirname, "..", "renderer");
const html = fs.readFileSync(path.join(RENDERER, "settings.html"), "utf8");
const js = fs.readFileSync(path.join(RENDERER, "settings.js"), "utf8");
const css = fs.readFileSync(path.join(RENDERER, "settings.css"), "utf8");
const wizardCss = fs.readFileSync(path.join(RENDERER, "wizard.css"), "utf8");

const htmlIds = new Set([...html.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]));
const htmlNames = new Set([...html.matchAll(/name="([a-z0-9-]+)"/g)].map((m) => m[1]));

// The engine helpers build ids as `${kind}-…` for kind in {stt, cleanup}; expand
// those template ids so the presence check covers what the script really queries.
function expand(id) {
  if (!id.includes("${kind}")) return [id];
  return ["stt", "cleanup"].map((k) => id.replace("${kind}", k));
}

test("every id settings.js references exists in settings.html", () => {
  const referenced = new Set();
  // $("id"), getElementById("id"), getElementById(`${kind}-…`)
  for (const m of js.matchAll(/(?:\$|getElementById)\(\s*[`"]([a-z0-9${}-]+)[`"]\s*\)/g)) {
    for (const id of expand(m[1])) referenced.add(id);
  }
  // Ids threaded through the bind* helpers as bare string arguments never appear
  // inside a $()/getElementById() call, so scan those call sites too. bindTest's
  // first two args are element ids (the third is an IPC channel — skip it);
  // bindFetchModels' first three are ids (button, result, <datalist>).
  for (const m of js.matchAll(/bindTest\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
    referenced.add(m[1]);
    referenced.add(m[2]);
  }
  for (const m of js.matchAll(/bindFetchModels\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
    referenced.add(m[1]);
    referenced.add(m[2]);
    referenced.add(m[3]);
  }
  assert.ok(referenced.size > 30, `expected many referenced ids, got ${referenced.size}`);

  const missing = [...referenced].filter((id) => !htmlIds.has(id)).sort();
  assert.deepStrictEqual(missing, [], `settings.html is missing ids: ${missing.join(", ")}`);
});

test("each tab's panel id (tab-<data-tab>) exists in settings.html", () => {
  // The tab click handler activates panels via `tab-${tab.dataset.tab}`, an id
  // the plain-string scan above can't see. Pin it from the nav's data-tab values.
  const dataTabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(dataTabs.length >= 5, `expected the five tabs, got ${dataTabs.length}`);
  const missing = dataTabs.filter((t) => !htmlIds.has(`tab-${t}`)).sort();
  assert.deepStrictEqual(missing, [], `missing tab panels: ${missing.map((t) => `tab-${t}`).join(", ")}`);
});

test("every radio/checkbox group name settings.js uses exists in settings.html", () => {
  const referenced = new Set([...js.matchAll(/name="([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(referenced.size >= 3, "expected the output-mode/stt-engine/cleanup-engine groups");

  const missing = [...referenced].filter((n) => !htmlNames.has(n)).sort();
  assert.deepStrictEqual(missing, [], `settings.html is missing radio groups: ${missing.join(", ")}`);
});

test("settings.html uses no inline style attributes (blocked by the CSP)", () => {
  // The window's Content-Security-Policy is `style-src 'self'`, which forbids
  // inline style="…" attributes. Any such attribute would be silently dropped.
  const inline = [...html.matchAll(/<[^>]*\sstyle="/g)];
  assert.strictEqual(inline.length, 0, "found inline style= attributes; move them to settings.css");
});

test("settings.css forces [hidden] to win over component display rules", () => {
  // Components like .row and .segmented set their own display, which overrides
  // the user-agent [hidden] rule. settings.js hides several such elements via
  // the hidden attribute (e.g. #cleanup-test-row), so a global guard is required.
  const normalized = css.replace(/\s+/g, " ");
  assert.match(
    normalized,
    /\[hidden\]\s*{\s*display:\s*none\s*!important/,
    "expected a global `[hidden] { display: none !important }` rule"
  );
});

test("every CSS variable used by settings.css and wizard.css is defined in :root", () => {
  // wizard.css layers on settings.css and reuses its tokens; a token rename in
  // settings.css would leave the wizard rendering with invalid values silently.
  const root = css.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(root, "settings.css should define a :root block");
  const defined = new Set([...root[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  const used = new Set(
    [...(css + wizardCss).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])
  );
  const undefinedVars = [...used].filter((v) => !defined.has(v)).sort();
  assert.deepStrictEqual(undefinedVars, [], `CSS vars used but not defined in :root: ${undefinedVars.join(", ")}`);
});

test("shared classes the wizard relies on still exist in settings.css", () => {
  // wizard.html reuses these settings.css primitives; renaming one silently
  // breaks the wizard's chrome. Cheap tripwire that each selector still appears.
  const shared = [".field", ".row", ".hint", ".status", ".lead", ".choice", "button.primary", "button.ghost", "code"];
  const missing = shared.filter((sel) => !css.includes(sel)).sort();
  assert.deepStrictEqual(missing, [], `settings.css no longer defines: ${missing.join(", ")}`);
});
