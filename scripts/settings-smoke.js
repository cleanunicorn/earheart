// Drives the real settings window and verifies the settings-page contract —
// the interaction model text-parsing tests can't reach:
//
//   1. The panel is one continuous scroll: every section renders at once
//      (the scroll range is far taller than the viewport), none are
//      display:none-swapped.
//   2. The scroll spy works: scrolling to the bottom lights the last index
//      entry (Advanced) with .active + aria-current.
//   3. The index navigates: clicking General re-highlights its entry immediately
//      and glides the panel back to the top.
//   4. The roving tabindex is seated at load: exactly one index button is a
//      Tab stop before any interaction.
//   5. The update card renders the full release notes, as text, never markup,
//      and clears them when the update does.
//   6. The engine state badge follows the engine radio in both directions, and
//      swaps inside a live region so the privacy consequence is announced.
//   7. Both custom-model sections offer a "Browse Hugging Face" button beside
//      "Find versions".
//   8. A fresh profile preselects the registry's default cleanup model, with its
//      note, in Settings and in the first-run wizard. The default is not the
//      first catalog entry, so a lost `select.value = …` would show another
//      model here instead of passing silently.
//   9. A history entry saved from an interrupted dictation is marked in the
//      list; a normal one isn't. The notification that announced it is long
//      gone by the time History is reopened. Search (#342) filters by any
//      case, says when nothing matches, and an older query's late answer
//      never replaces a newer one's; transcript and query text render as text,
//      never HTML; Delete removes one entry (on disk too) and keeps the rest,
//      and a delete that can't write the file says so on the card and keeps it.
//      The pager pages through the matches only, and deleting the last match
//      on a page lands on the page before it.
//      Kept recordings (17, #343): the Keep recordings switch is off by default
//      and can't be turned on without secure storage, saying why; an entry
//      with a kept recording plays it from a blob with seekable controls,
//      exports the original WAV, and deleting it mid-playback stops the
//      player, revokes its URL and deletes the file.
//  10. A model download keeps progress through redraws, exposes a focused
//      cancel action, handles a download owned by another window, and
//      announces terminal results in the persistent region.
//  11. Wizard-started downloads survive Settings model changes without
//      overwriting a concurrent download's state.
//  12. Failed model removals appear in the row and persistent live region.
//  13. A main-side save while the window is open (the tray's output radios,
//      the update prompt's "Don't remind me") shows in the form through
//      settings:changed, without discarding an edit the user hasn't saved,
//      and moves the form's baseline so its next save keeps the change.
//  14. The same for the setup wizard's output step.
//  13. Removing a custom model: the row shows "Removing…" with its buttons
//      disabled while the delete runs; the confirm mentions the downloaded
//      files only for an installed model; a failed delete (installed "Remove" and
//      "Remove from list") shows its error and keeps the entry; removing the
//      selected custom STT and cleanup models leaves each select on the
//      default, and the real Save persists those ids, never "".
//  13. A record or pause hotkey that failed to register at launch shows under
//      its field as soon as Settings opens, before any Save; a failure about an
//      accelerator the field no longer holds stays hidden, unless a failed
//      restore left the saved hotkey unbound.
//  13. "Find versions" on a speech model Earheart can't run (a NeMo Canary
//      repo) shows discovery's explanation as an error and offers no version
//      to add.
//  13. Save clamps the Performance limits (max dictation length, idle unload)
//      to the fields' own ranges, and says so.
//  14. A microphone chosen while permission or device enumeration is pending
//      survives completion (options and labels still refresh), and Save
//      writes that choice to disk; an untouched saved microphone stays put.
//  16. Save with a built-in model that isn't downloaded downloads it first
//      (with the row's progress), saves only once it is installed, never saves
//      or says "Saved" when the download fails or is cancelled, starts no
//      second transfer for repeated clicks or a Download already running, and
//      downloads nothing when the selection is already installed. Every
//      Save keeps the window open and says "Saved"; editing the form clears
//      that, and only the footer's Close closes the window (#298).
//  15. Each API key field says how the key is stored, matching what real
//      safeStorage reports after `ready`, and a saved key reaches disk as
//      ciphertext that decrypts back to it (secure storage) or, without it
//      (e.g. Linux with no keyring under xvfb), as plaintext — never lost.
//
// Run under Electron:
//
//   xvfb-run -a npx electron scripts/settings-smoke.js --no-sandbox   # Linux
//   npx electron scripts/settings-smoke.js                            # macOS/Win

const { app, session } = require("electron");
const settings = require("../main/settings");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A throwaway profile: check 8 needs first-run defaults, and the smoke should
// never read or write a developer's real settings. One directory per checkout,
// wiped at the start of every run: removing it on the way out doesn't work,
// because Chromium writes Local State, Preferences and friends back while it
// shuts down (even after process "exit"), so a per-run directory would pile up
// in the temp dir. Keyed on the checkout so parallel worktrees don't share one.
// Set before anything touches userData (settings.js resolves its path lazily).
const userData = path.join(
  os.tmpdir(),
  `earheart-settings-smoke-${crypto.createHash("sha1").update(__dirname).digest("hex").slice(0, 8)}`
);
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
// Logs too: on macOS they default outside userData, to the real ~/Library/Logs.
app.setPath("logs", path.join(userData, "logs"));

const windows = require("../main/windows");
const { waitForLoad } = require("./wait-for-load");
const { checkWindowLock } = require("./window-lock-smoke");
const { installPermissionHandler } = require("../main/window-guard");
const history = require("../main/history");
const ipc = require("../main/ipc");
// Keep each invoke handler ipc.init registers, so a check can wrap one (hold
// settings:save's reply open) and put the real one back.
const { ipcMain } = require("electron");
const invokeHandlers = new Map();
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  invokeHandlers.set(channel, handler);
  return registerHandler(channel, handler);
};
const engines = require("../main/engines");
const { registry } = engines;

// loadMicrophones() calls getUserMedia at init; the fake device keeps that
// deterministic on headless CI instead of hanging on a permission that will
// never arrive.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

// Like the tray app (main/main.js), stay alive with no window open: the
// microphone cases close Settings between runs, and Electron's default quit
// would end the smoke with exit 0 before the summary is printed.
app.on("window-all-closed", () => {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Each read is bounded too: an executeJavaScript whose window is destroyed
// mid-call never settles, and would otherwise hang the run past every check.
async function waitFor(read, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let timer;
    const value = await Promise.race([
      read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} (a read never settled)`)), 10000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (value) return value;
    await sleep(10);
  }
  throw new Error(message);
}

// Save keeps Settings open (#298): wait for its "Saved", then dismiss the
// window through the footer's Close button, as a user would. A Save is
// several round-trips (models:status, settings:save, hotkey registration), so
// it gets a longer budget than one poll loop on a loaded machine.
async function savedThenClose(win, message) {
  const run = (code) => win.webContents.executeJavaScript(code, true);
  await waitFor(
    () => !win.isDestroyed() && run(`document.getElementById("save-status").className === "status ok"`),
    message,
    500
  ).catch(async (err) => {
    const shown = win.isDestroyed() ? "(window closed)" : await run(`document.getElementById("save-status").textContent`);
    throw new Error(`${err.message}; status: ${JSON.stringify(shown)}`);
  });
  await clickClose(win);
}

// Click the footer's Close on a later task. Clicked inline, settings:close can
// reach main ahead of executeJavaScript's own reply, destroy the window, and
// leave that reply — and the smoke — waiting forever.
async function clickClose(win) {
  await win.webContents.executeJavaScript(
    `setTimeout(() => document.getElementById("close").click()); true`,
    true
  );
  await waitFor(() => win.isDestroyed(), "Close did not close Settings");
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  const suffix = detail ? ` (${detail})` : "";
  console.log(`[settings-smoke] ${ok ? "ok  " : "FAIL"} ${name}${suffix}`);
}

// Like main.js: a closed window must not quit the app. Without this, a check
// that closes the Settings window by mistake ends the run before the summary,
// and Electron's default quit exits 0 — a silent pass.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    // The shipped permission policy, so the microphone grant below is proven
    // through the same handler the app installs (main/window-guard.js).
    installPermissionHandler(session.defaultSession);
    // Saved pause and discard hotkeys, so check 13 can show their launch
    // failures too.
    settings.save({
      ...settings.get(),
      pauseHotkey: "CommandOrControl+Alt+P",
      discardHotkey: "CommandOrControl+Alt+D",
      audio: { ...settings.get().audio, deviceId: "missing-saved-device" },
    });
    // Check 13: the launch registration result main.js would report — both
    // hotkeys failed on the values now saved.
    const launchHotkeyError = "Could not register the record hotkey (smoke)";
    const launchPauseError = "Could not register the pause hotkey (smoke)";
    const launchDiscardError = "Could not register the discard hotkey (smoke)";
    // As main.js wires them (#204): the overlay's handlers, and custom models
    // following the settings.
    windows.init();
    require("../main/engines/catalog").bindCustomModels(settings);
    ipc.init({
      applyHotkeys: () => ({ hotkey: { ok: true }, pauseHotkey: { ok: true } }),
      onSettingsChanged: () => {},
      getHotkeyStatus: () => ({
        hotkey: { ok: false, error: launchHotkeyError, accelerator: settings.get().hotkey },
        pauseHotkey: { ok: false, error: launchPauseError, accelerator: settings.get().pauseHotkey },
        discardHotkey: { ok: false, error: launchDiscardError, accelerator: settings.get().discardHotkey },
      }),
    });
    const downloads = new Map();
    // Every transfer the engine was asked for, in order (check 16 counts them).
    const downloadCalls = [];
    const installedModels = new Set();
    const isInstalled = engines.isInstalled;
    engines.isInstalled = (kind, modelId) =>
      installedModels.has(`${kind}:${modelId}`) || isInstalled(kind, modelId);
    engines.download = (kind, modelId, { onProgress, signal }) =>
      new Promise((resolve, reject) => {
        downloadCalls.push(`${kind}:${modelId}`);
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        downloads.set(`${kind}:${modelId}`, {
          resolve: () => {
            installedModels.add(`${kind}:${modelId}`);
            resolve();
          },
          reject,
          onProgress,
        });
      });
    // Two entries for check 9, saved before the window reads them: one
    // delivered whole, one recovered from an interrupted dictation.
    const historyCfg = { enabled: true, limit: 100 };
    history.add({ raw: "whole dictation", text: "whole dictation", cleaned: false }, historyCfg);
    history.add(
      { raw: "recovered words", text: "recovered words", cleaned: false, incomplete: true },
      historyCfg
    );
    // And two for the search and delete checks: words that look like markup,
    // and words that need Unicode-aware case folding to find.
    const HTML_TEXT = '<img src=x onerror="window.__historyXss=1"><b>bold claim</b>';
    history.add({ raw: HTML_TEXT, text: HTML_TEXT, cleaned: false }, historyCfg);
    history.add({ raw: "École ΟΔΟΣ notes", text: "École ΟΔΟΣ notes", cleaned: false }, historyCfg);

    const win = windows.openSettings();
    await waitForLoad(win.webContents);
    // Let the init IPC round-trips (settings, models, history) settle.
    await sleep(1200);

    const js = (code) => win.webContents.executeJavaScript(code, true);
    // Model-row helpers: read a row, click one of its buttons by label, pick a
    // model in a select, list the stored custom definitions.
    const rowState = (kind) => js(`JSON.stringify({
      select: document.getElementById(${JSON.stringify(`${kind}-builtin-model`)}).value,
      status: document.querySelector(${JSON.stringify(`#${kind}-model-manage .status`)})?.textContent,
      buttons: [...document.querySelectorAll(${JSON.stringify(`#${kind}-model-manage button`)})].map((b) => b.textContent),
      announcement: document.getElementById("model-dl-announce").textContent,
    })`).then(JSON.parse);
    const clickRowButton = (kind, text) => js(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(`#${kind}-model-manage button`)})]
        .find((b) => b.textContent === ${JSON.stringify(text)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    const selectModel = (kind, modelId) => js(`(() => {
      const select = document.getElementById(${JSON.stringify(`${kind}-builtin-model`)});
      select.value = ${JSON.stringify(modelId)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    const definitionIds = () => (settings.get().customModels || []).map((m) => m.id);

    // 15. API key storage note and the on-disk form of a saved key.
    const keyStorage = settings.keyStorage();
    const keyNotes = JSON.parse(await js(`JSON.stringify({
      stt: document.getElementById("stt-key-storage").textContent,
      cleanup: document.getElementById("cleanup-key-storage").textContent,
    })`));
    const expectedNote = keyStorage.secure ? /^Saved encrypted/ : /^Saved unencrypted/;
    check(
      "each API key field says how the key is stored",
      expectedNote.test(keyNotes.stt) && expectedNote.test(keyNotes.cleanup),
      `${JSON.stringify(keyStorage)} ${JSON.stringify(keyNotes)}`
    );
    const smokeKey = "sk-settings-smoke-key";
    const beforeKey = settings.get();
    settings.save({ ...beforeKey, stt: { ...beforeKey.stt, apiKey: smokeKey } });
    const storedStt = JSON.parse(
      fs.readFileSync(path.join(userData, "settings.json"), "utf8")
    ).stt;
    const { safeStorage } = require("electron");
    const onDiskOk = keyStorage.secure
      ? !JSON.stringify(storedStt).includes(smokeKey) &&
        safeStorage.decryptString(Buffer.from(storedStt.apiKeyEncrypted, "base64")) === smokeKey
      : storedStt.apiKey === smokeKey && !("apiKeyEncrypted" in storedStt);
    check(
      keyStorage.secure
        ? "a saved API key is ciphertext on disk and decrypts back"
        : "without secure storage a saved API key stays usable in plaintext",
      onDiskOk && settings.get().stt.apiKey === smokeKey,
      `backend=${keyStorage.backend}`
    );

    // The window lock: Settings stays on its page and its bridge carries only
    // its own channels (main/window-guard.js, preload.js roles).
    await checkWindowLock(win, {
      role: "settings",
      refused: { method: "on", channel: "record:start" },
      allowed: { method: "on", channel: "history:changed" },
      check,
    });

    // 13. Registration status on open, before any Save.
    const hotkeyRows = JSON.parse(await js(`JSON.stringify({
      record: document.getElementById("hotkey-status").textContent,
      pause: document.getElementById("pause-hotkey-status").textContent,
      discard: document.getElementById("discard-hotkey-status").textContent,
      discardField: document.getElementById("discard-hotkey").value,
    })`));
    check(
      "a hotkey that failed at launch shows under its field on open",
      hotkeyRows.record === launchHotkeyError,
      JSON.stringify(hotkeyRows)
    );
    check(
      "a pause hotkey that failed at launch shows under its field on open",
      hotkeyRows.pause === launchPauseError,
      JSON.stringify(hotkeyRows)
    );
    check(
      "the saved discard hotkey and its launch failure show under its field on open",
      hotkeyRows.discardField === "CommandOrControl+Alt+D" && hotkeyRows.discard === launchDiscardError,
      JSON.stringify(hotkeyRows)
    );
    // A failure about an accelerator the field no longer holds (a rejected
    // save, since undone) stays hidden.
    const staleRow = await js(`(() => {
      renderHotkeyStatus({
        hotkey: { ok: true },
        pauseHotkey: { ok: false, error: "stale pause failure", accelerator: "Alt+F12" },
      });
      return document.getElementById("pause-hotkey-status").textContent;
    })()`);
    check(
      "a failure about an accelerator no longer in the field stays hidden",
      staleRow === "",
      JSON.stringify(staleRow)
    );
    // A failed swap whose rollback also failed leaves the saved hotkey unbound:
    // the result names the attempted accelerator, the field shows the saved
    // one, and the error must still show (hotkeys.js marks it unbound).
    const unboundRow = await js(`(() => {
      renderHotkeyStatus({
        hotkey: { ok: false, unbound: true, error: "record hotkey is now unbound", accelerator: "Alt+F11" },
        pauseHotkey: { ok: true },
      });
      const text = document.getElementById("hotkey-status").textContent;
      renderHotkeyStatus(null);
      return text;
    })()`);
    check(
      "a hotkey left unbound by a failed restore shows on reopen",
      unboundRow === "record hotkey is now unbound",
      JSON.stringify(unboundRow)
    );

    // 1. One continuous scroll, everything rendered.
    const layout = JSON.parse(
      await js(`
        (() => {
          const host = document.querySelector("main");
          const hidden = [...document.querySelectorAll(".panel")].filter(
            (p) => getComputedStyle(p).display === "none"
          ).length;
          return JSON.stringify({
            scrollable: host.scrollHeight > host.clientHeight * 2,
            hidden,
          });
        })();
      `)
    );
    check("panel scrolls as one surface", layout.scrollable);
    const microphone = JSON.parse(await js(`JSON.stringify({
      value: document.getElementById("mic-device").value,
      label: document.querySelector('#mic-device option[value="missing-saved-device"]')?.textContent,
      notice: document.getElementById("mic-device-status").textContent,
    })`));
    check("unavailable saved microphone remains selected and explains fallback",
      microphone.value === "missing-saved-device" &&
        microphone.label === "Configured microphone (not connected)" &&
        microphone.notice.includes("temporarily use the system default") &&
        microphone.notice.includes("selection stays saved"),
      JSON.stringify(microphone));
    check("no section is display:none-swapped", layout.hidden === 0, `${layout.hidden} hidden`);

    // 9. The incomplete marker, and only on the incomplete entry.
    const historyRows = JSON.parse(
      await js(`
        JSON.stringify([...document.querySelectorAll("#history-list li")].map((li) => ({
          text: li.querySelector(".text").textContent,
          meta: li.querySelector(".meta").textContent,
        })));
      `)
    );
    const incompleteRow = historyRows.find((r) => r.text === "recovered words");
    const wholeRow = historyRows.find((r) => r.text === "whole dictation");
    check(
      "an interrupted dictation is marked in History",
      !!incompleteRow && /incomplete/i.test(incompleteRow.meta),
      `meta=${JSON.stringify(incompleteRow?.meta)}`
    );
    check(
      "a complete dictation carries no such mark",
      !!wholeRow && !/incomplete/i.test(wholeRow.meta),
      `meta=${JSON.stringify(wholeRow?.meta)}`
    );

    // 9 (cont.). A Clear history whose delete fails (#287) says so and keeps the
    // rows, through the real handler and history module: only the unlink is
    // made to fail, as a file locked by an antivirus scan would.
    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = (file, ...rest) => {
      if (String(file).endsWith("history.json")) {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return realUnlink(file, ...rest);
    };
    let failedClear;
    try {
      await js(`window.confirm = () => true; document.getElementById("history-clear").click(); true`);
      failedClear = await waitFor(
        () => js(`(() => {
          const status = document.getElementById("history-clear-status");
          return !status.hidden && JSON.stringify({
            status: status.textContent,
            rows: document.querySelectorAll("#history-list li").length,
          });
        })()`),
        "a failed Clear history never said so"
      ).then(JSON.parse);
    } finally {
      fs.unlinkSync = realUnlink;
    }
    check(
      "a Clear history that can't delete the file says so and keeps the transcripts",
      /still on this computer/.test(failedClear.status) && /\(EPERM\)/.test(failedClear.status) &&
        /settings folder/.test(failedClear.status) && !/history\.json/.test(failedClear.status) &&
        failedClear.rows === historyRows.length && history.list().length === historyRows.length,
      JSON.stringify(failedClear)
    );

    // 9 (cont.). Transcript text is text: the markup-looking entry made no
    // element and ran nothing.
    const htmlRow = JSON.parse(await js(`JSON.stringify({
      text: [...document.querySelectorAll("#history-list .text")].map((el) => el.textContent),
      elements: document.querySelectorAll("#history-list img, #history-list b").length,
      ran: window.__historyXss === 1,
    })`));
    check(
      "a transcript that looks like HTML is shown as its literal words",
      htmlRow.text.includes(HTML_TEXT) && htmlRow.elements === 0 && !htmlRow.ran,
      JSON.stringify(htmlRow)
    );

    // 9 (cont.). Search, through the real handler and history module.
    const historyView = () => js(`JSON.stringify({
      value: document.getElementById("history-search").value,
      rows: [...document.querySelectorAll("#history-list li")].map((li) => (li.querySelector(".text") || li).textContent),
      elements: document.querySelectorAll("#history-list b, #history-list img").length,
      pager: !document.getElementById("history-pager").hidden,
    })`).then(JSON.parse);
    const searchFor = (query) => js(`(() => {
      const field = document.getElementById("history-search");
      field.value = ${JSON.stringify(query)};
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const showing = async (want, message) => {
      let last;
      await waitFor(async () => {
        last = await historyView();
        return JSON.stringify(last.rows) === JSON.stringify(want);
      }, message);
      return last;
    };
    await searchFor("éCOLE οδοσ");
    const found = await showing(["École ΟΔΟΣ notes"], "a Unicode, any-case search never narrowed the list");
    check("a search in another case, outside ASCII, finds the entry", !found.pager, JSON.stringify(found));
    const NO_MATCH = "<b>no such words</b>";
    await searchFor(NO_MATCH);
    const none = await showing([`No transcriptions match “${NO_MATCH}”.`], "a search with no match never said so");
    check("a search with no match says so, with the query as text", none.elements === 0 && !none.pager, JSON.stringify(none));

    // An older query's answer that arrives last must not replace a newer one's.
    const realSearch = invokeHandlers.get("history:search");
    let releaseSlow;
    const slowHeld = new Promise((resolve) => (releaseSlow = resolve));
    ipcMain.removeHandler("history:search");
    registerHandler("history:search", async (event, request) => {
      const answer = await realSearch(event, request);
      if (request?.query === "whole") await slowHeld;
      return answer;
    });
    let stale;
    try {
      await searchFor("whole");
      await sleep(300); // past the debounce: the "whole" request is in flight
      await searchFor("recovered");
      await showing(["recovered words"], "the newer search never drew");
      releaseSlow();
      await sleep(300);
      stale = await historyView();
    } finally {
      releaseSlow();
      ipcMain.removeHandler("history:search");
      registerHandler("history:search", realSearch);
    }
    check(
      "a slow answer for an older search never replaces the newer one",
      stale.value === "recovered" && JSON.stringify(stale.rows) === JSON.stringify(["recovered words"]),
      JSON.stringify(stale)
    );
    await searchFor("");
    await showing(["École ΟΔΟΣ notes", HTML_TEXT, "recovered words", "whole dictation"], "clearing the search never listed everything");

    // 9 (cont.). Delete one entry: gone from the list and the file, the rest kept.
    const deleteRow = (text) => js(`(() => {
      window.confirm = () => true;
      const li = [...document.querySelectorAll("#history-list li")].find((row) => row.querySelector(".text")?.textContent === ${JSON.stringify(text)});
      li.querySelector("button.delete").click();
      return true;
    })()`);
    await deleteRow(HTML_TEXT);
    const afterDelete = await showing(["École ΟΔΟΣ notes", "recovered words", "whole dictation"], "a deleted entry stayed in the list");
    await sleep(50);
    const onDisk = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "history.json"), "utf8")).map((e) => e.text);
    check(
      "Delete removes one entry, on disk too, and keeps its neighbours",
      JSON.stringify(onDisk) === JSON.stringify(afterDelete.rows),
      JSON.stringify({ onDisk, rows: afterDelete.rows })
    );

    // A delete that can't replace the file says so on the card and keeps it.
    const realRename = fs.renameSync;
    fs.renameSync = (from, to, ...rest) => {
      if (String(to).endsWith("history.json")) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return realRename(from, to, ...rest);
    };
    let failedDelete;
    try {
      await deleteRow("recovered words");
      failedDelete = await waitFor(
        () => js(`(() => {
          const li = [...document.querySelectorAll("#history-list li")].find((row) => row.querySelector(".text")?.textContent === "recovered words");
          const status = li?.querySelector(".status.err")?.textContent;
          return status && JSON.stringify({ status, rows: document.querySelectorAll("#history-list li").length, enabled: !li.querySelector("button.delete").disabled });
        })()`),
        "a failed Delete never said so"
      ).then(JSON.parse);
    } finally {
      fs.renameSync = realRename;
    }
    check(
      "a Delete that can't write the file says so and keeps the entry",
      /Couldn't delete this transcription/.test(failedDelete.status) && /\(EBUSY\)/.test(failedDelete.status) &&
        !/history\.json/.test(failedDelete.status) && failedDelete.rows === 3 && failedDelete.enabled &&
        history.list().some((e) => e.text === "recovered words"),
      JSON.stringify(failedDelete)
    );

    // 9 (cont.). Filtered pagination: the pager pages through the matches, and
    // deleting the only match on the last page lands on the page before it.
    for (let i = 1; i <= 7; i++) history.add({ raw: `pager item ${i}`, text: `pager item ${i}`, cleaned: false }, historyCfg);
    const pagerView = () => js(`JSON.stringify({
      rows: [...document.querySelectorAll("#history-list li .text")].map((el) => el.textContent),
      range: document.getElementById("history-range").textContent,
      shown: !document.getElementById("history-pager").hidden,
      newer: !document.getElementById("history-newer").disabled,
      older: !document.getElementById("history-older").disabled,
    })`).then(JSON.parse);
    const pagerShows = async (want, message) => {
      let last;
      await waitFor(async () => {
        last = await pagerView();
        return JSON.stringify(last.rows) === JSON.stringify(want);
      }, message);
      return last;
    };
    await searchFor("PAGER item");
    const firstPage = await pagerShows(
      ["pager item 7", "pager item 6", "pager item 5", "pager item 4", "pager item 3"],
      "a search never showed the first page of its matches"
    );
    await js(`document.getElementById("history-older").click(); true`);
    const lastPage = await pagerShows(["pager item 2", "pager item 1"], "Older never showed the rest of the matches");
    check(
      "the pager pages through the matches only, with their count",
      firstPage.shown && firstPage.range === "1–5 of 7 matching" && !firstPage.newer && firstPage.older &&
        lastPage.shown && lastPage.range === "6–7 of 7 matching" && lastPage.newer && !lastPage.older,
      JSON.stringify({ firstPage, lastPage })
    );
    await deleteRow("pager item 2");
    const oneLeft = await pagerShows(["pager item 1"], "a delete on the last page lost the page");
    await deleteRow("pager item 1");
    const backOne = await pagerShows(
      ["pager item 7", "pager item 6", "pager item 5", "pager item 4", "pager item 3"],
      "deleting the last match on a page left the pager stranded"
    );
    check(
      "deleting the last match on a page shows the page before it",
      oneLeft.range === "6–6 of 6 matching" && !backOne.shown && history.list().filter((e) => /^pager item/.test(e.text)).length === 5,
      JSON.stringify({ oneLeft, backOne })
    );
    await searchFor("");

    // 17. Kept recordings (#343). First the honest status, on this machine's
    // real secure storage: without it (headless Linux: no keyring) the switch
    // can't be turned on and says why; with it, it can.
    const realStatus = await invokeHandlers.get("recordings:status")();
    const card = await waitFor(
      () => js(`(() => {
        const usage = document.getElementById("recordings-usage").textContent;
        return usage && JSON.stringify({
          disabled: document.getElementById("recordings-keep").disabled,
          checked: document.getElementById("recordings-keep").checked,
          reason: document.getElementById("recordings-reason").hidden ? "" : document.getElementById("recordings-reason").textContent,
          usage,
        });
      })()`),
      "the Keep recordings card never showed its status"
    ).then(JSON.parse);
    check(
      "Keep recordings is off by default, and can be turned on only with secure storage",
      !card.checked && card.disabled === !realStatus.secure &&
        (realStatus.secure ? card.reason === "" : /can't be encrypted/.test(card.reason)) &&
        card.usage === "No recordings kept",
      JSON.stringify({ card, secure: realStatus.secure })
    );

    // Then the player, against a store with a stand-in keyring (CI's Linux
    // has none), through the real handlers and History module.
    const recordings = require("../main/recordings");
    const { createAudioStore } = require("../main/audio-store");
    const { encodeWav } = require("../main/util/wav");
    const keyring = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (text) => Buffer.from(`k:${text}`),
      decryptString: (buf) => buf.toString().slice(2),
    };
    const smokeStore = createAudioStore({ dir: () => path.join(app.getPath("userData"), "audio"), safeStorage: () => keyring });
    const realGetStore = recordings.getStore;
    recordings.getStore = () => smokeStore;
    const { dialog } = require("electron");
    const realSaveDialog = dialog.showSaveDialog;
    const exportPath = path.join(app.getPath("userData"), "exported.wav");
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
    try {
      const keptEntry = history.list().find((e) => e.text === "whole dictation");
      const tone = encodeWav(Float32Array.from({ length: 16000 * 3 }, (_, i) => 0.2 * Math.sin(i / 8)));
      smokeStore.save(keptEntry.id, tone, { limits: { maxAgeDays: 30, maxMegabytes: 1024 } });
      // Both entries on one page: the pager items above fill the newest one.
      await searchFor("o");
      const rowWith = (text) => `[...document.querySelectorAll("#history-list li")].find((row) => row.querySelector(".text")?.textContent === ${JSON.stringify(text)})`;
      const buttons = await waitFor(
        () => js(`(() => {
          const li = ${rowWith("whole dictation")};
          const other = ${rowWith("recovered words")};
          return li?.querySelector("button.play") && JSON.stringify({
            kept: [...li.querySelectorAll(".actions button")].map((b) => b.textContent),
            other: [...other.querySelectorAll(".actions button")].map((b) => b.textContent),
          });
        })()`),
        "an entry with a kept recording never offered Play"
      ).then(JSON.parse);
      check(
        "an entry with a kept recording offers Play, Export and Retranscribe; one without doesn't",
        ["Play", "Export…", "Retranscribe"].every((b) => buttons.kept.includes(b)) && !buttons.other.includes("Play"),
        JSON.stringify(buttons)
      );

      await js(`(() => {
        window.__revoked = 0;
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = (url) => { window.__revoked += 1; revoke(url); };
        ${rowWith("whole dictation")}.querySelector("button.play").click();
        return true;
      })()`);
      const loaded = await waitFor(
        () => js(`(() => {
          const a = document.querySelector("#history-list audio.player");
          return a && a.readyState >= 1 && Number.isFinite(a.duration) && JSON.stringify({ duration: a.duration, src: a.src.slice(0, 5), controls: a.controls });
        })()`),
        "the kept recording never loaded in the player"
      ).then(JSON.parse);
      const seeked = await js(`new Promise((resolve) => {
        const a = document.querySelector("#history-list audio.player");
        a.pause();
        a.addEventListener("seeked", () => resolve(a.currentTime), { once: true });
        a.currentTime = 2;
        setTimeout(() => resolve(a.currentTime), 3000);
      })`);
      check(
        "Play loads the recording from a blob with seekable controls",
        Math.abs(loaded.duration - 3) < 0.1 && loaded.src === "blob:" && loaded.controls && Math.abs(seeked - 2) < 0.1,
        JSON.stringify({ loaded, seeked })
      );

      await js(`${rowWith("whole dictation")}.querySelector("button.export").click(); true`);
      await waitFor(() => fs.existsSync(exportPath), "Export never wrote the file");
      await sleep(50);
      check("Export saves the original WAV where the user chose", fs.readFileSync(exportPath).equals(tone));

      // Expired while it plays (a tighter limit saved in Settings): the
      // player stops and lets go of its audio, the recording buttons go, and
      // the transcript stays — the same redraw main sends after a prune.
      await js(`document.querySelector("#history-list audio.player").play().catch(() => {}); true`);
      const keptFile = path.join(app.getPath("userData"), "audio", `${keptEntry.id}.wav.enc`);
      const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      fs.utimesSync(keptFile, longAgo, longAgo);
      const expired = smokeStore.prune({ maxAgeDays: 30, maxMegabytes: 1024 });
      win.webContents.send("history:changed", { updated: true });
      const afterExpiry = await waitFor(
        () => js(`(() => {
          const li = ${rowWith("whole dictation")};
          return li && !li.querySelector("button.play") && JSON.stringify({
            players: document.querySelectorAll("audio").length,
            revoked: window.__revoked,
            buttons: [...li.querySelectorAll(".actions button")].map((b) => b.textContent),
          });
        })()`),
        "an expired recording kept its Play button"
      ).then(JSON.parse);
      check(
        "a recording that expires while playing stops the player and releases it; the transcript stays",
        expired.includes(keptEntry.id) && afterExpiry.players === 0 && afterExpiry.revoked === 1 &&
          !afterExpiry.buttons.includes("Export…") && afterExpiry.buttons.includes("Copy") && !fs.existsSync(keptFile),
        JSON.stringify({ expired, afterExpiry })
      );
      // Kept again, and playing, for the delete check below.
      smokeStore.save(keptEntry.id, tone, { limits: { maxAgeDays: 30, maxMegabytes: 1024 } });
      win.webContents.send("history:changed", { updated: true });
      await waitFor(() => js(`!!${rowWith("whole dictation")}?.querySelector("button.play")`), "the kept-again recording never offered Play");
      await js(`${rowWith("whole dictation")}.querySelector("button.play").click(); true`);
      await waitFor(() => js(`(document.querySelector("#history-list audio.player")?.readyState ?? 0) >= 1`), "the kept-again recording never loaded");

      // Deleted while it plays: the player stops and lets go of its audio,
      // and the recording is gone from disk with its entry.
      await js(`(() => {
        const a = document.querySelector("#history-list audio.player");
        a.play().catch(() => {});
        window.confirm = () => true;
        ${rowWith("whole dictation")}.querySelector("button.delete").click();
        return true;
      })()`);
      const released = await waitFor(
        () => js(`(() => {
          const gone = !${rowWith("whole dictation")};
          return gone && JSON.stringify({
            players: document.querySelectorAll("audio").length,
            revoked: window.__revoked,
            errors: [...document.querySelectorAll("#history-list .status.err")].map((el) => el.textContent).filter(Boolean),
          });
        })()`),
        "deleting the playing entry never removed it"
      ).then(JSON.parse);
      check(
        "deleting the entry being played stops the player, releases its audio, and deletes the recording",
        released.players === 0 && released.revoked === 2 && released.errors.length === 0 &&
          !fs.existsSync(path.join(app.getPath("userData"), "audio", `${keptEntry.id}.wav.enc`)),
        JSON.stringify(released)
      );

      // Retranscribe, through the real button, on the second page: the
      // result shows under the original — which stays — with its own Copy,
      // and the page stays put. The pipeline is stood in for (it would need
      // an engine): it answers the way pipeline.retranscribe does.
      const olderEntry = history.list().find((e) => e.text === "recovered words");
      smokeStore.save(olderEntry.id, tone, { limits: { maxAgeDays: 30, maxMegabytes: 1024 } });
      await searchFor("");
      await waitFor(() => js(`!document.getElementById("history-older").disabled`), "History never offered an older page");
      await js(`document.getElementById("history-older").click(); true`);
      await waitFor(() => js(`!!${rowWith("recovered words")}?.querySelector("button.retranscribe")`), "the older page never offered Retranscribe");
      const realRetranscribe = invokeHandlers.get("history:retranscribe");
      let finishRetry;
      const retryHeld = new Promise((resolve) => (finishRetry = resolve));
      let answer = "store";
      ipcMain.removeHandler("history:retranscribe");
      registerHandler("history:retranscribe", async (event, id) => {
        if (answer === "busy") return { ok: false, error: "busy" };
        await retryHeld;
        const retry = { seq: Date.now(), at: new Date().toISOString(), status: "done", raw: "retried words", text: "Retried words.", cleaned: true };
        history.setRetry(id, retry);
        win.webContents.send("history:changed", { updated: true });
        return { ok: true, stored: true, retry };
      });
      try {
        const pageBefore = await js(`document.getElementById("history-range").textContent`);
        await js(`${rowWith("recovered words")}.querySelector("button.retranscribe").click(); true`);
        const running = await waitFor(
          () => js(`(() => {
            const b = ${rowWith("recovered words")}.querySelector("button.retranscribe");
            return b.disabled && b.textContent;
          })()`),
          "Retranscribe never showed it was running"
        );
        finishRetry();
        const shown = await waitFor(
          () => js(`(() => {
            const li = ${rowWith("recovered words")};
            return li?.querySelector(".retry-text") && JSON.stringify({
              original: li.querySelector(".text").textContent,
              retry: li.querySelector(".retry-text").textContent,
              head: li.querySelector(".retry-head").textContent,
              copy: !!li.querySelector("button.retry-copy"),
              range: document.getElementById("history-range").textContent,
            });
          })()`),
          "the retranscription never showed under its entry"
        ).then(JSON.parse);
        check(
          "Retranscribe shows its result under the original, with its own Copy, and keeps the page",
          running === "Retranscribing…" && shown.original === "recovered words" && shown.retry === "Retried words." &&
            /^Retranscribed .* · cleaned$/.test(shown.head) && shown.copy && shown.range === pageBefore && /^6–/.test(pageBefore),
          JSON.stringify({ running, shown, pageBefore })
        );
        answer = "busy";
        await js(`${rowWith("recovered words")}.querySelector("button.retranscribe").click(); true`);
        const refused = await waitFor(
          () => js(`(() => {
            const li = ${rowWith("recovered words")};
            const msg = li.querySelector(".status.err").textContent;
            const b = li.querySelector("button.retranscribe");
            return msg && JSON.stringify({ msg, enabled: !b.disabled, label: b.textContent });
          })()`),
          "a refused retranscription never said why"
        ).then(JSON.parse);
        check(
          "a refused retranscription says why and gives the button back",
          /Another retranscription is still running/.test(refused.msg) && refused.enabled && refused.label === "Retranscribe",
          JSON.stringify(refused)
        );
      } finally {
        finishRetry();
        ipcMain.removeHandler("history:retranscribe");
        registerHandler("history:retranscribe", realRetranscribe);
      }

      // Copy retranscription copies the retranscription, not the original.
      const realCopy = invokeHandlers.get("transcript:copy");
      const copied = [];
      ipcMain.removeHandler("transcript:copy");
      registerHandler("transcript:copy", async (event, text) => {
        copied.push(text);
        return { ok: true };
      });
      try {
        await js(`${rowWith("recovered words")}.querySelector("button.retry-copy").click(); true`);
        await waitFor(() => copied.length > 0, "Copy retranscription never copied");
      } finally {
        ipcMain.removeHandler("transcript:copy");
        registerHandler("transcript:copy", realCopy);
      }
      check(
        "Copy retranscription copies the retranscribed text, not the original",
        JSON.stringify(copied) === JSON.stringify(["Retried words."]),
        JSON.stringify(copied)
      );

      // A failed and a cancelled retranscription each say what happened, and
      // offer no text to copy.
      const outcome = async (retry, message) => {
        history.setRetry(olderEntry.id, { seq: Date.now() + Math.random(), at: new Date().toISOString(), ...retry });
        win.webContents.send("history:changed", { updated: true });
        return waitFor(
          () => js(`(() => {
            const li = ${rowWith("recovered words")};
            const head = li?.querySelector(".retry-head")?.textContent || "";
            return head.includes(${JSON.stringify(retry.status === "failed" ? "failed" : "cancelled")}) && JSON.stringify({
              head, text: !!li.querySelector(".retry-text"), copy: !!li.querySelector("button.retry-copy"),
              original: li.querySelector(".text").textContent,
            });
          })()`),
          message
        ).then(JSON.parse);
      };
      const failedView = await outcome({ status: "failed", error: "service down" }, "a failed retranscription never said so");
      const cancelledView = await outcome({ status: "cancelled" }, "a cancelled retranscription never said so");
      check(
        "failed and cancelled retranscriptions say what happened, keep the original, and offer nothing to copy",
        /failed: service down$/.test(failedView.head) && /cancelled by a new dictation/.test(cancelledView.head) &&
          !failedView.text && !failedView.copy && !cancelledView.text && !cancelledView.copy &&
          failedView.original === "recovered words" && cancelledView.original === "recovered words",
        JSON.stringify({ failedView, cancelledView })
      );

      // Two Plays in a row, the first one's recording arriving last: only
      // the second plays, and the late one never becomes a stray player.
      const ecoleEntry = history.list().find((e) => e.text === "École ΟΔΟΣ notes");
      smokeStore.save(ecoleEntry.id, tone, { limits: { maxAgeDays: 30, maxMegabytes: 1024 } });
      win.webContents.send("history:changed", { updated: true });
      await waitFor(() => js(`!!${rowWith("École ΟΔΟΣ notes")}?.querySelector("button.play")`), "the second kept recording never offered Play");
      const realAudioGet = invokeHandlers.get("history:audio-get");
      let releaseFirst;
      const firstHeld = new Promise((resolve) => (releaseFirst = resolve));
      ipcMain.removeHandler("history:audio-get");
      registerHandler("history:audio-get", async (event, id) => {
        const answer = await realAudioGet(event, id);
        if (id === olderEntry.id) await firstHeld;
        return answer;
      });
      let overlap;
      try {
        await js(`${rowWith("recovered words")}.querySelector("button.play").click(); true`);
        await sleep(100);
        await js(`${rowWith("École ΟΔΟΣ notes")}.querySelector("button.play").click(); true`);
        await waitFor(() => js(`!!${rowWith("École ΟΔΟΣ notes")}.querySelector("audio.player")`), "the second Play never loaded");
        releaseFirst();
        await sleep(300);
        overlap = await js(`JSON.stringify({
          players: document.querySelectorAll("audio").length,
          inSecond: !!${rowWith("École ΟΔΟΣ notes")}.querySelector("audio.player"),
          inFirst: !!${rowWith("recovered words")}.querySelector("audio.player"),
        })`).then(JSON.parse);
      } finally {
        releaseFirst();
        ipcMain.removeHandler("history:audio-get");
        registerHandler("history:audio-get", realAudioGet);
      }
      check(
        "a Play answered after a newer Play is dropped: one player, in the newer entry",
        overlap.players === 1 && overlap.inSecond && !overlap.inFirst,
        JSON.stringify(overlap)
      );
    } finally {
      recordings.getStore = realGetStore;
      dialog.showSaveDialog = realSaveDialog;
    }
    await searchFor("");

    // 4. Roving tabindex seated before any interaction.
    const tabStops = JSON.parse(
      await js(`
        JSON.stringify([...document.querySelectorAll(".tab")].map((t) => t.tabIndex));
      `)
    );
    check(
      "exactly one index button is a Tab stop at load",
      tabStops.filter((t) => t === 0).length === 1,
      tabStops.join(",")
    );

    // 2. Scroll spy: jump to the bottom (scroll-behavior:smooth governs the
    // scrollTop setter too, so force an instant jump) and fire the listener.
    const spy = JSON.parse(
      await js(`
        (() => {
          const host = document.querySelector("main");
          host.style.scrollBehavior = "auto";
          host.scrollTop = host.scrollHeight;
          host.dispatchEvent(new Event("scroll"));
          host.style.scrollBehavior = "";
          const active = document.querySelector(".tab.active");
          return JSON.stringify({
            tab: active ? active.dataset.tab : null,
            current: active ? active.getAttribute("aria-current") : null,
          });
        })();
      `)
    );
    check("scroll spy lights the last section", spy.tab === "advanced", `active=${spy.tab}`);
    check("active index entry carries aria-current", spy.current === "true");

    // 3. Index navigation: clicking General re-highlights immediately (the
    // highlight and the focus move are synchronous; the glide follows).
    const clicked = JSON.parse(
      await js(`
        (() => {
          document.getElementById("tabbtn-general").click();
          const active = document.querySelector(".tab.active");
          return JSON.stringify({
            tab: active ? active.dataset.tab : null,
            focus: document.activeElement ? document.activeElement.id : null,
          });
        })();
      `)
    );
    check("clicking the index re-highlights its entry", clicked.tab === "general");
    check(
      "clicking the index moves focus into the section's legend",
      clicked.focus === "legend-general",
      `activeElement=${clicked.focus}`
    );

    // The glide is asynchronous; wait for it to settle, then assert the
    // panel came back near the top (threshold, not 0 — scroll-margin leaves
    // a small offset).
    await sleep(1500);
    const top = await js(`document.querySelector("main").scrollTop`);
    check("clicking the index glides the panel back", top < 60, `scrollTop=${top}`);

    // 5. The update card carries the full release notes — the list the
    //    overlay prompt only summarises, and the reason "see Settings" on that
    //    prompt is a promise and not a dead end. Version by version, as text:
    //    the notes are fetched off the network, so they never become markup.
    win.webContents.send("updates:state", {
      status: "available",
      current: "0.24.1",
      latest: "0.26.0",
      progress: null,
      error: null,
      method: "install",
      hint: null,
      notes: [
        { version: "0.26.0", date: "2026-08-10", items: ["Newer thing", "<b>Not markup</b>"] },
        { version: "0.25.0", date: "2026-08-04", items: ["Older thing"] },
      ],
    });
    await sleep(100);
    const notes = JSON.parse(
      await js(`
        (() => {
          const box = document.getElementById("update-notes");
          return JSON.stringify({
            hidden: box.hidden,
            heads: [...box.querySelectorAll(".notes-head")].map((h) => h.textContent),
            items: [...box.querySelectorAll("ul.notes li")].map((li) => li.textContent),
            markup: box.innerHTML.includes("<b>"),
          });
        })()
      `)
    );
    check(
      "the update card lists every version's changes",
      notes.hidden === false &&
        notes.heads.length === 2 &&
        notes.heads[0] === "v0.26.0 — 2026-08-10" &&
        notes.items.length === 3,
      `heads=${JSON.stringify(notes.heads)} items=${JSON.stringify(notes.items)}`
    );
    check("release notes render as text, never markup", notes.markup === false);

    // Up to date again: the list goes with the update it described.
    win.webContents.send("updates:state", {
      status: "idle",
      current: "0.24.1",
      latest: null,
      progress: null,
      error: null,
      method: "install",
      hint: null,
      notes: [],
    });
    await sleep(100);
    const cleared = await js(`document.getElementById("update-notes").hidden`);
    check("the notes clear when the update does", cleared === true, `hidden=${cleared}`);

    // 6. The engine badge tracks the engine choice. Built-in vs
    //    OpenAI-compatible decides whether audio/words ever leave the machine,
    //    so the pill naming that consequence has to follow the radio in both
    //    directions — and it has to sit in a live region that stays put while
    //    the two states swap, or a screen reader hears the radio label and
    //    nothing about where the data goes.
    for (const kind of ["stt", "cleanup"]) {
      const badge = JSON.parse(
        await js(`
          (() => {
            const read = () => ({
              builtin: !document.getElementById("${kind}-engine-state-builtin").hidden,
              external: !document.getElementById("${kind}-engine-state-external").hidden,
            });
            const pick = (value) => {
              const radio = document.querySelector(
                'input[name="${kind}-engine"][value=' + JSON.stringify(value) + ']'
              );
              radio.checked = true;
              radio.dispatchEvent(new Event("change", { bubbles: true }));
              return read();
            };
            const slot = document
              .getElementById("${kind}-engine-state-builtin")
              .closest("[aria-live]");
            return JSON.stringify({
              external: pick("external"),
              builtin: pick("builtin"),
              live: slot ? slot.getAttribute("aria-live") : null,
            });
          })()
        `)
      );
      check(
        `the ${kind} engine badge follows the engine choice`,
        badge.external.external &&
          !badge.external.builtin &&
          badge.builtin.builtin &&
          !badge.builtin.external,
        `external=${JSON.stringify(badge.external)} builtin=${JSON.stringify(badge.builtin)}`
      );
      check(
        `the ${kind} engine badge swaps inside a live region`,
        badge.live === "polite",
        `aria-live=${badge.live}`
      );
    }

    // 7. Both custom-model sections offer a way to find a compatible repo
    //    without leaving the flow: an enabled "Browse Hugging Face" pill in
    //    the same action row as "Find versions".
    const browse = JSON.parse(
      await js(`
        JSON.stringify(["stt", "cleanup"].map((kind) => {
          const btn = document.getElementById(kind + "-hf-browse");
          const find = document.getElementById(kind + "-hf-find");
          return {
            kind,
            present: !!btn,
            enabled: !!btn && !btn.disabled,
            label: btn ? btn.textContent.trim() : null,
            sameRow: !!btn && !!find && btn.parentElement === find.parentElement,
          };
        }))
      `)
    );
    for (const b of browse) {
      check(
        `the ${b.kind} section offers a Browse Hugging Face button`,
        b.present && b.enabled && b.label === "Browse Hugging Face" && b.sameRow,
        JSON.stringify(b)
      );
    }

    // 13. An unsupported speech model family is refused where the user pasted
    //     it. The bridge is frozen by contextBridge, so Hugging Face is stubbed
    //     at the main process's fetch, which the IPC handler calls.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const body = String(url).includes("/tree/")
        ? ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"].map((p) => ({ type: "file", path: p, size: 1 }))
        : { sha: "c" };
      return { ok: true, status: 200, async json() { return body; } };
    };
    let refused;
    try {
      await js(`
        document.getElementById("stt-hf-url").value =
          "csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8";
        document.getElementById("stt-hf-find").click();
      `);
      refused = JSON.parse(
        await waitFor(
          () =>
            js(`(() => {
              const status = document.getElementById("stt-hf-result");
              if (document.getElementById("stt-hf-find").disabled) return "";
              if (status.className === "status") return "";
              return JSON.stringify({
                text: status.textContent,
                className: status.className,
                pickHidden: document.getElementById("stt-hf-pick").hidden,
              });
            })()`),
          "the Find versions lookup never settled"
        )
      );
    } finally {
      globalThis.fetch = realFetch;
      await js(`document.getElementById("stt-hf-url").value = ""`);
    }
    check(
      "Find versions refuses a Canary repo with a readable error and no version to add",
      /NeMo Canary model, which Earheart can't run/.test(refused.text) &&
        refused.className === "status err" &&
        refused.pickHidden,
      JSON.stringify(refused)
    );

    // 10-11. Drive the real renderer state machine while the IPC download
    // promise is held open, so no model files or network are involved.
    const downloadModels = await js(`JSON.stringify({
      stt: [...document.getElementById("stt-builtin-model").options].map((o) => o.value),
      cleanup: [...document.getElementById("cleanup-builtin-model").options].map((o) => o.value),
    })`).then(JSON.parse);
    const sttDefault = registry.DEFAULT_STT_MODEL;
    const sttModel = downloadModels.stt.find((id) => id !== sttDefault);
    const cleanupModel = downloadModels.cleanup.find((id) => id !== registry.DEFAULT_CLEANUP_MODEL);
    const startModelDownload = async (kind, modelId) => js(`(() => {
      const select = document.getElementById(${JSON.stringify(`${kind}-builtin-model`)});
      select.value = ${JSON.stringify(modelId)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      const button = document.querySelector("#" + ${JSON.stringify(`${kind}-model-manage`)} + " button");
      button.focus();
      button.click();
      return document.activeElement?.textContent;
    })()`);
    await startModelDownload("stt", sttModel);
    const sttDownload = await waitFor(
      () => downloads.get(`stt:${sttModel}`),
      "Settings download did not reach the engine"
    );
    const sttFocus = await js(`JSON.stringify({
      text: document.activeElement?.textContent,
      label: document.activeElement?.getAttribute("aria-label"),
      rowButton: document.querySelector("#stt-model-manage button")?.textContent,
    })`).then(JSON.parse);
    check(
      "starting a download keeps keyboard focus on its cancel action",
      sttFocus.text === "Cancel" && sttFocus.rowButton === "Cancel",
      JSON.stringify(sttFocus)
    );

    sttDownload.onProgress({
      fraction: 0.42, received: 42, total: 100,
    });
    const switchedProgress = await js(`(() => {
      const select = document.getElementById("stt-builtin-model");
      select.value = ${JSON.stringify(sttDefault)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      select.value = ${JSON.stringify(sttModel)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        width: document.querySelector("#stt-model-manage .dl-fill")?.style.width,
        status: document.querySelector("#stt-model-manage .status")?.textContent,
        button: document.querySelector("#stt-model-manage button")?.textContent,
      };
    })()`).then((s) => (typeof s === "string" ? JSON.parse(s) : s));
    check(
      "progress from an external download survives switching model selections",
      switchedProgress.width === "42%" &&
        switchedProgress.status.startsWith("42%") &&
        switchedProgress.button === "Cancel",
      JSON.stringify(switchedProgress)
    );

    const wizard = windows.openWizard();
    await waitForLoad(wizard.webContents);
    await checkWindowLock(wizard, {
      role: "wizard",
      refused: { method: "invoke", channel: "history:delete" },
      allowed: { method: "invoke", channel: "models:status" },
      check,
    });
    await wizard.webContents.executeJavaScript(
      `earheart.invoke("models:download", { kind: "cleanup", modelId: ${JSON.stringify(cleanupModel)} }); "started"`,
      true
    );
    const wizardDownload = await waitFor(
      () => downloads.get(`cleanup:${cleanupModel}`),
      "wizard download did not reach the engine"
    );
    const duplicateAction = await startModelDownload("cleanup", cleanupModel);
    await sleep(50);
    const duplicateState = await js(`JSON.stringify({
      button: document.querySelector("#cleanup-model-manage button")?.textContent,
      status: document.querySelector("#cleanup-model-manage .status")?.textContent,
    })`).then(JSON.parse);
    check(
      "Settings keeps a wizard-owned download active after Already downloading",
      duplicateAction === "Cancel" &&
        duplicateState.button === "Cancel" &&
        duplicateState.status === "Downloading…",
      JSON.stringify({ duplicateAction, ...duplicateState })
    );
    wizardDownload.onProgress({
      fraction: 0.73, received: 73, total: 100,
    });
    downloads.get(`stt:${sttModel}`).onProgress({
      fraction: 0.58, received: 58, total: 100,
    });
    const wizardProgress = await js(`(() => {
      const select = document.getElementById("cleanup-builtin-model");
      select.value = ${JSON.stringify(cleanupModel)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        width: document.querySelector("#cleanup-model-manage .dl-fill")?.style.width,
        status: document.querySelector("#cleanup-model-manage .status")?.textContent,
      };
    })()`).then((s) => (typeof s === "string" ? JSON.parse(s) : s));
    check(
      "wizard-started progress survives Settings model changes",
      wizardProgress.width === "73%" && wizardProgress.status.startsWith("73%"),
      JSON.stringify(wizardProgress)
    );
    const concurrentProgress = await js(`JSON.stringify({
      stt: document.querySelector("#stt-model-manage .status")?.textContent,
      cleanup: document.querySelector("#cleanup-model-manage .status")?.textContent,
      sttWidth: document.querySelector("#stt-model-manage .dl-fill")?.style.width,
      cleanupWidth: document.querySelector("#cleanup-model-manage .dl-fill")?.style.width,
    })`).then(JSON.parse);
    check(
      "concurrent model progress remains isolated by kind and model",
      concurrentProgress.stt.startsWith("58%") &&
        concurrentProgress.cleanup.startsWith("73%") &&
        concurrentProgress.sttWidth === "58%" && concurrentProgress.cleanupWidth === "73%",
      JSON.stringify(concurrentProgress)
    );

    sttDownload.resolve();
    wizardDownload.resolve();
    await sleep(250);
    windows.closeWizard();
    const completionAnnouncement = await js(`JSON.stringify({
      text: document.getElementById("model-dl-announce").textContent,
      live: document.getElementById("model-dl-announce").getAttribute("aria-live"),
    })`).then(JSON.parse);
    check(
      "successful downloads announce completion in the persistent live region",
      completionAnnouncement.live === "polite" && /Downloaded/.test(completionAnnouncement.text),
      JSON.stringify(completionAnnouncement)
    );

    const failedModel = downloadModels.stt.find(
      (id) => id !== sttDefault && id !== sttModel
    );
    await startModelDownload("stt", failedModel);
    const failedDownload = await waitFor(
      () => downloads.get(`stt:${failedModel}`),
      "failed download did not reach the engine"
    );
    failedDownload.reject(new Error("offline"));
    await sleep(150);
    const failedState = await js(`JSON.stringify({
      button: document.querySelector("#stt-model-manage button")?.textContent,
      status: document.querySelector("#stt-model-manage .status")?.textContent,
      announcement: document.getElementById("model-dl-announce").textContent,
    })`).then(JSON.parse);
    check(
      "failed downloads retain an error and retry action",
      failedState.button === "Retry download" &&
        failedState.status === "offline" &&
        failedState.announcement.endsWith("offline"),
      JSON.stringify(failedState)
    );
    const cancelModel = downloadModels.stt.find(
      (id) => id !== sttDefault && id !== sttModel && id !== failedModel
    );
    await startModelDownload("stt", cancelModel);
    const cancelButton = await waitFor(
      () => js(`document.querySelector("#stt-model-manage button")?.textContent === "Cancel"`),
      "cancel action did not render"
    );
    if (cancelButton !== true) throw new Error("cancel action was not available");
    await js(`document.querySelector("#stt-model-manage button").click()`);
    await sleep(150);
    const cancelledState = await js(`JSON.stringify({
      button: document.querySelector("#stt-model-manage button")?.textContent,
      status: document.querySelector("#stt-model-manage .status")?.textContent,
      announcement: document.getElementById("model-dl-announce").textContent,
    })`).then(JSON.parse);
    check(
      "cancelling a download restores its retryable state and announcement",
      cancelledState.button === "Download" &&
        cancelledState.status === "Cancelled" &&
        cancelledState.announcement.endsWith("Cancelled"),
      JSON.stringify(cancelledState)
    );

    engines.remove = async () => {
      throw new Error("model files are busy");
    };
    await js(`window.confirm = () => true; true`);
    await js(`(() => {
      const select = document.getElementById("stt-builtin-model");
      select.value = ${JSON.stringify(sttModel)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(
      () => js(`document.querySelector("#stt-model-manage button")?.textContent === "Remove"`),
      "installed model did not expose Remove"
    );
    await js(`document.querySelector("#stt-model-manage button").click()`);
    const removalFailure = await waitFor(
      () => js(`document.querySelector("#stt-model-manage .status")?.textContent === "model files are busy"`),
      "failed model removal did not appear in the row"
    );
    const removalAnnouncement = await js(`JSON.stringify({
      text: document.getElementById("model-dl-announce").textContent,
      live: document.getElementById("model-dl-announce").getAttribute("aria-live"),
    })`).then(JSON.parse);
    check(
      "failed model removals appear in the persistent live region",
      removalFailure === true &&
        removalAnnouncement.live === "polite" &&
        removalAnnouncement.text.endsWith("model files are busy"),
      JSON.stringify(removalAnnouncement)
    );

    await js(`(() => {
      const select = document.getElementById("cleanup-builtin-model");
      select.value = ${JSON.stringify(registry.DEFAULT_CLEANUP_MODEL)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);

    // 13. Settings saved by main while the window is open reach the form.
    const unsaved = "An edit the user has not saved yet";
    await js(`document.getElementById("cleanup-prompt").value = ${JSON.stringify(unsaved)}; true`);
    const before = settings.get();
    settings.save({
      ...before,
      output: { ...before.output, mode: "clipboard" },
      updates: { ...before.updates, remind: false },
    });
    const reflected = await waitFor(
      () =>
        js(`(() => {
          const mode = document.querySelector('input[name="output-mode"]:checked')?.value;
          const remind = document.getElementById("updates-remind").checked;
          return mode === "clipboard" && !remind
            ? JSON.stringify({
                mode,
                remind,
                prompt: document.getElementById("cleanup-prompt").value,
                status: document.getElementById("save-status").textContent,
                // What the next Save would send (collect() + baseline).
                sends: { mode: collect().output.mode, remind: collect().updates.remind, baseline },
              })
            : "";
        })()`),
      "the open form did not show the main-side change"
    ).then(JSON.parse);
    check(
      "a main-side save shows in the open form and keeps unsaved edits",
      reflected.mode === "clipboard" && reflected.remind === false && reflected.prompt === unsaved,
      JSON.stringify(reflected)
    );
    check(
      "the form says why its controls changed",
      /Output mode changed from the tray menu/.test(reflected.status) &&
        /Update reminders turned off/.test(reflected.status),
      JSON.stringify(reflected.status)
    );
    check(
      "the form's next save carries the main-side change and its baseline",
      reflected.sends.mode === "clipboard" &&
        reflected.sends.remind === false &&
        reflected.sends.baseline.outputMode === "clipboard" &&
        reflected.sends.baseline.remind === false,
      JSON.stringify(reflected.sends)
    );

    // 8. A fresh profile preselects the default cleanup model in both windows.
    const cleanupDefault = registry.getModel("cleanup", registry.DEFAULT_CLEANUP_MODEL);
    const readCleanupPick = (wc) =>
      wc.executeJavaScript(
        `JSON.stringify({
          value: document.getElementById("cleanup-builtin-model").value,
          first: document.getElementById("cleanup-builtin-model").options[0]?.value,
        })`,
        true
      ).then(JSON.parse);
    const settingsPick = await readCleanupPick(win.webContents);
    // The premise of the preselect checks: were the default the first catalog
    // entry, a lost `select.value = …` would pass them silently.
    check(
      "the default cleanup model is not the first option (check 8's premise)",
      settingsPick.first !== cleanupDefault.id,
      JSON.stringify(settingsPick)
    );
    check(
      "Settings preselects the default cleanup model on a fresh profile",
      settingsPick.value === cleanupDefault.id,
      JSON.stringify(settingsPick)
    );
    const wizardForDefaults = windows.openWizard();
    await waitForLoad(wizardForDefaults.webContents);
    await sleep(1200);
    const wizardPick = await readCleanupPick(wizardForDefaults.webContents);
    const wizardNote = await wizardForDefaults.webContents.executeJavaScript(
      `document.getElementById("cleanup-builtin-note").textContent`,
      true
    );
    // 14. A main-side save while the wizard is open reaches its output step.
    const beforeWizard = settings.get();
    settings.save({ ...beforeWizard, output: { ...beforeWizard.output, mode: "paste-copy" } });
    const wizardReflected = await waitFor(
      () =>
        wizardForDefaults.webContents.executeJavaScript(
          `(() => {
            const mode = document.querySelector('input[name="output-mode"]:checked')?.value;
            return mode === "paste-copy"
              ? JSON.stringify({
                  mode,
                  sends: collect().output.mode,
                  baseline,
                  announced: document.getElementById("sync-announce").textContent,
                })
              : "";
          })()`,
          true
        ),
      "the open wizard did not show the main-side change"
    ).then(JSON.parse);
    windows.closeWizard();
    check(
      "a main-side save shows in the open wizard and moves its baseline",
      wizardReflected.mode === "paste-copy" &&
        wizardReflected.sends === "paste-copy" &&
        wizardReflected.baseline.outputMode === "paste-copy" &&
        /Output mode changed/.test(wizardReflected.announced),
      JSON.stringify(wizardReflected)
    );
    check(
      "the wizard preselects the default cleanup model on a fresh profile",
      wizardPick.value === cleanupDefault.id,
      JSON.stringify(wizardPick)
    );
    check(
      "the default cleanup model is not the wizard's first option (check 8's premise)",
      wizardPick.first !== cleanupDefault.id,
      JSON.stringify(wizardPick)
    );
    check(
      "the wizard shows the default cleanup model's note",
      wizardNote === cleanupDefault.note,
      JSON.stringify(wizardNote)
    );

    // Save downloads a selected built-in model that is missing before it
    // persists (check 16). The Saves from here on test other fields, so the
    // models they select — the form's, and the defaults a custom-model removal
    // falls back to — count as downloaded.
    const selectedModels = JSON.parse(await js(`JSON.stringify([
      "stt:" + document.getElementById("stt-builtin-model").value,
      "cleanup:" + document.getElementById("cleanup-builtin-model").value,
    ])`));
    for (const key of [...selectedModels, `stt:${registry.DEFAULT_STT_MODEL}`, `cleanup:${registry.DEFAULT_CLEANUP_MODEL}`]) {
      installedModels.add(key);
    }

    // 13. The Performance limits clamp on the real Save: out-of-range entries
    // reach disk as the field's own min/max, not as typed (#210), and Save
    // says so. Last, since it saves the whole form.
    await js(`(() => {
      document.getElementById("max-seconds").value = "-5";
      document.getElementById("idle-unload").value = "9999";
      document.getElementById("save").click();
    })()`);
    const savedLimits = await waitFor(() => {
      const saved = settings.get();
      // Wait for the clamped values themselves, so stale state can't satisfy it.
      return saved.audio.maxRecordingSeconds === 10 && saved.engines.idleUnloadMinutes === 240 && saved;
    }, "Save did not store the clamped limits (10 s, 240 min)");
    check(
      "Save clamps max dictation length and idle unload to their ranges",
      savedLimits.audio.maxRecordingSeconds === 10 && savedLimits.engines.idleUnloadMinutes === 240,
      `max=${savedLimits.audio.maxRecordingSeconds} idle=${savedLimits.engines.idleUnloadMinutes}`
    );
    const shownLimits = await waitFor(
      () => js(`(() => {
        const status = document.getElementById("save-status").textContent;
        return status.startsWith("Saved —") && JSON.stringify({
          status,
          max: document.getElementById("max-seconds").value,
          idle: document.getElementById("idle-unload").value,
        });
      })()`),
      "Save never reported the adjusted limits"
    ).then(JSON.parse);
    check(
      "Save keeps the window open and shows the limits it stored",
      !win.isDestroyed() &&
        shownLimits.max === "10" &&
        shownLimits.idle === "240" &&
        shownLimits.status.includes("Max dictation length set to 10 s") &&
        shownLimits.status.includes("Idle unload set to 240 min"),
      JSON.stringify(shownLimits)
    );

    // "Deliver as one line" (#68): the switch is what Save sends — read
    // through the page's own collect(), so the window stays open for the
    // checks after this one.
    const singleLineSent = JSON.parse(await js(`(() => {
      const box = document.getElementById("output-single-line");
      const before = box.checked;
      box.checked = !before;
      const sent = collect().output.singleLine;
      box.checked = before;
      return JSON.stringify({ before, sent });
    })()`));
    check(
      "Deliver as one line is sent from its switch",
      singleLineSent.sent === !singleLineSent.before,
      JSON.stringify(singleLineSent)
    );

    // 13. Custom-model removal. Saved settings select a custom model of each
    // kind, so the reload below starts the renderer from them, as a user who
    // picked those models would.
    const customStt = {
      id: "custom-acme-smoke-stt-int8",
      kind: "stt",
      label: "smoke-stt · int8",
      note: "smoke fixture",
      engine: "sherpa-parakeet",
      custom: true,
      files: [{ name: "model.int8.onnx", url: "https://example.invalid/model.int8.onnx" }],
      sherpa: { family: "transducer" },
    };
    const customCleanup = {
      id: "custom-acme-smoke-q4-k-m",
      kind: "cleanup",
      label: "smoke · Q4_K_M",
      note: "smoke fixture",
      engine: "llama-gguf",
      custom: true,
      files: [{ name: "smoke-Q4_K_M.gguf", url: "https://example.invalid/smoke-Q4_K_M.gguf" }],
      gguf: { file: "smoke-Q4_K_M.gguf" },
    };
    const customListed = {
      ...customCleanup,
      id: "custom-acme-listed-q8-0",
      label: "listed · Q8_0",
      files: [{ name: "listed-Q8_0.gguf", url: "https://example.invalid/listed-Q8_0.gguf" }],
      gguf: { file: "listed-Q8_0.gguf" },
    };
    installedModels.add(`stt:${customStt.id}`);
    installedModels.add(`cleanup:${customCleanup.id}`);
    const seeded = settings.get();
    settings.save({
      ...seeded,
      stt: { ...seeded.stt, engine: "builtin", builtin: { ...seeded.stt.builtin, model: customStt.id } },
      cleanup: {
        ...seeded.cleanup,
        engine: "builtin",
        builtin: { ...seeded.cleanup.builtin, model: customCleanup.id },
      },
      customModels: [customStt, customCleanup, customListed],
    });
    // The save registers them (engines/catalog.js, bound above).
    win.webContents.reload();
    await waitForLoad(win.webContents);
    await sleep(1200);

    // A failed delete of the installed, selected custom STT model. The delete
    // is held open first, to see the row while the removal is in flight.
    let releaseRemoval;
    const removalHeld = new Promise((resolve) => (releaseRemoval = resolve));
    engines.remove = async () => {
      await removalHeld;
      throw new Error("custom model files are busy");
    };
    await js(`window.confirms = []; window.confirm = (m) => (window.confirms.push(m), true); true`);
    if (!(await clickRowButton("stt", "Remove"))) throw new Error("custom STT row has no Remove");
    await waitFor(
      () => rowState("stt").then((r) => r.status === "Removing…"),
      "an in-flight removal did not show Removing…"
    );
    const inFlight = await js(`JSON.stringify({
      status: document.querySelector("#stt-model-manage .status")?.textContent,
      disabled: [...document.querySelectorAll("#stt-model-manage button")].map((b) => b.disabled),
    })`).then(JSON.parse);
    check(
      "an in-flight model removal shows Removing… and disables the row's buttons",
      inFlight.status === "Removing…" &&
        inFlight.disabled.length > 0 &&
        inFlight.disabled.every(Boolean),
      JSON.stringify(inFlight)
    );
    releaseRemoval();
    await waitFor(
      () => rowState("stt").then((r) => r.status === "custom model files are busy"),
      "failed custom removal did not appear in the STT row"
    );
    const sttFailure = await rowState("stt");
    sttFailure.enabled = await js(
      `[...document.querySelectorAll("#stt-model-manage button")].every((b) => !b.disabled)`
    );
    // A failed delete through "Remove from list" on an uninstalled custom model.
    await selectModel("cleanup", customListed.id);
    if (!(await clickRowButton("cleanup", "Remove from list"))) {
      throw new Error("uninstalled custom row has no Remove from list");
    }
    await waitFor(
      () => rowState("cleanup").then((r) => r.status === "custom model files are busy"),
      "failed Remove from list did not appear in the cleanup row"
    );
    const listedFailure = await rowState("cleanup");
    const confirms = await js(`JSON.stringify(window.confirms)`).then(JSON.parse);
    check(
      "removing an installed custom model warns that its download is deleted; an uninstalled one doesn't",
      confirms.length === 2 &&
        confirms[0].includes("downloaded files") &&
        confirms[0].includes(customStt.label) &&
        confirms[1] === `Remove ${customListed.label} from your models?`,
      JSON.stringify(confirms)
    );
    check(
      "failed custom model removals show the error and keep the entry",
      sttFailure.select === customStt.id &&
        sttFailure.enabled === true &&
        sttFailure.announcement.endsWith("custom model files are busy") &&
        listedFailure.select === customListed.id &&
        listedFailure.announcement.endsWith("custom model files are busy") &&
        [customStt.id, customCleanup.id, customListed.id].every((id) => definitionIds().includes(id)) &&
        settings.get().stt.builtin.model === customStt.id,
      JSON.stringify({ sttFailure, listedFailure, definitions: definitionIds() })
    );

    // The retry succeeds once the files can be deleted.
    const removed = [];
    engines.remove = async (kind, modelId) => {
      removed.push(`${kind}:${modelId}`);
    };
    await clickRowButton("cleanup", "Remove from list");
    await waitFor(
      () => js(`![...document.getElementById("cleanup-builtin-model").options].some((o) => o.value === ${JSON.stringify(customListed.id)})`),
      "Remove from list retry did not drop the entry"
    );
    // Removing the selected custom models: each select must land on the
    // default, not on "" (a select set to a missing option reads back empty).
    await selectModel("cleanup", customCleanup.id);
    await clickRowButton("cleanup", "Remove");
    await clickRowButton("stt", "Remove");
    await waitFor(
      () => js(`![...document.querySelectorAll("#stt-builtin-model option, #cleanup-builtin-model option")]
        .some((o) => o.value === ${JSON.stringify(customStt.id)} || o.value === ${JSON.stringify(customCleanup.id)})`),
      "custom models were not removed from the selects"
    );
    const afterRemove = { stt: await rowState("stt"), cleanup: await rowState("cleanup") };
    check(
      "removing the selected custom models leaves each select on the default",
      afterRemove.stt.select === registry.DEFAULT_STT_MODEL &&
        afterRemove.cleanup.select === registry.DEFAULT_CLEANUP_MODEL &&
        // The last removal (STT) is announced in the persistent live region.
        afterRemove.stt.announcement === `${customStt.label}: Removed` &&
        removed.length === 3,
      JSON.stringify({ afterRemove, removed })
    );

    // Save goes through the real settings:save handler, so count saves to
    // know when the renderer's own one has landed.
    let rendererSaves = 0;
    const saveSettings = settings.save;
    settings.save = (next) => {
      rendererSaves++;
      return saveSettings(next);
    };
    await js(`document.getElementById("save").click(); true`);
    await waitFor(() => rendererSaves > 0, "Save after removing custom models did not reach main");
    settings.save = saveSettings;
    const persisted = {
      stt: settings.get().stt.builtin.model,
      cleanup: settings.get().cleanup.builtin.model,
      customModels: definitionIds(),
    };
    check(
      "Save after removing the selected custom models persists the defaults, never an empty id",
      persisted.stt === registry.DEFAULT_STT_MODEL &&
        persisted.cleanup === registry.DEFAULT_CLEANUP_MODEL &&
        persisted.customModels.length === 0,
      JSON.stringify(persisted)
    );

    // 14. A microphone chosen while permission or enumeration is pending
    // survives completion and is what Save writes to disk. Each case reopens
    // Settings on a saved device, holds the real loadMicrophones() at one
    // await, makes the choice through the real <select>, then releases.
    // Runs last: each case opens its own window, and the cases rewrite the
    // profile's microphone.
    windows.closeSettings();
    await waitFor(() => win.isDestroyed(), "settings window did not close");
    const SAVED_MIC = "saved-usb-mic";
    const ALT_MIC = "desk-mic";
    const raceDevices = [
      { kind: "audioinput", deviceId: "default", label: "Default - Saved USB Mic" },
      { kind: "audioinput", deviceId: SAVED_MIC, label: "Saved USB Mic" },
      { kind: "audioinput", deviceId: ALT_MIC, label: "Desk Mic" },
      { kind: "videoinput", deviceId: "camera", label: "Camera" },
    ];
    async function micRace({ hold, choose, reject = false, save = false, seedAlt = false }) {
      settings.save({ ...settings.get(), audio: { ...settings.get().audio, deviceId: SAVED_MIC } });
      const raceWin = windows.openSettings();
      await waitForLoad(raceWin.webContents);
      await sleep(1200);
      const run = (code) => raceWin.webContents.executeJavaScript(code, true);
      try {
        // Reset the picker to its markup state, then re-run the page's own
        // loader against held media promises (never awaited from here).
        const seeded = await run(`(() => {
          const select = document.getElementById("mic-device");
          [...select.options].slice(1).forEach((o) => o.remove());
          select.value = "";
          document.getElementById("mic-device-status").textContent = "";
          if (${seedAlt}) {
            const alt = document.createElement("option");
            alt.value = ${JSON.stringify(ALT_MIC)};
            alt.textContent = "Microphone 1";
            select.appendChild(alt);
          }
          const probe = (window.__micProbe = { calls: [], stopped: 0, done: false, error: null });
          const held = (stage) => new Promise((resolve, reject) => { probe[stage] = { resolve, reject }; });
          const stream = { getTracks: () => [{ stop: () => { probe.stopped++; } }] };
          const devices = ${JSON.stringify(raceDevices)};
          navigator.mediaDevices.getUserMedia = () => {
            probe.calls.push("getUserMedia");
            return ${JSON.stringify(hold)} === "permission" ? held("permission").then(() => stream) : Promise.resolve(stream);
          };
          navigator.mediaDevices.enumerateDevices = () => {
            probe.calls.push("enumerateDevices");
            return ${JSON.stringify(hold)} === "enumerate" ? held("enumerate").then(() => devices) : Promise.resolve(devices);
          };
          loadMicrophones().then(
            () => { probe.done = true; },
            (err) => { probe.error = String(err); probe.done = true; }
          );
          return select.value;
        })()`);
        const heldCall = hold === "permission" ? "getUserMedia" : "enumerateDevices";
        await waitFor(
          () => run(`window.__micProbe.calls.includes(${JSON.stringify(heldCall)})`),
          `loader did not reach ${heldCall}`
        );
        if (choose !== undefined) {
          await run(`(() => {
            const select = document.getElementById("mic-device");
            select.value = ${JSON.stringify(choose)};
            select.dispatchEvent(new Event("change", { bubbles: true }));
          })()`);
        }
        if (hold === "permission") {
          await run(reject
            ? `window.__micProbe.permission.reject(new DOMException("denied", "NotAllowedError"))`
            : `window.__micProbe.permission.resolve()`);
        } else if (hold === "enumerate") {
          await run(`window.__micProbe.enumerate.resolve()`);
        }
        await waitFor(() => run(`window.__micProbe.done`), "loader did not settle");
        const state = JSON.parse(await run(`(() => {
          const select = document.getElementById("mic-device");
          const label = (id) => select.querySelector('option[value="' + CSS.escape(id) + '"]')?.textContent ?? null;
          const result = JSON.stringify({
            seeded: ${JSON.stringify(seeded)},
            value: select.value,
            saved: label(${JSON.stringify(SAVED_MIC)}),
            alt: label(${JSON.stringify(ALT_MIC)}),
            values: [...select.options].map((o) => o.value),
            status: document.getElementById("mic-device-status").textContent,
            stopped: window.__micProbe.stopped,
            error: window.__micProbe.error,
          });
          delete navigator.mediaDevices.getUserMedia;
          delete navigator.mediaDevices.enumerateDevices;
          return result;
        })()`));
        if (save) {
          await run(`document.getElementById("save").click()`);
          await savedThenClose(raceWin, "Save never reported Saved");
          state.persisted = JSON.parse(
            fs.readFileSync(path.join(userData, "settings.json"), "utf8")
          ).audio.deviceId;
        }
        return state;
      } finally {
        if (!raceWin.isDestroyed()) {
          windows.closeSettings();
          await waitFor(() => raceWin.isDestroyed(), "settings window did not close");
        }
      }
    }
    const refreshed = (s) =>
      s.saved === "Saved USB Mic" &&
      s.alt === "Desk Mic" &&
      !s.values.includes("default") &&
      !s.values.includes("camera") &&
      new Set(s.values).size === s.values.length;

    const heldEnumeration = await micRace({ hold: "enumerate", choose: "", save: true });
    check(
      "System default chosen while enumeration is pending survives completion",
      heldEnumeration.seeded === SAVED_MIC && heldEnumeration.value === "" && !heldEnumeration.error,
      JSON.stringify(heldEnumeration)
    );
    check(
      "enumeration still refreshes microphone options and labels after a pending choice",
      refreshed(heldEnumeration) && heldEnumeration.stopped === 1,
      JSON.stringify(heldEnumeration)
    );
    check(
      "Save persists System default chosen during enumeration",
      heldEnumeration.persisted === "",
      JSON.stringify(heldEnumeration.persisted)
    );
    const heldPermission = await micRace({ hold: "permission", choose: "" });
    check(
      "System default chosen while microphone permission is pending survives completion",
      heldPermission.value === "" && refreshed(heldPermission) && !heldPermission.error,
      JSON.stringify(heldPermission)
    );
    const altChoice = await micRace({ hold: "enumerate", choose: ALT_MIC, seedAlt: true, save: true });
    check(
      "another microphone chosen during enumeration survives, relabelled, and is saved",
      altChoice.value === ALT_MIC && refreshed(altChoice) && altChoice.persisted === ALT_MIC,
      JSON.stringify(altChoice)
    );
    const untouched = await micRace({ hold: "none" });
    check(
      "an untouched saved microphone stays selected with its refreshed label",
      untouched.value === SAVED_MIC && refreshed(untouched) && untouched.status === "",
      JSON.stringify(untouched)
    );
    const denied = await micRace({ hold: "permission", choose: "", reject: true });
    check(
      "a choice made before microphone permission is denied is kept",
      denied.value === "" && denied.stopped === 0 && !denied.error,
      JSON.stringify(denied)
    );

    // 16. Save downloads a selected built-in model that isn't installed, and
    // persists only after it is. Each case opens a fresh window (and closes it
    // with Close once Save says "Saved") and holds the fake engine's transfer
    // open.
    const savedJson = () => JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    const notInstalled = (kind) => registry.listModels(kind)
      .map((m) => m.id)
      .find((id) => !installedModels.has(`${kind}:${id}`) && !isInstalled(kind, id));
    const saveSttModel = notInstalled("stt");
    const saveCleanupModel = notInstalled("cleanup");
    // The wizard checks after this block read the saved models; put back the
    // ones saved before it.
    const modelsBeforeSaves = { stt: settings.get().stt.builtin, cleanup: settings.get().cleanup.builtin };
    let saveCount = 0;
    const countedSave = settings.save;
    settings.save = (next) => {
      saveCount++;
      return countedSave(next);
    };
    async function openSaveWindow() {
      const saveWin = windows.openSettings();
      await waitForLoad(saveWin.webContents);
      await sleep(1200);
      const run = (code) => saveWin.webContents.executeJavaScript(code, true);
      const select = (kind, modelId) => run(`(() => {
        const select = document.getElementById(${JSON.stringify(`${kind}-builtin-model`)});
        select.value = ${JSON.stringify(modelId)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      const state = (kind) => run(`JSON.stringify({
        save: document.getElementById("save-status").textContent,
        saveClass: document.getElementById("save-status").className,
        saveDisabled: document.getElementById("save").disabled,
        row: document.querySelector(${JSON.stringify(`#${kind}-model-manage .status`)})?.textContent,
        width: document.querySelector(${JSON.stringify(`#${kind}-model-manage .dl-fill`)})?.style.width,
        buttons: [...document.querySelectorAll(${JSON.stringify(`#${kind}-model-manage button`)})].map((b) => b.textContent),
      })`).then(JSON.parse);
      return { saveWin, run, select, state };
    }
    try {
      // Download on Save, with progress; a second click starts nothing more.
      {
        const { saveWin, run, select, state } = await openSaveWindow();
        const callsBefore = downloadCalls.length;
        const savesBefore = saveCount;
        await select("stt", saveSttModel);
        await run(`document.getElementById("save").click(); document.getElementById("save").click(); true`);
        await waitFor(() => downloadCalls.length > callsBefore, "Save did not start the selected model's download");
        downloads.get(`stt:${saveSttModel}`).onProgress({ fraction: 0.42, received: 42, total: 100 });
        await run(`document.getElementById("save").click(); true`);
        const during = await waitFor(
          () => state("stt").then((s) => s.width === "42%" && s),
          "Save-triggered download never showed progress"
        );
        check(
          "Save downloads a selected model that isn't downloaded, without a Download click",
          downloadCalls.slice(callsBefore).join() === `stt:${saveSttModel}` &&
            saveCount === savesBefore &&
            savedJson().stt.builtin.model !== saveSttModel,
          JSON.stringify({ calls: downloadCalls.slice(callsBefore), saves: saveCount - savesBefore })
        );
        check(
          "Save shows the download's progress and keeps Save disabled while it runs",
          during.row.startsWith("42%") && during.buttons.includes("Cancel") &&
            /^Downloading .+ before saving…$/.test(during.save) && during.saveDisabled,
          JSON.stringify(during)
        );
        downloads.get(`stt:${saveSttModel}`).resolve();
        await savedThenClose(saveWin, "Save did not report Saved after the download");
        check(
          "Save persists the model once it is downloaded, once, after repeated clicks",
          savedJson().stt.builtin.model === saveSttModel &&
            saveCount === savesBefore + 1 &&
            downloadCalls.slice(callsBefore).length === 1,
          JSON.stringify({ calls: downloadCalls.slice(callsBefore), saves: saveCount - savesBefore })
        );
      }

      // Failure, cancel, then a Download already running when Save is clicked.
      {
        const { saveWin, run, select, state } = await openSaveWindow();
        const savesBefore = saveCount;
        const savedCleanup = savedJson().cleanup.builtin.model;
        await select("cleanup", saveCleanupModel);
        let callsBefore = downloadCalls.length;
        await run(`document.getElementById("save").click(); true`);
        await waitFor(() => downloadCalls.length > callsBefore, "Save did not start the cleanup download");
        downloads.get(`cleanup:${saveCleanupModel}`).reject(new Error("checksum mismatch"));
        const failed = await waitFor(
          // The row settles on models:done after its own status refresh.
          () => state("cleanup").then((s) => s.save.startsWith("Not saved") && !s.buttons.includes("Cancel") && s),
          "a failed download never reported Not saved"
        );
        check(
          "a failed Save-triggered download shows the error and saves nothing",
          /checksum mismatch/.test(failed.save) && failed.saveClass === "status err" &&
            !failed.saveDisabled && !saveWin.isDestroyed() &&
            saveCount === savesBefore && savedJson().cleanup.builtin.model === savedCleanup &&
            failed.row === "checksum mismatch" && failed.buttons.includes("Retry download"),
          JSON.stringify(failed)
        );

        callsBefore = downloadCalls.length;
        await run(`document.getElementById("save").click(); true`);
        await waitFor(() => downloadCalls.length > callsBefore, "a second Save did not retry the download");
        await waitFor(
          () => state("cleanup").then((s) => s.buttons.includes("Cancel")),
          "the retried download did not offer Cancel"
        );
        await run(`[...document.querySelectorAll("#cleanup-model-manage button")].find((b) => b.textContent === "Cancel").click(); true`);
        const cancelled = await waitFor(
          // The row settles on models:done after its own status refresh.
          () => state("cleanup").then((s) => s.save.startsWith("Not saved") && !s.buttons.includes("Cancel") && s),
          "a cancelled download never reported Not saved"
        );
        check(
          "cancelling a Save-triggered download says so and saves nothing",
          /Download cancelled/.test(cancelled.save) && !cancelled.saveDisabled &&
            saveCount === savesBefore && savedJson().cleanup.builtin.model === savedCleanup,
          JSON.stringify(cancelled)
        );

        callsBefore = downloadCalls.length;
        await run(`[...document.querySelectorAll("#cleanup-model-manage button")].find((b) => b.textContent === "Download").click(); true`);
        await waitFor(() => downloadCalls.length > callsBefore, "Download did not start");
        await run(`document.getElementById("save").click(); true`);
        await sleep(150);
        const joined = { calls: downloadCalls.slice(callsBefore), saves: saveCount - savesBefore, open: !saveWin.isDestroyed() };
        downloads.get(`cleanup:${saveCleanupModel}`).resolve();
        await savedThenClose(saveWin, "Save did not report Saved after the running download finished");
        check(
          "Save during a running Download waits for it instead of starting another",
          joined.calls.length === 1 && joined.saves === 0 && joined.open &&
            downloadCalls.slice(callsBefore).length === 1 &&
            saveCount === savesBefore + 1 && savedJson().cleanup.builtin.model === saveCleanupModel,
          JSON.stringify(joined)
        );
      }

      // Two missing models in one Save: speech first, then the cleanup model the
      // form holds when speech finishes (it changed meanwhile); a failure on
      // the second saves nothing, and the next Save downloads only what is
      // still missing.
      {
        const missingModels = (kind) => registry.listModels(kind)
          .map((m) => m.id)
          .filter((id) => !installedModels.has(`${kind}:${id}`) && !isInstalled(kind, id));
        const [sttTwo] = missingModels("stt");
        const [cleanupFirst, cleanupSwitched] = missingModels("cleanup");
        const { saveWin, run, select, state } = await openSaveWindow();
        const savesBefore = saveCount;
        const before = savedJson();
        let callsBefore = downloadCalls.length;
        await select("stt", sttTwo);
        await select("cleanup", cleanupFirst);
        await run(`document.getElementById("save").click(); true`);
        await waitFor(() => downloadCalls.length > callsBefore, "a two-model Save did not start speech");
        await select("cleanup", cleanupSwitched);
        downloads.get(`stt:${sttTwo}`).resolve();
        await waitFor(() => downloadCalls.length > callsBefore + 1, "a two-model Save did not continue to cleanup");
        const sequence = { calls: downloadCalls.slice(callsBefore), saves: saveCount - savesBefore };
        check(
          "one Save downloads speech, then the cleanup model selected when speech finished, before saving",
          sequence.calls.join() === `stt:${sttTwo},cleanup:${cleanupSwitched}` && sequence.saves === 0,
          JSON.stringify(sequence)
        );
        downloads.get(`cleanup:${cleanupSwitched}`).reject(new Error("offline"));
        const failedSecond = await waitFor(
          () => state("cleanup").then((s) => s.save.startsWith("Not saved") && !s.buttons.includes("Cancel") && s),
          "a failed second download never reported Not saved"
        );
        check(
          "a failed second download saves neither model",
          /offline/.test(failedSecond.save) && saveCount === savesBefore &&
            savedJson().stt.builtin.model === before.stt.builtin.model &&
            savedJson().cleanup.builtin.model === before.cleanup.builtin.model,
          JSON.stringify({ failedSecond, saved: savedJson().stt.builtin.model })
        );
        callsBefore = downloadCalls.length;
        await run(`document.getElementById("save").click(); true`);
        await waitFor(() => downloadCalls.length > callsBefore, "the retried Save did not start cleanup");
        downloads.get(`cleanup:${cleanupSwitched}`).resolve();
        await savedThenClose(saveWin, "the retried Save did not report Saved");
        check(
          "the next Save downloads only what is still missing and saves both once",
          downloadCalls.slice(callsBefore).join() === `cleanup:${cleanupSwitched}` &&
            saveCount === savesBefore + 1 &&
            savedJson().stt.builtin.model === sttTwo && savedJson().cleanup.builtin.model === cleanupSwitched,
          JSON.stringify({ calls: downloadCalls.slice(callsBefore), saves: saveCount - savesBefore })
        );
      }

      // Installed selection: Save downloads nothing, keeps the window open
      // and says "Saved" (#298); an edit clears that; Close closes the window.
      {
        const { saveWin, run, state } = await openSaveWindow();
        const callsBefore = downloadCalls.length;
        const savesBefore = saveCount;
        await run(`document.getElementById("save").click(); true`);
        const saved = await waitFor(
          () => state("stt").then((s) => s.saveClass === "status ok" && s),
          "a clean Save with installed models never reported Saved"
        );
        await sleep(300);
        const open = !saveWin.isDestroyed();
        check(
          "Save with downloaded models downloads nothing and saves once",
          downloadCalls.length === callsBefore && saveCount === savesBefore + 1,
          JSON.stringify({ calls: downloadCalls.slice(callsBefore), saves: saveCount - savesBefore })
        );
        check(
          "a clean Save keeps Settings open and says Saved",
          open && saved.save === "Saved" && !saved.saveDisabled,
          JSON.stringify({ open, saved })
        );
        // An interaction that changes nothing keeps "Saved": the snapshot
        // must match the form right after Save, not just differ after edits.
        await run(`(() => {
          document.querySelector(".tab").click();
          document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
        })()`);
        await sleep(100);
        const kept = await run(`document.getElementById("save-status").textContent`);
        check("a click or key that edits nothing keeps Saved", kept === "Saved", JSON.stringify(kept));
        // Step away from whichever end of the range the value sits at, so
        // collect()'s clamp can't undo the edit.
        await run(`(() => {
          const field = document.getElementById("max-seconds");
          window.__maxStep = Number(field.value) < Number(field.max) ? 1 : -1;
          field.value = String(Number(field.value) + window.__maxStep);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        })()`);
        const edited = await waitFor(
          () => run(`document.getElementById("save-status").textContent === ""`),
          "editing the form did not clear Saved"
        );
        check("editing the form after a Save clears Saved", edited);
        // A hotkey capture sets the value directly and fires no input event;
        // it must clear "Saved" too.
        await run(`(() => {
          const field = document.getElementById("max-seconds");
          field.value = String(Number(field.value) - window.__maxStep);
          document.getElementById("save").click();
        })()`);
        await waitFor(
          () => state("stt").then((s) => s.save === "Saved"),
          "a second clean Save never reported Saved"
        );
        await run(`(() => {
          const field = document.getElementById("pause-hotkey");
          field.click();
          field.dispatchEvent(new KeyboardEvent("keydown", {
            key: "F9", code: "F9", ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true,
          }));
          field.blur();
        })()`);
        const captured = await waitFor(
          () => run(`document.getElementById("save-status").textContent === "" &&
            document.getElementById("pause-hotkey").value`),
          "a captured hotkey did not clear Saved"
        );
        check("capturing a hotkey after a Save clears Saved", /Alt\+Shift\+F9$/.test(captured), JSON.stringify(captured));
        await clickClose(saveWin);
        check(
          "Close closes Settings without saving the edit",
          saveWin.isDestroyed() && saveCount === savesBefore + 2 &&
            !/F9$/.test(savedJson().pauseHotkey || ""),
          JSON.stringify({ saves: saveCount - savesBefore })
        );
      }

      // A plain Save whose own settings:changed rewrites the dictionary and
      // output controls mid-save is still "Saved": blank lines, duplicates,
      // padding and a removed word come back from the merge unchanged.
      {
        const beforeEdit = settings.get();
        const { saveWin, run } = await openSaveWindow();
        await run(`(() => {
          const field = document.getElementById("cleanup-dictionary");
          const kept = field.value.split("\\n").filter((line) => line.trim()).slice(1);
          field.value = ["", "  Padded  ", "dupe", "dupe", ...kept, ""].join("\\n");
          field.dispatchEvent(new Event("input", { bubbles: true }));
          document.querySelector('input[name="output-mode"]:not(:checked)').click();
          document.getElementById("save").click();
        })()`);
        await savedThenClose(saveWin, "a dictionary and output edit never reported Saved");
        check(
          "a Save that rewrites the dictionary and output mode still says Saved",
          savedJson().cleanup.dictionary.includes("Padded") && savedJson().cleanup.dictionary.includes("dupe"),
          JSON.stringify(savedJson().cleanup.dictionary)
        );
        // Later checks read the output mode and dictionary; put them back.
        const after = settings.get();
        settings.save({
          ...after,
          output: beforeEdit.output,
          cleanup: { ...after.cleanup, dictionary: beforeEdit.cleanup.dictionary },
        });
      }

      // #335: Always replace stays editable with cleanup off, follows an
      // alias the correction window saved meanwhile without touching what
      // the user typed, saves both, and refuses a heard form with two owners.
      {
        const beforeEdit = settings.get();
        const { saveWin, run } = await openSaveWindow();
        const usable = await run(`(() => {
          const toggle = document.getElementById("cleanup-enabled");
          toggle.checked = false;
          toggle.dispatchEvent(new Event("change", { bubbles: true }));
          const field = document.getElementById("cleanup-aliases");
          field.value = "air heart, ear heart -> Earheart";
          field.dispatchEvent(new Event("input", { bubbles: true }));
          return !field.closest("[inert]") && !field.disabled;
        })()`);
        check("Always replace is editable with cleanup off", usable === true);
        const live = settings.get();
        settings.save({ ...live, cleanup: { ...live.cleanup, aliases: [{ term: "kubectl", heard: ["cube cuddle"] }] } });
        const shown = await waitFor(
          () => run(`(() => { const v = document.getElementById("cleanup-aliases").value; return v.includes("cube cuddle") && v; })()`),
          "an alias saved elsewhere never reached the open form"
        );
        check("an alias saved elsewhere is appended to the typed rules",
          shown === "air heart, ear heart -> Earheart\ncube cuddle -> kubectl", JSON.stringify(shown));
        await run(`document.getElementById("save").click()`);
        await waitFor(() => run(`document.getElementById("save-status").className === "status ok"`), "the alias Save never reported Saved", 500);
        check("Save stores the typed and the concurrently saved aliases",
          JSON.stringify(savedJson().cleanup.aliases) === JSON.stringify([
            { term: "Earheart", heard: ["air heart", "ear heart"] },
            { term: "kubectl", heard: ["cube cuddle"] },
          ]), JSON.stringify(savedJson().cleanup.aliases));
        const refused = await run(`(() => {
          const field = document.getElementById("cleanup-aliases");
          field.value += "\\nAir Heart -> Airheart";
          field.dispatchEvent(new Event("input", { bubbles: true }));
          document.getElementById("save").click();
          return document.getElementById("save-status").textContent;
        })()`);
        check("Save refuses a heard form owned by another term, naming the line",
          /^Not saved — Always replace, line 3: “Air Heart” already becomes “Earheart”/.test(refused) &&
            savedJson().cleanup.aliases.length === 2,
          JSON.stringify(refused));
        await clickClose(saveWin);
        const after = settings.get();
        settings.save({ ...after, cleanup: { ...after.cleanup, enabled: beforeEdit.cleanup.enabled, aliases: beforeEdit.cleanup.aliases } });
      }

      // An edit made while the save is in flight is not in what was saved:
      // Save must say so instead of "Saved", and disk keeps the sent value.
      // Cover a plain field and a limit that the response used to overwrite.
      for (const { id, readSaved, nextValue } of [
        { id: "stt-language", readSaved: () => savedJson().stt.language, nextValue: (value) => value === "fr" ? "de" : "fr" },
        { id: "max-seconds", readSaved: () => savedJson().audio.maxRecordingSeconds, nextValue: (value) => value === 300 ? 600 : 300 },
      ]) {
        const { saveWin, run } = await openSaveWindow();
        const before = readSaved();
        const typed = nextValue(before);
        const realSave = invokeHandlers.get("settings:save");
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        let reached = false;
        ipcMain.removeHandler("settings:save");
        registerHandler("settings:save", async (...args) => {
          const reply = await realSave(...args);
          reached = true;
          await held;
          return reply;
        });
        try {
          await run(`document.getElementById("save").click(); true`);
          await waitFor(() => reached, "the held Save never reached main");
          await run(`(() => {
            const field = document.getElementById(${JSON.stringify(id)});
            field.value = ${JSON.stringify(typed)};
            field.dispatchEvent(new Event("input", { bubbles: true }));
          })()`);
          release();
          const during = await waitFor(
            () => run(`(() => {
              const status = document.getElementById("save-status");
              return status.textContent.startsWith("Saved") && JSON.stringify({
                text: status.textContent,
                className: status.className,
                field: document.getElementById(${JSON.stringify(id)}).value,
              });
            })()`),
            "the held Save never finished"
          ).then(JSON.parse);
          await sleep(100);
          const later = await run(`document.getElementById("save-status").textContent`);
          check(
            `${id}: an edit made while saving survives and is not vouched for by Saved`,
            during.className === "status" && /aren't saved yet/.test(during.text) &&
              later === during.text && during.field === String(typed) && readSaved() === before,
            JSON.stringify({ during, later, saved: readSaved() })
          );
        } finally {
          release();
          ipcMain.removeHandler("settings:save");
          registerHandler("settings:save", realSave);
        }
        await run(`document.getElementById("save").click(); true`);
        await savedThenClose(saveWin, `${id}: the second Save never reported Saved`);
        check(
          `${id}: a second Save persists the edit made during the first`,
          readSaved() === typed,
          JSON.stringify({ typed, saved: readSaved() })
        );
      }
      // Hold before the real handler: its settings:changed broadcast must not
      // erase edits made after Save, even before the response can reconcile.
      for (const field of ["output", "remind"]) {
        const cfg = settings.get();
        settings.save({ ...cfg, output: { ...cfg.output, mode: "paste", restoreClipboard: true }, updates: { ...cfg.updates, remind: true } });
        const { saveWin, run } = await openSaveWindow();
        const readSaved = () => field === "output" ? savedJson().output.mode : savedJson().updates.remind;
        const sent = field === "output" ? "clipboard" : false;
        const edited = field === "output" ? "paste-copy" : true;
        const setField = (value) => run(field === "output"
          ? `document.querySelector('input[name="output-mode"][value="${value}"]').click(); true`
          : `(() => { const el = document.getElementById("updates-remind"); el.checked = ${value}; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        const readField = () => run(field === "output"
          ? `document.querySelector('input[name="output-mode"]:checked').value`
          : `document.getElementById("updates-remind").checked`);
        const realSave = invokeHandlers.get("settings:save");
        let releaseSave;
        let releaseReply;
        const heldSave = new Promise((resolve) => { releaseSave = resolve; });
        const heldReply = new Promise((resolve) => { releaseReply = resolve; });
        let reached = false;
        ipcMain.removeHandler("settings:save");
        registerHandler("settings:save", async (...args) => {
          reached = true;
          await heldSave;
          const reply = await realSave(...args);
          await heldReply;
          return reply;
        });
        try {
          await setField(sent);
          await run(`document.getElementById("save").click(); true`);
          await waitFor(() => reached, "Save did not reach the held handler");
          await setField(edited);
          releaseSave();
          // Baseline advancement proves the renderer received the broadcast,
          // independently of the response, which is still held here.
          await waitFor(() => run(`baseline.${field === "output" ? "outputMode" : "remind"} === ${JSON.stringify(sent)}`), "save broadcast did not advance the baseline");
          const broadcastValue = await readField();
          check(`${field}: save broadcast preserves a later edit and advances baseline`,
            broadcastValue === edited && readSaved() === sent,
            JSON.stringify({ shown: broadcastValue, saved: readSaved(), edited, sent }));
          releaseReply();
          await waitFor(() => run(`!document.getElementById("save").disabled`), "held response did not finish");
          const responseValue = await readField();
          const status = await run(`document.getElementById("save-status").textContent`);
          check(`${field}: save response preserves the edit and warns it is unsaved`,
            responseValue === edited && /aren't saved yet/.test(status) && readSaved() === sent,
            JSON.stringify({ shown: responseValue, saved: readSaved(), status }));
        } finally {
          releaseSave();
          releaseReply();
          ipcMain.removeHandler("settings:save");
          registerHandler("settings:save", realSave);
        }
        await run(`document.getElementById("save").click(); true`);
        await savedThenClose(saveWin, `${field}: second Save did not report Saved`);
        check(`${field}: second Save persists the edit protected from the broadcast`,
          readSaved() === edited, JSON.stringify({ saved: readSaved(), edited }));
      }
    } finally {
      settings.save = countedSave;
      // A failed case leaves its window open; close it so the next block starts clean.
      windows.closeSettings();
      const saved = settings.get();
      settings.save({
        ...saved,
        stt: { ...saved.stt, builtin: modelsBeforeSaves.stt },
        cleanup: { ...saved.cleanup, builtin: modelsBeforeSaves.cleanup },
      });
    }

    await require("./wizard-smoke").checkWizard({ waitFor, check });
    await require("./correction-smoke").checkCorrection({ waitFor, check, savedThenClose });

    const failed = checks.filter((c) => !c.ok);
    console.log(
      `[settings-smoke] ${checks.length - failed.length}/${checks.length} checks passed`
    );
    app.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.error("[settings-smoke] error:", err);
    app.exit(1);
  }
});
