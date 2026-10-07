// How a form follows settings main saved while it was open — shared by the
// settings window and the setup wizard (both load this as a classic script
// before their own, like hotkey-capture.js). The main half of the contract is
// commitSettings in main/ipc.js.

// The shared fields (written by both a form and main) as a form last saw them
// from main. Sent with every save so main can tell a change made in the form
// from a stale value main has since replaced. The keys must match the `name`s
// of SHARED_FIELDS in main/ipc.js — test/ipc-contract.test.js pins that, since
// a key main doesn't know is skipped silently and the stale value wins.
function sharedBaseline(cfg) {
  return { outputMode: displayedOutputMode(cfg.output), remind: cfg.updates?.remind !== false };
}

// The output mode a form shows. Legacy settings expressed "paste & keep on
// clipboard" as paste mode with clipboard restore turned off; show those as
// the explicit paste-copy mode. Mirrors effectiveOutputMode in
// main/settings.js, which main compares the baseline against.
function displayedOutputMode(output) {
  return output.mode === "paste" && !output.restoreClipboard ? "paste-copy" : output.mode;
}

// Call `apply({ previous, current })` for every settings:changed. Changes that
// arrive before the form has loaded its settings are queued, in order, until
// the returned ready() runs at the end of the form's init.
function followSettingsChanges(apply) {
  let queued = [];
  earheart.on("settings:changed", (change) => {
    if (queued) queued.push(change);
    else apply(change);
  });
  return function ready() {
    const pending = queued;
    queued = null;
    for (const change of pending) apply(change);
  };
}

// Exported for unit tests only (hotkey-capture.js pattern); the pages use the
// classic-script globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { sharedBaseline, displayedOutputMode, followSettingsChanges };
}
