// Settings → Usage (#347): the local usage counts main keeps in usage.json
// (main/usage.js). Counts only — no transcript text ever reaches this page
// through these channels. A classic script loaded before settings.js; the
// enabled switch and typing-speed field are saved by settings.js's collect()
// like any other setting. Text goes in with textContent only, and bar widths
// through the CSSOM (the CSP blocks inline style attributes).

// "2 h 41 min", "12 min", "45 s" — whole units, never "0 h".
function usageFormatDuration(ms) {
  const totalSec = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  if (totalSec < 60) return `${totalSec} s`;
  const totalMin = Math.round(totalSec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function usageFormatCount(n) {
  return (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString();
}

const usagePlural = (n, one, many) => `${usageFormatCount(n)} ${n === 1 ? one : many}`;

// A YYYY-MM-DD day key as a local date (never parsed as UTC midnight).
function usageDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// The text of every figure in the section, from a summary (main/usage.js
// summarize). Pure, so the unit tests can pin the wording.
function usageView(summary) {
  const t = summary.totals;
  const longest = summary.streak.longest;
  const current = summary.streak.current;
  return {
    empty: t.takes === 0,
    takes: usageFormatCount(t.takes),
    words: usageFormatCount(t.words),
    speech: usageFormatDuration(t.speechMs),
    wpm: summary.avgWpm === null ? "—" : `${usageFormatCount(summary.avgWpm)} WPM`,
    streak: longest > current ? `${usagePlural(current, "day", "days")} (best ${usageFormatCount(longest)})` : usagePlural(current, "day", "days"),
    saved: summary.timeSavedMs === null ? "—" : `≈ ${usageFormatDuration(summary.timeSavedMs)}`,
    baseline: String(summary.typingWpm),
    readOnly:
      summary.readOnly === "newer"
        ? "Saved by a newer version of Earheart; not updating these numbers."
        : summary.readOnly
          ? "The usage file couldn't be read; not updating these numbers."
          : "",
    since: summary.since
      ? `Counting since ${usageDate(summary.since).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}.`
      : "",
  };
}

(function initUsageStats() {
  if (typeof document === "undefined" || typeof earheart === "undefined") return;
  const el = (id) => document.getElementById(id);
  if (!el("tab-usage")) return;

  function renderDays(days) {
    const list = el("usage-days");
    const most = Math.max(1, ...days.map((d) => d.words));
    const rows = days.map((day) => {
      const li = document.createElement("li");
      li.className = "usage-day";
      const date = document.createElement("span");
      date.className = "usage-day-date";
      date.textContent = usageDate(day.date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const track = document.createElement("span");
      track.className = "usage-day-track";
      track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.className = "usage-day-fill";
      fill.style.width = `${Math.round((day.words / most) * 100)}%`;
      track.append(fill);
      const words = document.createElement("span");
      words.className = "usage-day-words";
      words.textContent = usagePlural(day.words, "word", "words");
      li.append(date, track, words);
      return li;
    });
    list.replaceChildren(...rows);
  }

  function render(summary) {
    const view = usageView(summary);
    el("usage-empty").hidden = !view.empty;
    el("usage-readonly").hidden = !view.readOnly;
    el("usage-readonly").textContent = view.readOnly;
    el("usage-takes").textContent = view.takes;
    el("usage-words").textContent = view.words;
    el("usage-speech").textContent = view.speech;
    el("usage-wpm").textContent = view.wpm;
    el("usage-streak").textContent = view.streak;
    el("usage-saved").textContent = view.saved;
    el("usage-baseline").textContent = view.baseline;
    el("usage-since").textContent = view.since;
    renderDays(summary.days);
  }

  let refreshing = 0;
  async function refresh() {
    const ticket = ++refreshing;
    let res;
    try {
      res = await earheart.invoke("usage:get");
    } catch {
      return; // the numbers on screen stay; nothing here is worth an error
    }
    if (ticket !== refreshing || !res?.ok) return;
    render(res.summary);
  }

  function syncOffHint() {
    el("usage-off-hint").hidden = el("usage-enabled").checked;
  }

  el("usage-enabled").addEventListener("change", syncOffHint);
  el("usage-reset").addEventListener("click", async () => {
    if (!confirm("Reset usage statistics? Counts start again from today. Transcripts and History are not affected.")) return;
    const status = el("usage-reset-status");
    status.textContent = ""; // emptied first, so a repeat failure is announced again
    let res;
    try {
      res = await earheart.invoke("usage:reset");
    } catch (err) {
      res = { ok: false, error: err?.message || String(err) };
    }
    status.hidden = res?.ok !== false;
    if (!status.hidden) status.textContent = `Could not reset: ${res.error}`;
    refresh();
  });

  // A counted take or a reset; and any saved settings change (a new typing
  // baseline recomputes the estimate, the switch shows what was saved).
  earheart.on("usage:changed", refresh);
  earheart.on("settings:changed", () => {
    refresh();
    syncOffHint();
  });
  refresh();
})();

// Exported for unit tests only (permission-status.js pattern).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { usageFormatDuration, usageFormatCount, usageView };
}
