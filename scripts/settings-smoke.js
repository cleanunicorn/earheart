// Drives the real settings window and verifies the service-panel contract —
// the interaction model text-parsing tests can't reach:
//
//   1. The panel is one continuous scroll: every section renders at once
//      (the scroll range is far taller than the viewport), none are
//      display:none-swapped.
//   2. The scroll spy works: scrolling to the bottom lights the last index
//      entry (Advanced) with .active + aria-current.
//   3. The index navigates: clicking General relights its lamp immediately
//      and glides the panel back to the top.
//   4. The roving tabindex is seated at load: exactly one index button is a
//      Tab stop before any interaction.
//
// Run under Electron:
//
//   xvfb-run -a npx electron scripts/settings-smoke.js --no-sandbox   # Linux
//   npx electron scripts/settings-smoke.js                            # macOS/Win

const { app, session } = require("electron");
const windows = require("../main/windows");
const ipc = require("../main/ipc");

// loadMicrophones() calls getUserMedia at init; the fake device keeps that
// deterministic on headless CI instead of hanging on a permission that will
// never arrive.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  const suffix = detail ? ` (${detail})` : "";
  console.log(`[settings-smoke] ${ok ? "ok  " : "FAIL"} ${name}${suffix}`);
}

app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
      cb(true)
    );
    ipc.init({
      applyHotkeys: () => ({ hotkey: { ok: true }, pauseHotkey: { ok: true } }),
      onSettingsChanged: () => {},
    });

    const win = windows.openSettings();
    await new Promise((r) => win.webContents.once("did-finish-load", r));
    // Let the init IPC round-trips (settings, models, history) settle.
    await sleep(1200);

    const js = (code) => win.webContents.executeJavaScript(code, true);

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
    check("no section is display:none-swapped", layout.hidden === 0, `${layout.hidden} hidden`);

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

    // 3. Index navigation: clicking General relights immediately (the lamp
    // is synchronous; the glide follows).
    const clicked = JSON.parse(
      await js(`
        (() => {
          document.getElementById("tabbtn-general").click();
          const active = document.querySelector(".tab.active");
          return JSON.stringify({ tab: active ? active.dataset.tab : null });
        })();
      `)
    );
    check("clicking the index relights its lamp", clicked.tab === "general");

    // The glide is asynchronous; wait for it to settle, then assert the
    // panel came back near the top (threshold, not 0 — scroll-margin leaves
    // a small offset).
    await sleep(1500);
    const top = await js(`document.querySelector("main").scrollTop`);
    check("clicking the index glides the panel back", top < 60, `scrollTop=${top}`);

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
