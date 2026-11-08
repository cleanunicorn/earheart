// Double-tap activation for the record hotkey (opt-in; Settings → General).
//
// Electron's globalShortcut reports key-down only: no key-up, and a held key
// repeats the same callback. So the recognizer works on press timestamps
// alone, with two guards against a held key:
//
//   - Presses closer than REPEAT_MS are auto-repeat, never a deliberate tap.
//   - After the second press, SETTLE_MS must pass without another press. A
//     held key's repeats keep arriving, so the sequence is dropped and the
//     key is ignored until it has been quiet for QUIET_MS.
//
// A valid double tap therefore starts SETTLE_MS (~120 ms) after the second
// press. A single press while a dictation is live stops it at once, with no
// delay — except right after a latch (STOP_GUARD_MS), where it is the tail of
// the double tap, e.g. a second tap that is still held down. A single tap
// while idle does nothing.

const REPEAT_MS = 100;
const SETTLE_MS = 120;
const QUIET_MS = 300;
const STOP_GUARD_MS = 700;

const DEFAULT_WINDOW_MS = 500;
const MIN_WINDOW_MS = 250;
const MAX_WINDOW_MS = 1000;

/**
 * @param {{getState: () => string, start: () => void, stop: () => void,
 *   windowMs?: () => number, now?: () => number,
 *   setTimer?: Function, clearTimer?: Function}} deps
 */
function createDoubleTap({
  getState,
  start,
  stop,
  windowMs = () => DEFAULT_WINDOW_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let firstAt = null; // time of an unpaired first tap
  let lastAt = null; // time of the previous press of any kind
  let latchedAt = null;
  let settle = null;
  let quiet = null;
  let disposed = false;

  function clearTimers() {
    if (settle) clearTimer(settle);
    if (quiet) clearTimer(quiet);
    settle = quiet = null;
  }

  function reset() {
    clearTimers();
    firstAt = null;
  }

  function holdOff() {
    // A held key: forget the sequence and ignore it until it goes quiet.
    if (settle) clearTimer(settle);
    settle = null;
    firstAt = null;
    if (quiet) clearTimer(quiet);
    quiet = setTimer(() => {
      quiet = null;
    }, QUIET_MS);
  }

  function press() {
    if (disposed) return;
    const t = now();
    const gap = lastAt === null ? Infinity : t - lastAt;
    lastAt = t;

    if (getState() !== "idle") {
      reset();
      if (gap < REPEAT_MS) return;
      if (latchedAt !== null && t - latchedAt < STOP_GUARD_MS) return;
      stop();
      return;
    }
    if (settle) return holdOff(); // another press inside the settle check
    if (quiet) return holdOff(); // still held: restart the quiet period
    if (gap < REPEAT_MS) return; // auto-repeat of the press we already counted

    if (firstAt !== null && t - firstAt <= windowMs()) {
      firstAt = null;
      settle = setTimer(() => {
        settle = null;
        // The world may have moved on (discard, pause, tray, --toggle).
        if (disposed || getState() !== "idle") return;
        start();
        latchedAt = now();
      }, SETTLE_MS);
      return;
    }
    firstAt = t;
  }

  return {
    press,
    // Call on any pipeline state change or settings change.
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}

module.exports = {
  createDoubleTap,
  REPEAT_MS,
  SETTLE_MS,
  QUIET_MS,
  STOP_GUARD_MS,
  DEFAULT_WINDOW_MS,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
};
