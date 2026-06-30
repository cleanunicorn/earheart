// First-run setup wizard renderer. Walks through hotkey, microphone,
// speech-to-text, cleanup and output; the last step downloads any models that
// run on this computer (with progress) before saving and handing over to the
// settings window.

let current = null; // settings object being edited
let defaults = null;
let platform = "linux";
let micLoaded = false;
let modelStatus = null; // { stt: [...], cleanup: [...] } from the main process
let cleanupStyles = []; // [{ id, label, hint }] — the cleanup style slider stops

const $ = (id) => document.getElementById(id);

/* ---------- step navigation ---------- */

const steps = [...document.querySelectorAll(".step")];
let stepIndex = 0;

const dots = $("dots");
steps.forEach(() => {
  const dot = document.createElement("span");
  dot.className = "dot";
  dots.appendChild(dot);
});

function showStep(index) {
  stepIndex = Math.max(0, Math.min(steps.length - 1, index));
  steps.forEach((step, i) => step.classList.toggle("active", i === stepIndex));
  [...dots.children].forEach((dot, i) =>
    dot.classList.toggle("active", i === stepIndex)
  );
  $("back").hidden = stepIndex === 0;
  $("next").textContent =
    stepIndex === 0
      ? "Get started"
      : stepIndex === steps.length - 1
        ? "Finish setup"
        : "Next";
  $("next").disabled = false;
  if (steps[stepIndex].id === "step-mic" && !micLoaded) {
    micLoaded = true;
    loadMicrophones();
  }
  if (steps[stepIndex].id === "step-output") renderSummary();
  if (steps[stepIndex].id === "step-finish") enterDownloadStep();
}

$("back").addEventListener("click", () => showStep(stepIndex - 1));
$("next").addEventListener("click", () => {
  if (stepIndex === steps.length - 1) finish();
  else showStep(stepIndex + 1);
});

$("skip").addEventListener("click", () => {
  // Persists the defaults and opens the regular settings window.
  earheart.invoke("wizard:skip");
});

/* ---------- hotkey capture (same behavior as the settings window) ---------- */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function acceleratorFromEvent(event) {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const parts = [];
  // On macOS, physical Ctrl must stay Ctrl — CommandOrControl would register Cmd.
  if (event.ctrlKey) parts.push(platform === "darwin" ? "Control" : "CommandOrControl");
  if (event.metaKey) parts.push(platform === "darwin" ? "Command" : "Super");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (parts.length === 0) return null; // require at least one modifier

  let key = event.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  else if (key.startsWith("Arrow")) key = key.slice(5);
  parts.push(key);
  return parts.join("+");
}

const hotkeyInput = $("hotkey");
hotkeyInput.addEventListener("click", () => {
  hotkeyInput.classList.add("capturing");
  hotkeyInput.value = "Press keys…";
});
hotkeyInput.addEventListener("blur", () => {
  hotkeyInput.classList.remove("capturing");
  hotkeyInput.value = current?.hotkey || "";
});
hotkeyInput.addEventListener("keydown", (event) => {
  if (!hotkeyInput.classList.contains("capturing")) return;
  event.preventDefault();
  const accelerator = acceleratorFromEvent(event);
  if (accelerator) {
    current.hotkey = accelerator;
    hotkeyInput.value = accelerator;
    hotkeyInput.classList.remove("capturing");
    hotkeyInput.blur();
  }
});
$("hotkey-clear").addEventListener("click", () => {
  current.hotkey = defaults.hotkey;
  hotkeyInput.value = defaults.hotkey;
});

/* ---------- microphone list ---------- */

async function loadMicrophones() {
  const select = $("mic-device");
  try {
    // Ask for permission once so device labels are populated.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "default")
      .forEach((d) => {
        const option = document.createElement("option");
        option.value = d.deviceId;
        option.textContent = d.label || `Microphone ${select.length}`;
        select.appendChild(option);
      });
  } catch {
    $("mic-hint").textContent =
      "No microphone found (or access was denied). You can pick one later in Settings.";
  }
}

/* ---------- cleanup ---------- */
//
// The wizard always sets up the built-in (on-device) engines. Switching speech-
// to-text or cleanup to a remote/OpenAI-compatible service is left to Settings,
// so first-run setup stays on the happy path. The wizard preserves whatever
// remote config already exists in settings (collect() spreads it through).

function syncCleanupEnabled() {
  $("cleanup-fields").classList.toggle("disabled", !$("cleanup-enabled").checked);
}

$("cleanup-enabled").addEventListener("change", syncCleanupEnabled);

function populateCleanupModels() {
  const select = $("cleanup-builtin-model");
  select.replaceChildren();
  for (const m of modelStatus.cleanup) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = m.label;
    select.appendChild(option);
  }
  select.value = current.cleanup.builtin.model;
  syncCleanupNote();
}

function syncCleanupNote() {
  const id = $("cleanup-builtin-model").value;
  const m = modelStatus.cleanup.find((x) => x.id === id);
  $("cleanup-builtin-note").textContent = m
    ? m.installed ? `${m.note} · already downloaded` : m.note
    : "";
}
// Bound after the select exists.

// The wizard exposes only the named style stops (verbatim → clean → polished);
// raw "custom" sampling stays in Settings. A migrated/custom config just starts
// the slider at the default and leaves cleanup.custom untouched via collect().
function populateCleanupStyle() {
  let idx = cleanupStyles.findIndex((s) => s.id === current.cleanup.style);
  if (idx < 0) idx = cleanupStyles.findIndex((s) => s.id === "clean");
  if (idx < 0) idx = 0;
  $("cleanup-style").value = String(idx);
  renderStyleLabel();
}

function renderStyleLabel() {
  const idx = parseInt($("cleanup-style").value, 10) || 0;
  const style = cleanupStyles[idx];
  if (!style) return;
  $("cleanup-style-label").textContent = style.label;
  $("cleanup-style-hint").textContent = style.hint;
}

$("cleanup-style").addEventListener("input", renderStyleLabel);

/* ---------- collect wizard choices into a settings object ---------- */

function collect() {
  return {
    ...current,
    output: {
      ...current.output,
      mode: document.querySelector('input[name="output-mode"]:checked').value,
    },
    stt: {
      ...current.stt,
      engine: "builtin",
      builtin: { ...current.stt.builtin },
    },
    cleanup: {
      ...current.cleanup,
      enabled: $("cleanup-enabled").checked,
      engine: "builtin",
      builtin: {
        ...current.cleanup.builtin,
        model: $("cleanup-builtin-model").value,
      },
      style: cleanupStyles[parseInt($("cleanup-style").value, 10) || 0]?.id || "clean",
    },
    audio: {
      ...current.audio,
      deviceId: $("mic-device").value,
    },
  };
}

/* ---------- summary ---------- */

function renderSummary() {
  const next = collect();
  const mic = $("mic-device");
  const rows = [
    ["Hotkey", next.hotkey],
    ["Microphone", mic.selectedOptions[0]?.textContent || "System default"],
    ["Speech-to-text", "Built-in Parakeet (on this computer)"],
  ];
  if (!next.cleanup.enabled) {
    rows.push(["Cleanup", "Off"]);
  } else {
    const m = modelStatus.cleanup.find((x) => x.id === next.cleanup.builtin.model);
    const style = cleanupStyles.find((s) => s.id === next.cleanup.style);
    rows.push([
      "Cleanup",
      `Built-in ${m ? m.label : ""} (on this computer)${style ? ` · ${style.label}` : ""}`,
    ]);
  }
  rows.push([
    "Output",
    next.output.mode === "clipboard"
      ? "Clipboard only"
      : next.output.mode === "paste-copy"
        ? "Paste and keep on clipboard"
        : "Paste into active app",
  ]);

  const summary = $("summary");
  summary.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    summary.appendChild(row);
  }
}

document
  .querySelectorAll('input[name="output-mode"]')
  .forEach((radio) => radio.addEventListener("change", renderSummary));

/* ---------- download step ---------- */

// Models the user's choices require to run on this computer.
function neededModels(cfg) {
  const list = [];
  if (cfg.stt.engine === "builtin") {
    list.push({ kind: "stt", modelId: cfg.stt.builtin.model });
  }
  if (cfg.cleanup.enabled && cfg.cleanup.engine === "builtin") {
    list.push({ kind: "cleanup", modelId: cfg.cleanup.builtin.model });
  }
  return list;
}

const dlRows = new Map(); // "kind:id" -> { fill, status, retry, done }
let downloadStarted = false;

function infoFor(kind, modelId) {
  return modelStatus[kind].find((m) => m.id === modelId);
}

function setFill(row, fraction) {
  row.fill.style.width = `${Math.round(fraction * 100)}%`;
}

function formatMB(bytes) {
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

// "42% · 280 MB / 660 MB" — concrete progress so a slow download reads as
// working, not stalled.
function progressLabel({ received, total, fraction }) {
  const pct = Math.round((fraction ?? (total ? received / total : 0)) * 100);
  if (!total) return `${pct}%`;
  return `${pct}% · ${formatMB(received)} / ${formatMB(total)}`;
}

function checkAllDone() {
  const allDone = [...dlRows.values()].every((r) => r.done);
  $("next").disabled = !allDone;
  $("next").textContent = allDone ? "Finish setup" : "Downloading…";
}

async function runDownload(kind, modelId) {
  const key = `${kind}:${modelId}`;
  const row = dlRows.get(key);
  row.done = false;
  row.retry.hidden = true;
  row.status.textContent = "Downloading…";
  row.status.className = "status";
  checkAllDone();

  const res = await earheart.invoke("models:download", { kind, modelId });
  if (res.ok) {
    setFill(row, 1);
    row.status.textContent = "Ready ✓";
    row.status.className = "status ok";
    row.done = true;
  } else if (res.cancelled) {
    row.status.textContent = "Cancelled";
    row.status.className = "status";
  } else if (res.error === "Already downloading") {
    // A fast re-entry (toggling the selection) can race the previous transfer's
    // teardown. The download is still progressing, so keep showing it as such
    // rather than a hard error; progress events continue to update the row.
    row.status.textContent = "Downloading…";
    row.status.className = "status";
  } else {
    row.status.textContent = res.error || "Download failed";
    row.status.className = "status err";
    row.retry.hidden = false;
  }
  checkAllDone();
}

function buildRow(kind, modelId) {
  const info = infoFor(kind, modelId);
  const wrap = document.createElement("div");
  wrap.className = "dl-item";

  const head = document.createElement("div");
  head.className = "dl-head";
  const name = document.createElement("strong");
  name.textContent = info ? info.label : modelId;
  const status = document.createElement("span");
  status.className = "status";
  head.append(name, status);

  const bar = document.createElement("div");
  bar.className = "dl-bar";
  const fill = document.createElement("div");
  fill.className = "dl-fill";
  bar.appendChild(fill);

  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = info ? info.note : "";

  const retry = document.createElement("button");
  retry.className = "ghost";
  retry.textContent = "Retry";
  retry.hidden = true;
  retry.addEventListener("click", () => runDownload(kind, modelId));

  wrap.append(head, bar, note, retry);
  dlRows.set(`${kind}:${modelId}`, { fill, status, retry, done: false });
  return wrap;
}

async function enterDownloadStep() {
  const cfg = collect();
  const needed = neededModels(cfg);

  // Rebuild only when the set of needed models changes (revisiting the step
  // after going back shouldn't restart finished downloads).
  const signature = needed.map((n) => `${n.kind}:${n.modelId}`).sort().join(",");
  if (downloadStarted && signature === enterDownloadStep.signature) {
    checkAllDone();
    return;
  }
  enterDownloadStep.signature = signature;

  // Cancel anything in flight from a previous selection.
  for (const [key] of dlRows) {
    const [kind, modelId] = key.split(":");
    earheart.invoke("models:cancel", { kind, modelId });
  }
  dlRows.clear();
  const listEl = $("download-list");
  listEl.replaceChildren();

  const toDownload = needed.filter((n) => {
    const info = infoFor(n.kind, n.modelId);
    return info && !info.installed;
  });

  $("download-none").hidden = needed.length > 0;
  $("download-later-row").hidden = toDownload.length === 0;
  $("download-title").textContent = toDownload.length
    ? "Setting up the models that run on your computer"
    : "You're all set";
  $("download-intro").hidden = toDownload.length === 0;

  // Show every needed model; already-installed ones render as Ready.
  for (const n of needed) {
    listEl.appendChild(buildRow(n.kind, n.modelId));
    const row = dlRows.get(`${n.kind}:${n.modelId}`);
    const info = infoFor(n.kind, n.modelId);
    if (info && info.installed) {
      setFill(row, 1);
      row.status.textContent = "Ready ✓";
      row.status.className = "status ok";
      row.done = true;
    }
  }

  downloadStarted = true;
  checkAllDone();
  // Kick off the downloads that are actually missing.
  for (const n of toDownload) runDownload(n.kind, n.modelId);
}

earheart.on("models:progress", (p) => {
  const row = dlRows.get(`${p.kind}:${p.modelId}`);
  if (row && !row.done) {
    setFill(row, p.fraction);
    row.status.textContent = progressLabel(p);
    row.status.className = "status";
  }
});

$("download-later").addEventListener("click", () => {
  // Stop in-flight downloads and let the user finish; models can be fetched
  // later from Settings. The pipeline shows a clear error until they exist.
  for (const [key, row] of dlRows) {
    if (row.done) continue;
    const [kind, modelId] = key.split(":");
    earheart.invoke("models:cancel", { kind, modelId });
    row.done = true;
    row.status.textContent = "Skipped — download later in Settings";
    row.status.className = "status";
  }
  checkAllDone();
});

/* ---------- finish ---------- */

async function finish() {
  const status = $("finish-status");
  status.textContent = "Saving…";
  status.className = "status";
  let result;
  try {
    result = await earheart.invoke("wizard:complete", collect());
  } catch (err) {
    status.textContent = `Could not save: ${err.message}`;
    status.className = "status err";
    return;
  }
  current = result.settings;
  if (!result.hotkey.ok) {
    // Stay in the wizard so the user can pick a combination that registers.
    status.textContent = "";
    showStep(steps.findIndex((s) => s.id === "step-hotkey"));
    const hotkeyStatus = $("hotkey-status");
    hotkeyStatus.textContent = `${result.hotkey.error} — choose a different combination, then finish setup again.`;
    hotkeyStatus.className = "status err";
  }
  // On success the main process opens Settings and closes this window.
}

/* ---------- init ---------- */

(async () => {
  const data = await earheart.invoke("settings:get");
  current = data.settings;
  defaults = data.defaults;
  platform = data.platform;
  cleanupStyles = data.cleanupStyles || [];
  modelStatus = await earheart.invoke("models:status");

  hotkeyInput.value = current.hotkey;
  $("cleanup-enabled").checked = current.cleanup.enabled;
  document.querySelector(
    `input[name="output-mode"][value="${current.output.mode}"]`
  ).checked = true;

  populateCleanupModels();
  populateCleanupStyle();
  $("cleanup-builtin-model").addEventListener("change", () => {
    current.cleanup.builtin.model = $("cleanup-builtin-model").value;
    syncCleanupNote();
  });

  syncCleanupEnabled();

  if (platform === "darwin") $("demo-mod").textContent = "⌘";
  if (platform !== "linux") $("wayland-note").style.display = "none";
  showStep(0);
})();
