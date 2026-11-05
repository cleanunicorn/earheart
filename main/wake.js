// Sleep/wake handling for the overlay's Space placement on macOS (#353).
//
// The overlay joins every Space once at launch and re-asserts that before every
// show (main/windows.js rejoinActiveSpace). After the Mac wakes from standby the
// card was still reported opening on the Space it was first shown on, with
// nothing in the main process reacting to the wake. This listens for the wake
// and asks windows.js to re-join the hidden overlay to all Spaces.
//
// Kept apart from windows.js and free of an `electron` import so the wiring is
// unit-testable: main.js passes in powerMonitor, the pipeline's busy check and
// the re-join, and a test passes fakes (test/wake.test.js).
//
// Unverified on real macOS: nothing on the Linux host this was written on and
// nothing in CI executes a line of macOS Space behaviour. The real-Mac check is
// in the PR that added this (#353) and in test/wake.test.js's header.

// resume: the system woke from sleep. unlock-screen: the session was unlocked,
// which follows a wake that required a password and is the first moment the
// window server is serving this user's Spaces again. Both are macOS events in
// Electron's powerMonitor (unlock-screen is macOS and Windows only).
const WAKE_EVENTS = ["resume", "unlock-screen"];

/**
 * Wire the wake re-join. Returns the events listened to (empty off macOS).
 *
 * @param {object} deps
 * @param {{ on(event: string, fn: Function): void }} deps.powerMonitor
 * @param {() => boolean} deps.isBusy  true while a dictation is recording or processing
 * @param {(reason: string, opts: { deferOnly: boolean }) => void} deps.rejoin
 *   windows.rejoinOverlayAfterWake: re-joins the hidden overlay now and logs it,
 *   or, with deferOnly, makes no window call and leaves it to the next show
 * @param {string} [deps.platform]
 */
function init({ powerMonitor, isBusy, rejoin, platform = process.platform }) {
  // Windows virtual desktops have no public API to join (main/windows.js), and
  // Linux has never shown this; neither gets a listener, so neither changes.
  if (platform !== "darwin") return [];
  if (!powerMonitor || typeof powerMonitor.on !== "function") return [];
  for (const event of WAKE_EVENTS) {
    // Read the pipeline at the moment of the wake, not at wiring time. While a
    // dictation is recording or processing the card is on screen and its
    // renderer owns the microphone: nothing may touch the window then.
    powerMonitor.on(event, () => rejoin(event, { deferOnly: Boolean(isBusy()) }));
  }
  return [...WAKE_EVENTS];
}

module.exports = { init, WAKE_EVENTS };
