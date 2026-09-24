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
//      gone by the time History is reopened.
//  10. A model download keeps progress through redraws, exposes a focused
//      cancel action, and announces terminal success in the persistent region.
//  11. Wizard-started downloads survive Settings model changes without
//      overwriting a concurrent download's state.
//
// Run under Electron:
//
//   xvfb-run -a npx electron scripts/settings-smoke.js --no-sandbox   # Linux
//   npx electron scripts/settings-smoke.js                            # macOS/Win

const { app, session } = require("electron");
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

const windows = require("../main/windows");
const history = require("../main/history");
const ipc = require("../main/ipc");
const engines = require("../main/engines");
const { registry } = engines;

// loadMicrophones() calls getUserMedia at init; the fake device keeps that
// deterministic on headless CI instead of hanging on a permission that will
// never arrive.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(message);
}

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
    const downloads = new Map();
    const installedModels = new Set();
    const isInstalled = engines.isInstalled;
    engines.isInstalled = (kind, modelId) =>
      installedModels.has(`${kind}:${modelId}`) || isInstalled(kind, modelId);
    engines.download = (kind, modelId, { onProgress }) =>
      new Promise((resolve, reject) => {
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
    history.add({ raw: "whole dictation", text: "whole dictation", cleaned: false, delivered: "paste" }, historyCfg);
    history.add(
      { raw: "recovered words", text: "recovered words", cleaned: false, delivered: "paste", incomplete: true },
      historyCfg
    );

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
    let top = await js(`document.querySelector("main").scrollTop`);
    for (let attempt = 0; attempt < 30 && top >= 60; attempt++) {
      await sleep(100);
      top = await js(`document.querySelector("main").scrollTop`);
    }
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

    // 10-11. Drive the real renderer state machine while the IPC download
    // promise is held open, so no model files or network are involved.
    const downloadModels = await js(`JSON.stringify({
      stt: [...document.getElementById("stt-builtin-model").options].map((o) => o.value),
      cleanup: [...document.getElementById("cleanup-builtin-model").options].map((o) => o.value),
    })`).then(JSON.parse);
    const sttModel = downloadModels.stt.find((id) => id !== "parakeet-tdt-0.6b-v3-int8");
    const sttDefault = "parakeet-tdt-0.6b-v3-int8";
    const cleanupModel = downloadModels.cleanup.find((id) => id !== "granite-4.0-micro");
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
      };
    })()`).then((s) => (typeof s === "string" ? JSON.parse(s) : s));
    check(
      "progress from an external download survives switching model selections",
      switchedProgress.width === "42%" && switchedProgress.status.startsWith("42%"),
      JSON.stringify(switchedProgress)
    );

    const wizard = windows.openWizard();
    await new Promise((resolve) => wizard.webContents.once("did-finish-load", resolve));
    await wizard.webContents.executeJavaScript(
      `earheart.invoke("models:download", { kind: "cleanup", modelId: ${JSON.stringify(cleanupModel)} }); "started"`,
      true
    );
    const wizardDownload = await waitFor(
      () => downloads.get(`cleanup:${cleanupModel}`),
      "wizard download did not reach the engine"
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
    await js(`(() => {
      const select = document.getElementById("cleanup-builtin-model");
      select.value = "granite-4.0-micro";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);

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
    check(
      "Settings preselects the default cleanup model on a fresh profile",
      settingsPick.value === cleanupDefault.id,
      JSON.stringify(settingsPick)
    );
    const wizardForDefaults = windows.openWizard();
    await new Promise((r) => wizardForDefaults.webContents.once("did-finish-load", r));
    await sleep(1200);
    const wizardPick = await readCleanupPick(wizardForDefaults.webContents);
    const wizardNote = await wizardForDefaults.webContents.executeJavaScript(
      `document.getElementById("cleanup-builtin-note").textContent`,
      true
    );
    windows.closeWizard();
    check(
      "the wizard preselects the default cleanup model on a fresh profile",
      wizardPick.value === cleanupDefault.id,
      JSON.stringify(wizardPick)
    );
    check(
      "the wizard shows the default cleanup model's note",
      wizardNote === cleanupDefault.note,
      JSON.stringify(wizardNote)
    );

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
