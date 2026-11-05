// Settings → Usage (#347), inside settings-smoke's real Electron app and
// throwaway profile: the seeded counts render, the time saved is labelled an
// estimate against the stated baseline, a counted take shows up live, Reset
// empties the file on disk, and the switch and baseline save.
const fs = require("node:fs");
const path = require("node:path");
const windows = require("../main/windows");
const settings = require("../main/settings");
const usage = require("../main/usage");
const { waitForLoad } = require("./wait-for-load");

// Written before anything reads usage.json (main/usage.js caches the first
// load): two days of counts, today and yesterday.
function seedUsage(userData) {
  const today = usage.localDayKey(new Date());
  const yesterday = usage.addDays(today, -1);
  fs.writeFileSync(
    path.join(userData, "usage.json"),
    JSON.stringify({
      version: 1,
      since: yesterday,
      totals: { takes: 12, words: 1840, speechMs: 731000 },
      days: {
        [yesterday]: { takes: 5, words: 610, speechMs: 240000 },
        [today]: { takes: 7, words: 1230, speechMs: 491000 },
      },
    })
  );
}

const digits = (s) => String(s).replace(/\D/g, "");

async function checkUsage({ waitFor, check, savedThenClose, userData }) {
  const before = settings.get();
  const win = windows.openSettings();
  try {
    await waitForLoad(win.webContents);
    const run = (code) => win.webContents.executeJavaScript(code, true);
    await waitFor(() => run(`document.querySelectorAll("#usage-days li").length === 14`), "Usage did not render its 14 days");
    const shown = await run(`JSON.stringify({
      takes: document.getElementById("usage-takes").textContent,
      words: document.getElementById("usage-words").textContent,
      speech: document.getElementById("usage-speech").textContent,
      wpm: document.getElementById("usage-wpm").textContent,
      streak: document.getElementById("usage-streak").textContent,
      saved: document.getElementById("usage-saved").textContent,
      note: document.getElementById("usage-estimate-note").textContent,
      label: [...document.querySelectorAll("#tab-usage dt")].map((dt) => dt.textContent),
      firstDay: document.querySelector("#usage-days li .usage-day-words").textContent,
      barWidth: document.querySelector("#usage-days li .usage-day-fill").style.width,
      emptyHidden: document.getElementById("usage-empty").hidden,
      since: document.getElementById("usage-since").textContent,
      switchOn: document.getElementById("usage-enabled").checked,
      wpmField: document.getElementById("typing-wpm").value,
    })`).then(JSON.parse);
    // 1840 words over 731 s: 151 WPM. Typing them at 40 WPM takes 46 min;
    // minus 12 min 11 s of speaking, ≈ 34 min saved.
    check(
      "Usage shows the saved totals, speed and streak",
      digits(shown.takes) === "12" && digits(shown.words) === "1840" && shown.speech === "12 min" &&
        shown.wpm === "151 WPM" && shown.streak === "2 days" && shown.emptyHidden === true && /^Counting since /.test(shown.since),
      JSON.stringify(shown)
    );
    check(
      "Usage labels the time saved an estimate and states the 40 WPM baseline",
      shown.saved === "≈ 34 min" && shown.label.includes("Time saved (estimate)") &&
        /Estimate: typing these words at 40 WPM/.test(shown.note) && /Not measured/.test(shown.note) && shown.wpmField === "40",
      JSON.stringify(shown)
    );
    check(
      "Usage lists today first with its words in text beside a full bar",
      digits(shown.firstDay) === "1230" && shown.barWidth === "100%" && shown.switchOn === true,
      JSON.stringify(shown)
    );

    // Reset: confirmed, written to disk, and the screen follows.
    await run(`window.confirm = (m) => ((window.lastConfirm = m), true); document.getElementById("usage-reset").click(); true`);
    await waitFor(() => run(`document.getElementById("usage-takes").textContent === "0"`), "Reset did not empty the shown counts");
    const onDisk = JSON.parse(fs.readFileSync(path.join(userData, "usage.json"), "utf8"));
    const afterReset = await run(`JSON.stringify({
      question: window.lastConfirm,
      empty: !document.getElementById("usage-empty").hidden,
      saved: document.getElementById("usage-saved").textContent,
      status: document.getElementById("usage-reset-status").hidden,
    })`).then(JSON.parse);
    check(
      "Reset statistics asks first, empties usage.json and shows the empty state",
      afterReset.question === "Reset usage statistics? Counts start again from today. Transcripts and History are not affected." &&
        onDisk.totals.takes === 0 && onDisk.totals.words === 0 && Object.keys(onDisk.days).length === 0 &&
        afterReset.empty && afterReset.saved === "—" && afterReset.status,
      JSON.stringify({ afterReset, onDisk })
    );

    // A take counted in main reaches the open window (usage:changed).
    usage.record({ takeId: "usage-smoke", words: 9, speechMs: 4000 }, settings.get().usage);
    await waitFor(() => run(`document.getElementById("usage-takes").textContent === "1"`), "a counted take did not reach Settings");
    check("a counted take appears in Settings without reopening it", true);

    // Turning counting off and changing the baseline save; the estimate follows.
    await run(`(() => {
      const sw = document.getElementById("usage-enabled");
      sw.click();
      const field = document.getElementById("typing-wpm");
      field.value = "60";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const hint = await run(`!document.getElementById("usage-off-hint").hidden`);
    await run(`document.getElementById("save").click(); true`);
    await waitFor(() => run(`document.getElementById("usage-baseline").textContent === "60"`), "the new baseline did not reach the estimate");
    await savedThenClose(win, "Usage settings Save did not report Saved");
    const saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).usage;
    check(
      "the Usage switch and typing speed save, and off says earlier numbers are kept",
      hint === true && saved.enabled === false && saved.typingWpm === 60,
      JSON.stringify({ hint, saved })
    );
    check("with counting off, a take is not counted", usage.record({ takeId: "usage-smoke-2", words: 1, speechMs: 1000 }, settings.get().usage) === false);
  } finally {
    if (!win.isDestroyed()) windows.closeSettings();
    const now = settings.get();
    settings.save({ ...now, usage: before.usage });
  }
}

module.exports = { seedUsage, checkUsage };
