// Where is this dictation going? (#336) The frontmost application and, when it
// is a supported browser, the host of the page in its front tab.
//
// Support (see docs/formatting-profiles.md):
//   macOS    frontmost app via System Events; browser host via Apple Events
//            (Safari, Chromium-family browsers, Arc). Needs the Automation
//            permission for the browser, asked by macOS on first use.
//   others   unsupported → the caller falls back to the default style.
//
// Guarantees:
//   - Never throws and never rejects; every failure is "unavailable".
//   - Bounded by a timeout, so it can never hold up dictation.
//   - A browser is queried ONLY when System Events says it is frontmost, so a
//     non-running or background browser is never launched or asked.
//   - Only the hostname leaves this module. The full URL, the page title and
//     the document are never returned, logged or stored; error paths log the
//     failure kind, not tool output (which can contain the URL).

const { execFileAsync } = require("./util/exec-file");
const { normalizeHost } = require("./formatting-profiles");
const logger = require("./util/logger");

const DETECT_TIMEOUT_MS = 700;

const FRONTMOST_SCRIPT =
  'tell application "System Events" to get {bundle identifier, name} of first application process whose frontmost is true';

// Bundle id → how to ask for the front tab's URL. `current tab` is Safari's
// AppleScript term; Chromium-family browsers and Arc say `active tab`.
const BROWSERS = new Map([
  ["com.apple.safari", "current tab"],
  ["com.apple.safaritechnologypreview", "current tab"],
  ["com.google.chrome", "active tab"],
  ["com.google.chrome.beta", "active tab"],
  ["com.google.chrome.dev", "active tab"],
  ["com.google.chrome.canary", "active tab"],
  ["com.brave.browser", "active tab"],
  ["com.microsoft.edgemac", "active tab"],
  ["com.vivaldi.vivaldi", "active tab"],
  ["com.operasoftware.opera", "active tab"],
  ["company.thebrowser.browser", "active tab"], // Arc
]);

const UNAVAILABLE = Object.freeze({ supported: false, app: null, host: null });

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(UNAVAILABLE), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseFrontmost(out) {
  // "com.apple.Safari, Safari"
  const text = String(out || "").trim();
  const i = text.indexOf(",");
  if (i < 1) return null;
  const id = text.slice(0, i).trim();
  const name = text.slice(i + 1).trim();
  return id ? { id, name } : null;
}

// Host of the page in the front window's active tab, or null.
async function browserHost(exec, bundleId, tabTerm) {
  // `application id` addresses the already-running frontmost app; no name
  // lookup, no launch.
  const script = `tell application id "${bundleId}" to get URL of ${tabTerm} of front window`;
  const out = await exec("osascript", ["-e", script], { timeout: DETECT_TIMEOUT_MS });
  return normalizeHost(String(out || "").trim()) || null;
}

async function detectMac(exec) {
  let app = null;
  try {
    app = parseFrontmost(await exec("osascript", ["-e", FRONTMOST_SCRIPT], { timeout: DETECT_TIMEOUT_MS }));
  } catch (err) {
    logger.warn(`destination detection unavailable: app (${err?.killed ? "timeout" : "error"})`);
    return UNAVAILABLE;
  }
  if (!app) return UNAVAILABLE;
  const tabTerm = BROWSERS.get(app.id.toLowerCase());
  let host = null;
  if (tabTerm) {
    try {
      host = await browserHost(exec, app.id, tabTerm);
    } catch (err) {
      // Typically Automation not granted for this browser. Not an error for
      // the user: dictation continues on the application rule or default.
      logger.warn(`destination detection unavailable: browser host (${err?.killed ? "timeout" : "denied or no window"})`);
    }
  }
  return { supported: true, app: { id: app.id, name: app.name }, host };
}

// → { supported, app: { id, name } | null, host: string | null }
function createContextDetector({ platform = process.platform, exec = execFileAsync, timeoutMs = DETECT_TIMEOUT_MS * 3 } = {}) {
  return {
    // False where there is nothing to detect (not macOS): the pipeline then
    // settles the take's formatting at once, without waiting a tick.
    supported: platform === "darwin",
    detect() {
      if (platform !== "darwin") return Promise.resolve(UNAVAILABLE);
      return withTimeout(
        detectMac(exec).catch(() => UNAVAILABLE),
        timeoutMs
      );
    },
  };
}

module.exports = { createContextDetector, BROWSERS, DETECT_TIMEOUT_MS, UNAVAILABLE };
