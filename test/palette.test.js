const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createPalette } = require("../main/palette");
function fixture() {
  let idle = true, resolveLoad, copies = 0;
  const actions = { lastTranscript: () => "last", copyLast: async () => { copies++; }, correctLast: () => {}, checkUpdates: () => {}, openLog: () => {} };
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.webContents.isDestroyed = () => false;
  win.isDestroyed = () => false;
  win.show = () => { win.shown = true; };
  win.focus = () => {};
  win.destroy = () => { win.emit("closed"); };
  const entries = [{ id: "saved", text: "<img src=x onerror=alert(1)>", raw: "original" }];
  const destinations = [];
  const palette = createPalette({
    windows: { createPaletteWindow: () => win, loadPalette: () => new Promise(r => { resolveLoad = r; }), openSettings: d => destinations.push(d), paletteCaller: () => true },
    pipeline: { isPaletteIdle: () => idle },
    history: { search: ({ limit }) => ({ entries: entries.slice(0, limit), total: entries.length }), list: () => entries, isValidId: id => typeof id === "string" },
    settings: { get: () => ({ history: { enabled: true } }) },
    actions,
  });
  return { palette, win, entries, destinations, actions, copies: () => copies, busy: () => { idle = false; }, loaded: async () => { resolveLoad(); await Promise.resolve(); await Promise.resolve(); } };
}
test("reserve singleton before load; close during load never shows", async () => {
  const f = fixture(); f.palette.open(); f.palette.open();
  assert.equal(f.palette.isOpen(), true);
  assert.equal(f.win.shown, undefined);
  assert.equal(f.palette.dismissForDictation(), true);
  await f.loaded(); assert.equal(f.win.shown, undefined);
  assert.equal(f.palette.isOpen(), false);
});
test("busy refusal and recheck before asynchronous show", async () => {
  const f = fixture(); f.palette.open(); f.busy(); await f.loaded();
  assert.equal(f.win.shown, undefined); assert.equal(f.palette.isOpen(), false);
  assert.equal(f.palette.open(), false);
});
test("sender, malformed query and unknown command are rejected", async () => {
  const f = fixture(); f.palette.open(); await f.loaded();
  assert.throws(() => f.palette.query({}, ""), /window/);
  assert.throws(() => f.palette.query(f.win.webContents, {}), /text/);
  assert.throws(() => f.palette.query(f.win.webContents, "x".repeat(201)), /200/);
  await assert.rejects(f.palette.execute(f.win.webContents, { id: "settings:save" }), /command/);
});
test("history is bounded, previews remain text and deletion is authoritative", async () => {
  const f = fixture(); f.palette.open(); await f.loaded();
  for (let i = 0; i < 20; i++) f.entries.push({ id: `older-${i}`, text: "older" });
  const results = f.palette.query(f.win.webContents, "");
  assert.equal(results.items.filter(item => item.id === "history").length, 8);
  assert.equal(results.total, 21);
  assert.ok(results.items.some(i => i.label.includes("<img")));
  f.entries.length = 0;
  await assert.rejects(f.palette.execute(f.win.webContents, { id: "history", entryId: "saved", query: "" }), /History/);
});
test("one session dispatches at most once, even with concurrent Enter and click", async () => {
  const f = fixture(); f.palette.open(); await f.loaded();
  await Promise.allSettled([f.palette.execute(f.win.webContents, { id: "copy" }), f.palette.execute(f.win.webContents, { id: "copy" })]);
  assert.equal(f.copies(), 1);
});
test("navigation carries query and entry; busy execution cannot dispatch", async () => {
  const f = fixture(); f.palette.open(); await f.loaded();
  await f.palette.execute(f.win.webContents, { id: "history", entryId: "saved", query: "original" });
  assert.deepEqual(f.destinations, [{ section: "history", query: "original", entryId: "saved" }]);
  const g = fixture(); g.palette.open(); await g.loaded(); g.busy();
  await assert.rejects(g.palette.execute(g.win.webContents, { id: "copy" }), /dictation/);
  assert.equal(g.copies(), 0);
});
test("blur and renderer crash release the reservation", async () => {
  for (const event of ["blur", "render-process-gone"]) {
    const f = fixture(); f.palette.open(); await f.loaded();
    (event === "blur" ? f.win : f.win.webContents).emit(event);
    assert.equal(f.palette.isOpen(), false);
  }
});

test("failed load releases the reservation and allows a new open", async () => {
  let rejectLoad;
  const win = new EventEmitter();
  win.webContents = new EventEmitter(); win.isDestroyed = () => false;
  win.destroy = () => win.emit("closed");
  const palette = createPalette({ windows: { createPaletteWindow: () => win, loadPalette: () => new Promise((_, reject) => { rejectLoad = reject; }) }, pipeline: { isPaletteIdle: () => true } });
  palette.open(); rejectLoad(new Error("load failed"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(palette.isOpen(), false);
  assert.equal(palette.open(), true);
  palette.close();
});

test("stale availability prevents copying; failed actions remain single-dispatch and blur-dismissable", async () => {
  const f = fixture(); f.palette.open(); await f.loaded();
  assert.equal(f.palette.query(f.win.webContents, "copy").items[0].disabled, false);
  f.actions.lastTranscript = () => null;
  await assert.rejects(f.palette.execute(f.win.webContents, { id: "copy" }), /No transcription/);
  assert.equal(f.copies(), 0);
  f.actions.lastTranscript = () => "retained text";
  f.actions.copyLast = async () => { throw new Error("clipboard unavailable"); };
  await assert.rejects(f.palette.execute(f.win.webContents, { id: "copy" }), /clipboard unavailable/);
  await assert.rejects(f.palette.execute(f.win.webContents, { id: "copy" }), /already/);
  assert.equal(f.actions.lastTranscript(), "retained text");
  f.win.emit("blur");
  assert.equal(f.palette.isOpen(), false);
});
test("navigation History and Open History preserve their distinct query semantics", async () => {
  for (const id of ["nav-history", "history-search"]) {
    const f = fixture(); f.palette.open(); await f.loaded();
    await f.palette.execute(f.win.webContents, { id, query: "history" });
    assert.deepEqual(f.destinations[0], id === "nav-history" ? { section: "history" } : { section: "history", query: "history" });
  }
});
