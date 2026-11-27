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

// The paste keystroke, with one guard in front of it. Clicking the overlay
// (Stop, Finish) used to activate Earheart on macOS (confirmed on a Mac), so
// Cmd+V landed in Earheart and nowhere. The overlay is now a non-activating
// panel (main/windows.js nonActivating()), which should stop that at the
// source; this guard stays as the fallback should a click still activate
// Earheart (an Electron or macOS change). The pipeline passes a target only when the overlay was
// pressed during the take, and the script uses it only when Earheart is the
// frontmost app at paste time: then it hands the front back to that app
// first. A user who switched apps on purpose mid-dictation, including to an
// Earheart window, still gets the paste where they are. Without a target the
// script is the plain keystroke it always was.
// Everything goes through System Events, which the keystroke already needs,
// so this asks for no new permission. Arguments arrive as argv, never spliced
// into the script. Prints "pasted", "restored" (front handed back, then
// pasted) or "lost" (could not hand it back; nothing was typed).
const PASTE_SCRIPT = [
  "on run argv",
  "set ownPid to (item 1 of argv) as integer",
  "set targetId to item 2 of argv",
  'tell application "System Events"',
  "set outcome to \"pasted\"",
  "if targetId is not \"\" and (unix id of first application process whose frontmost is true) is ownPid then",
  "try",
  "set frontmost of first application process whose bundle identifier is targetId to true",
  "end try",
  "delay 0.15",
  "if (unix id of first application process whose frontmost is true) is ownPid then return \"lost\"",
  "set outcome to \"restored\"",
  "end if",
  'keystroke "v" using command down',
  "end tell",
  "return outcome",
  "end run",
].flatMap((line) => ["-e", line]);

// Bundle ids that are Earheart itself (packaged, or `npm start` under the
// stock Electron bundle). Dictating into Earheart's own window is legitimate;
// there is nothing to hand the front back to.
const SELF_BUNDLE_IDS = new Set([MAC_BUNDLE_ID.toLowerCase(), "com.github.electron"]);

// The app to hand the front back to, or "" for none.
function macRestoreTarget(appId) {
  const id = typeof appId === "string" ? appId.trim() : "";
  if (!id || SELF_BUNDLE_IDS.has(id.toLowerCase())) return "";
  return id;
}

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

// → "pasted" | "restored" | "lost" on macOS ("lost": no keystroke was sent);
// "pasted" elsewhere.
async function simulatePaste(signal, targetApp) {
  if (process.platform === "darwin") {
    // The first run can pop the Automation permission dialog, and osascript
    // blocks until the user answers it — give them time to read it. The
    // signal lets Cancel kill the waiting child instead of leaving it to fire
    // Cmd+V into whatever is focused once the dialog is finally answered.
    const out = await execFileAsync(
      "osascript",
      [...PASTE_SCRIPT, String(process.pid), macRestoreTarget(targetApp)],
      { timeout: OSASCRIPT_TIMEOUT_MS, signal }
    );
    const outcome = String(out ?? "").trim();
    return outcome === "lost" || outcome === "restored" ? outcome : "pasted";
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
  return "pasted";
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
    if (sameText(clipboard.readText(), transcript)) restoreSnapshot(snap);
  } catch (err) {
    logger.error("clipboard restore failed:", err);
  }
}

// Line endings are compared loosely, defensively: should a platform hand back
// CRLF for the LF it was given, a multi-line transcript must neither read as
// taken over nor miss its restore.
const sameText = (a, b) => a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");

// True when another app has put something else on the clipboard since we wrote
// `text`, during the paste delay (another copy, a clipboard manager). Pasting
// then would type THEIR content into the target — an unrelated command or
// private text reaching an agent's input (#291).
//
// Only unambiguous evidence counts, because a false "taken over" silently
// stops auto-paste: readable text that isn't ours, or no text at all while an
// image or a file copy is on offer. An empty read with only text formats is
// a clipboard we couldn't read (Windows answers "" while another app holds it
// open), not proof. On Wayland the check is skipped: an unfocused client —
// the overlay never takes focus — can read a stale selection, so the evidence
// isn't trustworthy there. What remains everywhere is the OS's own race
// between this check and the keystroke landing; it narrows the window, it
// can't close it.
function clipboardTakenOver(text) {
  if (process.platform === "linux" && isWayland()) return false;
  try {
    const current = clipboard.readText();
    if (sameText(current, text)) return false;
    if (current) return true;
    return clipboard.availableFormats().some((f) => f.startsWith("image/") || f === "text/uri-list");
  } catch {
    return false;
  }
}

// What the user is told when the paste was held back: the newer copy is
// theirs, and the transcript is a click away instead.
const CLIPBOARD_CHANGED = {
  note: "Copy it from the tray menu",
  hint:
    "Another app changed the clipboard before Earheart could paste, so nothing was pasted and that copy was left as it was. " +
    "Copy the transcript from the tray menu (Copy last transcription).",
};

// The restore armed by the last paste: `{ timer, text, snap }`, where `text` is
// the transcript it put on the clipboard and `snap` what it promised to put
// back. One at a time: a new dictation settles the previous one first.
let pendingRestore = null;

/**
 * Deliver text to the user.
 * @param {string} text
 * @param {object} cfg - settings.output slice
 * @param {AbortSignal} [signal]
 * @param {{targetApp?: string|null}} [opts] - macOS: bundle id of the app
 *   that was frontmost when the take started, passed only when the overlay
 *   was pressed. If Earheart is in front at paste time, the front is handed
 *   back to it before the keystroke.
 * @returns {Promise<{method: "paste"|"paste-copy"|"clipboard"|"clipboard-changed"|"cancelled", note?: string, hint?: string}>}
 *   "clipboard-changed": another app took the clipboard over before the paste,
 *   so nothing was pasted and the transcript is NOT on the clipboard.
 *   `note` is a one-line reason auto-paste fell back to the clipboard (short
 *   enough for the overlay); `hint` is the full instruction for a notification.
 */
async function deliver(text, cfg, signal, { targetApp = null } = {}) {
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
    // fallback must not wait on tccutil.
    repairPastePermissionsOnce();
    // A newer copy can arrive during the delay even when paste permission is
    // off. Report it so the pipeline keeps the transcript available to copy.
    if (clipboardTakenOver(text)) return { method: "clipboard-changed", ...CLIPBOARD_CHANGED };
    return { method: "clipboard", ...ACCESSIBILITY_OFF };
  }
  // Last moment before the keystroke: is what we'd paste still ours? If not,
  // paste nothing and leave the newer copy alone — no restore either, the
  // clipboard is no longer ours to put back.
  if (clipboardTakenOver(text)) {
    logger.warn("auto-paste skipped: the clipboard changed during the paste delay");
    return { method: "clipboard-changed", ...CLIPBOARD_CHANGED };
  }
  let outcome;
  try {
    outcome = await simulatePaste(signal, targetApp);
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
  if (outcome === "restored") {
    // No app name: the log never says where a dictation went.
    logger.info("auto-paste: Earheart was in front after an overlay press; handed focus back to the target app");
  }
  if (outcome === "lost") {
    // Earheart stayed in front, so no keystroke was sent. The transcript stays
    // on the clipboard (no restore) so the user can paste it themselves.
    logger.warn("auto-paste skipped: Earheart was in front after an overlay press and the target app could not be brought back");
    return { method: "clipboard", ...MAC_PASTE_FAILED };
  }

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
  // For the macOS compile check in test/deliver.test.js.
  PASTE_SCRIPT,
  // For voice commands (main/commands/): the same clipboard snapshot/restore
  // and platform checks delivery uses, so a selection capture can leave the
  // user's clipboard exactly as it found it.
  snapshotClipboard,
  restoreSnapshot,
  commandExists,
  isWayland,
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
