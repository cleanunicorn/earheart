// What the settings window says after "Fix auto-paste permission" runs, for
// every result fixPastePermissions (main/output/deliver.js) can return. Kept
// pure and separate so each combination is unit-tested; loaded as a classic
// script before settings.js.

function permissionFixStatus(result) {
  if (result.granted) {
    return {
      text: "Both permissions are on — if auto-paste still fails, Open error log shows why.",
      cls: "status ok",
    };
  }
  const automation = result.pane === "automation";
  if (!result.opened) {
    const where = automation ? "Automation ▸ Earheart ▸ System Events" : "Accessibility";
    return {
      text: `Couldn't open System Settings — open it manually: Privacy & Security ▸ ${where}.`,
      cls: "status err",
    };
  }
  if (!automation) {
    // The Accessibility pane lists apps with +/−. A grant an update left behind
    // stays listed and on; if the reset couldn't clear it, only removing and
    // re-adding the entry rewrites it.
    return {
      text: result.reset
        ? "Opened System Settings — turn Earheart on under Accessibility."
        : "Opened System Settings — turn Earheart on under Accessibility. If it is already on, remove it with − and add Earheart again.",
      cls: "status",
    };
  }
  // The Automation pane has no +/−: an app appears only once it has asked, with
  // a toggle per app it may control.
  if (result.automation === "pending") {
    return {
      text: "macOS is waiting for an answer — click Allow on its prompt, or dictate again and allow it then.",
      cls: "status",
    };
  }
  if (result.automation === "denied") {
    return {
      text: "Opened System Settings — under Automation ▸ Earheart, turn System Events on.",
      cls: "status",
    };
  }
  return {
    text: "Couldn't check Automation — Open error log shows why; dictate again and click Allow if macOS asks.",
    cls: "status err",
  };
}

// Exported for unit tests only (hotkey-capture.js pattern).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { permissionFixStatus };
}
