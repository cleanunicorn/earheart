const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function loadHistory(userData = "/unused") {
  const historyPath = require.resolve("../main/history");
  const electronPath = require.resolve("electron");
  const savedElectron = require.cache[electronPath];
  const electron = new Module(electronPath, null);
  electron.filename = electronPath;
  electron.loaded = true;
  electron.exports = { app: { getPath: () => userData } };
  require.cache[electronPath] = electron;
  delete require.cache[historyPath];
  const history = require(historyPath);
  delete require.cache[historyPath];
  if (savedElectron) require.cache[electronPath] = savedElectron;
  else delete require.cache[electronPath];
  return history;
}

test("history keeps valid transcripts while ignoring malformed rows", () => {
  const { validEntries } = loadHistory();
  const good = { text: "Keep my words", at: "2026-09-10T00:00:00.000Z" };
  assert.deepStrictEqual(
    validEntries([null, 1, "text", {}, { text: 42 }, good]),
    [good]
  );
});

test("history treats a non-array JSON value as empty", () => {
  const { validEntries } = loadHistory();
  assert.deepStrictEqual(validEntries({ text: "not a history list" }), []);
});

test("history preserves a corrupt file before accepting new entries", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "history.json");
  fs.writeFileSync(file, '[{"text":"old words"');
  const history = loadHistory(dir);

  history.add({ text: "new words" }, { enabled: true, limit: 100 });
  await new Promise((resolve) => setImmediate(resolve));

  const backup = fs.readdirSync(dir).find((name) => name.startsWith("history.json.corrupt-"));
  assert.ok(backup, "the unreadable history should be preserved");
  assert.strictEqual(fs.readFileSync(path.join(dir, backup), "utf8"), '[{"text":"old words"');
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].text, "new words");
  assert.match(saved[0].at, /^20\d\d-/);
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("history removes a temp file when the replacement fails", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const history = loadHistory(dir);
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated rename failure");
  };
  try {
    history.add({ text: "not lost" }, { enabled: true, limit: 100 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    fs.renameSync = originalRename;
  }

  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

/* ---- Clear history only clears what it deleted (#287) ---- */

function historyDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const CFG = { enabled: true, limit: 100 };

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`a clear that can't delete the file (${code}) says so and keeps the transcripts`, async (t) => {
    const dir = historyDir(t);
    const history = loadHistory(dir);
    history.add({ text: "keep me" }, CFG);
    await flush();
    const original = fs.unlinkSync;
    fs.unlinkSync = () => {
      throw Object.assign(new Error(`${code}: simulated`), { code });
    };
    let result;
    try {
      result = history.clear();
    } finally {
      fs.unlinkSync = original;
    }
    assert.deepStrictEqual(result, { ok: false, error: code }, "the code, not a message with the user's path");
    assert.deepStrictEqual(history.list().map((e) => e.text), ["keep me"], "still shown, for a retry");
    assert.deepStrictEqual(loadHistory(dir).list().map((e) => e.text), ["keep me"], "and still on disk");
  });
}

test("a successful clear stays cleared after a restart", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "gone" }, CFG);
  await flush();
  assert.deepStrictEqual(history.clear(), { ok: true });
  assert.deepStrictEqual(history.list(), []);
  assert.deepStrictEqual(loadHistory(dir).list(), []);
});

test("clearing a history that was never written succeeds", (t) => {
  const history = loadHistory(historyDir(t));
  assert.deepStrictEqual(history.clear(), { ok: true });
  assert.deepStrictEqual(history.list(), []);
});

test("a clear cancels the pending write, so it can't bring the entries back", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "never written" }, CFG);
  assert.deepStrictEqual(history.clear(), { ok: true }); // before the flush runs
  await flush();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.deepStrictEqual(loadHistory(dir).list(), []);
});

test("a failed clear keeps the pending write, so the entry still reaches disk", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "first" }, CFG);
  await flush();
  history.add({ text: "pending" }, CFG);
  const original = fs.unlinkSync;
  fs.unlinkSync = () => {
    throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" });
  };
  try {
    assert.strictEqual(history.clear().ok, false);
  } finally {
    fs.unlinkSync = original;
  }
  await flush();
  assert.deepStrictEqual(loadHistory(dir).list().map((e) => e.text), ["pending", "first"]);
});

/* ---- Stable entry ids (#342; the contract #343 builds on) ---- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("add stamps each entry with a UUID and returns it", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  const first = history.add({ text: "one" }, CFG);
  const second = history.add({ text: "two" }, CFG);
  assert.match(first, UUID);
  assert.match(second, UUID);
  assert.notStrictEqual(first, second);
  await flush();
  assert.deepStrictEqual(loadHistory(dir).list().map((e) => e.id), [second, first], "the ids survive a restart");
});

test("add keeps a caller's own UUID and replaces any other id", (t) => {
  const history = loadHistory(historyDir(t));
  const session = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.strictEqual(history.add({ id: session, text: "one" }, CFG), session);
  const again = history.add({ id: session, text: "reused" }, CFG);
  assert.match(again, UUID);
  assert.notStrictEqual(again, session, "no two entries ever share an id");
  // Only a UUID v4: a short or guessable id from a caller is not one it
  // generated fresh for this session.
  for (const id of ["session-1", "", "has space", "../escape", "x".repeat(65), session.toUpperCase(), "0f8fad5b-d9cb-169f-a165-70867728950e", 42, null]) {
    const stored = history.add({ id, text: "bad id" }, CFG);
    assert.match(stored, UUID, JSON.stringify(id));
    assert.notStrictEqual(stored, id);
  }
  assert.strictEqual(new Set(history.list().map((e) => e.id)).size, history.list().length);
});

test("add returns null and stores nothing with History off", (t) => {
  const history = loadHistory(historyDir(t));
  assert.strictEqual(history.add({ text: "private" }, { enabled: false, limit: 100 }), null);
  assert.deepStrictEqual(history.list(), []);
});

test("rows saved before ids existed load unchanged and get ids that stick", async (t) => {
  const dir = historyDir(t);
  const file = path.join(dir, "history.json");
  const legacy = [
    { raw: "uh newest", text: "Newest.", cleaned: true, at: "2026-09-12T00:00:00.000Z" },
    { text: "Middle", at: "2026-09-11T00:00:00.000Z", incomplete: true },
    { id: "keep-this", text: "Has an id", at: "2026-09-10T00:00:00.000Z" },
    { id: "keep-this", text: "Duplicate id", at: "2026-09-09T00:00:00.000Z" },
    { id: "bad id!", text: "Malformed id", at: "2026-09-08T00:00:00.000Z" },
  ];
  fs.writeFileSync(file, JSON.stringify(legacy));
  const history = loadHistory(dir);
  const loaded = history.list();
  assert.deepStrictEqual(
    loaded.map(({ id, ...rest }) => rest),
    legacy.map(({ id, ...rest }) => rest),
    "every field but the id is as it was, in the same order"
  );
  assert.strictEqual(loaded[2].id, "keep-this");
  for (const i of [0, 1, 3, 4]) assert.match(loaded[i].id, UUID);
  assert.strictEqual(new Set(loaded.map((e) => e.id)).size, legacy.length, "ids are unique");

  await flush(); // the migration is written once
  const reloaded = loadHistory(dir).list();
  assert.deepStrictEqual(reloaded.map((e) => e.id), loaded.map((e) => e.id), "same ids after a restart");
});

test("a history whose rows all have ids is not rewritten on load", async (t) => {
  const dir = historyDir(t);
  const file = path.join(dir, "history.json");
  const body = JSON.stringify([{ id: "a", text: "one", at: "2026-09-10T00:00:00.000Z" }]);
  fs.writeFileSync(file, body);
  const history = loadHistory(dir);
  history.list();
  await flush();
  assert.strictEqual(fs.readFileSync(file, "utf8"), body);
});

/* ---- Search ---- */

function seeded(t, texts) {
  const history = loadHistory(historyDir(t));
  // add() puts the newest first; seed oldest → newest so the list reads as given.
  for (const entry of [...texts].reverse()) history.add(typeof entry === "string" ? { text: entry } : entry, CFG);
  return history;
}
const texts = (result) => result.entries.map((e) => e.text);

test("search ignores case, including outside ASCII", (t) => {
  const history = seeded(t, ["Deploy the APP", "ÉCOLE normale", "Straße", "ΟΔΟΣ", "nothing here"]);
  assert.deepStrictEqual(texts(history.search({ query: "deploy the app" })), ["Deploy the APP"]);
  assert.deepStrictEqual(texts(history.search({ query: "école" })), ["ÉCOLE normale"]);
  assert.deepStrictEqual(texts(history.search({ query: "STRASSE" })), [], "ß is not expanded: matching stays literal");
  assert.deepStrictEqual(texts(history.search({ query: "straße" })), ["Straße"]);
  assert.deepStrictEqual(texts(history.search({ query: "οδοσ" })), ["ΟΔΟΣ"], "a word-final ς matches σ");
});

test("search matches composed and decomposed forms alike, but not unaccented ones", (t) => {
  const composed = "café au lait";
  const decomposed = "café noir";
  const history = seeded(t, [composed, decomposed, "cafe plain", "ＡＢＣ full width"]);
  assert.deepStrictEqual(texts(history.search({ query: "café" })), [composed, decomposed]);
  assert.deepStrictEqual(texts(history.search({ query: "café" })), [composed, decomposed]);
  assert.deepStrictEqual(texts(history.search({ query: "cafe" })), ["cafe plain"], "accents are not stripped");
  assert.deepStrictEqual(texts(history.search({ query: "abc" })), ["ＡＢＣ full width"]);
});

test("search needs every term, in any order, in the text or the original", (t) => {
  const history = seeded(t, [
    { text: "Run the migration.", raw: "um run the uh migration" },
    { text: "Run the tests" },
    { text: "🚀 ship it" },
  ]);
  assert.deepStrictEqual(texts(history.search({ query: "  migration   RUN " })), ["Run the migration."]);
  assert.deepStrictEqual(texts(history.search({ query: "uh migration" })), ["Run the migration."], "the pre-cleanup words count");
  assert.deepStrictEqual(texts(history.search({ query: "run" })), ["Run the migration.", "Run the tests"]);
  assert.deepStrictEqual(texts(history.search({ query: "🚀" })), ["🚀 ship it"]);
  assert.deepStrictEqual(texts(history.search({ query: "run ship" })), []);
});

test("an empty or blank query lists everything, newest first", (t) => {
  const history = seeded(t, ["c", "b", "a"]);
  for (const query of [undefined, "", "   \n\t"]) {
    const result = history.search(query === undefined ? {} : { query });
    assert.deepStrictEqual(texts(result), ["c", "b", "a"]);
    assert.deepStrictEqual([result.total, result.all], [3, 3]);
  }
  assert.deepStrictEqual(texts(history.search()), ["c", "b", "a"]);
});

test("search pages through the matches, not the whole list", (t) => {
  const history = seeded(t, ["match 1", "other", "match 2", "match 3", "other", "match 4", "match 5"]);
  const page = (offset) => history.search({ query: "match", offset, limit: 2 });
  assert.deepStrictEqual(texts(page(0)), ["match 1", "match 2"]);
  assert.deepStrictEqual(texts(page(2)), ["match 3", "match 4"]);
  assert.deepStrictEqual(texts(page(4)), ["match 5"]);
  assert.deepStrictEqual([page(4).total, page(4).all, page(4).offset], [5, 7, 4]);
});

test("an offset past the matches falls back to the last page, and no match is an empty page", (t) => {
  const history = seeded(t, ["a1", "a2", "a3", "b"]);
  const past = history.search({ query: "a", offset: 40, limit: 2 });
  assert.deepStrictEqual([texts(past), past.offset], [["a3"], 2]);
  const none = history.search({ query: "zzz", offset: 4, limit: 2 });
  assert.deepStrictEqual([none.entries, none.total, none.offset, none.all], [[], 0, 0, 4]);
});

test("search bounds what one request can ask for", (t) => {
  const history = seeded(t, Array.from({ length: 70 }, (_, i) => `entry ${i}`));
  assert.strictEqual(history.search({ limit: 1000 }).entries.length, history.MAX_PAGE);
  assert.strictEqual(history.search({ limit: 0 }).limit, 1);
  for (const limit of [2.5, "10", NaN, null]) assert.strictEqual(history.search({ limit }).limit, 20, String(limit));
  for (const offset of [-5, 1.5, "3", NaN]) assert.strictEqual(history.search({ offset }).offset, 0, String(offset));
  // Only the first MAX_QUERY characters are searched for.
  const long = `entry 1${" ".repeat(history.MAX_QUERY)}no-such-word`;
  assert.ok(history.search({ query: long }).total > 0);
  assert.throws(() => history.search({ query: 42 }), TypeError);
});

/* ---- Delete one entry ---- */

test("deleting one entry keeps its neighbours, in order, after a restart", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "oldest", raw: "oldest raw", cleaned: true }, CFG);
  const middle = history.add({ text: "private" }, CFG);
  history.add({ text: "newest", incomplete: true }, CFG);
  await flush();
  const before = history.list().filter((e) => e.id !== middle).map((e) => ({ ...e }));

  assert.deepStrictEqual(history.remove(middle), { ok: true, removed: true });
  assert.deepStrictEqual(history.list(), before);
  assert.deepStrictEqual(loadHistory(dir).list(), before, "the delete is on disk");
  assert.deepStrictEqual(history.search({ query: "private" }).total, 0);
});

test("deleting an id History doesn't have changes nothing", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "keep" }, CFG);
  await flush();
  const body = fs.readFileSync(path.join(dir, "history.json"), "utf8");
  for (const id of ["missing", "", undefined, 42]) {
    assert.deepStrictEqual(history.remove(id), { ok: true, removed: false });
  }
  assert.strictEqual(fs.readFileSync(path.join(dir, "history.json"), "utf8"), body);
});

for (const code of ["EPERM", "EBUSY", "ENOSPC"]) {
  test(`a delete that can't write the file (${code}) says so and keeps the entry`, async (t) => {
    const dir = historyDir(t);
    const history = loadHistory(dir);
    const id = history.add({ text: "keep me" }, CFG);
    history.add({ text: "neighbour" }, CFG);
    await flush();
    const original = fs.renameSync;
    fs.renameSync = () => {
      throw Object.assign(new Error(`${code}: simulated, with /home/someone/path`), { code });
    };
    let result;
    try {
      result = history.remove(id);
    } finally {
      fs.renameSync = original;
    }
    assert.deepStrictEqual(result, { ok: false, error: code }, "the code, not a message with the user's path");
    assert.deepStrictEqual(history.list().map((e) => e.text), ["neighbour", "keep me"], "still shown, for a retry");
    assert.deepStrictEqual(loadHistory(dir).list().map((e) => e.text), ["neighbour", "keep me"], "and still on disk");
    assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp file left");
    assert.deepStrictEqual(history.remove(id), { ok: true, removed: true }, "a retry works once the file is free");
  });
}

test("a delete before the pending write lands can't be undone by that write", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "kept" }, CFG);
  const id = history.add({ text: "deleted" }, CFG);
  assert.deepStrictEqual(history.remove(id), { ok: true, removed: true }); // before the flush runs
  history.add({ text: "after" }, CFG); // queues another write
  await flush();
  await flush();
  assert.deepStrictEqual(loadHistory(dir).list().map((e) => e.text), ["after", "kept"]);
});

test("a failed delete keeps the pending write, so queued entries still reach disk", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  const id = history.add({ text: "first" }, CFG);
  await flush();
  history.add({ text: "pending" }, CFG);
  const original = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" });
  };
  try {
    assert.strictEqual(history.remove(id).ok, false);
  } finally {
    fs.renameSync = original;
  }
  await flush();
  assert.deepStrictEqual(loadHistory(dir).list().map((e) => e.text), ["pending", "first"]);
});

// Retranscription results (#343) sit beside the original, never over it.
test("setRetry keeps the original transcript and the entry count", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  const cfg = { enabled: true, limit: 100 };
  const id = history.add({ raw: "orig raw", text: "Orig text.", cleaned: true }, cfg);
  history.add({ raw: "other", text: "other", cleaned: false }, cfg);
  const before = history.list().find((e) => e.id === id);
  const retry = { seq: 1, at: "2026-11-04T10:00:00.000Z", status: "done", raw: "new raw", text: "New text.", cleaned: true };
  assert.deepStrictEqual(history.setRetry(id, retry), { ok: true, stored: true });
  const after = history.list().find((e) => e.id === id);
  assert.strictEqual(history.list().length, 2, "a retry is not a new dictation");
  for (const field of ["raw", "text", "cleaned", "at", "id"]) assert.strictEqual(after[field], before[field], field);
  assert.deepStrictEqual(after.retry, retry);
  // Durable across a restart.
  assert.deepStrictEqual(loadHistory(dir).list().find((e) => e.id === id).retry, retry);
});

test("an older retry finishing late can't overwrite a newer result", (t) => {
  const history = loadHistory(historyDir(t));
  const id = history.add({ raw: "a", text: "a", cleaned: false }, { enabled: true, limit: 100 });
  assert.strictEqual(history.setRetry(id, { seq: 5, status: "done", text: "newer" }).stored, true);
  assert.deepStrictEqual(history.setRetry(id, { seq: 4, status: "done", text: "older" }), { ok: true, stored: false });
  assert.strictEqual(history.list()[0].retry.text, "newer");
  assert.strictEqual(history.setRetry(id, { seq: 6, status: "failed", error: "x" }).stored, true);
});

test("a retry for a deleted entry is dropped; a failed write changes nothing", (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  const id = history.add({ raw: "a", text: "a", cleaned: false }, { enabled: true, limit: 100 });
  assert.deepStrictEqual(history.setRetry("4a1b2c3d-0000-4000-8000-000000000000", { seq: 1, status: "done" }), { ok: true, stored: false });
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
  t.after(() => { fs.renameSync = realRename; });
  assert.deepStrictEqual(history.setRetry(id, { seq: 1, status: "done", text: "x" }), { ok: false, error: "EPERM" });
  fs.renameSync = realRename;
  assert.strictEqual(history.list()[0].retry, undefined);
  history.remove(id);
  assert.deepStrictEqual(history.setRetry(id, { seq: 2, status: "done" }), { ok: true, stored: false });
});
