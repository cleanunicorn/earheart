// Wait for a webContents to finish loading, with a deadline.
//
// The smoke and screenshot scripts stage real windows and used to wait on
// `did-finish-load` with no bound, so a page that never loads hung the run
// until CI's job timeout. This is the one place that wait lives now: it
// rejects with a named error once `timeoutMs` passes and removes its
// listener, so a hang fails fast and the process can exit.

function waitForLoad(wc, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wc.removeListener("did-finish-load", onLoad);
      reject(
        new Error(`waitForLoad: page did not finish loading within ${timeoutMs} ms`)
      );
    }, timeoutMs);
    const onLoad = () => {
      clearTimeout(timer);
      resolve();
    };
    wc.once("did-finish-load", onLoad);
  });
}

module.exports = { waitForLoad };
