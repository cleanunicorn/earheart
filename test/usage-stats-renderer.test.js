// Settings → Usage's renderer script (renderer/usage-stats.js, #347) run in a
// VM against a minimal fake DOM and a scripted bridge: what it shows when
// usage:get fails or recovers. The real window is driven in scripts/usage-smoke.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "renderer", "usage-stats.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "renderer", "settings.html"), "utf8");

function fakeElement(id = "") {
  return {
    id,
    textContent: "",
    hidden: false,
    checked: true,
    className: "",
    style: {},
    children: [],
    listeners: {},
    attrs: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
  };
}

// The section's elements as settings.html ships them: the initial text and
// `hidden` come from the markup, so the "before any load" state is real.
function sectionFromHtml() {
  const start = HTML.indexOf('<section id="tab-usage"');
  const section = HTML.slice(start, HTML.indexOf("</section>", start));
  const nodes = { "tab-usage": fakeElement("tab-usage") };
  for (const m of section.matchAll(/<(\w+)([^>]*)\bid="([a-z0-9-]+)"([^>]*)>([^<]*)/g)) {
    const node = fakeElement(m[3]);
    node.hidden = /\shidden(\s|$|>)/.test(` ${m[2]} ${m[4]}`);
    node.textContent = m[5];
    nodes[m[3]] = node;
  }
  return nodes;
}

const SUMMARY = {
  since: "2026-11-04",
  totals: { takes: 12, words: 1840, speechMs: 731000 },
  avgWpm: 151,
  timeSavedMs: 2029000,
  typingWpm: 40,
  streak: { current: 2, longest: 2 },
  days: [
    { date: "2026-11-05", takes: 7, words: 1230, speechMs: 491000 },
    { date: "2026-11-04", takes: 5, words: 610, speechMs: 240000 },
  ],
  readOnly: false,
};

// Load the script with `replies` answering each invoke in turn (a value, or
// an Error to reject with); `confirmAnswer` is what confirm() returns.
function loadSection({ replies, confirmAnswer = true }) {
  const nodes = sectionFromHtml();
  const calls = [];
  const listeners = {};
  const queue = [...replies];
  const context = {
    document: {
      getElementById: (id) => nodes[id] || null,
      createElement: () => fakeElement(),
    },
    earheart: {
      on: (channel, fn) => (listeners[channel] = fn),
      async invoke(channel) {
        calls.push(channel);
        const reply = queue.length > 1 ? queue.shift() : queue[0];
        const value = typeof reply === "function" ? reply(channel) : reply;
        if (value instanceof Error) throw value;
        return value;
      },
    },
    confirm: () => confirmAnswer,
  };
  vm.runInNewContext(SOURCE, context);
  const el = (id) => nodes[id];
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const shown = () => ({
    takes: el("usage-takes").textContent,
    words: el("usage-words").textContent,
    speech: el("usage-speech").textContent,
    streak: el("usage-streak").textContent,
    status: el("usage-load-status").hidden ? null : el("usage-load-status").textContent,
  });
  return { el, calls, listeners, settle, shown };
}

test("usage renderer: before any summary the figures read unavailable, not 0", () => {
  const nodes = sectionFromHtml();
  for (const id of ["usage-takes", "usage-words", "usage-speech", "usage-wpm", "usage-streak", "usage-saved"]) {
    assert.equal(nodes[id].textContent, "—", id);
  }
  assert.equal(nodes["usage-load-status"].hidden, true);
});

for (const [name, failure] of [
  ["a rejected usage:get", new Error("no handler")],
  ["usage:get answering { ok: false }", { ok: false, error: "unavailable" }],
]) {
  test(`usage renderer: ${name} says the stats could not be loaded, and recovery clears it`, async () => {
    let reply = failure;
    const s = loadSection({ replies: [() => reply] });
    await s.settle();
    assert.deepEqual(s.shown(), { takes: "—", words: "—", speech: "—", streak: "—", status: "Usage statistics could not be loaded." });
    assert.equal(s.el("usage-empty").hidden, true, "no 'nothing counted' claim either");

    reply = { ok: true, summary: SUMMARY };
    s.listeners["usage:changed"]();
    await s.settle();
    assert.deepEqual(s.shown(), { takes: "12", words: (1840).toLocaleString(), speech: "12 min", streak: "2 days", status: null });
  });
}

test("usage renderer: load failure → recovery → failure keeps the numbers but marks them out of date", async () => {
  let reply = new Error("no handler");
  const s = loadSection({ replies: [() => reply] });
  await s.settle();
  assert.equal(s.shown().status, "Usage statistics could not be loaded.");

  reply = { ok: true, summary: SUMMARY };
  s.listeners["usage:changed"]();
  await s.settle();
  assert.deepEqual(s.shown(), { takes: "12", words: (1840).toLocaleString(), speech: "12 min", streak: "2 days", status: null });
  assert.equal(s.el("usage-days").children.length, 2);

  reply = { ok: false, error: "unavailable" };
  s.listeners["settings:changed"]();
  await s.settle();
  assert.deepEqual(s.shown(), {
    takes: "12",
    words: (1840).toLocaleString(),
    speech: "12 min",
    streak: "2 days",
    status: "Usage statistics could not be refreshed; these numbers may be out of date.",
  });

  reply = { ok: true, summary: { ...SUMMARY, totals: { ...SUMMARY.totals, takes: 13 } } };
  s.listeners["usage:changed"]();
  await s.settle();
  assert.equal(s.shown().takes, "13");
  assert.equal(s.shown().status, null, "cleared on recovery");
});
