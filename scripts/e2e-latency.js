// End-to-end dictation latency measurement: drives the REAL pipeline (real
// overlay recording via Chromium's fake mic, real in-process engines and
// models) and reports how long stop→result takes, per phase.
//
// The fake audio device plays a WAV file as the microphone, so the run
// exercises exactly what a user dictation does: worklet capture, live-preview
// chunking, final transcribe, cleanup, delivery (clipboard mode).
//
//   xvfb-run -a npx electron scripts/e2e-latency.js --no-sandbox \
//     --wav=/path/to/speech.wav --models=/path/to/models \
//     --config=default --talk=30 --runs=2
//
// --models points at a directory with the model-manager layout
// (<kind>/<id>/files + .complete marker); use --link-models to build it from
// loose files. --config:
//   default      live preview on, cleanup on (app defaults)
//   no-preview   live preview off, cleanup on
//   stt-only     live preview off, cleanup off
//   preview-raw  live preview on, cleanup off
// Each run within one process reuses the already-warm engine workers, so run 1
// measures the cold path and run 2 the warm path.

const { app, ipcMain, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const argv = Object.fromEntries(
  process.argv
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => a.slice(2).split(/=(.*)/s).slice(0, 2))
);
const WAV = argv.wav;
const MODELS = argv.models;
const CONFIG = argv.config || "default";
const TALK_SEC = Number(argv.talk || 30);
const RUNS = Number(argv.runs || 2);

if (!WAV || !fs.existsSync(WAV)) {
  console.error("--wav=<file> is required (16kHz mono PCM16 works best)");
  process.exit(2);
}

// Fresh userData per invocation: settings and engine state never leak between
// measurement sweeps.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-e2e-"));
app.setPath("userData", userData);

// Install the models into userData/models by symlinking the provided dir.
if (MODELS) {
  fs.symlinkSync(MODELS, path.join(userData, "models"));
}

const configs = {
  default: {},
  "no-preview": { stt: { livePreview: { enabled: false } } },
  "stt-only": {
    stt: { livePreview: { enabled: false } },
    cleanup: { enabled: false },
  },
  "preview-raw": { cleanup: { enabled: false } },
};
const overrides = configs[CONFIG];
if (!overrides) {
  console.error(`unknown --config=${CONFIG}`);
  process.exit(2);
}
// Base settings for a deterministic run: clipboard delivery (no external
// keystroke tool), no idle unload mid-sweep, no history cap surprises.
fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify(
    deepMerge(
      {
        output: { mode: "clipboard" },
        engines: { idleUnloadMinutes: 0 },
        // Explicit engine fields: migrateLegacy treats a stored slice with no
        // `engine` as a pre-engine config and maps it to "remote".
        stt: { engine: "builtin" },
        cleanup: { engine: "builtin" },
      },
      overrides
    ),
    null,
    2
  )
);

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? deepMerge(base[k] || {}, v)
        : v;
  }
  return out;
}

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", WAV);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
      cb(true)
    );

    const windows = require("../main/windows");
    const pipeline = require("../main/pipeline");
    const history = require("../main/history");

    // Timestamp every overlay-bound pipeline event so the phase breakdown is
    // exact. The pipeline calls windows.sendToOverlay at call time, so wrapping
    // the export is enough.
    let events = [];
    const realSend = windows.sendToOverlay;
    windows.sendToOverlay = (channel, payload) => {
      if (channel === "pipeline:status" || channel === "pipeline:partial") {
        events.push({ t: Date.now(), channel, payload });
      }
      return realSend(channel, payload);
    };

    const states = [];
    pipeline.onStateChange((s) => states.push({ t: Date.now(), state: s }));
    pipeline.init();

    // --debug-chunks: log committed chunk boundaries and save captured WAVs,
    // to diagnose where the silence-aware commit lands in real captures.
    if (argv["debug-chunks"]) {
      const { wavToFloat32 } = require("../main/util/wav");
      ipcMain.on("audio:partial", (event, { seq, final, fromSample, wav }) => {
        if (!final) return;
        const { samples } = wavToFloat32(Buffer.from(wav));
        let sum = 0;
        for (const s of samples) sum += s * s;
        const rms = Math.sqrt(sum / samples.length);
        // RMS of the chunk's trailing 0.3s — what the overlay's quiet check saw.
        let tsum = 0;
        const tw = Math.min(samples.length, 4800);
        for (let i = samples.length - tw; i < samples.length; i++) tsum += samples[i] * samples[i];
        console.log(
          `[e2e-chunks] commit seq=${seq} from=${fromSample} frames=${samples.length} rms=${rms.toFixed(4)} tailRms=${Math.sqrt(tsum / tw).toFixed(4)}`
        );
      });
      ipcMain.on("audio:captured", (event, { sid, wav }) => {
        const f = path.join(userData, `captured-${sid}.wav`);
        fs.writeFileSync(f, Buffer.from(wav));
        console.log(`[e2e-chunks] captured wav saved: ${f}`);
      });
    }

    const waitForState = (want, timeoutMs = 300000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = setInterval(() => {
          if (pipeline.getState() === want) {
            clearInterval(tick);
            resolve(Date.now());
          } else if (Date.now() - t0 > timeoutMs) {
            clearInterval(tick);
            reject(new Error(`timed out waiting for state ${want}`));
          }
        }, 5);
      });

    const results = [];
    for (let run = 1; run <= RUNS; run++) {
      events = [];
      pipeline.toggle();
      await waitForState("recording");
      // Wait for the mic to actually deliver (status recording appears on
      // first samples), then speak for TALK_SEC.
      await sleep(TALK_SEC * 1000);
      const tStop = Date.now();
      pipeline.toggle();
      await waitForState("idle");
      const tDone = Date.now();

      const phase = {};
      for (const e of events.filter((e) => e.channel === "pipeline:status")) {
        if (!(e.payload.status in phase)) phase[e.payload.status] = e.t - tStop;
      }
      const entry = history.list()[0];
      results.push({
        run,
        config: CONFIG,
        talkSec: TALK_SEC,
        stopToIdleMs: tDone - tStop,
        phaseStartsMs: phase,
        rawChars: entry?.raw?.length ?? null,
        textChars: entry?.text?.length ?? null,
        raw: entry?.raw ?? null,
        text: entry?.text ?? null,
      });
      console.log(
        `[e2e] run ${run} (${CONFIG}, talk ${TALK_SEC}s): stop->done ${tDone - tStop}ms  phases=${JSON.stringify(phase)}`
      );
      await sleep(1500);
    }

    fs.writeFileSync(
      path.join(userData, "e2e-results.json"),
      JSON.stringify(results, null, 2)
    );
    console.log(`[e2e] RESULTS ${JSON.stringify(results.map(({ raw, text, ...r }) => r))}`);
    console.log(`[e2e] transcripts in ${path.join(userData, "e2e-results.json")}`);
    windows.destroyOverlay();
    app.exit(0);
  } catch (err) {
    console.error("[e2e] failed:", (err && err.stack) || err);
    app.exit(1);
  }
});
