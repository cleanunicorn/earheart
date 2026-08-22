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
//   5. The engine state badge follows the engine radio in both directions, and
//      swaps inside a live region so the privacy consequence is announced.
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
