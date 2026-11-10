// Fixed, local commands. No renderer-supplied IPC names, paths or code.
const NAVIGATION = [
  ["general", "General"], ["live", "Live preview"], ["stt", "Speech-to-text"],
  ["cleanup", "Cleanup"], ["history", "History"], ["advanced", "Advanced"],
];
function checkedQuery(query = "") {
  if (typeof query !== "string") throw new Error("The search must be text.");
  if (query.length > 200) throw new Error("Search is limited to 200 characters.");
  return query;
}
function createPalette({ windows, pipeline, history, settings, actions }) {
  let session = null;
  function close(restore = false) {
    const old = session;
    session = null; // release synchronously, including while load is pending
    if (!old) return;
    if (!old.win.isDestroyed()) old.win.destroy();
    if (restore && !old.lostFocus) windows.restorePaletteCaller?.(old.caller);
  }
  function open() {
    if (!pipeline.isPaletteIdle() || windows.isWizardOpen?.()) {
      actions.notice?.("Finish the current dictation or setup before opening Commands.");
      return false;
    }
    if (session) { if (session.ready) session.win.focus(); return true; }
    const caller = windows.capturePaletteCaller?.();
    const win = windows.createPaletteWindow();
    const current = { win, caller, ready: false, executed: false };
    session = current;
    win.on("closed", () => { if (session === current) session = null; });
    win.on("blur", () => {
      if (session !== current || !current.ready) return;
      // Preserve the dispatch latch while an action settles, but never reclaim
      // foreground from an app the user switched to in the meantime.
      current.lostFocus = true;
      if (!current.dispatching) close();
    });
    win.webContents.on("render-process-gone", () => { if (session === current) close(); });
    (async () => { await windows.loadPalette(win); })().then(() => {
      if (session !== current) return;
      if (!pipeline.isPaletteIdle() || windows.isWizardOpen?.()) { close(); return; }
      current.ready = true;
      win.show(); win.focus();
    }).catch(() => { if (session === current) close(); });
    return true;
  }
  function requireSender(sender) {
    if (!session || session.win.webContents !== sender) throw new Error("This command requires the palette window.");
    return session;
  }
  function query(sender, value) {
    requireSender(sender);
    const query = checkedQuery(value);
    const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const commands = NAVIGATION.map(([section, label]) => ({ id: `nav-${section}`, label, group: "Navigation", keywords: `${section} settings preferences` }));
    commands.push(
      { id: "copy", label: "Copy last transcription", group: "Actions", disabled: !actions.lastTranscript() },
      { id: "correct", label: "Correct last transcription", group: "Actions", disabled: !history.list()[0] },
      { id: "updates", label: "Check for updates", group: "Actions" },
      { id: "logs", label: "Open error log", group: "Actions" },
    );
    const items = commands.filter(c => terms.every(t => `${c.label} ${c.keywords || ""}`.toLocaleLowerCase().includes(t)));
    const enabled = settings.get().history.enabled;
    const page = enabled ? history.search({ query, limit: 8 }) : { entries: [], total: 0 };
    items.push(...page.entries.map(entry => ({ id: "history", entryId: entry.id, label: entry.text.slice(0, 180), group: "History" })));
    // Always retain a route to the full, paged results and destructive controls.
    items.push({ id: "history-search", label: "Open History", group: "History" });
    return { items, total: page.total, notice: !enabled ? "History is disabled." : page.total ? `${page.total} saved dictations match. Showing up to 8.` : query ? "No saved dictations match." : "No saved dictations yet." };
  }
  async function execute(sender, request) {
    const current = requireSender(sender);
    if (!pipeline.isPaletteIdle()) { close(); throw new Error("Finish the current dictation first."); }
    if (!current.ready || current.executed) throw new Error("This command has already been accepted.");
    if (!request || typeof request !== "object" || typeof request.id !== "string") throw new Error("Unknown command.");
    const query = checkedQuery(request.query);
    const nav = NAVIGATION.find(([id]) => request.id === `nav-${id}`);
    let run;
    if (nav) run = () => windows.openSettings({ section: nav[0] });
    else if (request.id === "history-search") run = () => windows.openSettings({ section: "history", query });
    else if (request.id === "history") {
      const entry = history.isValidId(request.entryId) && history.list().find(e => e.id === request.entryId);
      if (!settings.get().history.enabled || !entry) throw new Error("This transcript is no longer in History.");
      run = () => windows.openSettings({ section: "history", query, entryId: entry.id });
    } else if (request.id === "copy") {
      if (!actions.lastTranscript()) throw new Error("No transcription to copy.");
      run = actions.copyLast;
    } else if (request.id === "correct") {
      if (!history.list()[0]) throw new Error("No transcription to correct.");
      run = actions.correctLast;
    } else if (request.id === "updates") run = actions.checkUpdates;
    else if (request.id === "logs") run = actions.openLog;
    else throw new Error("Unknown command.");
    current.executed = true; // synchronously latch before any asynchronous operation
    current.dispatching = true;
    try {
      const result = await run();
      if (result?.ok === false) throw new Error(result.error || "The command failed.");
      if (session === current) close(!nav && ["copy", "updates"].includes(request.id));
      return { ok: true };
    } finally {
      // A failed session stays latched, but blur and Close still dismiss it.
      current.dispatching = false;
      if (session === current && current.lostFocus) close();
    }
  }
  function install(ipcMain) {
    const answer = fn => async (event, payload) => {
      try { return await fn(event.sender, payload); }
      catch (error) { return { ok: false, error: error.message }; }
    };
    ipcMain.handle("palette:open", answer(sender => {
      if (!windows.paletteCaller(sender)) throw new Error("Open Commands from Settings.");
      return { ok: open(), error: "Finish the current dictation before opening Commands." };
    }));
    ipcMain.handle("palette:query", answer((sender, value) => ({ ok: true, ...query(sender, value) })));
    ipcMain.handle("palette:execute", answer(execute));
    ipcMain.handle("palette:close", answer(sender => { requireSender(sender); close(true); return { ok: true }; }));
  }
  return { open, close, query, execute, install, isOpen: () => !!session, dismissForDictation: () => { if (!session) return false; close(); return true; } };
}
module.exports = { createPalette };
