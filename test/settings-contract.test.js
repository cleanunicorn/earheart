// Guards the contract between the settings/wizard renderer scripts and their
// markup, and the settings/wizard shared-stylesheet and shared-script coupling.
//
// settings.js and wizard.js drive the UI entirely by element id and
// radio-group name, so a markup redesign that drops or renames an element
// breaks the window silently (the script throws at runtime, not at load).
// wizard.html layers wizard.css on top of settings.css and reuses its :root
// tokens, so a token rename breaks the wizard just as silently — and both
// pages load hotkey-capture.js before their own script, so a dropped or
// reordered tag kills them just as quietly. These tests parse the files as
// text — no DOM, no Electron — and assert those contracts hold, so a
// regression fails here instead of in the app.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER = path.join(__dirname, "..", "renderer");
const SHARED = path.join(__dirname, "..", "shared");
const html = fs.readFileSync(path.join(RENDERER, "settings.html"), "utf8");
const js = fs.readFileSync(path.join(RENDERER, "settings.js"), "utf8");
const css = fs.readFileSync(path.join(RENDERER, "settings.css"), "utf8");
const wizardCss = fs.readFileSync(path.join(RENDERER, "wizard.css"), "utf8");
const wizardHtml = fs.readFileSync(path.join(RENDERER, "wizard.html"), "utf8");
const wizardJs = fs.readFileSync(path.join(RENDERER, "wizard.js"), "utf8");
const valueRangeJs = fs.readFileSync(path.join(SHARED, "value-range.js"), "utf8");

const htmlIds = new Set([...html.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]));
const htmlNames = new Set([...html.matchAll(/name="([a-z0-9-]+)"/g)].map((m) => m[1]));

// The engine helpers build ids as `${kind}-…` for kind in {stt, cleanup}; expand
// those template ids so the presence check covers what the script really queries.
function expand(id) {
  if (!id.includes("${kind}")) return [id];
  return ["stt", "cleanup"].map((k) => id.replace("${kind}", k));
}

test("every id settings.js references exists in settings.html", () => {
  const referenced = new Set();
  // $("id"), getElementById("id"), getElementById(`${kind}-…`)
  for (const m of js.matchAll(/(?:\$|getElementById)\(\s*[`"]([a-z0-9${}-]+)[`"]\s*\)/g)) {
    for (const id of expand(m[1])) referenced.add(id);
  }
  // Ids threaded through the bind* helpers as bare string arguments never appear
  // inside a $()/getElementById() call, so scan those call sites too. bindTest's
  // first two args are element ids (the third is an IPC channel — skip it);
  // bindFetchModels' first three are ids (button, result, <datalist>).
  for (const m of js.matchAll(/bindTest\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
    referenced.add(m[1]);
    referenced.add(m[2]);
  }
  for (const m of js.matchAll(/bindFetchModels\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
    referenced.add(m[1]);
    referenced.add(m[2]);
    referenced.add(m[3]);
  }
  assert.ok(referenced.size > 30, `expected many referenced ids, got ${referenced.size}`);

  const missing = [...referenced].filter((id) => !htmlIds.has(id)).sort();
  assert.deepStrictEqual(missing, [], `settings.html is missing ids: ${missing.join(", ")}`);
});

test("settings controls keep authored colors above non-text contrast minimums", () => {
  const flat = css.replace(/\s+/g, " ");
  assert.equal(
    (flat.match(/scrollbar-color:\s*var\(--field-edge\) transparent/g) || []).length,
    2,
    "both settings scrollbars use the token measured at 3:1 or better"
  );
  assert.match(
    flat,
    /\.segmented label:has\(input:checked\) \{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--text\)/,
    "the selected segment has a high-contrast state indicator"
  );
  assert.match(
    flat,
    /input\[type="range"\]::-webkit-slider-runnable-track \{[^}]*background:\s*var\(--field-edge\)/,
    "the WebKit range track uses the measured Field Edge token"
  );
  assert.match(
    flat,
    /input\[type="range"\]::-moz-range-track \{[^}]*background:\s*var\(--field-edge\)/,
    "the Firefox range track uses the measured Field Edge token"
  );
});

test("every id wizard.js references exists in wizard.html", () => {
  // wizard.js drives its UI by element id exactly like settings.js, but its
  // ids were previously unguarded: a renamed id (e.g. step-position, which
  // showStep dereferences before loadMicrophones/renderSummary/
  // enterDownloadStep) throws and silently kills the rest of every step
  // transition — including starting the model downloads on the finish step.
  // wizard.js uses only plain string ids (no ${kind} templates, no
  // bindTest/bindFetchModels indirection), so the plain scan suffices.
  const wizardIds = new Set(
    [...wizardHtml.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1])
  );
  const referenced = new Set();
  for (const m of wizardJs.matchAll(/(?:\$|getElementById)\(\s*[`"]([a-z0-9-]+)[`"]\s*\)/g)) {
    referenced.add(m[1]);
  }
  assert.ok(referenced.size > 15, `expected many referenced ids, got ${referenced.size}`);

  const missing = [...referenced].filter((id) => !wizardIds.has(id)).sort();
  assert.deepStrictEqual(missing, [], `wizard.html is missing ids: ${missing.join(", ")}`);
});

test("each tab's panel id (tab-<data-tab>) exists in settings.html", () => {
  // The tab click handler activates panels via `tab-${tab.dataset.tab}`, an id
  // the plain-string scan above can't see. Pin it from the nav's data-tab values.
  const dataTabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(dataTabs.length >= 5, `expected the five tabs, got ${dataTabs.length}`);
  const missing = dataTabs.filter((t) => !htmlIds.has(`tab-${t}`)).sort();
  assert.deepStrictEqual(missing, [], `missing tab panels: ${missing.map((t) => `tab-${t}`).join(", ")}`);
});

test("every panel section has a matching index button (data-tab)", () => {
  // The existing test checks nav→panel; this is the reverse. spySections
  // derives the active name from the .panel sections themselves, so a
  // section added without an index button would scroll fine but never take
  // the index highlight — the index would silently skip it.
  const dataTabs = new Set([...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]));
  const panelIds = [...html.matchAll(/<section id="tab-([a-z]+)"[^>]*class="panel/g)].map(
    (m) => m[1]
  );
  assert.ok(panelIds.length >= 5, `expected the five sections, got ${panelIds.length}`);
  const orphans = panelIds.filter((p) => !dataTabs.has(p)).sort();
  assert.deepStrictEqual(orphans, [], `sections without an index button: ${orphans.join(", ")}`);
});

test("each section's aria-labelledby points at its own existing legend", () => {
  // The legend headings carry the sections' accessible names; nothing at
  // runtime throws when the pairing breaks, so pin it here.
  const pairs = [...html.matchAll(/<section id="tab-([a-z]+)"[^>]*aria-labelledby="([a-z0-9-]+)"/g)];
  assert.ok(pairs.length >= 5, `expected five labelled sections, got ${pairs.length}`);
  const broken = pairs
    .filter(([, name, ref]) => ref !== `legend-${name}` || !htmlIds.has(ref))
    .map(([, name, ref]) => `tab-${name}→${ref}`);
  assert.deepStrictEqual(broken, [], `mislabelled sections: ${broken.join(", ")}`);
});

test("the always-visible History section stays live (no active-tab guard)", () => {
  // Every section renders at once now, so renderHistory must run at init and
  // unconditionally on history:changed — a re-added "only when the History
  // tab is active" guard (the old model's shape) would leave the list stale
  // for the whole session. Pins the call sites, not renderHistory itself.
  const normalized = js.replace(/\s+/g, " ");
  // The reset-to-newest is part of the pinned contract: a fresh dictation
  // must always land on the visible page, wherever the pager was left.
  assert.match(
    normalized,
    /earheart\.on\("history:changed", \(\) => \{ historyPage = 0; renderHistory\(\)/,
    "history:changed must reset to the newest page and rerender unconditionally"
  );
  const init = js.slice(js.lastIndexOf("(async () =>"));
  assert.ok(
    init.includes("renderHistory();"),
    "the init IIFE must render history once at load"
  );
});

test("history exposes the preserved original when cleanup changed it", () => {
  const normalized = js.replace(/\s+/g, " ");
  assert.match(
    normalized,
    /item\.cleaned && typeof item\.raw === "string" && item\.raw !== item\.text/,
    "the original action should appear only when cleanup produced different text"
  );
  assert.match(
    normalized,
    /historyCopyButton\("Copy original", item\.raw\)/,
    "the original action must copy the preserved raw transcript"
  );
});

test("every radio/checkbox group name settings.js uses exists in settings.html", () => {
  const referenced = new Set([...js.matchAll(/name="([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(referenced.size >= 3, "expected the output-mode/stt-engine/cleanup-engine groups");

  const missing = [...referenced].filter((n) => !htmlNames.has(n)).sort();
  assert.deepStrictEqual(missing, [], `settings.html is missing radio groups: ${missing.join(", ")}`);
});

test("shared value-range.js loads before settings.js, which validates numeric fields", () => {
  const shared = html.indexOf('src="../shared/value-range.js"');
  const own = html.indexOf('src="settings.js"');
  assert.notStrictEqual(shared, -1, "settings.html must load value-range.js");
  assert.ok(shared < own, "settings.html must load value-range.js before settings.js");
  assert.ok(fs.existsSync(path.join(SHARED, "value-range.js")));
  assert.match(js, /clampNumber\(/);
  assert.match(valueRangeJs, /function clampNumber\(/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "scripts", "settings-value-range-smoke.js")));
});

test("custom model version selects have accessible names", () => {
  for (const id of ["stt-hf-variant", "cleanup-hf-variant"]) {
    const select = html.match(new RegExp(`<select id="${id}"[^>]*>`));
    assert.ok(select, `${id} must exist`);
    assert.match(select[0], /aria-label="Model version"/);
  }
});

test("hotkey-capture.js loads before each page's own script", () => {
  // Both pages call wireHotkeyCapture at top level; if the shared script's
  // tag is dropped or reordered, the page script throws a ReferenceError
  // that silently kills everything after the index wiring — and the smoke
  // checks only exercise code registered before that point.
  for (const [name, source, page] of [
    ["settings.html", html, "settings.js"],
    ["wizard.html", wizardHtml, "wizard.js"],
  ]) {
    const shared = source.indexOf('src="hotkey-capture.js"');
    const own = source.indexOf(`src="${page}"`);
    assert.notStrictEqual(shared, -1, `${name} must load hotkey-capture.js`);
    assert.notStrictEqual(own, -1, `${name} must load ${page}`);
    assert.ok(shared < own, `${name} must load hotkey-capture.js before ${page}`);
  }
});

function extractFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `${name} function must exist`);
  const bodyStart = source.indexOf("{", declaration.index + declaration[0].length - 1);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      return source.slice(declaration.index, i + 1);
    }
  }
  assert.fail(`${name} function has an unclosed body`);
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function microphonePage(source, page) {
  const select = {
    value: "",
    options: [{ value: "", textContent: "System default" }],
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    appendChild(option) {
      this.options.push(option);
    },
    querySelector(selector) {
      const value = selector.match(/option\[value="(.*)"\]/)?.[1];
      return this.options.find((option) => option.value === value) || null;
    },
    get length() {
      return this.options.length;
    },
    get selectedOptions() {
      return this.options.filter((option) => option.value === this.value);
    },
    dispatchEvent(event) {
      this.listeners[event.type]?.(event);
    },
  };
  const hint = { textContent: "" };
  const baseDocument = {
    getElementById(id) {
      return id === "mic-device" ? select : hint;
    },
    createElement() {
      return { value: "", textContent: "" };
    },
  };
  const enumeration = deferred();
  const current = page === "wizard"
    ? {
        hotkey: "CommandOrControl+Shift+Space",
        output: { mode: "paste", restoreClipboard: true },
        stt: { engine: "remote", builtin: { model: "parakeet" }, baseUrl: "https://stt.test", apiKey: "", model: "", language: "en", livePreview: {} },
        cleanup: {
          enabled: true,
          engine: "remote",
          builtin: { model: "cleanup-model" },
          custom: { temperature: 0.2 },
          style: "custom",
          baseUrl: "", apiKey: "", model: "", dictionary: [], systemPrompt: "",
        },
        updates: { autoCheck: true, remind: true },
        engines: { idleUnloadMinutes: 0 },
        history: { enabled: true },
        audio: { deviceId: "saved-id", maxRecordingSeconds: 300 },
      }
    : {
        hotkey: "Control+Space", pauseHotkey: "", output: { mode: "paste", restoreClipboard: true },
        updates: {}, stt: { builtin: {}, livePreview: {} }, cleanup: { builtin: {}, custom: {} },
        engines: {}, history: {}, audio: { deviceId: "saved-id" },
      };
  const elements = {
    "mic-device": select,
    "cleanup-enabled": { checked: true },
    "cleanup-builtin-model": { value: "cleanup-model" },
    "cleanup-style": { value: "0" },
    "cleanup-temperature": { value: "" },
    "cleanup-top-p": { value: "" },
    "cleanup-top-k": { value: "" },
    "cleanup-min-p": { value: "" },
    "cleanup-url": { value: "" },
    "cleanup-key": { value: "" },
    "cleanup-model": { value: "" },
    "cleanup-dictionary": { value: "" },
    "cleanup-prompt": { value: "" },
    "cleanup-style-mode": { value: "custom" },
    "stt-url": { value: "" },
    "stt-key": { value: "" },
    "stt-model": { value: "" },
    "stt-language": { value: "" },
    "stt-live-preview": { checked: true },
    "max-seconds": { value: "300" },
    "start-on-boot": { checked: false },
    "updates-autocheck": { checked: true },
    "updates-remind": { checked: true },
    "idle-unload": { value: "0" },
    "history-enabled": { checked: true },
    "finish-status": { textContent: "", className: "" },
  };
  let payload;
  let invokeCount = 0;
  const context = {
    document: {
      getElementById(id) {
        return elements[id] || baseDocument.getElementById(id);
      },
      createElement: () => baseDocument.createElement(),
      querySelector(selector) {
        assert.strictEqual(selector, 'input[name="output-mode"]:checked');
        return { value: "paste-copy" };
      },
    },
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
        enumerateDevices: () => enumeration.promise,
      },
    },
    CSS: { escape: (value) => value },
    current,
    cleanupStyles: [{ id: "verbatim" }],
    $: (id) => elements[id] || baseDocument.getElementById(id),
    earheart: {
      invoke(channel, value) {
        assert.strictEqual(channel, page === "settings" ? "settings:save" : "wizard:complete");
        invokeCount++;
        payload = value;
        return Promise.resolve({ settings: value, hotkey: { ok: true } });
      },
    },
  };
  const loadFunction = `(${extractFunction(source, "loadMicrophones")})`;
  const load = require("node:vm").runInNewContext(loadFunction, context);
  if (page === "settings") {
    const settingsFunctions = [
      extractFunction(source, "num"),
      extractFunction(source, "styleMode"),
      extractFunction(source, "collectCleanupStyle"),
      extractFunction(source, "engineValue"),
      extractFunction(source, "collect"),
      "this.collect = collect;",
    ].join(String.fromCharCode(10));
    const radios = { stt: "builtin", cleanup: "builtin", "cleanup-style-mode": "custom" };
    context.document.querySelector = (selector) => {
      if (selector === 'input[name="output-mode"]:checked') return { value: "paste-copy" };
      const kind = selector.match(/name="([^"]+)"/)?.[1];
      return { value: radios[kind] };
    };
    require("node:vm").runInNewContext(settingsFunctions, context);
  } else {
    const wizardFunctions = `${extractFunction(source, "collect")}; ${extractFunction(source, "finish")}; this.finish = finish;`;
    require("node:vm").runInNewContext(wizardFunctions, context);
  }

  return {
    select,
    async reproduce({ selectSystemDefault = true } = {}) {
      const pending = load();
      await new Promise((resolve) => setImmediate(resolve));
      if (selectSystemDefault) {
        select.value = "";
        select.dispatchEvent({ type: "change" });
      }
      enumeration.resolve([
        { kind: "audioinput", deviceId: "saved-id", label: "Saved microphone" },
        { kind: "audioinput", deviceId: "other-id", label: "Other microphone" },
      ]);
      await pending;
      if (page === "settings") {
        await context.earheart.invoke("settings:save", context.collect());
      } else {
        await context.finish();
      }
      return { selected: select.value, saved: payload, invokeCount };
    },
  };
}
for (const [page, source] of [["settings", js], ["wizard", wizardJs]]) {
  test(`${page} preserves System default selected during microphone enumeration`, async () => {
    const fixture = microphonePage(source, page);
    const result = await fixture.reproduce();
    assert.strictEqual(result.selected, "");
    assert.strictEqual(result.saved.audio.deviceId, "");
    assert.strictEqual(result.invokeCount, 1);
    if (page === "wizard") {
      assert.strictEqual(result.saved.output.mode, "paste-copy");
      assert.strictEqual(result.saved.stt.engine, "builtin");
      assert.strictEqual(result.saved.cleanup.builtin.model, "cleanup-model");
      assert.strictEqual(result.saved.cleanup.style, "verbatim");
      assert.strictEqual(result.saved.hotkey, "CommandOrControl+Shift+Space");
    }
  });

  test(`${page} restores the saved microphone when the user leaves it untouched`, async () => {
    const fixture = microphonePage(source, page);
    const result = await fixture.reproduce({ selectSystemDefault: false });
    assert.strictEqual(result.selected, "saved-id");
    assert.strictEqual(result.saved.audio.deviceId, "saved-id");
    assert.strictEqual(result.invokeCount, 1);
  });
}
test("permission-status.js loads before settings.js, which uses it", () => {
  // settings.js only reaches for these when Fix is clicked or the window
  // regains focus, so a dropped tag passes the smoke checks and throws later.
  const shared = html.indexOf('src="permission-status.js"');
  const own = html.indexOf('src="settings.js"');
  assert.notStrictEqual(shared, -1, "settings.html must load permission-status.js");
  assert.ok(shared < own, "settings.html must load permission-status.js before settings.js");
  assert.ok(fs.existsSync(path.join(RENDERER, "permission-status.js")));
  assert.match(js, /permissionFixStatus\(/);
  assert.match(js, /permissionCheckStatus\(/);
});

test("settings.html uses no inline style attributes (blocked by the CSP)", () => {
  // The window's Content-Security-Policy is `style-src 'self'`, which forbids
  // inline style="…" attributes. Any such attribute would be silently dropped.
  const inline = [...html.matchAll(/<[^>]*\sstyle="/g)];
  assert.strictEqual(inline.length, 0, "found inline style= attributes; move them to settings.css");
});

test("settings action rows keep their fields visually separate", () => {
  const normalized = css.replace(/\s+/g, " ");
  assert.match(
    normalized,
    /\.field > input \+ \.row, \.field > datalist \+ \.row\s*\{\s*margin-top:\s*8px;\s*\}/,
    "expected an 8px gap after model fields before their action rows"
  );

  for (const [name, pattern] of [
    [
      "STT Hugging Face field",
      /<input id="stt-hf-url"[\s\S]*?\/>\s*<div class="row">\s*<button id="stt-hf-find"/,
    ],
    [
      "cleanup Hugging Face field",
      /<input id="cleanup-hf-url"[\s\S]*?\/>\s*<div class="row">\s*<button id="cleanup-hf-find"/,
    ],
    [
      "cleanup model field",
      /<input id="cleanup-model"[\s\S]*?\/>\s*<datalist id="cleanup-model-list"><\/datalist>\s*<div class="row">\s*<button id="cleanup-fetch-models"/,
    ],
  ]) {
    assert.match(html, pattern, `${name} should precede its action row`);
  }

  // The shared input selector also matches the wizard's direct slider row;
  // this id override keeps that intentional spacing at 6px on both pages.
  assert.match(
    normalized,
    /#cleanup-style-labels\s*\{\s*margin-top:\s*6px;\s*\}/,
    "the cleanup-style slider's intentional spacing must remain unchanged"
  );
});

test("settings.css forces [hidden] to win over component display rules", () => {
  // Components like .row and .segmented set their own display, which overrides
  // the user-agent [hidden] rule. settings.js hides several such elements via
  // the hidden attribute (e.g. #cleanup-test-row), so a global guard is required.
  const normalized = css.replace(/\s+/g, " ");
  assert.match(
    normalized,
    /\[hidden\]\s*{\s*display:\s*none\s*!important/,
    "expected a global `[hidden] { display: none !important }` rule"
  );
});

test("every CSS variable used by settings.css and wizard.css is defined in :root", () => {
  // wizard.css layers on settings.css and reuses its tokens; a token rename in
  // settings.css would leave the wizard rendering with invalid values silently.
  const root = css.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(root, "settings.css should define a :root block");
  const defined = new Set([...root[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  const used = new Set(
    [...(css + wizardCss).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])
  );
  const undefinedVars = [...used].filter((v) => !defined.has(v)).sort();
  assert.deepStrictEqual(undefinedVars, [], `CSS vars used but not defined in :root: ${undefinedVars.join(", ")}`);
});

test("shared classes the wizard relies on still exist in settings.css", () => {
  // wizard.html reuses these settings.css primitives; renaming one silently
  // breaks the wizard's chrome. Cheap tripwire that each selector still appears.
  // .capturing is toggled by hotkey-capture.js (which the wizard also loads)
  // and styled only here — the one visual cue that a hotkey field is armed.
  const shared = [".field", ".row", ".hint", ".status", ".lead", ".choice", "button.primary", "button.ghost", "code", ".capturing"];
  const missing = shared.filter((sel) => !css.includes(sel)).sort();
  assert.deepStrictEqual(missing, [], `settings.css no longer defines: ${missing.join(", ")}`);
});

test("disabled cleanup controls are inert in settings and the wizard", () => {
  for (const [name, source] of [["settings", js], ["wizard", wizardJs]]) {
    const normalized = source.replace(/\s+/g, " ");
    assert.match(
      normalized,
      /fields\.inert = !on/,
      `${name} must remove disabled cleanup fields from keyboard and accessibility navigation`
    );
  }
});

test("a coupled hotkey rollback gets a neutral save banner", () => {
  const normalized = js.replace(/\s+/g, " ");
  assert.match(
    normalized,
    /function hotkeySaveMessage\(hotkeyResult, pauseResult\).*if \(!hotkeyResult\.ok && !pauseResult\.ok\) { return "Saved, but the hotkeys could not be changed"/,
    "when both slot results fail, the banner must not blame either field"
  );
});
