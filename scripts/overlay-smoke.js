// Drives the real overlay page against Chromium's fake audio capture device
// and verifies the capture/UI sync contract of a dictation session:
//
//   1. The card never claims "Listening…" before audio samples actually flow:
//      the status goes starting -> recording, in that order.
//   2. Capture is aligned with the UI: the WAV delivered on stop covers (at
//      least) everything from the moment "Listening…" appeared, and it is not
//      silence — so no words spoken after the invitation to talk are lost.
//   3. A stop that races mic startup still resolves with audio:captured
//      instead of hanging the pipeline.
//   4. The shared AudioContext survives across sessions: after a completed
//      dictation AND after a cancel mid-startup, the next session records
//      again (suspend/resume reuse, no stale worklet).
//
// Run under Electron:
//
//   xvfb-run -a npx electron scripts/overlay-smoke.js --no-sandbox   # Linux
//   npx electron scripts/overlay-smoke.js                            # macOS/Win

const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("node:path");

// The fake device makes getUserMedia succeed without hardware and produces a
// tone, so captured WAVs contain real, non-silent samples deterministically.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const RENDERER = path.join(__dirname, "..", "renderer");
const PRELOAD = path.join(__dirname, "..", "preload.js");
const SAMPLE_RATE = 16000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  const suffix = detail ? ` (${detail})` : "";
  console.log(`[overlay-smoke] ${ok ? "ok  " : "FAIL"} ${name}${suffix}`);
}

function waitForMessage(channel, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, handler);
      reject(new Error(`timed out waiting for ${channel}`));
    }, timeoutMs);
    const handler = (event, payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    ipcMain.once(channel, handler);
  });
}

function cardStatus(win) {
  return win.webContents.executeJavaScript(
    `document.getElementById("card").dataset.status`
  );
}

// Poll until the card shows `want`; resolves with the time it was observed.
async function waitForStatus(win, want, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await cardStatus(win);
    if (status === want) return Date.now();
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for status "${want}" (at "${status}")`);
    }
    await sleep(10);
  }
}

// Duration and level of an audio:captured WAV (16 kHz mono PCM16).
function wavStats(wav) {
  const buf = Buffer.from(wav);
  const samples = Math.max(0, Math.floor((buf.length - 44) / 2));
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(44 + i * 2) / 0x8000;
    sum += s * s;
  }
  return {
    samples,
    seconds: samples / SAMPLE_RATE,
    rms: samples ? Math.sqrt(sum / samples) : 0,
  };
}

const start = (win, sid) =>
  win.webContents.send("record:start", {
    sid,
    deviceId: null,
    maxSeconds: 30,
    livePreview: { enabled: false },
  });

app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
      cb(true)
    );
    // A mic error anywhere is a failure worth seeing in the log.
    ipcMain.on("record:error", (event, payload) =>
      console.error("[overlay-smoke] record:error:", payload?.message)
    );

    const win = new BrowserWindow({
      width: 360,
      height: 92,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    await win.loadFile(path.join(RENDERER, "overlay.html"));

    // ---- Session 1: status order, and capture aligned with the UI ----------
    // Record every data-status transition from inside the page, so the order
    // is exact rather than sampled by polling.
    await win.webContents.executeJavaScript(`
      window.__statusLog = [document.getElementById("card").dataset.status];
      new MutationObserver(() => {
        const s = document.getElementById("card").dataset.status;
        if (window.__statusLog.at(-1) !== s) window.__statusLog.push(s);
      }).observe(document.getElementById("card"), {
        attributes: true,
        attributeFilter: ["data-status"],
      });
      "";
    `);

    start(win, 1);
    const liveAt = await waitForStatus(win, "recording");
    const log = await win.webContents.executeJavaScript("window.__statusLog");
    check(
      "status shows starting before recording",
      log.indexOf("starting") !== -1 &&
        log.indexOf("recording") > log.indexOf("starting"),
      `transitions=${JSON.stringify(log)}`
    );

    await sleep(1200); // "talk" for a bit while live
    const captured1P = waitForMessage("audio:captured");
    win.webContents.send("record:stop");
    const stoppedAt = Date.now();
    const captured1 = await captured1P;
    const stats1 = wavStats(captured1.wav);
    check("stop delivers the capture for the right session", captured1.sid === 1);
    check(
      "wav covers everything since Listening… appeared",
      stats1.seconds >= (stoppedAt - liveAt) / 1000 - 0.15,
      `wav=${stats1.seconds.toFixed(2)}s, ui-live window=${((stoppedAt - liveAt) / 1000).toFixed(2)}s`
    );
    check("captured audio is not silence", stats1.rms > 0.001, `rms=${stats1.rms.toFixed(4)}`);

    // ---- Session 2: stop racing mic startup still resolves -----------------
    const captured2P = waitForMessage("audio:captured");
    start(win, 2);
    win.webContents.send("record:stop"); // lands while getUserMedia is pending
    const captured2 = await captured2P;
    const stats2 = wavStats(captured2.wav);
    check("stop during mic startup still completes", captured2.sid === 2);
    check(
      "stop before mic-live captures (near) nothing",
      stats2.seconds < 0.5,
      `wav=${stats2.seconds.toFixed(2)}s`
    );

    // ---- Session 3: the shared context records again after reuse -----------
    const t0 = Date.now();
    start(win, 3);
    await waitForStatus(win, "recording");
    console.log(`[overlay-smoke] warm start -> mic live in ${Date.now() - t0}ms`);
    await sleep(600);
    const captured3P = waitForMessage("audio:captured");
    win.webContents.send("record:stop");
    const stats3 = wavStats((await captured3P).wav);
    check(
      "later session records on the reused audio engine",
      stats3.seconds > 0.4 && stats3.rms > 0.001,
      `wav=${stats3.seconds.toFixed(2)}s rms=${stats3.rms.toFixed(4)}`
    );

    // ---- Session 4/5: cancel mid-startup, then a full session again --------
    start(win, 4);
    win.webContents.send("record:cancel"); // lands while getUserMedia is pending
    await sleep(300);
    start(win, 5);
    await waitForStatus(win, "recording");
    await sleep(600);
    const captured5P = waitForMessage("audio:captured");
    win.webContents.send("record:stop");
    const captured5 = await captured5P;
    const stats5 = wavStats(captured5.wav);
    check(
      "recording works after a cancel mid-startup",
      captured5.sid === 5 && stats5.seconds > 0.4 && stats5.rms > 0.001,
      `wav=${stats5.seconds.toFixed(2)}s rms=${stats5.rms.toFixed(4)}`
    );

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      throw new Error(`${failed.length} check(s) failed`);
    }
    console.log(`[overlay-smoke] all ${checks.length} checks passed`);
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error("[overlay-smoke] failed:", (err && err.message) || err);
    app.exit(1);
  }
});
