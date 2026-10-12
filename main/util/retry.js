// Retrying a dictation stage (transcribe, clean up) that failed for a reason
// that can pass. Falling back — raw transcript for a failed cleanup, the
// recovered words for a failed decode — keeps the user's words (golden rule 8),
// but it drops the value they asked for; a crashed worker, a timeout or a
// service that blinked deserves another go first.
//
// Only failures a fresh attempt can fix are retried:
//   - an engine worker that died or wedged (ENGINE_EXITED / ENGINE_TIMEOUT —
//     engines/host.js re-forks on the next request),
//   - a remote service that was unreachable, timed out, dropped the connection
//     or sent garbage (services/transport-error.js), or answered 408, 429 or
//     5xx.
// Everything else would just repeat: a 401/404 is the settings, a missing
// model is the download, and an empty or runaway cleanup reply comes from a
// model that samples greedily by default (cleanup-styles.js "clean" runs at
// temperature 0), so the same input yields the same reply.
//
// A timeout already cost the user its whole deadline, so it gets one retry,
// not two.

const MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_AFTER_TIMEOUT = 2;
// Pause before retry n (1-based). Long enough for a service to come back from a
// blip; short enough not to matter next to a model reload.
const RETRY_DELAYS_MS = [250, 1000];

const PASSING_CODES = new Set([
  "ENGINE_EXITED",
  "SERVICE_UNREACHABLE",
  "SERVICE_DROPPED",
  "SERVICE_BAD_REPLY",
]);
const TIMEOUT_CODES = new Set(["ENGINE_TIMEOUT", "SERVICE_TIMEOUT"]);

/**
 * How many attempts in total a stage that failed with `err` may have.
 * 1 means don't retry.
 * @param {any} err
 * @returns {number}
 */
function attemptsFor(err) {
  if (TIMEOUT_CODES.has(err?.code)) return MAX_ATTEMPTS_AFTER_TIMEOUT;
  if (PASSING_CODES.has(err?.code)) return MAX_ATTEMPTS;
  const status = err?.status;
  if (status === 408 || status === 429 || status >= 500) return MAX_ATTEMPTS;
  return 1;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` until it succeeds, the failure isn't worth retrying, the
 * budget runs out, or the dictation goes stale (cancelled or superseded). The
 * last error is rethrown, so the caller's fallback works exactly as before.
 *
 * @template T
 * @param {(n: number) => Promise<T>} attempt called with the 1-based attempt number
 * @param {object} [opts]
 * @param {() => boolean} [opts.stale] true once nobody wants the result
 * @param {(info: {attempt: number, of: number, err: any}) => void} [opts.onRetry]
 *   called before attempt `attempt` (2, 3, …) of at most `of`
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<T>}
 */
async function withRetry(attempt, { stale = () => false, onRetry, sleep = realSleep } = {}) {
  // The budget only ever shrinks: a timeout's smaller one holds even when a
  // later try fails some other way, so "try 2 of 2" is never followed by a
  // third.
  let of = MAX_ATTEMPTS;
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      of = Math.min(of, attemptsFor(err));
      if (n >= of || stale()) throw err;
      await sleep(RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length) - 1]);
      if (stale()) throw err;
      onRetry?.({ attempt: n + 1, of, err });
    }
  }
}

module.exports = { withRetry, attemptsFor, MAX_ATTEMPTS, RETRY_DELAYS_MS };
