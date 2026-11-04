// Retained dictation audio (#343) as the app uses it: the one audio store
// under userData, when a dictation's recording is kept, the limits that prune
// it, export to a file the user picks, and retranscription of a kept
// recording. The storage format, encryption and failure rules live in
// main/audio-store.js; this file is the policy around them.
//
// A recording is kept only when all of these hold: the user turned on
// Settings → History → Keep recordings (`recordings.keep`, off by default),
// History is on (a recording is kept as its History entry's audio, by the
// entry id from main/history.js), and the OS offers real secure storage (the
// store refuses otherwise). With retention off nothing here writes to disk.

const electron = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createAudioStore } = require("./audio-store");
const history = require("./history");
const logger = require("./util/logger");

let store = null;

// Electron's members are read only when the store is first used, so the
// pure parts (createRetranscriber, exportWav) load under plain `node --test`.
function getStore() {
  if (store) return store;
  const { app } = electron;
  store = createAudioStore({
    dir: () => path.join(app.getPath("userData"), "audio"),
    // safeStorage answers only after `ready`; before it, nothing is secure.
    safeStorage: () => (app.isReady() ? electron.safeStorage : null),
    log: logger,
  });
  return store;
}

function limitsOf(cfg) {
  return { maxAgeDays: cfg.recordings.maxAgeDays, maxMegabytes: cfg.recordings.maxMegabytes };
}

function historyIds() {
  return new Set(history.list().map((entry) => entry.id));
}

// Whether a finished dictation's audio should be kept under `cfg`.
function shouldKeep(cfg) {
  return cfg.recordings?.keep === true && cfg.history?.enabled === true;
}

/**
 * Keep `wav` as History entry `id`'s audio, a turn later so encryption and
 * the write never sit between the transcript and its paste. `onSaved` runs
 * after a recording is kept (Settings redraws the entry). Never throws; a
 * failure is logged and shown in Settings (status().lastError), and the
 * transcript is unaffected.
 */
function keepLater(id, wav, cfg, onSaved = () => {}) {
  if (!id || !shouldKeep(cfg)) return;
  setImmediate(() => {
    try {
      const result = getStore().save(id, wav, { limits: limitsOf(cfg), keepIds: historyIds() });
      if (result.ok) onSaved();
      else if (result.error !== "deleted") logger.warn("recording not kept:", result.error);
    } catch (err) {
      logger.warn("recording not kept:", err.message);
    }
  });
}

/** Apply the limits now (age, size, recordings whose entry is gone). */
function prune(cfg) {
  try {
    return getStore().prune({ ...limitsOf(cfg), keepIds: historyIds() });
  } catch (err) {
    logger.warn("pruning kept recordings failed:", err.message);
    return [];
  }
}

const PRUNE_EVERY_MS = 60 * 60 * 1000;
let pruneTimer = null;

// Prune at startup and hourly, whether or not keeping is on: turning it off
// never strands recordings past their limits. `onPruned` runs when something
// was removed (Settings redraws).
function startPruning(getCfg, onPruned = () => {}) {
  const run = () => {
    if (prune(getCfg()).length) onPruned();
  };
  run();
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = setInterval(run, PRUNE_EVERY_MS);
  pruneTimer.unref?.();
}

/**
 * Write `wav` to `dest` (a path the user picked) through a temp file, so a
 * failed write never leaves a truncated file under their chosen name. This
 * is the one place a recording leaves its encryption, and only by the user's
 * explicit choice. Returns { ok: true } or { ok: false, error: <code> }.
 */
function exportWav(wav, dest, fsImpl = fs) {
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, wav, { mode: 0o600 });
    fsImpl.renameSync(tmp, dest);
    return { ok: true };
  } catch (err) {
    try {
      fsImpl.unlinkSync(tmp);
    } catch {
      // Never created.
    }
    return { ok: false, error: err.code || "unknown error" };
  }
}

/**
 * Retranscription of a kept recording, owned by the History entry it belongs
 * to — not a dictation: it never pastes or copies anything, never adds a
 * History entry, and never touches the entry's original `raw`/`text`. The
 * result goes into `entry.retry` (history.setRetry), marked "done", "failed"
 * or "cancelled".
 *
 * One runs at a time (another asks get "busy"), only while no dictation is
 * running ("dictating"), and a dictation that starts cancels it (cancel()).
 * `seq` is a timestamp that only increases, so across restarts a later retry
 * always outranks an earlier one and history.setRetry drops a stale result.
 *
 * @param {{
 *   read: (id: string) => { ok: boolean, wav?: Buffer, error?: string },
 *   transcribe: (wav: Buffer, signal: AbortSignal) => Promise<{ text: string, partial?: boolean }>,
 *   clean: (raw: string, signal: AbortSignal) => Promise<{ text: string, cleaned: boolean }>,
 *   setRetry: (id: string, retry: object) => { ok: boolean, stored?: boolean, error?: string },
 *   canStart: () => boolean,
 *   now?: () => number,
 *   onSettled?: () => void,
 * }} deps
 */
function createRetranscriber({ read, transcribe, clean, setRetry, canStart, now = Date.now, onSettled = () => {} }) {
  let running = null; // { id, controller }
  let lastSeq = 0;

  return {
    async run(id) {
      if (running) return { ok: false, error: "busy" };
      if (!canStart()) return { ok: false, error: "dictating" };
      const audio = read(id);
      if (!audio.ok) return { ok: false, error: audio.error };
      const seq = Math.max(now(), lastSeq + 1);
      lastSeq = seq;
      const controller = new AbortController();
      running = { id, controller };
      const retry = { seq, at: new Date(now()).toISOString() };
      try {
        const { text: raw, partial } = await transcribe(audio.wav, controller.signal);
        if (controller.signal.aborted) throw new Error("cancelled");
        Object.assign(retry, { raw, text: raw, cleaned: false });
        if (raw) Object.assign(retry, await clean(raw, controller.signal));
        if (controller.signal.aborted) throw new Error("cancelled");
        retry.status = "done";
        if (partial) retry.incomplete = true;
      } catch (err) {
        for (const field of ["raw", "text", "cleaned"]) delete retry[field];
        retry.status = controller.signal.aborted ? "cancelled" : "failed";
        if (retry.status === "failed") retry.error = String(err?.message || err).slice(0, 300);
      } finally {
        running = null;
        try {
          onSettled();
        } catch {
          // Housekeeping only.
        }
      }
      const saved = setRetry(id, retry);
      if (!saved.ok) return { ok: false, error: saved.error, retry };
      return { ok: true, stored: saved.stored, retry };
    },
    /** Cancel the running retry, if any; true when there was one. */
    cancel() {
      if (!running) return false;
      running.controller.abort();
      return true;
    },
    running: () => running?.id ?? null,
  };
}

module.exports = {
  getStore,
  shouldKeep,
  keepLater,
  prune,
  startPruning,
  exportWav,
  createRetranscriber,
  limitsOf,
};
