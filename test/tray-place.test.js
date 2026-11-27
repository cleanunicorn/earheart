// main/util/tray-place.js: copy that sends people to Earheart's icon menu
// names the tray everywhere but macOS, where it is the menu bar.
const { test } = require("node:test");
const assert = require("node:assert");
const { trayOrMenuBar } = require("../main/util/tray-place");

test("the menu bar on macOS, the tray everywhere else", () => {
  const choices = { tray: "tray", menuBar: "menu bar" };
  assert.equal(trayOrMenuBar(choices, "darwin"), "menu bar");
  assert.equal(trayOrMenuBar(choices, "win32"), "tray");
  assert.equal(trayOrMenuBar(choices, "linux"), "tray");
});

test("it reads this machine's platform by default", () => {
  const choices = { tray: "tray", menuBar: "menu bar" };
  assert.equal(trayOrMenuBar(choices), process.platform === "darwin" ? "menu bar" : "tray");
});
