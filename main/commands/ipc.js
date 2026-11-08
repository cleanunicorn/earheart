// IPC for the voice command card (#344). Every handler is checked twice before
// it touches the session: the sender must be the command window's own page
// (the preload already gives only that role these channels; this is the
// main-side half, so a compromised or confused window of another role gets
// nothing), and the payload must name a command id, which the session
// compares to the current command so a stale card or a late click is ignored.
//
// Handlers return plain data and never throw into the renderer. Content (the
// selection, the instruction, the result) travels only on command:state and
// the command:get reply, to the one window that shows it.

const REJECTED = { ok: false, error: "Not available from this window" };
const INVALID = { ok: false, error: "Invalid request" };

function registerCommandIpc({ ipcMain, session, isCommandSender, closeWindow }) {
  const guarded = (fn) => async (event, payload) => {
    if (!isCommandSender(event?.sender)) return REJECTED;
    const id = payload?.id;
    if (!Number.isSafeInteger(id) || id < 1) return INVALID;
    try {
      return await fn(id);
    } catch {
      return { ok: false, error: "The command failed" };
    }
  };

  // The card asks for the current command when it loads (a push sent before
  // its page was ready is lost), so get has no id to name yet.
  ipcMain.handle("command:get", (event) =>
    isCommandSender(event?.sender) ? { ok: true, view: session.peek() } : REJECTED);
  ipcMain.handle("command:stop", guarded((id) => session.stop(id)));
  ipcMain.handle("command:cancel", guarded((id) => {
    const result = session.cancel(id);
    closeWindow();
    return result;
  }));
  // Closing always closes, whichever command the card thinks it shows.
  ipcMain.handle("command:close", (event, payload) => {
    if (!isCommandSender(event?.sender)) return REJECTED;
    if (Number.isSafeInteger(payload?.id)) session.cancel(payload.id);
    closeWindow();
    return { ok: true };
  });
  ipcMain.handle("command:retry", guarded((id) => session.retry(id)));
  ipcMain.handle("command:restart", guarded((id) => session.restart(id)));
  ipcMain.handle("command:apply", guarded((id) => session.apply(id)));
  ipcMain.handle("command:copy", guarded((id) => session.copy(id)));
}

module.exports = { registerCommandIpc, REJECTED, INVALID };
