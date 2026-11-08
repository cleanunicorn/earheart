// Selection capture (main/commands/selection.js, #344): the user's clipboard is
// borrowed and must come back on every path, and a failed capture must say
// why instead of returning an empty or stale selection.

const { test } = require("node:test");
const assert = require("node:assert");
const { createSelectionCapture } = require("../main/commands/selection");
const { MAX_SELECTION_CHARS } = require("../main/util/transform-turn");

// A clipboard fake holding text plus an "other" payload (an image, say) that
// only the snapshot/restore pair can bring back.
function fakeClipboard(initial = { text: "USER-CLIPBOARD", other: "image-bytes" }) {
  const state = { ...initial };
  return {
    state,
    readText: () => state.text ?? "",
    writeText(text) { state.text = text; delete state.other; },
    clear() { delete state.text; delete state.other; },
  };
}

function rig({ copies, platform = {}, clipboard = fakeClipboard(), copyTimeoutMs = 60 } = {}) {
  const calls = { copy: 0, restores: 0 };
  const fakePlatform = {
    captureSupport: () => ({ ok: true }),
    secureInputActive: async () => false,
    waitForModifiersReleased: async () => true,
    // What the target app does when sent Ctrl+C: puts `copies` on the clipboard.
    sendCopy: async () => {
      calls.copy++;
      if (typeof copies === "function") return copies(clipboard);
      if (copies !== undefined) clipboard.state.text = copies;
    },
    ...platform,
  };
  const capture = createSelectionCapture({
    clipboard,
    snapshot: () => (clipboard.state.text !== undefined || clipboard.state.other !== undefined ? { ...clipboard.state } : null),
    restore: (snap) => { calls.restores++; for (const k of Object.keys(clipboard.state)) delete clipboard.state[k]; Object.assign(clipboard.state, snap); },
    platform: fakePlatform,
    copyTimeoutMs,
    modifierWaitMs: 10,
  });
  return { capture: (signal) => capture.capture(signal), clipboard, calls };
}

const unchanged = (r) => assert.deepStrictEqual(r.clipboard.state, { text: "USER-CLIPBOARD", other: "image-bytes" });

test("a selection is returned and the clipboard is put back exactly", async () => {
  const r = rig({ copies: "selected words" });
  const result = await r.capture();
  assert.deepStrictEqual(result, { ok: true, text: "selected words" });
  unchanged(r);
});

test("an empty selection fails as empty and leaves the clipboard unchanged", async () => {
  const r = rig({ copies: undefined });
  const result = await r.capture();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "empty");
  unchanged(r);
});

test("a selection of only whitespace is empty", async () => {
  const r = rig({ copies: "  \n\t " });
  assert.strictEqual((await r.capture()).reason, "empty");
  unchanged(r);
});

test("the same text already on the clipboard is not mistaken for 'nothing selected'", async () => {
  // The sentinel makes a copy of identical text distinguishable from no copy.
  const r = rig({ clipboard: fakeClipboard({ text: "same" }), copies: "same" });
  assert.deepStrictEqual(await r.capture(), { ok: true, text: "same" });
  assert.deepStrictEqual(r.clipboard.state, { text: "same" });
});

test("a keystroke tool that fails reports unavailable and restores the clipboard", async () => {
  const r = rig({ copies: () => { throw new Error("xdotool: no display"); } });
  const result = await r.capture();
  assert.strictEqual(result.reason, "unavailable");
  unchanged(r);
});

test("a keystroke tool that hangs reports a timeout and restores the clipboard", async () => {
  const r = rig({ copies: () => { throw Object.assign(new Error("timed out"), { killed: true }); } });
  const result = await r.capture();
  assert.strictEqual(result.reason, "timeout");
  unchanged(r);
});

test("hotkey modifiers still held: no copy is sent, the clipboard is untouched", async () => {
  const r = rig({ copies: "never", platform: { waitForModifiersReleased: async () => false } });
  const result = await r.capture();
  assert.strictEqual(result.reason, "modifiers-held");
  assert.strictEqual(r.calls.copy, 0, "Ctrl+Alt+C must never be sent");
  unchanged(r);
});

test("the copy waits for the modifiers before it is sent", async () => {
  const order = [];
  const r = rig({
    copies: "words",
    platform: {
      waitForModifiersReleased: async () => { order.push("released"); return true; },
      sendCopy: async () => { order.push("copy"); r.clipboard.state.text = "words"; },
    },
  });
  await r.capture();
  assert.deepStrictEqual(order, ["released", "copy"]);
});

test("a secure field refuses the capture before anything is sent or written", async () => {
  const r = rig({ copies: "password", platform: { secureInputActive: async () => true } });
  const result = await r.capture();
  assert.strictEqual(result.reason, "secure");
  assert.strictEqual(r.calls.copy, 0);
  unchanged(r);
});

test("an unsupported platform is reported without touching the clipboard", async () => {
  const r = rig({ copies: "x", platform: { captureSupport: () => ({ ok: false, reason: "Install xdotool" }) } });
  const result = await r.capture();
  assert.deepStrictEqual([result.ok, result.reason, result.message], [false, "unavailable", "Install xdotool"]);
  assert.strictEqual(r.calls.copy, 0);
  unchanged(r);
});

test("a selection over the limit is refused, not truncated", async () => {
  const r = rig({ copies: "a".repeat(MAX_SELECTION_CHARS + 1) });
  assert.strictEqual((await r.capture()).reason, "too-long");
  unchanged(r);
  const ok = rig({ copies: "a".repeat(MAX_SELECTION_CHARS) });
  assert.strictEqual((await ok.capture()).ok, true);
});

test("cancelling before or during the capture leaves the clipboard unchanged", async () => {
  const early = rig({ copies: "x" });
  const controller = new AbortController();
  controller.abort();
  assert.strictEqual((await early.capture(controller.signal)).reason, "cancelled");
  assert.strictEqual(early.calls.copy, 0);
  unchanged(early);

  const live = new AbortController();
  const during = rig({ copies: undefined, copyTimeoutMs: 1000 });
  const pending = during.capture(live.signal);
  setTimeout(() => live.abort(), 30);
  assert.strictEqual((await pending).reason, "cancelled");
  unchanged(during);
});

test("a cancelled keystroke reports cancelled", async () => {
  const controller = new AbortController();
  const r = rig({ copies: () => { controller.abort(); throw Object.assign(new Error("aborted"), { aborted: true }); } });
  assert.strictEqual((await r.capture(controller.signal)).reason, "cancelled");
  unchanged(r);
});

test("another app's copy during the capture is never overwritten by the restore", async () => {
  const r = rig({
    copies: (clipboard) => { clipboard.state.text = "selected"; },
  });
  // Between the capture and the restore, something else copies.
  const realRead = r.clipboard.readText;
  let reads = 0;
  r.clipboard.readText = () => {
    const value = realRead();
    // The final check before restoring sees a foreign copy.
    return ++reads > 1 ? "FOREIGN COPY" : value;
  };
  const result = await r.capture();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(r.calls.restores, 0, "the user's newer copy wins");
  assert.strictEqual(r.clipboard.state.text, "selected");
});

test("an empty clipboard is left empty after a capture", async () => {
  const r = rig({ clipboard: fakeClipboard({}), copies: "words" });
  assert.strictEqual((await r.capture()).ok, true);
  assert.deepStrictEqual(r.clipboard.state, {});
});

test("a failing restore doesn't lose the selection", async () => {
  const clipboard = fakeClipboard();
  const capture = createSelectionCapture({
    clipboard,
    snapshot: () => ({ text: "x" }),
    restore: () => { throw new Error("clipboard busy"); },
    platform: {
      captureSupport: () => ({ ok: true }),
      secureInputActive: async () => false,
      waitForModifiersReleased: async () => true,
      sendCopy: async () => { clipboard.state.text = "words"; },
    },
    copyTimeoutMs: 50,
    modifierWaitMs: 1,
  });
  assert.deepStrictEqual(await capture.capture(), { ok: true, text: "words" });
});
