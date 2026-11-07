// What "Lower other audio while recording" can do on this system, said
// plainly, from main's `ducking:status` (main/ducking/controller.js): not
// available (and why), the last failure, advice from the last take, or what
// it did this take. Dictation never depends on it. Shared by Settings and
// the setup wizard.
const DuckingStatus = (() => {
  function text(status) {
    if (!status) return "";
    const asUsual = "Dictation works as usual.";
    if (status.available === false) return `Not available on this system (${status.reason}). ${asUsual}`;
    if (status.lastError) return `Last attempt failed: ${status.lastError}. ${asUsual}`;
    // Advice from the last take (a macOS output switch mid-lowering): a full
    // sentence already, and not a failure.
    if (status.notice) return status.notice;
    if (status.state === "lowered") return "Other audio is lowered right now.";
    if (status.state === "skipped" && status.detail) return `Not lowered this take: ${status.detail}.`;
    if (status.state === "pending" && status.detail) return `Not restored yet: ${status.detail}.`;
    return status.mechanism ? `Uses ${status.mechanism} to change the output volume.` : "";
  }

  // Ask main and say what it answered; an older main without the handler (or
  // a failed call) says nothing rather than guess.
  async function show(element) {
    let status = null;
    try {
      status = await earheart.invoke("ducking:status");
    } catch {
      // see above
    }
    element.textContent = text(status);
  }

  return { text, show };
})();
if (typeof module !== "undefined") module.exports = DuckingStatus;
