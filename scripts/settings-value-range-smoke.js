// Exercise numeric Settings collection, IPC save, and persistence in Electron.
const { app, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const userData = path.join(
  os.tmpdir(),
  `earheart-settings-ranges-${crypto.createHash("sha1").update(__dirname).digest("hex").slice(0, 8)}`
);
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);

const windows = require("../main/windows");
const settings = require("../main/settings");
const ipc = require("../main/ipc");

function check(name, condition) {
  if (!condition) throw new Error(name);
  console.log(`[settings-value-range] ok ${name}`);
}

async function openSettings() {
  console.log("[settings-value-range] opening Settings");
  const win = windows.openSettings();
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  win.webContents.on("did-fail-load", (_event, code, description, url) => console.error("[settings-value-range] load failed", code, description, url));
  win.webContents.on("render-process-gone", (_event, details) => console.error("[settings-value-range] renderer gone", details));
  win.webContents.on("console-message", (_event, level, message, line, source) => console.log("[settings-value-range] renderer", level, message, line, source));
  win.on("closed", () => console.log("[settings-value-range] window closed"));
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const recording = document.getElementById("max-seconds");
      const idle = document.getElementById("idle-unload");
      if (document.getElementById("version").textContent.startsWith("v") && recording && idle && recording.value !== "" && idle.value !== "") resolve();
      else if (Date.now() - start > 5000) reject(new Error("Settings initialization timed out"));
      else setTimeout(poll, 10);
    };
    poll();
  })`);
  console.log("[settings-value-range] Settings ready");
  return win;
}

async function reopenSettings(previous, closed) {
  await closed;
  return openSettings();
}

async function saveValues(win, recording, idle) {
  console.log(`[settings-value-range] saving ${JSON.stringify(recording)} / ${JSON.stringify(idle)}`);
  const closed = new Promise((resolve) => win.once("closed", resolve));
  win.webContents.executeJavaScript(`(async () => {
    const button = document.getElementById("save");
    if (button.disabled) throw new Error("Settings save button is unexpectedly disabled");
    document.getElementById("max-seconds").value = ${JSON.stringify(recording)};
    document.getElementById("idle-unload").value = ${JSON.stringify(idle)};
    button.click();
    const start = Date.now();
    while (!button.disabled) {
      if (Date.now() - start > 5000) throw new Error("Settings save did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    while (document.getElementById("save-status").textContent !== "Saved") {
      if (Date.now() - start > 5000) throw new Error("Settings save timed out: " + document.getElementById("save-status").textContent + " disabled=" + button.disabled);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })()`).catch((error) => console.log("[settings-value-range] renderer detached after save:", error.message));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Settings save did not close the window")), 10000))]);
  console.log("[settings-value-range] save acknowledged by window close");
}

function readPersisted() {
  return JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
}

app.whenReady().then(async () => {
  const openedWindows = [];
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(true));
    ipc.init({
      applyHotkeys: () => ({ hotkey: { ok: true }, pauseHotkey: { ok: true } }),
      onSettingsChanged: () => {},
    });

    settings.save({
      ...settings.DEFAULTS,
      audio: { ...settings.DEFAULTS.audio, maxRecordingSeconds: -5 },
      engines: { ...settings.DEFAULTS.engines, idleUnloadMinutes: 99999 },
    });
    let win = await openSettings();
    openedWindows.push(win);
    await saveValues(win, "", "");
    check("blank saved recording fallback -5 clamps to 10", settings.get().audio.maxRecordingSeconds === 10);
    check("blank saved idle fallback 99999 clamps to 240", settings.get().engines.idleUnloadMinutes === 240);
    let persisted = readPersisted();
    check("disk stores clamped blank fallback", persisted.audio.maxRecordingSeconds === 10 && persisted.engines.idleUnloadMinutes === 240);
    win = await reopenSettings(win, Promise.resolve());
    openedWindows.push(win);
    await saveValues(win, "not a number", "Infinity");
    check("invalid recording input keeps its safe persisted value", settings.get().audio.maxRecordingSeconds === 10);
    check("nonfinite idle input keeps its safe persisted value", settings.get().engines.idleUnloadMinutes === 240);

    persisted = readPersisted();
    check("disk retains safe values after invalid inputs", persisted.audio.maxRecordingSeconds === 10 && persisted.engines.idleUnloadMinutes === 240);
    win = await reopenSettings(win, win._smokeClosed);
    openedWindows.push(win);
    await saveValues(win, "1", "999");
    check("typed low/high boundaries persist as 10 and 240", settings.get().audio.maxRecordingSeconds === 10 && settings.get().engines.idleUnloadMinutes === 240);

    persisted = readPersisted();
    check("disk stores typed low/high bounds", persisted.audio.maxRecordingSeconds === 10 && persisted.engines.idleUnloadMinutes === 240);
    win = await reopenSettings(win, win._smokeClosed);
    openedWindows.push(win);
    await saveValues(win, "99999", "-1");
    check("typed high/low boundaries persist as 3600 and 0", settings.get().audio.maxRecordingSeconds === 3600 && settings.get().engines.idleUnloadMinutes === 0);

    persisted = readPersisted();
    check("disk stores typed high/low bounds", persisted.audio.maxRecordingSeconds === 3600 && persisted.engines.idleUnloadMinutes === 0);
    win = await reopenSettings(win, win._smokeClosed);
    openedWindows.push(win);
    await saveValues(win, "300", "0");
    check("idle zero persists as never unload", settings.get().engines.idleUnloadMinutes === 0);
    persisted = readPersisted();
    check("settings.json contains the collected recording value", persisted.audio.maxRecordingSeconds === 300);
    check("settings.json preserves idle zero as never unload", persisted.engines.idleUnloadMinutes === 0);
    console.log("[settings-value-range] all persistence scenarios passed");
  } catch (error) {
    console.error("[settings-value-range] FAIL", error);
    process.exitCode = 1;
  } finally {
    for (const win of openedWindows) if (!win.isDestroyed()) win.destroy();
    app.exit(process.exitCode || 0);
  }
});

app.on("will-quit", () => {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {}
});
