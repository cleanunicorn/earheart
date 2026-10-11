const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const renderer = path.join(__dirname, "..", "renderer");
const script = fs.readFileSync(path.join(renderer, "correction.js"), "utf8");
const html = fs.readFileSync(path.join(renderer, "correction.html"), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Execute the shipped script, with the controls declared by the shipped HTML.
// Events bubble to document so keyboard tests exercise both action handlers.
async function editor({ text = "Run cube cuddle next.", invoke, cleanupEnabled = true } = {}) {
  const calls = [];
  const dirty = [];
  const notices = {};
  const document = { activeElement: null, listeners: {}, addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }, getElementById(id) {
    assert.ok(nodes.has(id), `control ${id} exists in correction.html`);
    return nodes.get(id);
  } };
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], {
    value: "", textContent: "", disabled: false, selectionStart: 0, selectionEnd: 0,
    listeners: {}, addEventListener: document.addEventListener,
    focus() { document.activeElement = this; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  }]));
  function fire(id, type, extra = {}) {
    const target = nodes.get(id);
    const event = { target, key: "", defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of target.listeners[type] || []) fn(event);
    for (const fn of document.listeners[type] || []) fn(event);
    return event;
  }
  const bridge = {
    on(channel, fn) { notices[channel] = fn; },
    send(channel, value) { assert.equal(channel, "correction:dirty"); dirty.push(value); },
    async invoke(channel, payload) {
      calls.push({ channel, payload });
      if (invoke) {
        const result = await invoke(channel, payload);
        if (result !== undefined) return result;
      }
      return channel === "correction:get" ? { text, cleanupEnabled } : { ok: true, cleanupEnabled };
    },
  };
  vm.runInNewContext(script, { document, earheart: bridge });
  await settle();
  const transcript = nodes.get("transcript");
  const spelling = nodes.get("spelling");
  return {
    nodes, transcript, spelling, calls, dirty, notices, document, fire,
    select(start, end) {
      transcript.focus(); transcript.setSelectionRange(start, end); fire("transcript", "select");
      spelling.focus();
    },
    type(value) { spelling.value = value; fire("spelling", "input"); },
    async click(id) { if (!nodes.get(id).disabled) fire(id, "click"); await settle(); },
    async key(id, key, extra) { const event = fire(id, "keydown", { key, ...extra }); await settle(); return event; },
    edit(value) { transcript.value = value; fire("transcript", "input"); },
  };
}

test("replacement preserves leading/trailing selected spaces, newlines and Unicode", async () => {
  const text = "🚀 Run \t\ncube cuddle \n next.";
  const e = await editor({ text });
  e.select(text.indexOf(" \t"), text.indexOf("next"));
  assert.equal(e.spelling.value, "cube cuddle");
  e.type(" kubectl ");
  await e.click("remember");
  assert.equal(e.transcript.value, "🚀 Run \t\nkubectl \n next.");
  assert.equal(e.calls.find((c) => c.channel === "correction:remember").payload, "kubectl");
});

test("an unchanged prefilled spelling does not remove a trailing word boundary", async () => {
  const e = await editor();
  e.select(4, 16); // includes the space before 'next'
  assert.equal(e.spelling.value, "cube cuddle");
  assert.equal(e.dirty.at(-1), false);
  await e.click("replace");
  assert.equal(e.transcript.value, "Run cube cuddle next.");
  assert.equal(e.nodes.get("undo").disabled, true);
  assert.equal(e.dirty.at(-1), false);
  await e.click("copy");
  assert.equal(e.calls.find((c) => c.channel === "transcript:copy").payload, e.transcript.value);
});

test("whitespace-only selection cannot replace or remember a spelling", async () => {
  const e = await editor();
  e.select(3, 4); e.type("term");
  await e.click("remember");
  assert.equal(e.nodes.get("replace").disabled, true);
  assert.equal(e.calls.length, 1);
  assert.equal(e.dirty.at(-1), false);
});

for (const guard of ["isComposing", "keyCode229", "compositionstart"]) {
  test(`all Enter, copy and Escape keyboard actions ignore IME ${guard}`, async () => {
    const e = await editor();
    e.select(4, 15); e.type("仮");
    const extra = guard === "isComposing" ? { isComposing: true }
      : guard === "keyCode229" ? { keyCode: 229 } : {};
    if (guard === "compositionstart") e.fire("spelling", "compositionstart");
    for (const [key, modifiers] of [["Enter", {}], ["Enter", { ctrlKey: true }], ["Enter", { metaKey: true }], ["Escape", {}]]) {
      const event = await e.key("spelling", key, { ...extra, ...modifiers });
      assert.equal(event.defaultPrevented, false, "leave composition to the browser");
    }
    e.transcript.focus();
    await e.key("transcript", "Enter", { ...extra, ctrlKey: true });
    await e.key("transcript", "Escape", extra);
    e.fire("transcript", "keyup", { key: "Enter", ...extra });
    assert.equal(e.spelling.value, "仮", "composition keyup does not recapture the selection");
    assert.equal(e.transcript.value, "Run cube cuddle next.");
    assert.equal(e.calls.length, 1, "no remember, copy or close IPC");
    if (guard === "compositionstart") e.fire("spelling", "compositionend");
    e.spelling.focus();
    await e.key("spelling", "Enter");
    assert.equal(e.calls.filter((c) => c.channel === "correction:remember").length, 1);
    assert.equal(e.transcript.value, "Run 仮 next.");
  });
}

test("undo reverses multiple replacements and never removes remembered vocabulary", async () => {
  const e = await editor();
  e.select(4, 15); e.type("kubectl"); await e.click("remember");
  e.select(12, 16); e.type("later"); await e.click("replace");
  assert.equal(e.transcript.value, "Run kubectl later.");
  await e.click("undo");
  assert.equal(e.transcript.value, "Run kubectl next.");
  assert.match(e.nodes.get("status").textContent, /remembered spellings stay/);
  await e.click("undo");
  assert.equal(e.transcript.value, "Run cube cuddle next.");
  assert.equal(e.nodes.get("undo").disabled, true);
  assert.equal(e.dirty.at(-1), false);
  assert.equal(e.calls.filter((c) => c.channel !== "correction:get").length, 1);
});

test("direct edits start a new replacement undo history", async () => {
  const e = await editor();
  e.select(4, 15); e.type("kubectl"); await e.click("replace");
  e.edit(e.transcript.value + " Keep this direct edit.");
  await e.click("undo");
  assert.equal(e.transcript.value, "Run kubectl next. Keep this direct edit.");
  assert.equal(e.nodes.get("undo").disabled, true);
  e.select(12, 16); e.type("later"); await e.click("replace");
  await e.click("undo");
  assert.equal(e.transcript.value, "Run kubectl next. Keep this direct edit.");
  assert.equal(e.nodes.get("undo").disabled, true);
  assert.equal(e.dirty.at(-1), true);
});

test("dirty events include unapplied spelling and direct edits, and clear when restored", async () => {
  const e = await editor();
  assert.deepEqual(e.dirty, [false]);
  e.select(4, 15); e.type("kubectl");
  assert.deepEqual(e.dirty, [false, true]);
  e.type(" cube cuddle ");
  assert.deepEqual(e.dirty, [false, true, false]);
  e.edit("Direct draft");
  e.edit("Run cube cuddle next.");
  assert.deepEqual(e.dirty, [false, true, false, true, false]);
});

test("Escape in spelling cancels its pending replacement; elsewhere it requests ordinary close", async () => {
  const e = await editor();
  e.select(4, 15); e.type("kubectl");
  await e.key("spelling", "Escape");
  assert.equal(e.document.activeElement, e.transcript);
  assert.equal(e.spelling.value, "");
  assert.equal(e.transcript.value, "Run cube cuddle next.");
  assert.equal(e.dirty.at(-1), false);
  assert.equal(e.calls.length, 1);
  e.edit("Keep an earlier direct edit");
  e.select(0, 4); e.type("Retain");
  await e.key("spelling", "Escape");
  assert.equal(e.dirty.at(-1), true, "cancelling spelling keeps earlier draft edits dirty");
  await e.key("transcript", "Escape");
  assert.equal(e.calls.at(-1).channel, "correction:close");
  assert.equal(e.calls.at(-1).payload, undefined);
  await e.click("cancel");
  assert.equal(e.calls.at(-1).payload, undefined);
});

test("copy refuses an unapplied spelling, then copies the full draft with the copied close override", async () => {
  const e = await editor();
  e.select(4, 15); e.type("kubectl");
  await e.click("copy");
  assert.equal(e.calls.length, 1);
  assert.match(e.nodes.get("status").textContent, /Apply your spelling/);
  await e.click("replace");
  await e.key("transcript", "Enter", { ctrlKey: true });
  assert.equal(e.calls.at(-2).channel, "transcript:copy");
  assert.equal(e.calls.at(-2).payload, "Run kubectl next.");
  assert.equal(e.calls.at(-1).channel, "correction:close");
  assert.equal(e.calls.at(-1).payload.copied, true);
});

for (const failure of ["reply", "rejection", "close", "close-reply"]) {
  test(`copy ${failure} failure retains draft, dirty state and undo`, async () => {
    const e = await editor({ invoke(channel) {
      if (channel === "transcript:copy" && failure === "reply") return { ok: false, error: "clipboard failed" };
      if (channel === "transcript:copy" && failure === "rejection") throw new Error("IPC failed");
      if (channel === "correction:close" && failure === "close") throw new Error("close failed");
      if (channel === "correction:close" && failure === "close-reply") return { ok: false, error: "close failed" };
    } });
    e.select(4, 15); e.type("kubectl"); await e.click("replace");
    await e.click("copy");
    assert.equal(e.transcript.value, "Run kubectl next.");
    assert.equal(e.dirty.at(-1), true);
    assert.equal(e.nodes.get("undo").disabled, false);
    assert.equal(e.nodes.get("copy").disabled, false);
    assert.match(e.nodes.get("status").textContent, /Your draft is still here/);
    if (!failure.startsWith("close")) assert.ok(!e.calls.some((c) => c.channel === "correction:close"));
    await e.click("undo");
    assert.equal(e.transcript.value, "Run cube cuddle next.");
  });
}

test("remember failure preserves the draft and pending spelling for Replace only", async () => {
  const e = await editor({ invoke(channel) {
    if (channel === "correction:remember") return { ok: false, error: "disk full" };
  } });
  e.select(4, 15); e.type("kubectl"); await e.click("remember");
  assert.equal(e.transcript.value, "Run cube cuddle next.");
  assert.equal(e.spelling.value, "kubectl");
  assert.equal(e.dirty.at(-1), true);
  assert.equal(e.nodes.get("undo").disabled, true);
  assert.match(e.nodes.get("status").textContent, /disk full/);
  await e.click("replace");
  assert.equal(e.transcript.value, "Run kubectl next.");
});

test("correction notices display safely without replacing or cleaning the draft", async () => {
  const e = await editor();
  e.edit("Unsaved draft");
  e.notices["correction:notice"]({ message: "<b>Another transcript cannot replace your active draft.</b>" });
  assert.equal(e.nodes.get("status").textContent, "<b>Another transcript cannot replace your active draft.</b>");
  assert.equal(e.transcript.value, "Unsaved draft");
  assert.equal(e.dirty.at(-1), true);
});

test("failed initialization leaves editing and copying disabled and reports the error", async () => {
  const e = await editor({ invoke(channel) {
    if (channel === "correction:get") throw new Error("transcript unavailable");
  } });
  assert.equal(e.transcript.readOnly, true);
  assert.equal(e.spelling.disabled, true);
  assert.equal(e.nodes.get("copy").disabled, true);
  assert.match(e.nodes.get("status").textContent, /transcript unavailable/);
  assert.deepEqual(e.dirty, []);
});
