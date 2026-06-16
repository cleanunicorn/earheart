// Settings window renderer.

let current = null; // settings object being edited
let defaults = null;
let platform = "linux";
let modelStatus = null; // { stt: [...], cleanup: [...] } from the main process

const $ = (id) => document.getElementById(id);

/* ---------- tabs ---------- */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "history") renderHistory();
  });
});

/* ---------- hotkey capture ---------- */

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

  $("cleanup-enabled").checked = current.cleanup.enabled;
  $("cleanup-url").value = current.cleanup.baseUrl;
  $("cleanup-key").value = current.cleanup.apiKey;
  $("cleanup-model").value = current.cleanup.model;
  $("cleanup-temperature").value = current.cleanup.temperature;
  $("cleanup-prompt").value = current.cleanup.systemPrompt;
  selectEngine("cleanup", current.cleanup.engine);
  $("cleanup-builtin-model").value = current.cleanup.builtin.model;
  syncCleanupEnabled();
  syncEngine("stt");
  syncEngine("cleanup");

  $("history-enabled").checked = current.history.enabled;
  $("max-seconds").value = current.audio.maxRecordingSeconds;
  $("idle-unload").value = current.engines?.idleUnloadMinutes ?? 2;

  if (platform !== "linux") $("wayland-note").style.display = "none";
}

function collect() {
  return {
    ...current,
    hotkey: current.hotkey,
    output: {
      ...current.output,
      mode: document.querySelector('input[name="output-mode"]:checked').value,
      // Legacy files could hold restoreClipboard: false from the era when
      // that was the only way to keep the transcript on the clipboard; the
      // explicit paste-copy mode replaces it, so plain paste always restores.
      restoreClipboard: true,
    },
    stt: {
      ...current.stt,
      engine: engineValue("stt"),
      builtin: { ...current.stt.builtin, model: $("stt-builtin-model").value },
      baseUrl: $("stt-url").value.trim(),
      apiKey: $("stt-key").value.trim(),
      model: $("stt-model").value.trim(),
      language: $("stt-language").value.trim(),
    },
    cleanup: {
      ...current.cleanup,
      enabled: $("cleanup-enabled").checked,
      engine: engineValue("cleanup"),
      builtin: { ...current.cleanup.builtin, model: $("cleanup-builtin-model").value },
      baseUrl: $("cleanup-url").value.trim(),
      apiKey: $("cleanup-key").value.trim(),
      model: $("cleanup-model").value.trim(),
      temperature: parseFloat($("cleanup-temperature").value) || 0,
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
  $("cleanup-fields").classList.toggle("disabled", !$("cleanup-enabled").checked);
}
$("cleanup-enabled").addEventListener("change", syncCleanupEnabled);

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
    btn.onclick = () => removeModel(kind, modelId);
  } else {
    status.textContent = "Not downloaded";
    btn.textContent = "Download";
    btn.className = "ghost";
    btn.onclick = () => downloadModel(kind, modelId, ui);
  }
  row.append(btn, status);
  container.append(note, bar, row);
  manage[kind] = ui;
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
    return;
  }
  // Failed or cancelled: revert to a download affordance the user can retry.
  ui.bar.hidden = true;
  ui.btn.textContent = res.cancelled ? "Download" : "Retry download";
  ui.btn.className = "ghost";
  ui.btn.onclick = () => downloadModel(kind, modelId, ui);
  ui.status.textContent = res.cancelled ? "Cancelled" : res.error || "Download failed";
  ui.status.className = res.cancelled ? "status" : "status err";
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

async function refreshModels() {
  modelStatus = await earheart.invoke("models:status");
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

$("save").addEventListener("click", async () => {
  const save = $("save-status");
  const hotkeyStatus = $("hotkey-status");
  let result;
  try {
    current = collect();
    result = await earheart.invoke("settings:save", current);
  } catch (err) {
    save.textContent = `Could not save: ${err.message}`;
    save.className = "status err";
    return;
  }
  current = result.settings;
  if (result.hotkey.ok) {
    save.textContent = "Saved";
    save.className = "status ok";
    hotkeyStatus.textContent = "";
  } else {
    save.textContent = "Saved, but the hotkey could not be registered";
    save.className = "status err";
    hotkeyStatus.textContent = result.hotkey.error;
    hotkeyStatus.className = "status err";
  }
  setTimeout(() => {
    save.textContent = "";
  }, 4000);
});

/* ---------- connection tests ---------- */

function bindTest(buttonId, resultId, channel, getCfg) {
  $(buttonId).addEventListener("click", async () => {
    const el = $(resultId);
    el.textContent = "Testing…";
    el.className = "status";
    const result = await earheart.invoke(channel, getCfg());
    if (result.ok) {
      el.textContent = result.sample ? `OK — "${result.sample}"` : "OK";
      el.className = "status ok";
    } else {
      el.textContent = result.error;
      el.className = "status err";
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

/* ---------- history ---------- */

async function renderHistory() {
  const items = await earheart.invoke("history:list");
  const list = $("history-list");
  list.replaceChildren();
  if (items.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="muted">No transcriptions yet.</span>';
    list.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = item.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    const when = document.createElement("span");
    when.textContent = `${new Date(item.at).toLocaleString()}${item.cleaned ? " · cleaned" : ""}`;
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(item.text);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    });
    meta.append(when, copy);
    li.append(text, meta);
    list.appendChild(li);
  }
}

$("history-clear").addEventListener("click", async () => {
  await earheart.invoke("history:clear");
  renderHistory();
});

earheart.on("history:changed", () => {
  if ($("tab-history").classList.contains("active")) renderHistory();
});

/* ---------- setup wizard ---------- */

$("open-wizard").addEventListener("click", () => {
  earheart.invoke("wizard:open");
});

// Opened right after the setup wizard: tell the user their choices are
// already filled in and saving as-is is fine.
if (new URLSearchParams(location.search).has("wizard")) {
  $("wizard-banner").hidden = false;
}
$("wizard-banner-dismiss").addEventListener("click", () => {
  $("wizard-banner").hidden = true;
});

/* ---------- init ---------- */

(async () => {
  const data = await earheart.invoke("settings:get");
  current = data.settings;
  defaults = data.defaults;
  platform = data.platform;
  $("version").textContent = `v${data.version}`;
  modelStatus = await earheart.invoke("models:status");
  populateModelSelect("stt");
  populateModelSelect("cleanup");
  populate();
  loadMicrophones();
})();
