// Overlay renderer: owns the microphone. Records 16 kHz mono PCM via an
// AudioWorklet, encodes WAV on stop, and ships it to the main process.

const SAMPLE_RATE = 16000;

const pill = document.getElementById("pill");
const statusText = document.getElementById("status-text");
const detailText = document.getElementById("detail-text");
const timerEl = document.getElementById("timer");
const meter = document.getElementById("meter");
const meterCtx = meter.getContext("2d");
const transcriptEl = document.getElementById("transcript");
const transcriptCleanEl = document.getElementById("transcript-clean");
const transcriptRawEl = document.getElementById("transcript-raw");

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

function setStatus(status, title, detail) {
  pill.dataset.status = status;
  statusText.textContent = title;
  detailText.textContent = detail || "";
}

function drawMeter() {
  meterCtx.clearRect(0, 0, meter.width, meter.height);
  const barWidth = meter.width / displayLevels.length;
  meterCtx.fillStyle = "#ff5470";
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
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
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

// Live preview: re-encode the audio captured so far and ship it for a fresh
// partial transcript. Skipped once the recording passes the configured cap
// (the offline recognizer re-decodes the whole buffer each tick, so cost grows
// with length) and when there's nothing recorded yet.
function sendPartial() {
  if (!recording || !livePreview) return;
  const cap = livePreview.maxSeconds || 0;
  if (cap > 0 && (Date.now() - recording.startedAt) / 1000 > cap) return;
  if (recording.chunks.length === 0) return;
  const wav = encodeWav(recording.chunks);
  earheart.send("audio:partial", { sid: recording.sid, wav });
}

// Paint the two layers. The prefix-reconcile logic lives in transcript.js so it
// can be unit-tested; here we just apply the result to the DOM. The panel fades
// in and out via the `.visible` opacity transition; `hidden` (which removes it
// from layout, collapsing the window height) is applied only *after* the
// fade-out so the exit animation matches the entrance instead of popping.
let hideTranscriptTimer = null;
function renderTranscript() {
  const { clean, tail, hasText } = reconcileTranscript(partialRaw, partialClean);
  transcriptCleanEl.textContent = clean;
  transcriptRawEl.textContent = tail;
  if (hasText) {
    if (hideTranscriptTimer) {
      clearTimeout(hideTranscriptTimer);
      hideTranscriptTimer = null;
    }
    transcriptEl.hidden = false;
    transcriptEl.classList.add("visible");
    syncOverlayHeight();
  } else if (!transcriptEl.hidden && !hideTranscriptTimer) {
    // Fade out, then collapse the layout once the opacity transition is done.
    transcriptEl.classList.remove("visible");
    hideTranscriptTimer = setTimeout(() => {
      hideTranscriptTimer = null;
      transcriptEl.hidden = true;
      syncOverlayHeight();
    }, 200); // matches the #transcript opacity transition
  }
}

function clearTranscript() {
  partialRaw = "";
  partialClean = "";
  renderTranscript();
}

// Ask the main process to size the window to the rendered content. The overlay
// is frameless and bottom-anchored, so the main process grows it upward.
//
// We report BASE_HEIGHT (the pill) plus the transcript panel's own height when
// it's showing. Measuring the transcript element — not document.body — is
// deliberate: the body is `height:100vh`, so its scrollHeight tracks the current
// window height and could only ever grow, never letting the window shrink back
// when the transcript shrinks or hides. The transcript's growth above the base
// is quantized to whole lines (~19px) so a single non-wrapping word doesn't nudge
// the window every partial; the base itself is reported exactly so the window
// returns to the pill size when the transcript clears. lastReportedHeight resets
// on overlay:show because the main process resets the window to BASE_HEIGHT there.
const BASE_HEIGHT = 80; // pill (56px) + 12px margin top/bottom; matches windows.js
const LINE_STEP = 19; // line-height 1.45 × 13px, one transcript line
let lastReportedHeight = 0;
function syncOverlayHeight() {
  let height = BASE_HEIGHT;
  if (!transcriptEl.hidden) {
    // Outer height of the transcript panel including its top/bottom margin.
    const style = getComputedStyle(transcriptEl);
    const margin = parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    const panel = transcriptEl.offsetHeight + margin;
    height = BASE_HEIGHT + Math.ceil(panel / LINE_STEP) * LINE_STEP;
  }
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
  const wasRecording = await teardown();
  if (wasRecording) {
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
});

// Live partial transcript: `raw` keeps pace with the voice, `cleaned` fills in
// behind it on pauses. The pipeline only sends these while recording; once it
// moves on to the final pass we clear the panel (the pill takes over).
earheart.on("pipeline:partial", ({ kind, text }) => {
  if (kind === "raw") partialRaw = text || "";
  else if (kind === "cleaned") partialClean = text || "";
  renderTranscript();
});

earheart.on("pipeline:status", ({ status, detail }) => {
  // The live preview belongs to the recording phase; the moment the pipeline
  // reports a post-recording status, retire the panel so it doesn't linger
  // alongside the pill's own status/preview.
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
        detail?.note
          ? "Copied to clipboard"
          : detail?.method === "clipboard"
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
  // The main process resets the window to the base pill height on show; mirror
  // that here so the next syncOverlayHeight() always re-reports against it.
  lastReportedHeight = 0;
  pill.classList.add("visible");
});
earheart.on("overlay:hide", () => pill.classList.remove("visible"));

document.getElementById("stop").addEventListener("click", stopRecording);
document.getElementById("cancel").addEventListener("click", cancelRecording);

// Click-and-drag anywhere on the pill (except the buttons) moves the overlay.
// The window itself is moved by the main process from the streamed screen
// coordinates, since a focusable:false frameless window can't be dragged
// natively.
let dragging = false;
pill.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  dragging = true;
  pill.classList.add("dragging");
  pill.setPointerCapture(event.pointerId);
  earheart.send("overlay:drag-start", { x: event.screenX, y: event.screenY });
});

pill.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  earheart.send("overlay:drag", { x: event.screenX, y: event.screenY });
});

function endDrag() {
  dragging = false;
  pill.classList.remove("dragging");
}

pill.addEventListener("pointerup", endDrag);
pill.addEventListener("pointercancel", endDrag);
