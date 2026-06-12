// Window management: the recording overlay (a small always-on-top pill that
// also owns the microphone) and the settings window.

const { BrowserWindow, screen } = require("electron");
const path = require("node:path");

const PRELOAD = path.join(__dirname, "..", "preload.js");
const RENDERER = path.join(__dirname, "..", "renderer");

const OVERLAY_WIDTH = 360;
const OVERLAY_HEIGHT = 80;

let overlayWindow = null;
let settingsWindow = null;
let wizardWindow = null;

function overlayPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY_HEIGHT - 24),
  };
}

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

function showOverlay() {
  const win = getOverlay();
  if (!win) return;
  const { x, y } = overlayPosition();
  win.setPosition(x, y);
  win.showInactive();
}

function hideOverlay() {
  const win = getOverlay();
  if (win && win.isVisible()) win.hide();
}

function sendToOverlay(channel, payload) {
  const win = getOverlay();
  if (win) win.webContents.send(channel, payload);
}

function openSettings({ fromWizard = false } = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
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
  showOverlay,
  hideOverlay,
  sendToOverlay,
  openSettings,
  sendToSettings,
  openWizard,
  closeWizard,
};
