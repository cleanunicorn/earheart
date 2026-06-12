// Overlay renderer: owns the microphone. Records 16 kHz mono PCM via an
// AudioWorklet, encodes WAV on stop, and ships it to the main process.

const SAMPLE_RATE = 16000;

const pill = document.getElementById("pill");
const statusText = document.getElementById("status-text");
const detailText = document.getElementById("detail-text");
const timerEl = document.getElementById("timer");
const meter = document.getElementById("meter");
const meterCtx = meter.getContext("2d");

let recording = null; // { stream, context, chunks, startedAt, timerId, maxTimerId }
let generation = 0; // bumped on every start/teardown to invalidate stale awaits
let currentSid = null; // session id from the main process
let stopWhenReady = false; // stop arrived while getUserMedia was still pending
let levels = new Array(24).fill(0);

function setStatus(status, title, detail) {
  pill.dataset.status = status;
  statusText.textContent = title;
  detailText.textContent = detail || "";
}

function drawMeter() {
  meterCtx.clearRect(0, 0, meter.width, meter.height);
  const barWidth = meter.width / levels.length;
  meterCtx.fillStyle = "#ff5470";
  levels.forEach((level, i) => {
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

async function startRecording({ sid, deviceId, maxSeconds }) {
  // A new session always supersedes whatever was running.
  await teardown();
  const myGeneration = ++generation;
  currentSid = sid;
  stopWhenReady = false;
  setStatus("recording", "Listening…");
  levels.fill(0);
  drawMeter();
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
      levels.push(event.data.rms);
      levels.shift();
      drawMeter();
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
    };
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
  if (!recording) return null;
  const rec = recording;
  recording = null;
  clearInterval(rec.timerId);
  clearTimeout(rec.maxTimerId);
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
earheart.on("record:cancel", () => teardown());

earheart.on("pipeline:status", ({ status, detail }) => {
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

earheart.on("overlay:show", () => pill.classList.add("visible"));
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
