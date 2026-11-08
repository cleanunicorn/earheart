// English: the canonical catalog. Keys are stable and semantic; see
// docs/localization.md for the entry format and the review rules.
(function (root) {
  const catalog = {
    // The language's own name, shown in the language picker. Never translated.
    "meta.name": "English",

    // Tray menu, tooltip and tray notifications (main/tray.js)
    "tray.start": "Start dictation",
    "tray.stop": "Stop & transcribe",
    "tray.processing": "Processing…",
    "tray.cancel": "Cancel",
    "tray.retryFailed": "Retry failed transcription",
    "tray.discardFailed": "Discard failed recording",
    "tray.output.paste": "Paste into active app",
    "tray.output.pasteCopy": "Paste and keep on clipboard",
    "tray.output.clipboard": "Copy to clipboard only",
    "tray.copyLast": "Copy last transcription",
    "tray.correctLast": "Correct last transcription…",
    "tray.settings": "Settings…",
    "tray.quit": "Quit Earheart",
    "tray.updateTo": "Update to v{version}…",
    "tray.downloadingUpdate": "Downloading update…",
    "tray.downloadingUpdatePct": "Downloading update… {percent}%",
    "tray.restartToUpdate": "Restart to update to v{version}",
    "tray.tooltip.recording": "Earheart — recording",
    "tray.tooltip.processing": "Earheart — processing",
    "tray.tooltip.ready": "Earheart — ready",
    "tray.copyFailed.title": "Could not copy transcript",
    "tray.copyFailed.body": "Your transcript is still in History. Try copying it again.",
    "tray.outputModeFailed.title": "Could not change the output mode",
    "tray.outputModeFailed.body": "Earheart couldn't save the setting. It is unchanged.",

    // Startup and setup notifications (main/setup-notices.js)
    "notice.ready.title": "Earheart is ready",
    "notice.ready.pressHotkey": "Press {hotkey} to dictate.",
    "notice.ready.openTray": "Open the tray menu to get started.",
    "notice.sttUnknown.title": "Earheart: no speech model available",
    "notice.sttUnknown.body":
      "The selected speech model isn't available. Choose one in Settings → Speech-to-text. Click to open Settings.",
    "notice.sttMissing.title": "Earheart: speech model not downloaded",
    "notice.sttMissing.body":
      "Download “{model}” in Settings → Speech-to-text before dictating. Click to open Settings.",
    "notice.promptOffer.title": "Earheart: a new cleanup prompt",
    "notice.promptOffer.custom":
      "The default prompt is now tuned for code dictation. Yours is edited, so it wasn't changed. Click to compare.",
    "notice.promptOffer.default":
      "The default prompt is now tuned for code dictation. Click to switch to it in Settings → Cleanup.",
    "notice.hotkey.title": "Earheart: hotkey not working",
    "notice.hotkey.clickToOpen": "Click to open Settings.",

    // Window titles and native dialogs (main/windows.js)
    "window.settings.title": "Earheart",
    "window.correction.title": "Correct transcript · Earheart",
    "window.wizard.title": "Welcome to Earheart",
    "correction.busy": "Your current correction is still open. Copy or close it before opening another transcript.",
    "correction.discard.keep": "Keep editing",
    "correction.discard.discard": "Discard draft",
    "correction.discard.message": "Discard your uncopied corrections?",
    "correction.discard.detail":
      "Your original transcript stays in History. Remembered spellings have already been saved.",

    // Correction window
    "correction.heading": "Correct transcript",
    "correction.transcriptLabel": "Transcript",
    "correction.selectionHint":
      "Select text, then press Tab to correct it. You can also edit the transcript directly.",

    // Settings → General: UI language and appearance
    "settings.language.title": "Language",
    "settings.language.label": "Interface language",
    "settings.language.system": "System default",
    "settings.language.hint":
      "The language of menus, settings and notifications. It does not change the language you dictate in.",
    "settings.appearance.title": "Appearance",
    "settings.appearance.system": "System",
    "settings.appearance.light": "Light",
    "settings.appearance.dark": "Dark",
    "settings.appearance.hint": "Light or dark for the overlay and every window. System follows your OS.",
  };
  if (typeof module !== "undefined" && module.exports) module.exports = catalog;
  else (root.EarheartLocales = root.EarheartLocales || {}).en = catalog;
})(typeof globalThis !== "undefined" ? globalThis : this);
