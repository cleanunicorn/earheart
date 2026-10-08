// macOS auto-paste permissions, settings panes, and stale-grant repair state.
const { app, systemPreferences, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const logger = require("../util/logger");
const { execFileAsync } = require("../util/exec-file");

// Deep link to System Settings ▸ Privacy & Security ▸ Accessibility. The URL is
// unchanged across the old System Preferences and the new System Settings, so it
// resolves on modern macOS (Ventura+).
const ACCESSIBILITY_PANE_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
// Privacy & Security ▸ Automation: where a denied "control System Events"
// decision is undone.
const AUTOMATION_PANE_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

// Probe System Events without sending a keystroke.
const PROBE_SCRIPT = 'tell application "System Events" to get name';

// The bundle identifier TCC files Earheart's permission decisions under. Must
// match `appId` in electron-builder.yml (a unit test holds them together).
const MAC_BUNDLE_ID = "dev.cleanunicorn.earheart";

const TCC_ACCESSIBILITY = "Accessibility";
const TCC_APPLE_EVENTS = "AppleEvents";
const AUTOMATION_DENIED = /\(-1743\)/;
const OSASCRIPT_TIMEOUT_MS = 30000;

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
    await run("osascript", ["-e", PROBE_SCRIPT], { timeout: OSASCRIPT_TIMEOUT_MS });
    return "granted";
  } catch (err) {
    logger.warn("automation probe failed:", err.cause ?? err);
    if (err.killed) return "pending";
    return AUTOMATION_DENIED.test(err.message) ? "denied" : "error";
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
  automationStatus,
  resetMacPermission,
  openAccessibilitySettings,
  openAutomationSettings,
};

/**
 * Get auto-paste back to a working state on macOS (Settings ▸ General ▸ Fix
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
    const reset = await p.resetMacPermission(TCC_ACCESSIBILITY);
    // An update leaves the Automation grant as stale as the Accessibility one;
    // clearing both now means one click repairs both, and the next paste gets
    // a fresh Automation prompt instead of a -1743.
    if (reset) await p.resetMacPermission(TCC_APPLE_EVENTS);
    // A no-op while a decision is still on record; the pane covers that.
    p.accessibilityTrusted(true);
    result = { granted: false, pane: "accessibility", reset };
  } else {
    let automation = await p.automationStatus();
    let reset = false;
    // Only a refusal on record is worth clearing: a probe that timed out is a
    // prompt still waiting, and any other failure is not a permission.
    if (automation === "denied") {
      reset = await p.resetMacPermission(TCC_APPLE_EVENTS);
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

/**
 * Repair auto-paste permissions without a click, once per build. Releases are
 * signed with one certificate, so grants normally survive updates — but when
 * the designated requirement changes (the first signed release after unsigned
 * ones, or a certificate rotation), the Accessibility (and Automation) grant
 * stays on record for the old one: shown as on, trusting nothing, never
 * re-prompted. When this build is untrusted and hasn't been
 * repaired yet, clear both decisions and raise the prompt. Runs at a visible,
 * non-first-run startup in a paste mode, or else on the first skipped paste of
 * a launch — so a hidden login launch stays silent and switching from
 * clipboard-only to paste later still gets it. At most once per launch. The
 * build is recorded only when both resets went through, so a failure is
 * retried next launch.
 * @returns {Promise<"not-needed"|"already-repaired"|"repaired"|"reset-failed">}
 *   "already-repaired" also covers the unpackaged app, which only prompts.
 */
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
    (await p.resetMacPermission(TCC_ACCESSIBILITY)) && (await p.resetMacPermission(TCC_APPLE_EVENTS));
  if (reset) {
    marker.write(version);
    logger.info(`cleared stale auto-paste permissions for ${version}`);
  }
  p.accessibilityTrusted(true);
  return reset ? "repaired" : "reset-failed";
}

// The first skipped paste shares startup's repair state and never waits on TCC.
function repairPastePermissionsOnce() {
  if (!repairRanThisLaunch) {
    repairPastePermissions().catch((err) => logger.warn("permission repair failed:", err));
  }
}

module.exports = {
  accessibilityTrusted,
  automationStatus,
  resetMacPermission,
  fixPastePermissions,
  checkPastePermissions,
  repairPastePermissions,
  repairPastePermissionsOnce,
  shouldRepairAtStartup,
  MAC_BUNDLE_ID,
  AUTOMATION_DENIED,
  OSASCRIPT_TIMEOUT_MS,
};
