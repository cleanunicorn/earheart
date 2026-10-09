// Smoke checks for the window lock (main/window-guard.js + the per-window
// preload roles), run against a real app window by overlay-smoke and
// settings-smoke: the page cannot navigate itself to another file, cannot open
// a popup, and its bridge refuses a channel that belongs to another window
// while still serving its own.
//
// Unit tests prove the guard's logic against fakes; this proves Electron
// actually fires the events the guard listens on and the role reaches the
// sandboxed preload through additionalArguments.

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long a navigation to a local file would take to commit if nothing
// stopped it. Local pages commit in well under 100 ms on CI.
const NAVIGATION_GRACE_MS = 750;

// `refused` and `allowed` are { method, channel } pairs for the bridge. Pick
// channels that are harmless if the check fails (reads or listens), since a
// broken lock would let the call through to main.
async function checkWindowLock(win, { role, refused, allowed, check }) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const before = wc.getURL();

  // Another real app page, so an unguarded window would visibly land on it.
  const other = role === "wizard" ? "settings.html" : "wizard.html";
  const target = pathToFileURL(path.join(__dirname, "..", "renderer", other)).href;
  let committed = null;
  const onNavigate = (_event, url) => (committed = url);
  wc.on("did-navigate", onNavigate);
  try {
    await js(`location.href = ${JSON.stringify(target)}; "requested"`);
    await sleep(NAVIGATION_GRACE_MS);
  } finally {
    wc.removeListener("did-navigate", onNavigate);
  }
  check(
    `${role}: the page cannot navigate the window away`,
    committed === null && wc.getURL() === before,
    committed ? `navigated to ${committed}` : undefined
  );

  const popup = await js(`window.open(${JSON.stringify(target)}) === null`);
  check(`${role}: the page cannot open a popup`, popup === true);

  const probe = ({ method, channel }) =>
    js(`(() => {
      try {
        const r = earheart.${method}(${JSON.stringify(channel)}, ${method === "on" ? "() => {}" : "undefined"});
        if (r && typeof r.catch === "function") r.catch(() => {});
        return "allowed";
      } catch (err) {
        return err.message;
      }
    })()`);
  const refusedResult = await probe(refused);
  check(
    `${role}: the bridge refuses another window's ${refused.channel}`,
    refusedResult.startsWith(`Unknown channel: ${refused.channel}`),
    refusedResult
  );
  const allowedResult = await probe(allowed);
  check(`${role}: the bridge still serves its own ${allowed.channel}`, allowedResult === "allowed", allowedResult);
}

module.exports = { checkWindowLock };
