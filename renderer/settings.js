// Settings window renderer.

let current = null; // settings object being edited
let defaults = null;
let platform = "linux";
let modelStatus = null; // { stt: [...], cleanup: [...] } from the main process
let cleanupStyles = []; // [{ id, label, hint }] — the cleanup style slider stops

const $ = (id) => document.getElementById(id);

/* ---------- section index ---------- */

// Every section sits on one scrolling page; the index on the left
// only navigates. Its highlight tracks the section currently in view (scroll
// spy), and clicking an entry glides the panel to that section (the easing
// comes from CSS scroll-behavior, which prefers-reduced-motion collapses).
// Roving tabindex keeps the index a single tab stop; arrows move within it.
const tabButtons = [...document.querySelectorAll(".tab")];
const panels = [...document.querySelectorAll(".panel")];
const panelHost = document.querySelector("main");

// Which index entry is lit — no scrolling. aria-current (not aria-selected):
// the index is navigation within one page, not a tablist swapping panels.
function markActiveTab(name) {
  for (const t of tabButtons) {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    if (on) t.setAttribute("aria-current", "true");
    else t.removeAttribute("aria-current");
    t.tabIndex = on ? 0 : -1;
  }
}

// While a click-initiated glide is in flight, the spy would highlight every
// entry the scroll passes through; hold the chosen one until the scroll settles.
let spyHeld = false;

// `focus` keeps focus on the index button (arrow-key roving); `focusSection`
// commits focus into the section itself (click/Enter activation) so the next
// Tab continues from the jumped-to section instead of the top of the page —
// all sections are always in the DOM now, so without this the index saves
// keyboard users nothing.
function activateTab(name, { focus = false, focusSection = false } = {}) {
  markActiveTab(name);
  if (focus) tabButtons.find((t) => t.dataset.tab === name)?.focus();
  const section = panels.find((p) => p.id === `tab-${name}`);
  if (!section) return;
  // Where this glide will land: the section's top under the 12px
  // scroll-margin, clamped to the scrollable range. If we're already there,
  // no scroll (and no scrollend to release the hold) will happen — so only
  // hold the highlight when a glide is actually coming.
  const target = Math.max(
    0,
    Math.min(
      section.offsetTop - panelHost.offsetTop - 12,
      panelHost.scrollHeight - panelHost.clientHeight
    )
  );
  spyHeld = Math.abs(panelHost.scrollTop - target) > 1;
  section.scrollIntoView({ block: "start" });
  // preventScroll: the glide above owns the motion; focus() must not fight
  // it with its own instant scroll.
  if (focusSection) {
    section.querySelector(".legend")?.focus({ preventScroll: true });
  }
}

// The user scrolling over a held glide takes the highlight back immediately.
panelHost.addEventListener("wheel", () => (spyHeld = false), { passive: true });
panelHost.addEventListener("touchstart", () => (spyHeld = false), {
  passive: true,
});

// The section whose top has passed the read line (a small offset under the
// panel's top edge) is the current one; hitting the end of the scroll always
// highlights the last entry, which could otherwise never reach the line.
// Panel ids are `tab-<name>`; the index buttons carry the bare name.
const sectionName = (panel) => panel.id.replace(/^tab-/, "");

function spySections() {
  if (spyHeld) return;
  const fromTop = panelHost.scrollTop;
  const atEnd =
    fromTop + panelHost.clientHeight >= panelHost.scrollHeight - 4;
  let name = panels[0] ? sectionName(panels[0]) : null;
  if (atEnd) {
    name = sectionName(panels[panels.length - 1]);
  } else {
    for (const p of panels) {
      if (p.offsetTop - panelHost.offsetTop - 40 <= fromTop) {
        name = sectionName(p);
      }
    }
  }
  if (name) markActiveTab(name);
}

panelHost.addEventListener("scroll", spySections, { passive: true });
panelHost.addEventListener("scrollend", () => {
  spyHeld = false;
  spySections();
});

tabButtons.forEach((tab, i) => {
  // Click covers Enter/Space on the focused button too (native semantics).
  tab.addEventListener("click", () =>
    activateTab(tab.dataset.tab, { focusSection: true })
  );
  tab.addEventListener("keydown", (event) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabButtons[(i + step + tabButtons.length) % tabButtons.length];
    activateTab(next.dataset.tab, { focus: true });
  });
});

// Seat the roving tabindex before any interaction: without this, every index
// button is its own Tab stop until the first click or scroll runs
// markActiveTab (native buttons default to tabIndex 0).
markActiveTab("general");

/* ---------- hotkey capture (wiring shared via hotkey-capture.js) ---------- */

const hotkeyInput = $("hotkey");
wireHotkeyCapture(hotkeyInput, {
  apply: (accelerator) => {
    current.hotkey = accelerator;
    hotkeyInput.value = accelerator;
  },
  restore: () => current?.hotkey || "",
});
$("hotkey-clear").addEventListener("click", () => {
  current.hotkey = defaults.hotkey;
  hotkeyInput.value = defaults.hotkey;
});

// The pause hotkey is optional: Clear unbinds it entirely (empty = not
// registered) rather than resetting to a default.
const pauseHotkeyInput = $("pause-hotkey");
wireHotkeyCapture(pauseHotkeyInput, {
  apply: (accelerator) => {
    current.pauseHotkey = accelerator;
    pauseHotkeyInput.value = accelerator;
  },
  restore: () => current?.pauseHotkey || "",
});
$("pause-hotkey-clear").addEventListener("click", () => {
  current.pauseHotkey = "";
  pauseHotkeyInput.value = "";
});

/* ---------- microphone list ---------- */

async function loadMicrophones() {
  const select = $("mic-device");
  // Show the saved device immediately so saving before (or without)
  // enumeration never silently resets the microphone choice.
  if (current.audio.deviceId) {
    const saved = document.createElement("option");
    saved.value = current.audio.deviceId;
    saved.textContent = "Configured microphone";
    select.appendChild(saved);
    select.value = current.audio.deviceId;
  }
  try {
    // Ask for permission once so device labels are populated.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "default")
      .forEach((d) => {
        const existing = select.querySelector(`option[value="${CSS.escape(d.deviceId)}"]`);
        if (existing) {
          existing.textContent = d.label || existing.textContent;
          return;
        }
        const option = document.createElement("option");
        option.value = d.deviceId;
        option.textContent = d.label || `Microphone ${select.length}`;
        select.appendChild(option);
      });
    select.value = current.audio.deviceId || "";
  } catch {
    // No microphone permission/device; leave "System default".
  }
}

/* ---------- populate / collect ---------- */

function populate() {
  hotkeyInput.value = current.hotkey;
  pauseHotkeyInput.value = current.pauseHotkey || "";
  // Legacy settings expressed "paste & keep on clipboard" as paste mode with
  // clipboard restore turned off; show those as the explicit paste-copy mode.
  const mode =
    current.output.mode === "paste" && !current.output.restoreClipboard
      ? "paste-copy"
      : current.output.mode;
  (
    document.querySelector(`input[name="output-mode"][value="${mode}"]`) ||
    document.querySelector('input[name="output-mode"][value="paste"]')
  ).checked = true;

  $("stt-url").value = current.stt.baseUrl;
  $("stt-key").value = current.stt.apiKey;
  $("stt-model").value = current.stt.model;
  $("stt-language").value = current.stt.language;
  selectEngine("stt", current.stt.engine);
  $("stt-builtin-model").value = current.stt.builtin.model;
  $("stt-live-preview").checked = current.stt.livePreview?.enabled ?? true;

  $("cleanup-enabled").checked = current.cleanup.enabled;
  $("cleanup-url").value = current.cleanup.baseUrl;
  $("cleanup-key").value = current.cleanup.apiKey;
  $("cleanup-model").value = current.cleanup.model;
  populateCleanupStyle();
  $("cleanup-dictionary").value = (current.cleanup.dictionary || []).join("\n");
  $("cleanup-prompt").value = current.cleanup.systemPrompt;
  selectEngine("cleanup", current.cleanup.engine);
  $("cleanup-builtin-model").value = current.cleanup.builtin.model;
  syncCleanupEnabled();
  syncEngine("stt");
  syncEngine("cleanup");

  const reviewMode = current.review?.mode || "off";
  (
    document.querySelector(`input[name="review-mode"][value="${reviewMode}"]`) ||
    document.querySelector('input[name="review-mode"][value="off"]')
  ).checked = true;
  $("review-min-chars").value = current.review?.minChars ?? 400;
  syncReviewMode();

  $("start-on-boot").checked = !!current.startOnBoot;

  $("history-enabled").checked = current.history.enabled;
  $("updates-autocheck").checked = current.updates?.autoCheck !== false;
  $("updates-remind").checked = current.updates?.remind !== false;
  $("max-seconds").value = current.audio.maxRecordingSeconds;
  $("idle-unload").value = current.engines?.idleUnloadMinutes ?? 2;

  if (platform !== "linux") {
    $("wayland-note").style.display = "none";
    $("pause-wayland-note").style.display = "none";
  }
}

function collect() {
  return {
    ...current,
    hotkey: current.hotkey,
    pauseHotkey: current.pauseHotkey || "",
    startOnBoot: $("start-on-boot").checked,
    updates: {
      ...current.updates,
      autoCheck: $("updates-autocheck").checked,
      remind: $("updates-remind").checked,
    },
    output: {
      ...current.output,
      mode: document.querySelector('input[name="output-mode"]:checked').value,
      // Legacy files could hold restoreClipboard: false from the era when
      // that was the only way to keep the transcript on the clipboard; the
      // explicit paste-copy mode replaces it, so plain paste always restores.
      restoreClipboard: true,
    },
    review: {
      ...current.review,
      mode:
        document.querySelector('input[name="review-mode"]:checked')?.value ||
        "off",
      // Preserved even while the mode is "off"/"always" so flipping back to
      // "length" keeps the user's threshold.
      minChars: Math.max(0, parseInt($("review-min-chars").value, 10) || 400),
    },
    stt: {
      ...current.stt,
      engine: engineValue("stt"),
      builtin: { ...current.stt.builtin, model: $("stt-builtin-model").value },
      baseUrl: $("stt-url").value.trim(),
      apiKey: $("stt-key").value.trim(),
      model: $("stt-model").value.trim(),
      language: $("stt-language").value.trim(),
      // Preserve the live-preview tuning (interval, caps); only the toggle is
      // surfaced in the UI.
      livePreview: {
        ...current.stt.livePreview,
        enabled: $("stt-live-preview").checked,
      },
    },
    cleanup: {
      ...current.cleanup,
      enabled: $("cleanup-enabled").checked,
      engine: engineValue("cleanup"),
      builtin: { ...current.cleanup.builtin, model: $("cleanup-builtin-model").value },
      baseUrl: $("cleanup-url").value.trim(),
      apiKey: $("cleanup-key").value.trim(),
      model: $("cleanup-model").value.trim(),
      ...collectCleanupStyle(),
      // One term per line in the textarea; stored as an array of trimmed,
      // non-empty lines.
      dictionary: $("cleanup-dictionary")
        .value.split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
      systemPrompt: $("cleanup-prompt").value,
    },
    audio: {
      ...current.audio,
      deviceId: $("mic-device").value,
      maxRecordingSeconds: parseInt($("max-seconds").value, 10) || 300,
    },
    engines: {
      ...current.engines,
      // 0 (or blank) = never unload; otherwise the idle window in minutes.
      idleUnloadMinutes: Math.max(0, parseInt($("idle-unload").value, 10) || 0),
    },
    history: {
      ...current.history,
      enabled: $("history-enabled").checked,
    },
  };
}

function syncCleanupEnabled() {
  const on = $("cleanup-enabled").checked;
  const fields = $("cleanup-fields");
  fields.classList.toggle("disabled", !on);
  // The .disabled class dims and sets pointer-events:none, which blocks the
  // mouse but leaves the controls in the tab order; `inert` also removes them
  // from keyboard focus and the accessibility tree so the visual and real
  // interactivity match.
  fields.inert = !on;
}
$("cleanup-enabled").addEventListener("change", syncCleanupEnabled);

// The character threshold only means something in "length" mode; same
// dim+inert treatment as the cleanup fields so keyboard focus matches.
function syncReviewMode() {
  const mode =
    document.querySelector('input[name="review-mode"]:checked')?.value || "off";
  const field = $("review-threshold-field");
  const on = mode === "length";
  field.classList.toggle("disabled", !on);
  field.inert = !on;
}
for (const radio of document.querySelectorAll('input[name="review-mode"]')) {
  radio.addEventListener("change", syncReviewMode);
}

/* ---------- cleanup style: preset slider vs custom sampling ---------- */

// A segmented control picks the mode. "Preset" shows the slider (verbatim →
// clean → polished); "Custom values" shows the raw sampling fields. Only the
// active mode's controls are visible, so switching is one click.
function styleMode() {
  const el = document.querySelector('input[name="cleanup-style-mode"]:checked');
  return el ? el.value : "preset";
}

function setStyleMode(mode) {
  const el = document.querySelector(`input[name="cleanup-style-mode"][value="${mode}"]`);
  if (el) el.checked = true;
}

function populateCleanupStyle() {
  const c = current.cleanup;
  setStyleMode(c.style === "custom" ? "custom" : "preset");

  let idx = cleanupStyles.findIndex((s) => s.id === c.style);
  if (idx < 0) idx = cleanupStyles.findIndex((s) => s.id === "clean");
  if (idx < 0) idx = 0;
  $("cleanup-style").value = String(idx);

  const custom = c.custom || {};
  $("cleanup-temperature").value = custom.temperature ?? "";
  $("cleanup-top-p").value = custom.topP ?? "";
  $("cleanup-top-k").value = custom.topK ?? "";
  $("cleanup-min-p").value = custom.minP ?? "";

  renderStyleLabel();
  syncStyleMode();
}

function renderStyleLabel() {
  const idx = parseInt($("cleanup-style").value, 10) || 0;
  const style = cleanupStyles[idx];
  if (!style) return;
  $("cleanup-style-label").textContent = style.label;
  $("cleanup-style-hint").textContent = style.hint;
  // Without this the slider announces bare "0/1/2" to screen readers.
  $("cleanup-style").setAttribute("aria-valuetext", `${style.label} — ${style.hint}`);
  // The custom pane's seed button tracks the slider's last position, which
  // persists while the preset pane is hidden.
  $("cleanup-custom-from-preset").textContent = `Start from preset: ${style.label}`;
}

// Show only the active mode's controls; `hidden` also removes the inactive
// ones from the tab order and accessibility tree.
function syncStyleMode() {
  const custom = styleMode() === "custom";
  $("cleanup-style-preset").hidden = custom;
  $("cleanup-style-custom").hidden = !custom;
}

// Clamp a parsed number into [min, max], falling back when the field is blank
// or unparseable so a stray entry never writes NaN into settings.
function num(id, min, max, fallback) {
  const v = parseFloat($(id).value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function collectCleanupStyle() {
  const idx = parseInt($("cleanup-style").value, 10) || 0;
  const style = styleMode() === "custom" ? "custom" : cleanupStyles[idx]?.id || "clean";
  // A blanked field falls back to its saved value, not a neutral constant —
  // clearing a box must never silently change behaviour on save.
  const cur = current.cleanup.custom || {};
  return {
    style,
    custom: {
      temperature: num("cleanup-temperature", 0, 2, cur.temperature ?? 0.2),
      topP: num("cleanup-top-p", 0, 1, cur.topP ?? 1),
      topK: Math.round(num("cleanup-top-k", 0, 200, cur.topK ?? 0)),
      minP: num("cleanup-min-p", 0, 1, cur.minP ?? 0),
    },
  };
}

$("cleanup-style").addEventListener("input", renderStyleLabel);
document
  .querySelectorAll('input[name="cleanup-style-mode"]')
  .forEach((r) => r.addEventListener("change", syncStyleMode));

// Seed the custom fields from the preset the slider points at, so tweaking
// can start from a known-good profile instead of whatever was last saved.
$("cleanup-custom-from-preset").addEventListener("click", () => {
  const idx = parseInt($("cleanup-style").value, 10) || 0;
  const sampling = cleanupStyles[idx]?.sampling;
  if (!sampling) return;
  $("cleanup-temperature").value = sampling.temperature;
  $("cleanup-top-p").value = sampling.topP;
  $("cleanup-top-k").value = sampling.topK;
  $("cleanup-min-p").value = sampling.minP;
});

/* ---------- built-in engines + model management ---------- */

// The settings UI offers a simple Built-in / External choice; anything that
// isn't the in-process engine routes through the "remote" OpenAI-compatible
// path, so the external option always maps to "remote".
function engineValue(kind) {
  const v = document.querySelector(`input[name="${kind}-engine"]:checked`).value;
  return v === "builtin" ? "builtin" : "remote";
}

function selectEngine(kind, engine) {
  const v = engine === "builtin" ? "builtin" : "external";
  const radio = document.querySelector(`input[name="${kind}-engine"][value="${v}"]`);
  if (radio) radio.checked = true;
}

function syncEngine(kind) {
  const builtin =
    document.querySelector(`input[name="${kind}-engine"]:checked`).value === "builtin";
  $(`${kind}-builtin-fields`).hidden = !builtin;
  $(`${kind}-external-fields`).hidden = builtin;
  if (kind === "cleanup") $("cleanup-test-row").hidden = builtin;
  renderManage(kind);
}

function populateModelSelect(kind) {
  const select = $(`${kind}-builtin-model`);
  select.replaceChildren();
  for (const m of modelStatus[kind]) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = m.label;
    select.appendChild(option);
  }
}

// Per-kind handles to the live progress bar / status so download progress
// events can find their row.
const manage = { stt: {}, cleanup: {} };

function renderManage(kind) {
  const container = $(`${kind}-model-manage`);
  if (!container || !modelStatus) return;
  const modelId = $(`${kind}-builtin-model`).value;
  const info = modelStatus[kind].find((m) => m.id === modelId);
  container.replaceChildren();
  manage[kind] = { modelId };
  if (!info) return;

  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = info.note;

  const bar = document.createElement("div");
  bar.className = "dl-bar";
  bar.hidden = true;
  const fill = document.createElement("div");
  fill.className = "dl-fill";
  bar.appendChild(fill);

  const row = document.createElement("div");
  row.className = "row";
  const status = document.createElement("span");
  status.className = "status";
  const btn = document.createElement("button");
  const ui = { modelId, bar, fill, status, btn };

  if (info.installed) {
    status.textContent = "Downloaded ✓";
    status.className = "status ok";
    btn.textContent = "Remove";
    btn.className = "ghost danger";
    // For a custom model "Remove" also forgets its definition, since there's no
    // curated reason to keep an un-downloaded custom entry around.
    btn.onclick = () =>
      info.custom ? removeCustomModel(modelId) : removeModel(kind, modelId);
  } else {
    status.textContent = "Not downloaded";
    btn.textContent = "Download";
    btn.className = "ghost";
    btn.onclick = () => downloadModel(kind, modelId, ui);
  }
  row.append(btn, status);
  // A custom model that isn't downloaded still needs a way off the list.
  if (info.custom && !info.installed) {
    const forget = document.createElement("button");
    forget.textContent = "Remove from list";
    forget.className = "ghost danger";
    forget.onclick = () => removeCustomModel(modelId);
    row.append(forget);
  }
  container.append(note, bar, row);
  manage[kind] = ui;
}

// Terminal download outcomes announce through one persistent sr-only live
// region: the visible per-row span is rebuilt by renderManage
// (replaceChildren), and a live region's initial content on insertion is
// not announced — so the row itself can never speak.
function announceDownload(kind, modelId, message) {
  const info = modelStatus?.[kind]?.find((m) => m.id === modelId);
  $("model-dl-announce").textContent = `${info ? info.label : modelId}: ${message}`;
}

async function downloadModel(kind, modelId, ui) {
  // While the download runs, the same button cancels it (the wizard offers the
  // same escape; without it a multi-minute download in Settings is a one-way
  // trip). models:cancel aborts the in-flight transfer in the main process.
  ui.bar.hidden = false;
  ui.status.textContent = "Downloading…";
  ui.status.className = "status";
  const onCancel = () => earheart.invoke("models:cancel", { kind, modelId });
  ui.btn.textContent = "Cancel";
  ui.btn.className = "ghost";
  ui.btn.onclick = onCancel;

  const res = await earheart.invoke("models:download", { kind, modelId });
  ui.btn.onclick = null;
  if (res.ok) {
    await refreshModels();
    announceDownload(kind, modelId, "Downloaded ✓");
    return;
  }
  // Failed or cancelled: revert to a download affordance the user can retry.
  ui.bar.hidden = true;
  ui.btn.textContent = res.cancelled ? "Download" : "Retry download";
  ui.btn.className = "ghost";
  ui.btn.onclick = () => downloadModel(kind, modelId, ui);
  ui.status.textContent = res.cancelled ? "Cancelled" : res.error || "Download failed";
  ui.status.className = res.cancelled ? "status" : "status err";
  announceDownload(kind, modelId, ui.status.textContent);
}

async function removeModel(kind, modelId) {
  const info = modelStatus[kind].find((m) => m.id === modelId);
  const label = info ? info.label : modelId;
  if (!confirm(`Remove ${label}? You'll need to download it again to use it.`)) {
    return;
  }
  await earheart.invoke("models:remove", { kind, modelId });
  await refreshModels();
}

// Remove a custom model entirely: its files (if downloaded) and its definition.
async function removeCustomModel(modelId) {
  const info = [...modelStatus.stt, ...modelStatus.cleanup].find((m) => m.id === modelId);
  const label = info ? info.label : modelId;
  if (!confirm(`Remove ${label} from your models?`)) return;
  const res = await earheart.invoke("models:remove-custom", { modelId });
  if (res.ok) current.customModels = res.customModels;
  await refreshModels();
}

// Re-pull model status and rebuild the dropdowns (custom models may have been
// added or removed), keeping the current selection — or a `preferred` id per
// kind, e.g. to select a model that was just added.
async function refreshModels(preferred = {}) {
  modelStatus = await earheart.invoke("models:status");
  for (const kind of ["stt", "cleanup"]) {
    const select = $(`${kind}-builtin-model`);
    const want = preferred[kind] || select.value || current[kind].builtin.model;
    populateModelSelect(kind);
    select.value = modelStatus[kind].some((m) => m.id === want)
      ? want
      : current[kind].builtin.model;
  }
  renderManage("stt");
  renderManage("cleanup");
}

// "42% · 280 MB / 660 MB" — concrete progress so a slow download reads as
// working, not stalled.
function progressLabel({ received, total, fraction }) {
  const pct = Math.round((fraction ?? (total ? received / total : 0)) * 100);
  if (!total) return `${pct}%`;
  const mb = (b) => `${(b / 1e6).toFixed(0)} MB`;
  return `${pct}% · ${mb(received)} / ${mb(total)}`;
}

earheart.on("models:progress", (p) => {
  const m = manage[p.kind];
  if (m && m.modelId === p.modelId && m.fill) {
    m.fill.style.width = `${Math.round(p.fraction * 100)}%`;
    if (m.status) {
      m.status.textContent = progressLabel(p);
      m.status.className = "status";
    }
  }
});

document
  .querySelectorAll('input[name="stt-engine"]')
  .forEach((r) => r.addEventListener("change", () => syncEngine("stt")));
document
  .querySelectorAll('input[name="cleanup-engine"]')
  .forEach((r) => r.addEventListener("change", () => syncEngine("cleanup")));
$("stt-builtin-model").addEventListener("change", () => renderManage("stt"));
$("cleanup-builtin-model").addEventListener("change", () => renderManage("cleanup"));

$("cleanup-prompt-reset").addEventListener("click", () => {
  $("cleanup-prompt").value = defaults.cleanup.systemPrompt;
});

/* ---------- save ---------- */

const saveButton = $("save");
saveButton.addEventListener("click", async () => {
  const save = $("save-status");
  const hotkeyStatus = $("hotkey-status");
  const pauseHotkeyStatus = $("pause-hotkey-status");
  let result;
  let pauseResult;
  // Acknowledge the click immediately and block a duplicate save while the
  // round-trip is in flight.
  saveButton.disabled = true;
  save.textContent = "Saving…";
  save.className = "status";
  try {
    current = collect();
    result = await earheart.invoke("settings:save", current);
    current = result.settings;
    // Older mains don't report a pause result; treat that as fine.
    pauseResult = result.pauseHotkey ?? { ok: true };
    if (result.hotkey.ok && pauseResult.ok) {
      // Clean save — close the window so the user doesn't have to dismiss it.
      save.textContent = "Saved";
      save.className = "status ok";
      hotkeyStatus.textContent = "";
      pauseHotkeyStatus.textContent = "";
      earheart.invoke("settings:close");
      return;
    }
  } catch (err) {
    // Covers a rejected save AND a resolved-but-malformed result, so the button
    // never stays stuck disabled on "Saving…".
    save.textContent = `Could not save: ${err.message}`;
    save.className = "status err";
    saveButton.disabled = false;
    return;
  }
  // A hotkey couldn't be registered: keep the window open so the error is
  // visible and the user can pick a combination that works.
  saveButton.disabled = false;
  save.textContent = `Saved, but the ${result.hotkey.ok ? "pause hotkey" : "hotkey"} could not be registered`;
  save.className = "status err";
  hotkeyStatus.textContent = result.hotkey.ok ? "" : result.hotkey.error;
  hotkeyStatus.className = "status err";
  pauseHotkeyStatus.textContent = pauseResult.ok ? "" : pauseResult.error;
  pauseHotkeyStatus.className = "status err";
  setTimeout(() => {
    save.textContent = "";
  }, 4000);
});

/* ---------- connection tests ---------- */

function bindTest(buttonId, resultId, channel, getCfg) {
  const btn = $(buttonId);
  btn.addEventListener("click", async () => {
    const el = $(resultId);
    // Disable while the test is in flight so a second click can't race a stale
    // response over the result (mirrors bindFetchModels).
    btn.disabled = true;
    el.textContent = "Testing…";
    el.className = "status";
    try {
      const result = await earheart.invoke(channel, getCfg());
      if (result.ok) {
        el.textContent = result.sample ? `OK — "${result.sample}"` : "OK";
        el.className = "status ok";
      } else {
        el.textContent = result.error;
        el.className = "status err";
      }
    } finally {
      btn.disabled = false;
    }
  });
}

bindTest("stt-test", "stt-test-result", "stt:test", () => collect().stt);
bindTest("cleanup-test", "cleanup-test-result", "cleanup:test", () => ({
  ...collect().cleanup,
  enabled: true,
}));

// Fetch the model list from an external OpenAI-compatible service and offer it
// as autocomplete on the model input (a <datalist>). The input stays editable
// so a user can still type a model the server doesn't advertise.
function bindFetchModels(buttonId, resultId, datalistId, getCfg) {
  const btn = $(buttonId);
  btn.addEventListener("click", async () => {
    const el = $(resultId);
    // Guard against a second click firing a concurrent fetch while one is
    // in flight.
    btn.disabled = true;
    el.textContent = "Fetching…";
    el.className = "status";
    try {
      const result = await earheart.invoke("models:list-remote", getCfg());
      if (!result.ok) {
        el.textContent = result.error;
        el.className = "status err";
        return;
      }
      const list = $(datalistId);
      list.replaceChildren(
        ...result.models.map((id) => {
          const opt = document.createElement("option");
          opt.value = id;
          return opt;
        })
      );
      el.textContent = result.models.length
        ? `${result.models.length} model${result.models.length === 1 ? "" : "s"} — click the field to choose`
        : "No models reported by this service";
      el.className = result.models.length ? "status ok" : "status";
    } finally {
      btn.disabled = false;
    }
  });
}

bindFetchModels("stt-fetch-models", "stt-fetch-result", "stt-model-list", () => {
  const c = collect().stt;
  return { baseUrl: c.baseUrl, apiKey: c.apiKey };
});
bindFetchModels("cleanup-fetch-models", "cleanup-fetch-result", "cleanup-model-list", () => {
  const c = collect().cleanup;
  return { baseUrl: c.baseUrl, apiKey: c.apiKey };
});

/* ---------- add a custom model from a Hugging Face repo ---------- */

function humanSize(bytes) {
  if (!bytes) return "";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// Paste a Hugging Face repo URL or owner/model → "Find versions" lists its
// variants (GGUF quantizations for cleanup, transducer precisions for STT) →
// "Add" registers the chosen one as a custom model, which then downloads and
// removes through the same UI as the built-ins.
function bindAddCustomModel(kind) {
  const urlInput = $(`${kind}-hf-url`);
  const findBtn = $(`${kind}-hf-find`);
  const result = $(`${kind}-hf-result`);
  const pick = $(`${kind}-hf-pick`);
  const variantSelect = $(`${kind}-hf-variant`);
  const addBtn = $(`${kind}-hf-add`);

  findBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    findBtn.disabled = true;
    pick.hidden = true;
    result.textContent = "Looking up versions…";
    result.className = "status";
    try {
      const res = await earheart.invoke("models:hf-variants", { kind, url });
      if (!res.ok) {
        result.textContent = res.error;
        result.className = "status err";
        return;
      }
      variantSelect.replaceChildren(
        ...res.variants.map((v) => {
          const opt = document.createElement("option");
          opt.value = v.label;
          const size = humanSize(v.totalBytes);
          opt.textContent =
            v.label +
            (size ? ` · ${size}` : "") +
            (v.label === res.recommended ? " · recommended" : "");
          return opt;
        })
      );
      if (res.recommended) variantSelect.value = res.recommended;
      pick.hidden = false;
      result.textContent = `${res.repo} — ${res.variants.length} version${res.variants.length === 1 ? "" : "s"}`;
      result.className = "status ok";
    } finally {
      findBtn.disabled = false;
    }
  });

  addBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    const variant = variantSelect.value;
    if (!url || !variant) return;
    addBtn.disabled = true;
    result.textContent = "Adding…";
    result.className = "status";
    try {
      const res = await earheart.invoke("models:add-custom", { kind, url, variant });
      if (!res.ok) {
        result.textContent = res.error;
        result.className = "status err";
        return;
      }
      // Keep `current` in sync so a later settings save doesn't drop the model.
      current.customModels = res.customModels;
      await refreshModels({ [kind]: res.modelId });
      urlInput.value = "";
      pick.hidden = true;
      result.textContent = "Added — click Download to fetch it";
      result.className = "status ok";
    } finally {
      addBtn.disabled = false;
    }
  });
}
bindAddCustomModel("stt");
bindAddCustomModel("cleanup");

/* ---------- history ---------- */

const HISTORY_PAGE_SIZE = 5;
let historyPage = 0; // 0 = the newest page

async function renderHistory() {
  const items = await earheart.invoke("history:list");
  const list = $("history-list");
  const pager = $("history-pager");
  list.replaceChildren();

  const pages = Math.max(1, Math.ceil(items.length / HISTORY_PAGE_SIZE));
  historyPage = Math.min(historyPage, pages - 1); // clamp after clear/shrink
  pager.hidden = pages <= 1;

  if (items.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="muted">No transcriptions yet.</span>';
    list.appendChild(li);
    return;
  }

  const start = historyPage * HISTORY_PAGE_SIZE;
  const slice = items.slice(start, start + HISTORY_PAGE_SIZE);
  $("history-range").textContent = `${start + 1}–${start + slice.length} of ${items.length}`;
  $("history-newer").disabled = historyPage === 0;
  $("history-older").disabled = historyPage >= pages - 1;

  for (const item of slice) {
    const li = document.createElement("li");
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = item.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    const when = document.createElement("span");
    when.textContent = `${new Date(item.at).toLocaleString()}${item.cleaned ? " · cleaned" : ""}`;
    const actions = document.createElement("span");
    actions.className = "actions";
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(item.text);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    });
    actions.append(copy);
    meta.append(when, actions);
    li.append(text, meta);
    list.appendChild(li);
    // The card is laid out as soon as it is attached (the History section is
    // always visible), so overflow past the 3-line clamp is measurable here.
    if (text.scrollHeight > text.clientHeight + 1) {
      const more = document.createElement("button");
      more.className = "more";
      more.textContent = "Show more";
      more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", () => {
        const open = li.classList.toggle("expanded");
        more.textContent = open ? "Show less" : "Show more";
        more.setAttribute("aria-expanded", String(open));
      });
      actions.prepend(more);
    }
  }
}

$("history-newer").addEventListener("click", () => {
  historyPage -= 1;
  renderHistory();
});

$("history-older").addEventListener("click", () => {
  historyPage += 1;
  renderHistory();
});

$("history-clear").addEventListener("click", async () => {
  // Unlike a removed model, cleared history is gone for good — gate it the
  // same way model removal already is.
  if (!confirm("Clear all saved transcriptions? This can't be undone.")) return;
  await earheart.invoke("history:clear");
  renderHistory();
});

// The History section is always on the panel now, so keep it live. A new
// dictation snaps back to the newest page so it is immediately visible.
earheart.on("history:changed", () => { historyPage = 0; renderHistory(); });

/* ---------- setup wizard ---------- */

$("open-wizard").addEventListener("click", () => {
  earheart.invoke("wizard:open");
});

/* ---------- error log ---------- */

$("open-logs").addEventListener("click", async () => {
  const el = $("open-logs-result");
  try {
    const result = await earheart.invoke("logs:open");
    if (result.ok) {
      // Main falls back when the OS has no app for .log files (common on
      // Windows): "revealed" = the file selected in the file manager,
      // "folder" = the logs directory, because nothing has faulted yet.
      el.textContent =
        result.action === "revealed"
          ? "Opened its folder — no app is set up for .log files"
          : result.action === "folder"
            ? "Nothing logged yet — opened the logs folder"
            : result.path;
      el.className = "status";
    } else {
      // Opening can fail (no default handler for .log); still show where it is.
      el.textContent = result.path ? `Couldn't open it — find it at ${result.path}` : result.error;
      el.className = "status err";
    }
  } catch (err) {
    // A bridge-level throw (e.g. a channel missing from the preload allowlist)
    // must surface here, not die as an unhandled rejection.
    el.textContent = `Couldn't open the log: ${err.message}`;
    el.className = "status err";
  }
});

/* ---------- macOS auto-paste (Accessibility) permission ---------- */

function setAccessibilityStatus(text, cls = "status") {
  const el = $("accessibility-status");
  el.textContent = text;
  el.className = cls;
}

$("accessibility-fix").addEventListener("click", async () => {
  const btn = $("accessibility-fix");
  btn.disabled = true;
  setAccessibilityStatus("Checking…");
  try {
    const result = await earheart.invoke("permissions:accessibility-fix");
    if (result.granted) {
      setAccessibilityStatus(
        "Already granted — if auto-paste still fails, toggle Earheart off and on under Accessibility.",
        "status ok"
      );
    } else if (result.opened) {
      setAccessibilityStatus(
        "Opened System Settings — turn Earheart on under Accessibility."
      );
    } else {
      setAccessibilityStatus(
        "Couldn't open System Settings — open it manually: Privacy & Security ▸ Accessibility.",
        "status err"
      );
    }
  } finally {
    btn.disabled = false;
  }
});

// Re-check silently when the window regains focus, so the status updates from
// "turn Earheart on…" to confirmation once the user grants it in System
// Settings — without re-opening System Settings. Only meaningful after the user
// has clicked Fix (so an empty status stays empty).
window.addEventListener("focus", async () => {
  if (platform !== "darwin" || !$("accessibility-status").textContent) return;
  const result = await earheart.invoke("permissions:accessibility-check");
  if (result.granted) {
    setAccessibilityStatus("Auto-paste permission is on.", "status ok");
  }
});

// Opened right after the setup wizard: tell the user their choices are
// already filled in and saving as-is is fine.
if (new URLSearchParams(location.search).has("wizard")) {
  $("wizard-banner").hidden = false;
}
$("wizard-banner-dismiss").addEventListener("click", () => {
  $("wizard-banner").hidden = true;
});

/* ---------- updates ---------- */

// Last state pushed from main; drives what the action button does on click.
let updateState = null;

// The changes waiting in the update, version by version, so the decision is
// made on what's in it. Built as text nodes: the notes are published with the
// release and fetched over the network, so they never become markup. Kept up
// until the update is gone (unlike the overlay's summary, which steps aside
// once the download starts) — this is the page you come to to read them.
function renderUpdateNotes(entries) {
  const box = $("update-notes");
  const blocks = (entries || []).flatMap((entry) => {
    const head = document.createElement("div");
    head.className = "notes-head";
    head.textContent = entry.date ? `v${entry.version} — ${entry.date}` : `v${entry.version}`;
    const list = document.createElement("ul");
    list.className = "notes";
    for (const text of entry.items) {
      const li = document.createElement("li");
      li.textContent = text;
      list.append(li);
    }
    return [head, list];
  });
  box.replaceChildren(...blocks);
  box.hidden = !blocks.length;
}

function renderUpdateState(u) {
  updateState = u;
  const action = $("update-action");
  const status = $("update-status");
  renderUpdateNotes(u.status === "idle" ? [] : u.notes);
  $("update-bar").hidden = u.status !== "downloading";
  $("update-skip").hidden = !(u.status === "available" && u.method === "install");
  action.disabled = u.status === "checking" || u.status === "installing";
  status.className = "status";
  // One-shot outcomes announce; the ~1%-step download ticks must not spam
  // the screen-reader queue.
  status.setAttribute("aria-live", u.status === "downloading" ? "off" : "polite");

  switch (u.status) {
    case "checking":
      action.textContent = "Checking…";
      status.textContent = "";
      break;
    case "available":
      if (u.method === "install") {
        action.textContent = `Update to v${u.latest}`;
      } else {
        action.textContent = "Open download page";
        if (u.hint) $("update-hint").textContent = u.hint;
      }
      status.textContent = `Version ${u.latest} is available`;
      status.className = "status ok";
      break;
    case "downloading": {
      const pct = Math.round(((u.progress && u.progress.fraction) || 0) * 100);
      $("update-fill").style.width = `${pct}%`;
      action.textContent = "Cancel";
      status.textContent = `Downloading… ${pct}%`;
      break;
    }
    case "ready":
      action.textContent = `Restart to update to v${u.latest}`;
      status.textContent = "Downloaded ✓";
      status.className = "status ok";
      break;
    case "installing":
      action.textContent = "Restarting…";
      status.textContent = "";
      break;
    case "error":
      action.textContent = u.latest ? "Retry update" : "Check for updates";
      status.textContent = u.error || "Update failed";
      status.className = "status err";
      break;
    default:
      // idle — leave any "Up to date ✓" set by a manual check in place
      action.textContent = "Check for updates";
  }
}

$("update-action").addEventListener("click", async () => {
  const u = updateState || { status: "idle" };
  if (u.status === "downloading") {
    earheart.invoke("updates:cancel");
  } else if (u.status === "ready") {
    earheart.invoke("updates:install");
  } else if (u.status === "available" || (u.status === "error" && u.latest)) {
    earheart.invoke("updates:apply");
  } else {
    const res = await earheart.invoke("updates:check");
    if (res.status === "idle") {
      $("update-status").textContent = "Up to date ✓";
      $("update-status").className = "status ok";
    }
  }
});

$("update-skip").addEventListener("click", () => earheart.invoke("updates:skip"));

earheart.on("updates:state", renderUpdateState);

/* ---------- init ---------- */

(async () => {
  const data = await earheart.invoke("settings:get");
  current = data.settings;
  defaults = data.defaults;
  platform = data.platform;
  cleanupStyles = data.cleanupStyles || [];
  // The Accessibility permission only exists on macOS.
  if (platform === "darwin") $("accessibility-field").hidden = false;
  $("version").textContent = `v${data.version}`;
  if (platform === "darwin") {
    // The app ships unsigned; this is the one-time manual step after which
    // in-app updates de-quarantine new versions automatically.
    $("update-hint").textContent +=
      " If a freshly downloaded Earheart says it is damaged, run" +
      " `xattr -cr /Applications/Earheart.app` once — updates installed from" +
      " here handle that automatically afterwards.";
  }
  renderUpdateState(await earheart.invoke("updates:get"));
  modelStatus = await earheart.invoke("models:status");
  populateModelSelect("stt");
  populateModelSelect("cleanup");
  populate();
  renderHistory();
  loadMicrophones();
})();
