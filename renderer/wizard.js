// First-run setup wizard renderer. Walks through hotkey, microphone,
// speech-to-text, cleanup and output, then saves and hands over to the
// settings window with everything pre-filled.

let current = null; // settings object being edited
let defaults = null;
let platform = "linux";
let micLoaded = false;

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
  if (steps[stepIndex].id === "step-mic" && !micLoaded) {
    micLoaded = true;
    loadMicrophones();
  }
  if (steps[stepIndex].id === "step-finish") renderSummary();
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
  const local = sttMode() === "local";
  $("stt-local-fields").hidden = !local;
  $("stt-remote-fields").hidden = local;
}

document
  .querySelectorAll('input[name="stt-mode"]')
  .forEach((radio) => radio.addEventListener("change", syncSttMode));

/* ---------- cleanup ---------- */

function syncCleanupEnabled() {
  $("cleanup-fields").classList.toggle("disabled", !$("cleanup-enabled").checked);
}
$("cleanup-enabled").addEventListener("change", syncCleanupEnabled);

/* ---------- collect wizard choices into a settings object ---------- */

function collect() {
  const local = sttMode() === "local";
  return {
    ...current,
    output: {
      ...current.output,
      mode: document.querySelector('input[name="output-mode"]:checked').value,
    },
    stt: local
      ? { ...defaults.stt }
      : {
          ...current.stt,
          baseUrl: $("stt-url").value.trim() || defaults.stt.baseUrl,
          apiKey: $("stt-key").value.trim(),
          model: $("stt-model").value.trim() || defaults.stt.model,
        },
    cleanup: {
      ...current.cleanup,
      enabled: $("cleanup-enabled").checked,
      baseUrl: $("cleanup-url").value.trim() || defaults.cleanup.baseUrl,
      apiKey: $("cleanup-key").value.trim(),
      model: $("cleanup-model").value.trim(),
    },
    audio: {
      ...current.audio,
      deviceId: $("mic-device").value,
    },
    sttServer: {
      autoStart: local && $("server-autostart").checked,
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

/* ---------- summary ---------- */

function renderSummary() {
  const next = collect();
  const local = sttMode() === "local";
  const mic = $("mic-device");
  const rows = [
    ["Hotkey", next.hotkey],
    ["Microphone", mic.selectedOptions[0]?.textContent || "System default"],
    [
      "Speech-to-text",
      local ? "Local Parakeet server" : next.stt.baseUrl,
    ],
  ];
  if (local) {
    rows.push(["Start STT server with app", next.sttServer.autoStart ? "Yes" : "No"]);
  }
  rows.push([
    "Cleanup",
    next.cleanup.enabled ? next.cleanup.model || "enabled" : "Off",
  ]);
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

  hotkeyInput.value = current.hotkey;
  $("server-command").value = current.sttServer.command;
  $("cleanup-url").value = current.cleanup.baseUrl;
  $("cleanup-model").value = current.cleanup.model;
  $("cleanup-enabled").checked = current.cleanup.enabled;
  document.querySelector(
    `input[name="output-mode"][value="${current.output.mode}"]`
  ).checked = true;
  syncSttMode();
  syncCleanupEnabled();

  if (platform === "darwin") $("demo-mod").textContent = "⌘";
  if (platform !== "linux") $("wayland-note").style.display = "none";
  showStep(0);
})();
