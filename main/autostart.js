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

// Arguments the login item launches with, so login lands in the tray (not a
// window). Shared by the set and get calls below: on Windows
// getLoginItemSettings compares the stored launch command against the args you
// query with, so the two MUST match or the read-back state drifts.
const LOGIN_ITEM_ARGS = ["--hidden"];

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
    args: LOGIN_ITEM_ARGS,
  });
}

// Decide whether autostart is on from an Electron login-item settings object.
// On Windows, openAtLogin only reads true when the query args match the ones the
// item was registered with — so we always query with LOGIN_ITEM_ARGS — but
// executableWillLaunchAtLogin reflects the run key directly (it ignores args),
// which is the most faithful "will it actually launch?" signal. macOS/Linux
// don't set that field, so fall back to openAtLogin there.
function loginItemEnabled(item) {
  return item.executableWillLaunchAtLogin ?? item.openAtLogin ?? false;
}

// Whether autostart is currently registered with the OS. Used as the source of
// truth so the settings UI reflects reality even if it drifted.
function isEnabled() {
  if (process.platform === "linux") return fs.existsSync(linuxAutostartPath());
  return loginItemEnabled(app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }));
}

module.exports = {
  apply,
  isEnabled,
  // Exported for unit tests (pure, no Electron).
  loginItemEnabled,
  linuxDesktopEntry,
  linuxLaunchCommand,
  linuxAutostartPath,
};
