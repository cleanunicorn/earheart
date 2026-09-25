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

async function saveValues(win, recording, idle, sampling) {
  console.log(`[settings-value-range] saving ${JSON.stringify(recording)} / ${JSON.stringify(idle)}`);
  const samplingScript = sampling
    ? [
        `document.querySelector('input[name="cleanup-style-mode"][value="custom"]').checked = true;`,
        `document.getElementById("cleanup-temperature").value = ${JSON.stringify(sampling.temperature)};`,
        `document.getElementById("cleanup-top-p").value = ${JSON.stringify(sampling.topP)};`,
        `document.getElementById("cleanup-top-k").value = ${JSON.stringify(sampling.topK)};`,
        `document.getElementById("cleanup-min-p").value = ${JSON.stringify(sampling.minP)};`,
      ].join("\n")
    : "";
  const closed = new Promise((resolve) => win.once("closed", resolve));
  win.webContents.executeJavaScript(`(async () => {
    const button = document.getElementById("save");
    if (button.disabled) throw new Error("Settings save button is unexpectedly disabled");
    document.getElementById("max-seconds").value = ${JSON.stringify(recording)};
    document.getElementById("idle-unload").value = ${JSON.stringify(idle)};
    ${samplingScript}
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
    fs.writeFileSync(
      path.join(userData, "settings.json"),
      JSON.stringify({
        audio: { maxRecordingSeconds: -5 },
        engines: { idleUnloadMinutes: 99999 },
        cleanup: { custom: { temperature: 9, topP: -1, topK: -50, minP: 2 } },
      })
    );
    const loaded = settings.get();
    check("load clamps corrupted recording limit", loaded.audio.maxRecordingSeconds === 10);
    check("load clamps corrupted idle window", loaded.engines.idleUnloadMinutes === 240);
    check("load clamps corrupted sampling values", loaded.cleanup.custom.temperature === 2 && loaded.cleanup.custom.topP === 0 && loaded.cleanup.custom.topK === 0 && loaded.cleanup.custom.minP === 1);

    ipc.init({
      applyHotkeys: () => ({ hotkey: { ok: true }, pauseHotkey: { ok: true } }),
      onSettingsChanged: () => {},
    });

    settings.save({
      ...loaded,
      audio: { ...loaded.audio, maxRecordingSeconds: -5 },
      engines: { ...loaded.engines, idleUnloadMinutes: 99999 },
      cleanup: {
        ...loaded.cleanup,
        custom: { temperature: -5, topP: 2, topK: 999, minP: -1 },
      },
    });
    let persisted = readPersisted();
    check("save clamps invalid settings at the main-process boundary", settings.get().audio.maxRecordingSeconds === 10 && settings.get().engines.idleUnloadMinutes === 240 && settings.get().cleanup.custom.temperature === 0 && settings.get().cleanup.custom.topP === 1 && settings.get().cleanup.custom.topK === 200 && settings.get().cleanup.custom.minP === 0);
    check("disk stores main-process clamped values", persisted.audio.maxRecordingSeconds === 10 && persisted.engines.idleUnloadMinutes === 240 && persisted.cleanup.custom.temperature === 0 && persisted.cleanup.custom.topP === 1 && persisted.cleanup.custom.topK === 200 && persisted.cleanup.custom.minP === 0);

    let win = await openSettings();
    openedWindows.push(win);
    await saveValues(win, "", "", { temperature: "", topP: "", topK: "", minP: "" });
    check("blank numeric fields preserve only in-range saved fallbacks", settings.get().audio.maxRecordingSeconds === 10 && settings.get().engines.idleUnloadMinutes === 240 && settings.get().cleanup.custom.temperature === 0 && settings.get().cleanup.custom.topP === 1 && settings.get().cleanup.custom.topK === 200 && settings.get().cleanup.custom.minP === 0);
    persisted = readPersisted();
    check("disk stores clamped blank fallbacks", persisted.audio.maxRecordingSeconds === 10 && persisted.engines.idleUnloadMinutes === 240 && persisted.cleanup.custom.temperature === 0 && persisted.cleanup.custom.topP === 1 && persisted.cleanup.custom.topK === 200 && persisted.cleanup.custom.minP === 0);
    win = await reopenSettings(win, Promise.resolve());
    openedWindows.push(win);
    await saveValues(win, "not a number", "Infinity", { temperature: "bad", topP: "bad", topK: "bad", minP: "bad" });
    check("invalid recording input keeps its safe persisted value", settings.get().audio.maxRecordingSeconds === 10);
    check("nonfinite idle input keeps its safe persisted value", settings.get().engines.idleUnloadMinutes === 240);

    persisted = readPersisted();
    check("disk retains safe values after invalid inputs", persisted.audio.maxRecordingSeconds === 10 && persisted.engines.idleUnloadMinutes === 240);
    win = await reopenSettings(win, win._smokeClosed);
    openedWindows.push(win);
    await saveValues(win, "1", "999", { temperature: "9", topP: "-1", topK: "999", minP: "-1" });
    check("typed low/high boundaries persist as 10 and 240", settings.get().audio.maxRecordingSeconds === 10 && settings.get().engines.idleUnloadMinutes === 240);
    check("typed sampling boundaries persist in range", settings.get().cleanup.custom.temperature === 2 && settings.get().cleanup.custom.topP === 0 && settings.get().cleanup.custom.topK === 200 && settings.get().cleanup.custom.minP === 0);

    persisted = readPersisted();
    check("disk stores typed low/high bounds", persisted.audio.maxRecordingSeconds === 10 && persisted.engines.idleUnloadMinutes === 240);
    win = await reopenSettings(win, win._smokeClosed);
    openedWindows.push(win);
    await saveValues(win, "99999", "-1", { temperature: "0.55", topP: "0.75", topK: "40.5", minP: "0.35" });
    check("typed high/low boundaries persist as 3600 and 0", settings.get().audio.maxRecordingSeconds === 3600 && settings.get().engines.idleUnloadMinutes === 0);
    check("sampling precision is preserved while top-k remains integral", settings.get().cleanup.custom.temperature === 0.55 && settings.get().cleanup.custom.topP === 0.75 && settings.get().cleanup.custom.topK === 41 && settings.get().cleanup.custom.minP === 0.35);

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
