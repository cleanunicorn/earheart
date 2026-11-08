// The native edges of a voice command (#344): copy the selection in another
// app, wait for the hotkey's modifier keys to come up, fingerprint the focused
// window, and ask whether a secure text field has the keyboard.
//
// Everything is an exec of a platform tool (osascript, PowerShell, xdotool,
// wtype, ydotool), injectable so main/commands/selection.js and session.js are
// testable without an OS. None of it can be proven by CI: it is checked by
// hand per OS (docs/commands.md has the matrix and what has been tried).
//
// What each OS can honestly do:
//   macOS    copy + modifiers + app fingerprint + secure-input check
//   Windows  copy + modifiers + window fingerprint (secure fields NOT detectable)
//   X11      copy + window fingerprint (xdotool); modifiers are cleared by the tool
//   Wayland  copy via wtype/ydotool where it works; no window fingerprint, so
//            a result can only be copied, never applied

const { execFileAsync } = require("../util/exec-file");
const deliver = require("../output/deliver");

const MODIFIER_WAIT_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PS = (script) => ["-NoProfile", "-NonInteractive", "-Command", script];

// Windows: block (inside one PowerShell) until Shift/Ctrl/Alt/Win are all up,
// or the deadline. Prints "released" or "held".
const WIN_MODIFIER_SCRIPT = (ms) => `
Add-Type -Namespace E -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);'
$deadline = [DateTime]::UtcNow.AddMilliseconds(${ms})
do {
  $down = $false
  foreach ($k in 0x10,0x11,0x12,0x5B,0x5C) { if ([E.K]::GetAsyncKeyState($k) -band 0x8000) { $down = $true } }
  if (-not $down) { 'released'; exit }
  Start-Sleep -Milliseconds 25
} while ([DateTime]::UtcNow -lt $deadline)
'held'
`;

// macOS: the same wait through AppKit (NSEvent.modifierFlags is process-wide).
const MAC_MODIFIER_SCRIPT = (ms) => `
ObjC.import('AppKit');
var mask = 0x20000 | 0x40000 | 0x80000 | 0x100000;
var left = ${ms};
while ((Number($.NSEvent.modifierFlags) & mask) !== 0 && left > 0) { $.NSThread.sleepForTimeInterval(0.025); left -= 25; }
((Number($.NSEvent.modifierFlags) & mask) === 0) ? 'released' : 'held';
`;

function createPlatform({
  platform = process.platform,
  exec = execFileAsync,
  wayland = deliver.isWayland,
  hasCommand = deliver.commandExists,
  accessibilityTrusted = deliver.accessibilityTrusted,
} = {}) {
  const x11 = platform === "linux" && !wayland() && hasCommand("xdotool");

  // The Linux copy candidates, in the order paste uses: Wayland tools first.
  function linuxCopyCommands() {
    const out = [];
    if (wayland()) {
      out.push(["wtype", ["-M", "ctrl", "-k", "c", "-m", "ctrl"]]);
      // 29 = LeftCtrl, 46 = C
      out.push(["ydotool", ["key", "29:1", "46:1", "46:0", "29:0"]]);
    }
    out.push(["xdotool", ["key", "--clearmodifiers", "ctrl+c"]]);
    return out.filter(([cmd]) => hasCommand(cmd));
  }

  /** Whether a selection can be captured here at all, and if not why. */
  function captureSupport() {
    if (platform === "darwin") {
      return accessibilityTrusted()
        ? { ok: true }
        : { ok: false, reason: "Accessibility permission is off for Earheart (Settings ▸ General ▸ Fix auto-paste permission)" };
    }
    if (platform === "win32") return { ok: true };
    return linuxCopyCommands().length
      ? { ok: true }
      : { ok: false, reason: "Install wtype, ydotool or xdotool to read the selection" };
  }

  /** Whether the focused window can be told apart later (what Apply needs). */
  function fingerprintSupport() {
    if (platform === "darwin") return { ok: true, grain: "app" };
    if (platform === "win32") return { ok: true, grain: "window" };
    if (x11) return { ok: true, grain: "window" };
    return { ok: false, reason: "This desktop cannot identify the focused window, so results can only be copied" };
  }

  async function sendCopy(signal) {
    if (platform === "darwin") {
      await exec("osascript", ["-e", 'tell application "System Events" to keystroke "c" using command down'], { timeout: 5000, signal });
    } else if (platform === "win32") {
      await exec("powershell.exe", PS("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')"), { timeout: 5000, signal });
    } else {
      let last = null;
      for (const [cmd, args] of linuxCopyCommands()) {
        try {
          await exec(cmd, args, { timeout: 5000, signal });
          return;
        } catch (err) {
          if (signal?.aborted || err.aborted) throw err;
          last = err;
        }
      }
      throw last || new Error("No keystroke tool found");
    }
  }

  /**
   * Resolve true once no modifier key is held, false if one still is after
   * `ms`. Where the OS can't be asked (Linux), a short fixed wait stands in
   * and the keystroke tool clears the rest.
   */
  async function waitForModifiersReleased(ms = MODIFIER_WAIT_MS, signal) {
    try {
      if (platform === "win32") {
        const out = await exec("powershell.exe", PS(WIN_MODIFIER_SCRIPT(ms)), { timeout: ms + 4000, signal });
        return String(out).trim() === "released";
      }
      if (platform === "darwin") {
        const out = await exec("osascript", ["-l", "JavaScript", "-e", MAC_MODIFIER_SCRIPT(ms)], { timeout: ms + 4000, signal });
        return String(out).trim() === "released";
      }
    } catch (err) {
      if (signal?.aborted || err.aborted) throw err;
      return true; // can't ask: go on, the copy itself will report a failure
    }
    await sleep(250);
    return true;
  }

  /** The focused window's identity, or null when it can't be read. */
  async function fingerprint(signal) {
    try {
      if (platform === "darwin") {
        const out = await exec("osascript", ["-e",
          'tell application "System Events" to get (unix id of first application process whose frontmost is true) & "|" & (name of first application process whose frontmost is true)'],
        { timeout: 5000, signal });
        const [pid, ...name] = String(out).trim().split("|");
        return pid ? { id: `mac:${pid}`, label: name.join("|") } : null;
      }
      if (platform === "win32") {
        const out = await exec("powershell.exe", PS(`
Add-Type -Namespace E -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);'
$h = [E.W]::GetForegroundWindow(); $p = 0; [void][E.W]::GetWindowThreadProcessId($h, [ref]$p)
"$($h.ToInt64())|$p|$((Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName)"`), { timeout: 8000, signal });
        const [hwnd, pid, name] = String(out).trim().split("|");
        return hwnd && hwnd !== "0" ? { id: `win:${hwnd}:${pid}`, label: name || "" } : null;
      }
      if (x11) {
        const id = String(await exec("xdotool", ["getactivewindow"], { timeout: 3000, signal })).trim();
        if (!id) return null;
        let label = "";
        try { label = String(await exec("xdotool", ["getwindowname", id], { timeout: 3000, signal })).trim(); } catch { /* label is cosmetic */ }
        return { id: `x11:${id}`, label };
      }
    } catch (err) {
      if (signal?.aborted || err.aborted) throw err;
    }
    return null;
  }

  /**
   * True when a secure text field is known to have the keyboard. Only macOS
   * reports this; elsewhere the answer is always false, which means "not
   * known", not "safe".
   */
  async function secureInputActive(signal) {
    if (platform !== "darwin") return false;
    try {
      const out = await exec("osascript", ["-l", "JavaScript", "-e",
        "ObjC.import('Carbon'); $.IsSecureEventInputEnabled() ? 'secure' : 'open'"], { timeout: 5000, signal });
      return String(out).trim() === "secure";
    } catch (err) {
      if (signal?.aborted || err.aborted) throw err;
      return false;
    }
  }

  return { captureSupport, fingerprintSupport, sendCopy, waitForModifiersReleased, fingerprint, secureInputActive };
}

module.exports = { createPlatform, MODIFIER_WAIT_MS };
