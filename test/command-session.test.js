// The voice command state machine (main/commands/session.js, #344) against
// fakes for every edge: selection capture, the focused-window probe, the
// recorder/STT handover, the transform and the paste.
//
// What these pin is the safety contract: the selection is replaced only by an
// explicit Apply, of a complete result, over the same window and selection —
// and never by the spoken instruction. Stale ids, cancellation at every stage
// and a cancel racing a completion must leave the target untouched.

const { test } = require("node:test");
const assert = require("node:assert");
const { createCommandSession } = require("../main/commands/session");
const { TRANSFORM_TRUNCATED_MESSAGE, TRANSFORM_EMPTY_MESSAGE } = require("../main/util/transform-turn");

const SELECTION = "TOP-SECRET-SELECTION the quick brown fox";
const INSTRUCTION = "make this friendlier SPOKEN-INSTRUCTION";
const OUTPUT = "RESULT-TEXT a friendly fox";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function rig({
  config = {},
  selection = async () => ({ ok: true, text: SELECTION }),
  fingerprint = async () => ({ id: "x11:1", label: "Editor" }),
  fingerprintSupport = { ok: true, grain: "window" },
  transform = async () => OUTPUT,
  paste = async () => ({ method: "paste" }),
  startRecording,
} = {}) {
  const calls = { transform: [], pasted: [], copied: [], recordings: [], stops: 0, cancels: 0, views: [], logs: [] };
  const logger = {
    info: (...a) => calls.logs.push(a.join(" ")),
    warn: (...a) => calls.logs.push(a.join(" ")),
  };
  let handlers = null;
  let nextSid = 100;
  const platform = {
    captureSupport: () => ({ ok: true }),
    fingerprintSupport: () => fingerprintSupport,
    fingerprint: (signal) => fingerprint(signal),
  };
  const session = createCommandSession({
    getConfig: () => ({ engine: "builtin", timeoutMs: 5000, allowApply: true, ...config }),
    selection: { capture: (signal) => selection(signal) },
    platform,
    transform: (request, signal) => { calls.transform.push(request); return transform(request, signal); },
    startRecording: startRecording || ((h) => { handlers = h; calls.recordings.push(h); return ++nextSid; }),
    stopRecording: () => { calls.stops++; },
    cancelRecording: () => { calls.cancels++; },
    writeClipboard: (text) => calls.copied.push(text),
    paste: (text, signal) => { calls.pasted.push(text); return paste(text, signal); },
    onView: (view) => calls.views.push(view),
    logger,
  });
  return {
    session,
    calls,
    handlers: () => handlers,
    sid: () => nextSid,
    last: () => session.peek(),
    // Speak the instruction: the pipeline hands the transcript over.
    speak: (text = INSTRUCTION) => handlers.onTranscript(nextSid, text),
  };
}

async function toReady(r) {
  await r.session.begin();
  r.speak();
  await tick();
  assert.strictEqual(r.last().phase, "ready");
  return r.last().id;
}

test("a rewrite captures the selection, takes the spoken instruction and shows input and output", async () => {
  const r = rig();
  const started = await r.session.begin();
  assert.strictEqual(started.ok, true);
  assert.strictEqual(r.last().phase, "recording");
  assert.strictEqual(r.last().mode, "rewrite");
  assert.strictEqual(r.last().selection, SELECTION);

  r.speak();
  assert.strictEqual(r.last().phase, "transforming");
  await tick();
  const view = r.last();
  assert.strictEqual(view.phase, "ready");
  assert.strictEqual(view.selection, SELECTION, "the card keeps showing what is being rewritten");
  assert.strictEqual(view.instruction, INSTRUCTION);
  assert.strictEqual(view.output, OUTPUT);
  assert.strictEqual(view.canApply, true);
  assert.deepStrictEqual(r.calls.transform, [{ instruction: INSTRUCTION, selection: SELECTION }]);
  assert.deepStrictEqual(r.calls.pasted, [], "nothing is pasted without Apply");
});

test("with no selection it drafts from the brief and says why", async () => {
  const r = rig({ selection: async () => ({ ok: false, reason: "empty", message: "Nothing is selected" }) });
  await r.session.begin();
  assert.strictEqual(r.last().mode, "draft");
  assert.strictEqual(r.last().captureNote, "Nothing is selected");
  r.speak();
  await tick();
  assert.deepStrictEqual(r.calls.transform, [{ instruction: INSTRUCTION, selection: "" }]);
  assert.strictEqual(r.last().phase, "ready");
});

test("Apply pastes the result — never the instruction — and finishes", async () => {
  const r = rig();
  const id = await toReady(r);
  const result = await r.session.apply(id);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(r.calls.pasted, [OUTPUT]);
  assert.ok(!r.calls.pasted.includes(INSTRUCTION));
  assert.strictEqual(r.last().phase, "applied");
});

test("Apply is refused when the focused window is no longer the one the selection came from", async () => {
  let focused = { id: "x11:1" };
  const r = rig({ fingerprint: async () => focused });
  const id = await toReady(r);
  focused = { id: "x11:2" }; // the user moved on
  const result = await r.session.apply(id);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocked, true);
  assert.deepStrictEqual(r.calls.pasted, [], "target drift never receives the replacement");
  const view = r.last();
  assert.strictEqual(view.phase, "ready");
  assert.strictEqual(view.canApply, false, "no second automatic try");
  assert.strictEqual(view.canCopy, true, "falls back to Copy");
  assert.match(view.applyNote, /changed/);
  assert.strictEqual(view.output, OUTPUT);
});

test("Apply is refused when the selection in that window changed", async () => {
  let reads = 0;
  const r = rig({
    selection: async () => (reads++ === 0 ? { ok: true, text: SELECTION } : { ok: true, text: "something else" }),
  });
  const id = await toReady(r);
  const result = await r.session.apply(id);
  assert.strictEqual(result.blocked, true);
  assert.deepStrictEqual(r.calls.pasted, []);
  assert.strictEqual(r.last().canApply, false);
});

test("Apply is refused when the selection can no longer be read", async () => {
  let reads = 0;
  const r = rig({
    selection: async () => (reads++ === 0 ? { ok: true, text: SELECTION } : { ok: false, reason: "empty", message: "Nothing is selected" }),
  });
  const id = await toReady(r);
  assert.strictEqual((await r.session.apply(id)).blocked, true);
  assert.deepStrictEqual(r.calls.pasted, []);
});

test("without a fingerprint of the target (Wayland, unknown window) the result can only be copied", async () => {
  const r = rig({ fingerprintSupport: { ok: false, reason: "This desktop cannot identify the focused window" } });
  const id = await toReady(r);
  const view = r.last();
  assert.strictEqual(view.canApply, false);
  assert.match(view.applyNote, /cannot identify/);
  assert.deepStrictEqual(await r.session.apply(id), { ok: false, blocked: true, reason: view.applyNote });
  assert.deepStrictEqual(r.calls.pasted, []);
  assert.strictEqual(r.session.copy(id).ok, true);
  assert.deepStrictEqual(r.calls.copied, [OUTPUT]);
});

test("a window that can't be identified at capture time falls back to Copy", async () => {
  const r = rig({ fingerprint: async () => null });
  const id = await toReady(r);
  assert.strictEqual(r.last().canApply, false);
  assert.strictEqual((await r.session.apply(id)).blocked, true);
  assert.deepStrictEqual(r.calls.pasted, []);
});

test("Apply can be turned off in settings", async () => {
  const r = rig({ config: { allowApply: false } });
  const id = await toReady(r);
  assert.strictEqual(r.last().canApply, false);
  assert.strictEqual((await r.session.apply(id)).blocked, true);
  assert.deepStrictEqual(r.calls.pasted, []);
});

test("a paste that falls back to the clipboard keeps the result on the card", async () => {
  const r = rig({ paste: async () => ({ method: "clipboard", note: "Paste it with Ctrl+V" }) });
  const id = await toReady(r);
  const result = await r.session.apply(id);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(r.last().phase, "ready");
  assert.match(r.last().notice, /clipboard/);
  assert.strictEqual(r.last().output, OUTPUT);
});

test("another app taking the clipboard stops the paste and says so", async () => {
  const r = rig({ paste: async () => ({ method: "clipboard-changed" }) });
  const id = await toReady(r);
  await r.session.apply(id);
  assert.match(r.last().notice, /Another app changed the clipboard/);
  assert.strictEqual(r.last().phase, "ready");
});

test("a paste that throws leaves the result on screen", async () => {
  const r = rig({ paste: async () => { throw new Error("tool exploded"); } });
  const id = await toReady(r);
  const result = await r.session.apply(id);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(r.last().phase, "ready");
  assert.strictEqual(r.last().output, OUTPUT);
});

for (const [name, failure, kind] of [
  ["a result cut off at the length limit", () => { throw new Error(TRANSFORM_TRUNCATED_MESSAGE); }, "truncated"],
  ["an empty result", () => { throw new Error(TRANSFORM_EMPTY_MESSAGE); }, "empty"],
  ["a blank result from a client that didn't check", () => "   \n ", "empty"],
  ["a remote service error", () => { throw Object.assign(new Error("Command service error 500"), { status: 500 }); }, "failed"],
  ["a remote service timeout", () => { throw Object.assign(new Error("Command service didn't answer within 120 s"), { code: "SERVICE_TIMEOUT" }); }, "timeout"],
]) {
  test(`${name} fails the command, keeps the instruction and selection, and offers no Apply or Copy`, async () => {
    const r = rig({ transform: async () => failure() });
    await r.session.begin();
    r.speak();
    await tick();
    const view = r.last();
    assert.strictEqual(view.phase, "failed");
    assert.strictEqual(view.error.kind, kind);
    assert.strictEqual(view.selection, SELECTION);
    assert.strictEqual(view.instruction, INSTRUCTION);
    assert.strictEqual(view.output, null);
    assert.strictEqual(view.canApply, false);
    assert.strictEqual(view.canCopy, false);
    assert.strictEqual(view.canRetry, true);
    assert.deepStrictEqual(r.calls.pasted, []);
    assert.deepStrictEqual((await r.session.apply(view.id)).ok, false);
    assert.deepStrictEqual(r.calls.pasted, []);
  });
}

test("a transform that never answers times out on its own deadline", async () => {
  const r = rig({
    config: { timeoutMs: 20 },
    transform: (request, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  await r.session.begin();
  r.speak();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const view = r.last();
  assert.strictEqual(view.phase, "failed");
  assert.strictEqual(view.error.kind, "timeout");
  assert.match(view.error.message, /took longer than/);
  assert.strictEqual(view.instruction, INSTRUCTION);
  assert.strictEqual(view.selection, SELECTION);
});

test("Retry runs the transform again with the same instruction and selection", async () => {
  let attempt = 0;
  const r = rig({ transform: async () => { if (attempt++ === 0) throw new Error("boom"); return OUTPUT; } });
  await r.session.begin();
  r.speak();
  await tick();
  assert.strictEqual(r.last().phase, "failed");
  assert.strictEqual(r.session.retry(r.last().id).ok, true);
  await tick();
  assert.strictEqual(r.last().phase, "ready");
  assert.strictEqual(r.last().output, OUTPUT);
  assert.deepStrictEqual(r.calls.transform, [
    { instruction: INSTRUCTION, selection: SELECTION },
    { instruction: INSTRUCTION, selection: SELECTION },
  ]);
});

for (const error of [
  new Error("cleanup cancelled"),
  Object.assign(new Error("operation interrupted"), { name: "AbortError" }),
]) {
  test(`external transform interruption (${error.name}: ${error.message}) preserves input and allows Retry`, async () => {
    let attempt = 0;
    const r = rig({ transform: async (_request, signal) => {
      assert.strictEqual(signal.aborted, false);
      if (attempt++ === 0) throw error;
      return OUTPUT;
    } });
    await r.session.begin();
    r.speak();
    await tick();
    const view = r.last();
    assert.strictEqual(view.phase, "failed");
    assert.match(view.error.message, /interrupted.*retry/i);
    assert.strictEqual(view.selection, SELECTION);
    assert.strictEqual(view.instruction, INSTRUCTION);
    assert.strictEqual(view.output, null);
    assert.strictEqual(view.canApply, false);
    assert.strictEqual(view.canRetry, true);
    assert.deepStrictEqual(r.calls.pasted, []);
    assert.strictEqual(r.session.retry(view.id).ok, true);
    await tick();
    assert.strictEqual(r.last().phase, "ready");
    assert.strictEqual(r.last().output, OUTPUT);
    assert.deepStrictEqual(r.calls.transform[1], r.calls.transform[0]);
    r.session.dispose();
  });
}

/* ---- cancellation at every stage ---- */

test("cancel while reading the selection stops there: no recording, no transform, no paste", async () => {
  const gate = deferred();
  const r = rig({ selection: async (signal) => { signal.addEventListener("abort", () => gate.resolve({ ok: false, reason: "cancelled" })); return gate.promise; } });
  const started = r.session.begin();
  await tick();
  assert.strictEqual(r.last().phase, "capturing");
  r.session.cancel(r.last().id);
  assert.strictEqual((await started).cancelled, true);
  assert.strictEqual(r.last(), null);
  assert.strictEqual(r.calls.recordings.length, 0);
  assert.strictEqual(r.calls.transform.length, 0);
  assert.deepStrictEqual(r.calls.pasted, []);
});

test("cancel while recording cancels the take and drops a transcript that arrives late", async () => {
  const r = rig();
  await r.session.begin();
  const { id } = r.last();
  const h = r.handlers();
  const sid = r.sid();
  assert.strictEqual(r.session.cancel(id).ok, true);
  assert.strictEqual(r.calls.cancels, 1);
  h.onTranscript(sid, "late words");
  await tick();
  assert.strictEqual(r.calls.transform.length, 0);
  assert.strictEqual(r.last(), null);
});

test("cancelling the take from the overlay ends the whole command", async () => {
  const r = rig();
  await r.session.begin();
  r.handlers().onEnd(r.sid(), "cancelled");
  assert.strictEqual(r.last(), null);
  assert.strictEqual(r.calls.cancels, 0, "the take is already cancelled");
});

test("a failed take keeps the card, with Speak again but no Retry", async () => {
  const r = rig();
  await r.session.begin();
  r.handlers().onEnd(r.sid(), "error", "The speech service is down");
  const view = r.last();
  assert.strictEqual(view.phase, "failed");
  assert.strictEqual(view.error.message, "The speech service is down");
  assert.strictEqual(view.selection, SELECTION);
  assert.strictEqual(view.canRetry, false);
  const again = await r.session.restart(view.id);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(r.last().phase, "recording");
  assert.notStrictEqual(r.last().id, view.id);
});

test("hearing nothing is a failure that never reaches the transform", async () => {
  const r = rig();
  await r.session.begin();
  r.handlers().onEnd(r.sid(), "empty");
  assert.strictEqual(r.last().phase, "failed");
  assert.strictEqual(r.last().error.kind, "empty-speech");
  assert.strictEqual(r.calls.transform.length, 0);
});

test("cancel while the transform runs aborts it and drops its late result", async () => {
  const gate = deferred();
  let seenSignal;
  const r = rig({ transform: (request, signal) => { seenSignal = signal; return gate.promise; } });
  await r.session.begin();
  r.speak();
  const { id } = r.last();
  r.session.cancel(id);
  assert.strictEqual(seenSignal.aborted, true);
  gate.resolve(OUTPUT); // completes after the cancel
  await tick();
  assert.strictEqual(r.last(), null);
  assert.deepStrictEqual(r.calls.pasted, []);
  assert.strictEqual((await r.session.apply(id)).stale, true, "the cancelled command can't be applied");
});

test("a cancel racing a completion: whichever lands second is dropped", async () => {
  const gate = deferred();
  const r = rig({ transform: () => gate.promise });
  await r.session.begin();
  r.speak();
  const { id } = r.last();
  gate.resolve(OUTPUT);
  r.session.cancel(id); // synchronous: wins before the promise continuation
  await tick();
  assert.strictEqual(r.last(), null);
  assert.strictEqual(r.calls.views.at(-1), null);
});

test("cancel while Apply is in flight stops it before the paste", async () => {
  const gate = deferred();
  // The capture-time probe answers at once; only the Apply-time probe is held.
  let probes = 0;
  const r2 = rig({
    fingerprint: async () => (probes++ === 0 ? { id: "x11:1" } : gate.promise),
  });
  const id = await toReady(r2);
  const applying = r2.session.apply(id);
  await tick();
  assert.strictEqual(r2.last().phase, "applying");
  r2.session.cancel(id);
  gate.resolve({ id: "x11:1" });
  const result = await applying;
  assert.strictEqual(result.cancelled, true);
  assert.deepStrictEqual(r2.calls.pasted, [], "a cancelled Apply never pastes");
});

test("a cancelled paste in flight reports cancelled and leaves no applied state", async () => {
  const r = rig({ paste: async () => ({ method: "cancelled" }) });
  const id = await toReady(r);
  const result = await r.session.apply(id);
  assert.strictEqual(result.cancelled, true);
  assert.notStrictEqual(r.last()?.phase, "applied");
});

/* ---- identity ---- */

test("a new command invalidates the old id for every action", async () => {
  const r = rig();
  const oldId = await toReady(r);
  await r.session.begin();
  const newId = r.last().id;
  assert.notStrictEqual(oldId, newId);
  for (const result of [
    await r.session.apply(oldId), r.session.copy(oldId), r.session.retry(oldId), r.session.cancel(oldId), r.session.stop(oldId),
  ]) {
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stale, true);
  }
  assert.strictEqual(r.session.get(oldId), null);
  assert.strictEqual(r.last().id, newId, "the stale calls changed nothing");
  assert.deepStrictEqual(r.calls.pasted, []);
});

test("a transcript from an earlier take can't reach a newer command", async () => {
  const r = rig();
  await r.session.begin();
  const oldHandlers = r.handlers();
  const oldSid = r.sid();
  r.session.cancel(r.last().id);
  await r.session.begin();
  oldHandlers.onTranscript(oldSid, "stale words");
  await tick();
  assert.strictEqual(r.calls.transform.length, 0);
  assert.strictEqual(r.last().phase, "recording");
});

test("Apply only works from the ready state", async () => {
  const r = rig();
  await r.session.begin();
  const { id } = r.last();
  assert.strictEqual((await r.session.apply(id)).ok, false, "recording");
  r.speak();
  assert.strictEqual((await r.session.apply(id)).ok, false, "transforming");
  assert.deepStrictEqual(r.calls.pasted, []);
});

test("a double Apply pastes once", async () => {
  const gate = deferred();
  const r = rig({ paste: () => gate.promise });
  const id = await toReady(r);
  const first = r.session.apply(id);
  await tick();
  const second = await r.session.apply(id);
  assert.strictEqual(second.ok, false);
  gate.resolve({ method: "paste" });
  assert.strictEqual((await first).ok, true);
  assert.strictEqual(r.calls.pasted.length, 1);
});

/* ---- starting and stopping ---- */

test("the hotkey while recording finishes the take", async () => {
  const r = rig();
  await r.session.begin();
  const second = await r.session.begin();
  assert.strictEqual(second.stopped, true);
  assert.strictEqual(r.calls.stops, 1);
  assert.strictEqual(r.last().phase, "transcribing");
});

test("the hotkey during other work doesn't start a second command", async () => {
  const gate = deferred();
  const r = rig({ transform: () => gate.promise });
  await r.session.begin();
  r.speak();
  const again = await r.session.begin();
  assert.strictEqual(again.busy, true);
  assert.strictEqual(r.calls.recordings.length, 1);
});

test("when recording can't start the command fails visibly without a transform", async () => {
  const r = rig({ startRecording: () => false });
  const result = await r.session.begin();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(r.last().phase, "failed");
  assert.strictEqual(r.last().canRetry, false);
  assert.strictEqual(r.calls.transform.length, 0);
});

test("a recording stopped elsewhere (dictation hotkey, overlay) shows as transcribing", async () => {
  const r = rig();
  await r.session.begin();
  r.session.markTranscribing();
  assert.strictEqual(r.last().phase, "transcribing");
});

test("closing the window ends the command and its recording", async () => {
  const r = rig();
  await r.session.begin();
  r.session.dispose();
  assert.strictEqual(r.calls.cancels, 1);
  assert.strictEqual(r.session.peek(), null);
  assert.strictEqual(r.session.isActive(), false);
});

test("copy only offers a result that exists", async () => {
  const r = rig({ transform: async () => { throw new Error("boom"); } });
  await r.session.begin();
  r.speak();
  await tick();
  assert.strictEqual(r.session.copy(r.last().id).ok, false);
  assert.deepStrictEqual(r.calls.copied, []);
});

test("an over-long spoken instruction is cut, not sent whole", async () => {
  const r = rig();
  await r.session.begin();
  r.handlers().onTranscript(r.sid(), "x".repeat(10000));
  await tick();
  assert.strictEqual(r.calls.transform[0].instruction.length, 4000);
});

/* ---- privacy ---- */

test("nothing the user said, selected or received is ever logged", async () => {
  const failing = rig({ transform: async () => { throw new Error("service said no"); } });
  await failing.session.begin();
  failing.speak();
  await tick();
  failing.session.retry(failing.last().id);
  await tick();
  failing.session.cancel(failing.last().id);

  const ok = rig();
  const id = await toReady(ok);
  await ok.session.apply(id);

  const blocked = rig({ fingerprint: (() => { let n = 0; return async () => ({ id: n++ ? "other" : "x11:1" }); })() });
  const blockedId = await toReady(blocked);
  await blocked.session.apply(blockedId);

  for (const { calls } of [failing, ok, blocked]) {
    const text = calls.logs.join("\n");
    assert.ok(calls.logs.length > 0, "the flow does log its progress");
    for (const secret of ["TOP-SECRET-SELECTION", "SPOKEN-INSTRUCTION", "RESULT-TEXT", "quick brown fox"]) {
      assert.ok(!text.includes(secret), `logged ${secret}`);
    }
  }
});

test("a remote config marks the card so the UI can say text leaves the machine", async () => {
  const r = rig({ config: { engine: "remote" } });
  await r.session.begin();
  assert.strictEqual(r.last().remote, true);
  const local = rig();
  await local.session.begin();
  assert.strictEqual(local.last().remote, false);
});

/* ---- a failed capture never leaves a paste target ---- */

for (const reason of ["secure", "unavailable", "timeout", "modifiers-held"]) {
  test(`after a ${reason} capture failure the draft is Copy-only and Apply never pastes`, async () => {
    const r = rig({ selection: async () => ({ ok: false, reason, message: `capture failed: ${reason}` }) });
    const id = await toReady(r);
    const view = r.last();
    assert.strictEqual(view.mode, "draft");
    assert.strictEqual(view.canApply, false);
    assert.match(view.applyNote, /can only be copied/);
    assert.strictEqual(view.canCopy, true);
    const result = await r.session.apply(id);
    assert.strictEqual(result.blocked, true);
    assert.deepStrictEqual(r.calls.pasted, []);
  });
}

test("a draft over a truly empty selection may be applied, after re-checking nothing is selected now", async () => {
  const r = rig({ selection: async () => ({ ok: false, reason: "empty", message: "Nothing is selected" }) });
  const id = await toReady(r);
  assert.strictEqual(r.last().canApply, true);
  assert.strictEqual((await r.session.apply(id)).ok, true);
  assert.deepStrictEqual(r.calls.pasted, [OUTPUT]);
});

test("a draft is refused if text got selected, or the cursor became unreadable, before Apply", async () => {
  for (const later of [{ ok: true, text: "newly selected" }, { ok: false, reason: "secure", message: "secure" }]) {
    let reads = 0;
    const r = rig({ selection: async () => (reads++ === 0 ? { ok: false, reason: "empty", message: "Nothing is selected" } : later) });
    const id = await toReady(r);
    assert.strictEqual((await r.session.apply(id)).blocked, true);
    assert.deepStrictEqual(r.calls.pasted, []);
  }
});
