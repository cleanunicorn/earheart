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
        calls.events.push("unregisterAll");
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

test("a cold-start collision whose record is rejected reports both slots", () => {
  const X = "CommandOrControl+Shift+Space";
  const { hotkeys, bindings } = loadHotkeys({ occupied: [X] });

  const result = hotkeys.applyPair(pair(X, X));

  assert.strictEqual(result.record.ok, false);
  assert.match(result.record.error, /Could not register/);
  assert.deepStrictEqual(result.pause, {
    ok: false,
    error: "Not changed: the record hotkey could not be registered",
  });
  assert.strictEqual(bindings.size, 0);
});

test("clearing the pause hotkey unregisters exactly its accelerator", () => {
  const { hotkeys, calls, bindings } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  clearCalls(calls);

  const result = hotkeys.applyPair(pair(A, ""));

  assert.deepStrictEqual(result, { record: { ok: true }, pause: { ok: true, empty: true } });
  assert.deepStrictEqual(calls.events, [`unregister:${B}`]);
  assert.strictEqual(bindings.has(A), true, "the record hotkey is untouched");
  assert.strictEqual(bindings.has(B), false);

  // The cleared slot is really empty: binding it again registers afresh.
  clearCalls(calls);
  hotkeys.applyPair(pair(A, B));
  assert.deepStrictEqual(calls.events, [`register:${B}`]);
});

test("unregisterAll releases every hotkey and forgets the slots", () => {
  const { hotkeys, calls, bindings } = loadHotkeys();
  hotkeys.applyPair(pair(A, B));
  clearCalls(calls);

  hotkeys.unregisterAll();

  assert.deepStrictEqual(calls.events, ["unregisterAll"]);
  assert.strictEqual(bindings.size, 0);
  // The module's own record must be cleared too: otherwise reapplying the same
  // pair looks like "no change" and leaves the app with no hotkeys at all.
  clearCalls(calls);
  const result = hotkeys.applyPair(pair(A, B));
  assert.deepStrictEqual(result, { record: { ok: true }, pause: { ok: true } });
  assert.deepStrictEqual(calls.events, [`register:${A}`, `register:${B}`]);
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

test("suspending releases every held hotkey; resuming restores the same bindings", () => {
  let recorded = 0;
  const { hotkeys, calls, bindings } = loadHotkeys();
  hotkeys.applyAll({ ...all(A, B, D), onRecord: () => recorded++ });
  hotkeys.armDiscard(true);
  clearCalls(calls);

  hotkeys.suspend(true);
  assert.deepStrictEqual([...bindings.keys()], [], "the capture field gets every key");
  hotkeys.suspend(true);
  assert.strictEqual(calls.unregistered.length, 3, "suspending twice is a no-op");

  hotkeys.suspend(false);
  assert.deepStrictEqual([...bindings.keys()].sort(), [A, B, D].sort());
  bindings.get(A)();
  assert.strictEqual(recorded, 1, "the restored record hotkey runs its callback");
  hotkeys.suspend(false);
  assert.strictEqual(calls.registered.length, 3, "resuming twice is a no-op");
});

test("a dictation that starts or ends while suspended is honored on resume", () => {
  const { hotkeys, bindings } = loadHotkeys();
  hotkeys.applyAll(all(A, "", D));
  hotkeys.suspend(true);

  hotkeys.armDiscard(true); // the tray starts a dictation mid-capture
  assert.strictEqual(bindings.has(D), false, "nothing is grabbed while suspended");
  hotkeys.suspend(false);
  assert.strictEqual(bindings.has(D), true, "still live: discard is armed on resume");

  hotkeys.suspend(true);
  hotkeys.armDiscard(false); // the dictation ends mid-capture
  hotkeys.suspend(false);
  assert.strictEqual(bindings.has(D), false, "idle again: discard stays free");
  assert.strictEqual(bindings.has(A), true);
});

test("a save while suspended checks the new pair with the OS, then stands down again", () => {
  const { hotkeys, calls, bindings } = loadHotkeys({ occupied: [C] });
  hotkeys.applyAll(all(A, "", ""));
  hotkeys.suspend(true);
  clearCalls(calls);

  const result = hotkeys.applyAll(all(B, "", ""));
  assert.strictEqual(result.record.ok, true);
  assert.ok(calls.events.includes(`register:${B}`), "the new binding was really registered");
  assert.deepStrictEqual([...bindings.keys()], [], "another field is still capturing");

  const rejected = hotkeys.applyAll(all(C, "", ""));
  assert.strictEqual(rejected.record.ok, false, "a taken key still fails at Save");

  hotkeys.suspend(false);
  assert.deepStrictEqual([...bindings.keys()], [B]);
});

test("a hotkey another app grabbed during capture is logged and left unbound", () => {
  const { hotkeys, calls, bindings } = loadHotkeys({
    registerImpl: (accelerator, attempt) => !(accelerator === B && attempt > 1),
  });
  hotkeys.applyAll(all(A, B, ""));
  hotkeys.suspend(true);

  assert.deepStrictEqual(hotkeys.suspend(false), ["pause"]);

  assert.strictEqual(bindings.has(A), true, "record still comes back");
  assert.strictEqual(bindings.has(B), false);
  assert.match(calls.warnings.at(-1), /pause hotkey: .*after capture/);
});

test("a discard hotkey saved mid-dictation is held even when the old one failed to come back", () => {
  const { hotkeys, bindings } = loadHotkeys({
    registerImpl: (accelerator, attempt) => !(accelerator === D && attempt > 2),
  });
  hotkeys.applyAll(all(A, "", D)); // attempt 1: checked at Save
  hotkeys.armDiscard(true); // attempt 2: recording starts, D held
  hotkeys.suspend(true);
  hotkeys.suspend(false); // attempt 3: another app took D during capture
  assert.strictEqual(bindings.has(D), false);

  const result = hotkeys.applyAll(all(A, "", E));

  assert.deepStrictEqual(result.discard, { ok: true });
  assert.strictEqual(bindings.has(E), true, "the live dictation can be discarded with the new key");
  hotkeys.armDiscard(false);
  assert.strictEqual(bindings.has(E), false, "and it is released when the dictation ends");
});

test("correction shortcut triggers, suspends during capture and preserves old key on failed rebind", () => {
  const { hotkeys, bindings } = loadHotkeys({ occupied: ["CommandOrControl+Alt+X"] });
  let corrected = 0;
  const next = { record: A, pause: B, correct: C, onRecord() {}, onPause() {}, onCorrect() { corrected++; } };
  assert.strictEqual(hotkeys.applyAll(next).correct.ok, true);
  bindings.get(C)();
  assert.strictEqual(corrected, 1);
  hotkeys.suspend(true);
  assert.strictEqual(bindings.size, 0);
  hotkeys.suspend(false);
  bindings.get(C)();
  assert.strictEqual(corrected, 2);
  assert.strictEqual(hotkeys.applyAll({ ...next, correct: "CommandOrControl+Alt+X" }).correct.ok, false);
  assert.ok(bindings.has(C));
  assert.strictEqual(hotkeys.applyAll({ ...next, correct: "" }).correct.empty, true);
  assert.ok(!bindings.has(C));
});
test("correction collisions do not steal any existing shortcut, including idle discard", () => {
  const { hotkeys, bindings } = loadHotkeys();
  const D = "CommandOrControl+Alt+D";
  const next = { record: A, pause: B, discard: D, correct: C, onRecord() {}, onPause() {}, onDiscard() {}, onCorrect() {} };
  hotkeys.applyAll(next);
  for (const correct of [A, B, D]) {
    assert.strictEqual(hotkeys.applyAll({ ...next, correct }).correct.ok, false);
    assert.ok(bindings.has(C));
  }
  for (const slot of ["record", "pause", "discard"]) {
    assert.strictEqual(hotkeys.applyAll({ ...next, [slot]: C })[slot].ok, false);
    assert.ok(bindings.has(C));
  }
});

test("transferring a correction key to dictation can roll back after a settings write failure", () => {
  const { hotkeys, bindings } = loadHotkeys();
  const D = "CommandOrControl+Alt+D";
  const original = { record: A, pause: B, correct: C, onRecord() {}, onPause() {}, onCorrect() {} };
  hotkeys.applyAll(original);
  const changed = hotkeys.applyAll({ ...original, record: C, correct: D });
  assert.strictEqual(changed.record.ok, true);
  assert.strictEqual(changed.correct.ok, true);
  const rollback = hotkeys.applyAll(original);
  assert.strictEqual(rollback.record.ok, true);
  assert.strictEqual(rollback.correct.ok, true);
  assert.deepStrictEqual(new Set(bindings.keys()), new Set([A, B, C]));
});

// Correction transactions: a swap or transfer with a dictation slot completes
// or leaves every binding as it was, and a clash is charged to the changed slot.
function correctionSlots(hotkeys) {
  const fired = [];
  const next = {
    record: A, pause: B, discard: "CommandOrControl+Alt+D", correct: C,
    onRecord: () => fired.push("record"), onPause: () => fired.push("pause"),
    onDiscard: () => fired.push("discard"), onCorrect: () => fired.push("correct"),
  };
  assert.ok(Object.values(hotkeys.applyAll(next)).every((result) => result.ok));
  return { next, fired };
}

test("a dictation slot moving onto the unchanged correction key is the only one charged", () => {
  for (const slot of ["record", "pause", "discard"]) {
    const { hotkeys, bindings } = loadHotkeys();
    const { next, fired } = correctionSlots(hotkeys);
    const results = hotkeys.applyAll({ ...next, [slot]: C });
    assert.deepStrictEqual(results[slot], {
      ok: false, error: `"${prettyHotkey(C)}" is already used by the correction hotkey`,
    });
    assert.deepStrictEqual(results.correct, { ok: true }, `${slot}: correction still works`);
    bindings.get(C)();
    assert.deepStrictEqual(fired, ["correct"]);
  }
});

test("a correction key moving onto an unchanged dictation key is the only one charged", () => {
  const { hotkeys, bindings } = loadHotkeys();
  const { next, fired } = correctionSlots(hotkeys);
  const results = hotkeys.applyAll({ ...next, correct: A });
  assert.strictEqual(results.record.ok, true);
  assert.strictEqual(results.correct.ok, false);
  assert.match(results.correct.error, /used by the record hotkey/);
  bindings.get(A)();
  bindings.get(C)();
  assert.deepStrictEqual(fired, ["record", "correct"]);
});

test("when both slots change into one key, or on a cold start, the correction key yields", () => {
  const { hotkeys, bindings } = loadHotkeys();
  const { next } = correctionSlots(hotkeys);
  const X = "CommandOrControl+Alt+X";
  const both = hotkeys.applyAll({ ...next, record: X, correct: X });
  assert.strictEqual(both.record.ok, true);
  assert.match(both.correct.error, /used by the record hotkey/);
  assert.ok(bindings.has(C), "the old correction key is kept");

  const cold = loadHotkeys();
  const results = cold.hotkeys.applyAll({ record: A, pause: "", correct: A, onRecord() {}, onPause() {}, onCorrect() {} });
  assert.strictEqual(results.record.ok, true);
  assert.strictEqual(results.correct.ok, false);
  assert.deepStrictEqual([...cold.bindings.keys()], [A]);
});

test("correction swaps with record, pause and discard, then rolls back to the saved settings", () => {
  for (const slot of ["record", "pause", "discard"]) {
    for (const live of [false, true]) {
      const label = `${slot}, dictation ${live ? "live" : "idle"}`;
      const { hotkeys, bindings } = loadHotkeys();
      const { next, fired } = correctionSlots(hotkeys);
      hotkeys.armDiscard(live);
      const theirs = next[slot];
      // Discard is held by the OS only while a dictation is live.
      const held = (key, owner) => owner !== "discard" || live ? bindings.has(key) : !bindings.has(key);
      const press = (key) => bindings.get(key)?.();

      const swapped = hotkeys.applyAll({ ...next, [slot]: C, correct: theirs });
      assert.ok(Object.values(swapped).every((result) => result.ok), `${label}: ${JSON.stringify(swapped)}`);
      assert.ok(held(C, slot) && held(theirs, "correct"), `${label}: swapped`);
      press(theirs);
      press(C);
      assert.deepStrictEqual(fired, slot !== "discard" || live ? ["correct", slot] : ["correct"], label);

      // A failed settings write re-applies the previous settings.
      const rollback = hotkeys.applyAll(next);
      assert.ok(Object.values(rollback).every((result) => result.ok), `${label}: rollback ${JSON.stringify(rollback)}`);
      assert.ok(held(theirs, slot) && held(C, "correct"), `${label}: restored`);
      assert.strictEqual(bindings.has(next.discard), live, `${label}: discard held only while live`);
      fired.length = 0;
      press(C);
      press(theirs);
      assert.deepStrictEqual(fired, slot !== "discard" || live ? ["correct", slot] : ["correct"], label);
    }
  }
});

test("a three-way rotation through the correction key completes", () => {
  const { hotkeys, bindings } = loadHotkeys();
  const { next, fired } = correctionSlots(hotkeys);
  const results = hotkeys.applyAll({ ...next, record: B, pause: C, correct: A });
  assert.ok(Object.values(results).every((result) => result.ok), JSON.stringify(results));
  for (const key of [A, B, C]) bindings.get(key)();
  assert.deepStrictEqual(fired, ["correct", "record", "pause"]);
});

test("a swap the OS refuses halfway keeps both old bindings", () => {
  // record takes C (just released) but the OS refuses A for correction.
  const { hotkeys, bindings } = loadHotkeys({
    registerImpl: (accelerator, attempt) => !(accelerator === A && attempt === 2),
  });
  const { next, fired } = correctionSlots(hotkeys);
  const results = hotkeys.applyAll({ ...next, record: C, correct: A });
  assert.deepStrictEqual(results.record, { ok: false, error: "Not changed: the correction hotkey could not be registered" });
  assert.strictEqual(results.correct.ok, false);
  assert.match(results.correct.error, /Could not register/);
  bindings.get(A)();
  bindings.get(C)();
  assert.deepStrictEqual(fired, ["record", "correct"]);
});

test("a swap whose dictation side the OS refuses keeps the correction key", () => {
  const { hotkeys, bindings } = loadHotkeys({
    registerImpl: (accelerator, attempt) => !(accelerator === C && attempt === 2),
  });
  const { next, fired } = correctionSlots(hotkeys);
  const results = hotkeys.applyAll({ ...next, record: C, correct: A });
  assert.strictEqual(results.record.ok, false);
  assert.match(results.record.error, /Could not register/);
  assert.deepStrictEqual(results.correct, { ok: false, error: "Not changed: the record hotkey could not be registered" });
  bindings.get(A)();
  bindings.get(C)();
  assert.deepStrictEqual(fired, ["record", "correct"]);
});

test("a dictation slot waiting for the correction key stays put when the correction key cannot move", () => {
  const X = "CommandOrControl+Alt+X";
  const { hotkeys, bindings } = loadHotkeys({ occupied: [X] });
  const { next, fired } = correctionSlots(hotkeys);
  const results = hotkeys.applyAll({ ...next, record: C, pause: "CommandOrControl+Alt+P2", correct: X });
  assert.deepStrictEqual(results.record, { ok: false, error: "Not changed: the correction hotkey could not be registered" });
  assert.strictEqual(results.pause.ok, true, "an unrelated change still lands");
  assert.strictEqual(results.correct.ok, false);
  bindings.get(A)();
  bindings.get(C)();
  assert.deepStrictEqual(fired, ["record", "correct"]);
});

test("a swap that cannot retake the old correction key reports it unbound", () => {
  const { hotkeys, bindings } = loadHotkeys({
    // A refused for correction, then C refused when it is taken back.
    registerImpl: (accelerator, attempt) => !(accelerator === A && attempt === 2) && !(accelerator === C && attempt === 3),
  });
  const { next } = correctionSlots(hotkeys);
  const results = hotkeys.applyAll({ ...next, record: C, correct: A });
  assert.strictEqual(results.correct.unbound, true);
  assert.match(results.correct.error, /now unbound/);
  assert.ok(bindings.has(A), "record is back on its own key");
  hotkeys.suspend(true);
  hotkeys.suspend(false);
  assert.ok(!bindings.has(C), "an unbound correction key is not re-grabbed after capture");
});

test("a failed correction swap restores a pause key temporarily taken by live discard", () => {
  const { hotkeys, bindings, calls } = loadHotkeys({
    registerImpl: (accelerator, attempt) => !(accelerator === A && attempt === 2),
  });
  const { next, fired } = correctionSlots(hotkeys);
  hotkeys.armDiscard(true);
  const results = hotkeys.applyAll({ ...next, record: C, pause: "", discard: B, correct: A });
  assert.deepStrictEqual(new Set(bindings.keys()), new Set([A, B, C, next.discard]));
  for (const key of [A, B, C, next.discard]) bindings.get(key)();
  assert.deepStrictEqual(fired, ["record", "pause", "correct", "discard"]);
  for (const slot of ["record", "pause", "discard"]) {
    assert.deepStrictEqual(results[slot], { ok: false, error: "Not changed: the correction hotkey could not be registered" });
  }
  assert.strictEqual(results.correct.ok, false);
  assert.match(results.correct.error, /Could not register/);
  assert.strictEqual(results.correct.unbound, undefined);
  assert.deepStrictEqual(calls.warnings, []);
  hotkeys.armDiscard(false);
  assert.deepStrictEqual(new Set(bindings.keys()), new Set([A, B, C]));
});

test("a refused pair restore releases temporary callbacks before retaking correction", () => {
  const E = "CommandOrControl+Alt+E";
  const { hotkeys, bindings } = loadHotkeys({
    // Refuse A for correction, then B when restoring the original pair.
    registerImpl: (accelerator, attempt) => !(accelerator === A && attempt === 2) && !(accelerator === B && attempt === 2),
  });
  const { next, fired } = correctionSlots(hotkeys);
  hotkeys.armDiscard(true);
  const results = hotkeys.applyAll({ ...next, record: C, pause: E, correct: A });
  assert.strictEqual(results.record.unbound, true);
  assert.strictEqual(results.pause.unbound, true);
  assert.strictEqual(results.correct.unbound, undefined);
  assert.deepStrictEqual(new Set(bindings.keys()), new Set([C, next.discard]));
  bindings.get(C)();
  assert.deepStrictEqual(fired, ["correct"], "the correction key no longer triggers the temporary record callback");
  hotkeys.suspend(true);
  hotkeys.suspend(false);
  assert.deepStrictEqual(new Set(bindings.keys()), new Set([C, next.discard]), "capture cannot resurrect rejected pair bindings");
});

test("a refused discard restore drops its temporary correction-key grab", () => {
  let reject = false;
  const D = "CommandOrControl+Alt+D";
  const { hotkeys, bindings } = loadHotkeys({
    registerImpl: (accelerator) => {
      if (reject && accelerator === D) { reject = false; return false; }
      return true;
    },
  });
  const { next, fired } = correctionSlots(hotkeys);
  hotkeys.armDiscard(true);
  reject = true;
  const results = hotkeys.applyAll({ ...next, record: D, pause: "", discard: C, correct: A });
  assert.strictEqual(results.discard.unbound, true);
  assert.match(results.discard.error, /saved discard hotkey is now unbound/);
  assert.strictEqual(results.correct.unbound, undefined);
  assert.deepStrictEqual(new Set(bindings.keys()), new Set([A, B, C]));
  for (const key of [A, B, C]) bindings.get(key)();
  assert.deepStrictEqual(fired, ["record", "pause", "correct"]);
  hotkeys.armDiscard(false);
  hotkeys.armDiscard(true);
  assert.deepStrictEqual(new Set(bindings.keys()), new Set([A, B, C]), "rejected discard must not re-arm on correction's key");
});

test("combined transfers and one-shot OS failures match reported slots and callback ownership", () => {
  const D = "CommandOrControl+Alt+D";
  const E = "CommandOrControl+Alt+E";
  const values = ["", A, B, C, D, E];
  const slots = ["record", "pause", "discard", "correct"];
  const before = { record: A, pause: B, discard: D, correct: C };
  const callbacks = Object.fromEntries(slots.map((slot) => [
    `on${slot[0].toUpperCase()}${slot.slice(1)}`, () => slot,
  ]));
  let checked = 0;
  for (const fail of values) for (const live of [false, true]) {
    for (const record of values) for (const pause of values) for (const discard of values) for (const correct of values) {
      const target = { record, pause, discard, correct };
      const keys = Object.values(target).filter(Boolean);
      if (!record || new Set(keys).size !== keys.length) continue;
      let ready = false;
      let injected = false;
      const { hotkeys, bindings } = loadHotkeys({ registerImpl: (accelerator) => {
        if (ready && fail && accelerator === fail && !injected) {
          injected = true;
          return false;
        }
        return true;
      } });
      hotkeys.applyAll({ ...before, ...callbacks });
      hotkeys.armDiscard(live);
      ready = true;
      const result = hotkeys.applyAll({ ...target, ...callbacks });
      const label = JSON.stringify({ target, fail, live, result });
      const expected = new Map();
      for (const slot of slots) {
        if (result[slot].unbound) {
          assert.strictEqual(result[slot].ok, false, label);
          continue;
        }
        const key = result[slot].ok ? target[slot] : before[slot];
        if (key && (slot !== "discard" || live)) expected.set(key, slot);
      }
      assert.deepStrictEqual(new Set(bindings.keys()), new Set(expected.keys()), label);
      for (const [key, slot] of expected) assert.strictEqual(bindings.get(key)(), slot, label);
      checked++;
    }
  }
  assert.strictEqual(checked, 4380);
});

// #286: a pair slot moving onto the old discard key in the same save that
// moves discard off it — when discard's new key fails, discard never left.
for (const slot of ["record", "pause"]) {
  test(`${slot} taking the old discard key rolls back when the new discard key fails`, () => {
    const { hotkeys, bindings } = loadHotkeys({ occupied: [E] });
    hotkeys.applyAll(all(A, B, D));
    const attempt = slot === "record" ? all(D, B, E) : all(A, D, E);

    const result = hotkeys.applyAll(attempt);

    assert.strictEqual(result.discard.ok, false);
    assert.strictEqual(result[slot].ok, false, `${slot} is reported not changed`);
    assert.match(result[slot].error, /still the discard hotkey/);
    // Distinct again: the pair slot is back on its old key, discard keeps D.
    assert.strictEqual(bindings.has(slot === "record" ? A : B), true);
    assert.strictEqual(bindings.has(D), false, "D is discard's, not held while idle");
    hotkeys.armDiscard(true);
    assert.strictEqual(bindings.has(D), true, "the next dictation's discard arms");
  });
}

test("if the rolled-back key is gone too, discard yields and is reported unbound", () => {
  const occupied = [E];
  const { hotkeys, bindings } = loadHotkeys({ occupied });
  hotkeys.applyAll(all(A, B, D));
  // Another app grabs A the moment record lets go of it.
  occupied.push(A);
  const result = hotkeys.applyAll(all(D, B, E));

  assert.strictEqual(result.record.ok, true, "record keeps D");
  assert.strictEqual(result.discard.ok, false);
  assert.strictEqual(result.discard.cleared, true);
  assert.match(result.discard.error, /now unbound/);
  hotkeys.armDiscard(true);
  assert.strictEqual(bindings.get(D) !== undefined, true, "D belongs to record alone");
});

test("a pair slot taking discard's key while discard's move is rejected as a clash rolls back", () => {
  // pause -> D (discard's key) and discard -> A (record's unchanged key, a clash).
  const { hotkeys, bindings } = loadHotkeys();
  hotkeys.applyAll(all(A, B, D));
  const result = hotkeys.applyAll(all(A, D, A));
  assert.strictEqual(result.discard.ok, false);
  assert.strictEqual(result.pause.ok, false, "pause didn't move onto the key discard kept");
  assert.strictEqual(bindings.has(B), true);
  hotkeys.armDiscard(true);
  assert.strictEqual(bindings.has(D), true, "discard still arms on D");
});

test("when both pair slots moved, a failed discard move rolls both back instead of dropping discard", () => {
  // record A -> D, pause B -> A, discard D -> E (occupied).
  const { hotkeys, bindings } = loadHotkeys({ occupied: [E] });
  hotkeys.applyAll(all(A, B, D));
  const result = hotkeys.applyAll(all(D, A, E));
  assert.strictEqual(result.record.ok, false);
  assert.strictEqual(result.pause.ok, false);
  assert.ok(!result.discard.cleared, "discard kept its key");
  assert.strictEqual(bindings.has(A) && bindings.has(B), true);
  hotkeys.armDiscard(true);
  assert.strictEqual(bindings.has(D), true);
});

test("a hand-edited clash at launch still makes discard yield", () => {
  const { hotkeys } = loadHotkeys();
  const result = hotkeys.applyAll(all(A, D, D));
  assert.strictEqual(result.pause.ok, true);
  assert.strictEqual(result.discard.ok, false);
});

test("a correction rotation's rollback never moves record off its restored key", () => {
  // record A, pause B, discard D, correction C; another app holds D while
  // idle. One save: record -> C, discard -> A, correction -> D.
  const C = "CommandOrControl+Alt+C";
  const occupied = [];
  const { hotkeys, bindings } = loadHotkeys({ occupied });
  const f = () => {};
  hotkeys.applyAll({ record: A, pause: B, discard: D, correct: C, onRecord: f, onPause: f, onDiscard: f, onCorrect: f });
  occupied.push(D);
  const result = hotkeys.applyAll({ record: C, pause: B, discard: A, correct: D, onRecord: f, onPause: f, onDiscard: f, onCorrect: f });
  assert.ok(!result.record.unbound, `record stays bound: ${JSON.stringify(result.record)}`);
  assert.strictEqual(bindings.has(A), true, "record is back on A");
});
