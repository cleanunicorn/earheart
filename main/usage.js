// Local usage statistics (#347): how many takes, words and seconds of speech
// were delivered, per local calendar day, so Settings → Usage can show speed,
// streaks and an estimate of the typing time saved.
//
// Counts only. Nothing here ever sees, stores or sends transcript text: the
// pipeline hands record() a word count and a duration. The file
// (userData/usage.json) is independent of History, so it keeps counting with
// History off. No network: this module needs only node:fs/path, plus Electron
// (for the userData path and IPC) loaded lazily, so tests can require it bare.
//
// Never in the way of delivery (Golden rule 8): record() runs after the paste,
// never throws, and defers its disk write a turn (the history.js shape).
// Format, counting policy and degrade rules: docs/usage-stats.md.

const fs = require("node:fs");
const path = require("node:path");
const logger = require("./util/logger");

const VERSION = 1;
// ~10 years of day buckets (~60 bytes each, ~220 KB): far more than the UI
// shows, still trivially small. The oldest go first; totals never shrink.
const MAX_DAYS = 3660;
// A take id seen this recently is not counted again (one take, one count).
const RECENT_IDS = 16;
const DEFAULT_TYPING_WPM = 40;
const MIN_TYPING_WPM = 10;
const MAX_TYPING_WPM = 200;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/* ---- Pure helpers ---- */

const pad = (n) => String(n).padStart(2, "0");

// The LOCAL calendar date of `date` as YYYY-MM-DD: a take at 23:30 belongs to
// the day the user lived it, not to the UTC date.
function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The day key `n` calendar days from `key`. Steps on the calendar (Date.UTC
// on y/m/d), never by 86,400,000 ms, so a 23 h or 25 h DST day is still one.
function addDays(key, n) {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// A real calendar date in YYYY-MM-DD form ("2026-02-30" is not).
function isDayKey(key) {
  return typeof key === "string" && DAY_KEY.test(key) && addDays(key, 0) === key;
}

function countWords(text) {
  if (typeof text !== "string") return 0;
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

// A stored count: a finite, non-negative integer, or 0.
function toCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), Number.MAX_SAFE_INTEGER) : 0;
}

function bucket(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return { takes: toCount(src.takes), words: toCount(src.words), speechMs: toCount(src.speechMs) };
}

function emptyState(since = null) {
  return { since, totals: bucket(), days: {}, readOnly: false };
}

// Drop the oldest day buckets past MAX_DAYS. Totals are untouched.
function prune(days) {
  const keys = Object.keys(days);
  if (keys.length <= MAX_DAYS) return;
  keys.sort();
  for (const key of keys.slice(0, keys.length - MAX_DAYS)) delete days[key];
}

// Whatever a usage file held, as a valid in-memory state: bad numbers become
// 0, bad day keys and empty days are dropped. A file from a newer Earheart
// (version > 1) is shown but marked read-only, so this version never
// overwrites a format it doesn't know.
function sanitize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
  const days = {};
  if (raw.days && typeof raw.days === "object" && !Array.isArray(raw.days)) {
    for (const [key, value] of Object.entries(raw.days)) {
      if (!isDayKey(key)) continue;
      const day = bucket(value);
      if (day.takes > 0) days[key] = day;
    }
  }
  prune(days);
  const earliest = Object.keys(days).sort()[0] || null;
  return {
    since: isDayKey(raw.since) ? raw.since : earliest,
    totals: bucket(raw.totals),
    days,
    readOnly: Number.isFinite(raw.version) && raw.version > VERSION ? "newer" : false,
  };
}

function clampWpm(value) {
  return Number.isFinite(value) ? Math.round(Math.min(MAX_TYPING_WPM, Math.max(MIN_TYPING_WPM, value))) : DEFAULT_TYPING_WPM;
}

/**
 * What Settings shows, from a state. `days` (newest first) covers the last
 * `days` calendar days including today, zero-filled. avgWpm is null until a
 * second of speech is counted (no Infinity/NaN); timeSavedMs is null with no
 * takes and never negative: typing the words at `typingWpm`, minus the time
 * spent speaking them — an estimate, not a measurement.
 */
function summarize(state, { now = new Date(), days = 14, typingWpm = DEFAULT_TYPING_WPM } = {}) {
  const wpm = clampWpm(typingWpm);
  const totals = bucket(state.totals);
  const has = (key) => (state.days[key]?.takes || 0) > 0;
  const today = localDayKey(now);

  // Current streak: consecutive days with a take, ending today — or
  // yesterday, so a streak is not "broken" before today's first dictation.
  let current = 0;
  for (let key = has(today) ? today : addDays(today, -1); has(key); key = addDays(key, -1)) current++;
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const key of Object.keys(state.days).filter(has).sort()) {
    run = prev && addDays(prev, 1) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = key;
  }

  const list = [];
  for (let i = 0; i < Math.max(0, Math.floor(days)); i++) {
    const date = addDays(today, -i);
    list.push({ date, ...bucket(state.days[date]) });
  }

  return {
    since: state.since,
    totals,
    avgWpm: totals.speechMs >= 1000 ? Math.round(totals.words / (totals.speechMs / 60000)) : null,
    timeSavedMs: totals.takes > 0 ? Math.max(0, Math.round((totals.words / wpm) * 60000 - totals.speechMs)) : null,
    typingWpm: wpm,
    streak: { current, longest: Math.max(longest, current) },
    days: list,
    readOnly: state.readOnly || false,
  };
}

/* ---- Store ---- */

let cached = null;
let flushScheduled = false;
const recentIds = [];
const listeners = new Set();

function usagePath() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "usage.json");
}

function load() {
  if (cached) return cached;
  const file = usagePath();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    // Missing: a fresh start. Unreadable for another reason: show nothing
    // and write nothing this session, so a passing I/O error can't replace
    // years of counts with one day's.
    cached = emptyState();
    if (err.code !== "ENOENT") {
      cached.readOnly = "unreadable";
      logger.warn("usage stats unreadable:", err.message);
    }
    return cached;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    cached = sanitize(parsed);
    return cached;
  }
  // Not a usage object at all: keep it aside (as history.js does) and start
  // again, rather than refusing to count forever.
  cached = emptyState();
  let backup = `${file}.corrupt-${Date.now()}-${process.pid}`;
  for (let suffix = 1; fs.existsSync(backup); suffix++) {
    backup = `${file}.corrupt-${Date.now()}-${process.pid}-${suffix}`;
  }
  try {
    fs.renameSync(file, backup);
    logger.warn("corrupt usage stats preserved at", backup);
  } catch (err) {
    logger.warn("corrupt usage stats backup failed:", err.message);
  }
  return cached;
}

function serialize(state) {
  return JSON.stringify({ version: VERSION, since: state.since, totals: state.totals, days: state.days });
}

// Replace usage.json through a temp file + rename, so a crash mid-write never
// leaves a truncated file. Throws on failure, after removing the temp file.
function writeAtomic(state) {
  const file = usagePath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, serialize(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The write may have failed before the temp file was created.
    }
    throw err;
  }
}

// Deferred one turn and coalesced, like history.js: record() returns at once
// and a burst of takes writes once. Writes the state as it is at flush time.
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    if (!flushScheduled) return; // superseded by reset()
    flushScheduled = false;
    if (!cached || cached.readOnly) return;
    try {
      writeAtomic(cached);
    } catch (err) {
      logger.warn("usage stats write failed:", err.message);
    }
  });
}

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      logger.warn("usage listener failed:", err?.message);
    }
  }
}

/**
 * Count one delivered take. `cfg` is the `usage` settings section; with
 * `enabled: false` nothing is counted (earlier counts stay). A take id seen
 * among the last few is ignored. Never throws; returns whether it counted.
 */
function record({ takeId, words, speechMs, now = new Date() } = {}, cfg) {
  try {
    if (cfg && cfg.enabled === false) return false;
    if (takeId !== undefined && takeId !== null) {
      if (recentIds.includes(takeId)) return false;
    }
    const state = load();
    if (state.readOnly) return false;
    if (takeId !== undefined && takeId !== null) {
      recentIds.push(takeId);
      if (recentIds.length > RECENT_IDS) recentIds.shift();
    }
    const add = { takes: 1, words: toCount(words), speechMs: toCount(speechMs) };
    const key = localDayKey(now);
    const day = state.days[key] || bucket();
    for (const field of ["takes", "words", "speechMs"]) {
      day[field] = toCount(day[field] + add[field]);
      state.totals[field] = toCount(state.totals[field] + add[field]);
    }
    state.days[key] = day;
    if (!state.since) state.since = key;
    prune(state.days);
    scheduleFlush();
    emit();
    return true;
  } catch (err) {
    logger.warn("usage record failed:", err?.message);
    return false;
  }
}

function summary(opts = {}) {
  return summarize(load(), opts);
}

/**
 * Start counting again from today. Written at once (an explicit user action,
 * allowed even over a newer version's file); on failure the counts in memory
 * stay as they were, so the screen never claims a reset the disk didn't take.
 */
function reset(now = new Date()) {
  const fresh = emptyState(localDayKey(now));
  try {
    writeAtomic(fresh);
  } catch (err) {
    logger.warn("usage stats reset failed:", err.message);
    return { ok: false, error: err.code || err.message };
  }
  cached = fresh;
  flushScheduled = false;
  emit();
  return { ok: true };
}

function onChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// IPC for Settings → Usage. The window refetches on "usage:changed".
function init() {
  const { ipcMain } = require("electron");
  const settings = require("./settings");
  const windows = require("./windows");
  ipcMain.handle("usage:get", () => {
    try {
      return { ok: true, summary: summary({ typingWpm: settings.get().usage?.typingWpm }) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
  ipcMain.handle("usage:reset", () => reset());
  onChanged(() => windows.sendToSettings("usage:changed"));
}

module.exports = {
  record,
  summary,
  reset,
  onChanged,
  init,
  localDayKey,
  addDays,
  isDayKey,
  countWords,
  sanitize,
  summarize,
  VERSION,
  MAX_DAYS,
  DEFAULT_TYPING_WPM,
  MIN_TYPING_WPM,
  MAX_TYPING_WPM,
};
