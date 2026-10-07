// Notices that tell the user about a broken setup before they speak: a record
// hotkey that failed to register, or a built-in speech model that isn't on
// disk. main.js shows them at launch and pipeline.js when the hotkey is pressed
// without a model, so both say the same thing and both lead to Settings.
//
// Electron is injected rather than required, so the copy, the notifier and the
// startup policy can be tested directly — main.js binds Electron at module
// scope and cannot be required from a test.

const { prettyHotkey } = require("./util/hotkey-label");

// Matches the other notifications' limit (pipeline.js), so a long native error
// can't push the fix path out of view.
const BODY_MAX = 180;

function readyNotice(hotkey) {
  const combo = prettyHotkey(hotkey);
  return {
    title: "Earheart is ready",
    body: combo ? `Press ${combo} to dictate.` : "Open the tray menu to get started.",
  };
}

/**
 * The notice for a getSttReadiness() result that is not ok. Names the model by
 * its registry label, never the internal id.
 */
function sttNotReadyNotice(readiness) {
  if (readiness.reason === "unknown") {
    return {
      title: "Earheart: no speech model available",
      body:
        "The selected speech model isn't available. Choose one in Settings → " +
        "Speech-to-text. Click to open Settings.",
    };
  }
  return {
    title: "Earheart: speech model not downloaded",
    body:
      `Download “${readiness.label}” in Settings → Speech-to-text before ` +
      "dictating. Click to open Settings.",
  };
}

/** The notice for a record hotkey that failed to register at launch. */
function hotkeyFailureNotice(result) {
  const suffix = " Click to open Settings.";
  return {
    title: "Earheart: hotkey not working",
    body: `${String(result.error).slice(0, BODY_MAX - suffix.length)}${suffix}`,
  };
}

/**
 * Shows notices whose click opens Settings. The latest one stays referenced
 * past show() so its click handler survives: a Notification only a local scope
 * referenced can be collected before the user gets to it.
 *
 * Without a notification service (a Linux session without one, or permission
 * denied) show() is a silent no-op, so Settings opens instead. A `critical`
 * notice — one reporting that dictation can't work — also falls back to
 * Settings when it throws or the OS reports it failed.
 */
function createNotifier({ Notification, openSettings, logger }) {
  let current = null;
  function show(note, { critical = false } = {}) {
    if (!Notification.isSupported()) {
      openSettings();
      return;
    }
    try {
      current = new Notification(note);
      current.on("click", () => openSettings());
      if (critical) current.on("failed", () => openSettings());
      current.show();
    } catch (err) {
      logger.warn(`notification failed: ${err.message}`);
      if (critical) openSettings();
    }
  }
  return { show, current: () => current };
}

/**
 * Decide what a launch shows. First match wins:
 *   smoke test                 → nothing
 *   visible first run          → the setup wizard
 *   record hotkey failed       → Settings (visible) / a notice (hidden)
 *   speech model not ready     → a notice (visible or hidden)
 *   visible                    → the "ready" notice
 *   hidden (autostart), healthy → nothing
 * A pause-only failure raises nothing here — dictation still works — and shows
 * under its field when Settings opens.
 */
function announceStartup({
  cfg,
  hidden,
  smokeTest,
  firstRun,
  hotkeyStatus,
  sttReadiness,
  openWizard,
  openSettings,
  notify,
}) {
  if (smokeTest) return;
  if (!hidden && firstRun) {
    openWizard();
    return;
  }
  if (!hotkeyStatus.hotkey.ok) {
    // Announcing "press X to dictate" would be a lie. Visible: show Settings,
    // where the hotkey field, its error and the Wayland note live. Hidden
    // (autostart): there is no window, so the notice is the signal.
    if (hidden) notify(hotkeyFailureNotice(hotkeyStatus.hotkey), { critical: true });
    else openSettings();
    return;
  }
  if (!sttReadiness.ok) {
    notify(sttNotReadyNotice(sttReadiness), { critical: true });
    return;
  }
  // Returning user: stay in the tray and announce, instead of popping a
  // settings window they have to dismiss. A healthy autostart stays silent.
  if (!hidden) notify(readyNotice(cfg.hotkey));
}

module.exports = {
  readyNotice,
  sttNotReadyNotice,
  hotkeyFailureNotice,
  createNotifier,
  announceStartup,
};
