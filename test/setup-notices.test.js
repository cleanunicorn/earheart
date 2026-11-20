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
  announcePromptOffer,
  promptOfferNotice,
  startupDownloads,
  runStartupDownloads,
  BODY_MAX,
  HELD_MAX,
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

function rig(options = {}) {
  const { Notification, shown } = fakeNotification(options);
  const calls = { settings: 0, wizard: 0, warnings: [] };
  const openSettings = () => {
    calls.settings += 1;
  };
  const notifier = createNotifier({
    Notification,
    openSettings,
    logger: { warn: (...args) => calls.warnings.push(args.join(" ")) },
    ...(options.settingsWhenUnsupported === undefined
      ? {}
      : { settingsWhenUnsupported: options.settingsWhenUnsupported }),
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

test("every shown notice stays referenced until it is clicked or closed", () => {
  // One dictation can raise several notices (interrupted, cleanup failed,
  // paste failed); each keeps its click handler until the user is done with it.
  const r = rig();

  for (const title of ["a", "b", "c"]) r.notifier.show({ title, body: "b" });

  assert.deepStrictEqual(r.notifier.held(), r.shown);
  r.shown[0].handlers.click();
  assert.strictEqual(r.calls.settings, 1);
  r.shown[1].handlers.close();
  assert.deepStrictEqual(r.notifier.held(), [r.shown[2]]);
});

test("the held notices are capped, oldest first", () => {
  const r = rig();

  for (let i = 0; i < HELD_MAX + 2; i++) r.notifier.show({ title: `n${i}`, body: "b" });

  assert.deepStrictEqual(r.notifier.held(), r.shown.slice(2));
});

test("a notice that fails to show is not held", () => {
  const r = rig({ throwOnShow: true });

  r.notifier.show({ title: "t", body: "b" });

  assert.deepStrictEqual(r.notifier.held(), []);
  assert.match(r.calls.warnings[0], /notification failed: no notification daemon/);
});

test("a notifier made not to open Settings stays quiet without a service, unless critical", () => {
  const r = rig({ supported: false, settingsWhenUnsupported: false });

  r.notifier.show({ title: "t", body: "b" });
  assert.strictEqual(r.calls.settings, 0);

  r.notifier.show({ title: "t", body: "b" }, { critical: true });
  assert.strictEqual(r.calls.settings, 1);
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

test("a new default prompt is announced once, only while cleanup is on", () => {
  const offer = { id: "abc", kind: "custom" };
  const run = (cleanup, o = offer) => {
    const notes = [];
    const recorded = [];
    const announced = announcePromptOffer({
      cfg: { cleanup },
      offer: o,
      notify: (n) => notes.push(n),
      record: (id) => recorded.push(id),
    });
    return { announced, notes, recorded };
  };
  const first = run({ enabled: true, promptOfferNotified: "" });
  assert.strictEqual(first.announced, true);
  assert.deepStrictEqual(first.recorded, ["abc"]);
  assert.deepStrictEqual(first.notes, [promptOfferNotice(offer)]);
  assert.strictEqual(run({ enabled: true, promptOfferNotified: "abc" }).announced, false);
  assert.strictEqual(run({ enabled: false }).announced, false);
  assert.strictEqual(run({ enabled: true }, null).announced, false);
});

test("the prompt notice says whether the user's own prompt was left alone", () => {
  assert.match(promptOfferNotice({ kind: "custom" }).body, /edited, so it wasn't changed/);
  assert.match(promptOfferNotice({ kind: "previous-default" }).body, /switch/);
  for (const kind of ["custom", "previous-default"]) {
    assert.ok(promptOfferNotice({ kind }).body.length <= 180);
  }
});

/* ---------------- launch-time downloads of missing models ---------------- */

const cleanupMissing = { ok: false, reason: "missing", modelId: "granite-micro", label: "Granite 4.0 Micro" };

test("a launch downloads the missing speech model, then the missing cleanup model", () => {
  assert.deepStrictEqual(
    startupDownloads({ sttReadiness: missing, cleanupReadiness: cleanupMissing }),
    [
      { kind: "stt", modelId: missing.modelId, label: missing.label },
      { kind: "cleanup", modelId: cleanupMissing.modelId, label: cleanupMissing.label },
    ]
  );
  assert.deepStrictEqual(
    startupDownloads({ sttReadiness: { ok: true }, cleanupReadiness: cleanupMissing }).map((d) => d.kind),
    ["cleanup"]
  );
  assert.deepStrictEqual(startupDownloads({ sttReadiness: { ok: true }, cleanupReadiness: { ok: true } }), []);
});

test("first run, the smoke test and an unknown model download nothing", () => {
  const both = { sttReadiness: missing, cleanupReadiness: cleanupMissing };
  assert.deepStrictEqual(startupDownloads({ ...both, firstRun: true }), []);
  assert.deepStrictEqual(startupDownloads({ ...both, smokeTest: true }), []);
  assert.deepStrictEqual(
    startupDownloads({ sttReadiness: { ok: false, reason: "unknown", modelId: "gone" }, cleanupReadiness: { ok: true } }),
    []
  );
});

test("a launch downloading the speech model says so instead of asking the user to download it", () => {
  for (const hidden of [false, true]) {
    const r = rig();
    startup(r, { hidden, sttReadiness: missing, sttDownloading: true });
    assert.strictEqual(r.shown.length, 1);
    assert.match(r.shown[0].options.title, /downloading the speech model/);
    assert.ok(r.shown[0].options.body.includes(`“${missing.label}”`));
    assert.doesNotMatch(r.shown[0].options.title, /ready|not downloaded/);
  }
  // A failed record hotkey still wins.
  const r = rig();
  startup(r, { hidden: true, hotkeyStatus: failedRecord, sttReadiness: missing, sttDownloading: true });
  assert.match(r.shown[0].options.title, /hotkey not working/);
});

function downloadRig(outcomes) {
  const calls = [];
  const notes = [];
  const warnings = [];
  return {
    calls,
    notes,
    warnings,
    opts: {
      download: async (req) => {
        calls.push(req);
        const outcome = outcomes[req.kind];
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      notify: (note, options) => notes.push({ ...note, critical: !!options?.critical }),
      logger: { info() {}, warn: (msg) => warnings.push(msg) },
      hotkey: "CommandOrControl+Shift+Space",
    },
  };
}
const fullPlan = startupDownloads({ sttReadiness: missing, cleanupReadiness: cleanupMissing });

test("startup downloads run one at a time, speech first, and joining any transfer already running", async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  await runStartupDownloads({
    plan: fullPlan,
    download: async (req) => {
      order.push(req);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { ok: true };
    },
    notify() {},
    logger: { info() {}, warn() {} },
  });
  assert.strictEqual(peak, 1);
  assert.deepStrictEqual(order, [
    { kind: "stt", modelId: missing.modelId, join: true },
    { kind: "cleanup", modelId: cleanupMissing.modelId, join: true },
  ]);
});

test("a speech model that lands says ready; cleanup announces itself elsewhere", async () => {
  const r = downloadRig({ stt: { ok: true }, cleanup: { ok: true } });
  await runStartupDownloads({ plan: fullPlan, ...r.opts });
  assert.deepStrictEqual(r.notes.map((n) => n.title), ["Earheart is ready"]);

  const noHotkey = downloadRig({ stt: { ok: true } });
  await runStartupDownloads({ plan: fullPlan.slice(0, 1), ...noHotkey.opts, hotkeyOk: false });
  assert.strictEqual(noHotkey.notes.length, 0, "no \"press X\" when X didn't register");
});

test("a failed speech download says why and leads to Settings; cleanup still tries", async () => {
  const r = downloadRig({ stt: { ok: false, error: "getaddrinfo ENOTFOUND huggingface.co" }, cleanup: { ok: true } });
  const results = await runStartupDownloads({ plan: fullPlan, ...r.opts });
  assert.strictEqual(r.notes.length, 1);
  assert.match(r.notes[0].title, /download failed/);
  assert.ok(r.notes[0].body.includes(`“${missing.label}”`));
  assert.ok(r.notes[0].body.includes("ENOTFOUND"));
  assert.match(r.notes[0].body, /Click to open Settings\.$/);
  assert.ok(r.notes[0].body.length <= BODY_MAX);
  assert.strictEqual(r.notes[0].critical, true);
  assert.strictEqual(r.calls.length, 2);
  assert.deepStrictEqual(results.map((x) => x.ok), [false, true]);
});

test("a cancelled download is quiet, a failed cleanup is only logged, and a throw never escapes", async () => {
  const r = downloadRig({ stt: { ok: false, cancelled: true, error: "aborted" }, cleanup: new Error("disk full") });
  const results = await runStartupDownloads({ plan: fullPlan, ...r.opts });
  assert.strictEqual(r.notes.length, 0);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /cleanup model granite-micro: disk full/);
  assert.deepStrictEqual(results.map((x) => x.ok), [false, false]);
});


test("startup skips queued models deselected while speech downloads", async () => {
  let cleanupEnabled = true;
  const calls = [];
  await runStartupDownloads({
    plan: fullPlan,
    ...downloadRig({}).opts,
    isSelected: (item) => item.kind === "stt" || cleanupEnabled,
    download: async (item) => {
      calls.push(item.kind);
      cleanupEnabled = false;
      return { ok: true };
    },
  });
  assert.deepStrictEqual(calls, ["stt"]);
});

test("startup does not announce an obsolete speech download outcome", async () => {
  for (const outcome of [{ ok: true }, { ok: false, error: "offline" }]) {
    let selected = true;
    const r = downloadRig({});
    await runStartupDownloads({
      plan: fullPlan.slice(0, 1),
      ...r.opts,
      isSelected: () => selected,
      download: async () => {
        selected = false;
        return outcome;
      },
    });
    assert.deepStrictEqual(r.notes, []);
  }
});
