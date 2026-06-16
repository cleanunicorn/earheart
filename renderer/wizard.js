// First-run setup wizard renderer. Walks through hotkey, microphone,
// speech-to-text, cleanup, a one-time model download, and output, then saves
// and hands over to the settings window with everything pre-filled.

let current = null; // settings object being edited
let defaults = null;
let platform = "linux";
let catalog = { stt: [], cleanup: [] };
let micLoaded = false;
let modelsStarted = false; // download step kicked off?

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
  const id = steps[stepIndex].id;
  if (id === "step-mic" && !micLoaded) {
    micLoaded = true;
    loadMicrophones();
  }
  if (id === "step-models") ensureDownloads();
  if (id === "step-finish") renderSummary();
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

/* ---------- speech-to-text mode ---------- */

function sttMode() {
  return document.querySelector('input[name="stt-mode"]:checked').value;
}

function syncSttMode() {
  const mode = sttMode();
  $("stt-builtin-fields").hidden = mode !== "builtin";
  $("stt-local-fields").hidden = mode !== "local";
  $("stt-remote-fields").hidden = mode !== "remote";
  // The built-in engine has nothing to connect to yet (the model downloads on
  // the next step), so the connection test only makes sense for server/remote.
  $("stt-test-row").hidden = mode === "builtin";
  modelsStarted = false; // choice may change what we download
}

document
  .querySelectorAll('input[name="stt-mode"]')
  .forEach((radio) => radio.addEventListener("change", syncSttMode));

/* ---------- cleanup ---------- */

function cleanupMode() {
  return document.querySelector('input[name="cleanup-mode"]:checked').value;
}

function syncCleanupEnabled() {
  $("cleanup-fields").classList.toggle("disabled", !$("cleanup-enabled").checked);
}

function syncCleanupMode() {
  const builtin = cleanupMode() === "builtin";
  $("cleanup-builtin-fields").hidden = !builtin;
  $("cleanup-service-fields").hidden = builtin;
  $("cleanup-custom-uri-field").hidden =
    !builtin || $("cleanup-builtin-model").value !== "custom";
  syncCleanupModelNote();
  modelsStarted = false;
}

function syncCleanupModelNote() {
  const id = $("cleanup-builtin-model").value;
  const spec = catalog.cleanup.find((m) => m.id === id);
  $("cleanup-builtin-note").textContent = spec ? spec.note : "";
  $("cleanup-custom-uri-field").hidden =
    cleanupMode() !== "builtin" || id !== "custom";
}

$("cleanup-enabled").addEventListener("change", syncCleanupEnabled);
document
  .querySelectorAll('input[name="cleanup-mode"]')
  .forEach((radio) => radio.addEventListener("change", syncCleanupMode));

/* ---------- model select population ---------- */

function fillSelect(select, items, selectedId) {
  select.replaceChildren();
  for (const m of items) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    select.appendChild(opt);
  }
  if (selectedId) select.value = selectedId;
}

/* ---------- collect wizard choices into a settings object ---------- */

function collect() {
  const mode = sttMode();
  const cleanMode = cleanupMode();
  let stt;
  if (mode === "builtin") {
    stt = { ...current.stt, engine: "builtin", localModel: $("stt-builtin-model").value };
  } else if (mode === "local") {
    // Connect to a separately-run Parakeet server at the default local URL.
    stt = { ...defaults.stt, engine: "service", localModel: current.stt.localModel };
  } else {
    stt = {
      ...current.stt,
      engine: "service",
      baseUrl: $("stt-url").value.trim() || defaults.stt.baseUrl,
      apiKey: $("stt-key").value.trim(),
      model: $("stt-model").value.trim() || defaults.stt.model,
    };
  }

  return {
    ...current,
    output: {
      ...current.output,
      mode: document.querySelector('input[name="output-mode"]:checked').value,
    },
    stt,
    cleanup: {
      ...current.cleanup,
      enabled: $("cleanup-enabled").checked,
      engine: cleanMode,
      localModel: $("cleanup-builtin-model").value,
      localModelUri: $("cleanup-custom-uri").value.trim(),
      baseUrl: $("cleanup-url").value.trim() || defaults.cleanup.baseUrl,
      apiKey: $("cleanup-key").value.trim(),
      model: $("cleanup-model").value.trim(),
    },
    audio: {
      ...current.audio,
      deviceId: $("mic-device").value,
    },
    sttServer: {
      autoStart: mode === "local" && $("server-autostart").checked,
      command: $("server-command").value.trim() || defaults.sttServer.command,
    },
  };
}

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

/* ---------- model downloads (step 6) ---------- */

const jobs = {}; // target -> { fill, state, promise }

function fmtBytes(n) {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function makeRow(target, name) {
  const box = $("downloads");
  const row = document.createElement("div");
  row.className = "dl";
  const head = document.createElement("div");
  head.className = "dl-head";
  const nameEl = document.createElement("span");
  nameEl.className = "dl-name";
  nameEl.textContent = name;
  const state = document.createElement("span");
  state.className = "dl-state";
  state.textContent = "Starting…";
  head.append(nameEl, state);
  const bar = document.createElement("div");
  bar.className = "dl-bar";
  const fill = document.createElement("div");
  fill.className = "dl-fill indeterminate";
  bar.appendChild(fill);
  row.append(head, bar);
  box.appendChild(row);
  jobs[target] = { fill, state };
}

// Live progress pushed from the main process while a model downloads.
earheart.on("models:progress", (p) => {
  const job = jobs[p.target];
  if (!job) return;
  if (p.phase === "downloading") {
    if (p.total) {
      const pct = Math.min(100, Math.round((p.received / p.total) * 100));
      job.fill.classList.remove("indeterminate");
      job.fill.style.width = `${pct}%`;
      job.state.textContent = `${pct}% · ${fmtBytes(p.received)} / ${fmtBytes(p.total)}`;
    } else {
      job.state.textContent = fmtBytes(p.received);
    }
  } else if (p.phase === "done") {
    job.fill.classList.remove("indeterminate");
    job.fill.classList.add("done");
    job.state.textContent = "Ready";
    job.state.className = "dl-state ok";
  } else if (p.phase === "error") {
    job.fill.classList.remove("indeterminate");
    job.state.textContent = p.error || "Failed";
    job.state.className = "dl-state err";
  }
});

async function ensureDownloads() {
  if (modelsStarted) return;
  modelsStarted = true;
  const box = $("downloads");
  box.replaceChildren();
  for (const k of Object.keys(jobs)) delete jobs[k];

  const next = collect();
  const status = await earheart.invoke("models:status", {
    stt: { engine: next.stt.engine, localModel: next.stt.localModel },
    cleanup: {
      engine: next.cleanup.engine,
      localModel: next.cleanup.localModel,
      localModelUri: next.cleanup.localModelUri,
    },
  });

  const plan = [];
  if (next.stt.engine === "builtin" && !status.stt.installed) {
    const m = catalog.stt.find((x) => x.id === next.stt.localModel);
    plan.push({
      target: "stt",
      name: `Speech-to-text — ${m ? m.label : "Parakeet"}`,
      payload: { target: "stt", modelId: next.stt.localModel },
    });
  }
  if (
    next.cleanup.enabled &&
    next.cleanup.engine === "builtin" &&
    !status.cleanup.installed
  ) {
    const m = catalog.cleanup.find((x) => x.id === next.cleanup.localModel);
    plan.push({
      target: "cleanup",
      name: `Cleanup — ${m ? m.label : "Gemma"}`,
      payload: {
        target: "cleanup",
        modelId: next.cleanup.localModel,
        customUri: next.cleanup.localModelUri,
      },
    });
  }

  if (plan.length === 0) {
    $("models-hint").textContent = "";
    const p = document.createElement("p");
    p.className = "lead";
    p.textContent =
      "Everything's ready — no downloads needed. Click Next to continue.";
    box.appendChild(p);
    return;
  }

  for (const job of plan) {
    makeRow(job.target, job.name);
    jobs[job.target].promise = earheart.invoke("models:download", job.payload);
  }
}

/* ---------- summary ---------- */

function sttSummary(next) {
  if (next.stt.engine === "builtin") {
    const m = catalog.stt.find((x) => x.id === next.stt.localModel);
    return `In-app Parakeet (${m ? m.label : next.stt.localModel})`;
  }
  if (sttMode() === "local") return "Local Parakeet server";
  return next.stt.baseUrl;
}

function cleanupSummary(next) {
  if (!next.cleanup.enabled) return "Off";
  if (next.cleanup.engine === "builtin") {
    if (next.cleanup.localModel === "custom") {
      return `In-app: ${next.cleanup.localModelUri || "custom model"}`;
    }
    const m = catalog.cleanup.find((x) => x.id === next.cleanup.localModel);
    return `In-app ${m ? m.label : next.cleanup.localModel}`;
  }
  return next.cleanup.model || next.cleanup.baseUrl;
}

function renderSummary() {
  const next = collect();
  const rows = [
    ["Hotkey", next.hotkey],
    ["Microphone", $("mic-device").selectedOptions[0]?.textContent || "System default"],
    ["Speech-to-text", sttSummary(next)],
  ];
  if (sttMode() === "local") {
    rows.push(["Start STT server with app", next.sttServer.autoStart ? "Yes" : "No"]);
  }
  rows.push(["Cleanup", cleanupSummary(next)]);
  rows.push([
    "Output",
    next.output.mode === "paste" ? "Paste into active app" : "Clipboard only",
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
$("stt-builtin-model").addEventListener("change", () => (modelsStarted = false));
$("cleanup-builtin-model").addEventListener("change", syncCleanupModelNote);

/* ---------- finish ---------- */

async function finish() {
  const status = $("finish-status");
  // Don't strand the user with a half-downloaded model: wait for any in-flight
  // downloads to settle first (success or failure), then save.
  const pending = Object.values(jobs)
    .map((j) => j.promise)
    .filter(Boolean);
  if (pending.length) {
    status.textContent = "Finishing once model download completes…";
    status.className = "status";
    await Promise.allSettled(pending);
  }

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

  const status = await earheart.invoke("models:status");
  catalog = status.catalog;

  // Populate model pickers (cleanup gets a "custom" entry for any HF GGUF).
  fillSelect($("stt-builtin-model"), catalog.stt, current.stt.localModel);
  fillSelect(
    $("cleanup-builtin-model"),
    [...catalog.cleanup, { id: "custom", label: "Custom (Hugging Face)…" }],
    current.cleanup.localModel
  );

  hotkeyInput.value = current.hotkey;
  $("server-command").value = current.sttServer.command;
  $("cleanup-url").value = current.cleanup.baseUrl;
  $("cleanup-model").value = current.cleanup.model;
  $("cleanup-custom-uri").value = current.cleanup.localModelUri || "";
  $("cleanup-enabled").checked = current.cleanup.enabled;
  // Reflect the saved STT/cleanup engine choice on the radios. A non-builtin
  // engine is shown as the "remote service" path with its fields pre-filled.
  const sttModeValue = current.stt.engine === "builtin" ? "builtin" : "remote";
  document.querySelector(`input[name="stt-mode"][value="${sttModeValue}"]`).checked = true;
  if (current.stt.engine !== "builtin") {
    $("stt-url").value = current.stt.baseUrl || "";
    $("stt-key").value = current.stt.apiKey || "";
    $("stt-model").value = current.stt.model || "";
  }
  document.querySelector(
    `input[name="cleanup-mode"][value="${current.cleanup.engine === "builtin" ? "builtin" : "service"}"]`
  ).checked = true;
  document.querySelector(
    `input[name="output-mode"][value="${current.output.mode}"]`
  ).checked = true;

  syncSttMode();
  syncCleanupEnabled();
  syncCleanupMode();

  if (platform === "darwin") $("demo-mod").textContent = "⌘";
  if (platform !== "linux") $("wayland-note").style.display = "none";
  showStep(0);
})();
