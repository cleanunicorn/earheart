// renderer/platform-context.js: platform-specific copy in Settings and the
// wizard shows only where it applies, and every such sentence starts hidden so
// it never flashes on the wrong system before the page learns where it runs.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "renderer", "platform-context.js"), "utf8");
const sandbox = {};
vm.runInNewContext(`${source}\nthis.platformMatches = platformMatches; this.showForPlatform = showForPlatform;`, sandbox);
const { platformMatches, showForPlatform } = sandbox;

test("Wayland notes are for Linux Wayland sessions only", () => {
  assert.equal(platformMatches("wayland", { platform: "linux", wayland: true }), true);
  assert.equal(platformMatches("wayland", { platform: "linux", wayland: false }), false, "X11 can grab global keys");
  assert.equal(platformMatches("wayland", { platform: "darwin", wayland: true }), false);
  assert.equal(platformMatches("wayland", { platform: "win32" }), false);
});

test("OS tokens match their platform; not-darwin is everything but macOS", () => {
  assert.equal(platformMatches("darwin", { platform: "darwin" }), true);
  assert.equal(platformMatches("darwin", { platform: "linux" }), false);
  assert.equal(platformMatches("win32", { platform: "win32" }), true);
  assert.equal(platformMatches("linux", { platform: "linux", wayland: false }), true);
  assert.equal(platformMatches("not-darwin", { platform: "win32" }), true);
  assert.equal(platformMatches("not-darwin", { platform: "darwin" }), false);
});

test("showForPlatform hides what doesn't apply and reveals what does", () => {
  const el = (os) => ({ dataset: { os }, hidden: true });
  const els = { wayland: el("wayland"), mac: el("darwin"), others: el("not-darwin"), either: el("darwin win32") };
  const root = { querySelectorAll: () => Object.values(els) };
  showForPlatform(root, { platform: "win32", wayland: false });
  assert.deepEqual(
    Object.fromEntries(Object.entries(els).map(([k, v]) => [k, v.hidden])),
    { wayland: true, mac: true, others: false, either: false }
  );
});

test("every platform-specific sentence starts hidden, and both pages load the helper first", () => {
  for (const page of ["settings.html", "wizard.html"]) {
    const html = fs.readFileSync(path.join(ROOT, "renderer", page), "utf8");
    const tagged = html.match(/<[^>]+data-os="[^"]*"[^>]*>/g) || [];
    assert.ok(tagged.length > 0, `${page} has platform-specific copy`);
    for (const tag of tagged) assert.match(tag, /\shidden[\s>]/, `${page}: ${tag} starts hidden`);
    const helper = html.indexOf('src="platform-context.js"');
    const own = html.indexOf(`src="${page.replace(".html", ".js")}"`);
    assert.ok(helper > 0 && helper < own, `${page} loads platform-context.js before its own script`);
    // Every "On Wayland" note sits inside a Wayland-only element.
    const bare = html.replace(/<span[^>]*data-os="wayland"[^>]*>[\s\S]*?<\/span>/g, "");
    assert.doesNotMatch(bare, /On Wayland/, `${page}: an untagged Wayland note`);
  }
});
