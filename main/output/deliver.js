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

const { clipboard, systemPreferences, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const logger = require("../util/logger");

// Deep link to System Settings ▸ Privacy & Security ▸ Accessibility. The URL is
// unchanged across the old System Preferences and the new System Settings, so it
// resolves on modern macOS (Ventura+).
const ACCESSIBILITY_PANE_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, ...options }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
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
// two permission errors macOS raises look nothing alike, and both leave the
// text safely on the clipboard, so the overlay note is the only place the
// user learns which toggle to flip.
function explainMacPasteError(message) {
  // "Not authorized to send Apple events to System Events. (-1743)": the
  // Automation permission was denied, or the build lacks the apple-events
  // entitlement, so osascript never reaches System Events.
  if (/-1743\b|not authorized to send apple events/i.test(message)) {
    return "macOS blocked Automation — allow Earheart to control System Events under Privacy & Security ▸ Automation";
  }
  // "osascript is not allowed to send keystrokes. (1002)": Accessibility is off.
  if (/\b1002\b|not allowed to send keystrokes/i.test(message)) {
    return "Accessibility permission is off — Settings ▸ Advanced ▸ Fix auto-paste permission";
  }
  return message;
}

async function simulatePaste() {
  if (process.platform === "darwin") {
    try {
      await execFileAsync(
        "osascript",
        ["-e", 'tell application "System Events" to keystroke "v" using command down'],
        // The first run can pop the Automation permission dialog, and osascript
        // blocks until the user answers it — give them time to read it.
        { timeout: 30000 }
      );
    } catch (err) {
      throw new Error(explainMacPasteError(err.message));
    }
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
 * @returns {Promise<{method: "paste"|"paste-copy"|"clipboard"|"cancelled", note?: string}>}
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
  try {
    await simulatePaste();
  } catch (err) {
    // Text is already on the clipboard, so the user can paste manually. The
    // overlay note vanishes in seconds; the log line is what survives.
    logger.error("auto-paste failed:", err.message);
    return { method: "clipboard", note: err.message };
  }

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

module.exports = {
  deliver,
  accessibilityTrusted,
  openAccessibilitySettings,
  explainMacPasteError,
};
