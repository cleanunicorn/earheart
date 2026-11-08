// Drives the real Settings "Tools" card, the real approval window and the real
// IPC wiring (main/tools/index.js) against a fixture MCP server over stdio.
// Proves what unit tests with fakes cannot: the renderer pages render
// server-provided text as text, only the approval window's click resolves a
// request, Deny/Escape/closing the window never run the tool, and Allow runs
// exactly the request that was shown.
//
//   xvfb-run -a npx electron scripts/approval-smoke.js --no-sandbox   # Linux
//   npx electron scripts/approval-smoke.js                            # macOS/Win

const { app, ipcMain, safeStorage, nativeTheme } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const userData = path.join(os.tmpdir(), `earheart-approval-smoke-${crypto.createHash("sha1").update(__dirname).digest("hex").slice(0, 8)}`);
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.setPath("logs", path.join(userData, "logs"));
app.on("window-all-closed", () => {});

const settings = require("../main/settings");
const windows = require("../main/windows");
const logger = require("../main/util/logger");
const tools = require("../main/tools");
const { waitForLoad } = require("./wait-for-load");

const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.js");
const LOG = path.join(userData, "calls.log");
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, message, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error(message);
}
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith("call ")) : []);

app.whenReady().then(async () => {
  try {
    nativeTheme.themeSource = "dark";
    windows.init();
    // A throwaway settings file so the Settings window opens on defaults.
    settings.save(settings.get());
    const manager = tools.init({ ipcMain, app, safeStorage, secretStorageSecure: () => false, windows, logger });
    // Stand in for the handlers settings:get etc. that ipc.init would add.
    ipcMain.handle("settings:get", () => ({ settings: settings.get(), defaults: settings.DEFAULTS, platform: process.platform, version: "0", hotkeyStatus: null, keyStorage: settings.keyStorage(), cleanupStyles: [] }));

    let SID = "";
    const win = windows.openSettings();
    await waitForLoad(win.webContents);
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await waitFor(() => js('document.getElementById("tools-card") && document.getElementById("tools-storage").textContent.length > 0'), "tools card did not load");

    // 1. Add a server through the real form. Its name is markup: it must show as text.
    const hostile = '<img src=x onerror="window.__pwned=1">Fixture';
    await js(`(() => {
      const set = (id, v) => { document.getElementById(id).value = v; };
      set("tools-name", ${JSON.stringify(hostile)});
      set("tools-command", "node"); // process.execPath is Electron here
      set("tools-args", ${JSON.stringify(FIXTURE)});
      set("tools-env", ${JSON.stringify(`FIXTURE_LOG=${LOG}\n!TOKEN=s3cret`)});
      document.getElementById("tools-save").click();
    })()`);
    await waitFor(() => js('document.querySelectorAll("#tools-list .field").length === 1'), "server was not added");
    SID = manager.view()[0].id;
    check("an added server is listed and its name renders as text, not markup",
      await js('document.querySelector("#tools-list strong").textContent.includes("<img") && !document.querySelector("#tools-list img") && !window.__pwned'));
    check("no tool is callable before Discover", (await tools.host.execute({ serverId: SID, tool: "echo", args: { message: "x" } })).ok === false && calls().length === 0);

    // 2. Discover from the UI, then enable `echo` with the ask policy.
    await js('Array.from(document.querySelectorAll("#tools-list button")).find((b) => b.textContent === "Discover tools").click()');
    await waitFor(() => js('document.querySelectorAll("#tools-list select").length > 5'), "tools were not discovered").catch(async (e) => { throw new Error(`${e.message}: ${await js('document.getElementById("tools-status").textContent + " | " + document.getElementById("tools-list").innerText')}`); });
    const serverEnabled = await js('(() => { const c = document.querySelector("#tools-list input[aria-label$=\\"enabled\\"]"); c.click(); return true; })()');
    await waitFor(() => manager.view()[0]?.enabled === true, "server did not enable");
    const rowOf = (name) => `Array.from(document.querySelectorAll("#tools-list .row")).find((r) => r.querySelector("span")?.textContent === ${JSON.stringify(name)})`;
    await js(`${rowOf("echo")}.querySelector("input[type=checkbox]").click()`);
    await waitFor(() => manager.view()[0].tools.find((t) => t.name === "echo").enabled, "echo did not enable");
    check("enabling a tool in Settings reaches main with the default Ask policy",
      manager.view()[0].tools.find((t) => t.name === "echo").policy === "ask" && serverEnabled);
    check("secret env values never reach the Settings page",
      !(await js("document.body.innerText")).includes("s3cret") && manager.view()[0].env.TOKEN.secret === true);
    check("a tool the user did not enable is absent from the model catalog", (await tools.host.catalog()).map((t) => t.tool).join() === "echo", JSON.stringify((await tools.host.catalog()).map((t) => t.tool)) + JSON.stringify(manager.view()[0].tools.map(t=>[t.name,t.enabled,t.policy])));

    // 3. The approval window: ask -> shown -> Deny.
    const approval = async () => {
      await waitFor(() => windows.getApprovalWindow(), "approval window did not open");
      const w = windows.getApprovalWindow();
      await waitForLoad(w.webContents).catch(() => {});
      return { w, run: (code) => w.webContents.executeJavaScript(code, true) };
    };
    const model = { serverId: SID, tool: "echo" };
    let pending = tools.host.execute({ ...model, args: { message: "<b>first</b>" } });
    let ap = await approval();
    await waitFor(() => ap.run('document.getElementById("request").hidden === false && document.getElementById("args").textContent.includes("first")'), "approval did not render");
    check("approval shows the request as text with a provenance label and Deny focused",
      await ap.run('document.getElementById("args").textContent.includes("<b>first</b>") && !document.querySelector("#args b") && document.getElementById("server").textContent.includes("<img") && document.getElementById("provenance").textContent.includes("Server-provided") && document.activeElement.id === "deny"'));
    await ap.run('document.getElementById("deny").click()');
    const denied = await pending;
    check("Deny never executes the tool", denied.ok === false && /denied/.test(denied.error) && calls().length === 0, JSON.stringify(denied));
    await waitFor(() => ap.w.isDestroyed(), "approval window did not close after the decision");

    // 4. Escape denies; closing the window denies; neither runs the tool.
    pending = tools.host.execute({ ...model, args: { message: "esc" } });
    ap = await approval();
    await waitFor(() => ap.run('!document.getElementById("request").hidden'), "approval did not render");
    ap.w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    ap.w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    check("Escape denies", (await pending).ok === false && calls().length === 0);

    pending = tools.host.execute({ ...model, args: { message: "closed" } });
    ap = await approval();
    ap.w.close();
    const closed = await pending;
    check("closing the approval window denies and runs nothing", closed.ok === false && /window closed/.test(closed.error) && calls().length === 0, JSON.stringify(closed));

    // 5. Allow runs exactly the displayed request, after the short guard delay.
    pending = tools.host.execute({ ...model, args: { message: "approved" } });
    ap = await approval();
    await waitFor(() => ap.run('!document.getElementById("allow").disabled'), "Allow never enabled");
    await ap.run('document.getElementById("allow").click()');
    const done = await pending;
    check("Allow executes the approved arguments once", done.ok && /echo: approved/.test(done.text) && calls().length === 1 && calls()[0].includes('"approved"'), JSON.stringify(done));

    // 6. Settings can't resolve approvals: its bridge has no approval channels,
    // and main refuses the sender even if it did.
    pending = tools.host.execute({ ...model, args: { message: "forged" } });
    await approval();
    const id = manager.broker.current().id;
    const viaSettings = await js(`(async () => { try { await window.earheart.invoke("approval:decide", { id: ${JSON.stringify(id)}, decision: "allow" }); return "resolved"; } catch (e) { return e.message; } })()`);
    check("the Settings window cannot approve a request", /Unknown channel/.test(viaSettings) && manager.broker.size() === 1, viaSettings);
    manager.broker.cancelAll("smoke cleanup");
    await pending;
    check("the forged request never ran", calls().length === 1);

    // 7. Shutdown stops the server.
    const pid = manager._clients.get(SID)?.client.pid;
    await tools.shutdown(2000);
    await sleep(200);
    let gone = true;
    try { process.kill(pid, 0); gone = false; } catch { /* exited */ }
    check("shutdown leaves no tool server process behind", pid && gone);

    const failed = checks.filter((c) => !c.ok);
    console.log(`[approval-smoke] ${checks.length - failed.length}/${checks.length} checks passed`);
    app.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.error("[approval-smoke] error:", err);
    app.exit(1);
  }
});
