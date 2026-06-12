// Window management: the recording overlay (a small always-on-top pill that
// also owns the microphone) and the settings window.

const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");

const PRELOAD = path.join(__dirname, "..", "preload.js");
const RENDERER = path.join(__dirname, "..", "renderer");

const OVERLAY_WIDTH = 360;
const OVERLAY_HEIGHT = 80;
// Matches the pill's fade-out transition in overlay.css.
const OVERLAY_FADE_MS = 200;

let overlayWindow = null;
let settingsWindow = null;
let wizardWindow = null;
let overlayCustomPosition = null; // set when the user drags the pill
let overlayDragOrigin = null; // { winX, winY, pointerX, pointerY }
let overlayHideTimer = null;

function clampToWorkArea(x, y) {
  const { workArea } = screen.getDisplayNearestPoint({ x, y });
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - OVERLAY_WIDTH),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - OVERLAY_HEIGHT),
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

// Click-and-drag for the overlay pill. The renderer streams absolute screen
// coordinates; positioning from a recorded origin (instead of incremental
// deltas) keeps the pill glued to the cursor even if events are dropped.
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
  const next = clampToWorkArea(
    Math.round(overlayDragOrigin.winX + x - overlayDragOrigin.pointerX),
    Math.round(overlayDragOrigin.winY + y - overlayDragOrigin.pointerY)
  );
  win.setPosition(next.x, next.y);
  overlayCustomPosition = next;
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
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never steal keyboard focus from the app the user is dictating into.
    focusable: false,
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
  const { x, y } = overlayPosition();
  win.setPosition(x, y);
  win.showInactive();
  win.webContents.send("overlay:show");
}

function hideOverlay() {
  const win = getOverlay();
  if (!win || !win.isVisible() || overlayHideTimer) return;
  // Let the pill fade out before the window actually disappears.
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
    width: 760,
    height: 640,
    minWidth: 620,
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

function sendToSettings(channel, payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
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
  openWizard,
  closeWizard,
};
