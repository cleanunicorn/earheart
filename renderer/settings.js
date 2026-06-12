// Settings window renderer.

let current = null; // settings object being edited
let defaults = null;
let platform = "linux";

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
  document.querySelector(
    `input[name="output-mode"][value="${current.output.mode}"]`
  ).checked = true;
  $("restore-clipboard").checked = current.output.restoreClipboard;

  $("stt-url").value = current.stt.baseUrl;
  $("stt-key").value = current.stt.apiKey;
  $("stt-model").value = current.stt.model;
  $("stt-language").value = current.stt.language;

  $("cleanup-enabled").checked = current.cleanup.enabled;
  $("cleanup-url").value = current.cleanup.baseUrl;
  $("cleanup-key").value = current.cleanup.apiKey;
  $("cleanup-model").value = current.cleanup.model;
  $("cleanup-temperature").value = current.cleanup.temperature;
  $("cleanup-prompt").value = current.cleanup.systemPrompt;
  syncCleanupEnabled();

  $("history-enabled").checked = current.history.enabled;
  $("server-autostart").checked = current.sttServer.autoStart;
  $("server-command").value = current.sttServer.command;
  $("max-seconds").value = current.audio.maxRecordingSeconds;

  if (platform !== "linux") $("wayland-note").style.display = "none";
}

function collect() {
  return {
    ...current,
    hotkey: current.hotkey,
    output: {
      ...current.output,
      mode: document.querySelector('input[name="output-mode"]:checked').value,
      restoreClipboard: $("restore-clipboard").checked,
    },
    stt: {
      ...current.stt,
      baseUrl: $("stt-url").value.trim(),
      apiKey: $("stt-key").value.trim(),
      model: $("stt-model").value.trim(),
      language: $("stt-language").value.trim(),
    },
    cleanup: {
      ...current.cleanup,
      enabled: $("cleanup-enabled").checked,
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
    sttServer: {
      autoStart: $("server-autostart").checked,
      command: $("server-command").value.trim(),
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

/* ---------- setup wizard hand-off ---------- */

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
  populate();
  loadMicrophones();
})();
