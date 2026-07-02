// Overlay renderer: owns the microphone. Records 16 kHz mono PCM via an
// AudioWorklet, encodes WAV on stop, and ships it to the main process.

const SAMPLE_RATE = 16000;

const card = document.getElementById("card");
const statusText = document.getElementById("status-text");
const detailText = document.getElementById("detail-text");
const timerEl = document.getElementById("timer");
const meter = document.getElementById("meter");
const meterCtx = meter.getContext("2d");
const transcriptEl = document.getElementById("transcript");
const transcriptCleanEl = document.getElementById("transcript-clean");
const transcriptRawEl = document.getElementById("transcript-raw");
const progressEl = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");

let recording = null; // { stream, context, chunks, startedAt, timerId, maxTimerId, partialTimerId }
let generation = 0; // bumped on every start/teardown to invalidate stale awaits
let currentSid = null; // session id from the main process
let stopWhenReady = false; // stop arrived while getUserMedia was still pending
let levels = new Array(24).fill(0);

// Live preview state: the latest raw and cleaned partial transcripts. The
// cleaned line is the prominent text; the raw tail is the part of the raw
// transcript past the cleaned prefix (what's been heard but not yet cleaned).
let livePreview = null; // { intervalMs, maxSeconds } when enabled this session
let partialRaw = "";
let partialClean = "";

// The audio worklet posts levels far faster than the screen refreshes, so we
// don't redraw the meter per message. Instead each frame eases the displayed
// bars toward the latest levels on a requestAnimationFrame loop: fewer canvas
// redraws (one per frame, not per audio chunk) and a slower, smoother glide.
let displayLevels = new Array(24).fill(0);
let meterRaf = null;

function meterFrame() {
  let moved = false;
  for (let i = 0; i < levels.length; i++) {
    // Ease ~18% of the remaining distance per frame for a gentle ramp.
    const next = displayLevels[i] + (levels[i] - displayLevels[i]) * 0.18;
    if (Math.abs(next - displayLevels[i]) > 0.0005) moved = true;
    displayLevels[i] = next;
  }
  drawMeter();
  // Keep animating while recording; once levels settle after stop, let it idle.
  if (recording || moved) {
    meterRaf = requestAnimationFrame(meterFrame);
  } else {
    meterRaf = null;
  }
}

function startMeter() {
  if (meterRaf === null) meterRaf = requestAnimationFrame(meterFrame);
}

function stopMeter() {
  if (meterRaf !== null) {
    cancelAnimationFrame(meterRaf);
    meterRaf = null;
  }
}

// How long a completed (fraction >= 1) bar lingers before hiding — long enough
// to see it finish (the 0.15s width transition fits inside), short enough not
// to trail into the next phase's own progress.
const PROGRESS_COMPLETE_HOLD_MS = 400;
let progressHideTimer = null;

// Statuses whose layout reserves the bar's box (see overlay.css), so a
// completed bar mid-hold can ride through them without a collapse. Terminal
// statuses (done/empty/error) are absent on purpose: there the box isn't
// reserved, so the hold must end WITH the status swap — expiring 400ms later
// would shift the final text mid-read (and park an amber bar under a green
// dot).
const PROGRESS_HOLD_STATUSES = new Set(["transcribing", "cleaning", "delivering"]);

function setStatus(status, title, detail) {
  card.dataset.status = status;
  statusText.textContent = title;
  detailText.textContent = detail || "";
  // Every phase change retires the previous phase's bar. It stays hidden until
  // the new phase's first pipeline:progress event, so phases that report no
  // progress (remote engines, near-instant steps) never flash an empty track.
  // Exception: a completed bar mid-hold survives into hold-friendly statuses
  // so the user sees it actually finish; its own timer hides it.
  if (!progressHideTimer || !PROGRESS_HOLD_STATUSES.has(status)) resetProgress();
}

// Cancel a pending completion hold; returns whether one was active (i.e. the
// on-screen width still belongs to the previous, completed phase).
function clearProgressHold() {
  if (!progressHideTimer) return false;
  clearTimeout(progressHideTimer);
  progressHideTimer = null;
  return true;
}

function resetProgress() {
  clearProgressHold();
  progressEl.hidden = true;
  progressFill.style.width = "0";
}

// The meter now flexes to fill the control row, so its rendered width varies with
// the card size and device pixel ratio. Keep the canvas backing store matched to
// its CSS box (× dpr) so the bars stay crisp and un-stretched at any width; a
// ResizeObserver (wired up below) calls this whenever that box changes.
function resizeMeter() {
  const rect = meter.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (meter.width !== w || meter.height !== h) {
    meter.width = w;
    meter.height = h;
    drawMeter(); // repaint into the resized buffer (a resize clears the canvas)
  }
}

function drawMeter() {
  meterCtx.clearRect(0, 0, meter.width, meter.height);
  const barWidth = meter.width / displayLevels.length;
  // A muted rose, not the full #ff5470 accent: the saturated red is reserved for
  // the primary (stop) button so it stays the one thing the eye lands on.
  meterCtx.fillStyle = "rgba(255, 120, 140, 0.5)";
  displayLevels.forEach((level, i) => {
    const h = Math.max(2, Math.min(1, level * 6) * meter.height);
    meterCtx.fillRect(
      i * barWidth + 1,
      (meter.height - h) / 2,
      barWidth - 2,
      h
    );
  });
}

function updateTimer() {
  if (!recording) return;
  const seconds = Math.floor((Date.now() - recording.startedAt) / 1000);
  timerEl.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function encodeWav(chunks) {
  const total = totalSamples(chunks);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

// Total samples recorded so far across all worklet chunks.
function totalSamples(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  return n;
}

// Encode the recorded samples in [from, to) into a WAV. Walks the chunk list,
// skipping samples before `from` and stopping at `to`, so we only ever encode
// the slice the live preview needs — not the whole growing buffer.
function encodeWavRange(chunks, from, to) {
  const flat = new Float32Array(to - from);
  let pos = 0; // absolute sample index at the start of the current chunk
  let out = 0;
  for (const chunk of chunks) {
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + chunk.length);
    if (end > start) {
      flat.set(chunk.subarray(start - pos, end - pos), out);
      out += end - start;
    }
    pos += chunk.length;
    if (pos >= to) break;
  }
  return encodeWav([flat]);
}

// Live preview, append-only and chunked: each tick we ship only the audio of the
// CURRENT in-progress chunk (the samples since the last committed boundary), so
// decode cost stays flat regardless of how long the dictation runs. Once that
// chunk reaches `chunkSeconds`, we send it one last time marked `final` and
// advance the boundary, freezing it into the committed transcript on the main
// side and starting a fresh chunk.
function sendPartial() {
  if (!recording || !livePreview) return;
  const total = totalSamples(recording.chunks);
  const from = recording.committedSamples;
  if (total <= from) return; // nothing new recorded since the last commit

  const chunkSamples = (livePreview.chunkSeconds || 5) * SAMPLE_RATE;
  const liveSamples = total - from;
  const final = liveSamples >= chunkSamples;

  const wav = encodeWavRange(recording.chunks, from, total);
  earheart.send("audio:partial", {
    sid: recording.sid,
    seq: recording.seq,
    final,
    wav,
  });

  if (final) {
    // Freeze this chunk: future ticks send only audio recorded after it.
    recording.committedSamples = total;
    recording.seq += 1;
  }
}

// Paint the two layers. The prefix-reconcile logic lives in transcript.js so it
// can be unit-tested; here we just apply the result to the DOM. Showing/hiding
// the transcript toggles `hidden` (in/out of layout) and the card's
// `data-transcript` flag (which adds the divider above the controls), then resizes
// the window to fit. The whole card fades via its own opacity transition.
function renderTranscript() {
  const { clean, tail, hasText } = reconcileTranscript(partialRaw, partialClean);
  transcriptCleanEl.textContent = clean;
  transcriptRawEl.textContent = tail;
  transcriptEl.hidden = !hasText;
  if (hasText) card.setAttribute("data-transcript", "");
  else card.removeAttribute("data-transcript");
  syncOverlayHeight();
}

function clearTranscript() {
  partialRaw = "";
  partialClean = "";
  renderTranscript();
}

// Ask the main process to size the window to the rendered content. The overlay
// is frameless and bottom-anchored, so the main process grows it upward.
//
// We measure the card's CONTENT via scrollHeight (not offsetHeight, which the
// viewport clamps to the current window height before it has grown, and not
// document.body, whose `height:100vh` pins it to the window). The card has
// `overflow:hidden` for its rounded corners, so its content can exceed the
// window; scrollHeight reports that true desired height. Plus the 12px card
// margins. The window jump is un-eased, but the card's own height eases via CSS
// (see #card transition), so content slides into the new space smoothly.
const CARD_MARGIN = 12; // matches #card margin in overlay.css
let lastReportedHeight = 0;
function syncOverlayHeight() {
  // Measure the card's NATURAL content height: clear any pinned height first so a
  // shrink (e.g. transcript cleared) is measured, not clamped by the old value.
  card.style.height = "";
  const content = card.scrollHeight;
  // Pin it so the CSS height transition has a concrete from/to to ease between
  // (it can't animate `height: auto`); the window resizes instantly around it.
  card.style.height = `${content}px`;
  const height = content + CARD_MARGIN * 2;
  if (height !== lastReportedHeight) {
    lastReportedHeight = height;
    earheart.send("overlay:resize", { height });
  }
}

async function startRecording({ sid, deviceId, maxSeconds, livePreview: live }) {
  // A new session always supersedes whatever was running.
  await teardown();
  const myGeneration = ++generation;
  currentSid = sid;
  stopWhenReady = false;
  livePreview = live && live.enabled ? live : null;
  setStatus("recording", "Listening…");
  clearTranscript();
  levels.fill(0);
  displayLevels.fill(0);
  drawMeter(); // clear to a flat baseline; the rAF loop starts once mic is live
  timerEl.textContent = "0:00";

  let stream = null;
  let context = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    await context.audioWorklet.addModule("recorder-worklet.js");
    if (myGeneration !== generation) {
      // Cancelled while the microphone was being opened: shut it down.
      stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => {});
      return;
    }
    const source = context.createMediaStreamSource(stream);
    const recorder = new AudioWorkletNode(context, "recorder");
    const chunks = [];
    recorder.port.onmessage = (event) => {
      chunks.push(event.data.samples);
      // Just record the level; the rAF meter loop reads `levels` each frame.
      levels.push(event.data.rms);
      levels.shift();
    };
    source.connect(recorder);

    recording = {
      sid,
      stream,
      context,
      chunks,
      startedAt: Date.now(),
      // Append-only live preview: `committedSamples` is the sample offset where
      // the current in-progress chunk starts; everything before it has been
      // frozen into committed chunks and need never be re-sent. `seq` counts
      // committed chunks so the main process can tell a growing in-progress chunk
      // from the start of a new one.
      committedSamples: 0,
      seq: 0,
      timerId: setInterval(updateTimer, 250),
      maxTimerId: setTimeout(
        () => stopRecording(),
        (maxSeconds || 300) * 1000
      ),
      partialTimerId: livePreview
        ? setInterval(sendPartial, livePreview.intervalMs || 1200)
        : null,
    };
    startMeter(); // rAF loop runs for the whole session (recording is now set)
    if (stopWhenReady) {
      stopWhenReady = false;
      stopRecording();
    }
  } catch (err) {
    stream?.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => {});
    if (myGeneration === generation) {
      earheart.send("record:error", {
        sid,
        message: `Microphone unavailable: ${err.message}`,
      });
    }
  }
}

async function teardown() {
  generation++; // invalidates any startRecording still awaiting the mic
  stopWhenReady = false;
  stopMeter();
  if (!recording) return null;
  const rec = recording;
  recording = null;
  clearInterval(rec.timerId);
  clearTimeout(rec.maxTimerId);
  if (rec.partialTimerId) clearInterval(rec.partialTimerId);
  rec.stream.getTracks().forEach((track) => track.stop());
  await rec.context.close().catch(() => {});
  return rec;
}

async function stopRecording() {
  if (!recording) {
    // Stop raced ahead of microphone setup; finish once the mic is live.
    stopWhenReady = true;
    return;
  }
  const rec = await teardown();
  if (!rec) return;
  const wav = encodeWav(rec.chunks);
  earheart.send("audio:captured", { sid: rec.sid, wav });
}

async function cancelRecording() {
  const sid = currentSid;
  const rec = await teardown();
  if (rec) {
    earheart.send("record:cancelled", { sid });
  } else {
    earheart.send("pipeline:cancel");
  }
}

earheart.on("record:start", startRecording);
earheart.on("record:stop", stopRecording);
earheart.on("record:cancel", () => {
  teardown();
  clearTranscript();
  resetProgress();
});

// Live partial transcript: `raw` keeps pace with the voice, `cleaned` fills in
// behind it on pauses. The pipeline only sends these while recording; once it
// moves on to the final pass we clear the transcript (the control row's status
// takes over).
earheart.on("pipeline:partial", ({ kind, text }) => {
  if (kind === "raw") partialRaw = text || "";
  else if (kind === "cleaned") partialClean = text || "";
  renderTranscript();
});

// Determinate progress within the current processing phase. The phase guard
// drops stale/out-of-order events (e.g. a late "transcribing" tick arriving
// after the status already moved on to "cleaning").
earheart.on("pipeline:progress", ({ phase, fraction }) => {
  if (card.dataset.status !== phase) return;
  const supersedesHold = clearProgressHold();
  const pct = Math.max(0, Math.min(100, (fraction || 0) * 100));
  progressEl.hidden = false;
  if (supersedesHold) {
    // The 100% on screen belongs to the PREVIOUS phase's hold; easing down
    // from it would read as the bar draining backwards. Snap, then let the
    // transition resume for this phase's own updates.
    progressFill.style.transition = "none";
    progressFill.style.width = `${pct.toFixed(1)}%`;
    void progressFill.offsetWidth; // flush the un-animated width
    progressFill.style.transition = "";
  } else {
    progressFill.style.width = `${pct.toFixed(1)}%`;
  }
  // A completed bar holds at 100% briefly, then hides itself — the phase's
  // closing statement rather than a cut-off.
  if (fraction >= 1) {
    progressHideTimer = setTimeout(resetProgress, PROGRESS_COMPLETE_HOLD_MS);
  }
});

earheart.on("pipeline:status", ({ status, detail }) => {
  // The live preview belongs to the recording phase; the moment the pipeline
  // reports a post-recording status, retire the transcript so it doesn't linger
  // alongside the control row's own status/preview.
  clearTranscript();
  switch (status) {
    case "transcribing":
      setStatus("transcribing", "Transcribing…");
      break;
    case "cleaning":
      setStatus("cleaning", "Cleaning up…");
      break;
    case "delivering":
      setStatus("delivering", "Typing…");
      break;
    case "done":
      setStatus(
        "done",
        detail?.note || detail?.method === "clipboard"
          ? "Copied to clipboard"
          : detail?.method === "paste-copy"
            ? "Pasted & copied"
            : "Pasted",
        detail?.note || detail?.preview
      );
      break;
    case "empty":
      setStatus("empty", "Nothing heard", "Try again closer to the mic");
      break;
    case "error":
      setStatus("error", "Failed", detail?.message);
      break;
  }
});

earheart.on("overlay:show", () => {
  // The main process resets the window to the base card height on show; mirror
  // that here so the next syncOverlayHeight() always re-reports against it.
  lastReportedHeight = 0;
  card.classList.add("visible");
});
earheart.on("overlay:hide", () => card.classList.remove("visible"));

// Keep the waveform canvas's backing store matched to its flexed CSS box. The
// observer fires once on observe() (sizing the canvas before the first draw) and
// again on any later change (window/DPR/layout), so the bars are always crisp.
new ResizeObserver(resizeMeter).observe(meter);

document.getElementById("stop").addEventListener("click", stopRecording);
document.getElementById("cancel").addEventListener("click", cancelRecording);

// Click-and-drag anywhere on the card (except the buttons) moves the overlay.
// The window itself is moved by the main process from the streamed screen
// coordinates, since a focusable:false frameless window can't be dragged
// natively.
let dragging = false;
card.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  dragging = true;
  card.classList.add("dragging");
  card.setPointerCapture(event.pointerId);
  earheart.send("overlay:drag-start", { x: event.screenX, y: event.screenY });
});

// Coalesce the drag stream to one send per animation frame. pointermove can fire
// far faster than a transparent, always-on-top window can be repositioned, and an
// unbatched send-per-event floods the IPC channel so the window trails a stale
// backlog (the "lags behind" feel). We keep only the freshest coordinate and send
// it once per frame; this is lossless because the main process positions from a
// recorded origin (see windows.js), not from accumulated deltas, so dropping the
// intermediate points never desyncs the card from the cursor.
let pendingDrag = null;
let dragRaf = null;
function flushDrag() {
  dragRaf = null;
  if (pendingDrag) {
    earheart.send("overlay:drag", pendingDrag);
    pendingDrag = null;
  }
}

card.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  pendingDrag = { x: event.screenX, y: event.screenY };
  if (dragRaf === null) dragRaf = requestAnimationFrame(flushDrag);
});

function endDrag() {
  // pointercancel can trail pointerup; only the first end of a real drag counts.
  if (!dragging) return;
  dragging = false;
  card.classList.remove("dragging");
  // Send the final position immediately so the card settles exactly under the
  // release point even if a frame was still pending.
  if (dragRaf !== null) {
    cancelAnimationFrame(dragRaf);
    flushDrag();
  }
  // Tell the main process the drag is over so it persists the resting spot.
  earheart.send("overlay:drag-end");
}

card.addEventListener("pointerup", endDrag);
card.addEventListener("pointercancel", endDrag);
