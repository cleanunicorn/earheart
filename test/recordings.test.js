// Retranscription of a kept recording (#343) is session-owned: it never
// delivers, never adds an entry, never replaces the original, and a stale,
// overlapping or cancelled run has a recoverable outcome. Export writes the
// original WAV, atomically.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRetranscriber, exportWav, shouldKeep } = require("../main/recordings");

const ID = "2b0e0a46-2c3f-4b5e-9f00-0123456789ab";
const WAV = Buffer.from("RIFF....WAVE");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(over = {}) {
  const stored = [];
  const calls = { transcribe: 0, clean: 0, settled: 0 };
  let clock = 1_000;
  const r = createRetranscriber({
    read: over.read || (() => ({ ok: true, wav: WAV })),
    transcribe: over.transcribe || (async () => { calls.transcribe++; return { text: "new raw" }; }),
    clean: over.clean || (async (raw) => { calls.clean++; return { text: `Clean ${raw}.`, cleaned: true }; }),
    setRetry: over.setRetry || ((id, retry) => { stored.push({ id, retry }); return { ok: true, stored: true }; }),
    canStart: over.canStart || (() => true),
    now: () => clock,
    onSettled: () => calls.settled++,
  });
  return { r, stored, calls, tick: (ms) => { clock += ms; } };
}

test("a retry stores its result beside the entry and delivers nothing", async () => {
  const { r, stored, calls } = harness();
  const res = await r.run(ID);
  assert.equal(res.ok, true);
  assert.equal(res.stored, true);
  assert.deepEqual(stored, [{ id: ID, retry: { seq: 1000, at: new Date(1000).toISOString(), raw: "new raw", text: "Clean new raw.", cleaned: true, status: "done" } }]);
  assert.equal(calls.transcribe, 1);
  assert.equal(calls.settled, 1);
});

test("overlapping retries: a second while one runs is refused as busy, then works", async () => {
  const gate = deferred();
  const { r, stored } = harness({ transcribe: () => gate.promise });
  const first = r.run(ID);
  assert.equal(r.running(), ID);
  assert.deepEqual(await r.run(ID), { ok: false, error: "busy" });
  assert.deepEqual(await r.run("other"), { ok: false, error: "busy" });
  gate.resolve({ text: "ok" });
  assert.equal((await first).ok, true);
  assert.equal(r.running(), null);
  assert.equal((await r.run(ID)).ok, true);
  assert.equal(stored.length, 2);
  assert.ok(stored[1].retry.seq > stored[0].retry.seq, "later retries always outrank earlier ones");
});

test("seq keeps increasing even when the clock doesn't", async () => {
  const { r, stored } = harness();
  await r.run(ID);
  await r.run(ID);
  assert.equal(stored[1].retry.seq, stored[0].retry.seq + 1);
});

test("refused while a dictation runs", async () => {
  const { r, stored } = harness({ canStart: () => false });
  assert.deepEqual(await r.run(ID), { ok: false, error: "dictating" });
  assert.equal(stored.length, 0);
});

test("missing or unreadable audio is an answer, not a stored failure", async () => {
  for (const error of ["missing", "unreadable"]) {
    const { r, stored, calls } = harness({ read: () => ({ ok: false, error }) });
    assert.deepEqual(await r.run(ID), { ok: false, error });
    assert.equal(stored.length, 0);
    assert.equal(calls.transcribe, 0);
  }
});

test("cancelled by a new dictation: marked cancelled, no text, and retryable", async () => {
  const { r, stored } = harness({
    transcribe: (wav, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  const run = r.run(ID);
  assert.equal(r.cancel(), true);
  const res = await run;
  assert.equal(res.ok, true);
  assert.equal(stored[0].retry.status, "cancelled");
  assert.equal(stored[0].retry.text, undefined);
  assert.equal(r.cancel(), false, "nothing left running");
});

test("a cancel during cleanup still counts as cancelled", async () => {
  let rr;
  const { r, stored } = harness({ clean: async (raw) => { rr.cancel(); return { text: "late", cleaned: true }; } });
  rr = r;
  await r.run(ID);
  assert.equal(stored[0].retry.status, "cancelled");
  assert.equal(stored[0].retry.text, undefined);
});

test("a failed transcription is marked failed with the reason", async () => {
  const { r, stored } = harness({ transcribe: async () => { throw new Error("service down"); } });
  assert.equal((await r.run(ID)).ok, true);
  assert.equal(stored[0].retry.status, "failed");
  assert.equal(stored[0].retry.error, "service down");
});

test("an empty transcript is a done retry with empty text, cleanup skipped", async () => {
  const { r, stored, calls } = harness({ transcribe: async () => ({ text: "" }) });
  await r.run(ID);
  assert.equal(stored[0].retry.status, "done");
  assert.equal(stored[0].retry.text, "");
  assert.equal(calls.clean, 0);
});

test("a partial transcript is marked incomplete", async () => {
  const { r, stored } = harness({ transcribe: async () => ({ text: "some", partial: true }) });
  await r.run(ID);
  assert.equal(stored[0].retry.incomplete, true);
});

test("an entry deleted meanwhile, or a newer result, drops this one; a failed write says so", async () => {
  const dropped = harness({ setRetry: () => ({ ok: true, stored: false }) });
  assert.equal((await dropped.r.run(ID)).stored, false);
  const failing = harness({ setRetry: () => ({ ok: false, error: "EPERM" }) });
  const res = await failing.r.run(ID);
  assert.equal(res.ok, false);
  assert.equal(res.error, "EPERM");
  assert.equal(failing.r.running(), null, "a failed write still frees the next retry");
});

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-export-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("export writes the original WAV bytes to the chosen file", (t) => {
  const dest = path.join(tmp(t), "dictation.wav");
  assert.deepEqual(exportWav(WAV, dest), { ok: true });
  assert.ok(fs.readFileSync(dest).equals(WAV));
});

test("a failed export leaves no partial file and returns the code", (t) => {
  const dir = tmp(t);
  const dest = path.join(dir, "dictation.wav");
  const flaky = { ...fs, renameSync() { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); } };
  assert.deepEqual(exportWav(WAV, dest, flaky), { ok: false, error: "ENOSPC" });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(exportWav(WAV, path.join(dir, "missing-dir", "x.wav")), { ok: false, error: "ENOENT" });
});

// security-1: the folder the user exports into may be writable by others.
// Whatever sits at a temp path there — a symlink to another file, a file —
// is never written through, and a failed export removes only its own file.
const POSIX = { skip: process.platform === "win32" && "POSIX permissions and symlinks" };

// The temp name is random, so plant at whatever name the export picks, just
// before its exclusive create.
const plantingAt = (plant) => ({
  ...fs,
  openSync(file, ...rest) {
    plant(file);
    return fs.openSync(file, ...rest);
  },
});

test("export fails rather than write into a file already at its temp path", (t) => {
  const dir = tmp(t);
  const dest = path.join(dir, "dictation.wav");
  let planted = null;
  const result = exportWav(WAV, dest, plantingAt((file) => {
    planted = file;
    fs.writeFileSync(file, "someone else's");
  }));
  assert.deepEqual(result, { ok: false, error: "EEXIST" });
  assert.equal(fs.readFileSync(planted, "utf8"), "someone else's", "untouched, and not ours to remove");
  assert.equal(fs.existsSync(dest), false, "nothing lands under the chosen name");
});

test("export never writes through a symlink planted at its temp path", POSIX, (t) => {
  const dir = tmp(t);
  const dest = path.join(dir, "dictation.wav");
  const victim = path.join(tmp(t), "victim.txt");
  fs.writeFileSync(victim, "keep me", { mode: 0o644 });
  // The name an export used to pick, planted ahead of time…
  fs.symlinkSync(victim, `${dest}.${process.pid}.tmp`);
  // …and a link at the name it picks now.
  const result = exportWav(WAV, dest, plantingAt((file) => fs.symlinkSync(victim, file)));
  assert.deepEqual(result, { ok: false, error: "EEXIST" });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me", "the symlink's target gets no audio");
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(dest), false, "nothing lands under the chosen name");
  const left = fs.readdirSync(dir);
  assert.equal(left.length, 2);
  assert.ok(left.every((name) => fs.lstatSync(path.join(dir, name)).isSymbolicLink()), "the planted links aren't ours to remove");
});

test("export picks an unpredictable temp name beside the destination", (t) => {
  const dir = tmp(t);
  const dest = path.join(dir, "a.wav");
  const seen = [];
  const recording = plantingAt((file) => seen.push(file));
  assert.deepEqual(exportWav(WAV, dest, recording), { ok: true });
  assert.deepEqual(exportWav(WAV, dest, recording), { ok: true });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.ok(seen.every((file) => path.dirname(file) === dir), "the temp sits beside the destination");
  assert.ok(!seen.includes(`${dest}.${process.pid}.tmp`), "not the old pid-derived name");
  assert.deepEqual(fs.readdirSync(dir), ["a.wav"]);
  assert.ok(fs.readFileSync(dest).equals(WAV));
});

test("an exported file is private to the user", POSIX, (t) => {
  const dest = path.join(tmp(t), "dictation.wav");
  assert.deepEqual(exportWav(WAV, dest), { ok: true });
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
});

test("recordings are kept only when the user opted in and History is on", () => {
  assert.equal(shouldKeep({ recordings: { keep: true }, history: { enabled: true } }), true);
  assert.equal(shouldKeep({ recordings: { keep: false }, history: { enabled: true } }), false);
  assert.equal(shouldKeep({ recordings: { keep: true }, history: { enabled: false } }), false);
  assert.equal(shouldKeep({ history: { enabled: true } }), false);
});
