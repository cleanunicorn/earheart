// Wait for a webContents to finish loading, with a deadline.
//
// The smoke and screenshot scripts stage real windows and used to wait on
// `did-finish-load` with no bound, so a page that never loads hung the run
// until CI's job timeout. This is the one place that wait lives now: it
// rejects with a named error as soon as the main frame fails to load, or once
// `timeoutMs` passes, and removes its listeners either way, so a hang fails
// fast and the process can exit.

// Chromium's ERR_ABORTED: the navigation was replaced by another one (for
// example a reload), not a broken page. The replacement still finishes.
const ERR_ABORTED = -3;

function waitForLoad(wc, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onLoad);
      wc.removeListener("did-fail-load", onFail);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`waitForLoad: page did not finish loading within ${timeoutMs} ms`)
      );
    }, timeoutMs);
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onFail = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      cleanup();
      reject(
        new Error(
          `waitForLoad: page failed to load: ${errorDescription} (${errorCode}) ${validatedURL}`
        )
      );
    };
    wc.on("did-finish-load", onLoad);
    wc.on("did-fail-load", onFail);
  });
}

module.exports = { waitForLoad };
