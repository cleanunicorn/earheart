// Output delivery: put text into the app the user is working in.
//
// "paste" mode writes the text to the clipboard and simulates the platform
// paste keystroke (Cmd+V / Ctrl+V) in the focused application, optionally
// restoring the previous clipboard contents afterwards — in every format the
// user had there (an image, HTML, RTF, a file copy), not just the plain text.
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

const { clipboard } = require("electron");
const fs = require("node:fs");
const logger = require("../util/logger");
const { execFileAsync } = require("../util/exec-file");
const {
  accessibilityTrusted, automationStatus, resetMacPermission,
  fixPastePermissions, checkPastePermissions, repairPastePermissions,
  repairPastePermissionsOnce, shouldRepairAtStartup, MAC_BUNDLE_ID,
  AUTOMATION_DENIED, OSASCRIPT_TIMEOUT_MS,
} = require("./mac-permissions");

const PASTE_SCRIPT = 'tell application "System Events" to keystroke "v" using command down';

// Accessibility is off for this build. Either it was never granted, or the
// app's designated requirement changed — the move from unsigned to
// certificate-signed releases, or a certificate rotation — leaving the old
// grant listed and switched on while this build is untrusted.
const ACCESSIBILITY_OFF = {
  note: "Accessibility permission is off",
  hint: "Accessibility is off for Earheart (an update can reset it) — Settings ▸ General ▸ Fix auto-paste permission",
};

// A paste tool that failed for any other reason. Its own words (a PowerShell
// stack trace, an X11 error, an AppleScript code) mean nothing to the user and
// stay in the log; the text is already on the clipboard, so say how to paste it.
// The overlay card's title and the notification's title already say auto-paste
// failed, so the note doesn't repeat it.
const PASTE_FAILED = {
  note: "Paste it with Ctrl+V",
  hint: "Paste it with Ctrl+V. What the paste tool reported is in Settings ▸ Advanced ▸ Open error log",
};
const MAC_PASTE_FAILED = {
  note: "Paste it with ⌘V",
  hint: "Paste it with ⌘V. What the paste tool reported is in Settings ▸ Advanced ▸ Open error log",
};
// Linux without wtype, ydotool or xdotool: installing one is the fix.
// simulatePasteLinux tags its error with this code; explainPasteError reads it.
const NO_KEYSTROKE_TOOL_CODE = "NO_KEYSTROKE_TOOL";
const NO_KEYSTROKE_TOOL = {
  note: "No keystroke tool found",
  hint: "Install wtype, ydotool or xdotool for auto-paste; until then, paste with Ctrl+V",
};

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
  }
  // X11, or XWayland apps after the Wayland candidates.
  candidates.push(["xdotool", ["key", "--clearmodifiers", "ctrl+v"]]);

  const available = candidates.filter(([cmd]) => commandExists(cmd));
  if (available.length === 0) {
    throw Object.assign(
      new Error("No keystroke tool found (install wtype, ydotool or xdotool)"),
      { code: NO_KEYSTROKE_TOOL_CODE }
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
  if (AUTOMATION_DENIED.test(message)) {
    return {
      note: "Automation permission is off",
      hint: "Allow Earheart to control System Events under System Settings ▸ Privacy & Security ▸ Automation",
    };
  }
  // 1002: System Events refused the keystroke, which is Accessibility.
  if (/\(1002\)/.test(message)) return ACCESSIBILITY_OFF;
  return MAC_PASTE_FAILED;
}

function explainPasteError(err) {
  if (process.platform === "darwin") return explainMacPasteError(err);
  if (err.code === NO_KEYSTROKE_TOOL_CODE) return NO_KEYSTROKE_TOOL;
  return PASTE_FAILED;
}

async function simulatePaste(signal) {
  if (process.platform === "darwin") {
    // The first run can pop the Automation permission dialog, and osascript
    // blocks until the user answers it — give them time to read it. The
    // signal lets Cancel kill the waiting child instead of leaving it to fire
    // Cmd+V into whatever is focused once the dialog is finally answered.
    await execFileAsync("osascript", ["-e", PASTE_SCRIPT], { timeout: OSASCRIPT_TIMEOUT_MS, signal });
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

// A file copy's references. Only writeBuffer() can put them back, and, like
// writeText(), it replaces every other format (checked against Electron 42
// under Xvfb: write({...}) keeps its keys together; writeText and writeBuffer
// each leave only what they wrote).
const URI_LIST_FORMAT = "text/uri-list";

// How long the target app gets to consume the pasted transcript before the
// previous clipboard contents are put back.
const RESTORE_WINDOW_MS = 1000;

/**
 * What the clipboard holds right now, in every form Electron can read back.
 * readText() alone is not enough: a screenshot, a file copy or rich text all
 * read as "" there, and writing that "" back would destroy them.
 * @returns {{text?: string, html?: string, rtf?: string, image?: object,
 *   uris?: Buffer} | null} null when nothing is capturable — an empty
 *   clipboard, or only formats Electron cannot read — so the caller skips the
 *   restore instead of overwriting the user's contents.
 */
function snapshotClipboard() {
  const formats = clipboard.availableFormats();
  const snap = {};
  const text = clipboard.readText();
  if (text) snap.text = text;
  if (formats.includes("text/html")) {
    const html = clipboard.readHTML();
    if (html) snap.html = html;
  }
  if (formats.includes("text/rtf")) {
    const rtf = clipboard.readRTF();
    if (rtf) snap.rtf = rtf;
  }
  // Only decode an image when one is advertised: a screenshot is megabytes.
  if (formats.some((format) => format.startsWith("image/"))) {
    const image = clipboard.readImage();
    if (!image.isEmpty()) snap.image = image;
  }
  if (formats.includes(URI_LIST_FORMAT)) {
    const uris = clipboard.readBuffer(URI_LIST_FORMAT);
    if (uris.length > 0) snap.uris = uris;
  }
  return Object.keys(snap).length > 0 ? snap : null;
}

/** Put a snapshotClipboard() result back, as one write. */
function restoreSnapshot(snap) {
  const { uris, ...data } = snap;
  // A file copy also lists the paths as plain text, but the references are
  // what a paste into a file manager uses and the two cannot ride together.
  // Anything richer (an image, HTML, RTF) alongside them wins instead.
  if (uris && !data.html && !data.rtf && !data.image) {
    clipboard.writeBuffer(URI_LIST_FORMAT, uris);
    return;
  }
  clipboard.write(data);
}

// Put the snapshot back, but only while the clipboard still holds the
// transcript we wrote: if another app has replaced it since, that copy is the
// user's newer intent and wins. Every restore goes through here so the guard
// cannot drift between the cancel, timer and settle paths.
// The restore is a courtesy to the previous clipboard, never a reason to lose
// the dictation: a failing write is logged and delivery goes on (at the settle
// it would otherwise reject deliver() before this transcript is even written;
// in the timer it would only reach the process-level handler).
function restoreIfUnchanged(snap, transcript) {
  try {
    if (clipboard.readText() === transcript) restoreSnapshot(snap);
  } catch (err) {
    logger.error("clipboard restore failed:", err);
  }
}

// The restore armed by the last paste: `{ timer, text, snap }`, where `text` is
// the transcript it put on the clipboard and `snap` what it promised to put
// back. One at a time: a new dictation settles the previous one first.
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
  // A restore scheduled by a previous dictation must not fire under this one,
  // but its promise still stands: if that transcript is still on the
  // clipboard, put the user's contents back now, before this dictation takes
  // its own snapshot — otherwise re-dictating within the second loses them.
  // The trade: a target app still reading that paste gets the restored
  // contents instead. There is no signal for when a paste has been consumed,
  // and the previous keystroke has long been sent (dictations are serialized),
  // so the window is cut short rather than the snapshot dropped.
  if (pendingRestore) {
    const { timer, text: previousText, snap } = pendingRestore;
    clearTimeout(timer);
    pendingRestore = null;
    restoreIfUnchanged(snap, previousText);
  }
  const pasting = cfg.mode === "paste" || cfg.mode === "paste-copy";
  // Only plain "paste" mode restores; "paste-copy" exists precisely to keep
  // the transcript on the clipboard after pasting. `null` means no restore —
  // disabled, or nothing on the clipboard worth putting back.
  const previous =
    cfg.mode === "paste" && cfg.restoreClipboard ? snapshotClipboard() : null;
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
    if (previous !== null) restoreIfUnchanged(previous, text);
    return { method: "cancelled" };
  }
  // Ask macOS directly before driving System Events. An untrusted app's
  // keystroke can never land, and the osascript attempt can hang on a
  // permission prompt or fail with an error that doesn't say the grant went
  // stale after an update.
  if (!accessibilityTrusted()) {
    logger.error("auto-paste skipped:", ACCESSIBILITY_OFF.hint);
    // Once per launch, clear a stale grant this build hasn't repaired yet and
    // raise the prompt skipped along with the keystroke. Not awaited: the
    // transcript is already on the
    // clipboard and the fallback must not wait on tccutil.
    repairPastePermissionsOnce();
    return { method: "clipboard", ...ACCESSIBILITY_OFF };
  }
  try {
    await simulatePaste(signal);
  } catch (err) {
    if (signal?.aborted || err.aborted) return { method: "cancelled" };
    // Text is already on the clipboard, so the user can paste manually. The
    // overlay note vanishes in seconds; the log line is what survives, so it
    // carries the verbatim tool output, not just our reading of it.
    const { note, hint } = explainPasteError(err);
    logger.error("auto-paste failed:", hint, "— tool output:", err.message, "—", err.cause ?? err);
    return { method: "clipboard", note, hint };
  }
  // Cancelled while the keystroke was in flight: the paste may have landed,
  // but nothing after it (the clipboard restore) should run for a dead session.
  if (signal?.aborted) return { method: "cancelled" };

  if (previous !== null) {
    // Wait for the target app to consume the clipboard before restoring it,
    // and only restore if nothing else has written to it since.
    const timer = setTimeout(() => {
      pendingRestore = null;
      restoreIfUnchanged(previous, text);
    }, RESTORE_WINDOW_MS);
    pendingRestore = { timer, text, snap: previous };
  }
  return { method: cfg.mode };
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
