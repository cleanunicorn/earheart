// Output delivery: put text into the app the user is working in.
//
// "paste" mode writes the text to the clipboard and simulates the platform
// paste keystroke (Cmd+V / Ctrl+V) in the focused application, optionally
// restoring the previous clipboard contents afterwards.
// "paste-copy" mode pastes the same way but always leaves the transcript on
// the clipboard (never restores the previous contents).
// "clipboard" mode only copies, leaving pasting to the user.
//
// Keystroke simulation per platform:
//   macOS   - osascript (System Events); needs Accessibility permission for
//             the keystroke and Automation permission (Apple Events to System
//             Events) for the packaged app to talk to System Events at all
//   Windows - PowerShell SendKeys
//   Linux   - wtype or ydotool on Wayland, xdotool on X11; if none of those
//             tools exist we degrade to clipboard-only and tell the caller.

const { app, clipboard, systemPreferences, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const logger = require("../util/logger");

// Deep link to System Settings ▸ Privacy & Security ▸ Accessibility. The URL is
// unchanged across the old System Preferences and the new System Settings, so it
// resolves on modern macOS (Ventura+).
const ACCESSIBILITY_PANE_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
// Privacy & Security ▸ Automation: where a denied "control System Events"
// decision is undone.
const AUTOMATION_PANE_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

// The AppleScript auto-paste runs. Also used as the Automation probe: it only
// reaches System Events at all when the user has allowed Earheart to control
// it, so the same one-liner tells us whether that permission is on.
const PASTE_SCRIPT = 'tell application "System Events" to keystroke "v" using command down';
const PROBE_SCRIPT = 'tell application "System Events" to get name';

// The bundle identifier TCC files Earheart's permission decisions under. Must
// match `appId` in electron-builder.yml (a unit test holds them together).
const MAC_BUNDLE_ID = "dev.cleanunicorn.earheart";

// Accessibility is off for this build. Either it was never granted, or —
// because releases are not signed with a stable identity, so macOS ties a
// grant to the exact build that received it — an update left the old build's
// grant listed and switched on while the new build is untrusted.
const ACCESSIBILITY_OFF = {
  note: "Accessibility permission is off",
  hint: "Accessibility is off for Earheart (an update can reset it) — Settings ▸ Advanced ▸ Fix auto-paste permission",
};

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, ...options }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // Prefer the tool's own stderr, but keep the raw error underneath so a
      // caller can tell a timeout or abort apart from a real failure.
      const wrapped = new Error(stderr?.trim() || err.message, { cause: err });
      wrapped.killed = !!err.killed;
      wrapped.aborted = err.name === "AbortError" || err.code === "ABORT_ERR";
      reject(wrapped);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandExists(cmd) {
  const dirs = (process.env.PATH || "").split(":");
  return dirs.some((dir) => {
    try {
      fs.accessSync(`${dir}/${cmd}`, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function isWayland() {
  return (
    process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY
  );
}

async function simulatePasteLinux() {
  // Each candidate either succeeds or we move on to the next one.
  const candidates = [];
  if (isWayland()) {
    // wtype: works on wlroots compositors (Sway, Hyprland, ...)
    candidates.push(["wtype", ["-M", "ctrl", "-k", "v", "-m", "ctrl"]]);
    // ydotool: works anywhere its daemon runs (29 = LeftCtrl, 47 = V)
    candidates.push(["ydotool", ["key", "29:1", "47:1", "47:0", "29:0"]]);
    // XWayland apps can still be reachable via xdotool
    candidates.push(["xdotool", ["key", "--clearmodifiers", "ctrl+v"]]);
  } else {
    candidates.push(["xdotool", ["key", "--clearmodifiers", "ctrl+v"]]);
  }

  const available = candidates.filter(([cmd]) => commandExists(cmd));
  if (available.length === 0) {
    throw new Error(
      "No keystroke tool found (install wtype, ydotool or xdotool)"
    );
  }
  let lastErr = null;
  for (const [cmd, args] of available) {
    try {
      await execFileAsync(cmd, args);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Turn the raw osascript failure into something the user can act on. The
// permission errors macOS raises look nothing alike, and both leave the text
// safely on the clipboard, so the overlay note is where the user learns which
// toggle to flip. `note` is one short line (the overlay's detail row shows
// roughly 25 characters before it clips); `hint` is the full instruction, for
// the notification and the log. osascript always prints the numeric code in
// parentheses; the prose around it is localized, so only the code is matched.
function explainMacPasteError(err) {
  const message = typeof err === "string" ? err : err.message;
  // The child was killed by our timeout: nothing on stderr, and almost always
  // because the Automation prompt sat unanswered behind a full-screen app.
  if (typeof err === "object" && err.killed) {
    return {
      note: "Automation prompt not answered",
      hint: "macOS is waiting for you to allow Earheart to control System Events — dictate again and click Allow",
    };
  }
  // -1743 errAEEventNotPermitted: Automation was denied, so osascript never
  // reaches System Events.
  if (/\(-1743\)/.test(message)) {
    return {
      note: "Automation permission is off",
      hint: "Allow Earheart to control System Events under System Settings ▸ Privacy & Security ▸ Automation",
    };
  }
  // 1002: System Events refused the keystroke, which is Accessibility.
  if (/\(1002\)/.test(message)) return ACCESSIBILITY_OFF;
  return { note: message, hint: message };
}

async function simulatePaste(signal) {
  if (process.platform === "darwin") {
    // The first run can pop the Automation permission dialog, and osascript
    // blocks until the user answers it — give them time to read it. The
    // signal lets Cancel kill the waiting child instead of leaving it to fire
    // Cmd+V into whatever is focused once the dialog is finally answered.
    await execFileAsync("osascript", ["-e", PASTE_SCRIPT], { timeout: 30000, signal });
  } else if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    ]);
  } else {
    await simulatePasteLinux();
  }
}

let pendingRestore = null;
let accessibilityPrompted = false;

/**
 * Deliver text to the user.
 * @param {string} text
 * @param {object} cfg - settings.output slice
 * @param {AbortSignal} [signal]
 * @returns {Promise<{method: "paste"|"paste-copy"|"clipboard"|"cancelled", note?: string, hint?: string}>}
 *   `note` is a one-line reason auto-paste fell back to the clipboard (short
 *   enough for the overlay); `hint` is the full instruction for a notification.
 */
async function deliver(text, cfg, signal) {
  if (signal?.aborted) return { method: "cancelled" };
  // A restore scheduled by a previous dictation must not clobber this one.
  if (pendingRestore) {
    clearTimeout(pendingRestore);
    pendingRestore = null;
  }
  const pasting = cfg.mode === "paste" || cfg.mode === "paste-copy";
  // Only plain "paste" mode restores; "paste-copy" exists precisely to keep
  // the transcript on the clipboard after pasting.
  const previous =
    cfg.mode === "paste" && cfg.restoreClipboard ? clipboard.readText() : null;
  clipboard.writeText(text);

  if (!pasting) {
    return { method: "clipboard" };
  }

  // Give the target app a moment to be focused (the overlay never takes
  // focus, but the clipboard write itself can need a beat on some systems).
  await sleep(cfg.pasteDelayMs ?? 150);
  if (signal?.aborted) return { method: "cancelled" };
  // Ask macOS directly before driving System Events. An untrusted app's
  // keystroke can never land, and the osascript attempt can hang on a
  // permission prompt or fail with an error that doesn't say the grant went
  // stale after an update.
  if (!accessibilityTrusted()) {
    logger.error("auto-paste skipped:", ACCESSIBILITY_OFF.hint);
    // Skipping the keystroke also skips the prompt System Events would have
    // raised for a never-decided app, so raise it ourselves, once per launch.
    if (!accessibilityPrompted) {
      accessibilityPrompted = true;
      accessibilityTrusted(true);
    }
    return { method: "clipboard", ...ACCESSIBILITY_OFF };
  }
  try {
    await simulatePaste(signal);
  } catch (err) {
    if (signal?.aborted || err.aborted) return { method: "cancelled" };
    // Text is already on the clipboard, so the user can paste manually. The
    // overlay note vanishes in seconds; the log line is what survives, so it
    // carries the verbatim tool output, not just our reading of it.
    const { note, hint } =
      process.platform === "darwin" ? explainMacPasteError(err) : { note: err.message, hint: err.message };
    logger.error("auto-paste failed:", hint, "—", err.cause ?? err);
    return { method: "clipboard", note, hint };
  }
  // Cancelled while the keystroke was in flight: the paste may have landed,
  // but nothing after it (the clipboard restore) should run for a dead session.
  if (signal?.aborted) return { method: "cancelled" };

  if (previous !== null) {
    // Wait for the target app to consume the clipboard before restoring it,
    // and only restore if nothing else has written to it since.
    pendingRestore = setTimeout(() => {
      pendingRestore = null;
      if (clipboard.readText() === text) clipboard.writeText(previous);
    }, 1000);
  }
  return { method: cfg.mode };
}

// Whether macOS trusts this app for Accessibility, which auto-paste needs to
// drive the Cmd+V keystroke through System Events. Non-macOS platforms have no
// such permission, so they are always "granted". Pass prompt=true to let macOS
// show its permission dialog — a no-op once the user has already decided, which
// is why openAccessibilitySettings exists as the reliable fallback.
function accessibilityTrusted(prompt = false) {
  if (process.platform !== "darwin") return true;
  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

// Open the Accessibility pane so the user can flip Earheart's toggle — the only
// thing that works once macOS has recorded a decision and won't prompt again.
function openAccessibilitySettings() {
  return shell.openExternal(ACCESSIBILITY_PANE_URL);
}

// Whether macOS lets this app send Apple Events to System Events (Privacy &
// Security ▸ Automation), the second permission auto-paste needs. There is no
// query API for it, so ask System Events something harmless: a never-decided
// app gets the native prompt (which is what we want). Resolves "granted",
// "denied" (-1743: a refusal is on record), "pending" (our timeout killed the
// probe, almost always because the prompt went unanswered) or "error".
// Non-macOS platforms have no such permission.
async function automationStatus() {
  if (process.platform !== "darwin") return "granted";
  try {
    await execFileAsync("osascript", ["-e", PROBE_SCRIPT], { timeout: 30000 });
    return "granted";
  } catch (err) {
    logger.warn("automation probe failed:", err.cause ?? err);
    if (err.killed) return "pending";
    return /\(-1743\)/.test(err.message) ? "denied" : "error";
  }
}

async function automationTrusted() {
  return (await automationStatus()) === "granted";
}

function openAutomationSettings() {
  return shell.openExternal(AUTOMATION_PANE_URL);
}

// Forget Earheart's recorded decision for a TCC service ("Accessibility" or
// "AppleEvents"). A grant left behind by an older build keeps its toggle on in
// System Settings while trusting nothing, and macOS never prompts again while
// any decision is on record — clearing it is what lets the native prompt come
// back. Only for the packaged app: under `npm start` the decisions belong to
// Electron or the terminal, not to Earheart. Best-effort; resolves whether the
// reset went through.
async function resetMacPermission(service) {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  try {
    await execFileAsync("/usr/bin/tccutil", ["reset", service, MAC_BUNDLE_ID]);
    logger.info(`tccutil reset ${service} ${MAC_BUNDLE_ID}: ok`);
    return true;
  } catch (err) {
    logger.warn(`tccutil reset ${service} failed:`, err.cause ?? err);
    return false;
  }
}

const macPermissions = {
  accessibilityTrusted,
  automationStatus,
  resetMacPermission,
  openAccessibilitySettings,
  openAutomationSettings,
};

/**
 * Get auto-paste back to a working state on macOS (Settings ▸ Advanced ▸ Fix
 * auto-paste permission). For whichever permission is off, clear Earheart's
 * recorded decision so macOS asks again, fire the native prompt, and open the
 * pane as the fallback. Other platforms report granted.
 * @param {object} [p] - permission primitives, injectable for tests
 * @returns {Promise<{granted: boolean, pane?: "accessibility"|"automation",
 *   opened?: boolean, reset?: boolean, automation?: string}>}
 *   `reset` says whether the stale decision was cleared; `automation` is the
 *   final probe status when the Automation pane is the one to act on.
 */
async function fixPastePermissions(p = macPermissions) {
  let result;
  if (!p.accessibilityTrusted()) {
    const reset = await p.resetMacPermission("Accessibility");
    // An update leaves the Automation grant as stale as the Accessibility one;
    // clearing both now means one click repairs both, and the next paste gets
    // a fresh Automation prompt instead of a -1743.
    if (reset) await p.resetMacPermission("AppleEvents");
    // A no-op while a decision is still on record; the pane covers that.
    p.accessibilityTrusted(true);
    result = { granted: false, pane: "accessibility", reset };
  } else {
    let automation = await p.automationStatus();
    let reset = false;
    // Only a refusal on record is worth clearing: a probe that timed out is a
    // prompt still waiting, and any other failure is not a permission.
    if (automation === "denied") {
      reset = await p.resetMacPermission("AppleEvents");
      if (reset) automation = await p.automationStatus();
    }
    if (automation === "granted") return { granted: true };
    result = { granted: false, pane: "automation", reset, automation };
  }
  try {
    await (result.pane === "automation" ? p.openAutomationSettings() : p.openAccessibilitySettings());
    return { ...result, opened: true };
  } catch {
    return { ...result, opened: false };
  }
}

// Called once on the first launch after an update. The update has just
// invalidated the Accessibility grant (see ACCESSIBILITY_OFF), so repair it
// before the user dictates into a paste that can't land: clear the stale
// decisions and let macOS ask again. Does nothing for a build macOS already
// trusts, or outside the packaged app.
async function repairPastePermissionsAfterUpdate(p = macPermissions) {
  if (process.platform !== "darwin" || !app.isPackaged || p.accessibilityTrusted()) return false;
  logger.info("updated build is not trusted for Accessibility; clearing the stale grant");
  if (await p.resetMacPermission("Accessibility")) await p.resetMacPermission("AppleEvents");
  p.accessibilityTrusted(true);
  return true;
}

module.exports = {
  deliver,
  accessibilityTrusted,
  automationTrusted,
  fixPastePermissions,
  repairPastePermissionsAfterUpdate,
  explainMacPasteError,
  MAC_BUNDLE_ID,
};
