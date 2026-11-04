// Retained dictation audio (#343): an opt-in, encrypted, size- and
// age-limited store of each dictation's WAV, keyed by its History entry id
// (main/history.js, the id contract), so Settings → History can replay,
// export and retranscribe it — after a restart too.
//
// Off by default. With retention off nothing here writes: no directory, no
// key, no file. The in-memory failed-take retry (#293, main/failed-take.js)
// is separate and unchanged.
//
// On disk, under <userData>/audio/ (directory 0700, files 0600):
//
//   key.json          { "version": 1, "wrapped": "<base64>" } — a random
//                     256-bit data key, base64, encrypted by Electron
//                     safeStorage (the OS keychain: Keychain, DPAPI, Secret
//                     Service/KWallet). Only the wrapped form is ever stored.
//   <entryId>.wav.enc one recording, format v1:
//                       "EHAU" magic (4 bytes) · version 0x01 (1) ·
//                       IV (12) · AES-256-GCM tag (16) · ciphertext
//                     The GCM additional data is magic + version + entry id,
//                     so a file copied or renamed onto another entry fails to
//                     authenticate instead of playing the wrong words.
//                     A file with an unknown magic or version is reported
//                     unreadable (a newer build's format), never rewritten,
//                     and still deletable and still expires.
//
// Fail closed: retention can only turn on where safeStorage is real OS-backed
// encryption (secret-store.storageStatus — on Linux, "basic_text" is a
// password hardcoded into Chromium and counts as unavailable). Audio is never
// written in plaintext. A key file that exists but can't be unwrapped (keyring
// locked or replaced, userData copied from another machine) makes existing
// audio unreadable and stops new recordings being kept, with the reason in
// status(); the key file is never replaced on its own, so a keyring that
// unlocks later gets the audio back. Deleting all recordings removes the key
// too, and the next kept recording starts a new one.
//
// Writes go to a temp file then rename, so a crash, a full disk or a refused
// write never leaves a truncated recording behind: the temp file is removed,
// the failure is logged and kept in status().lastError for Settings, and the
// transcript (already in History) is unaffected.
//
// Limits: recordings older than maxAgeDays (by the time they were written)
// go first, then the oldest until the total fits maxMegabytes, and any
// recording whose History entry no longer exists (deleted, cleared, or pushed
// out by History's own entry limit). A single recording bigger than the whole
// budget is not kept.

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");
const secretStore = require("./secret-store");

const MAGIC = Buffer.from("EHAU", "ascii");
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES + TAG_BYTES;
const KEY_FILE = "key.json";
const KEY_FILE_VERSION = 1;
const SUFFIX = ".wav.enc";
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
// History's id pattern; anything else is never turned into a path.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function aad(id) {
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), Buffer.from(id, "utf8")]);
}

// Pure: seal one WAV for entry `id` with the 32-byte `key`.
function seal(wav, key, id) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(id));
  const body = Buffer.concat([cipher.update(wav), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
}

// Whether `head` starts like a recording this build can read.
function knownFormat(head) {
  return head.length >= HEADER_BYTES && head.subarray(0, 4).equals(MAGIC) && head[4] === FORMAT_VERSION;
}

// Pure: the WAV inside `file`, or throws an Error with `code` "unreadable".
function open(file, key, id) {
  const fail = (why) => Object.assign(new Error(`recording is unreadable: ${why}`), { code: "unreadable" });
  if (!knownFormat(file)) throw fail("unknown format");
  const iv = file.subarray(5, 5 + IV_BYTES);
  const tag = file.subarray(5 + IV_BYTES, HEADER_BYTES);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(id));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(file.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    throw fail("damaged, or sealed with another key");
  }
}

// Why retention can't run here, for Settings, or null when it can.
function insecureReason(status, platform) {
  if (status.secure) return null;
  if (platform === "linux") {
    return status.backend && status.backend !== "unknown"
      ? `No system keyring is available (storage backend "${status.backend}"), so recordings can't be encrypted.`
      : "No system keyring is available, so recordings can't be encrypted.";
  }
  return "This system's secure storage isn't available, so recordings can't be encrypted.";
}

/**
 * @param {{
 *   dir: () => string,             // <userData>/audio, resolved lazily
 *   safeStorage: () => object|null, // Electron safeStorage once ready, else null
 *   platform?: string,
 *   now?: () => number,
 *   fs?: typeof import("node:fs"),
 *   log?: { warn: Function },
 * }} options
 */
function createAudioStore({ dir, safeStorage, platform = process.platform, now = Date.now, fs = nodeFs, log = console }) {
  // The unwrapped data key, once read or made. `keyProblem` is why it can't
  // be: "locked" (a key file exists but won't unwrap) or "lost" (no key file,
  // but recordings sealed with one) — sticky until the user deletes all
  // recordings or the app restarts.
  let dataKey = null;
  let keyProblem = null;
  let lastError = null;

  const fileFor = (id) => path.join(dir(), `${id}${SUFFIX}`);

  function storage() {
    const ss = safeStorage();
    const status = secretStore.storageStatus(ss, platform);
    return { ss, status, reason: insecureReason(status, platform) };
  }

  function ensureDir() {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    // mkdir's mode doesn't apply to a directory that already existed, and
    // the umask can widen it; neither may leave the audio readable by others.
    if (platform !== "win32") fs.chmodSync(dir(), 0o700);
  }

  function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Never created, or already gone.
      }
      throw err;
    }
  }

  // The data key, unwrapping or (with `create`) making it. Returns
  // { key } or { error: "insecure" | "locked" | "lost" | "no-key" }.
  function loadKey({ create = false } = {}) {
    if (dataKey) return { key: dataKey };
    const { ss, status } = storage();
    if (!status.secure || !ss) return { error: "insecure" };
    if (keyProblem) return { error: keyProblem };
    const keyPath = path.join(dir(), KEY_FILE);
    let stored = null;
    try {
      stored = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") {
        // Present but unreadable or not JSON: treated as a lost key, never
        // overwritten — the audio it seals stays for a later fix or a delete.
        keyProblem = "locked";
        log.warn("audio key file unreadable:", err.code || err.message);
        return { error: keyProblem };
      }
    }
    if (stored) {
      try {
        if (stored.version !== KEY_FILE_VERSION || typeof stored.wrapped !== "string") throw new Error("unknown key file format");
        const key = Buffer.from(ss.decryptString(Buffer.from(stored.wrapped, "base64")), "base64");
        if (key.length !== 32) throw new Error("wrong key length");
        dataKey = key;
        return { key };
      } catch (err) {
        keyProblem = "locked";
        log.warn("audio key could not be unwrapped:", err.message);
        return { error: keyProblem };
      }
    }
    if (!create) return { error: "no-key" };
    // No key file, but recordings: the key was deleted or lost. A new key
    // would make Settings look healthy while those stay unreadable for good,
    // so nothing new is kept until the user deletes all recordings.
    if (entries().length > 0) {
      keyProblem = "lost";
      log.warn("audio key file missing while recordings remain");
      return { error: keyProblem };
    }
    const key = crypto.randomBytes(32);
    ensureDir();
    const wrapped = ss.encryptString(key.toString("base64")).toString("base64");
    writeAtomic(keyPath, JSON.stringify({ version: KEY_FILE_VERSION, wrapped }));
    dataKey = key;
    return { key };
  }

  // Every recording on disk: [{ id, file, bytes, mtimeMs }], oldest first.
  // Temp files and anything not named like a recording are skipped.
  function entries() {
    let names;
    try {
      names = fs.readdirSync(dir());
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(SUFFIX)) continue;
      const id = name.slice(0, -SUFFIX.length);
      if (!isValidId(id)) continue;
      const file = path.join(dir(), name);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) out.push({ id, file, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Removed between the listing and the stat.
      }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  function unlinkQuiet(file) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return true;
      log.warn("could not delete a kept recording:", err.code || err.message);
      return false;
    }
  }

  /**
   * Delete what the limits no longer allow: recordings older than the age
   * limit, ones whose History entry is gone (`keepIds`, when given), then the
   * oldest until the total plus `reserve` bytes fits the size limit.
   * Returns the ids removed.
   */
  function prune({ maxAgeDays, maxMegabytes, keepIds = null, reserve = 0 }) {
    const removed = [];
    let list;
    try {
      list = entries();
    } catch (err) {
      log.warn("could not list kept recordings:", err.code || err.message);
      return removed;
    }
    const cutoff = now() - maxAgeDays * DAY_MS;
    const live = [];
    for (const item of list) {
      const orphan = keepIds && !keepIds.has(item.id);
      if ((item.mtimeMs < cutoff || orphan) && unlinkQuiet(item.file)) removed.push(item.id);
      else live.push(item);
    }
    const budget = maxMegabytes * MB;
    let total = live.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of live) {
      if (total + reserve <= budget) break;
      if (unlinkQuiet(item.file)) {
        removed.push(item.id);
        total -= item.bytes;
      }
    }
    return removed;
  }

  return {
    /**
     * Keep `wav` for History entry `id`. `limits` = { maxAgeDays,
     * maxMegabytes }, `keepIds` = the ids still in History. Never throws:
     * resolves to { ok: true } or { ok: false, error }, where error is
     * "insecure", "locked", "lost", "too-large", "invalid-id", "deleted" (the
     * entry left History first; not an error) or a file-system code
     * (ENOSPC, EACCES, …), which status().lastError also reports.
     */
    save(id, wav, { limits, keepIds = null }) {
      const fail = (error) => {
        lastError = { code: error, at: new Date(now()).toISOString() };
        return { ok: false, error };
      };
      if (!isValidId(id)) return fail("invalid-id");
      // Deleted (or cleared) between the dictation and this write: keeping
      // its audio would bring back what the user just removed.
      if (keepIds && !keepIds.has(id)) return { ok: false, error: "deleted" };
      try {
        const { key, error } = loadKey({ create: true });
        if (!key) return fail(error);
        const sealed = seal(wav, key, id);
        if (sealed.length > limits.maxMegabytes * MB) return fail("too-large");
        // Make room first, so the new recording fits the budget it is judged by.
        prune({ ...limits, keepIds, reserve: sealed.length });
        writeAtomic(fileFor(id), sealed);
        lastError = null;
        return { ok: true };
      } catch (err) {
        log.warn("could not keep the recording:", err.code || err.message);
        return fail(err.code || "unknown error");
      }
    },

    /**
     * The WAV kept for `id`: { ok: true, wav } or { ok: false, error } with
     * error "missing" (none kept, or deleted/expired), "unreadable" (damaged,
     * unknown format, or the key can't be unwrapped), "insecure" (no secure
     * storage now) or a file-system code.
     */
    read(id) {
      if (!isValidId(id)) return { ok: false, error: "missing" };
      let file;
      try {
        file = fs.readFileSync(fileFor(id));
      } catch (err) {
        return { ok: false, error: err.code === "ENOENT" ? "missing" : err.code || "unknown error" };
      }
      const { key, error } = loadKey();
      if (!key) return { ok: false, error: error === "insecure" ? "insecure" : "unreadable" };
      try {
        return { ok: true, wav: open(file, key, id) };
      } catch (err) {
        return { ok: false, error: err.code || "unreadable" };
      }
    },

    /**
     * Without decrypting, per id: "kept" (a format this build reads, and a
     * key to read it with — damage inside the ciphertext only shows when it
     * is read), "unreadable" (known unreadable: unknown format, truncated, or
     * no usable key), or null (nothing kept).
     */
    availability(ids) {
      const out = {};
      const keyOk = Boolean(loadKey().key);
      for (const id of ids) {
        if (!isValidId(id)) continue;
        let head = null;
        let fd = null;
        try {
          fd = fs.openSync(fileFor(id), "r");
          head = Buffer.alloc(HEADER_BYTES);
          const n = fs.readSync(fd, head, 0, HEADER_BYTES, 0);
          head = head.subarray(0, n);
        } catch {
          head = null;
        } finally {
          if (fd !== null) fs.closeSync(fd);
        }
        out[id] = head === null ? null : keyOk && knownFormat(head) ? "kept" : "unreadable";
      }
      return out;
    },

    /** Delete the recording kept for `id`; true when none is left. */
    remove(id) {
      if (!isValidId(id)) return true;
      return unlinkQuiet(fileFor(id));
    },

    /**
     * Delete every recording and the key: { ok: true } or { ok: false, error }
     * when something couldn't be deleted (what could be, is).
     */
    clear() {
      let failed = null;
      let names = [];
      try {
        names = fs.readdirSync(dir());
      } catch (err) {
        if (err.code !== "ENOENT") return { ok: false, error: err.code || "unknown error" };
      }
      // Recordings (and stray temp files) first; the key only once all of
      // them are gone, so a partial failure never strands a recording
      // without the key that reads it. What is left can be deleted again.
      for (const name of names.filter((n) => n !== KEY_FILE)) {
        try {
          fs.unlinkSync(path.join(dir(), name));
        } catch (err) {
          if (err.code !== "ENOENT") failed = err.code || "unknown error";
        }
      }
      if (!failed && names.includes(KEY_FILE)) {
        try {
          fs.unlinkSync(path.join(dir(), KEY_FILE));
        } catch (err) {
          if (err.code !== "ENOENT") failed = err.code || "unknown error";
        }
      }
      if (!failed) {
        dataKey = null;
        keyProblem = null;
        lastError = null;
      }
      return failed ? { ok: false, error: failed } : { ok: true };
    },

    prune,

    /**
     * What Settings shows: { secure, reason, key: "ok"|"locked"|"lost"|"none",
     * count, bytes, lastError }.
     */
    status() {
      const { status, reason } = storage();
      let list = [];
      try {
        list = entries();
      } catch {
        // Reported as none; the next write or prune logs the cause.
      }
      const key = status.secure ? loadKey() : { error: "insecure" };
      return {
        secure: status.secure,
        reason,
        key: key.key ? "ok" : key.error === "locked" || key.error === "lost" ? key.error : "none",
        count: list.length,
        bytes: list.reduce((sum, item) => sum + item.bytes, 0),
        lastError,
      };
    },
  };
}

module.exports = { createAudioStore, seal, open, insecureReason, FORMAT_VERSION, HEADER_BYTES, SUFFIX, KEY_FILE };
