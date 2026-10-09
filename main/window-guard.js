// Least-privilege guards for the app's own windows. Every window loads one of
// three local pages and keeps the window.earheart bridge for as long as it
// lives, so anything that swaps the page out — a dropped file or link
// (Chromium navigates on drop), a stray location assignment, window.open —
// would hand that bridge, and the settings it can read and write, to foreign
// content. These guards keep each window on the page it was opened with.
//
// No electron import: windows.js and main.js pass in what they have, so the
// guards are unit-testable under plain `node --test`.

const path = require("node:path");
const { fileURLToPath } = require("node:url");

const RENDERER = path.join(__dirname, "..", "renderer");
const APP_PAGES = new Set(["overlay.html", "settings.html", "wizard.html"]);

// True when `url` is one of the app's own renderer pages (a query such as
// settings.html?wizard=1 is fine). Anything else — another file, another
// scheme, a malformed URL — is not ours.
function isAppPage(url) {
  let file;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;
    file = fileURLToPath(parsed);
  } catch {
    return false;
  }
  let dir = path.dirname(file);
  let root = RENDERER;
  // Windows paths are case-insensitive, and a drive letter may come back in
  // either case.
  if (process.platform === "win32") {
    dir = dir.toLowerCase();
    root = root.toLowerCase();
  }
  return dir === root && APP_PAGES.has(path.basename(file));
}

// Keep a window's page in place: refuse every renderer-initiated navigation
// that would leave the document (same-document hash changes are harmless and
// never reach a new page), deny every popup, and refuse <webview>. Programmatic
// loads from main (loadFile, reload) don't emit will-navigate, so the app's
// own reloads still work.
function guardNavigation(webContents, { onBlocked = () => {} } = {}) {
  webContents.on("will-navigate", (event) => {
    if (event.isSameDocument) return;
    event.preventDefault();
    onBlocked("navigation", event.url);
  });
  webContents.setWindowOpenHandler(({ url }) => {
    onBlocked("window.open", url);
    return { action: "deny" };
  });
  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    onBlocked("webview", "");
  });
}

// Microphone and clipboard-write are the only permissions the renderer asks
// for, and only the app's own pages may have them.
const GRANTED_PERMISSIONS = new Set(["media", "clipboard-sanitized-write"]);

function shouldGrantPermission(permission, requestingUrl) {
  return GRANTED_PERMISSIONS.has(permission) && isAppPage(requestingUrl);
}

// Install the permission policy on a session. details.requestingUrl is the
// URL the asking frame last loaded; fall back to the page's own URL.
function installPermissionHandler(session) {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldGrantPermission(permission, details?.requestingUrl || webContents?.getURL()));
  });
}

module.exports = {
  isAppPage,
  guardNavigation,
  shouldGrantPermission,
  installPermissionHandler,
};
