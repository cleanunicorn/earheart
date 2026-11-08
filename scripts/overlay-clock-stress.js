// Investigation harness for #371, not a CI gate or a recovery implementation.
// xvfb-run -a npx electron scripts/overlay-clock-stress.js --no-sandbox [overlay|runtime|runtime-serial|runtime-gap] [120]
// All modes exercise stop during pending acquisition, then a 1.2 s take.
// runtime uses only the platform graph, with the same shared 16 kHz context,
// real recorder processor, disconnect/stop/suspend ordering and fake device.
const { app, ipcMain, session } = require("electron");
const { performance } = require("node:perf_hooks");
const { isolateProfile } = require("./demo-profile");
isolateProfile(app, { prefix: "earheart-overlay-smoke-" });
const windows = require("../main/windows");
windows.init();
const { waitForLoad } = require("./wait-for-load");
const { installPermissionHandler } = require("../main/window-guard");
const { wavToFloat32 } = require("../main/util/wav");
const mode = process.argv.find((a) => ["overlay", "runtime", "runtime-serial", "runtime-gap"].includes(a)) || "overlay";
const iterations = Number(process.argv.find((a) => /^\d+$/.test(a)) || 120);
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One owner and SID per subscription. Every completion/error/timeout/finally
// removes the listener; a cancellation never waits for audio:captured.
function terminal(wc, sid) {
  const events = [];
  const channels = ["record:cancelled", "audio:captured", "record:error"];
  const listeners = channels.map((channel) => {
    const listener = (event, payload) => {
      if (event.sender === wc && payload?.sid === sid) events.push({ channel, payload });
    };
    ipcMain.on(channel, listener);
    return listener;
  });
  return { events, close() { channels.forEach((ch, i) => ipcMain.removeListener(ch, listeners[i])); } };
}

app.whenReady().then(async () => {
  let win;
  try {
    installPermissionHandler(session.defaultSession);
    win = windows.createOverlay();
    await waitForLoad(win.webContents);
    windows.showOverlay();
    const js = (code) => win.webContents.executeJavaScript(code);
    console.log(JSON.stringify({ mode, iterations, versions: process.versions, platform: process.platform, arch: process.arch }));
    await js(`(async () => {
      await ensureAudioEngine();
      window.clockProbe = { posts: 0, timeline: [] };
      const probe = window.clockProbe;
      for (const method of ["resume", "suspend", "close"]) {
        const original = AudioContext.prototype[method];
        AudioContext.prototype[method] = function (...args) {
          probe.timeline.push({ method, at: performance.now(), state: this.state, time: this.currentTime });
          return original.apply(this, args).then(value => {
            probe.timeline.push({ method: method + ":done", at: performance.now(), state: this.state, time: this.currentTime });
            return value;
          });
        };
      }
      const OriginalNode = AudioWorkletNode;
      window.AudioWorkletNode = class extends OriginalNode {
        constructor(...args) {
          super(...args);
          this.port.addEventListener("message", () => probe.posts++);
          this.port.start();
        }
      };
      // Minimal platform reproduction, independent of overlay's session code.
      window.runtime = { ctx: null, rec: null, stopPending: false, pending: false, cancelled: null };
      runtime.ctx = audioContext;
      runtime.stop = () => {
        if (!runtime.rec) { runtime.stopPending = true; return; }
        const rec = runtime.rec; runtime.rec = null;
        rec.node.port.postMessage("stop");
        rec.source.disconnect(); rec.node.disconnect();
        rec.stream.getTracks().forEach(t => t.stop());
        runtime.parked = ${mode === "runtime-serial"}
          ? runtime.resuming.then(() => runtime.ctx.suspend())
          : runtime.ctx.suspend();
        if (!rec.samples.length) runtime.cancelled = rec.sid;
        runtime.last = rec;
      };
      runtime.start = async sid => {
        runtime.pending = true;
        runtime.stopPending = false;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(null) });
        if (${mode === "runtime-serial"}) await runtime.parked;
        runtime.resuming = runtime.ctx.resume();
        const source = runtime.ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(runtime.ctx, "recorder");
        const rec = { sid, stream, source, node, samples: [] };
        node.port.onmessage = e => { if (runtime.rec === rec && e.data.samples) rec.samples.push(...e.data.samples); };
        source.connect(node); runtime.rec = rec; runtime.pending = false;
        if (runtime.stopPending) runtime.stop();
      };
    })()`);
    const start = (sid) => win.webContents.send("record:start", { sid, deviceId: null, maxSeconds: 30, livePreview: { enabled: false } });
    const stop = () => win.webContents.send("record:stop");
    const wait = async (read, label, ms = 12000) => {
      const began = performance.now();
      while (!(await read())) {
        if (performance.now() - began > ms) throw new Error(label);
        await sleep(10);
      }
    };
    const snapshot = () => js(`(() => {
      const c = ${mode === "overlay" ? "audioContext" : "runtime.ctx"};
      const rec = ${mode === "overlay" ? "recording" : "runtime.rec"};
      const tr = rec?.stream.getAudioTracks()[0];
      return { wall: performance.now(), time: c?.currentTime, state: c?.state,
        posts: clockProbe.posts, samples: rec && (rec.samples?.length ?? rec.chunks.length), sid: rec?.sid,
        track: tr && { state: tr.readyState, muted: tr.muted, enabled: tr.enabled } };
    })()`);
    let failed = 0;
    for (let i = 0; i < iterations; i++) {
      const sid = 1000 + i * 2;
      const cancel = terminal(win.webContents, sid);
      const take = terminal(win.webContents, sid + 1);
      let timeline = [];
      try {
        await js("clockProbe.posts = 0; clockProbe.timeline = []");
        if (mode === "overlay") { start(sid); stop(); }
        else await js(`runtime.start(${sid}); runtime.stop(); undefined`);
        await wait(() => mode === "overlay" ? cancel.events.length > 0 : js(`runtime.cancelled === ${sid}`), "pending stop did not finish");
        if (mode === "overlay" && cancel.events[0].channel !== "record:cancelled") throw new Error("pending stop was not cancelled");
        // Exploratory timing control: let the prior resume completion settle.
        if (mode === "runtime-gap") await sleep(30);
        if (mode === "overlay") start(sid + 1);
        else await js(`runtime.start(${sid + 1}); undefined`);
        const began = performance.now();
        let live = false;
        while (performance.now() - began < 11000) {
          const snap = await snapshot();
          timeline.push(snap);
          if (snap.sid === sid + 1 && snap.samples > 0) {
            live = mode !== "overlay" || await js("Boolean(recording?.startedAt)");
            if (live) break;
          }
          if (take.events.length) break;
          await sleep(100);
        }
        if (!live) throw new Error("take never became live");
        await sleep(1200);
        let samples;
        if (mode === "overlay") {
          stop();
          await wait(() => take.events.length > 0, "take did not finish");
          const result = take.events[0];
          if (result.channel !== "audio:captured") throw new Error(result.payload.message || result.channel);
          samples = wavToFloat32(Buffer.from(result.payload.wav)).samples;
        } else {
          samples = await js("runtime.stop(); runtime.last.samples");
        }
        if (!samples.length || !samples.some(s => Math.abs(s) > 0.001)) throw new Error("empty or silent capture");
        console.log(JSON.stringify({ iter: i, ok: true, samples: samples.length, first: timeline[0], live: timeline.at(-1), lifecycle: await js("clockProbe.timeline") }));
      } catch (error) {
        failed++;
        console.log(JSON.stringify({ iter: i, ok: false, error: error.message, timeline, lifecycle: await js("clockProbe.timeline"), events: take.events.map(e => ({ channel: e.channel, sid: e.payload.sid, message: e.payload.message })) }));
      } finally {
        cancel.close();
        take.close();
        // Explicit cancellation, not a stop waiting on a nonexistent capture.
        if (mode === "overlay") win.webContents.send("record:cancel");
        else await js(`(async () => {
          if (runtime.rec) runtime.stop();
          if (runtime.last?.sid === ${sid + 1} && !runtime.last.samples.length) {
            await runtime.ctx.close();
            runtime.ctx = new AudioContext({ sampleRate: 16000 });
            await runtime.ctx.audioWorklet.addModule("recorder-worklet.js");
            await runtime.ctx.suspend();
          }
        })()`);
      }
    }
    console.log(JSON.stringify({ mode, iterations, failed }));
    app.exit(failed ? 1 : 0);
  } catch (error) {
    console.error(error);
    app.exit(2);
  }
});
