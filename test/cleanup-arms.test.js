// Tests for the cleanup A/B harness's arm table (scripts/cleanup-arms.js).
//
// scripts/eval-cleanup.mjs needs a multi-GB model, so the parts of it that can
// waste a run are pinned here without one: a misspelled ARMS id is an error
// rather than a silently narrower run, and no two arms can be the same
// experiment (same directive, same sampling) — that duplicate is dropped at
// build time and reported, not run twice.

const { test } = require("node:test");
const assert = require("node:assert");

const { RAW_ARMS, ALL_ARMS, DROPPED_ARMS, dedupeArms, selectArms } = require("../scripts/cleanup-arms");
const { cleanupUserTurn, cleanupSamplingOptions } = require("../main/util/cleanup-turn");

const ids = (arms) => arms.map((a) => a.id);

test("cleanup-arms: no two arms share a directive and a sampling profile", () => {
  const seen = new Set();
  for (const arm of ALL_ARMS) {
    const key = `${arm.directive}\0${JSON.stringify(Object.entries(arm.sampling).sort())}`;
    assert.ok(!seen.has(key), `${arm.id} duplicates an earlier arm`);
    seen.add(key);
  }
  // Every raw arm is either kept or reported as dropped — nothing vanishes.
  assert.strictEqual(ALL_ARMS.length + DROPPED_ARMS.length, RAW_ARMS.length);
  for (const d of DROPPED_ARMS) {
    assert.ok(RAW_ARMS.some((a) => a.id === d.id), `${d.id} is not a raw arm`);
    assert.ok(ALL_ARMS.some((a) => a.id === d.sameAs), `${d.sameAs} is not a kept arm`);
  }
});

test("cleanup-arms: today polished/prompt-only duplicates polished/new, and only it", () => {
  // Polished sampling in main/cleanup-styles.js is back at the pre-sharpening
  // profile, so "sharpened directive + old sampling" IS polished/new. If the
  // sampling changes again this arm comes back on its own and this pin moves.
  assert.deepStrictEqual(DROPPED_ARMS, [{ id: "polished/prompt-only", sameAs: "polished/new" }]);
  assert.ok(!ids(ALL_ARMS).includes("polished/prompt-only"));
  const raw = Object.fromEntries(RAW_ARMS.map((a) => [a.id, a]));
  const a = raw["polished/prompt-only"];
  const b = raw["polished/new"];
  // A dropped pair would have produced byte-identical requests.
  assert.strictEqual(cleanupUserTurn(`sys ${a.directive}`, "um hi"), cleanupUserTurn(`sys ${b.directive}`, "um hi"));
  assert.deepStrictEqual(cleanupSamplingOptions(a.sampling), cleanupSamplingOptions(b.sampling));
});

test("cleanup-arms: dedupeArms keeps the first of equal arms, ignoring sampling key order", () => {
  const arms = [
    { id: "a", directive: "x", sampling: { temperature: 0.2, topP: 0.9 } },
    { id: "b", directive: "x", sampling: { topP: 0.9, temperature: 0.2 } },
    { id: "c", directive: "y", sampling: { temperature: 0.2, topP: 0.9 } },
    { id: "d", directive: "x", sampling: { temperature: 0.3, topP: 0.9 } },
  ];
  const { arms: kept, dropped } = dedupeArms(arms);
  assert.deepStrictEqual(ids(kept), ["a", "c", "d"]);
  assert.deepStrictEqual(dropped, [{ id: "b", sameAs: "a" }]);
});

test("cleanup-arms: selectArms validates ARMS instead of silently narrowing the run", () => {
  const all = ids(ALL_ARMS);
  assert.deepStrictEqual(ids(selectArms(ALL_ARMS, undefined)), all);
  assert.deepStrictEqual(ids(selectArms(ALL_ARMS, "")), all, "unset or empty ARMS means every arm");
  // Table order, not request order; repeats do not run an arm twice.
  assert.deepStrictEqual(ids(selectArms(ALL_ARMS, "polished/new,clean/old, clean/old")), ["clean/old", "polished/new"]);
  assert.throws(() => selectArms(ALL_ARMS, "polished/nwe,clean/new"), (err) => {
    assert.match(err.message, /unknown arm "polished\/nwe"/);
    for (const id of all) assert.ok(err.message.includes(id), `error lists ${id}`);
    return true;
  });
  assert.throws(() => selectArms(ALL_ARMS, ","), /selects no arm/);
  // A dropped duplicate is not selectable: asking for it names its twin.
  assert.throws(() => selectArms(ALL_ARMS, "polished/prompt-only"), /polished\/prompt-only.*same as polished\/new/);
});
