// Transcription history: a small JSON file with the most recent dictations,
// so a transcript is never lost if a paste goes to the wrong window.

const { app } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const logger = require("./util/logger");

let cached = null;

function historyPath() {
  return path.join(app.getPath("userData"), "history.json");
}

function validEntries(value) {
  if (!Array.isArray(value)) return [];
  // A manually edited, partially recovered, or older history file may contain
  // nulls or other JSON values. Only records with transcript text can satisfy
  // the renderer/tray contract; ignore bad rows without hiding valid ones.
  return value.filter(
    (entry) => entry && typeof entry === "object" && typeof entry.text === "string"
  );
}

// Entry IDs — the contract later features (#343: retained audio linked to its
// history entry) build on:
//   - Every entry has an `id`: 1–64 characters of [A-Za-z0-9_-]. New ones are
//     UUID v4 (crypto.randomUUID()), stamped by add() before delivery runs.
//   - An id never changes and is never reused: corrections, search and other
//     deletes leave it alone, and a deleted entry's id is gone for good.
//   - A caller that needs the id before the entry exists (a dictation session
//     naming its audio file) may pass a valid, unused `entry.id` to add(),
//     which keeps it; anything else is replaced by a fresh UUID. add()
//     returns the id it stored.
//   - Rows saved before ids existed (or with a missing, malformed or duplicate
//     id) get a fresh UUID when the file is loaded, and that is written back
//     once, so the id is stable across restarts from then on. If that write
//     fails, the next launch assigns new ones; nothing else about the row
//     changes either way.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

// Give each row without a usable, unique id a new one. Returns whether any
// row changed, so the caller can persist the migration.
function assignIds(entries) {
  const seen = new Set();
  let changed = false;
  for (const entry of entries) {
    if (!isValidId(entry.id) || seen.has(entry.id)) {
      entry.id = crypto.randomUUID();
      changed = true;
    }
    seen.add(entry.id);
  }
  return changed;
}

function load() {
  if (cached) return cached;
  const file = historyPath();
  let corrupt = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) {
      cached = validEntries(parsed);
      if (assignIds(cached)) scheduleFlush();
    } else {
      cached = [];
      corrupt = true;
    }
  } catch (err) {
    cached = [];
    corrupt = err instanceof SyntaxError;
  }
  if (corrupt) {
    let backup = `${file}.corrupt-${Date.now()}-${process.pid}`;
    let suffix = 0;
    while (fs.existsSync(backup)) {
      backup = `${file}.corrupt-${Date.now()}-${process.pid}-${++suffix}`;
    }
    try {
      fs.renameSync(file, backup);
      logger.warn("corrupt history preserved at", backup);
    } catch (renameErr) {
      logger.warn("corrupt history backup failed:", renameErr.message);
    }
  }
  return cached;
}

// Persistence is deferred one event-loop turn and coalesced: add() returns
// immediately (a synchronous disk write would now sit between the final text
// and the paste, delaying it), a burst of adds writes once, and the flush
// still runs within milliseconds — before any later quit event can be
// processed — so an entry is durably on disk by the time the user could exit.
// The write itself
// goes through a temp file + rename (same pattern as model-manager/updates),
// so a crash mid-write can never leave a truncated history.json behind; if an
// older write did leave one, load() preserves it before starting fresh.
let flushScheduled = false;

// Replace history.json with `items` through a temp file + rename. Throws on
// failure, after removing the temp file.
function writeAtomic(items) {
  const file = historyPath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
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

// The flush writes whatever the list is when it runs, not when it was
// queued, so an entry removed in between (remove(), clear()) stays removed.
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    if (!flushScheduled) return; // superseded by clear() or remove()
    flushScheduled = false;
    try {
      writeAtomic(cached);
    } catch (err) {
      logger.warn("history write failed:", err.message);
    }
  });
}

// Returns the stored entry's id (see the id contract above), or null when
// History is off.
function add(entry, cfg) {
  if (!cfg.enabled) return null;
  const items = load();
  const id = isValidId(entry.id) && !items.some((item) => item.id === entry.id) ? entry.id : crypto.randomUUID();
  items.unshift({ ...entry, id, at: new Date().toISOString() });
  items.length = Math.min(items.length, cfg.limit || 100);
  cached = items;
  scheduleFlush();
  return id;
}

function list() {
  return load();
}

/* ---- Search ---- */

// Bounds on what a search may ask for: the query is cut to MAX_QUERY
// characters and a page holds at most MAX_PAGE entries, so one request can't
// make the main process scan or send more than History already holds.
const MAX_QUERY = 200;
const MAX_PAGE = 50;
const DEFAULT_PAGE = 20;

// How text is compared: NFKC, so a composed "é" matches a decomposed one and
// a full-width "Ａ" matches "A"; lower-cased (and normalised again, since
// lower-casing "İ" decomposes it); and final sigma folded to σ, so a query
// typed mid-word still finds a word-final ς. Accents are not stripped: "cafe"
// does not match "café".
function fold(value) {
  return value.normalize("NFKC").toLowerCase().normalize("NFKC").replace(/ς/g, "σ");
}

const folded = new WeakMap();

function haystack(entry) {
  let value = folded.get(entry);
  if (value === undefined) {
    value = fold(typeof entry.raw === "string" ? `${entry.text}\n${entry.raw}` : entry.text);
    folded.set(entry, value);
  }
  return value;
}

function clampInt(value, min, max, fallback) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

// One page of the entries matching `query`, newest first. The query splits on
// whitespace into terms, and an entry matches when every term appears in its
// text or its pre-cleanup transcript (`raw`). An empty query matches all.
// `offset` past the last match is pulled back to the start of the last page,
// so a delete or a narrower query never strands the pager on an empty page.
// Returns { entries, total, offset, limit, all } — total counts the matches,
// all counts every entry. Throws a TypeError for a non-string query.
function search({ query = "", offset = 0, limit = DEFAULT_PAGE } = {}) {
  if (typeof query !== "string") throw new TypeError("The search must be text.");
  const size = clampInt(limit, 1, MAX_PAGE, DEFAULT_PAGE);
  const terms = fold(query.slice(0, MAX_QUERY)).split(/\s+/u).filter(Boolean);
  const items = load();
  const matches = terms.length
    ? items.filter((entry) => {
        const hay = haystack(entry);
        return terms.every((term) => hay.includes(term));
      })
    : items;
  const total = matches.length;
  let start = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
  if (start >= total) start = total ? Math.floor((total - 1) / size) * size : 0;
  return { entries: matches.slice(start, start + size), total, offset: start, limit: size, all: items.length };
}

/* ---- Delete one entry ---- */

// Delete the entry with this id. The file is rewritten before the list
// changes, with the same rule as clear() (#287): only a write that worked
// removes the entry from the list. A failed one (EPERM, EBUSY, a full disk)
// returns { ok: false, error: <code> } and leaves the list, the file and any
// pending write as they were, so the entry is still there for a retry. The
// write holds every queued add, so a successful delete also settles the
// pending flush — which could only write the list without the entry anyway.
// An id that isn't in History returns { ok: true, removed: false }.
function remove(id) {
  const items = load();
  const index = isValidId(id) ? items.findIndex((entry) => entry.id === id) : -1;
  if (index === -1) return { ok: true, removed: false };
  const next = items.filter((_, i) => i !== index);
  try {
    writeAtomic(next);
  } catch (err) {
    logger.warn("history delete failed:", err.message);
    return { ok: false, error: err.code || "unknown error" };
  }
  cached = next;
  flushScheduled = false;
  return { ok: true, removed: true };
}

// Delete the saved history. Only a delete that worked — or found nothing to
// delete (ENOENT) — empties the list (#287): a failed one (EPERM, EBUSY, an
// antivirus scan holding the file) leaves the transcripts on disk, and
// showing an empty history would be a promise the next launch breaks. Then
// the list, and any pending write of it, stay as they were, for a retry.
// Returns { ok: true } or { ok: false, error } — error is the short code
// (EBUSY, EPERM, …): the full message carries the path to the user's home.
function clear() {
  try {
    fs.unlinkSync(historyPath());
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.warn("history clear failed:", err.message);
      return { ok: false, error: err.code || "unknown error" };
    }
  }
  cached = [];
  // Cancel any pending flush so it can't recreate the file after the delete.
  flushScheduled = false;
  return { ok: true };
}

module.exports = { add, list, search, remove, clear, validEntries, isValidId, MAX_QUERY, MAX_PAGE };
