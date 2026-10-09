const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const { prettyHotkey, registrationHint } = require("../main/util/hotkey-label");

const A = "CommandOrControl+Shift+Space";
const B = "CommandOrControl+Alt+P";
const C = "CommandOrControl+Alt+C";

function loadHotkeys({ registerImpl = () => true, occupied = [] } = {}) {
  const hotkeysPath = require.resolve("../main/hotkeys");
  const loggerPath = require.resolve("../main/util/logger");
  const electronPath = require.resolve("electron");
  const savedLogger = require.cache[loggerPath];
  const savedElectron = require.cache[electronPath];
  const calls = { registered: [], unregistered: [], events: [], warnings: [] };
  const bindings = new Map();
  const attempts = new Map();
  const electron = new Module(electronPath, null);
  electron.filename = electronPath;
  electron.loaded = true;
  electron.exports = {
    globalShortcut: {
      register(accelerator, callback) {
        calls.registered.push({ accelerator, callback });
        calls.events.push(`register:${accelerator}`);
        const attempt = (attempts.get(accelerator) || 0) + 1;
        attempts.set(accelerator, attempt);
        if (bindings.has(accelerator) || occupied.includes(accelerator)) return false;
        const ok = registerImpl(accelerator, attempt);
        if (ok) bindings.set(accelerator, callback);
        return ok;
      },
      unregister(accelerator) {
        calls.unregistered.push(accelerator);
        calls.events.push(`unregister:${accelerator}`);
        bindings.delete(accelerator);
      },
      unregisterAll() {
        bindings.clear();
      },
    },
  };
  const logger = new Module(loggerPath, null);
  logger.filename = loggerPath;
  logger.loaded = true;
  logger.exports = { warn: (message) => calls.warnings.push(message) };
  require.cache[loggerPath] = logger;
  require.cache[electronPath] = electron;
  delete require.cache[hotkeysPath];
  const hotkeys = require(hotkeysPath);
  delete require.cache[hotkeysPath];
  if (savedElectron) require.cache[electronPath] = savedElectron;
  else delete require.cache[electronPath];
  if (savedLogger) require.cache[loggerPath] = savedLogger;
  else delete require.cache[loggerPath];
  return { hotkeys, calls, bindings };
}

function pair(record, pause, onRecord = () => {}, onPause = () => {}) {
  return { record, pause, onRecord, onPause };
}

function clearCalls(calls) {
  calls.registered.length = 0;
  calls.unregistered.length = 0;
  calls.events.length = 0;
}

test("a rejected replacement keeps the working hotkey registered", () => {
  const OLD = "CommandOrControl+Shift+Space";
  const BAD = "CommandOrControl+Alt+X";
  const { hotkeys, calls, bindings } = loadHotkeys({ occupied: [BAD] });
  hotkeys.applyPair(pair(OLD, ""));
  clearCalls(calls);

  const result = hotkeys.applyPair(pair(BAD, ""));

  assert.strictEqual(result.record.ok, false);
  assert.strictEqual(bindings.has(OLD), true);
  assert.deepStrictEqual(calls.unregistered, []);
});

test("an invalid replacement keeps the working hotkey registered", () => {
  const OLD = "CommandOrControl+Shift+Space";
  const BAD = "Nope+X";
  const { hotkeys, calls, bindings } = loadHotkeys({
    registerImpl(accelerator) {
      if (accelerator === BAD) throw new Error("bad accelerator");
      return true;
    },
  });
  hotkeys.applyPair(pair(OLD, ""));
  clearCalls(calls);

  const result = hotkeys.applyPair(pair(BAD, ""));

  assert.strictEqual(result.record.ok, false);
  assert.match(result.record.error, /Invalid hotkey "Nope\+X": bad accelerator/);
  assert.strictEqual(bindings.has(OLD), true);
  assert.deepStrictEqual(calls.unregistered, []);
});

test("a successful replacement releases the previous hotkey afterwards", () => {
  const OLD = "CommandOrControl+Shift+Space";
  const NEXT = "CommandOrControl+Alt+X";
  const { hotkeys, calls } = loadHotkeys();
  hotkeys.applyPair(pair(OLD, ""));
  clearCalls(calls);

  hotkeys.applyPair(pair(NEXT, ""));

  assert.deepStrictEqual(calls.events, [`register:${NEXT}`, `unregister:${OLD}`]);
});

test("a final-pair collision does not touch either existing hotkey", () => {
  const { hotkeys, calls } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  clearCalls(calls);

  const result = hotkeys.applyPair(pair(C, C));

  assert.strictEqual(result.record.ok, false);
  assert.strictEqual(result.pause.ok, false);
  assert.match(result.record.error, /already used by the pause hotkey/);
  assert.match(result.pause.error, /already used by the record hotkey/);
  assert.deepStrictEqual(calls.events, []);
});

test("a collision reports only the changed slot when the owner is unchanged", () => {
  const { hotkeys, calls } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  clearCalls(calls);

  const result = hotkeys.applyPair(pair(A, A));

  assert.deepStrictEqual(result.record, { ok: true });
  assert.strictEqual(result.pause.ok, false);
  assert.match(result.pause.error, /already used by the record hotkey/);
  assert.deepStrictEqual(calls.events, []);
});

test("a cold-start collision keeps the required record hotkey working", () => {
  const X = "CommandOrControl+Shift+Space";
  const triggered = [];
  const { hotkeys, calls, bindings } = loadHotkeys();

  const result = hotkeys.applyPair(
    pair(X, X, () => triggered.push("record"), () => triggered.push("pause"))
  );

  assert.deepStrictEqual(result.record, { ok: true });
  assert.strictEqual(result.pause.ok, false);
  assert.match(result.pause.error, /already used by the record hotkey/);
  assert.deepStrictEqual(calls.registered.map(({ accelerator }) => accelerator), [X]);
  bindings.get(X)();
  assert.deepStrictEqual(triggered, ["record"]);
});

test("a rejected cold-start pause hotkey keeps the required record hotkey working", () => {
  const triggered = [];
  const { hotkeys, calls, bindings } = loadHotkeys({ occupied: [B] });

  const result = hotkeys.applyPair(
    pair(A, B, () => triggered.push("record"), () => triggered.push("pause"))
  );

  assert.deepStrictEqual(result.record, { ok: true });
  assert.strictEqual(result.pause.ok, false);
  assert.match(result.pause.error, /Could not register/);
  assert.strictEqual(bindings.has(A), true);
  assert.deepStrictEqual(calls.unregistered, []);
  bindings.get(A)();
  assert.deepStrictEqual(triggered, ["record"]);
});

test("reapplying the same pair does not drop and reacquire either hotkey", () => {
  const { hotkeys, calls } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  clearCalls(calls);

  assert.deepStrictEqual(hotkeys.applyPair(pair(A, B)), {
    record: { ok: true },
    pause: { ok: true },
  });
  assert.deepStrictEqual(calls.events, []);
});

test("swapping record and pause succeeds with the callbacks exchanged", () => {
  const triggered = [];
  const { hotkeys, calls, bindings } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  clearCalls(calls);

  const result = hotkeys.applyPair(
    pair(B, A, () => triggered.push("record"), () => triggered.push("pause"))
  );

  assert.deepStrictEqual(result, { record: { ok: true }, pause: { ok: true } });
  assert.deepStrictEqual(calls.unregistered, [A, B]);
  assert.deepStrictEqual(calls.registered.map(({ accelerator }) => accelerator), [B, A]);
  bindings.get(B)();
  bindings.get(A)();
  assert.deepStrictEqual(triggered, ["record", "pause"]);
});

test("a failed swap restores both previous bindings and callbacks", () => {
  const triggered = [];
  const { hotkeys, calls, bindings } = loadHotkeys({
    registerImpl: (accelerator, attempt) => !(accelerator === A && attempt === 2),
  });
  hotkeys.applyPair(
    pair(A, B, () => triggered.push("old-record"), () => triggered.push("old-pause"))
  );
  clearCalls(calls);

  const result = hotkeys.applyPair(pair(B, A));

  assert.strictEqual(result.record.ok, false);
  assert.match(result.record.error, /Not changed.*pause hotkey/);
  assert.strictEqual(result.pause.ok, false);
  assert.match(result.pause.error, /Could not register/);
  bindings.get(A)();
  bindings.get(B)();
  assert.deepStrictEqual(triggered, ["old-record", "old-pause"]);
  clearCalls(calls);
  hotkeys.applyPair(pair(A, B));
  assert.deepStrictEqual(calls.events, []);
});

test("an invalid crossed target restores both previous bindings", () => {
  const { hotkeys, bindings } = loadHotkeys({
    registerImpl(accelerator, attempt) {
      if (accelerator === A && attempt === 2) throw new Error("bad accelerator");
      return true;
    },
  });
  hotkeys.applyPair(pair(A, B));

  const result = hotkeys.applyPair(pair(B, A));

  assert.strictEqual(result.record.ok, false);
  assert.strictEqual(result.pause.ok, false);
  assert.match(result.pause.error, /Invalid hotkey.*bad accelerator/);
  assert.strictEqual(bindings.has(A), true);
  assert.strictEqual(bindings.has(B), true);
});

test("a later free-target failure rolls back an earlier successful target", () => {
  const D = "CommandOrControl+Alt+D";
  const { hotkeys, bindings } = loadHotkeys({ occupied: [D] });
  hotkeys.applyPair(pair(A, B));

  const result = hotkeys.applyPair(pair(C, D));

  assert.strictEqual(result.record.ok, false);
  assert.strictEqual(result.pause.ok, false);
  assert.strictEqual(bindings.has(C), false);
  assert.strictEqual(bindings.has(A), true);
  assert.strictEqual(bindings.has(B), true);
});

test("two free replacements register before either previous binding is released", () => {
  const D = "CommandOrControl+Alt+D";
  const { hotkeys, calls, bindings } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  clearCalls(calls);

  const result = hotkeys.applyPair(pair(C, D));

  assert.deepStrictEqual(result, { record: { ok: true }, pause: { ok: true } });
  assert.deepStrictEqual(calls.events, [
    `register:${C}`,
    `register:${D}`,
    `unregister:${A}`,
    `unregister:${B}`,
  ]);
  assert.deepStrictEqual([...bindings.keys()], [C, D]);
});

test("a mixed free and crossed change registers in no-drop order", () => {
  const triggered = [];
  const { hotkeys, calls, bindings } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  clearCalls(calls);

  const result = hotkeys.applyPair(
    pair(B, C, () => triggered.push("record"), () => triggered.push("pause"))
  );

  assert.deepStrictEqual(result, { record: { ok: true }, pause: { ok: true } });
  assert.deepStrictEqual(calls.events, [
    `register:${C}`,
    `unregister:${B}`,
    `register:${B}`,
    `unregister:${A}`,
  ]);
  bindings.get(B)();
  bindings.get(C)();
  assert.deepStrictEqual(triggered, ["record", "pause"]);
});

test("a mixed crossed failure removes the free addition and restores its owner", () => {
  const triggered = [];
  const { hotkeys, bindings } = loadHotkeys({
    registerImpl: (accelerator, attempt) => !(accelerator === B && attempt === 2),
  });
  hotkeys.applyPair(
    pair(A, B, () => triggered.push("old-record"), () => triggered.push("old-pause"))
  );

  const result = hotkeys.applyPair(pair(B, C));

  assert.strictEqual(result.record.ok, false);
  assert.strictEqual(result.pause.ok, false);
  assert.strictEqual(bindings.has(C), false);
  assert.strictEqual(bindings.has(A), true);
  bindings.get(B)();
  assert.deepStrictEqual(triggered, ["old-pause"]);
});

test("a rollback re-registration failure is reported and removed from state", () => {
  const { hotkeys, calls } = loadHotkeys({
    registerImpl(accelerator, attempt) {
      if (accelerator === A && attempt === 2) return false;
      if (accelerator === B && attempt === 3) return false;
      return true;
    },
  });
  hotkeys.applyPair(pair(A, B));

  const failed = hotkeys.applyPair(pair(B, A));

  assert.match(failed.pause.error, /Could not restore/);
  assert.match(failed.pause.error, /pause hotkey is now unbound until you save again or restart/);
  assert.deepStrictEqual(calls.warnings, [
    `Could not restore "${prettyHotkey(B)}" after rollback. The pause hotkey is now unbound until you save again or restart.`,
  ]);
  clearCalls(calls);
  hotkeys.applyPair(pair(A, B));
  assert.deepStrictEqual(calls.registered.map(({ accelerator }) => accelerator), [B]);
});

test("a collateral rollback failure reports the unbound slot without contradiction", () => {
  const { hotkeys, calls, bindings } = loadHotkeys({
    registerImpl(accelerator, attempt) {
      if (accelerator === A && (attempt === 2 || attempt === 3)) return false;
      return true;
    },
  });
  hotkeys.applyPair(pair(A, B));

  const failed = hotkeys.applyPair(pair(B, A));

  assert.strictEqual(
    failed.record.error.replace(/\s+/g, " "),
    `The pause hotkey could not be registered. Could not restore "${prettyHotkey(A)}" after rollback. The record hotkey is now unbound until you save again or restart.`
  );
  assert.doesNotMatch(failed.record.error, /Not changed/);
  assert.deepStrictEqual(calls.warnings, [
    `Could not restore "${prettyHotkey(A)}" after rollback. The record hotkey is now unbound until you save again or restart.`,
  ]);
  assert.strictEqual(bindings.has(A), false);
  assert.strictEqual(bindings.has(B), true);
});

// A failed swap whose rollback also fails leaves the slot's *saved* hotkey
// unbound. Settings hides results about an accelerator the field no longer
// holds, so this one must say it describes the slot itself: the saved value
// (A) is what the field shows on reopen, not the attempted one (B).
test("a slot left unbound by a failed restore is marked as describing the slot", () => {
  const { hotkeys, bindings } = loadHotkeys({
    registerImpl(accelerator, attempt) {
      if (accelerator === A && (attempt === 2 || attempt === 3)) return false;
      return true;
    },
  });
  hotkeys.applyPair(pair(A, B));

  const results = hotkeys.toHotkeyResults(hotkeys.applyPair(pair(B, A)), { hotkey: B, pauseHotkey: A });

  assert.strictEqual(bindings.has(A), false, "the saved record hotkey is really unbound");
  assert.strictEqual(results.hotkey.unbound, true);
  assert.strictEqual(results.hotkey.accelerator, B, "the attempted accelerator differs from the saved one");
  assert.strictEqual(results.pauseHotkey.unbound, undefined, "an ordinary rejection keeps its old binding");
});

test("empty targets are valid unbound states", () => {
  const { hotkeys, bindings } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));

  const result = hotkeys.applyPair(pair("", ""));

  assert.deepStrictEqual(result, {
    record: { ok: true, empty: true },
    pause: { ok: true, empty: true },
  });
  assert.strictEqual(bindings.size, 0);
});

test("an empty record maps to the required-hotkey error without losing its marker", () => {
  const { hotkeys } = loadHotkeys();

  assert.deepStrictEqual(
    hotkeys.toHotkeyResults({
      record: { ok: true, empty: true },
      pause: { ok: true, empty: true },
    }),
    {
      hotkey: { ok: false, empty: true, error: "No hotkey configured" },
      pauseHotkey: { ok: true, empty: true },
    }
  );
});

test("a non-empty record failure passes through without an empty marker", () => {
  const { hotkeys } = loadHotkeys();
  const record = { ok: false, error: "record rejected" };

  assert.deepStrictEqual(
    hotkeys.toHotkeyResults({ record, pause: { ok: true } }),
    { hotkey: record, pauseHotkey: { ok: true } }
  );
});

// Settings shows a stored result only while its field still holds the same
// accelerator, so each slot carries the accelerator it was attempted with.
test("results carry the accelerator each slot was attempted with", () => {
  const { hotkeys } = loadHotkeys();
  const record = { ok: false, error: "record rejected" };

  assert.deepStrictEqual(
    hotkeys.toHotkeyResults(
      { record, pause: { ok: true, empty: true } },
      { hotkey: A, pauseHotkey: undefined }
    ),
    {
      hotkey: { ok: false, error: "record rejected", accelerator: A },
      pauseHotkey: { ok: true, empty: true, accelerator: "" },
    }
  );
  assert.deepStrictEqual(record, { ok: false, error: "record rejected" }, "the pair result is not mutated");
  assert.deepStrictEqual(
    hotkeys.toHotkeyResults({ record: { ok: true, empty: true }, pause: { ok: true } }, { hotkey: "" }),
    {
      hotkey: { ok: false, empty: true, error: "No hotkey configured", accelerator: "" },
      pauseHotkey: { ok: true, accelerator: "" },
    }
  );
});

// Hotkey errors are read by people (Settings rows, the startup notice), so they
// name the keys the way the platform does and point only at help that exists
// on this platform. Electron itself still receives the raw accelerator.
test("registration errors show the readable accelerator and this platform's hint", () => {
  const { hotkeys, calls } = loadHotkeys({ occupied: [B] });

  const result = hotkeys.applyPair(pair(A, B));

  assert.strictEqual(
    result.pause.error,
    `Could not register "${prettyHotkey(B)}" (${registrationHint()}).`
  );
  assert.ok(calls.registered.some(({ accelerator }) => accelerator === B));
});

test("collision errors show the readable accelerator", () => {
  const cold = loadHotkeys().hotkeys.applyPair(pair(A, A));
  assert.strictEqual(cold.pause.error, `"${prettyHotkey(A)}" is already used by the record hotkey`);

  const { hotkeys } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  const warm = hotkeys.applyPair(pair(C, C));
  assert.strictEqual(warm.record.error, `"${prettyHotkey(C)}" is already used by the pause hotkey`);
  assert.strictEqual(warm.pause.error, `"${prettyHotkey(C)}" is already used by the record hotkey`);
});

test("an invalid accelerator error shows the readable form and keeps the native reason", () => {
  const BAD = "CommandOrControl+Nope";
  const { hotkeys } = loadHotkeys({
    registerImpl(accelerator) {
      if (accelerator === BAD) throw new Error("bad accelerator");
      return true;
    },
  });

  const result = hotkeys.applyPair(pair(BAD, ""));

  assert.strictEqual(result.record.error, `Invalid hotkey "${prettyHotkey(BAD)}": bad accelerator`);
});

test("no hotkey error carries a raw Electron modifier name", () => {
  const { hotkeys } = loadHotkeys({ occupied: [B] });
  const results = [hotkeys.applyPair(pair(A, B)), hotkeys.applyPair(pair(C, C))];
  for (const result of results) {
    for (const slot of [result.record, result.pause]) {
      if (slot.error) assert.doesNotMatch(slot.error, /CommandOrControl/);
    }
  }
});

// ---- discard hotkey: a third, optional slot held only while a dictation is live

const D = "CommandOrControl+Alt+D";
const E = "CommandOrControl+Alt+E";

function all(record, pause, discard, onDiscard = () => {}) {
  return { record, pause, discard, onRecord: () => {}, onPause: () => {}, onDiscard };
}

test("an empty discard hotkey is a valid unbound state and is never registered", () => {
  const { hotkeys, calls } = loadHotkeys();
  const result = hotkeys.applyAll(all(A, "", ""));
  assert.deepStrictEqual(result.discard, { ok: true, empty: true });
  clearCalls(calls);

  hotkeys.armDiscard(true);
  assert.deepStrictEqual(calls.registered, []);
});

test("saving a discard hotkey while idle checks it, then releases it", () => {
  const { hotkeys, calls, bindings } = loadHotkeys();
  const result = hotkeys.applyAll(all(A, "", D));

  assert.deepStrictEqual(result.discard, { ok: true });
  assert.ok(calls.registered.some(({ accelerator }) => accelerator === D), "Save tries the binding");
  assert.strictEqual(bindings.has(D), false, "idle, the combination stays free for other apps");
  assert.strictEqual(bindings.has(A), true);
});

test("the discard hotkey is held exactly while a dictation is live", () => {
  let discarded = 0;
  const { hotkeys, calls, bindings } = loadHotkeys();
  hotkeys.applyAll(all(A, B, D, () => discarded++));
  clearCalls(calls);

  hotkeys.armDiscard(true); // recording starts
  assert.strictEqual(bindings.has(D), true);
  bindings.get(D)();
  assert.strictEqual(discarded, 1, "the key runs the discard callback");

  hotkeys.armDiscard(true); // recording -> processing: still live
  assert.deepStrictEqual(calls.events, [`register:${D}`], "re-arming is a no-op");

  hotkeys.armDiscard(false); // back to idle
  assert.strictEqual(bindings.has(D), false);
  hotkeys.armDiscard(false);
  assert.deepStrictEqual(calls.events, [`register:${D}`, `unregister:${D}`], "disarming twice is a no-op");
  assert.strictEqual(bindings.has(A) && bindings.has(B), true, "record and pause are untouched");

  hotkeys.armDiscard(true); // the next dictation
  assert.strictEqual(bindings.has(D), true);
});

test("a discard hotkey another app holds fails at Save and keeps the previous one", () => {
  const { hotkeys, bindings, calls } = loadHotkeys({ occupied: [E] });
  hotkeys.applyAll(all(A, "", D));

  const result = hotkeys.applyAll(all(A, "", E));

  assert.strictEqual(result.discard.ok, false);
  assert.strictEqual(result.discard.error, `Could not register "${prettyHotkey(E)}" (${registrationHint()}).`);
  clearCalls(calls);
  hotkeys.armDiscard(true);
  assert.deepStrictEqual(calls.events, [`register:${D}`], "the working binding is the one armed");
  assert.strictEqual(bindings.has(D), true);
});

test("changing the discard hotkey mid-dictation swaps the held binding", () => {
  const { hotkeys, bindings } = loadHotkeys();
  hotkeys.applyAll(all(A, "", D));
  hotkeys.armDiscard(true);

  const result = hotkeys.applyAll(all(A, "", E));

  assert.deepStrictEqual(result.discard, { ok: true });
  assert.strictEqual(bindings.has(D), false);
  assert.strictEqual(bindings.has(E), true, "still live, so the new binding stays held");
  hotkeys.armDiscard(false);
  assert.strictEqual(bindings.has(E), false);
});

test("clearing the discard hotkey mid-dictation releases it", () => {
  const { hotkeys, bindings } = loadHotkeys();
  hotkeys.applyAll(all(A, "", D));
  hotkeys.armDiscard(true);

  const result = hotkeys.applyAll(all(A, "", ""));

  assert.deepStrictEqual(result.discard, { ok: true, empty: true });
  assert.strictEqual(bindings.has(D), false);
});

test("a discard hotkey changed into the record hotkey is rejected; record keeps working", () => {
  const { hotkeys, bindings } = loadHotkeys();
  hotkeys.applyAll(all(A, B, D));

  const result = hotkeys.applyAll(all(A, B, A));

  assert.deepStrictEqual(result.record, { ok: true });
  assert.strictEqual(result.discard.error, `"${prettyHotkey(A)}" is already used by the record hotkey`);
  assert.strictEqual(bindings.has(A), true);
  hotkeys.armDiscard(true);
  assert.strictEqual(bindings.has(D), true, "the previous discard binding is kept");
});

test("a pause hotkey changed into the discard hotkey is rejected; both keep their bindings", () => {
  const { hotkeys, bindings } = loadHotkeys();
  hotkeys.applyAll(all(A, B, D));

  const result = hotkeys.applyAll(all(A, D, D));

  assert.strictEqual(result.pause.error, `"${prettyHotkey(D)}" is already used by the discard hotkey`);
  assert.deepStrictEqual(result.discard, { ok: true });
  assert.strictEqual(bindings.has(B), true, "pause keeps its old binding");
  hotkeys.armDiscard(true);
  assert.strictEqual(bindings.has(D), true);
});

test("a cold-start discard hotkey that duplicates pause yields and stays unbound", () => {
  const { hotkeys, bindings, calls } = loadHotkeys();

  const result = hotkeys.applyAll(all(A, B, B));

  assert.deepStrictEqual(result.pause, { ok: true });
  assert.strictEqual(result.discard.error, `"${prettyHotkey(B)}" is already used by the pause hotkey`);
  assert.strictEqual(bindings.has(B), true);
  clearCalls(calls);
  hotkeys.armDiscard(true);
  assert.deepStrictEqual(calls.registered, [], "nothing is armed over the pause hotkey");
});

test("a discard hotkey equal to a pause binding kept by a failed change is a collision", () => {
  const { hotkeys } = loadHotkeys({ occupied: [C] });
  hotkeys.applyAll(all(A, B, D));

  // Pause asks for C (taken by another app) and keeps B; discard asks for B.
  const result = hotkeys.applyAll(all(A, C, B));

  assert.strictEqual(result.pause.ok, false);
  assert.strictEqual(result.discard.error, `"${prettyHotkey(B)}" is already used by the pause hotkey`);
});

test("an arming failure is logged, not thrown, and the next dictation retries", () => {
  let busy = false;
  const { hotkeys, bindings, calls } = loadHotkeys({ registerImpl: (acc) => !(busy && acc === D) });
  hotkeys.applyAll(all(A, "", D));
  busy = true; // another app grabbed it after Save
  clearCalls(calls);

  hotkeys.armDiscard(true);
  assert.strictEqual(bindings.has(D), false);
  assert.match(calls.warnings.at(-1), /discard hotkey: Could not register/);
  hotkeys.armDiscard(false); // nothing held, nothing to release
  assert.ok(!calls.unregistered.includes(D));

  busy = false;
  hotkeys.armDiscard(true);
  assert.strictEqual(bindings.has(D), true);
});

test("unregisterAll forgets the armed discard hotkey", () => {
  const { hotkeys, bindings } = loadHotkeys();
  hotkeys.applyAll(all(A, "", D));
  hotkeys.armDiscard(true);

  hotkeys.unregisterAll();
  assert.strictEqual(bindings.has(D), false);
  hotkeys.armDiscard(true);
  assert.strictEqual(bindings.has(D), true, "a stale armed flag would skip this");
});

test("results report the discard slot with its accelerator", () => {
  const { hotkeys } = loadHotkeys({ occupied: [D] });
  const results = hotkeys.toHotkeyResults(hotkeys.applyAll(all(A, "", D)), {
    hotkey: A,
    pauseHotkey: "",
    discardHotkey: D,
  });

  assert.strictEqual(results.discardHotkey.ok, false);
  assert.strictEqual(results.discardHotkey.accelerator, D);
  assert.deepStrictEqual(results.pauseHotkey, { ok: true, empty: true, accelerator: "" });
});
