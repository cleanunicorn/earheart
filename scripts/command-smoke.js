// Drives the real voice command card (#344) in a real Electron window, with the
// session's edges faked (no microphone, no foreign app): the page, the preload
// role allowlist, the main-side sender check and the session are all real.
//
//   1. The card never takes the keyboard: it is a non-focusable window, shown
//      inactive, so Apply's paste lands in the app the selection came from.
//   2. The card renders the selection, the spoken instruction and the result as
//      TEXT (markup in any of them stays inert), with the remote-service
//      privacy line only for a remote command.
//   3. Apply and Copy follow the session: a drifted target leaves only Copy and
//      says why; a good target pastes the RESULT, once, never the instruction.
//   4. A failed transform keeps the selection and the instruction on screen
//      with no Apply and no Copy.
//   5. Cancel at every stage closes the card; a late result after Cancel never
//      reaches the target.
//   6. Another window's bridge can't reach the command channels (the preload
//      refuses them), and main refuses a request from any sender but the card.
//
// Run under Electron:
//
//   xvfb-run -a npx electron scripts/command-smoke.js --no-sandbox   # Linux
//   npx electron scripts/command-smoke.js                            # macOS/Win

const { app, ipcMain, nativeTheme } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const userData = path.join(
  os.tmpdir(),
  `earheart-command-smoke-${crypto.createHash("sha1").update(__dirname).digest("hex").slice(0, 8)}`
);
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.setPath("logs", path.join(userData, "logs"));

const windows = require("../main/windows");
const { waitForLoad } = require("./wait-for-load");
const { createCommandSession } = require("../main/commands/session");
const { registerCommandIpc, REJECTED } = require("../main/commands/ipc");

app.on("window-all-closed", () => {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await read()) return;
    await sleep(15);
  }
  throw new Error(message);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`[command-smoke] ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const SELECTION = "<img src=x onerror=\"window.__pwned=1\"> original <b>selected</b> text";
const INSTRUCTION = "make it <i>friendlier</i>";
const OUTPUT = "A <u>friendlier</u> version";

app.whenReady().then(async () => {
  try {
    nativeTheme.themeSource = "dark";
    windows.init();

    // A session over fakes, shown in the real window.
    const state = { pasted: [], copied: [], focus: { id: "x11:1" }, transform: async () => OUTPUT, remote: false, handlers: null, cancels: 0 };
    const session = createCommandSession({
      getConfig: () => ({ engine: state.remote ? "remote" : "builtin", timeoutMs: 5000, allowApply: true }),
      selection: { capture: async () => ({ ok: true, text: SELECTION }) },
      platform: {
        captureSupport: () => ({ ok: true }),
        fingerprintSupport: () => ({ ok: true, grain: "window" }),
        fingerprint: async () => state.focus,
      },
      transform: (request, signal) => state.transform(request, signal),
      startRecording: (handlers) => { state.handlers = handlers; return 7; },
      stopRecording() {},
      cancelRecording: () => { state.cancels++; },
      writeClipboard: (text) => state.copied.push(text),
      paste: async (text) => { state.pasted.push(text); return { method: "paste" }; },
      onView: (view) => { if (view) windows.sendToCommand("command:state", view); else windows.closeCommand(); },
    });
    const handlers = new Map();
    registerCommandIpc({
      ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn); ipcMain.handle(channel, fn); } },
      session,
      isCommandSender: windows.isCommandSender,
      closeWindow: () => windows.closeCommand(),
    });

    const open = async () => {
      const win = windows.openCommand({ onClosed: () => session.dispose() });
      await waitForLoad(win.webContents);
      return win;
    };
    const page = (win) => (code) => win.webContents.executeJavaScript(code, true);

    // ---- 1 + 2: window behavior and rendering ----
    let win = await open();
    let run = page(win);
    await waitFor(() => win.isVisible(), "the card never appeared");
    check("the card is not focusable and does not hold the keyboard", win.isFocusable() === false && !win.isFocused());

    const started = session.begin();
    await started;
    state.handlers.onTranscript(7, INSTRUCTION);
    await waitFor(() => run('document.getElementById("output").textContent.length > 0'), "the result never rendered");
    check("selection, instruction and result render as text", await run(`
      document.getElementById("selection").textContent === ${JSON.stringify(SELECTION)} &&
      document.getElementById("instruction").textContent === ${JSON.stringify(INSTRUCTION)} &&
      document.getElementById("output").textContent === ${JSON.stringify(OUTPUT)}`));
    check("markup in them stays inert", await run(`!document.querySelector("pre img, pre b, pre i, pre u") && window.__pwned === undefined`));
    check("a local command shows no remote-service notice", await run('document.getElementById("remote-note").hidden'));
    check("Apply and Copy are offered once there is a valid result", await run('!document.getElementById("apply").hidden && !document.getElementById("apply").disabled && !document.getElementById("copy").hidden'));

    // ---- 3: copy, then drifted apply, then a good apply ----
    await run('document.getElementById("copy").click()');
    await waitFor(() => state.copied.length === 1, "Copy did not reach the session");
    check("Copy puts the result, not the instruction, on the clipboard", state.copied[0] === OUTPUT);

    state.focus = { id: "x11:2" }; // the user switched windows
    await run('document.getElementById("apply").click()');
    await waitFor(() => run('document.getElementById("apply").disabled'), "a drifted target still offered Apply");
    check("a drifted target is never pasted into", state.pasted.length === 0);
    check("the card says why and keeps Copy", await run('document.getElementById("notice").textContent.includes("changed") && !document.getElementById("copy").hidden'));

    state.focus = { id: "x11:1" };
    await session.begin();
    state.handlers.onTranscript(7, INSTRUCTION);
    await waitFor(() => run('document.getElementById("output").textContent.length > 0 && !document.getElementById("apply").disabled'), "second result never rendered");
    await run('document.getElementById("apply").click(); document.getElementById("apply").click()');
    await waitFor(() => state.pasted.length >= 1, "Apply never pasted");
    await sleep(100);
    check("Apply pastes the result exactly once", state.pasted.length === 1 && state.pasted[0] === OUTPUT, JSON.stringify(state.pasted));
    check("the instruction is never pasted", !state.pasted.includes(INSTRUCTION));

    // ---- 4: a failed transform ----
    state.transform = async () => { throw new Error("The model returned no text"); };
    await session.begin();
    state.handlers.onTranscript(7, INSTRUCTION);
    await waitFor(() => run('!document.getElementById("error").hidden'), "the failure never rendered");
    check("a failed transform keeps the selection and the instruction", await run(`
      document.getElementById("selection").textContent === ${JSON.stringify(SELECTION)} &&
      document.getElementById("instruction").textContent === ${JSON.stringify(INSTRUCTION)}`));
    check("and offers neither Apply nor Copy, only Retry", await run('document.getElementById("apply").hidden && document.getElementById("copy").hidden && !document.getElementById("retry").hidden'));

    // ---- 5: cancel, with a late result ----
    let release;
    state.transform = () => new Promise((resolve) => { release = resolve; });
    state.pasted.length = 0;
    await session.begin();
    state.handlers.onTranscript(7, INSTRUCTION);
    await waitFor(() => run('document.getElementById("cancel").textContent === "Cancel"'), "no Cancel while working");
    await run('document.getElementById("cancel").click()');
    await waitFor(() => win.isDestroyed(), "Cancel did not close the card");
    release(OUTPUT);
    await sleep(50);
    check("a result that arrives after Cancel is dropped", state.pasted.length === 0 && session.peek() === null);

    // A cancel that starts outside the card (overlay Esc, discard hotkey).
    win = await open();
    await session.begin();
    state.handlers.onEnd(7, "cancelled");
    await waitFor(() => win.isDestroyed(), "an outside cancel left the card open");
    check("a cancel from the overlay closes the card", session.peek() === null);

    // Closing the card while recording cancels the take.
    win = await open();
    run = page(win);
    state.cancels = 0;
    await session.begin();
    await waitFor(() => run('!document.getElementById("finish").hidden'), "no Finish while listening");
    win.destroy();
    await sleep(50);
    check("closing the card mid-recording cancels the recording", state.cancels === 1 && session.peek() === null);

    // ---- remote notice ----
    state.remote = true;
    state.transform = async () => OUTPUT;
    win = await open();
    run = page(win);
    await session.begin();
    await waitFor(() => run('!document.getElementById("remote-note").hidden'), "a remote command did not say text leaves the machine");
    check("a remote command says the text is sent to the service", true);
    session.dispose();
    win.destroy();

    // ---- 6: other windows ----
    win = await open();
    const settingsWin = windows.openSettings();
    await waitForLoad(settingsWin.webContents);
    const reachable = await settingsWin.webContents.executeJavaScript(
      `(async () => { try { await earheart.invoke("command:apply", { id: 1 }); return "reached"; } catch (e) { return e.message; } })()`, true);
    check("Settings' bridge can't invoke command channels", /Unknown channel/.test(reachable), reachable);
    // Main refuses a request from any sender but the card, even if a bridge let it through.
    const refused = await handlers.get("command:apply")({ sender: settingsWin.webContents }, { id: 1 });
    const accepted = await handlers.get("command:get")({ sender: win.webContents }, {});
    check("main refuses command requests from other windows", refused && refused.ok === false && refused.error === REJECTED.error);
    check("and answers the card", accepted && accepted.ok === true);
    settingsWin.destroy();
    session.dispose();
    win.destroy();
  } catch (err) {
    console.error(`[command-smoke] ERROR: ${err.stack || err.message}`);
    check("no unexpected error", false, err.message);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`[command-smoke] ${checks.length - failed.length}/${checks.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
});
