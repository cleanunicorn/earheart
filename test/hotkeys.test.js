const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

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
    `Could not restore "${B}" after rollback. The pause hotkey is now unbound until you save again or restart.`,
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
    `The pause hotkey could not be registered. Could not restore "${A}" after rollback. The record hotkey is now unbound until you save again or restart.`
  );
  assert.doesNotMatch(failed.record.error, /Not changed/);
  assert.deepStrictEqual(calls.warnings, [
    `Could not restore "${A}" after rollback. The record hotkey is now unbound until you save again or restart.`,
  ]);
  assert.strictEqual(bindings.has(A), false);
  assert.strictEqual(bindings.has(B), true);
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
