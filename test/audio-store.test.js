// Retained dictation audio (#343): encrypted at rest under a safeStorage-
// wrapped key, fail closed, limited by age and size, and recoverable when a
// file is missing, damaged, or the disk is full.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAudioStore, seal, open, HEADER_BYTES, SUFFIX } = require("../main/audio-store");
const { encodeWav } = require("../main/util/wav");

const DAY = 24 * 60 * 60 * 1000;
const LIMITS = { maxAgeDays: 30, maxMegabytes: 1024 };

// A safeStorage stand-in: a keyring identified by `secret`. Wrapping with
// one secret and unwrapping with another fails, as a replaced keyring does.
function fakeSafeStorage({ available = true, backend = "gnome_libsecret", secret = "keyring-1" } = {}) {
  const pad = crypto.createHash("sha256").update(secret).digest();
  const xor = (buf) => Buffer.from(buf.map((b, i) => b ^ pad[i % pad.length]));
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.concat([Buffer.from(secret), Buffer.from("|"), xor(Buffer.from(s, "utf8"))]),
    decryptString(buf) {
      const sep = buf.indexOf("|");
      if (buf.subarray(0, sep).toString() !== secret) throw new Error("Error while decrypting the ciphertext");
      return xor(buf.subarray(sep + 1)).toString("utf8");
    },
  };
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-audio-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "audio");
}

function wav(seconds = 1, value = 0.25) {
  return encodeWav(new Float32Array(16000 * seconds).fill(value));
}

function store(t, extra = {}) {
  const dir = extra.dirPath || tmpDir(t);
  let ss = extra.safeStorage === undefined ? fakeSafeStorage() : extra.safeStorage;
  let clock = extra.now ?? 1_700_000_000_000;
  const warnings = [];
  const s = createAudioStore({
    dir: () => dir,
    safeStorage: () => ss,
    platform: extra.platform || "linux",
    now: () => clock,
    fs: extra.fs || fs,
    log: { warn: (...args) => warnings.push(args.join(" ")) },
  });
  return {
    s, dir, warnings,
    setSafeStorage: (next) => { ss = next; },
    advance: (ms) => { clock += ms; },
  };
}

const ID_A = "2b0e0a46-2c3f-4b5e-9f00-0123456789ab";
const ID_B = "7c1f1b57-3d40-4c6f-8a11-123456789abc";
const ID_C = "8d202c68-4e51-4d70-9b22-23456789abcd";

test("off until used: creating a store touches nothing on disk", (t) => {
  const { s, dir } = store(t);
  assert.equal(s.status().count, 0);
  assert.deepEqual(s.availability([ID_A]), { [ID_A]: null });
  assert.equal(fs.existsSync(dir), false);
});

test("a kept recording reads back after a restart (a new store over the same files)", (t) => {
  const first = store(t);
  const audio = wav(2);
  assert.deepEqual(first.s.save(ID_A, audio, { limits: LIMITS }), { ok: true });
  // A new process: no key in memory, only key.json and the sealed file.
  const second = store(t, { dirPath: first.dir });
  const back = second.s.read(ID_A);
  assert.equal(back.ok, true);
  assert.ok(back.wav.equals(audio));
  assert.deepEqual(second.s.availability([ID_A, ID_B]), { [ID_A]: "kept", [ID_B]: null });
});

test("never plaintext: the file and key on disk don't contain the audio or the data key", (t) => {
  const { s, dir } = store(t);
  const audio = wav(1, 0.5);
  s.save(ID_A, audio, { limits: LIMITS });
  const file = fs.readFileSync(path.join(dir, ID_A + SUFFIX));
  assert.equal(file.subarray(0, 4).toString(), "EHAU");
  assert.equal(file[4], 1);
  assert.equal(file.indexOf("RIFF"), -1);
  assert.equal(file.indexOf(audio.subarray(44, 108)), -1, "PCM samples must not appear in the clear");
  const keyFile = JSON.parse(fs.readFileSync(path.join(dir, "key.json"), "utf8"));
  assert.equal(keyFile.version, 1);
  assert.match(keyFile.wrapped, /^[A-Za-z0-9+/=]+$/);
  const dataKey = fakeSafeStorage().decryptString(Buffer.from(keyFile.wrapped, "base64"));
  assert.equal(Buffer.from(dataKey, "base64").length, 32);
  assert.ok(!fs.readFileSync(path.join(dir, "key.json"), "utf8").includes(dataKey), "only the wrapped key is stored");
});

test("restrictive permissions on the directory, key and recordings", { skip: process.platform === "win32" }, (t) => {
  const { s, dir } = store(t);
  s.save(ID_A, wav(), { limits: LIMITS });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "key.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, ID_A + SUFFIX)).mode & 0o777, 0o600);
});

test("fail closed: without real secure storage nothing is written and status says why", (t) => {
  for (const [label, ss, platform] of [
    ["basic_text on Linux", fakeSafeStorage({ backend: "basic_text" }), "linux"],
    ["unknown backend", fakeSafeStorage({ backend: "unknown" }), "linux"],
    ["unavailable on macOS", fakeSafeStorage({ available: false }), "darwin"],
    ["not ready (null)", null, "win32"],
  ]) {
    const { s, dir } = store(t, { safeStorage: ss, platform });
    assert.deepEqual(s.save(ID_A, wav(), { limits: LIMITS }), { ok: false, error: "insecure" }, label);
    assert.equal(fs.existsSync(dir), false, `${label}: no directory, no key, no plaintext`);
    const status = s.status();
    assert.equal(status.secure, false, label);
    assert.match(status.reason, /can't be encrypted/, label);
    assert.equal(status.lastError.code, "insecure", label);
  }
  const basic = store(t, { safeStorage: fakeSafeStorage({ backend: "basic_text" }) });
  assert.match(basic.s.status().reason, /basic_text/);
});

test("a lost or replaced key: audio is reported unreadable, never dropped, and no new audio is kept", (t) => {
  const first = store(t);
  first.s.save(ID_A, wav(), { limits: LIMITS });
  const keyBefore = fs.readFileSync(path.join(first.dir, "key.json"), "utf8");
  // Next launch, the keyring is a different one (reset, or another machine).
  const next = store(t, { dirPath: first.dir, safeStorage: fakeSafeStorage({ secret: "keyring-2" }) });
  assert.deepEqual(next.s.read(ID_A), { ok: false, error: "unreadable" });
  assert.deepEqual(next.s.availability([ID_A]), { [ID_A]: "unreadable" });
  assert.equal(next.s.status().key, "locked");
  assert.deepEqual(next.s.save(ID_B, wav(), { limits: LIMITS }), { ok: false, error: "locked" });
  // The key file and the audio are still there for a keyring that comes back.
  assert.equal(fs.readFileSync(path.join(first.dir, "key.json"), "utf8"), keyBefore);
  assert.ok(fs.existsSync(path.join(first.dir, ID_A + SUFFIX)));
  assert.ok(next.warnings.some((w) => /unwrapped/.test(w)));
  // Deleting the unreadable audio is always possible.
  assert.equal(next.s.remove(ID_A), true);
  assert.equal(fs.existsSync(path.join(first.dir, ID_A + SUFFIX)), false);
});

test("a garbled key file is a lost key, not a crash, and is not overwritten", (t) => {
  const first = store(t);
  first.s.save(ID_A, wav(), { limits: LIMITS });
  fs.writeFileSync(path.join(first.dir, "key.json"), "{not json");
  const next = store(t, { dirPath: first.dir });
  assert.deepEqual(next.s.read(ID_A), { ok: false, error: "unreadable" });
  assert.deepEqual(next.s.save(ID_B, wav(), { limits: LIMITS }), { ok: false, error: "locked" });
  assert.equal(fs.readFileSync(path.join(first.dir, "key.json"), "utf8"), "{not json");
});

test("clear() deletes every recording and the key; the next save starts a fresh key", (t) => {
  const first = store(t);
  first.s.save(ID_A, wav(), { limits: LIMITS });
  const locked = store(t, { dirPath: first.dir, safeStorage: fakeSafeStorage({ secret: "other" }) });
  assert.equal(locked.s.status().key, "locked");
  assert.deepEqual(locked.s.clear(), { ok: true });
  assert.deepEqual(fs.readdirSync(first.dir), []);
  assert.deepEqual(locked.s.save(ID_B, wav(), { limits: LIMITS }), { ok: true });
  assert.equal(locked.s.read(ID_B).ok, true);
  assert.equal(locked.s.status().key, "ok");
});

test("missing and damaged recordings have distinct, recoverable answers", (t) => {
  const { s, dir } = store(t);
  assert.deepEqual(s.read(ID_A), { ok: false, error: "missing" });
  s.save(ID_A, wav(), { limits: LIMITS });
  const file = path.join(dir, ID_A + SUFFIX);
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 3] ^= 0xff;
  fs.writeFileSync(file, bytes);
  assert.deepEqual(s.read(ID_A), { ok: false, error: "unreadable" });
  // A truncated file and a future format version are unreadable too.
  fs.writeFileSync(file, bytes.subarray(0, HEADER_BYTES - 1));
  assert.deepEqual(s.read(ID_A), { ok: false, error: "unreadable" });
  assert.deepEqual(s.availability([ID_A]), { [ID_A]: "unreadable" });
  const future = Buffer.from(bytes);
  future[4] = 2;
  fs.writeFileSync(file, future);
  assert.deepEqual(s.read(ID_A), { ok: false, error: "unreadable" });
  // And can be deleted.
  assert.equal(s.remove(ID_A), true);
  assert.deepEqual(s.read(ID_A), { ok: false, error: "missing" });
});

test("a recording renamed onto another entry fails to authenticate", (t) => {
  const { s, dir } = store(t);
  s.save(ID_A, wav(), { limits: LIMITS });
  fs.renameSync(path.join(dir, ID_A + SUFFIX), path.join(dir, ID_B + SUFFIX));
  assert.deepEqual(s.read(ID_B), { ok: false, error: "unreadable" });
});

test("seal/open round-trip and reject the wrong key or id", () => {
  const key = crypto.randomBytes(32);
  const audio = wav();
  const sealed = seal(audio, key, ID_A);
  assert.ok(open(sealed, key, ID_A).equals(audio));
  assert.throws(() => open(sealed, crypto.randomBytes(32), ID_A), { code: "unreadable" });
  assert.throws(() => open(sealed, key, ID_B), { code: "unreadable" });
});

test("full disk: the temp file is removed, nothing half-written remains, and the error is reported", (t) => {
  const real = fs;
  let fail = false;
  const flaky = {
    ...real,
    writeFileSync(file, data, opts) {
      if (fail && String(file).includes(ID_B)) {
        real.writeFileSync(file, data.subarray(0, 10), opts); // a partial write…
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return real.writeFileSync(file, data, opts);
    },
  };
  const { s, dir } = store(t, { fs: flaky });
  s.save(ID_A, wav(), { limits: LIMITS });
  fail = true;
  assert.deepEqual(s.save(ID_B, wav(), { limits: LIMITS }), { ok: false, error: "ENOSPC" });
  assert.deepEqual(fs.readdirSync(dir).sort(), [ID_A + SUFFIX, "key.json"].sort());
  assert.equal(s.status().lastError.code, "ENOSPC");
  // The earlier recording is untouched, and the next good write clears the error.
  assert.equal(s.read(ID_A).ok, true);
  fail = false;
  assert.deepEqual(s.save(ID_C, wav(), { limits: LIMITS }), { ok: true });
  assert.equal(s.status().lastError, null);
});

test("expiry: older than the age limit goes, the rest stay", (t) => {
  const h = store(t);
  h.s.save(ID_A, wav(), { limits: LIMITS });
  // File times come from the file system; age the first one by hand.
  const old = new Date(Date.now() - 31 * DAY);
  fs.utimesSync(path.join(h.dir, ID_A + SUFFIX), old, old);
  h.s.save(ID_B, wav(), { limits: LIMITS });
  const store2 = store(t, { dirPath: h.dir, now: Date.now() });
  assert.deepEqual(store2.s.prune(LIMITS), [ID_A]);
  assert.equal(store2.s.read(ID_B).ok, true);
});

test("the size limit evicts oldest first to make room for a new recording", (t) => {
  const h = store(t, { now: Date.now() });
  const big = wav(20); // ~640 KB sealed
  const size = seal(big, crypto.randomBytes(32), ID_A).length;
  // A budget that fits two recordings, not three.
  const limits = { maxAgeDays: 30, maxMegabytes: (2.5 * size) / (1024 * 1024) };
  h.s.save(ID_A, big, { limits });
  fs.utimesSync(path.join(h.dir, ID_A + SUFFIX), new Date(Date.now() - 3000), new Date(Date.now() - 3000));
  h.s.save(ID_B, big, { limits });
  fs.utimesSync(path.join(h.dir, ID_B + SUFFIX), new Date(Date.now() - 2000), new Date(Date.now() - 2000));
  h.s.save(ID_C, big, { limits });
  assert.deepEqual(h.s.availability([ID_A, ID_B, ID_C]), { [ID_A]: null, [ID_B]: "kept", [ID_C]: "kept" });
  assert.ok(h.s.status().bytes <= limits.maxMegabytes * 1024 * 1024);
});

test("a recording bigger than the whole budget is not kept, and evicts nothing", (t) => {
  const h = store(t);
  h.s.save(ID_A, wav(1), { limits: LIMITS });
  const tiny = { maxAgeDays: 30, maxMegabytes: 0.05 }; // ~52 KB
  assert.deepEqual(h.s.save(ID_B, wav(5), { limits: tiny }), { ok: false, error: "too-large" });
  assert.equal(h.s.read(ID_A).ok, true);
});

test("orphans: recordings whose History entry is gone are pruned", (t) => {
  const h = store(t);
  h.s.save(ID_A, wav(), { limits: LIMITS });
  h.s.save(ID_B, wav(), { limits: LIMITS });
  assert.deepEqual(h.s.prune({ ...LIMITS, keepIds: new Set([ID_B]) }), [ID_A]);
  assert.equal(h.s.status().count, 1);
});

test("ids that aren't History ids never become paths", (t) => {
  const h = store(t);
  for (const bad of ["../key", "a/b", "", "x".repeat(65), null, 42]) {
    assert.deepEqual(h.s.save(bad, wav(), { limits: LIMITS }), { ok: false, error: "invalid-id" });
    assert.deepEqual(h.s.read(bad), { ok: false, error: "missing" });
    assert.equal(h.s.remove(bad), true);
  }
  assert.equal(fs.existsSync(h.dir), false);
});

test("status counts recordings and ignores temp and foreign files", (t) => {
  const h = store(t);
  h.s.save(ID_A, wav(), { limits: LIMITS });
  fs.writeFileSync(path.join(h.dir, `${ID_B}${SUFFIX}.123.tmp`), "x");
  fs.writeFileSync(path.join(h.dir, "notes.txt"), "x");
  const status = h.s.status();
  assert.equal(status.count, 1);
  assert.equal(status.key, "ok");
  assert.equal(status.bytes, fs.statSync(path.join(h.dir, ID_A + SUFFIX)).size);
});

test("a deleted key file with recordings left is a lost key: no silent new key until all are deleted", (t) => {
  const first = store(t);
  first.s.save(ID_A, wav(), { limits: LIMITS });
  fs.unlinkSync(path.join(first.dir, "key.json"));
  const next = store(t, { dirPath: first.dir });
  assert.equal(next.s.status().key, "lost", "reported at once after the restart, before any save");
  assert.deepEqual(next.s.read(ID_A), { ok: false, error: "unreadable" });
  assert.deepEqual(next.s.availability([ID_A]), { [ID_A]: "unreadable" });
  assert.deepEqual(next.s.save(ID_B, wav(), { limits: LIMITS }), { ok: false, error: "lost" });
  assert.equal(fs.existsSync(path.join(first.dir, "key.json")), false, "no replacement key was made");
  assert.equal(next.s.status().key, "lost");
  assert.ok(fs.existsSync(path.join(first.dir, ID_A + SUFFIX)), "the recording is preserved");
  // The deliberate reset: delete all, then keeping works again with a new key.
  assert.deepEqual(next.s.clear(), { ok: true });
  assert.deepEqual(next.s.save(ID_B, wav(), { limits: LIMITS }), { ok: true });
  assert.equal(next.s.status().key, "ok");
});

test("an empty store makes its first key without complaint", (t) => {
  const h = store(t);
  assert.equal(h.s.status().key, "none");
  assert.deepEqual(h.s.save(ID_A, wav(), { limits: LIMITS }), { ok: true });
  assert.equal(h.s.status().key, "ok");
});

test("a save for an entry already gone from History writes nothing", (t) => {
  const h = store(t);
  assert.deepEqual(h.s.save(ID_A, wav(), { limits: LIMITS, keepIds: new Set([ID_B]) }), { ok: false, error: "deleted" });
  assert.equal(h.s.status().count, 0);
  assert.equal(h.s.status().lastError, null, "a deleted entry is not a failure");
});

test("a clear that can't delete a recording keeps the key and says so; a retry finishes it", (t) => {
  const real = fs;
  let busy = true;
  const flaky = {
    ...real,
    unlinkSync(file) {
      if (busy && String(file).endsWith(ID_A + SUFFIX)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return real.unlinkSync(file);
    },
  };
  const h = store(t, { fs: flaky });
  h.s.save(ID_A, wav(), { limits: LIMITS });
  h.s.save(ID_B, wav(), { limits: LIMITS });
  assert.deepEqual(h.s.clear(), { ok: false, error: "EBUSY" });
  assert.deepEqual(fs.readdirSync(h.dir).sort(), [ID_A + SUFFIX, "key.json"].sort(), "B went, A and its key stay");
  assert.equal(h.s.read(ID_A).ok, true, "what is left is still readable");
  busy = false;
  assert.deepEqual(h.s.clear(), { ok: true });
  assert.deepEqual(fs.readdirSync(h.dir), []);
});

test("a single remove that fails reports it, and a later prune of the orphan finishes it", (t) => {
  const real = fs;
  let busy = true;
  const flaky = {
    ...real,
    unlinkSync(file) {
      if (busy && String(file).endsWith(ID_A + SUFFIX)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return real.unlinkSync(file);
    },
  };
  const h = store(t, { fs: flaky });
  h.s.save(ID_A, wav(), { limits: LIMITS });
  assert.equal(h.s.remove(ID_A), false);
  busy = false;
  assert.deepEqual(h.s.prune({ ...LIMITS, keepIds: new Set() }), [ID_A]);
  assert.equal(h.s.status().count, 0);
});

test("a full budget whose oldest recording can't be deleted keeps the new one out, not over the limit", (t) => {
  const real = fs;
  let held = null;
  const flaky = {
    ...real,
    unlinkSync(file) {
      if (held && String(file).endsWith(held + SUFFIX)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return real.unlinkSync(file);
    },
  };
  const h = store(t, { fs: flaky, now: Date.now() });
  const audio = wav(5);
  const size = seal(audio, crypto.randomBytes(32), ID_A).length;
  const limits = { maxAgeDays: 30, maxMegabytes: (1.5 * size) / (1024 * 1024) }; // room for one
  assert.deepEqual(h.s.save(ID_A, audio, { limits }), { ok: true });
  held = ID_A;
  assert.deepEqual(h.s.save(ID_B, audio, { limits }), { ok: false, error: "over-limit" });
  assert.equal(h.s.status().count, 1);
  assert.ok(h.s.status().bytes <= limits.maxMegabytes * 1024 * 1024);
  assert.equal(h.s.status().lastError.code, "over-limit");
  held = null;
  assert.deepEqual(h.s.save(ID_B, audio, { limits }), { ok: true }, "once it can be deleted, room is made");
  assert.deepEqual(h.s.availability([ID_A, ID_B]), { [ID_A]: null, [ID_B]: "kept" });
});

test("secure storage that goes away mid-session stops reads and saves, despite a cached key", (t) => {
  const h = store(t);
  assert.deepEqual(h.s.save(ID_A, wav(), { limits: LIMITS }), { ok: true });
  assert.equal(h.s.read(ID_A).ok, true, "key now cached");
  h.setSafeStorage(fakeSafeStorage({ backend: "basic_text" }));
  assert.deepEqual(h.s.read(ID_A), { ok: false, error: "insecure" });
  assert.deepEqual(h.s.save(ID_B, wav(), { limits: LIMITS }), { ok: false, error: "insecure" });
  assert.equal(fs.existsSync(path.join(h.dir, ID_B + SUFFIX)), false);
  assert.deepEqual(h.s.availability([ID_A]), { [ID_A]: "unreadable" });
  assert.equal(h.s.status().secure, false);
  // Back again: the same key still works.
  h.setSafeStorage(fakeSafeStorage());
  assert.equal(h.s.read(ID_A).ok, true);
});
