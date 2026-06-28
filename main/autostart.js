// Start-on-login (autostart) across Windows, macOS and Linux.
//
// Windows and macOS expose a native login-items API through Electron's
// app.setLoginItemSettings / app.getLoginItemSettings, so we let the OS track
// the registration. Linux has no such API; instead the freedesktop XDG
// autostart spec says any .desktop file in ~/.config/autostart is launched by
// the desktop environment at login, so on Linux we write (or remove) that file
// ourselves.
//
// Either way the app is launched with --hidden so logging in lands you in the
// tray with the hotkey ready, not in a settings window.

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const LINUX_DESKTOP_FILE = "earheart.desktop";

// The command the desktop environment should run at login. On Linux AppImages
// the relaunchable path lives in $APPIMAGE — process.execPath points inside the
// mounted image and would be stale next boot — so prefer it; fall back to
// execPath for .deb installs and `npm start` development runs.
function linuxLaunchCommand() {
  const exec = process.env.APPIMAGE || process.execPath;
  return `${exec} --hidden`;
}

// A minimal but complete XDG autostart entry. X-GNOME-Autostart-enabled keeps
// GNOME from treating the entry as disabled.
function linuxDesktopEntry(command = linuxLaunchCommand()) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Earheart",
    "Comment=Private, hotkey-driven voice dictation",
    `Exec=${command}`,
    "Icon=earheart",
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

function linuxAutostartPath() {
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", LINUX_DESKTOP_FILE);
}

function applyLinux(enabled) {
  const file = linuxAutostartPath();
  if (enabled) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, linuxDesktopEntry());
  } else {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      // Already absent is success — nothing to remove.
      if (err.code !== "ENOENT") throw err;
    }
  }
}

// Set whether Earheart launches at login. Idempotent and safe to call on every
// startup to reconcile the OS state with the saved setting.
function apply(enabled) {
  if (process.platform === "linux") {
    applyLinux(enabled);
    return;
  }
  // Windows + macOS: native login item. openAsHidden is honoured on macOS; the
  // --hidden argument covers Windows (and is harmless on macOS).
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: enabled,
    args: ["--hidden"],
  });
}

// Whether autostart is currently registered with the OS. Used as the source of
// truth so the settings UI reflects reality even if it drifted.
function isEnabled() {
  if (process.platform === "linux") return fs.existsSync(linuxAutostartPath());
  return app.getLoginItemSettings().openAtLogin;
}

module.exports = {
  apply,
  isEnabled,
  // Exported for unit tests (pure, no Electron).
  linuxDesktopEntry,
  linuxLaunchCommand,
  linuxAutostartPath,
};
