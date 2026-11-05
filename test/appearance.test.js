// main/appearance.js (#348): the Appearance setting drives Electron's
// nativeTheme.themeSource, and a theme change repaints the framed windows'
// native background. Loaded fresh per test against a fake nativeTheme.

const { test } = require("node:test");
const assert = require("node:assert");
const { withStubs } = require("./helpers/stub-modules");

const APPEARANCE = require.resolve("../main/appearance");
const SETTINGS = require.resolve("../main/settings");
const WINDOWS = require.resolve("../main/windows");

function loadAppearance(stored) {
  const listeners = [];
  const themeHandlers = {};
  const sources = []; // every themeSource assignment, in order
  let source = "system";
  const nativeTheme = {
    get themeSource() {
      return source;
    },
    set themeSource(value) {
      sources.push(value);
      source = value;
    },
    on: (event, fn) => {
      themeHandlers[event] = fn;
    },
  };
  let cfg = stored;
  let refreshed = 0;
  const appearance = withStubs(
    {
      [require.resolve("electron")]: { nativeTheme },
      [SETTINGS]: {
        get: () => cfg,
        onChanged: (fn) => {
          listeners.push(fn);
          return () => {};
        },
      },
      [WINDOWS]: { refreshInk: () => refreshed++ },
    },
    [APPEARANCE],
    () => require(APPEARANCE)
  );
  const change = (next) => {
    const previous = cfg;
    cfg = next;
    for (const fn of listeners) fn({ previous, current: next });
  };
  return { appearance, sources, themeHandlers, change, refreshed: () => refreshed, listeners };
}

test("init sets themeSource from the saved appearance", () => {
  for (const value of ["light", "dark"]) {
    const { appearance, sources } = loadAppearance({ appearance: value });
    appearance.init();
    assert.deepStrictEqual(sources, [value]);
  }
  // "system" is already Electron's default: nothing to assign.
  const { appearance, sources } = loadAppearance({ appearance: "system" });
  appearance.init();
  assert.deepStrictEqual(sources, []);
});

test("an unknown or missing appearance follows the OS", () => {
  for (const value of [undefined, "sepia", "", 3]) {
    const { appearance } = loadAppearance({});
    assert.strictEqual(appearance.themeSourceFor(value), "system", String(value));
  }
  const { appearance, sources } = loadAppearance({ appearance: "dark" });
  appearance.init();
  assert.deepStrictEqual(sources, ["dark"]);
});

test("a saved change re-sets themeSource; an unrelated save leaves it alone", () => {
  const { appearance, sources, change } = loadAppearance({ appearance: "dark", hotkey: "F9" });
  appearance.init();
  change({ appearance: "dark", hotkey: "F10" });
  assert.deepStrictEqual(sources, ["dark"], "same appearance: no reassignment");
  change({ appearance: "light" });
  change({ appearance: "system" });
  assert.deepStrictEqual(sources, ["dark", "light", "system"]);
});

test("a nativeTheme update repaints the framed windows' ink", () => {
  const { appearance, themeHandlers, refreshed } = loadAppearance({ appearance: "system" });
  appearance.init();
  assert.strictEqual(typeof themeHandlers.updated, "function");
  themeHandlers.updated();
  themeHandlers.updated();
  assert.strictEqual(refreshed(), 2);
});

test("init is idempotent: one settings listener, one theme listener", () => {
  const { appearance, listeners } = loadAppearance({ appearance: "light" });
  appearance.init();
  appearance.init();
  assert.strictEqual(listeners.length, 1);
});

test("the setting's values are exactly Electron's themeSource values", () => {
  const { appearance } = loadAppearance({});
  assert.deepStrictEqual(appearance.APPEARANCES, ["system", "light", "dark"]);
  // main/settings.js keeps the same list for normalization.
  const settingsSrc = require("node:fs").readFileSync(SETTINGS, "utf8");
  const list = settingsSrc.match(/const APPEARANCES = (\[[^\]]*\]);/);
  assert.ok(list, "main/settings.js must declare APPEARANCES");
  assert.deepStrictEqual(JSON.parse(list[1]), appearance.APPEARANCES);
});
