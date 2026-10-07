// The notices that tell the user about a broken setup before they speak
// (#194): their copy, the notifier that shows them, and the startup policy that
// picks one. main.js binds Electron at module scope and cannot be required from
// a test, so the decisions live in main/setup-notices.js with Electron injected.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  readyNotice,
  sttNotReadyNotice,
  hotkeyFailureNotice,
  createNotifier,
  announceStartup,
} = require("../main/setup-notices");

// A stand-in for Electron's Notification: records every instance, its
// handlers, and whether it was shown.
function fakeNotification({ supported = true, throwOnShow = false } = {}) {
  const shown = [];
  class Notification {
    static isSupported() {
      return supported;
    }
    constructor(options) {
      this.options = options;
      this.handlers = {};
    }
    on(event, fn) {
      this.handlers[event] = fn;
      return this;
    }
    show() {
      if (throwOnShow) throw new Error("no notification daemon");
      shown.push(this);
    }
  }
  return { Notification, shown };
}

function rig(options) {
  const { Notification, shown } = fakeNotification(options);
  const calls = { settings: 0, wizard: 0, warnings: [] };
  const openSettings = () => {
    calls.settings += 1;
  };
  const notifier = createNotifier({
    Notification,
    openSettings,
    logger: { warn: (...args) => calls.warnings.push(args.join(" ")) },
  });
  return { notifier, shown, calls, openSettings, openWizard: () => (calls.wizard += 1) };
}

const okHotkeys = { hotkey: { ok: true }, pauseHotkey: { ok: true } };
const failedRecord = {
  hotkey: { ok: false, error: 'Could not register "Ctrl+Shift+Space" (already in use).' },
  pauseHotkey: { ok: true },
};
const missing = { ok: false, reason: "missing", modelId: "parakeet-int8", label: "Parakeet TDT 0.6B v3 (int8)" };

function startup(r, overrides = {}) {
  announceStartup({
    cfg: { hotkey: "CommandOrControl+Shift+Space" },
    hidden: false,
    smokeTest: false,
    firstRun: false,
    hotkeyStatus: okHotkeys,
    sttReadiness: { ok: true },
    openWizard: r.openWizard,
    openSettings: r.openSettings,
    notify: r.notifier.show,
    ...overrides,
  });
}

/* ---------------- copy ---------------- */

test("the not-downloaded notice names the model by its label and the way to fix it", () => {
  const note = sttNotReadyNotice(missing);

  assert.match(note.title, /speech model not downloaded/);
  assert.ok(note.body.includes(`“${missing.label}”`));
  assert.ok(!note.body.includes(missing.modelId), "the internal id is not the name shown");
  assert.match(note.body, /Settings → Speech-to-text/);
  assert.match(note.body, /Click to open Settings/);
});

test("an unknown model gets a choose-a-model notice, not a download one", () => {
  const note = sttNotReadyNotice({ ok: false, reason: "unknown", modelId: "gone" });

  assert.doesNotMatch(note.body, /Download/);
  assert.match(note.body, /Choose one in Settings → Speech-to-text/);
});

test("the hotkey failure notice carries the registration error and the way to fix it", () => {
  const note = hotkeyFailureNotice(failedRecord.hotkey);

  assert.match(note.title, /hotkey not working/);
  assert.ok(note.body.startsWith(failedRecord.hotkey.error));
  assert.match(note.body, /Click to open Settings/);
  assert.ok(hotkeyFailureNotice({ ok: false, error: "x".repeat(400) }).body.length <= 180);
});

test("the ready notice keeps its wording", () => {
  assert.deepStrictEqual(readyNotice(""), {
    title: "Earheart is ready",
    body: "Open the tray menu to get started.",
  });
  assert.match(readyNotice("CommandOrControl+Shift+Space").body, /^Press .+Shift\+Space to dictate\.$/);
});

/* ---------------- notifier ---------------- */

test("a notice opens Settings on click and stays referenced after show()", () => {
  const r = rig();

  r.notifier.show({ title: "t", body: "b" });

  assert.strictEqual(r.shown.length, 1);
  assert.strictEqual(r.calls.settings, 0);
  r.shown[0].handlers.click();
  assert.strictEqual(r.calls.settings, 1);
  assert.strictEqual(r.notifier.current(), r.shown[0]);
});

test("without a notification service the notice falls back to Settings", () => {
  const r = rig({ supported: false });

  r.notifier.show({ title: "t", body: "b" });

  assert.strictEqual(r.shown.length, 0);
  assert.strictEqual(r.calls.settings, 1);
});

test("a critical notice that fails to show opens Settings instead", () => {
  const r = rig({ throwOnShow: true });

  r.notifier.show({ title: "t", body: "b" }, { critical: true });

  assert.strictEqual(r.calls.settings, 1);
  assert.strictEqual(r.calls.warnings.length, 1);
});

test("a critical notice the OS reports as failed opens Settings", () => {
  const r = rig();

  r.notifier.show({ title: "t", body: "b" }, { critical: true });
  r.shown[0].handlers.failed();

  assert.strictEqual(r.calls.settings, 1);
});

test("a non-critical notice that fails to show is only logged", () => {
  const r = rig({ throwOnShow: true });

  r.notifier.show({ title: "t", body: "b" });

  assert.strictEqual(r.calls.settings, 0);
  assert.strictEqual(r.calls.warnings.length, 1);
});

/* ---------------- startup policy ---------------- */

test("a hidden launch whose record hotkey failed shows a notice that opens Settings", () => {
  const r = rig();

  startup(r, { hidden: true, hotkeyStatus: failedRecord });

  assert.strictEqual(r.shown.length, 1);
  assert.match(r.shown[0].options.title, /hotkey not working/);
  assert.ok(r.shown[0].options.body.includes(failedRecord.hotkey.error));
  assert.strictEqual(r.calls.settings, 0);
  r.shown[0].handlers.click();
  assert.strictEqual(r.calls.settings, 1);
});

test("a visible launch whose record hotkey failed still opens Settings directly", () => {
  const r = rig();

  startup(r, { hotkeyStatus: failedRecord });

  assert.strictEqual(r.shown.length, 0);
  assert.strictEqual(r.calls.settings, 1);
});

test("a visible launch with the speech model missing never says ready", () => {
  const r = rig();

  startup(r, { sttReadiness: missing });

  assert.strictEqual(r.shown.length, 1);
  assert.match(r.shown[0].options.title, /speech model not downloaded/);
  assert.doesNotMatch(r.shown[0].options.title, /ready/);
  r.shown[0].handlers.click();
  assert.strictEqual(r.calls.settings, 1);
});

test("a hidden launch with the speech model missing shows the same notice", () => {
  const r = rig();

  startup(r, { hidden: true, sttReadiness: missing });

  assert.strictEqual(r.shown.length, 1);
  assert.match(r.shown[0].options.title, /speech model not downloaded/);
});

test("a failed record hotkey takes precedence over a missing model", () => {
  const r = rig();

  startup(r, { hidden: true, hotkeyStatus: failedRecord, sttReadiness: missing });

  assert.strictEqual(r.shown.length, 1);
  assert.match(r.shown[0].options.title, /hotkey not working/);
});

test("a healthy visible launch says ready; a healthy hidden launch stays silent", () => {
  const visible = rig();
  startup(visible);
  assert.strictEqual(visible.shown.length, 1);
  assert.strictEqual(visible.shown[0].options.title, "Earheart is ready");

  const hidden = rig();
  startup(hidden, { hidden: true });
  assert.strictEqual(hidden.shown.length, 0);
  assert.strictEqual(hidden.calls.settings, 0);
});

test("a pause-only failure neither blocks ready nor raises a startup notice", () => {
  const pauseFailed = { hotkey: { ok: true }, pauseHotkey: { ok: false, error: "taken" } };
  const visible = rig();
  startup(visible, { hotkeyStatus: pauseFailed });
  assert.strictEqual(visible.shown[0].options.title, "Earheart is ready");

  const hidden = rig();
  startup(hidden, { hidden: true, hotkeyStatus: pauseFailed });
  assert.strictEqual(hidden.shown.length, 0);
});

test("first run opens the wizard; the smoke test shows nothing", () => {
  const first = rig();
  startup(first, { firstRun: true, sttReadiness: missing });
  assert.strictEqual(first.calls.wizard, 1);
  assert.strictEqual(first.shown.length, 0);

  const smoke = rig();
  startup(smoke, { smokeTest: true, hotkeyStatus: failedRecord, sttReadiness: missing });
  assert.strictEqual(smoke.shown.length + smoke.calls.settings + smoke.calls.wizard, 0);
});
