// Guards the contract between the settings renderer script and its markup.
//
// settings.js drives the UI entirely by element id and radio-group name, so a
// markup redesign that drops or renames an element breaks the window silently
// (the script throws at runtime, not at load). These tests parse both files as
// text — no DOM, no Electron — and assert every id/name the script reaches for
// exists in the HTML, so a regression fails here instead of in the app.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER = path.join(__dirname, "..", "renderer");
const html = fs.readFileSync(path.join(RENDERER, "settings.html"), "utf8");
const js = fs.readFileSync(path.join(RENDERER, "settings.js"), "utf8");
const css = fs.readFileSync(path.join(RENDERER, "settings.css"), "utf8");

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
  assert.ok(referenced.size > 20, `expected many referenced ids, got ${referenced.size}`);

  const missing = [...referenced].filter((id) => !htmlIds.has(id)).sort();
  assert.deepStrictEqual(missing, [], `settings.html is missing ids: ${missing.join(", ")}`);
});

test("every radio/checkbox group name settings.js uses exists in settings.html", () => {
  const referenced = new Set(
    [...js.matchAll(/name="([a-z-]+)"/g)].map((m) => m[1])
  );
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
