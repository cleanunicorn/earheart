// Local usage statistics (main/usage.js, #347): counting, the summary maths
// (no Infinity/NaN, never a negative estimate), streaks on local calendar
// days across DST, persistence, and every way a usage file can be damaged.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stubModules } = require("./helpers/stub-modules");

const USAGE = require.resolve("../main/usage");
const ELECTRON = require.resolve("electron");
const LOGGER = require.resolve("../main/util/logger");

const flush = () => new Promise((resolve) => setImmediate(resolve));

// What the cache held before any stub, so every test's cleanup restores the
// same thing whatever order several loads in one test unwind in.
const ORIGINAL = { [ELECTRON]: require.cache[ELECTRON], [LOGGER]: require.cache[LOGGER] };
function restoreOriginal() {
  for (const [p, entry] of Object.entries(ORIGINAL)) {
    if (entry) require.cache[p] = entry;
    else delete require.cache[p];
  }
}

// A fresh main/usage.js whose userData is `dir`. Electron is required lazily
// (inside usagePath()), so the stub stays installed until the test ends.
function loadUsage(t, dir) {
  const warnings = [];
  stubModules({
    [ELECTRON]: { app: { getPath: () => dir } },
    [LOGGER]: { info() {}, warn: (...a) => warnings.push(a.join(" ")), error() {} },
  });
  delete require.cache[USAGE];
  const usage = require(USAGE);
  // Let a deferred write land before the stubs go: it resolves userData
  // when it runs, and must not land in the next test's directory.
  t.after(async () => {
    await flush();
    delete require.cache[USAGE];
    restoreOriginal();
  });
  usage.warnings = warnings;
  // A new launch against the same userData and stubs.
  usage.reload = () => {
    delete require.cache[USAGE];
    return Object.assign(require(USAGE), { warnings });
  };
  return usage;
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);
const readFile = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf8"));
const pure = require("../main/usage");

test("usage: a take adds one take, its words and its duration, to today and the totals", async (t) => {
  const dir = tmpDir(t);
  const usage = loadUsage(t, dir);
  const now = at(2026, 11, 5);
  assert.strictEqual(usage.record({ takeId: 1, words: 12, speechMs: 6000.4, now }), true);
  assert.strictEqual(usage.record({ takeId: 2, words: 8, speechMs: 4000, now }), true);
  const s = usage.summary({ now });
  assert.deepStrictEqual(s.totals, { takes: 2, words: 20, speechMs: 10000 });
  assert.deepStrictEqual(s.days[0], { date: "2026-11-05", takes: 2, words: 20, speechMs: 10000 });
  assert.strictEqual(s.since, "2026-11-05");

  await flush();
  const saved = readFile(dir);
  assert.deepStrictEqual(saved, {
    version: 1,
    since: "2026-11-05",
    totals: { takes: 2, words: 20, speechMs: 10000 },
    days: { "2026-11-05": { takes: 2, words: 20, speechMs: 10000 } },
  });
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(path.join(dir, "usage.json")).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("usage: the file holds counts only, never text", async (t) => {
  const dir = tmpDir(t);
  const usage = loadUsage(t, dir);
  // Even a caller that passes text along can't get it written.
  usage.record({ takeId: "a", words: 3, speechMs: 1500, text: "secret words", raw: "secret raw" });
  await flush();
  const body = fs.readFileSync(path.join(dir, "usage.json"), "utf8");
  assert.doesNotMatch(body, /secret|"text"|"raw"/);
});

test("usage: one take id counts once, and disabled counts nothing but keeps the numbers", (t) => {
  const usage = loadUsage(t, tmpDir(t));
  const now = at(2026, 11, 5);
  assert.strictEqual(usage.record({ takeId: 7, words: 5, speechMs: 2000, now }), true);
  assert.strictEqual(usage.record({ takeId: 7, words: 5, speechMs: 2000, now }), false, "same take again");
  assert.strictEqual(usage.record({ takeId: 8, words: 5, speechMs: 2000, now }, { enabled: false }), false);
  assert.deepStrictEqual(usage.summary({ now }).totals, { takes: 1, words: 5, speechMs: 2000 });
  // Counting resumes when enabled again; the disabled take id was never seen.
  assert.strictEqual(usage.record({ takeId: 8, words: 1, speechMs: 500, now }, { enabled: true }), true);
  assert.strictEqual(usage.summary({ now }).totals.takes, 2);
});

test("usage: bad words and durations count as 0, never NaN or Infinity", (t) => {
  const usage = loadUsage(t, tmpDir(t));
  const now = at(2026, 11, 5);
  usage.record({ takeId: 1, words: 0, speechMs: NaN, now });
  usage.record({ takeId: 2, words: -4, speechMs: -5, now });
  usage.record({ takeId: 3, words: "many", speechMs: Infinity, now });
  const s = usage.summary({ now });
  assert.deepStrictEqual(s.totals, { takes: 3, words: 0, speechMs: 0 });
  assert.strictEqual(s.avgWpm, null);
  assert.strictEqual(s.timeSavedMs, 0);
});

test("usage: countWords splits on any whitespace", () => {
  assert.strictEqual(pure.countWords("  Run the\ttests\nnow  "), 4);
  assert.strictEqual(pure.countWords(""), 0);
  assert.strictEqual(pure.countWords("   "), 0);
  assert.strictEqual(pure.countWords(null), 0);
  assert.strictEqual(pure.countWords("naïve café déjà"), 3);
});

test("usage: summarize — empty, no speech time, slower than typing, the baseline applied", () => {
  const now = at(2026, 11, 5);
  const state = (totals) => ({ since: "2026-11-05", totals, days: {}, readOnly: false });

  const empty = pure.summarize(state({ takes: 0, words: 0, speechMs: 0 }), { now });
  assert.strictEqual(empty.avgWpm, null);
  assert.strictEqual(empty.timeSavedMs, null);
  assert.strictEqual(empty.typingWpm, 40);

  // Words but no measurable speech: no WPM (would be Infinity), still an estimate.
  const noSpeech = pure.summarize(state({ takes: 1, words: 40, speechMs: 0 }), { now });
  assert.strictEqual(noSpeech.avgWpm, null);
  assert.strictEqual(noSpeech.timeSavedMs, 60000);
  assert.strictEqual(pure.summarize(state({ takes: 1, words: 40, speechMs: 999 }), { now }).avgWpm, null);

  // 120 words in 60 s: 120 WPM; typing at 40 takes 3 min, so 2 min saved.
  const fast = pure.summarize(state({ takes: 2, words: 120, speechMs: 60000 }), { now });
  assert.strictEqual(fast.avgWpm, 120);
  assert.strictEqual(fast.timeSavedMs, 120000);
  // At 60 WPM typing takes 2 min: 1 min saved.
  assert.strictEqual(pure.summarize(state({ takes: 2, words: 120, speechMs: 60000 }), { now, typingWpm: 60 }).timeSavedMs, 60000);

  // Speaking slower than typing never shows a negative saving.
  const slow = pure.summarize(state({ takes: 1, words: 10, speechMs: 60000 }), { now });
  assert.strictEqual(slow.avgWpm, 10);
  assert.strictEqual(slow.timeSavedMs, 0);

  // The baseline is clamped to 10–200 and defaults to 40.
  assert.strictEqual(pure.summarize(state({ takes: 0, words: 0, speechMs: 0 }), { now, typingWpm: 5 }).typingWpm, 10);
  assert.strictEqual(pure.summarize(state({ takes: 0, words: 0, speechMs: 0 }), { now, typingWpm: 900 }).typingWpm, 200);
  assert.strictEqual(pure.summarize(state({ takes: 0, words: 0, speechMs: 0 }), { now, typingWpm: NaN }).typingWpm, 40);
});

test("usage: the last N days are zero-filled, newest first", () => {
  const now = at(2026, 11, 5);
  const state = {
    since: "2026-11-01",
    totals: { takes: 3, words: 30, speechMs: 9000 },
    days: { "2026-11-05": { takes: 1, words: 10, speechMs: 3000 }, "2026-11-01": { takes: 2, words: 20, speechMs: 6000 } },
    readOnly: false,
  };
  const s = pure.summarize(state, { now, days: 14 });
  assert.strictEqual(s.days.length, 14);
  assert.deepStrictEqual(s.days.map((d) => d.date).slice(0, 5), ["2026-11-05", "2026-11-04", "2026-11-03", "2026-11-02", "2026-11-01"]);
  assert.strictEqual(s.days[1].takes, 0);
  assert.strictEqual(s.days[4].words, 20);
  assert.strictEqual(s.days[13].date, "2026-10-23");
});

test("usage: streaks — today and yesterday, a gap, today not yet dictated, the longest", () => {
  const day = (takes = 1) => ({ takes, words: 1, speechMs: 1000 });
  const state = (keys) => ({ since: null, totals: { takes: 1, words: 1, speechMs: 1000 }, days: Object.fromEntries(keys.map((k) => [k, day()])), readOnly: false });
  const streak = (keys, now) => pure.summarize(state(keys), { now }).streak;

  assert.deepStrictEqual(streak(["2026-11-04", "2026-11-05"], at(2026, 11, 5)), { current: 2, longest: 2 });
  assert.deepStrictEqual(streak(["2026-11-03", "2026-11-05"], at(2026, 11, 5)), { current: 1, longest: 1 });
  // Nothing yet today: yesterday's streak is still alive.
  assert.deepStrictEqual(streak(["2026-11-03", "2026-11-04"], at(2026, 11, 5)), { current: 2, longest: 2 });
  // Two days without a take: it's over.
  assert.deepStrictEqual(streak(["2026-11-02", "2026-11-03"], at(2026, 11, 5)), { current: 0, longest: 2 });
  // Longest across history, over a month and year boundary.
  assert.deepStrictEqual(
    streak(["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-11-05"], at(2026, 11, 5)),
    { current: 1, longest: 4 }
  );
  // An empty bucket (takes 0) is not a day with a take.
  const withEmpty = state(["2026-11-04", "2026-11-05"]);
  withEmpty.days["2026-11-04"].takes = 0;
  assert.deepStrictEqual(pure.summarize(withEmpty, { now: at(2026, 11, 5) }).streak, { current: 1, longest: 1 });
});

test("usage: addDays steps calendar days; isDayKey rejects impossible dates", () => {
  assert.strictEqual(pure.addDays("2026-02-28", 1), "2026-03-01");
  assert.strictEqual(pure.addDays("2028-02-28", 1), "2028-02-29");
  assert.strictEqual(pure.addDays("2026-01-01", -1), "2025-12-31");
  assert.strictEqual(pure.addDays("nope", 1), null);
  assert.ok(pure.isDayKey("2026-11-05"));
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-5", "20261105", "", null, 20261105]) {
    assert.ok(!pure.isDayKey(bad), String(bad));
  }
});

// Time zones run in a child process with TZ set, so no zone state leaks into
// the rest of this suite.
function inZone(tz, code) {
  const script = `const u = require(${JSON.stringify(USAGE)}); const out = (${code})(u); process.stdout.write(JSON.stringify(out));`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, TZ: tz }, timeout: 20000 });
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("usage: days are the LOCAL date, not the UTC one", () => {
  // 12:00 UTC on 5 Nov is 01:00 on 6 Nov in Auckland (UTC+13).
  assert.strictEqual(inZone("Pacific/Auckland", `(u) => u.localDayKey(new Date("2026-11-05T12:00:00Z"))`), "2026-11-06");
  // 04:30 UTC on 6 Nov is 23:30 on 5 Nov in New York (UTC-5).
  assert.strictEqual(inZone("America/New_York", `(u) => u.localDayKey(new Date("2026-11-06T04:30:00Z"))`), "2026-11-05");
});

test("usage: a streak survives the 23 h and 25 h days of a DST change", () => {
  const result = inZone(
    "America/New_York",
    `(u) => {
      const s = { since: null, totals: { takes: 3, words: 3, speechMs: 3000 }, readOnly: false, days: {} };
      const out = {};
      for (const [name, keys, now] of [
        ["spring", ["2026-03-07", "2026-03-08", "2026-03-09"], new Date(2026, 2, 9, 0, 30)],
        ["fall", ["2026-10-31", "2026-11-01", "2026-11-02"], new Date(2026, 10, 2, 23, 30)],
      ]) {
        s.days = Object.fromEntries(keys.map((k) => [k, { takes: 1, words: 1, speechMs: 1000 }]));
        const sum = u.summarize(s, { now, days: 3 });
        out[name] = { streak: sum.streak, days: sum.days.map((d) => d.date), today: u.localDayKey(now) };
      }
      return out;
    }`
  );
  assert.deepStrictEqual(result.spring, { streak: { current: 3, longest: 3 }, days: ["2026-03-09", "2026-03-08", "2026-03-07"], today: "2026-03-09" });
  assert.deepStrictEqual(result.fall, { streak: { current: 3, longest: 3 }, days: ["2026-11-02", "2026-11-01", "2026-10-31"], today: "2026-11-02" });
});

test("usage: counts survive a restart and keep counting with History off", async (t) => {
  const dir = tmpDir(t);
  const first = loadUsage(t, dir);
  first.record({ takeId: 1, words: 10, speechMs: 5000, now: at(2026, 11, 4) }, { enabled: true });
  await flush();
  const second = first.reload();
  second.record({ takeId: 1, words: 6, speechMs: 3000, now: at(2026, 11, 5) }, { enabled: true });
  const s = second.summary({ now: at(2026, 11, 5) });
  assert.deepStrictEqual(s.totals, { takes: 2, words: 16, speechMs: 8000 }, "a new launch's take ids start fresh");
  assert.strictEqual(s.since, "2026-11-04");
  assert.deepStrictEqual(s.streak, { current: 2, longest: 2 });
});

test("usage: reset empties the counts, starts from today, and stays empty after a restart", async (t) => {
  const dir = tmpDir(t);
  const usage = loadUsage(t, dir);
  const changes = [];
  usage.onChanged(() => changes.push("changed"));
  usage.record({ takeId: 1, words: 10, speechMs: 5000, now: at(2026, 11, 1) });
  // A write still pending when Reset lands must not bring the old counts back.
  assert.deepStrictEqual(usage.reset(at(2026, 11, 5)), { ok: true });
  await flush();
  assert.deepStrictEqual(changes, ["changed", "changed"]);
  assert.deepStrictEqual(readFile(dir), { version: 1, since: "2026-11-05", totals: { takes: 0, words: 0, speechMs: 0 }, days: {} });
  const again = usage.reload().summary({ now: at(2026, 11, 5) });
  assert.deepStrictEqual(again.totals, { takes: 0, words: 0, speechMs: 0 });
  assert.strictEqual(again.since, "2026-11-05");
  assert.strictEqual(again.timeSavedMs, null);
});

test("usage: a reset the disk refuses keeps the counts and says why", async (t) => {
  const dir = tmpDir(t);
  const usage = loadUsage(t, dir);
  usage.record({ takeId: 1, words: 10, speechMs: 5000 });
  await flush();
  const before = fs.readFileSync(path.join(dir, "usage.json"), "utf8");
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error("simulated"), { code: "EACCES" });
  };
  let result;
  try {
    result = usage.reset();
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepStrictEqual(result, { ok: false, error: "EACCES" });
  assert.strictEqual(usage.summary().totals.takes, 1, "memory not cleared");
  assert.strictEqual(fs.readFileSync(path.join(dir, "usage.json"), "utf8"), before);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("usage: a write failure is logged, never thrown at the caller", async (t) => {
  const dir = tmpDir(t);
  const usage = loadUsage(t, dir);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = () => {
    throw new Error("disk full");
  };
  try {
    assert.strictEqual(usage.record({ takeId: 1, words: 2, speechMs: 1000 }), true);
    await flush();
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.ok(usage.warnings.some((w) => /usage stats write failed: disk full/.test(w)));
  assert.strictEqual(usage.summary().totals.takes, 1);
});

test("usage: a corrupt file is kept aside and counting starts again", async (t) => {
  for (const body of ['{"version":1,"totals":', "[1,2,3]", "42", "null"]) {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, "usage.json"), body);
    const usage = loadUsage(t, dir);
    assert.deepStrictEqual(usage.summary().totals, { takes: 0, words: 0, speechMs: 0 }, body);
    const backup = fs.readdirSync(dir).find((n) => n.startsWith("usage.json.corrupt-"));
    assert.ok(backup, `${body}: preserved`);
    assert.strictEqual(fs.readFileSync(path.join(dir, backup), "utf8"), body);
    usage.record({ takeId: 1, words: 1, speechMs: 1000 });
    await flush();
    assert.strictEqual(readFile(dir).totals.takes, 1, body);
  }
});

test("usage: an old or hand-edited file is sanitized field by field and saved as v1", async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(
    path.join(dir, "usage.json"),
    JSON.stringify({
      totals: { takes: 4, words: "lots", speechMs: -1 },
      days: {
        "2026-11-04": { takes: 2, words: 20.6, speechMs: 9000 },
        "2026-02-30": { takes: 1, words: 1, speechMs: 1 },
        yesterday: { takes: 1 },
        "2026-11-03": [1, 2],
        "2026-11-02": { takes: 0, words: 5 },
      },
    })
  );
  const usage = loadUsage(t, dir);
  const s = usage.summary({ now: at(2026, 11, 5) });
  assert.deepStrictEqual(s.totals, { takes: 4, words: 0, speechMs: 0 });
  assert.strictEqual(s.since, "2026-11-04", "since falls back to the earliest day");
  assert.strictEqual(s.readOnly, false);
  usage.record({ takeId: 1, words: 1, speechMs: 1000, now: at(2026, 11, 5) });
  await flush();
  const saved = readFile(dir);
  assert.strictEqual(saved.version, 1);
  assert.deepStrictEqual(Object.keys(saved.days).sort(), ["2026-11-04", "2026-11-05"]);
  assert.deepStrictEqual(saved.days["2026-11-04"], { takes: 2, words: 21, speechMs: 9000 });
});

test("usage: a newer version's file is shown but never counted into or overwritten", async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "usage.json");
  const body = JSON.stringify({ version: 2, since: "2026-01-01", totals: { takes: 9, words: 90, speechMs: 60000 }, days: {}, extra: { x: 1 } });
  fs.writeFileSync(file, body);
  const usage = loadUsage(t, dir);
  assert.strictEqual(usage.record({ takeId: 1, words: 5, speechMs: 1000 }), false);
  await flush();
  assert.strictEqual(fs.readFileSync(file, "utf8"), body, "bytes untouched");
  const s = usage.summary();
  assert.strictEqual(s.readOnly, "newer");
  assert.deepStrictEqual(s.totals, { takes: 9, words: 90, speechMs: 60000 });
  // Reset is an explicit choice, so it may replace it.
  assert.deepStrictEqual(usage.reset(at(2026, 11, 5)), { ok: true });
  assert.strictEqual(readFile(dir).version, 1);
  assert.strictEqual(usage.record({ takeId: 2, words: 5, speechMs: 1000 }), true);
});

test("usage: a file it can't read is left alone for the session", async (t) => {
  const dir = tmpDir(t);
  // A directory where the file should be: reading fails with EISDIR, not ENOENT.
  fs.mkdirSync(path.join(dir, "usage.json"));
  const usage = loadUsage(t, dir);
  assert.strictEqual(usage.summary().readOnly, "unreadable");
  assert.strictEqual(usage.record({ takeId: 1, words: 5, speechMs: 1000 }), false);
  await flush();
  assert.ok(fs.statSync(path.join(dir, "usage.json")).isDirectory());
});

test("usage: at most 3660 day buckets are kept, oldest dropped, totals unchanged", async (t) => {
  const days = {};
  let key = "2016-01-01";
  for (let i = 0; i < 3700; i++) {
    days[key] = { takes: 1, words: 1, speechMs: 1000 };
    key = pure.addDays(key, 1);
  }
  const state = pure.sanitize({ version: 1, since: "2016-01-01", totals: { takes: 3700, words: 3700, speechMs: 3700000 }, days });
  const kept = Object.keys(state.days).sort();
  assert.strictEqual(kept.length, pure.MAX_DAYS);
  assert.strictEqual(kept[0], pure.addDays("2016-01-01", 40));
  assert.strictEqual(state.totals.takes, 3700);
  assert.strictEqual(state.since, "2016-01-01");

  // And a record past the bound drops the oldest live.
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify({ version: 1, since: "2016-01-01", totals: state.totals, days: state.days }));
  const usage = loadUsage(t, dir);
  usage.record({ takeId: 1, words: 1, speechMs: 1000, now: at(2027, 1, 1) });
  await flush();
  const saved = readFile(dir);
  assert.strictEqual(Object.keys(saved.days).length, pure.MAX_DAYS);
  assert.strictEqual(saved.totals.takes, 3701);
});

test("usage: a listener that throws doesn't stop the count", (t) => {
  const usage = loadUsage(t, tmpDir(t));
  usage.onChanged(() => {
    throw new Error("window gone");
  });
  assert.strictEqual(usage.record({ takeId: 1, words: 1, speechMs: 1000 }), true);
  assert.strictEqual(usage.summary().totals.takes, 1);
});

test("usage: main/usage.js has no network access", () => {
  const source = fs.readFileSync(USAGE, "utf8");
  const required = [...new Set([...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]))].sort();
  assert.deepStrictEqual(required, ["./settings", "./util/logger", "./windows", "electron", "node:fs", "node:path"]);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bnet\b\.|XMLHttpRequest|WebSocket/);
});
