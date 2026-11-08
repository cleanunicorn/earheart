// Notices that tell the user about a broken setup before they speak: a record
// hotkey that failed to register, or a built-in speech model that isn't on
// disk. main.js shows them at launch and pipeline.js when the hotkey is pressed
// without a model, so both say the same thing and both lead to Settings.
//
// Electron is injected rather than required, so the copy, the notifier and the
// startup policy can be tested directly — main.js binds Electron at module
// scope and cannot be required from a test.

const { prettyHotkey } = require("./util/hotkey-label");
const { t } = require("./i18n");

// Matches the other notifications' limit (pipeline.js), so a long native error
// can't push the fix path out of view.
const BODY_MAX = 180;

function readyNotice(hotkey) {
  const combo = prettyHotkey(hotkey);
  return {
    title: t("notice.ready.title"),
    body: combo ? t("notice.ready.pressHotkey", { hotkey: combo }) : t("notice.ready.openTray"),
  };
}

/**
 * The notice for a getSttReadiness() result that is not ok. Names the model by
 * its registry label, never the internal id.
 */
function sttNotReadyNotice(readiness) {
  if (readiness.reason === "unknown") {
    return { title: t("notice.sttUnknown.title"), body: t("notice.sttUnknown.body") };
  }
  return {
    title: t("notice.sttMissing.title"),
    body: t("notice.sttMissing.body", { model: readiness.label }),
  };
}

/**
 * The notice for a new default cleanup prompt (settings.cleanupPromptOffer).
 * Its click opens Settings → Cleanup, where the offer is answered.
 */
function promptOfferNotice(offer) {
  return {
    title: t("notice.promptOffer.title"),
    body: t(offer.kind === "custom" ? "notice.promptOffer.custom" : "notice.promptOffer.default"),
  };
}

/** The notice for a record hotkey that failed to register at launch. */
function hotkeyFailureNotice(result) {
  const suffix = ` ${t("notice.hotkey.clickToOpen")}`;
  return {
    title: t("notice.hotkey.title"),
    body: `${String(result.error).slice(0, BODY_MAX - suffix.length)}${suffix}`,
  };
}

// How many shown notices stay referenced at once. A notice leaves the set when
// it is clicked, closed or fails; the cap bounds it on platforms that never
// report a dismissal.
const HELD_MAX = 8;

/**
 * Shows notices whose click opens Settings. Every shown notice stays
 * referenced until it is clicked, closed or fails, so its click handler
 * survives: a Notification only a local scope referenced can be collected
 * before the user gets to it, and one dictation can raise several.
 *
 * Without a notification service (a Linux session without one, or permission
 * denied) show() is a silent no-op, so Settings opens instead — unless the
 * notifier was made with `settingsWhenUnsupported: false`, for notices whose
 * news is already on screen. A `critical` notice — one reporting that
 * dictation can't work — always falls back to Settings, also when it throws or
 * the OS reports it failed.
 */
function createNotifier({ Notification, openSettings, logger, settingsWhenUnsupported = true }) {
  const held = new Set();
  let current = null;
  function show(note, { critical = false } = {}) {
    if (!Notification.isSupported()) {
      if (critical || settingsWhenUnsupported) openSettings();
      return;
    }
    let shown = null;
    try {
      shown = new Notification(note);
      const release = () => held.delete(shown);
      shown.on("click", () => {
        release();
        openSettings();
      });
      shown.on("close", release);
      if (critical) {
        shown.on("failed", () => {
          release();
          openSettings();
        });
      }
      held.add(shown);
      if (held.size > HELD_MAX) held.delete(held.values().next().value);
      current = shown;
      shown.show();
    } catch (err) {
      if (shown) held.delete(shown);
      logger.warn(`notification failed: ${err.message}`);
      if (critical) openSettings();
    }
  }
  return { show, current: () => current, held: () => [...held] };
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

/**
 * Announce a new default cleanup prompt once: the first launch that finds one
 * the user hasn't decided on, while cleanup is on. `record(id)` remembers the
 * announcement, so later launches stay quiet; Settings keeps offering it.
 * Returns whether it announced.
 */
function announcePromptOffer({ cfg, offer, notify, record }) {
  if (!offer || !cfg.cleanup?.enabled || cfg.cleanup.promptOfferNotified === offer.id) return false;
  notify(promptOfferNotice(offer));
  record(offer.id);
  return true;
}

module.exports = {
  readyNotice,
  sttNotReadyNotice,
  hotkeyFailureNotice,
  promptOfferNotice,
  createNotifier,
  BODY_MAX,
  HELD_MAX,
  announceStartup,
  announcePromptOffer,
};
