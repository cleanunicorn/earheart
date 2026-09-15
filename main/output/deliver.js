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
const path = require("node:path");
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
  if (signal?.aborted) {
    // Plain paste promises to put the previous clipboard back. Cancellation
    // before the keystroke should keep that promise too, but only if another
    // app has not replaced our transcript in the meantime.
    if (previous !== null && clipboard.readText() === text) {
      clipboard.writeText(previous);
    }
    return { method: "cancelled" };
  }
  // Ask macOS directly before driving System Events. An untrusted app's
  // keystroke can never land, and the osascript attempt can hang on a
  // permission prompt or fail with an error that doesn't say the grant went
  // stale after an update.
  if (!accessibilityTrusted()) {
    logger.error("auto-paste skipped:", ACCESSIBILITY_OFF.hint);
    // Skipping the keystroke also skips the prompt System Events would have
    // raised for a never-decided app, so raise it ourselves, once per launch.
    // Once per launch, clear a stale grant this build hasn't repaired yet and
    // raise the prompt. Not awaited: the transcript is already on the
    // clipboard and the fallback must not wait on tccutil.
    if (!repairRanThisLaunch) {
      repairPastePermissions().catch((err) => logger.warn("permission repair failed:", err));
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
// Non-macOS platforms have no such permission. `run` and `platform` are
// injectable for tests.
async function automationStatus({ run = execFileAsync, platform = process.platform } = {}) {
  if (platform !== "darwin") return "granted";
  try {
    await run("osascript", ["-e", PROBE_SCRIPT], { timeout: 30000 });
    return "granted";
  } catch (err) {
    logger.warn("automation probe failed:", err.cause ?? err);
    if (err.killed) return "pending";
    return /\(-1743\)/.test(err.message) ? "denied" : "error";
  }
}

function openAutomationSettings() {
  return shell.openExternal(AUTOMATION_PANE_URL);
}

// Forget Earheart's recorded decision for a TCC service ("Accessibility" or
// "AppleEvents"). A grant left behind by an older build keeps its toggle on in
// System Settings while trusting nothing, and macOS never prompts again while
// any decision is on record — clearing it is what lets the native prompt come
// back. Always scoped to our bundle id: without it tccutil resets the service
// for every app. Only for the packaged app: under `npm start` the decisions
// belong to Electron or the terminal, not to Earheart. Best-effort; resolves
// whether the reset went through.
async function resetMacPermission(
  service,
  { run = execFileAsync, platform = process.platform, packaged = app.isPackaged } = {}
) {
  if (platform !== "darwin" || !packaged) return false;
  try {
    await run("/usr/bin/tccutil", ["reset", service, MAC_BUNDLE_ID]);
    logger.info(`tccutil reset ${service} ${MAC_BUNDLE_ID}: ok`);
    return true;
  } catch (err) {
    logger.warn(`tccutil reset ${service} failed:`, err.cause ?? err);
    return false;
  }
}

const macPermissions = {
  accessibilityTrusted,
  automationStatus: () => automationStatus(),
  resetMacPermission: (service) => resetMacPermission(service),
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

// Passive state for the settings window's refocus check: never resets or
// opens anything. `automation` is only probed once Accessibility is on, so the
// UI can move on to the next blocker after the user flips the first toggle.
async function checkPastePermissions(p = macPermissions) {
  if (!p.accessibilityTrusted()) return { granted: false, accessibility: false };
  const automation = await p.automationStatus();
  return { granted: automation === "granted", accessibility: true, automation };
}

// Which build the automatic stale-grant repair last ran for. Its own file, not
// settings.json: the settings window saves whole objects, and the repair must
// not depend on the wizard having written settings yet.
function repairMarkerPath() {
  return path.join(app.getPath("userData"), "paste-permission-repair");
}

const repairMarker = {
  read() {
    try {
      return fs.readFileSync(repairMarkerPath(), "utf8").trim();
    } catch {
      return "";
    }
  },
  write(version) {
    try {
      fs.writeFileSync(repairMarkerPath(), version);
    } catch (err) {
      logger.warn("could not record the permission repair:", err);
    }
  },
};

/**
 * Repair auto-paste permissions without a click, once per build. Releases have
 * no stable signing identity, so every update leaves the Accessibility (and
 * Automation) grant on record for the old build: shown as on, trusting
 * nothing, never re-prompted. When this build is untrusted and hasn't been
 * repaired yet, clear both decisions and raise the prompt. Runs at a visible,
 * non-first-run startup in a paste mode, or else on the first skipped paste of
 * a launch — so a hidden login launch stays silent and switching from
 * clipboard-only to paste later still gets it. At most once per launch. The
 * build is recorded only when both resets went through, so a failure is
 * retried next launch.
 * @returns {Promise<"not-needed"|"already-repaired"|"repaired"|"reset-failed">}
 *   "already-repaired" also covers the unpackaged app, which only prompts.
 */
// Whether startup should run the repair: a returning user's visible launch in
// a paste mode. A first run hasn't chosen how to deliver yet and a hidden login
// launch stays silent; the first skipped paste covers both.
function shouldRepairAtStartup({ smokeTest, firstRun, hidden, mode }) {
  return !smokeTest && !firstRun && !hidden && mode !== "clipboard";
}

// Startup and the first skipped paste can both ask for the repair. One run
// per launch, shared while in flight: two overlapping resets could clear a
// grant the user accepted from the first prompt.
let repairRanThisLaunch = false;
let repairInFlight = null;

function repairPastePermissions(options) {
  if (!repairInFlight) {
    repairRanThisLaunch = true;
    repairInFlight = runPastePermissionRepair(options).finally(() => {
      repairInFlight = null;
    });
  }
  return repairInFlight;
}

async function runPastePermissionRepair({
  p = macPermissions,
  marker = repairMarker,
  platform = process.platform,
  packaged = app.isPackaged,
  version = app.getVersion?.(),
} = {}) {
  if (platform !== "darwin") return "not-needed";
  if (p.accessibilityTrusted()) return "not-needed";
  // Under `npm start` the grants belong to Electron or the terminal, so there
  // is nothing of ours to clear — but the prompt is still worth raising.
  if (!packaged || marker.read() === version) {
    // Already cleared for this build: the prompt is all that is left to offer
    // (a no-op once the user has answered it).
    p.accessibilityTrusted(true);
    return "already-repaired";
  }
  // Both must clear before the build counts as repaired; either failing is
  // retried on the next launch that is still untrusted. If Accessibility
  // cleared and the user granted it, a still-stale Automation decision is not
  // chased from here: resetting it blind could revoke a grant the user has
  // since given. That paste fails with -1743, whose note sends the user to
  // Fix, which resets Automation only on a confirmed denial.
  const reset =
    (await p.resetMacPermission("Accessibility")) && (await p.resetMacPermission("AppleEvents"));
  if (reset) {
    marker.write(version);
    logger.info(`cleared stale auto-paste permissions for ${version}`);
  }
  p.accessibilityTrusted(true);
  return reset ? "repaired" : "reset-failed";
}

module.exports = {
  deliver,
  accessibilityTrusted,
  automationStatus,
  resetMacPermission,
  fixPastePermissions,
  checkPastePermissions,
  repairPastePermissions,
  shouldRepairAtStartup,
  explainMacPasteError,
  MAC_BUNDLE_ID,
};
