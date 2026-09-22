// Built-in STT decoding in pieces: a recording reaches the worker one stretch
// of speech at a time — cut at every pause, and never more than
// MAX_DECODE_SECONDS at once (see util/split-silence.js) — decoded one after
// another and joined in order.
//
// Why: one decode over several utterances is unsafe twice over. The shipped
// Parakeet int8 model drops whole sentences when two of them share a decode,
// so a long buffer silently loses a growing share of the words (#168); and
// under Electron's utilityProcess the worker exits outright on a single
// buffer of ~3 minutes (#169). Measurements: docs/long-recordings.md. Both the final transcription and the live preview's chunk decodes
// (whose committed text is reused verbatim in the final transcript) go
// through here.
//
// Why the pieces are driven from here rather than inside the worker: a piece
// that finished is text in this process, so it survives the worker dying on a
// later one. A piece whose worker died or went silent is retried once on a
// fresh worker; one that still fails is skipped and the rest carry on, so the
// user gets every word that could be decoded — marked `partial` — rather than
// an error (golden rule 8: never lose the user's words).
//
// Dependency-injected like live-preview.js, so it runs without Electron: the
// pipeline passes the real route.transcribe, and scripts/eval-long-decode.js a
// bare worker host.

const { splitPoints } = require("./util/split-silence");
const { joinText } = require("./util/join-text");
// The overlay loads renderer/speech-probe.js as a plain <script>
// (renderer/overlay.html); its CommonJS export guard lets the main process
// apply the same speech verdict.
const { containsSpeech } = require("../renderer/speech-probe");
const { encodeWav, wavSlice, wavToFloat32, wavSampleFrames, SAMPLE_RATE } = require("./util/wav");

// Longest audio one worker decode may receive when the speech has no pause to
// cut at. Pauses do the real work; this is the backstop — a cap alone, even at
// 20 s, still loses words ("Why pauses, not just a shorter buffer" in
// docs/long-recordings.md). Also well clear of the ~3-minute single buffer
// that kills the worker (#169).
const MAX_DECODE_SECONDS = 20;

// After this many pieces in a row failed even their retry, the worker is not
// coming back for this recording: stop paying a model reload per piece.
const MAX_CONSECUTIVE_FAILURES = 2;

// The worker itself died or wedged — worth one more try on a fresh process.
// Anything else is an error the worker replied with, and would just repeat.
// Takes the caught error or a failed piece, which keeps that error's code.
function retryable(failure) {
  return failure?.code === "ENGINE_EXITED" || failure?.code === "ENGINE_TIMEOUT";
}

// [from, to) frame ranges covering the whole WAV — one per stretch of speech
// between pauses, each at most maxSec — and the samples they index.
function planPieces(wav, maxSec, minPauseSec) {
  const frames = wavSampleFrames(wav);
  if (!frames) return { ranges: [[0, 0]], samples: new Float32Array(0) };
  const { samples, sampleRate } = wavToFloat32(wav);
  const edges = [0, ...splitPoints(samples, sampleRate, { maxSec, minPauseSec }), frames];
  return { ranges: edges.slice(1).map((to, i) => [edges[i], to]), samples };
}

// Silence put around a piece that heard speech but decoded to nothing, for
// its one second try: a fragment cut out mid-flow can come back once it has
// room to start and stop. Measured (docs/long-recordings.md) it rescued the
// words the lab lost that way; what stayed empty was a breath or click after
// a finished sentence, which the speech probe — biased toward "speech" on
// purpose — also calls speech.
const EMPTY_RETRY_PAD_SEC = 0.25;

// Up to EMPTY_RETRY_PAD_SEC a side, but never past maxSec in total: the
// padded retry is a worker input like any other. Null when there is no room —
// then the retry would be the same audio, and decode the same.
function padded(samples, fromFrame, toFrame, maxSec) {
  const room = Math.floor((maxSec * SAMPLE_RATE - (toFrame - fromFrame)) / 2);
  const pad = Math.min(Math.round(EMPTY_RETRY_PAD_SEC * SAMPLE_RATE), room);
  if (pad <= 0) return null;
  const pcm = new Int16Array(toFrame - fromFrame + 2 * pad);
  for (let i = fromFrame; i < toFrame; i++) {
    pcm[pad + i - fromFrame] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768)));
  }
  return encodeWav(pcm, SAMPLE_RATE);
}

function emptySpeechError() {
  return Object.assign(new Error("speech decoded to no text"), { code: "EMPTY_SPEECH" });
}

/**
 * Decode `wav` one stretch of speech at a time.
 *
 * `prefixText` is trusted committed live-preview text that precedes `wav`
 * (always kept, even if every piece fails). `salvageChunks` are a broken
 * snapshot's committed chunks ({from, to, text}, in `wav` frames): a range the
 * decode fails is filled with the chunks lying wholly inside it — never one
 * that overlaps a decoded piece, which would repeat its words. `salvageText`
 * is that snapshot's whole text, the last resort when nothing else came back.
 *
 * Throws only when nothing at all was recovered, so a model that isn't
 * installed still surfaces as an error rather than as an empty dictation.
 *
 * @param {Buffer} wav mono PCM16
 * @param {object} deps
 * @param {(wav: Buffer, opts: {onDecodeMs?: (ms: number) => void}) => Promise<string>} deps.runTranscribe
 * @param {() => void} [deps.restartStt] retire a wedged worker before retrying
 * @param {number} [deps.maxSec]
 * @param {number} [deps.minPauseSec] shortest pause cut at (Infinity: none)
 * @param {string} [deps.prefixText]
 * @param {{from: number, to: number, text: string}[]} [deps.salvageChunks]
 * @param {string} [deps.salvageText]
 * @param {() => boolean} [deps.stale] true once the session was cancelled
 * @param {(ms: number) => void} [deps.onDecodeMs] each piece's worker decode time
 * @param {{warn: Function}} [deps.log]
 * @returns {Promise<{text: string, partial: boolean, stale?: boolean, pieces: object[]}>}
 */
// The decoded pieces' text in recording order, each gap filled with the
// salvage chunks that lie wholly inside it. A gap is a failed piece, or an
// unconfirmed one (speech heard, nothing decoded even padded): if the live
// preview had words there, they are the user's. Filling an unconfirmed gap
// doesn't make the result partial — those words are delivered.
function assemble(pieces, salvageChunks) {
  let text = "";
  let failedFrom = null;
  const fill = (to) => {
    if (failedFrom === null) return;
    for (const c of salvageChunks) {
      if (c.from >= failedFrom && c.to <= to) text = joinText(text, c.text);
    }
    failedFrom = null;
  };
  for (const p of pieces) {
    if (!p.ok || p.unconfirmed) {
      if (failedFrom === null) failedFrom = p.fromFrame;
      continue;
    }
    fill(p.fromFrame);
    text = joinText(text, p.text);
  }
  fill(pieces.at(-1).toFrame);
  return text;
}

async function transcribeChunked(
  wav,
  {
    runTranscribe,
    restartStt = () => {},
    maxSec = MAX_DECODE_SECONDS,
    minPauseSec,
    prefixText = "",
    salvageChunks = [],
    salvageText = "",
    stale = () => false,
    onDecodeMs,
    log,
  }
) {
  const plan = planPieces(wav, maxSec, minPauseSec);
  const pieces = plan.ranges.map(([fromFrame, toFrame]) => ({
    fromFrame,
    toFrame,
    ok: false,
    attempts: 0,
  }));
  let firstError = null;
  let consecutiveFailures = 0;

  for (const piece of pieces) {
    if (stale()) return { text: "", partial: false, stale: true, pieces };
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      piece.skipped = true;
      continue;
    }
    const pieceWav =
      pieces.length === 1 ? wav : wavSlice(wav, piece.fromFrame, piece.toFrame);
    for (;;) {
      piece.attempts++;
      try {
        let text = ((await runTranscribe(pieceWav, { onDecodeMs })) || "").trim();
        if (!text && containsSpeech(plan.samples.subarray(piece.fromFrame, piece.toFrame), SAMPLE_RATE)) {
          // Speech in, nothing out: one more try with room around it. Still
          // empty is accepted (see EMPTY_RETRY_PAD_SEC) but marked, and it
          // counts as lost once nothing else in the recording decoded either.
          const paddedWav = padded(plan.samples, piece.fromFrame, piece.toFrame, maxSec);
          if (paddedWav) {
            piece.attempts++;
            text = ((await runTranscribe(paddedWav, { onDecodeMs })) || "").trim();
          }
          if (!text) piece.unconfirmed = true;
        }
        piece.ok = true;
        piece.text = text;
        break;
      } catch (err) {
        if (stale()) return { text: "", partial: false, stale: true, pieces };
        const fromSec = (piece.fromFrame / SAMPLE_RATE).toFixed(1);
        const toSec = (piece.toFrame / SAMPLE_RATE).toFixed(1);
        log?.warn(
          `STT decode: piece ${fromSec}-${toSec}s attempt ${piece.attempts} failed:`,
          err?.message,
          err?.code ? `(${err.code}${err.exitCode !== undefined ? `, exit code ${err.exitCode}` : ""})` : ""
        );
        // A timed-out worker is still stuck in the native decode: retire it
        // every time, or the retry — and on a last attempt, the next piece or
        // dictation — queues behind it. An exited one is already gone (the
        // host re-forks on the next request).
        if (err?.code === "ENGINE_TIMEOUT") restartStt();
        if (piece.attempts < 2 && retryable(err)) continue;
        piece.error = err?.message || String(err);
        piece.code = err?.code;
        piece.exitCode = err?.exitCode;
        firstError = firstError || err;
        break;
      }
    }
    // Only a worker that keeps dying stops the run.
    consecutiveFailures = piece.ok || !retryable(piece) ? 0 : consecutiveFailures + 1;
  }

  let decoded = assemble(pieces, salvageChunks);
  if (!decoded && pieces.some((p) => p.unconfirmed)) {
    // Speech heard and no text anywhere: that is not an empty dictation.
    for (const p of pieces.filter((q) => q.unconfirmed)) {
      Object.assign(p, { ok: false, code: "EMPTY_SPEECH", error: "speech decoded to no text" });
    }
    firstError = firstError || emptySpeechError();
    decoded = assemble(pieces, salvageChunks);
  }
  const partial = pieces.some((p) => !p.ok);
  const recovered = partial && !decoded ? salvageText : decoded;
  const text = joinText(prefixText, recovered);
  if (partial && !text) throw firstError;
  return { text, partial, pieces };
}

module.exports = { transcribeChunked, MAX_DECODE_SECONDS };
