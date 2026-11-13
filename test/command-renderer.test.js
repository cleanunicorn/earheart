// The real card and session together: background selection work must not
// prevent the user from stopping or cancelling a restarted recording.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createCommandSession } = require("../main/commands/session");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function restartedCard() {
  const gate = deferred();
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      addEventListener(_event, fn) { this.click = fn; },
    });
    return nodes.get(id);
  };
  const listeners = {};
  let slow = false, handlers, sid = 0;
  const calls = { stops: 0, cancels: 0, channels: [] };
  const session = createCommandSession({
    getConfig: () => ({}),
    selection: { capture: () => slow ? gate.promise : Promise.resolve({ ok: true, text: "selection" }) },
    platform: { fingerprintSupport: () => ({ ok: false }) },
    startRecording: (h) => { handlers = h; return ++sid; },
    stopRecording: () => { calls.stops++; },
    cancelRecording: () => { calls.cancels++; },
    onView: (view) => listeners["command:state"]?.(view),
  });
  vm.runInNewContext(fs.readFileSync(require.resolve("../renderer/command.js"), "utf8"), {
    document: { getElementById: element },
    earheart: {
      on: (channel, fn) => { listeners[channel] = fn; },
      invoke: (channel, payload) => {
        calls.channels.push(channel);
        if (channel === "command:get") return Promise.resolve({ ok: true, view: session.peek() });
        if (channel === "command:restart") return session.restart(payload.id);
        if (channel === "command:stop") return Promise.resolve(session.stop(payload.id));
        if (channel === "command:cancel") return Promise.resolve(session.cancel(payload.id));
        throw new Error(`Unexpected IPC: ${channel}`);
      },
    },
  });
  await session.begin();
  handlers.onEnd(sid, "empty");
  slow = true;
  const restarting = element("again").click();
  assert.equal(session.peek().phase, "recording");
  assert.equal(element("finish").hidden, false);
  return {
    session, calls, element,
    async cleanup() {
      gate.resolve({ ok: true, text: "selection" });
      await restarting;
      session.dispose();
    },
  };
}

test("Finish speaking works while Speak again is waiting for the selection", async (t) => {
  const r = await restartedCard();
  t.after(() => r.cleanup());
  await r.element("finish").click();
  await r.element("finish").click();
  assert.equal(r.calls.stops, 1);
  assert.equal(r.session.peek().phase, "transcribing");
  // Interrupt completion must not release the outstanding restart's guard.
  await r.element("again").click();
  assert.equal(r.calls.channels.filter((c) => c === "command:restart").length, 1);
});

test("Cancel works while Speak again is waiting for the selection", async (t) => {
  const r = await restartedCard();
  t.after(() => r.cleanup());
  await r.element("cancel").click();
  assert.equal(r.calls.cancels, 1);
  assert.equal(r.session.peek(), null);
});
