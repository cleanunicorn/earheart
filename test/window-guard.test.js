// main/window-guard.js: which URLs count as the app's own pages, the
// permission policy built on that, and the navigation guard every app window
// gets. Plain node — the guard takes the webContents it guards, so a recording
// fake stands in for Electron.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  isAppPage,
  guardNavigation,
  shouldGrantPermission,
  installPermissionHandler,
} = require("../main/window-guard");

const RENDERER = path.join(__dirname, "..", "renderer");
const page = (name) => pathToFileURL(path.join(RENDERER, name)).href;

test("isAppPage accepts the three renderer pages, with or without a query", () => {
  for (const name of ["overlay.html", "settings.html", "wizard.html"]) {
    assert.ok(isAppPage(page(name)), name);
  }
  assert.ok(isAppPage(`${page("settings.html")}?wizard=1`));
  assert.ok(isAppPage(`${page("settings.html")}#general`));
});

test("isAppPage refuses anything that is not one of those pages", () => {
  const refused = [
    page("evil.html"), // another file in the renderer directory
    page("overlay.js"),
    pathToFileURL(path.join(RENDERER, "..", "settings.html")).href, // a sibling directory
    pathToFileURL(path.join(RENDERER, "sub", "settings.html")).href, // a subdirectory
    pathToFileURL(path.join(RENDERER, "sub", "..", "..", "x", "settings.html")).href,
    "https://example.com/settings.html",
    "http://127.0.0.1:8484/renderer/settings.html",
    "data:text/html,<p>hi",
    "about:blank",
    "not a url",
    "",
    undefined,
  ];
  for (const url of refused) assert.strictEqual(isAppPage(url), false, String(url));
});

test("permissions: only microphone and clipboard-write, and only for app pages", () => {
  assert.ok(shouldGrantPermission("media", page("overlay.html")));
  assert.ok(shouldGrantPermission("clipboard-sanitized-write", page("settings.html")));
  assert.strictEqual(shouldGrantPermission("media", "https://example.com/"), false);
  assert.strictEqual(shouldGrantPermission("media", page("evil.html")), false);
  assert.strictEqual(shouldGrantPermission("geolocation", page("overlay.html")), false);
  assert.strictEqual(shouldGrantPermission("notifications", page("settings.html")), false);
});

test("the installed handler judges the requesting URL, falling back to the page URL", () => {
  let handler;
  installPermissionHandler({ setPermissionRequestHandler: (h) => (handler = h) });
  const ask = (permission, details, pageUrl) => {
    let granted;
    handler({ getURL: () => pageUrl }, permission, (v) => (granted = v), details);
    return granted;
  };
  assert.strictEqual(ask("media", { requestingUrl: page("overlay.html") }, "https://evil/"), true);
  assert.strictEqual(ask("media", { requestingUrl: "https://evil/" }, page("overlay.html")), false);
  assert.strictEqual(ask("media", {}, page("settings.html")), true);
  assert.strictEqual(ask("media", undefined, "https://evil/"), false);
});

function fakeWebContents() {
  const handlers = {};
  return {
    handlers,
    on: (event, handler) => (handlers[event] = handler),
    setWindowOpenHandler: (handler) => (handlers.windowOpen = handler),
  };
}

function navEvent(props) {
  return { ...props, prevented: false, preventDefault() { this.prevented = true; } };
}

test("guardNavigation refuses leaving the page, popups and webviews", () => {
  const wc = fakeWebContents();
  const blocked = [];
  guardNavigation(wc, { onBlocked: (what, url) => blocked.push([what, url]) });

  // A dropped file or link, or a location assignment: a cross-document load.
  for (const url of [page("wizard.html"), "https://example.com/", "file:///tmp/evil.html"]) {
    const event = navEvent({ url, isSameDocument: false });
    wc.handlers["will-navigate"](event);
    assert.ok(event.prevented, `navigation to ${url} must be prevented`);
  }
  assert.deepStrictEqual(wc.handlers.windowOpen({ url: "https://example.com/" }), { action: "deny" });
  const webview = navEvent({});
  wc.handlers["will-attach-webview"](webview);
  assert.ok(webview.prevented, "a <webview> must not attach");
  assert.deepStrictEqual(blocked.map(([what]) => what), ["navigation", "navigation", "navigation", "window.open", "webview"]);
});

test("guardNavigation lets same-document navigation through", () => {
  const wc = fakeWebContents();
  guardNavigation(wc);
  const event = navEvent({ url: `${page("settings.html")}#history`, isSameDocument: true });
  wc.handlers["will-navigate"](event);
  assert.strictEqual(event.prevented, false);
});
