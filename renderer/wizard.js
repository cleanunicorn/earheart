// First-run setup wizard renderer. Walks through hotkey, microphone,
// speech-to-text, cleanup and output; the last step downloads any models that
// run on this computer (with progress) before saving and handing over to the
// settings window.

let current = null; // settings object being edited
// The shared fields as this window last saw them from main; sent with the
// save (sharedBaseline in settings-sync.js).
let baseline = null;
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
  // The step-dot row is visual; this is what it says, for keyboard/AT users.
  $("step-position").textContent = `Step ${stepIndex + 1} of ${steps.length}`;
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
  updateDownloadCopy();
}

$("back").addEventListener("click", () => showStep(stepIndex - 1));
$("next").addEventListener("click", () => {
  if (stepIndex === steps.length - 1) finish();
  else {
    if (stepIndex === 3) {
      const t = transfer("stt", collect().stt.builtin.model);
      startDownload(t, ["failed", "skipped"].includes(t.phase));
    }
    if (stepIndex === 5) {
      cleanupConsent = collect().cleanup.enabled ? collect().cleanup.builtin.model : null;
      later = false;
    }
    showStep(stepIndex + 1);
  }
});

$("skip").addEventListener("click", async () => {
  leaving = true; cleanupConsent = null;
  await Promise.all([...transfers.values()].map(cancelOwned));
  earheart.invoke("wizard:skip");
});

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

/* ---------- microphone list ---------- */

async function loadMicrophones() {
  const select = $("mic-device");
  let selectionChanged = false;
  select.addEventListener("change", () => {
    selectionChanged = true;
  });
  // Preserve the saved device before permission or enumeration can finish, so
  // saving the wizard cannot silently replace it with the system default.
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
        const existing = [...select.options].find((option) => option.value === d.deviceId);
        if (existing) {
          existing.textContent = d.label || existing.textContent;
          return;
        }
        const option = document.createElement("option");
        option.value = d.deviceId;
        option.textContent = d.label || `Microphone ${select.length}`;
        select.appendChild(option);
      });
    if (!selectionChanged) select.value = current.audio.deviceId || "";
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
  const on = $("cleanup-enabled").checked;
  const fields = $("cleanup-fields");
  fields.classList.toggle("disabled", !on);
  fields.inert = !on;
  reconcileCleanup();
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
  // Without this the slider announces bare "0/1/2" to screen readers.
  $("cleanup-style").setAttribute("aria-valuetext", `${style.label} — ${style.hint}`);
}

$("cleanup-style").addEventListener("input", renderStyleLabel);

/* ---------- collect wizard choices into a settings object ---------- */

function collect() {
  return {
    ...current,
    output: {
      ...current.output,
      mode: document.querySelector("input[name=\"output-mode\"]:checked").value,
      // As in Settings: the explicit paste-copy mode replaces the legacy
      // restoreClipboard: false, so plain paste always restores.
      restoreClipboard: true,
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
    // Accelerators are machine notation — mono here just like in Settings.
    if (label === "Hotkey") dd.classList.add("accel");
    row.append(dt, dd);
    summary.appendChild(row);
  }
}

document
  .querySelectorAll("input[name=\"output-mode\"]")
  .forEach((radio) => radio.addEventListener("change", renderSummary));

/* ---------- download records outlive their visible rows ---------- */
const transfers = new Map();
const dlRows = new Map();
const downloadOwner = crypto.randomUUID();
let cleanupConsent = null;
let later = false;
let leaving = false;
function neededModels(cfg = collect()) {
  return [
    ...(cfg.stt.engine === "builtin" ? [{ kind: "stt", modelId: cfg.stt.builtin.model }] : []),
    ...(cfg.cleanup.enabled && cfg.cleanup.engine === "builtin" ? [{ kind: "cleanup", modelId: cfg.cleanup.builtin.model }] : []),
  ];
}
function infoFor(kind, modelId) { return modelStatus?.[kind]?.find((m) => m.id === modelId); }
function transfer(kind, modelId) {
  const key = kind + ":" + modelId;
  if (!transfers.has(key)) {
    const info = infoFor(kind, modelId);
    transfers.set(key, { kind, modelId, phase: info?.installed ? "ready" : info?.download ? "downloading" : "idle",
      received: info?.download?.received || 0, total: info?.bytes, generation: 0, owned: false,
      burden: !info?.installed, promise: null });
  }
  return transfers.get(key);
}
function speechReady() {
  return collect().stt.engine !== "builtin" || transfer("stt", collect().stt.builtin.model).phase === "ready";
}
function updateDownloadCopy() {
  if (!current || !modelStatus) return;
  const cfg = collect();
  const speech = transfer("stt", cfg.stt.builtin.model);
  const size = (t) => Number.isFinite(t.total) ? ModelProgress.bytes(Math.max(0, t.total - t.received)) : "size unknown";
  $("speech-download-hint").textContent = speech.phase === "ready" ? "Speech is already downloaded." : speech.phase === "downloading" ? "Speech downloading — " + ModelProgress.label(speech) + ". You can continue setup." : "Speech needs " + size(speech) + ". Download speech and continue starts it now while you finish setup.";
  if (stepIndex === 3) $("next").textContent = ["ready", "downloading"].includes(speech.phase) ? "Next" : "Download speech and continue (" + size(speech) + ")";
  if (stepIndex === 5) {
    const cleanup = cfg.cleanup.enabled ? transfer("cleanup", cfg.cleanup.builtin.model) : null;
    $("next").textContent = cleanup && !["ready", "downloading"].includes(cleanup.phase) ? "Next: download cleanup (" + size(cleanup) + ")" : "Next";
    $("download-cost").textContent = (speech.phase === "ready" ? "Speech ready." : speech.phase === "downloading" ? "Speech already downloading — " + ModelProgress.label(speech) + "." : "Speech still needs its download.") + " " + (cleanup && cleanup.phase !== "ready" ? "Optional cleanup needs " + size(cleanup) + "; it starts after speech is ready." : "No additional download needed.");
  }
  if (stepIndex !== steps.length - 1) return;
  $("next").disabled = !speechReady() && !later;
  $("next").textContent = speechReady() || later ? "Finish setup" : "Downloading speech…";
  $("finish-hint").textContent = speechReady() ? "Your setup will be saved. Click into any text field and press " + current.hotkey + " to speak." + (cfg.cleanup.enabled && transfer("cleanup", cfg.cleanup.builtin.model).phase !== "ready" ? " Optional cleanup keeps downloading in the background; dictation works with raw transcripts until it is ready." : "") : "Dictation won't work until you download speech in Settings → Speech-to-text. Cleanup is optional; without it you get raw transcripts.";
  const burden = neededModels(cfg).map((n) => transfer(n.kind, n.modelId)).filter((t) => t.burden);
  const known = burden.every((t) => Number.isFinite(t.total));
  const received = burden.reduce((n, t) => n + (t.phase === "ready" && t.total ? t.total : Math.min(t.received, t.total ?? t.received)), 0);
  $("download-total").textContent = burden.length ? ModelProgress.bytes(received) + " of " + (known ? ModelProgress.bytes(burden.reduce((n, t) => n + t.total, 0)) : "an unknown total") : "Models already downloaded";
  for (const [key, row] of dlRows) {
    const t = transfers.get(key);
    const skipped = t.kind === "stt" ? "Not downloaded — dictation won't work until you download it in Settings" : "Not downloaded — optional; you'll get raw transcripts without it";
    row.status.textContent = t.phase === "ready" ? "Ready ✓" : t.phase === "skipped" ? skipped : t.phase === "failed" ? t.error : t.phase === "downloading" ? ModelProgress.label(t) : t.kind === "cleanup" ? "Waiting for speech — optional" : "Waiting for download";
    row.status.className = "status" + (t.phase === "ready" ? " ok" : t.phase === "failed" ? " err" : "");
    row.fill.style.width = (t.phase === "ready" ? 100 : ModelProgress.fraction(t) * 100) + "%";
    row.retry.hidden = !["failed", "skipped"].includes(t.phase);
  }
}
function announceDownload(t, message) { $("dl-announce").textContent = (infoFor(t.kind, t.modelId)?.label || t.modelId) + ": " + message; }
function settleDownload(t, result) {
  if (t.phase === "skipped" || leaving || t.phase === "ready") return;
  if (result.error === "Already downloading") { t.owned = false; return; }
  t.phase = result.ok ? "ready" : "failed";
  t.error = result.cancelled ? "Cancelled — retry when ready" : result.error || "Download failed";
  if (result.ok) { const info = infoFor(t.kind, t.modelId); if (info) info.installed = true; if (t.total) t.received = t.total; }
  announceDownload(t, result.ok ? "Ready" : t.error);
  updateDownloadCopy();
  maybeStartCleanup();
}
async function startDownload(t, retry = false) {
  if (leaving || (!retry && ["ready", "downloading", "failed", "skipped"].includes(t.phase))) return;
  // Let the cancelled same-id attempt finish broadcasting before a retry.
  if (retry && t.promise) await t.promise.catch(() => {});
  if (leaving) return;
  const generation = ++t.generation;
  t.phase = "downloading"; t.owned = true; later = false;
  updateDownloadCopy();
  t.promise = earheart.invoke("models:download", { kind: t.kind, modelId: t.modelId, owner: downloadOwner })
    .then((result) => { if (generation === t.generation) settleDownload(t, result); })
    .catch((err) => { if (generation === t.generation) settleDownload(t, { ok: false, error: err.message }); });
}
function maybeStartCleanup() {
  if (leaving || later || !cleanupConsent || !speechReady()) return;
  const cfg = collect();
  if (cfg.cleanup.enabled && cfg.cleanup.builtin.model === cleanupConsent) startDownload(transfer("cleanup", cleanupConsent));
}
function cancelOwned(t) {
  t.generation++;
  if (t.owned && t.phase === "downloading") return earheart.invoke("models:cancel", { kind: t.kind, modelId: t.modelId, owner: downloadOwner });
  return Promise.resolve();
}
function reconcileCleanup() {
  if (!current || !modelStatus) return;
  const cfg = collect();
  for (const t of transfers.values()) if (t.kind === "cleanup" && (!cfg.cleanup.enabled || t.modelId !== cfg.cleanup.builtin.model)) {
    cancelOwned(t); if (t.owned && t.phase !== "ready") t.phase = "skipped";
  }
  if (!cfg.cleanup.enabled || cleanupConsent !== cfg.cleanup.builtin.model) cleanupConsent = null;
  updateDownloadCopy();
}
function buildRow(t) {
  const wrap = document.createElement("div"); wrap.className = "dl-item";
  const head = document.createElement("div"); head.className = "dl-head";
  const name = document.createElement("strong"); name.textContent = infoFor(t.kind, t.modelId)?.label || t.modelId;
  const status = document.createElement("span"); head.append(name, status);
  const bar = document.createElement("div"); bar.className = "dl-bar";
  const fill = document.createElement("div"); fill.className = "dl-fill"; bar.append(fill);
  const retry = document.createElement("button"); retry.className = "ghost"; retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    if (t.kind === "cleanup") cleanupConsent = t.modelId;
    if (t.kind === "cleanup" && !speechReady()) { t.phase = "idle"; later = false; updateDownloadCopy(); }
    else startDownload(t, true);
  });
  wrap.append(head, bar, retry); dlRows.set(t.kind + ":" + t.modelId, { status, fill, retry }); return wrap;
}
function enterDownloadStep() {
  dlRows.clear();
  $("download-list").replaceChildren(...neededModels().map((n) => buildRow(transfer(n.kind, n.modelId))));
  $("download-later-row").hidden = neededModels().every((n) => transfer(n.kind, n.modelId).phase === "ready");
  updateDownloadCopy(); maybeStartCleanup();
}
earheart.on("models:progress", (p) => {
  const t = transfer(p.kind, p.modelId); if (t.phase === "skipped" || leaving) return;
  t.phase = "downloading"; t.received = Math.max(0, p.received || 0); if (!t.total && p.total) t.total = p.total;
  updateDownloadCopy();
});
earheart.on("models:done", (p) => { const t = transfers.get(p.kind + ":" + p.modelId); if (t) settleDownload(t, p); });
$("download-later").addEventListener("click", () => {
  later = true; cleanupConsent = null;
  for (const n of neededModels()) { const t = transfer(n.kind, n.modelId); if (t.phase === "ready") continue; cancelOwned(t); t.phase = "skipped"; }
  $("dl-announce").textContent = "Downloads skipped. Speech is required for dictation; cleanup is optional. Download later in Settings.";
  updateDownloadCopy();
});

/* ---------- changes saved elsewhere ---------- */

// Main saved the settings while the wizard is open (e.g. the tray's output
// radios): take the values only main writes and show a changed output mode,
// without touching anything else the user has chosen.
function applySettingsChange({ previous, current: saved }) {
  if (Array.isArray(saved.dictionary)) {
    current.cleanup.dictionary = [...saved.dictionary];
    baseline.dictionary = [...saved.dictionary];
  }
  current.overlay = saved.overlay;
  current.customModels = saved.customModels;
  current.updates = { ...saved.updates };
  baseline.remind = saved.updates.remind !== false;
  if (
    previous.output.mode !== saved.output.mode ||
    previous.output.restoreClipboard !== saved.output.restoreClipboard
  ) {
    current.output = { ...current.output, mode: saved.output.mode, restoreClipboard: saved.output.restoreClipboard };
    const radio = document.querySelector(
      `input[name="output-mode"][value="${displayedOutputMode(saved.output)}"]`
    );
    const shownBefore = document.querySelector('input[name="output-mode"]:checked')?.value;
    if (radio) radio.checked = true;
    baseline.outputMode = sharedBaseline(saved).outputMode;
    renderSummary();
    if (shownBefore !== displayedOutputMode(saved.output)) {
      // Say why the choice just changed under the user.
      $("sync-announce").textContent = "Output mode changed from the tray menu.";
    }
  }
}

const settingsChangesReady = followSettingsChanges(applySettingsChange);

/* ---------- finish ---------- */

async function finish() {
  const status = $("finish-status");
  status.textContent = "Saving…";
  status.className = "status";
  let result;
  try {
    result = await earheart.invoke("wizard:complete", { settings: collect(), baseline });
  } catch (err) {
    status.textContent = `Could not save: ${err.message}`;
    status.className = "status err";
    return;
  }
  current = result.settings;
  baseline = sharedBaseline(current);
  // Main may have kept its own output mode (a tray change the wizard hadn't
  // seen yet); show what was actually saved.
  const savedRadio = document.querySelector(
    `input[name="output-mode"][value="${displayedOutputMode(current.output)}"]`
  );
  if (savedRadio) savedRadio.checked = true;
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
  baseline = sharedBaseline(current);

  hotkeyInput.value = current.hotkey;
  $("cleanup-enabled").checked = current.cleanup.enabled;
  document.querySelector(
    `input[name="output-mode"][value="${displayedOutputMode(current.output)}"]`
  ).checked = true;

  populateCleanupModels();
  populateCleanupStyle();
  $("cleanup-builtin-model").addEventListener("change", () => {
    current.cleanup.builtin.model = $("cleanup-builtin-model").value;
    syncCleanupNote();
    reconcileCleanup();
  });

  syncCleanupEnabled();

  if (platform === "darwin") $("demo-mod").textContent = "⌘";
  if (platform !== "linux") $("wayland-note").style.display = "none";
  showStep(0);
  settingsChangesReady();
})();
