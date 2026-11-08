// The "Lower other audio while recording" status line Settings and the setup
// wizard both show (renderer/ducking-status.js), from main's ducking:status.
const test = require("node:test");
const assert = require("node:assert");
const DuckingStatus = require("../renderer/ducking-status");

const idle = { available: true, mechanism: "pactl", reason: "", state: "idle", detail: "", lastError: "" };

test("says plainly when lowering is unavailable, and that dictation still works", () => {
  assert.strictEqual(
    DuckingStatus.text({ ...idle, available: false, mechanism: null, reason: "no volume tool found" }),
    "Not available on this system (no volume tool found). Dictation works as usual."
  );
});

test("a failure outranks the take's state, and names it", () => {
  assert.strictEqual(
    DuckingStatus.text({ ...idle, state: "lowered", lastError: "pactl exited 1" }),
    "Last attempt failed: pactl exited 1. Dictation works as usual."
  );
});

test("describes the take: lowered, skipped, or not restored yet", () => {
  assert.strictEqual(DuckingStatus.text({ ...idle, state: "lowered" }), "Other audio is lowered right now.");
  assert.strictEqual(DuckingStatus.text({ ...idle, state: "skipped", detail: "output is muted" }), "Not lowered this take: output is muted.");
  assert.strictEqual(DuckingStatus.text({ ...idle, state: "pending", detail: "device is gone" }), "Not restored yet: device is gone.");
});

test("a notice from the last take is said as advice, not as a failure", () => {
  const notice = "The output switched while it was being lowered, so the new output may be quieter now. Set its volume back by hand if so.";
  assert.strictEqual(DuckingStatus.text({ ...idle, state: "lowered", notice }), notice);
  assert.strictEqual(DuckingStatus.text({ ...idle, state: "idle", notice }), notice, "still there after the restore");
  assert.match(DuckingStatus.text({ ...idle, lastError: "pactl exited 1", notice }), /^Last attempt failed/, "a failure still outranks it");
});

test("otherwise names the mechanism, and says nothing without an answer", () => {
  assert.strictEqual(DuckingStatus.text(idle), "Uses pactl to change the output volume.");
  assert.strictEqual(DuckingStatus.text({ ...idle, mechanism: null }), "");
  assert.strictEqual(DuckingStatus.text(null), "");
});

test("show writes what main answered, and nothing when the call fails", async (t) => {
  t.after(() => delete global.earheart);
  const element = { textContent: "Checking this system's volume controls…" };
  global.earheart = { invoke: async (channel) => (assert.strictEqual(channel, "ducking:status"), idle) };
  await DuckingStatus.show(element);
  assert.strictEqual(element.textContent, "Uses pactl to change the output volume.");
  global.earheart = { invoke: async () => { throw new Error("No handler registered"); } };
  await DuckingStatus.show(element);
  assert.strictEqual(element.textContent, "");
});
