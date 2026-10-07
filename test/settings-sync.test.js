// renderer/settings-sync.js: how the Settings window and the wizard follow
// settings main saved while they were open (#190).

const { test } = require("node:test");
const assert = require("node:assert");
const {
  sharedBaseline,
  displayedOutputMode,
  followSettingsChanges,
} = require("../renderer/settings-sync");

// A fake preload bridge: capture the settings:changed handler.
function withFakeBridge(fn) {
  const handlers = {};
  const saved = globalThis.earheart;
  globalThis.earheart = { on: (channel, handler) => (handlers[channel] = handler) };
  try {
    return fn(handlers);
  } finally {
    if (saved === undefined) delete globalThis.earheart;
    else globalThis.earheart = saved;
  }
}

const change = (from, to) => ({ previous: { output: { mode: from } }, current: { output: { mode: to } } });

test("changes that arrive before the form loads are applied in order on ready()", () => {
  withFakeBridge((handlers) => {
    const applied = [];
    const ready = followSettingsChanges((c) => applied.push(`${c.previous.output.mode}>${c.current.output.mode}`));

    handlers["settings:changed"](change("paste", "clipboard"));
    handlers["settings:changed"](change("clipboard", "paste-copy"));
    assert.deepStrictEqual(applied, [], "nothing applies before the form has its settings");

    ready();
    assert.deepStrictEqual(applied, ["paste>clipboard", "clipboard>paste-copy"]);

    handlers["settings:changed"](change("paste-copy", "paste"));
    assert.deepStrictEqual(applied.at(-1), "paste-copy>paste", "after ready() changes apply at once");
  });
});

test("sharedBaseline reads the displayed mode and normalizes remind", () => {
  assert.deepStrictEqual(
    sharedBaseline({ output: { mode: "clipboard", restoreClipboard: true }, updates: { remind: false } }),
    { outputMode: "clipboard", remind: false }
  );
  assert.deepStrictEqual(sharedBaseline({ output: { mode: "paste", restoreClipboard: true }, updates: {} }), {
    outputMode: "paste",
    remind: true,
  });
  assert.strictEqual(
    sharedBaseline({ output: { mode: "paste", restoreClipboard: false }, updates: {} }).outputMode,
    "paste-copy"
  );
});

test("displayedOutputMode shows the legacy paste-without-restore encoding as paste-copy", () => {
  assert.strictEqual(displayedOutputMode({ mode: "paste", restoreClipboard: false }), "paste-copy");
  assert.strictEqual(displayedOutputMode({ mode: "paste", restoreClipboard: true }), "paste");
  assert.strictEqual(displayedOutputMode({ mode: "clipboard", restoreClipboard: false }), "clipboard");
});

// main compares the form's baseline against effectiveOutputMode; the two
// mappings must agree or a legacy profile reads as changed on every save.
test("the forms' legacy mapping matches main's effectiveOutputMode", () => {
  const { effectiveOutputMode } = require("../main/settings");
  for (const mode of ["paste", "paste-copy", "clipboard"]) {
    for (const restoreClipboard of [true, false]) {
      const output = { mode, restoreClipboard };
      assert.strictEqual(displayedOutputMode(output), effectiveOutputMode(output), JSON.stringify(output));
    }
  }
});
