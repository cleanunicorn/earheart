// The final transcription's built-in decode, bounded: a recording longer than
// MAX_DECODE_SECONDS reaches the STT worker as a sequence of pieces, each cut
// at a quiet moment (see util/split-silence.js), decoded one after another and
// joined in order.
//
// Why bounded: one decode over a long buffer is unsafe twice over. The shipped
// Parakeet model silently drops a growing share of the words (word ratio 0.839
// at 124.5 s, 0.449 at 310.9 s — #168), and under Electron's utilityProcess
// the worker exits outright on a single buffer of ~3 minutes (#169). The live
// preview's committed chunks normally cover all but the last few seconds, but
// a broken snapshot (a chunk failed, or heard speech and decoded nothing) or
// no committed chunk at all still hands the whole recording to this decode.
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
const { wavSlice, wavToFloat32, wavSampleFrames, SAMPLE_RATE } = require("./util/wav");

// Longest audio one worker decode may receive. Evidence (#168, default model,
// one decode): 69 s kept a 0.988 word ratio at 4.9% WER, 124.5 s already
// dropped to 0.839. 60 s stays under the known-good point with margin while
// keeping a 5-minute dictation to ~5 decodes. Measured through this code by
// scripts/eval-long-decode.js — see docs/long-recordings.md.
const MAX_DECODE_SECONDS = 60;

// After this many pieces in a row failed even their retry, the worker is not
// coming back for this recording: stop paying a model reload per piece.
const MAX_CONSECUTIVE_FAILURES = 2;

// Join transcript fragments with a space; either side may be empty. Mirrors
// the live preview's own joinText.
function joinRaw(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return `${a} ${b}`;
}

// The worker itself died or wedged — worth one more try on a fresh process.
// Anything else is an error the worker replied with, and would just repeat.
function retryable(err) {
  return err?.code === "ENGINE_EXITED" || err?.code === "ENGINE_TIMEOUT";
}

// [from, to) frame ranges covering the whole WAV, each at most maxSec. A
// recording under the cap is one range and is never decoded here.
function planPieces(wav, maxSec) {
  const frames = wavSampleFrames(wav);
  if (frames <= maxSec * SAMPLE_RATE) return [[0, frames]];
  const { samples, sampleRate } = wavToFloat32(wav);
  const edges = [0, ...splitPoints(samples, sampleRate, { maxSec }), frames];
  return edges.slice(1).map((to, i) => [edges[i], to]);
}

/**
 * Decode `wav` in bounded pieces.
 *
 * `prefixText` is trusted committed live-preview text that precedes `wav`
 * (always kept, even if every piece fails). `salvageText` is a broken
 * snapshot's committed text: it has holes, so it is used only when no piece
 * produced any words — mixing it with decoded pieces would repeat them.
 *
 * Throws only when nothing at all was recovered, so a model that isn't
 * installed still surfaces as an error rather than as an empty dictation.
 *
 * @param {Buffer} wav mono PCM16
 * @param {object} deps
 * @param {(wav: Buffer, opts: {onDecodeMs?: (ms: number) => void}) => Promise<string>} deps.runTranscribe
 * @param {() => void} [deps.restartStt] retire a wedged worker before retrying
 * @param {number} [deps.maxSec]
 * @param {string} [deps.prefixText]
 * @param {string} [deps.salvageText]
 * @param {() => boolean} [deps.stale] true once the session was cancelled
 * @param {(ms: number) => void} [deps.onDecodeMs] each piece's worker decode time
 * @param {{warn: Function}} [deps.log]
 * @returns {Promise<{text: string, partial: boolean, stale?: boolean, pieces: object[]}>}
 */
async function transcribeChunked(
  wav,
  {
    runTranscribe,
    restartStt = () => {},
    maxSec = MAX_DECODE_SECONDS,
    prefixText = "",
    salvageText = "",
    stale = () => false,
    onDecodeMs,
    log,
  }
) {
  const pieces = planPieces(wav, maxSec).map(([fromFrame, toFrame]) => ({
    fromFrame,
    toFrame,
    ok: false,
    attempts: 0,
  }));
  let decoded = "";
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
        const text = await runTranscribe(pieceWav, { onDecodeMs });
        piece.ok = true;
        decoded = joinRaw(decoded, (text || "").trim());
        break;
      } catch (err) {
        if (stale()) return { text: "", partial: false, stale: true, pieces };
        const fromSec = (piece.fromFrame / SAMPLE_RATE).toFixed(1);
        const toSec = (piece.toFrame / SAMPLE_RATE).toFixed(1);
        log?.warn(
          `final decode: piece ${fromSec}-${toSec}s attempt ${piece.attempts} failed:`,
          err?.message,
          err?.code ? `(${err.code}${err.exitCode !== undefined ? `, exit code ${err.exitCode}` : ""})` : ""
        );
        if (piece.attempts < 2 && retryable(err)) {
          // An exited worker is already gone (the host re-forks on the next
          // request); a timed-out one is still stuck in the native decode.
          if (err.code === "ENGINE_TIMEOUT") restartStt();
          continue;
        }
        piece.error = err?.message || String(err);
        piece.code = err?.code;
        piece.exitCode = err?.exitCode;
        firstError = firstError || err;
        break;
      }
    }
    consecutiveFailures = piece.ok ? 0 : consecutiveFailures + 1;
  }

  const partial = pieces.some((p) => !p.ok);
  const recovered = partial && !decoded ? salvageText : decoded;
  const text = joinRaw(prefixText, recovered);
  if (partial && !text) throw firstError;
  return { text, partial, pieces };
}

module.exports = { transcribeChunked, joinRaw, MAX_DECODE_SECONDS };
