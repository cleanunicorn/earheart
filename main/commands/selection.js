// Read the text selected in another app (#344) by sending it a copy.
//
// The user's clipboard is borrowed, never taken: it is snapshotted first and
// put back on EVERY path out (success, empty selection, timeout, cancel, a
// failing keystroke tool), but only while it still holds what this capture put
// there. If another app copied something meanwhile, that copy is the user's
// newer intent and stays.
//
// A sentinel is written before the copy so "the selection is the same text as
// what was on the clipboard" and "nothing was copied" can be told apart: the
// capture succeeded only if the clipboard changed away from the sentinel.
//
// The hotkey's own modifiers may still be down when this runs, which would turn
// Ctrl+C into Ctrl+Alt+C or similar; it waits for them to come up first, and
// reports "modifiers-held" rather than guessing if they never do.
//
// Failures carry a `reason` the session turns into copy for the user:
//   unavailable | secure | modifiers-held | timeout | empty | too-long | cancelled
// A secure-field check exists on macOS only; elsewhere an unreadable password
// field shows up as "empty" at best. See docs/commands.md.

const crypto = require("node:crypto");
const { MAX_SELECTION_CHARS } = require("../util/transform-turn");

const POLL_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} deps
 * @param {{readText(): string, writeText(t: string): void, clear(): void}} deps.clipboard
 * @param {() => object|null} deps.snapshot   deliver.snapshotClipboard
 * @param {(snap: object) => void} deps.restore deliver.restoreSnapshot
 * @param {ReturnType<import("./platform").createPlatform>} deps.platform
 * @param {number} [deps.copyTimeoutMs]
 */
function createSelectionCapture({ clipboard, snapshot, restore, platform, copyTimeoutMs = 700, modifierWaitMs }) {
  const sentinel = () => `​​earheart-capture-${crypto.randomBytes(8).toString("hex")}`;
  let pending = Promise.resolve();

  // Cancellation can leave Copy or a polling tick in flight. Serialize the
  // entire clipboard loan, including restoration, so a restarted command
  // never snapshots the preceding capture's sentinel. Recording is independent
  // of this queue and still starts immediately.
  function capture(signal) {
    const result = pending.then(() => captureOnce(signal));
    pending = result.catch(() => {});
    return result;
  }

  // Put the user's clipboard back, but only if it still holds one of our own
  // values. Never throws: a failed restore must not hide the capture result.
  function restoreIfOurs(snap, ours) {
    try {
      const current = clipboard.readText();
      if (!ours.includes(current)) return;
      if (snap) restore(snap);
      else clipboard.clear();
    } catch {
      // Best effort; the clipboard is a courtesy, not the result.
    }
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string, message: string}>}
   */
  async function captureOnce(signal) {
    const fail = (reason, message) => ({ ok: false, reason, message });
    if (signal?.aborted) return fail("cancelled", "Cancelled");
    const support = platform.captureSupport();
    if (!support.ok) return fail("unavailable", support.reason);

    const snap = snapshot();
    const marker = sentinel();
    const ours = [marker];
    try {
      if (await platform.secureInputActive(signal)) {
        return fail("secure", "A secure field has the keyboard, so Earheart won't read the selection");
      }
      if (!(await platform.waitForModifiersReleased(modifierWaitMs, signal))) {
        return fail("modifiers-held", "Release the hotkey's keys and try again");
      }
      if (signal?.aborted) return fail("cancelled", "Cancelled");
      clipboard.writeText(marker);
      try {
        await platform.sendCopy(signal);
      } catch (err) {
        if (signal?.aborted || err.aborted) return fail("cancelled", "Cancelled");
        if (err.killed) return fail("timeout", "The app didn't answer the copy in time");
        return fail("unavailable", "Couldn't copy the selection from this app");
      }
      const deadline = Date.now() + copyTimeoutMs;
      let text = marker;
      while (Date.now() < deadline) {
        if (signal?.aborted) return fail("cancelled", "Cancelled");
        text = clipboard.readText();
        if (text !== marker) break;
        await sleep(POLL_MS);
      }
      if (text === marker) return fail("empty", "Nothing is selected, or the app doesn't allow copying it");
      ours.push(text);
      if (text.trim() === "") return fail("empty", "Nothing is selected");
      if (text.length > MAX_SELECTION_CHARS) {
        return fail("too-long", `The selection is longer than ${MAX_SELECTION_CHARS.toLocaleString("en-US")} characters`);
      }
      return { ok: true, text };
    } finally {
      restoreIfOurs(snap, ours);
    }
  }

  return { capture };
}

module.exports = { createSelectionCapture };
