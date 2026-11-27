// Is this a Linux Wayland session? There, apps can't grab global shortcuts
// (notably on GNOME), so paste uses wtype/ydotool and Settings explains how to
// bind a desktop shortcut instead. Pure environment reading, Electron-free.
function isWaylandSession(env = process.env) {
  return env.XDG_SESSION_TYPE === "wayland" || !!env.WAYLAND_DISPLAY;
}

module.exports = { isWaylandSession };
