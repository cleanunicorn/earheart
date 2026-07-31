// Drives the real overlay page against Chromium's fake audio capture device
// and verifies the capture/UI sync contract of a dictation session:
//
//   1. The card never claims "Listening…" before audio samples actually flow:
//      the status goes starting -> recording, in that order.
//   2. Capture is aligned with the UI: the WAV delivered on stop covers (at
//      least) everything from the moment "Listening…" appeared, and it is not
//      silence — so no words spoken after the invitation to talk are lost.
//   3. A stop that races mic startup resolves as record:cancelled (nothing was
//      captured, so there is no dictation to transcribe) instead of hanging.
//   4. The shared AudioContext survives across sessions: after a completed
//      dictation AND after a cancel mid-startup, the next session records
//      again (suspend/resume reuse, no stale worklet).
//
// Run under Electron:
//
//   xvfb-run -a npx electron scripts/overlay-smoke.js --no-sandbox   # Linux
//   npx electron scripts/overlay-smoke.js                            # macOS/Win

const { app, ipcMain, session } = require("electron");
const windows = require("../main/windows");
const { wavToFloat32, wavDurationSec } = require("../main/util/wav");

// The fake device makes getUserMedia succeed without hardware and produces a
// tone, so captured WAVs contain real, non-silent samples deterministically.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How far the delivered WAV may fall short of the wall-clock window it should
// cover. The gap is audio-thread scheduling: the worklet posts 128-sample
// quanta (8ms at 16kHz), and the last few can still be in flight when stop
// lands. 150ms (~19 quanta) is the real contract — a capture path that drops
// audio misses by far more than this.
//
// macOS CI runners are the exception: they are shared and their audio thread
// gets descheduled hard enough to lose ~230ms of a 1.2s window (observed on
// GitHub Actions macos-latest, PR #56), which trips a 150ms bound on a build
// with nothing wrong with it. Give darwin 350ms — still ~1.5x the worst
// shortfall we've measured, and still nowhere near what a broken capture path
// would produce. Widened only where the flake lives: the other duration bounds
// in this file already carry 200-250ms of slack.
const WAV_LAG_ALLOWANCE_SEC = process.platform === "darwin" ? 0.35 : 0.15;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  const suffix = detail ? ` (${detail})` : "";
  console.log(`[overlay-smoke] ${ok ? "ok  " : "FAIL"} ${name}${suffix}`);
}

// Any record:error is a failure: the fake device always delivers, so a mic
// error here means the session plumbing broke. Collected so waitForStatus can
// surface the real diagnostic instead of an opaque status timeout.
const micErrors = [];

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
    if (micErrors.length > 0) {
      throw new Error(`record:error while waiting for "${want}": ${micErrors[0]}`);
    }
    const status = await cardStatus(win);
    if (status === want) return Date.now();
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for status "${want}" (at "${status}")`);
    }
    await sleep(10);
  }
}

// Duration and level of an audio:captured WAV, via the same RIFF parsers the
// main process uses on real dictations.
function wavStats(wav) {
  const buf = Buffer.from(wav);
  const { samples } = wavToFloat32(buf);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return {
    samples: samples.length,
    seconds: wavDurationSec(buf),
    rms: samples.length ? Math.sqrt(sum / samples.length) : 0,
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
    ipcMain.on("record:error", (event, payload) => {
      micErrors.push(payload?.message || "unknown");
      console.error("[overlay-smoke] record:error:", payload?.message);
    });

    // The production overlay window (same flags, preload, throttling config the
    // shipped app runs with) — the same staging approach as scripts/screenshots.js.
    const win = windows.createOverlay();
    await new Promise((resolve) =>
      win.webContents.once("did-finish-load", resolve)
    );

    // Show the window the production way: showOverlay() positions it, shows
    // it without focus, and sends overlay:show — which the card answers by
    // adding .visible. This must happen before the wave-clock checks below:
    // a hidden window's frame clock collapses to ~1fps, freezing the
    // requestAnimationFrame loop the waveform is written from.
    windows.showOverlay();
    const visibleDeadline = Date.now() + 5000;
    let cardVisible = false;
    while (!cardVisible && Date.now() < visibleDeadline) {
      cardVisible = await win.webContents.executeJavaScript(
        `document.getElementById("card").classList.contains("visible")`
      );
      if (!cardVisible) await sleep(10);
    }
    check("overlay:show makes the card visible", cardVisible);

    // One snapshot of the key/detail state the CSS+JS contract promises for a
    // given moment; read computed display (never #meter opacity — that is
    // mid-transition whenever it is read synchronously).
    const uiState = () =>
      win.webContents.executeJavaScript(`({
        pauseDisplay: getComputedStyle(document.querySelector("#pause .icon-pause")).display,
        resumeDisplay: getComputedStyle(document.querySelector("#pause .icon-resume")).display,
        ariaPressed: document.getElementById("pause").getAttribute("aria-pressed"),
        dataDetail: document.getElementById("card").hasAttribute("data-detail"),
        detailDisplay: getComputedStyle(document.getElementById("detail-text")).display,
        stopDisabled: document.getElementById("stop").disabled,
        pauseDisabled: document.getElementById("pause").disabled,
      })`);

    const waveColumns = () =>
      win.webContents.executeJavaScript("waveHistory.length");

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
      stats1.seconds >= (stoppedAt - liveAt) / 1000 - WAV_LAG_ALLOWANCE_SEC,
      `wav=${stats1.seconds.toFixed(2)}s, ui-live window=${((stoppedAt - liveAt) / 1000).toFixed(2)}s, allowance=${WAV_LAG_ALLOWANCE_SEC}s`
    );
    check("captured audio is not silence", stats1.rms > 0.001, `rms=${stats1.rms.toFixed(4)}`);

    // ---- Session 2: stop racing mic startup resolves as abandoned ----------
    const cancelled2P = waitForMessage("record:cancelled");
    start(win, 2);
    win.webContents.send("record:stop"); // lands while getUserMedia is pending
    const cancelled2 = await cancelled2P;
    check(
      "stop before mic-live resolves as an abandoned attempt",
      cancelled2.sid === 2,
      `sid=${cancelled2.sid}`
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

    // ---- Session 6: pause holds capture; the paused span is excluded --------
    // Speak ~0.5s, pause ~0.6s (the fake mic keeps producing tone — none of it
    // may land in the capture), resume and speak ~0.5s more. The WAV must
    // cover only the live spans, and the timer must agree with it.
    start(win, 6);
    await waitForStatus(win, "recording");
    const wave0 = await waveColumns();
    await sleep(500);
    // The waveform is the bar's proof of hearing: while live, the canvas must
    // actually carry paint (a drawMeter throw would kill the rAF loop
    // silently and leave a dead bar with every IPC check still green).
    const litPixels = await win.webContents.executeJavaScript(`(() => {
      const c = document.getElementById("meter");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    })()`);
    check("waveform paints while recording", litPixels > 0, `lit=${litPixels}`);
    // Drive pause through the real channel (pause hotkey / `earheart --pause`
    // land here), so the preload whitelist and the renderer handler are both
    // exercised.
    win.webContents.send("record:pause-toggle");
    await waitForStatus(win, "paused");
    const wave1 = await waveColumns();
    check(
      "waveform write clock runs while live",
      wave1 - wave0 >= 3 && wave1 - wave0 <= 10,
      `columns=${wave1 - wave0} over ~500ms (one per 80ms expected; 0 means the frame clock is not running)`
    );
    // The paused key must SAY it resumes: play glyph shown, pause glyph
    // hidden, aria-pressed latched — and the hint's detail line takes the
    // wave area (data-detail), while stop/pause both stay usable.
    const pausedUi = await uiState();
    check(
      "paused key shows the resume glyph and latches aria-pressed",
      pausedUi.resumeDisplay === "block" &&
        pausedUi.pauseDisplay === "none" &&
        pausedUi.ariaPressed === "true",
      `resume=${pausedUi.resumeDisplay} pause=${pausedUi.pauseDisplay} aria-pressed=${pausedUi.ariaPressed}`
    );
    check(
      "paused hint takes the detail line (data-detail set)",
      pausedUi.dataDetail === true && pausedUi.detailDisplay === "block",
      `data-detail=${pausedUi.dataDetail} detail display=${pausedUi.detailDisplay}`
    );
    check(
      "stop and pause stay usable while paused",
      pausedUi.stopDisabled === false && pausedUi.pauseDisabled === false
    );
    await sleep(600);
    const wave2 = await waveColumns();
    check(
      "waveform holds while paused",
      wave2 === wave1,
      `columns grew ${wave2 - wave1} across a 600ms pause`
    );
    win.webContents.send("record:pause-toggle");
    await waitForStatus(win, "recording");
    // Resume must clear the latch and the detail line in lockstep — a
    // data-detail left set would dim the waveform to 7% for the rest of the
    // app's lifetime.
    const resumedUi = await uiState();
    check(
      "resume restores the pause glyph and clears the detail line",
      resumedUi.pauseDisplay === "block" &&
        resumedUi.resumeDisplay === "none" &&
        resumedUi.ariaPressed === "false" &&
        resumedUi.dataDetail === false &&
        resumedUi.detailDisplay === "none",
      `pause=${resumedUi.pauseDisplay} resume=${resumedUi.resumeDisplay} aria-pressed=${resumedUi.ariaPressed} data-detail=${resumedUi.dataDetail}`
    );
    await sleep(500);
    const wave3 = await waveColumns();
    check(
      "waveform write clock resumes with the take",
      wave3 - wave2 >= 3,
      `columns=${wave3 - wave2} over ~500ms resumed`
    );
    const captured6P = waitForMessage("audio:captured");
    win.webContents.send("record:stop");
    const captured6 = await captured6P;
    const stats6 = wavStats(captured6.wav);
    check(
      "paused span is excluded from the capture",
      captured6.sid === 6 && stats6.seconds > 0.75 && stats6.seconds < 1.35,
      `wav=${stats6.seconds.toFixed(2)}s across ~1.0s live + 0.6s paused`
    );
    const timer6 = await win.webContents.executeJavaScript(
      `document.getElementById("timer").textContent`
    );
    check(
      "timer counts captured audio only",
      timer6 === "0:00" || timer6 === "0:01",
      `timer=${timer6}`
    );

    // ---- Terminal state: the keys go inert once the dictation lands --------
    // Done is the bar's only filled key; a regression in setStatus's
    // enablement branch would leave it lit and clickable after delivery.
    win.webContents.send("pipeline:status", {
      status: "done",
      detail: { preview: "staged preview" },
    });
    await waitForStatus(win, "done");
    const doneUi = await uiState();
    check(
      "Done and pause go inert once the dictation is delivered",
      doneUi.stopDisabled === true && doneUi.pauseDisabled === true,
      `stop.disabled=${doneUi.stopDisabled} pause.disabled=${doneUi.pauseDisabled}`
    );

    check("no mic errors during the run", micErrors.length === 0, micErrors.join("; "));

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      throw new Error(`${failed.length} check(s) failed`);
    }
    console.log(`[overlay-smoke] all ${checks.length} checks passed`);
    windows.destroyOverlay();
    app.exit(0);
  } catch (err) {
    console.error("[overlay-smoke] failed:", (err && err.message) || err);
    app.exit(1);
  }
});
