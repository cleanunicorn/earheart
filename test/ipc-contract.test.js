// Guards the IPC channel contract across its three layers: the renderer
// scripts call earheart.invoke/on/send, the preload bridge only lets
// whitelisted channels through (and throws "Unknown channel" for the rest),
// and the main process must register a matching ipcMain.handle/on.
//
// The layers are wired by string literals with no compile-time link, so a
// channel added to main/ipc.js but not to the preload allowlist produces a
// button that silently does nothing (the bridge throw dies as an unhandled
// rejection in an async listener) — exactly how "Open error log" shipped
// dead: logs:open had a handler and a caller but no allowlist entry. These
// tests parse the files as text — no DOM, no Electron — so that class of
// regression fails here instead of in the app.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const preload = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");

function readAll(dir, ext) {
  let out = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out += readAll(p, ext);
    else if (entry.name.endsWith(ext)) out += fs.readFileSync(p, "utf8") + "\n";
  }
  return out;
}

const renderer = readAll(path.join(ROOT, "renderer"), ".js");
const main = readAll(path.join(ROOT, "main"), ".js");

function channels(source, regex) {
  return new Set([...source.matchAll(regex)].map((m) => m[1]));
}

// The three preload allowlists: const LISTEN|SEND|INVOKE = new Set([ "…", … ])
function allowlist(name) {
  const block = preload.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(block, `preload.js should define the ${name} allowlist`);
  return channels(block[1], /"([a-z:-]+)"/g);
}

const LISTEN = allowlist("LISTEN");
const SEND = allowlist("SEND");
const INVOKE = allowlist("INVOKE");

// Renderer → main request channels. bindTest threads its channel through as
// a bare third argument (never an earheart.invoke("…") literal), so scan
// those call sites too or stt:test/cleanup:test go unguarded.
const invoked = new Set([
  ...channels(renderer, /earheart\.invoke\(\s*"([a-z:-]+)"/g),
  ...channels(renderer, /bindTest\(\s*"[^"]+"\s*,\s*"[^"]+"\s*,\s*"([a-z:-]+)"/g),
]);
const handled = channels(main, /ipcMain\.handle\(\s*"([a-z:-]+)"/g);

test("every channel the renderers invoke is in the preload INVOKE allowlist", () => {
  assert.ok(invoked.size > 20, `expected many invoked channels, got ${invoked.size}`);
  const missing = [...invoked].filter((c) => !INVOKE.has(c)).sort();
  assert.deepStrictEqual(missing, [], `preload INVOKE is missing: ${missing.join(", ")}`);
});

test("every channel the renderers invoke has an ipcMain.handle", () => {
  const missing = [...invoked].filter((c) => !handled.has(c)).sort();
  assert.deepStrictEqual(missing, [], `main has no handler for: ${missing.join(", ")}`);
});

test("every preload INVOKE entry has an ipcMain.handle (no dead allowlist entries)", () => {
  const dead = [...INVOKE].filter((c) => !handled.has(c)).sort();
  assert.deepStrictEqual(dead, [], `INVOKE allows channels main never handles: ${dead.join(", ")}`);
});

test("every channel the renderers listen on is in the preload LISTEN allowlist", () => {
  const listened = channels(renderer, /earheart\.on\(\s*"([a-z:-]+)"/g);
  assert.ok(listened.size > 10, `expected many listened channels, got ${listened.size}`);
  const missing = [...listened].filter((c) => !LISTEN.has(c)).sort();
  assert.deepStrictEqual(missing, [], `preload LISTEN is missing: ${missing.join(", ")}`);
});

// logs:open answers with an `action` naming which of its three fallbacks ran,
// and the renderer switches on that string to phrase the status line. The two
// sides are joined by nothing but the literal, so renaming one silently drops
// the other back to its default branch. `action:` appears nowhere else in
// main, so a file-wide scan is the whole set.
test("every logs:open action the renderer branches on is one main can return", () => {
  const emitted = channels(main, /action:\s*"([a-z]+)"/g);
  assert.deepStrictEqual(
    [...emitted].sort(),
    ["folder", "opened", "revealed"],
    "logs:open should return exactly the three documented outcomes",
  );
  // "opened" needs no branch — it falls through to printing the bare path.
  const compared = channels(renderer, /result\.action\s*===\s*"([a-z]+)"/g);
  const unknown = [...compared].filter((a) => !emitted.has(a)).sort();
  assert.deepStrictEqual(unknown, [], `renderer tests actions main never sends: ${unknown.join(", ")}`);
});

test("every channel the renderers send is in SEND and has an ipcMain.on", () => {
  const sent = channels(renderer, /earheart\.send\(\s*"([a-z:-]+)"/g);
  assert.ok(sent.size > 5, `expected many sent channels, got ${sent.size}`);
  const received = channels(main, /ipcMain\.on\(\s*"([a-z:-]+)"/g);
  const unlisted = [...sent].filter((c) => !SEND.has(c)).sort();
  assert.deepStrictEqual(unlisted, [], `preload SEND is missing: ${unlisted.join(", ")}`);
  const unreceived = [...sent].filter((c) => !received.has(c)).sort();
  assert.deepStrictEqual(unreceived, [], `main has no ipcMain.on for: ${unreceived.join(", ")}`);
});

// A channel can be allowlisted, sent and received and STILL lose data: the
// main-side handler destructures the payload, so a field the renderer sends but
// the handler forgets to name is dropped without a word. audio:partial shipped
// exactly that way — `fromSample` never reached the live preview, so every
// committed chunk failed its contiguity check and the final pass silently fell
// back to decoding the whole recording. Compare the two field lists.
test("every field the renderer sends on audio:partial reaches the main handler", () => {
  const sendBlock = renderer.match(
    /earheart\.send\(\s*"audio:partial",\s*\{([\s\S]*?)\}\s*\)/
  );
  assert.ok(sendBlock, "overlay.js should send audio:partial with an object literal");
  // Object-literal keys, shorthand (`final,`) and explicit (`fromSample: from,`).
  const sentFields = channels(sendBlock[1], /^\s*(\w+)\s*[,:]/gm);
  assert.ok(sentFields.has("fromSample"), "the send site should carry fromSample");

  const onBlock = main.match(
    // Lazy up to the FIRST brace: greedy would run past the destructure and
    // capture the empty `= {}` default instead.
    /ipcMain\.on\(\s*"audio:partial",\s*\([^)]*?\{([^}]*)\}/
  );
  assert.ok(onBlock, "main should receive audio:partial with a destructured payload");
  const receivedFields = channels(onBlock[1], /(\w+)/g);

  const dropped = [...sentFields].filter((f) => !receivedFields.has(f)).sort();
  assert.deepStrictEqual(
    dropped,
    [],
    `main's audio:partial handler drops: ${dropped.join(", ")}`
  );
});
