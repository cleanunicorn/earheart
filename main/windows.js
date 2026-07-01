// Window management: the recording overlay (a small always-on-top card that
// also owns the microphone) and the settings window.

const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");

const PRELOAD = path.join(__dirname, "..", "preload.js");
const RENDERER = path.join(__dirname, "..", "renderer");

const OVERLAY_WIDTH = 360;
// Base card: grip (~12px) + 56px control row + 12px margin top/bottom.
const OVERLAY_HEIGHT = 92;
// Matches the card's fade-out transition in overlay.css.
const OVERLAY_FADE_MS = 200;

let overlayWindow = null;
let settingsWindow = null;
let wizardWindow = null;
let overlayCustomPosition = null; // set when the user drags the card
let overlayDragOrigin = null; // { winX, winY, pointerX, pointerY }
let overlayHideTimer = null;

// Clamp a top-left position so the window stays on-screen. The height matters
// for the bottom bound: a transcript-grown overlay is taller than OVERLAY_HEIGHT,
// so pass its actual height (defaulting to the base card height) or the window's
// bottom edge can be dragged off the work area.
function clampToWorkArea(x, y, height = OVERLAY_HEIGHT) {
  const { workArea } = screen.getDisplayNearestPoint({ x, y });
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - OVERLAY_WIDTH),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height),
  };
}

function overlayPosition() {
  if (overlayCustomPosition) {
    // Re-clamp in case displays changed since the user dragged it there.
    return clampToWorkArea(overlayCustomPosition.x, overlayCustomPosition.y);
  }
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY_HEIGHT - 24),
  };
}

// Click-and-drag for the overlay card. The renderer streams absolute screen
// coordinates; positioning from a recorded origin (instead of incremental
// deltas) keeps the card glued to the cursor even if events are dropped.
ipcMain.on("overlay:drag-start", (event, { x, y } = {}) => {
  const win = getOverlay();
  if (!win || typeof x !== "number" || typeof y !== "number") return;
  const [winX, winY] = win.getPosition();
  overlayDragOrigin = { winX, winY, pointerX: x, pointerY: y };
});

ipcMain.on("overlay:drag", (event, { x, y } = {}) => {
  const win = getOverlay();
  if (!win || !overlayDragOrigin) return;
  if (typeof x !== "number" || typeof y !== "number") return;
  const [, h] = win.getSize();
  const next = clampToWorkArea(
    Math.round(overlayDragOrigin.winX + x - overlayDragOrigin.pointerX),
    Math.round(overlayDragOrigin.winY + y - overlayDragOrigin.pointerY),
    h // a transcript-grown overlay is taller than the base card height
  );
  win.setPosition(next.x, next.y);
  // Store the card's *bottom-anchored* top-left (where a base-height window would
  // sit), so the next show — which resets to base height — places it correctly
  // instead of inheriting the grown top.
  overlayCustomPosition = { x: next.x, y: next.y + h - OVERLAY_HEIGHT };
});

// The live transcript grows the overlay's content upward (the card stays pinned
// to the bottom edge so it doesn't jump). The renderer reports the height its
// content needs; we resize the window and shift its top up by the delta, then
// re-clamp so a tall transcript near the top of the screen isn't pushed off.
// We deliberately do NOT touch overlayCustomPosition here — it tracks the card's
// resting (base-height) spot, which the grow-upward must not overwrite.
ipcMain.on("overlay:resize", (event, { height } = {}) => {
  const win = getOverlay();
  if (!win || typeof height !== "number") return;
  const [w, h] = win.getSize();
  const [winX, winY] = win.getPosition();
  const { workArea } = screen.getDisplayNearestPoint({ x: winX, y: winY });
  // Grow freely, but never taller than the work area leaves room for (with a
  // small bottom gap) — a runaway transcript shouldn't fill the whole screen.
  const cap = Math.max(OVERLAY_HEIGHT, workArea.height - 48);
  const target = Math.max(OVERLAY_HEIGHT, Math.min(Math.round(height), cap));
  if (target === h) return;
  // Keep the bottom edge fixed: the top moves up as the window grows. If that
  // pushes the top above the work area (a tall transcript near the top of the
  // screen), floor it at the work-area top so the transcript isn't clipped.
  const bottom = winY + h;
  const nextY = Math.max(workArea.y, bottom - target);
  win.setBounds({ x: winX, y: nextY, width: w, height: target });
});

function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const { x, y } = overlayPosition();
  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    // Must be resizable so the live transcript can grow the window via setBounds:
    // macOS ignores programmatic height changes on a non-resizable window. The
    // window is frameless, so there are no user-facing resize handles anyway.
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never steal keyboard focus from the app the user is dictating into.
    focusable: false,
    // A focusable:false window shown with showInactive() is never the active
    // window, so on macOS its mouse-downs are swallowed to (try to) activate it
    // instead of reaching the page — leaving Stop/Cancel and drag dead until some
    // later event jostled the window. acceptFirstMouse delivers that first click
    // straight to the web contents, so the controls work the moment it appears.
    acceptFirstMouse: true,
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(RENDERER, "overlay.html"));
  overlayWindow.webContents.on("render-process-gone", () => {
    // A dead overlay renderer means no more dictation; bring it back.
    overlayWindow?.webContents.reload();
  });
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
  return overlayWindow;
}

function getOverlay() {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
}

// The overlay is closable: false, which makes app.quit() silently abort on
// Windows (electron#5891): quit tries to close every window and the overlay
// refuses. destroy() bypasses the closable check; call this from before-quit.
function destroyOverlay() {
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
}

function showOverlay() {
  const win = getOverlay();
  if (!win) return;
  if (overlayHideTimer) {
    // A fade-out is in flight; this show supersedes it.
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  // Reset to the base card size before showing: a previous dictation may have
  // grown the window for its transcript, and overlayPosition() assumes the base
  // height. The renderer re-reports its height as the new transcript fills in.
  const { x, y } = overlayPosition();
  win.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
  win.showInactive();
  // Transparent, frameless windows don't begin hit-testing mouse input until
  // their bounds actually change *while visible*. The setBounds above runs while
  // the window is hidden and resolves to the same base size, so it's a no-op for
  // hit-testing — which is why Stop/Cancel and drag were dead until the live
  // transcript first grew the window (the first real on-screen resize). Nudge the
  // height by a pixel and back to force that geometry update now, so the controls
  // work the moment the overlay appears. This is the cross-platform half of the
  // fix; macOS additionally needs acceptFirstMouse (set on the window) because an
  // inactive window there swallows the first click regardless of hit-testing.
  const [w, h] = win.getSize();
  win.setSize(w, h + 1);
  win.setSize(w, h);
  win.webContents.send("overlay:show");
}

function hideOverlay() {
  const win = getOverlay();
  if (!win || !win.isVisible() || overlayHideTimer) return;
  // Let the card fade out before the window actually disappears.
  win.webContents.send("overlay:hide");
  overlayHideTimer = setTimeout(() => {
    overlayHideTimer = null;
    const w = getOverlay();
    if (w && w.isVisible()) w.hide();
  }, OVERLAY_FADE_MS);
}

function sendToOverlay(channel, payload) {
  const win = getOverlay();
  if (win) win.webContents.send(channel, payload);
}

function openSettings({ fromWizard = false } = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (fromWizard) {
      // The wizard was re-run while Settings was already open: reload so
      // the form picks up the choices the wizard just saved.
      settingsWindow.loadFile(path.join(RENDERER, "settings.html"), {
        query: { wizard: "1" },
      });
    }
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    // Snug around the 620px content column (max-width in settings.css) plus its
    // 28px side padding, so there's little left/right dead space.
    width: 680,
    // Sized so the roomier card-based General tab fits without scrolling; the
    // longer tabs (Cleanup) still scroll, which is expected.
    height: 780,
    minWidth: 560,
    minHeight: 480,
    title: "Earheart",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(
    path.join(RENDERER, "settings.html"),
    // The query lets the settings page show a "pre-configured by the setup
    // wizard" banner when it opens right after the wizard finishes.
    fromWizard ? { query: { wizard: "1" } } : undefined
  );
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

function openWizard() {
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    wizardWindow.show();
    wizardWindow.focus();
    return wizardWindow;
  }
  wizardWindow = new BrowserWindow({
    width: 620,
    height: 680,
    minWidth: 560,
    minHeight: 560,
    title: "Welcome to Earheart",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  wizardWindow.loadFile(path.join(RENDERER, "wizard.html"));
  wizardWindow.on("closed", () => {
    wizardWindow = null;
  });
  return wizardWindow;
}

function closeWizard() {
  if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
}

function closeSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
}

function sendToSettings(channel, payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

// Send to every live window. Used for events both the wizard and Settings care
// about (e.g. model download progress) so whichever is open stays in sync.
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

module.exports = {
  createOverlay,
  getOverlay,
  destroyOverlay,
  showOverlay,
  hideOverlay,
  sendToOverlay,
  openSettings,
  sendToSettings,
  broadcast,
  openWizard,
  closeWizard,
  closeSettings,
};
