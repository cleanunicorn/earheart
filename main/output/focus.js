// Target-window capture and restore for the review-before-send flow.
//
// The paste in deliver.js lands in whatever window has keyboard focus, which
// works because the overlay never takes it. The review step is the one
// deliberate exception: the overlay borrows focus so the transcript can be
// edited, so before it does we remember which window the user dictated into
// (captureTarget), and give it back right before pasting (restoreTarget).
//
// Every failure degrades softly: a null token or a failed restore just means
// send behaves like today's paste-into-whatever-is-focused, and deliver()
// already falls back to clipboard-with-note when the paste itself fails.
// Nothing in here may ever block or fail a dictation.
//
// captureSpec/restoreSpec build the platform commands as data so tests can
// cover every platform's argument shapes without a display server.

const { execFileAsync, commandExists, isWayland } = require("../util/exec");
const logger = require("../util/logger");

// macOS goes through System Events for both capture and restore on purpose:
// activating the target directly (`tell application id … to activate`) sends
// that app an Apple Event and triggers a per-target-app Automation consent
// prompt, while System Events is the exact permission surface the auto-paste
// keystroke already needs — no new prompts for existing users.
const DARWIN_CAPTURE_SCRIPT =
  'tell application "System Events" to get (unix id of first application process whose frontmost is true) & "\\n" & (name of first application process whose frontmost is true)';

function darwinRestoreScript(token) {
  // Prefer the pid; fall back to the name if the process was relaunched.
  const pid = Number(token.pid);
  const name = String(token.name || "").replace(/[\\"]/g, "");
  if (Number.isFinite(pid) && pid > 0) {
    return (
      'tell application "System Events"\n' +
      `if exists (first application process whose unix id is ${pid}) then\n` +
      `set frontmost of (first application process whose unix id is ${pid}) to true\n` +
      (name ? `else\nset frontmost of application process "${name}" to true\n` : "") +
      "end if\nend tell"
    );
  }
  return `tell application "System Events" to set frontmost of application process "${name}" to true`;
}

// Windows: GetForegroundWindow gives the HWND of the window the user was
// dictating into. Restoring is the delicate half — SetForegroundWindow is
// called from a PowerShell child that is not the foreground process, so
// Windows' foreground lock may reduce it to a taskbar flash. Tapping the Alt
// key (keybd_event VK_MENU) first is the long-standing release of that lock.
// If this proves flaky in the field, the escalation is AttachThreadInput.
const WIN_CAPTURE_SCRIPT =
  "Add-Type 'using System;using System.Runtime.InteropServices;public class FG{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();}';" +
  "[FG]::GetForegroundWindow().ToInt64()";

function winRestoreScript(hwnd) {
  const id = String(hwnd).replace(/[^0-9]/g, "");
  return (
    "Add-Type 'using System;using System.Runtime.InteropServices;public class FG{" +
    '[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);' +
    '[DllImport("user32.dll")]public static extern bool IsWindow(IntPtr h);' +
    '[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);}\';' +
    `$h=[IntPtr]${id};` +
    "if(-not [FG]::IsWindow($h)){exit 1};" +
    // Alt down/up releases the foreground lock for the SetForegroundWindow call.
    "[FG]::keybd_event(0x12,0,0,[UIntPtr]::Zero);" +
    "[FG]::SetForegroundWindow($h)|Out-Null;" +
    "[FG]::keybd_event(0x12,0,2,[UIntPtr]::Zero)"
  );
}

// Build the capture command for a platform, or null when capture is not
// possible there (Wayland has no way to ask which surface is focused).
// parse() turns the command's stdout into the token payload, or null.
function captureSpec(platform, wayland) {
  if (platform === "darwin") {
    return {
      cmd: "osascript",
      args: ["-e", DARWIN_CAPTURE_SCRIPT],
      parse: (out) => {
        const [pid, ...name] = String(out).trim().split("\n");
        const parsed = { kind: "darwin", pid: Number(pid), name: name.join("\n").trim() };
        return Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed : null;
      },
    };
  }
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", WIN_CAPTURE_SCRIPT],
      parse: (out) => {
        const hwnd = String(out).trim();
        return /^[0-9]+$/.test(hwnd) && hwnd !== "0"
          ? { kind: "win32", hwnd }
          : null;
      },
    };
  }
  // Linux: only X11 can be queried. On Wayland the token still records the
  // situation so restoreTarget can explain itself in its note.
  if (wayland) return null;
  return {
    cmd: "xdotool",
    args: ["getactivewindow"],
    parse: (out) => {
      const id = String(out).trim();
      return /^[0-9]+$/.test(id) ? { kind: "x11", windowId: id } : null;
    },
  };
}

// Build the restore command for a token, or null when there is nothing to run
// (Wayland, missing/degenerate token).
function restoreSpec(token) {
  if (!token) return null;
  if (token.kind === "darwin") {
    return { cmd: "osascript", args: ["-e", darwinRestoreScript(token)] };
  }
  if (token.kind === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", winRestoreScript(token.hwnd)],
    };
  }
  if (token.kind === "x11") {
    return {
      cmd: "xdotool",
      args: ["windowactivate", "--sync", String(token.windowId)],
    };
  }
  return null; // wayland or unknown
}

// Remember the window the user is dictating into. Must be called while that
// window still has focus — i.e. BEFORE the overlay is made focusable.
async function captureTarget() {
  try {
    if (process.platform === "linux" && isWayland()) {
      // No Wayland protocol exposes the focused surface; the review flow
      // instead relies on the compositor returning focus to the previous
      // surface once the overlay stops being focusable.
      return { kind: "wayland" };
    }
    const spec = captureSpec(process.platform, false);
    if (!spec || (process.platform === "linux" && !commandExists(spec.cmd))) {
      return null;
    }
    return spec.parse(await execFileAsync(spec.cmd, spec.args));
  } catch (err) {
    logger.warn("focus capture failed:", err.message);
    return null;
  }
}

// Give focus back to the captured window. Never throws; the caller pastes
// regardless and deliver() handles the paste's own failure modes.
async function restoreTarget(token) {
  try {
    const spec = restoreSpec(token);
    if (!spec) {
      return {
        ok: false,
        note:
          token?.kind === "wayland"
            ? "Wayland cannot re-focus the target window; relying on the compositor"
            : "no captured target window",
      };
    }
    if (process.platform === "linux" && !commandExists(spec.cmd)) {
      return { ok: false, note: `${spec.cmd} not found` };
    }
    await execFileAsync(spec.cmd, spec.args);
    return { ok: true };
  } catch (err) {
    logger.warn("focus restore failed:", err.message);
    return { ok: false, note: err.message };
  }
}

module.exports = { captureTarget, restoreTarget, captureSpec, restoreSpec };
