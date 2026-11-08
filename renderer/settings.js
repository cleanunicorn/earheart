// Settings window renderer.

let current = null; // settings object being edited
// The shared fields as this window last saw them from main; sent with every
// save (sharedBaseline in settings-sync.js).
let baseline = null;
let defaults = null;
let platform = "linux";
let modelStatus = null; // { stt: [...], cleanup: [...] } from the main process
let keyStorage = null; // how main stores API keys (settings:get keyStorage)
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
      section.offsetTop - 12, // main is the section's positioned offset parent
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
      if (p.offsetTop - 40 <= fromTop) {
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

// The discard hotkey is optional in the same way: Clear unbinds it.
const discardHotkeyInput = $("discard-hotkey");
wireHotkeyCapture(discardHotkeyInput, {
  apply: (accelerator) => {
    current.discardHotkey = accelerator;
    discardHotkeyInput.value = accelerator;
  },
  restore: () => current?.discardHotkey || "",
});
$("discard-hotkey-clear").addEventListener("click", () => {
  current.discardHotkey = "";
  discardHotkeyInput.value = "";
});

const paletteHotkeyInput = $("palette-hotkey");
wireHotkeyCapture(paletteHotkeyInput, {
  apply: accelerator => { current.paletteHotkey = accelerator; paletteHotkeyInput.value = accelerator; },
  restore: () => current?.paletteHotkey || "",
});
$("palette-hotkey-clear").addEventListener("click", () => { current.paletteHotkey = ""; paletteHotkeyInput.value = ""; });
async function openCommands() {
  const result = await earheart.invoke("palette:open");
  $("commands-status").textContent = result.ok ? "" : result.error;
}
$("commands").addEventListener("click", openCommands);
document.addEventListener("keydown", event => {
  if (event.isComposing || event.repeat || document.querySelector(".capturing")) return;
  if ((platform === "darwin" ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
    event.preventDefault(); openCommands();
  }
});

const correctHotkeyInput = $("correct-hotkey");
wireHotkeyCapture(correctHotkeyInput, {
  apply: (accelerator) => {
    current.correctHotkey = accelerator;
    correctHotkeyInput.value = accelerator;
  },
  restore: () => current?.correctHotkey || "",
});
$("correct-hotkey-clear").addEventListener("click", () => {
  current.correctHotkey = "";
  correctHotkeyInput.value = "";
});

// The voice command hotkey (#344) is optional like the others.
const commandsHotkeyInput = $("commands-hotkey");
wireHotkeyCapture(commandsHotkeyInput, {
  apply: (accelerator) => {
    current.commands = { ...current.commands, hotkey: accelerator };
    commandsHotkeyInput.value = accelerator;
  },
  restore: () => current?.commands?.hotkey || "",
});
$("commands-hotkey-clear").addEventListener("click", () => {
  current.commands = { ...current.commands, hotkey: "" };
  commandsHotkeyInput.value = "";
});

// Remote fields show only for the remote engine; the engine hint says where
// the text goes either way.
function renderCommandsEngine() {
  const remote = $("commands-engine").value === "remote";
  $("commands-remote").hidden = !remote;
  $("commands-engine-hint").textContent = remote
    ? ""
    : "Runs on this computer with the Cleanup model, so nothing leaves it. Download the model in Cleanup.";
}
$("commands-engine").addEventListener("change", renderCommandsEngine);

// What this OS can do, from main (settings:get commandCapabilities).
function renderCommandCapabilities(caps) {
  if (!caps) return;
  const parts = [];
  if (!caps.capture?.ok) parts.push(`Reading a selection isn't available: ${caps.capture?.reason || "unsupported"}.`);
  if (!caps.apply?.ok) parts.push(`${caps.apply?.reason || "Replacing the selection isn't available."}`);
  if (platform !== "darwin") parts.push("Password fields can't be detected on this system: don't run a command with one focused.");
  $("commands-capabilities").textContent = parts.join(" ");
}

/* ---------- background audio ---------- */

const DUCK_STATUS_REFRESH_MS = 2000;

// The "Lower other audio while recording" status line, shared with the setup
// wizard (renderer/ducking-status.js).
const refreshDuckStatus = () => DuckingStatus.show($("duck-status"));

/* ---------- microphone list ---------- */

// "Play" next to the record sound volume (#341): the start then the stop cue
// at the typed volume, on a throwaway context so nothing lingers. Purely a
// preview — any failure just stays silent.
const RECORD_SOUND_PREVIEW_GAP_MS = 300;
$("record-sound-test").addEventListener("click", () => {
  let ctx = null;
  try {
    const percent = numInRange("record-sound-volume", defaults?.audio?.recordSoundVolumePercent ?? 60);
    ctx = new AudioContext();
    const volume = percent / 100;
    ctx.resume().catch(() => {});
    const first = playCue(ctx, "start", volume);
    setTimeout(() => {
      const second = playCue(ctx, "stop", volume);
      setTimeout(() => ctx.close().catch(() => {}), (second?.ms || 0) + 200);
    }, (first?.ms || 0) + RECORD_SOUND_PREVIEW_GAP_MS);
  } catch {
    ctx?.close().catch(() => {});
  }
});

async function loadMicrophones() {
  const select = $("mic-device");
  const status = $("mic-device-status");
  let selectionChanged = false;
  select.addEventListener("change", () => {
    selectionChanged = true;
  });
  // Show the saved device immediately so saving before (or without)
  // enumeration never silently resets the microphone choice.
  if (current.audio.deviceId) {
    const saved = document.createElement("option");
    saved.value = current.audio.deviceId;
    saved.textContent = i18n.t("rt.configuredMicrophone");
    select.appendChild(saved);
    select.value = current.audio.deviceId;
  }
  try {
    // Ask for permission once so device labels are populated.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter(
      (d) => d.kind === "audioinput" && d.deviceId !== "default"
    );
    microphones.forEach((d) => {
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
    if (
      current.audio.deviceId &&
      !microphones.some((d) => d.deviceId === current.audio.deviceId)
    ) {
      const configured = select.querySelector(`option[value="${CSS.escape(current.audio.deviceId)}"]`);
      if (configured) {
        configured.textContent = i18n.t("rt.configuredMicrophoneNotConnected");
        status.textContent =
          "Saved microphone not found. Dictation can temporarily use the system default; this selection stays saved.";
      }
    }
    if (!selectionChanged) select.value = current.audio.deviceId || "";
    if (typeof onMicrophonesListed === "function") onMicrophonesListed(devices);
  } catch {
    // No microphone permission/device; leave "System default".
  }
  if (!selectionChanged) formBaseline.set(select, { value: select.value, checked: select.checked });
}

// ---- Automatic selection (#339) ----
// The three controls are written ONLY by populate()/showMicPolicy() and the
// post-save sync above, never by device enumeration: loadMicrophones() reports
// what it found through onMicrophonesListed(), and renderMicPolicy() reads the
// controls to draw the preview. So a choice made while enumeration runs can't
// be overwritten by it.
let micDevices = [];
let micClasses = null; // { records, available } once the probe answered

function showMicPolicy(audio) {
  $("mic-mode").value = audio.micMode === "auto" ? "auto" : "manual";
  $("mic-bluetooth").checked = audio.micIncludeBluetooth !== false;
  $("mic-virtual").checked = audio.micIncludeVirtual !== false;
  renderMicPolicy();
}

function onMicrophonesListed(devices) {
  micDevices = devices.filter((d) => d.kind === "audioinput");
  renderMicPolicy();
}

function renderMicPolicy() {
  const auto = $("mic-mode").value === "auto";
  $("mic-auto-options").hidden = !auto;
  // The probe answered with nothing: say the toggles may be inert here.
  $("mic-class-hint").hidden = !(auto && micClasses && !micClasses.available);
  const status = $("mic-auto-status");
  if (!auto) {
    status.textContent = "";
    return;
  }
  if (!micDevices.some((d) => d.label)) {
    status.textContent = "Currently: decided when you start dictating.";
    return;
  }
  const picked = resolveMicrophone({
    mode: "auto",
    savedId: $("mic-device").value,
    includeBluetooth: $("mic-bluetooth").checked,
    includeVirtual: $("mic-virtual").checked,
    devices: micDevices,
    records: micClasses?.records || [],
  });
  status.textContent = picked.notice
    ? `Currently: ${picked.notice.replace(/^./, (c) => c.toLowerCase())}.`
    : `Currently: ${picked.label || "system default"}.`;
}

async function initMicrophonePolicy() {
  for (const id of ["mic-mode", "mic-bluetooth", "mic-virtual", "mic-device"]) {
    $(id).addEventListener("change", renderMicPolicy);
  }
  try {
    // Settings may wait for the OS tool; a take never does.
    micClasses = await earheart.invoke("mics:classes", { wait: 5000 });
  } catch {
    micClasses = { records: [], available: false };
  }
  renderMicPolicy();
}

/* ---------- populate / collect ---------- */

function showOutputMode(output) {
  const mode = displayedOutputMode(output);
  (
    document.querySelector(`input[name="output-mode"][value="${mode}"]`) ||
    document.querySelector('input[name="output-mode"][value="paste"]')
  ).checked = true;
}

function populate() {
  hotkeyInput.value = current.hotkey;
  pauseHotkeyInput.value = current.pauseHotkey || "";
  discardHotkeyInput.value = current.discardHotkey || "";
  correctHotkeyInput.value = current.correctHotkey || "";
  paletteHotkeyInput.value = current.paletteHotkey || "";
  $("commands-shortcut").textContent = displayHotkey("CommandOrControl+K");
  commandsHotkeyInput.value = current.commands?.hotkey || "";
  $("commands-engine").value = current.commands?.engine === "remote" ? "remote" : "builtin";
  $("commands-url").value = current.commands?.baseUrl || "";
  $("commands-key").value = current.commands?.apiKey || "";
  $("commands-model").value = current.commands?.model || "";
  $("commands-allow-apply").checked = current.commands?.allowApply !== false;
  renderCommandsEngine();
  showOutputMode(current.output);

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
  $("cleanup-aliases").value = formatAliases(current.cleanup.aliases);
  $("cleanup-prompt").value = current.cleanup.systemPrompt;
  selectEngine("cleanup", current.cleanup.engine);
  renderKeyStorage();
  $("cleanup-builtin-model").value = current.cleanup.builtin.model;
  syncCleanupEnabled();
  syncEngine("stt");
  syncEngine("cleanup");

  $("start-on-boot").checked = !!current.startOnBoot;
  $("appearance").value = current.appearance || "system";
  populateUiLanguages();
  $("ui-language").value = EarheartI18n.normalizePreference(current.uiLanguage);

  $("history-enabled").checked = current.history.enabled;
  $("agents-enabled").checked = current.agents?.enabled === true;
  $("agents-permission").value = current.agents?.permission === "read" ? "read" : "edit";
  $("agents-codex-path").value = current.agents?.binaries?.codex || "";
  $("agents-claude-path").value = current.agents?.binaries?.claude || "";
  $("recordings-keep").checked = current.recordings?.keep === true;
  $("recordings-days").value = current.recordings?.maxAgeDays ?? defaults.recordings.maxAgeDays;
  $("recordings-mb").value = current.recordings?.maxMegabytes ?? defaults.recordings.maxMegabytes;
  renderRecordingsStatus();
  $("usage-enabled").checked = current.usage?.enabled !== false;
  $("usage-off-hint").hidden = $("usage-enabled").checked;
  $("typing-wpm").value = current.usage?.typingWpm ?? defaults.usage.typingWpm;
  $("output-single-line").checked = current.output.singleLine === true;
  $("updates-autocheck").checked = current.updates?.autoCheck !== false;
  $("updates-remind").checked = current.updates?.remind !== false;
  $("max-seconds").value = current.audio.maxRecordingSeconds;
  $("duck-other-audio").checked = current.audio.duckOtherAudio === true;
  showMicPolicy(current.audio);
  $("duck-level").value = current.audio.duckLevelPercent ?? defaults.audio.duckLevelPercent;
  $("record-sounds").checked = current.audio.recordSounds === true;
  $("record-sound-volume").value = current.audio.recordSoundVolumePercent ?? defaults.audio.recordSoundVolumePercent;
  $("idle-unload").value = current.engines?.idleUnloadMinutes ?? defaults.engines.idleUnloadMinutes;

  if (platform !== "linux") {
    $("wayland-note").style.display = "none";
    $("pause-wayland-note").style.display = "none";
    $("discard-wayland-note").style.display = "none";
  }
}

// The Always replace textarea as records. Never throws, since every form
// comparison calls collect(): text that doesn't parse is carried as it is,
// so it still counts as an unsaved edit, and saveSettings refuses it with
// parseAliases' message before anything is sent.
function collectAliases() {
  const text = $("cleanup-aliases").value;
  try {
    return parseAliases(text);
  } catch {
    return { unparsed: text };
  }
}

function collect() {
  return {
    ...current,
    hotkey: current.hotkey,
    pauseHotkey: current.pauseHotkey || "",
    discardHotkey: current.discardHotkey || "",
    correctHotkey: current.correctHotkey || "",
    paletteHotkey: current.paletteHotkey || "",
    commands: {
      ...current.commands,
      hotkey: current.commands?.hotkey || "",
      engine: $("commands-engine").value === "remote" ? "remote" : "builtin",
      baseUrl: $("commands-url").value.trim(),
      apiKey: $("commands-key").value.trim(),
      model: $("commands-model").value.trim(),
      allowApply: $("commands-allow-apply").checked,
    },
    startOnBoot: $("start-on-boot").checked,
    appearance: $("appearance").value,
    uiLanguage: $("ui-language").value,
    updates: {
      ...current.updates,
      autoCheck: $("updates-autocheck").checked,
      remind: $("updates-remind").checked,
    },
    output: {
      ...current.output,
      mode: document.querySelector('input[name="output-mode"]:checked').value,
      singleLine: $("output-single-line").checked,
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
      aliases: collectAliases(),
      systemPrompt: $("cleanup-prompt").value,
    },
    audio: {
      ...current.audio,
      deviceId: $("mic-device").value,
      // Automatic selection (#339). deviceId above is kept whatever the mode:
      // it is the manual choice and the fallback, never rewritten by auto.
      micMode: $("mic-mode").value === "auto" ? "auto" : "manual",
      micIncludeBluetooth: $("mic-bluetooth").checked !== false,
      micIncludeVirtual: $("mic-virtual").checked !== false,
      // Clamped to the field's own min/max: the markup's limits bind nothing
      // on their own, and a tiny or negative cap ends every dictation at once.
      maxRecordingSeconds: Math.round(
        numInRange(
          "max-seconds",
          current.audio?.maxRecordingSeconds ?? defaults.audio.maxRecordingSeconds
        )
      ),
      duckOtherAudio: $("duck-other-audio").checked,
      duckLevelPercent: Math.round(
        numInRange(
          "duck-level",
          current.audio?.duckLevelPercent ?? defaults.audio.duckLevelPercent
        )
      ),
      recordSounds: $("record-sounds").checked,
      recordSoundVolumePercent: Math.round(
        numInRange(
          "record-sound-volume",
          current.audio?.recordSoundVolumePercent ?? defaults.audio.recordSoundVolumePercent
        )
      ),
    },
    engines: {
      ...current.engines,
      // 0 (or blank) = never unload; otherwise the idle window in minutes.
      idleUnloadMinutes: Math.round(numInRange("idle-unload", 0)),
    },
    history: {
      ...current.history,
      enabled: $("history-enabled").checked,
    },
    // Send to agents (#345): off unless turned on; no full-access mode exists.
    agents: {
      ...current.agents,
      enabled: $("agents-enabled").checked,
      permission: $("agents-permission").value === "read" ? "read" : "edit",
      binaries: {
        codex: $("agents-codex-path").value.trim(),
        claude: $("agents-claude-path").value.trim(),
      },
    },
    // Kept recordings (#343). Main refuses `keep` without secure storage.
    recordings: {
      ...current.recordings,
      keep: $("recordings-keep").checked,
      maxAgeDays: Math.round(numInRange("recordings-days", current.recordings?.maxAgeDays ?? defaults.recordings.maxAgeDays)),
      maxMegabytes: Math.round(numInRange("recordings-mb", current.recordings?.maxMegabytes ?? defaults.recordings.maxMegabytes)),
    },
    // Usage counts (#347): the switch and the time-saved typing baseline.
    usage: {
      ...current.usage,
      enabled: $("usage-enabled").checked,
      typingWpm: Math.round(numInRange("typing-wpm", current.usage?.typingWpm ?? defaults.usage.typingWpm)),
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

// One option per shipped catalog, named in its own language so a user can find
// theirs whatever the current UI language is (#349). Idempotent.
function populateUiLanguages() {
  const select = $("ui-language");
  for (const tag of Object.keys(EarheartLocales)) {
    if (select.querySelector(`option[value="${tag}"]`)) continue;
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = EarheartLocales[tag]["meta.name"] || tag;
    select.append(option);
  }
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
  $("cleanup-custom-from-preset").textContent = i18n.t("rt.startFromPresetLabel", { label: style.label });
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

// num() bounded by the field's own min/max attributes, so the markup stays the
// one place each range is written down.
function numInRange(id, fallback) {
  return num(id, Number($(id).min), Number($(id).max), fallback);
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
  $(`${kind}-engine-state-builtin`).hidden = !builtin;
  $(`${kind}-engine-state-external`).hidden = builtin;
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
const modelDownloads = new Map();

function modelDownloadKey(kind, modelId) {
  return `${kind}:${modelId}`;
}

function showModelError(modelId, error) {
  for (const kind of ["stt", "cleanup"]) {
    const ui = manage[kind];
    if (ui && ui.modelId === modelId) {
      ui.status.textContent = error;
      ui.status.className = "status err";
    }
  }
  const kind = ["stt", "cleanup"].find((candidate) =>
    modelStatus?.[candidate]?.some((model) => model.id === modelId)
  );
  if (kind) announceModelStatus(kind, modelId, error);
}

function renderManage(kind) {
  const container = $(`${kind}-model-manage`);
  if (!container || !modelStatus) return;
  const modelId = $(`${kind}-builtin-model`).value;
  const restoreDownloadFocus =
    manage[kind]?.modelId === modelId &&
    manage[kind].btn === document.activeElement;
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
  const download = modelDownloads.get(modelDownloadKey(kind, modelId));

  if (info.installed) {
    status.textContent = i18n.t("rt.downloaded");
    status.className = "status ok";
    btn.textContent = i18n.t("rt.remove");
    btn.className = "ghost danger";
    // For a custom model "Remove" also forgets its definition, since there's no
    // curated reason to keep an un-downloaded custom entry around.
    btn.onclick = () =>
      info.custom ? removeCustomModel(modelId) : removeModel(kind, modelId);
  } else {
    if (download) {
      bar.hidden = false;
      fill.style.width = `${Math.round(download.fraction * 100)}%`;
      status.textContent = download.message || "Downloading…";
      btn.textContent = i18n.t("rt.cancel");
      btn.className = "ghost";
      btn.onclick = () => earheart.invoke("models:cancel", { kind, modelId });
    } else {
      // Main keeps the last failure, so it shows even when this window
      // opened after the download's models:done (e.g. a wizard handoff).
      status.textContent = info.error || "Not downloaded";
      if (info.error) status.className = "status err";
      btn.textContent = info.error ? "Retry download" : "Download";
      btn.className = "ghost";
      btn.onclick = () => downloadModel(kind, modelId);
    }
  }
  row.append(btn, status);
  // A custom model that isn't downloaded still needs a way off the list.
  if (info.custom && !info.installed) {
    const forget = document.createElement("button");
    forget.textContent = i18n.t("rt.removeFromList");
    forget.className = "ghost danger";
    forget.onclick = () => removeCustomModel(modelId);
    row.append(forget);
  }
  container.append(note, bar, row);
  manage[kind] = ui;
  if (restoreDownloadFocus && !btn.disabled) btn.focus({ preventScroll: true });
}

// Model outcomes announce through one persistent sr-only live region: the
// visible per-row span is rebuilt by renderManage and cannot speak reliably.
function announceModelStatus(kind, modelId, message) {
  const info = modelStatus?.[kind]?.find((m) => m.id === modelId);
  $("model-dl-announce").textContent = `${info ? info.label : modelId}: ${message}`;
}

async function downloadModel(kind, modelId) {
  const key = modelDownloadKey(kind, modelId);
  if (modelDownloads.has(key)) return;
  modelDownloads.set(key, { fraction: 0, message: "Downloading…" });
  renderManage(kind);

  // While the download runs, the same button cancels it (the wizard offers the
  // same escape; without it a multi-minute download in Settings is a one-way
  // trip). models:cancel aborts the in-flight transfer in the main process.
  try {
    const result = await earheart.invoke("models:download", { kind, modelId });
    if (result.error === "Already downloading") {
      // Another window owns this transfer; keep this row bound to its broadcasts.
      const active = modelDownloads.get(key);
      if (active) active.message = "Downloading…";
    }
  } catch (err) {
    finishModelDownload({ kind, modelId, ok: false, error: err.message });
  }
}

async function finishModelDownload(result) {
  const { kind, modelId, ok, cancelled, error } = result;
  modelDownloads.delete(modelDownloadKey(kind, modelId));
  const selectedModelId = manage[kind]?.modelId;
  await refreshModels({ [kind]: selectedModelId });
  if (!ok && manage[kind]?.modelId === modelId) {
    const ui = manage[kind];
    ui.bar.hidden = true;
    ui.btn.textContent = cancelled ? "Download" : "Retry download";
    ui.btn.className = "ghost";
    ui.btn.onclick = () => downloadModel(kind, modelId);
    ui.status.textContent = cancelled ? "Cancelled" : error || "Download failed";
    ui.status.className = cancelled ? "status" : "status err";
  }
  announceModelStatus(
    kind,
    modelId,
    ok ? "Downloaded ✓" : cancelled ? "Cancelled" : error || "Download failed"
  );
}

earheart.on("models:done", (result) => finishModelDownload(result));

// While a removal runs (main first stops any download of the model, which can
// take a moment) the row says so and its buttons are disabled, so a second
// click can't send the same removal again.
function setRowRemoving(modelId, removing) {
  for (const kind of ["stt", "cleanup"]) {
    const ui = manage[kind];
    if (!ui || ui.modelId !== modelId) continue;
    for (const button of $(`${kind}-model-manage`).querySelectorAll("button")) {
      button.disabled = removing;
    }
    if (removing && ui.status) {
      ui.status.textContent = i18n.t("rt.removing");
      ui.status.className = "status";
    }
  }
}

async function removeModel(kind, modelId) {
  const info = modelStatus[kind].find((m) => m.id === modelId);
  const label = info ? info.label : modelId;
  if (!confirm(`Remove ${label}? You'll need to download it again to use it.`)) {
    return;
  }
  setRowRemoving(modelId, true);
  const res = await earheart.invoke("models:remove", { kind, modelId });
  setRowRemoving(modelId, false);
  if (res.ok) {
    // Announce before refreshing, while modelStatus still has the label.
    announceModelStatus(kind, modelId, "Removed");
    await refreshModels();
  } else {
    showModelError(modelId, res.error || "Could not remove model");
  }
}

// Remove a custom model entirely: its files (if downloaded) and its definition.
async function removeCustomModel(modelId) {
  const info = [...modelStatus.stt, ...modelStatus.cleanup].find((m) => m.id === modelId);
  const label = info ? info.label : modelId;
  // An installed custom model loses its download too; say so, like the
  // curated models' confirm does.
  const question = info?.installed
    ? `Remove ${label} and its downloaded files? You'll need to download it again to use it.`
    : `Remove ${label} from your models?`;
  if (!confirm(question)) return;
  setRowRemoving(modelId, true);
  const res = await earheart.invoke("models:remove-custom", { modelId });
  setRowRemoving(modelId, false);
  if (res.ok) {
    current.customModels = res.customModels;
    // Main falls back to the default when the removed model was the saved
    // one. Adopt that, or refreshModels would keep pointing the select at the
    // removed id, which reads back as "" and gets saved as an empty model.
    if (res.kind && res.model) current[res.kind].builtin.model = res.model;
    announceModelStatus(res.kind || info?.kind, modelId, "Removed");
    await refreshModels();
  } else {
    showModelError(modelId, res.error || "Could not remove model");
  }
}

// Re-pull model status and rebuild the dropdowns (custom models may have been
// added or removed), keeping the current selection — or a `preferred` id per
// kind, e.g. to select a model that was just added.
async function refreshModels(preferred = {}) {
  modelStatus = await earheart.invoke("models:status");
  for (const kind of ["stt", "cleanup"]) for (const info of modelStatus[kind]) {
    if (info.download) modelDownloads.set(modelDownloadKey(kind, info.id), {
      fraction: ModelProgress.fraction({ ...info.download, total: info.download.total || info.bytes }),
      message: ModelProgress.label({ ...info.download, total: info.download.total || info.bytes }),
    });
  }
  renderSetupBanner();
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
  // A model added, downloaded or removed can move a select after the click
  // that started it was already checked.
  clearStaleSaved();
}

// "42% · 280 MB / 660 MB" — concrete progress so a slow download reads as
// working, not stalled.
const progressLabel = ModelProgress.label;

earheart.on("models:progress", (p) => {
  const key = modelDownloadKey(p.kind, p.modelId);
  let download = modelDownloads.get(key);
  if (!download) {
    download = { fraction: 0, message: "Downloading…" };
    modelDownloads.set(key, download);
  }
  download.fraction = p.fraction;
  download.message = progressLabel(p);
  renderSetupBanner();
  const m = manage[p.kind];
  if (m && m.modelId === p.modelId && m.fill) {
    m.fill.style.width = `${Math.round(p.fraction * 100)}%`;
    m.status.textContent = download.message;
    m.status.className = "status";
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

/* ---------- new default prompt offer ---------- */

// settings:get says when a new default prompt ships that this user hasn't
// decided on (settings.cleanupPromptOffer). An untouched earlier default only
// needs a yes or no; an edited prompt shows what the new default changes
// against theirs, so they can see what they would gain or lose.
let promptOffer = null;
function renderPromptOffer() {
  const box = $("prompt-offer");
  box.hidden = !promptOffer;
  if (!promptOffer) return;
  const custom = promptOffer.kind === "custom";
  $("prompt-offer-text").textContent = custom
    ? "It is tuned for code dictation. You've edited yours, so it wasn't changed — here is what the new default changes:"
    : "It is tuned for code dictation: a spoken symbol said twice, like “dot dot slash”, becomes code (../) instead of being dropped as a stutter. Yours is the previous default.";
  $("prompt-offer-keep").textContent = custom ? "Keep mine" : "Keep the previous one";
  const diff = $("prompt-offer-diff");
  diff.hidden = !custom;
  diff.replaceChildren();
  if (custom) {
    const marks = { same: "  ", del: "− ", add: "+ " };
    for (const d of foldUnchanged(diffLines($("cleanup-prompt").value, defaults.cleanup.systemPrompt))) {
      const row = document.createElement("span");
      row.className = d.op;
      row.textContent = d.op === "skip"
        ? `  … ${d.count} unchanged line${d.count === 1 ? "" : "s"}`
        : marks[d.op] + d.line;
      diff.append(row);
    }
  }
}

async function answerPromptOffer(decision) {
  $("prompt-offer-status").textContent = "";
  const result = await earheart.invoke("cleanup:prompt-offer", { decision });
  if (!result?.ok) {
    $("prompt-offer-status").textContent = `Couldn't save that: ${result?.error || "unknown error"}`;
    return;
  }
  // Saved by main already, so the field and its unsaved-changes baseline both
  // take the stored prompt (the answer doesn't leave the form looking edited),
  // and `current` takes the decision, which the next form save spreads back.
  const field = $("cleanup-prompt");
  field.value = result.systemPrompt;
  formBaseline.set(field, { value: field.value, checked: field.checked });
  current.cleanup = { ...current.cleanup, systemPrompt: result.systemPrompt, promptOfferDecided: result.promptOfferDecided };
  promptOffer = null;
  renderPromptOffer();
}
$("prompt-offer-use").addEventListener("click", () => answerPromptOffer("use"));
$("prompt-offer-keep").addEventListener("click", () => answerPromptOffer("keep"));

/* ---------- changes saved elsewhere ---------- */

// Main saved the settings (tray radio, update prompt, overlay drag, custom
// models, or this window's own save). Take the values only main writes, and
// show a shared field only when this save changed it — never repopulate the
// whole form, which would throw away edits the user hasn't saved yet.
let pendingSaveSnapshot = null;
function unchangedSinceSave(el) {
  if (!pendingSaveSnapshot) return true;
  return JSON.stringify({ value: el.value, checked: el.checked }) === JSON.stringify(pendingSaveSnapshot.get(el));
}

function applySettingsChange({ previous, current: saved }) {
  // Main already saved this change (the tray, the correction window, an
  // overlay drag), so a form that matched the last Save still matches disk.
  const matchedSave = savedForm !== null && JSON.stringify(collect()) === savedForm;
  const flipped = [];
  if (Array.isArray(saved.dictionary) && JSON.stringify(previous.dictionary) !== JSON.stringify(saved.dictionary)) {
    const field = $("cleanup-dictionary");
    const focused = document.activeElement === field;
    const caret = [field.selectionStart, field.selectionEnd, field.selectionDirection];
    const merged = mergeVocabulary(baseline.dictionary, field.value.split("\n"), saved.dictionary);
    field.value = !focused && !field.value ? merged.join("\n")
      : mergeVocabularyText(baseline.dictionary, field.value, saved.dictionary);
    if (focused) field.setSelectionRange(...caret);
    current.cleanup.dictionary = merged;
    baseline.dictionary = [...saved.dictionary];
    flipped.push("Dictionary updated with saved spellings.");
  }
  if (Array.isArray(saved.aliases) && JSON.stringify(previous.aliases) !== JSON.stringify(saved.aliases)) {
    // Another window (the correction window) added aliases. Append the ones
    // the field doesn't have yet as new lines and never rewrite what the user
    // typed, even when it doesn't parse yet; the save merges by heard form.
    const field = $("cleanup-aliases");
    const caret = [field.selectionStart, field.selectionEnd, field.selectionDirection];
    const focused = document.activeElement === field;
    const shown = new Set();
    for (const line of field.value.split("\n")) {
      const heardPart = line.split(/->|→/)[0];
      for (const heard of heardPart.split(",")) if (heard.trim()) shown.add(aliasKey(heard));
    }
    const before = new Set((baseline.aliases || []).flatMap((r) => r.heard.map(aliasKey)));
    const added = saved.aliases
      .map((r) => ({ term: r.term, heard: r.heard.filter((h) => !before.has(aliasKey(h)) && !shown.has(aliasKey(h))) }))
      .filter((r) => r.heard.length);
    if (added.length) {
      const text = formatAliases(added);
      field.value = field.value.trim() ? `${field.value.replace(/\n+$/, "")}\n${text}` : text;
      if (focused) field.setSelectionRange(...caret);
      flipped.push("Always replace updated with saved aliases.");
    }
    const parsed = collectAliases();
    current.cleanup.aliases = Array.isArray(parsed) ? mergeAliases(baseline.aliases, parsed, saved.aliases) : saved.aliases;
    baseline.aliases = saved.aliases.map((r) => ({ term: r.term, heard: [...r.heard] }));
  }
  current.overlay = saved.overlay;
  current.customModels = saved.customModels;
  current.updates = {
    ...current.updates,
    skippedVersion: saved.updates.skippedVersion,
    lastSeenVersion: saved.updates.lastSeenVersion,
  };
  if (
    previous.output.mode !== saved.output.mode ||
    previous.output.restoreClipboard !== saved.output.restoreClipboard
  ) {
    const shownBefore = document.querySelector('input[name="output-mode"]:checked')?.value;
    current.output = { ...current.output, mode: saved.output.mode, restoreClipboard: saved.output.restoreClipboard };
    const preserveEdit = ![...document.querySelectorAll('input[name="output-mode"]')].every(unchangedSinceSave);
    if (!preserveEdit) showOutputMode(saved.output);
    baseline.outputMode = sharedBaseline(saved).outputMode;
    // Only main's tray radios change the mode while this window is open.
    if (!preserveEdit && shownBefore !== displayedOutputMode(saved.output)) {
      flipped.push(i18n.t("rt.outputModeChangedFromThe"));
    }
  }
  const remind = saved.updates.remind !== false;
  if ((previous.updates.remind !== false) !== remind) {
    current.updates.remind = saved.updates.remind;
    const preserveEdit = !unchangedSinceSave($("updates-remind"));
    if (!preserveEdit && $("updates-remind").checked !== remind) {
      flipped.push(
        remind ? "Update reminders turned on elsewhere." : "Update reminders turned off from the update prompt."
      );
    }
    if (!preserveEdit) $("updates-remind").checked = remind;
    baseline.remind = remind;
  }
  // Re-take the snapshot so the next click doesn't clear "Saved"; a form that
  // already held unsaved edits drops it.
  if (matchedSave) savedForm = JSON.stringify(collect());
  clearStaleSaved();
  announceSettingsChange(flipped.join(" "));
}

// Say why a control just changed under the user. This window's own save never
// flips a control (it already shows what it saved), and a save in flight
// reports its own result, so neither announces here.
function announceSettingsChange(message) {
  const status = $("save-status");
  if (!message || saveButton.disabled) return;
  status.textContent = message;
  status.className = "status";
  setTimeout(() => {
    if (status.textContent === message) status.textContent = "";
  }, 4000);
}

const settingsChangesReady = followSettingsChanges(applySettingsChange);

/* ---------- save ---------- */

// Say under each API key field how the key is kept on disk. Main encrypts keys
// with OS-backed storage when it can (main/secret-store.js); where it can't —
// typically Linux without a keyring, where Electron's fallback is a hardcoded
// password — the key is saved unencrypted and the note says so plainly. A
// stored key that couldn't be decrypted reads as empty, so ask for it again
// until the field holds something.
function keyStorageNote(section, value) {
  if (!keyStorage) return "";
  if (keyStorage.unreadable?.includes(section) && !value) {
    return "Your saved key couldn't be decrypted — the system keyring may be locked or was reset. Enter the key again.";
  }
  if (keyStorage.secure) {
    if (platform === "darwin") return "Saved encrypted with your macOS Keychain.";
    if (platform === "win32") return "Saved encrypted with your Windows account.";
    return "Saved encrypted with your system keyring.";
  }
  if (platform === "linux") {
    return "Saved unencrypted: no system keyring (such as GNOME Keyring or KWallet) is available. The settings file is readable only by your user account. Set up a keyring and restart Earheart to encrypt the key.";
  }
  return "Saved unencrypted: your system's secure storage isn't available. The settings file is readable only by your user account.";
}

function renderKeyStorage() {
  $("stt-key-storage").textContent = keyStorageNote("stt", $("stt-key").value.trim());
  $("cleanup-key-storage").textContent = keyStorageNote("cleanup", $("cleanup-key").value.trim());
  $("commands-key-storage").textContent = keyStorageNote("commands", $("commands-key").value.trim());
}

$("commands-key").addEventListener("input", renderKeyStorage);
$("stt-key").addEventListener("input", renderKeyStorage);
$("cleanup-key").addEventListener("input", renderKeyStorage);

// Show each hotkey's registration failure under its field: the launch result
// (from settings:get) when the window opens, then each Save's. A result is shown
// only while the field holds the accelerator it was attempted with — after a
// rejected save, settings keep the old working value, and an error about the
// rejected one would describe a combination that is no longer there. Two kinds
// are shown regardless: a result without an accelerator (an older main), and an
// `unbound` one — a failed restore left the saved hotkey itself unregistered.
function renderHotkeyStatus(status) {
  const rows = [
    [$("commands-hotkey-status"), status?.commandsHotkey, current.commands?.hotkey],
    [$("hotkey-status"), status?.hotkey, current.hotkey],
    [$("pause-hotkey-status"), status?.pauseHotkey, current.pauseHotkey],
    [$("discard-hotkey-status"), status?.discardHotkey, current.discardHotkey],
    [$("correct-hotkey-status"), status?.correctHotkey, current.correctHotkey],
    [$("palette-hotkey-status"), status?.paletteHotkey, current.paletteHotkey],
  ];
  for (const [row, result, shown] of rows) {
    const stale =
      !result?.unbound && result?.accelerator !== undefined && result.accelerator !== (shown || "");
    row.textContent = result && !result.ok && !stale ? result.error : "";
    row.className = "status err";
  }
}

function hotkeySaveMessage(hotkeyResult, pauseResult, discardResult, correctResult, paletteResult) {
  const failed = [
    [hotkeyResult, "hotkey"],
    [pauseResult, "pause hotkey"],
    [discardResult, "discard hotkey"],
    [correctResult, "correction hotkey"],
    [paletteResult, "Commands hotkey"],
  ].filter(([result]) => result && !result.ok);
  // More than one slot failing is usually one coupled rollback; blaming a
  // single field would be wrong.
  if (failed.length > 1) {
    return "Saved, but the hotkeys could not be changed";
  }
  return `Saved, but the ${failed[0][1]} could not be registered`;
}

// What Save stored differently from what was typed in the Performance limits
// (collect() and main both clamp to the fields' ranges), one phrase each.
// Without this a typed 9999 would quietly become 240.
function limitAdjustments(saved, sent) {
  const fields = [
    { id: "max-seconds", label: "Max dictation length", unit: "s", value: saved.audio?.maxRecordingSeconds },
    { id: "idle-unload", label: "Idle unload", unit: "min", value: saved.engines?.idleUnloadMinutes },
    { id: "recordings-days", label: "Delete recordings after", unit: "days", value: saved.recordings?.maxAgeDays },
    { id: "recordings-mb", label: "Keep at most", unit: "MB", value: saved.recordings?.maxMegabytes },
    { id: "typing-wpm", label: "Typing speed", unit: "WPM", value: saved.usage?.typingWpm },
  ];
  return fields
    .filter(({ id, value }) => {
      const typed = sent.get($(id)).value.trim();
      return typed !== "" && Number(typed) !== value;
    })
    .map(({ id, label, unit, value }) => `${label} set to ${value} ${unit} (allowed ${$(id).min}–${$(id).max})`);
}

// Start (or join) one model's download for Save, through the same row state a
// Download click uses, and resolve with its outcome.
async function saveDownload(kind, modelId) {
  const key = modelDownloadKey(kind, modelId);
  if (!modelDownloads.has(key)) modelDownloads.set(key, { fraction: 0, message: "Downloading…" });
  renderManage(kind);
  $(`${kind}-model-manage`).scrollIntoView({ block: "nearest" });
  try {
    // join: a transfer already running (a Download click, the wizard) is
    // awaited, not started twice.
    return await earheart.invoke("models:download", { kind, modelId, join: true });
  } catch (err) {
    finishModelDownload({ kind, modelId, ok: false, error: err.message });
    return { ok: false, error: err.message };
  }
}

// Persist only models that can run: download every selected built-in model
// that is missing, then collect the form again (it may have changed during the
// download) until nothing is missing. Returns the settings to save; throws with
// the reason when a download fails or is cancelled, so nothing is saved.
async function downloadSelectedModels(save) {
  const finished = new Set();
  for (;;) {
    if (!ModelSave.used(collect()).length) return collect();
    // Fresh status: another window may have downloaded or removed a model.
    await refreshModels();
    const next = collect();
    const [needed] = ModelSave.missing(next, modelStatus);
    if (!needed) return next;
    const key = modelDownloadKey(needed.kind, needed.modelId);
    if (finished.has(key)) throw new Error(`${needed.label}: downloaded, but still not available`);
    save.textContent = i18n.t("rt.downloadingLabelBeforeSaving", { label: needed.label });
    save.className = "status";
    const result = await saveDownload(needed.kind, needed.modelId);
    if (!result?.ok) {
      throw new Error(`${needed.label}: ${result?.cancelled ? "Download cancelled" : result?.error || "Download failed"}`);
    }
    finished.add(key);
  }
}

const saveButton = $("save");
// Set before Save's first await, so a second click (or a programmatic one)
// can't start another save while a download or the commit is in flight.
let saving = false;
saveButton.addEventListener("click", async () => {
  if (saving) return;
  saving = true;
  try {
    await saveSettings();
  } finally {
    saving = false;
  }
});

// The form as the last successful Save left it. "Saved" stays only while the
// form still matches, so it never vouches for unsaved changes. Many edits
// (hotkey capture, Reset, "Start from preset") set values directly and fire
// no input event, so after any interaction compare the form itself.
let savedForm = null;
function clearStaleSaved() {
  const save = $("save-status");
  if (savedForm === null || save.className !== "status ok") return;
  if (JSON.stringify(collect()) === savedForm) return;
  savedForm = null;
  save.textContent = "";
}
for (const event of ["input", "change", "click", "keydown", "keyup"]) {
  // Capture phase plus a task: runs after the control's own handler.
  document.addEventListener(event, () => setTimeout(clearStaleSaved), true);
}

$("close").addEventListener("click", () => earheart.invoke("settings:close"));

// The timer that clears a hotkey failure's message. Each Save cancels it, so
// a failure's timer can't wipe the next Save's result.
let saveStatusTimer;

async function saveSettings() {
  const save = $("save-status");
  clearTimeout(saveStatusTimer);
  let result;
  let pauseResult;
  let discardResult;
  let correctResult;
  // Acknowledge the click immediately and block a duplicate save while the
  // round-trip is in flight.
  saveButton.disabled = true;
  save.textContent = i18n.t("rt.saving");
  save.className = "status";
  try {
    parseAliases($("cleanup-aliases").value);
  } catch (err) {
    save.textContent = i18n.t("rt.notSavedMessage", { message: err.message });
    save.className = "status err";
    saveButton.disabled = false;
    return;
  }
  let next;
  try {
    next = await downloadSelectedModels(save);
  } catch (err) {
    // Nothing was saved: say so, and leave the form as the user set it.
    save.textContent = i18n.t("rt.notSavedMessage", { message: err.message });
    save.className = "status err";
    saveButton.disabled = false;
    return;
  }
  save.textContent = i18n.t("rt.saving");
  save.className = "status";
  try {
    current = next;
    // The controls stay live during the round-trip: remember what was sent, so
    // an edit made meanwhile is never vouched for by "Saved".
    const sent = formSnapshot();
    // The same save broadcasts before replying. Protect later edits in both
    // paths while still letting broadcasts advance the saved baseline.
    pendingSaveSnapshot = sent;
    result = await earheart.invoke("settings:save", { settings: current, baseline });
    // The Hugging Face add-model fields aren't settings: a Find versions
    // lookup landing meanwhile changes nothing Save stores.
    const returned = formSnapshot();
    const unchanged = (el) => JSON.stringify(returned.get(el)) === JSON.stringify(sent.get(el));
    const editedWhileSaving = [...returned.keys()].some(
      (el) => !/-hf-/.test(el.id) && !unchanged(el)
    );
    current = result.settings;
    baseline = sharedBaseline(current);
    // Main may have kept its own value for a shared field (a tray change this
    // form hadn't seen yet), so show what was actually saved unless the user
    // edited that control while waiting. Treat the output radios as one field.
    if ([...document.querySelectorAll('input[name="output-mode"]')].every(unchanged)) {
      showOutputMode(current.output);
    }
    if (unchanged($("updates-remind"))) $("updates-remind").checked = current.updates.remind !== false;
    const adjusted = limitAdjustments(current, sent);
    if (unchanged($("max-seconds"))) $("max-seconds").value = current.audio.maxRecordingSeconds;
    if (unchanged($("duck-other-audio"))) $("duck-other-audio").checked = current.audio.duckOtherAudio === true;
    // Each control on its own: one the user touched while saving keeps their value.
    if (unchanged($("mic-mode"))) $("mic-mode").value = current.audio.micMode === "auto" ? "auto" : "manual";
    if (unchanged($("mic-bluetooth"))) $("mic-bluetooth").checked = current.audio.micIncludeBluetooth !== false;
    if (unchanged($("mic-virtual"))) $("mic-virtual").checked = current.audio.micIncludeVirtual !== false;
    renderMicPolicy();
    if (unchanged($("duck-level"))) $("duck-level").value = current.audio.duckLevelPercent;
    if (unchanged($("record-sounds"))) $("record-sounds").checked = current.audio.recordSounds === true;
    if (unchanged($("record-sound-volume"))) $("record-sound-volume").value = current.audio.recordSoundVolumePercent;
    refreshDuckStatus();
    if (unchanged($("idle-unload"))) $("idle-unload").value = current.engines.idleUnloadMinutes;
    if (unchanged($("recordings-days"))) $("recordings-days").value = current.recordings.maxAgeDays;
    if (unchanged($("recordings-mb"))) $("recordings-mb").value = current.recordings.maxMegabytes;
    if (unchanged($("typing-wpm"))) $("typing-wpm").value = current.usage.typingWpm;
    // Main turns "keep" back off without secure storage: show what was saved.
    $("recordings-keep").checked = current.recordings.keep === true;
    renderRecordingsStatus();
    refreshAgents();
    // Older mains don't report a pause result; treat that as fine.
    pauseResult = result.pauseHotkey ?? { ok: true };
    discardResult = result.discardHotkey ?? { ok: true };
    correctResult = result.correctHotkey ?? { ok: true };
    const hotkeysOk = result.hotkey.ok && pauseResult.ok && discardResult.ok && correctResult.ok && (result.paletteHotkey?.ok !== false);
    const hotkeyStatus = { hotkey: result.hotkey, pauseHotkey: pauseResult, discardHotkey: discardResult, correctHotkey: correctResult, paletteHotkey: result.paletteHotkey, commandsHotkey: result.commandsHotkey };
    if (hotkeysOk) {
      // Save never closes the window (#298): a window that vanished on its own
      // read as a crash. "Saved" stays until the form is edited again; Close
      // dismisses the window.
      const saved = adjusted.length ? `Saved — ${adjusted.join("; ")}` : "Saved";
      if (editedWhileSaving) {
        // What was sent is saved; the edits since are not. Say so, and take no
        // snapshot that would vouch for them.
        save.textContent = i18n.t("rt.savedChangesMadeWhileSaving", { saved });
        save.className = "status";
        savedForm = null;
      } else {
        save.textContent = saved;
        save.className = "status ok";
        savedForm = JSON.stringify(collect());
      }
      renderHotkeyStatus(hotkeyStatus);
      saveButton.disabled = false;
      return;
    }
  } catch (err) {
    // Covers a rejected save AND a resolved-but-malformed result, so the button
    // never stays stuck disabled on "Saving…".
    save.textContent = i18n.t("rt.couldNotSaveMessage", { message: err.message });
    save.className = "status err";
    saveButton.disabled = false;
    return;
  } finally {
    pendingSaveSnapshot = null;
  }
  // A hotkey couldn't be registered: keep the window open so the error is
  // visible and the user can pick a combination that works.
  saveButton.disabled = false;
  save.textContent = hotkeySaveMessage(result.hotkey, pauseResult, discardResult, correctResult, result.paletteHotkey);
  save.className = "status err";
  renderHotkeyStatus({ hotkey: result.hotkey, pauseHotkey: pauseResult, discardHotkey: discardResult, correctHotkey: correctResult, paletteHotkey: result.paletteHotkey, commandsHotkey: result.commandsHotkey });
  saveStatusTimer = setTimeout(() => {
    save.textContent = "";
  }, 4000);
}

/* ---------- connection tests ---------- */

function bindTest(buttonId, resultId, channel, getCfg) {
  const btn = $(buttonId);
  btn.addEventListener("click", async () => {
    const el = $(resultId);
    // Disable while the test is in flight so a second click can't race a stale
    // response over the result (mirrors bindFetchModels).
    btn.disabled = true;
    el.textContent = i18n.t("rt.testing");
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
    el.textContent = i18n.t("rt.fetching");
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
  const browseBtn = $(`${kind}-hf-browse`);

  // Opens the hub in the browser, pre-filtered to this kind; the user copies
  // a repo from there into the field above. Disabled while the browser is
  // being asked, so a double-click doesn't open two tabs.
  let browseError = null;
  browseBtn.addEventListener("click", async () => {
    browseBtn.disabled = true;
    try {
      const res = await earheart.invoke("models:browse-hf", { kind });
      if (!res.ok) {
        browseError = res.error;
        result.textContent = res.error;
        result.className = "status err";
      } else if (browseError !== null && result.textContent === browseError) {
        // Clear only our own stale error, never a Find/Add status.
        result.textContent = "";
        result.className = "status";
        browseError = null;
      }
    } finally {
      browseBtn.disabled = false;
    }
  });

  findBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    findBtn.disabled = true;
    pick.hidden = true;
    result.textContent = i18n.t("rt.lookingUpVersions");
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
      result.textContent = i18n.t("rt.repoVersions", { repo: res.repo, count: res.variants.length });
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
    result.textContent = i18n.t("rt.adding");
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
      result.textContent = i18n.t("rt.addedClickDownloadToFetch");
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
let historyQuery = ""; // what the search field filters by; "" = everything
// Each render asks main for one page; only the newest request may draw it, so
// a slow answer for an older query or page can't land under the current one.
let historyRequest = 0;

function historyCopyButton(label, value, report) {
  const button = document.createElement("button");
  button.className = "copy";
  button.textContent = label;
  button.addEventListener("click", async () => {
    report("");
    try {
      const result = await earheart.invoke("transcript:copy", value);
      if (!result.ok) throw new Error(result.error);
      button.textContent = i18n.t("rt.copied");
      setTimeout(() => (button.textContent = label), 1200);
    } catch (err) { report(`Could not copy: ${err.message}`); }
  });
  return button;
}

// The single line shown in place of cards: nothing saved, nothing matching,
// or the search itself failing. Always text — the query is the user's.
function historyNotice(message) {
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.className = "muted";
  span.textContent = message;
  li.appendChild(span);
  $("history-list").replaceChildren(li);
}

async function renderHistory() {
  const request = ++historyRequest;
  const query = historyQuery;
  let res;
  try {
    res = await earheart.invoke("history:search", {
      query, offset: historyPage * HISTORY_PAGE_SIZE, limit: HISTORY_PAGE_SIZE,
    });
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  if (request !== historyRequest) return; // superseded by a newer query, page or change
  // The entry being played was deleted, expired, cleared or paged away: stop
  // it and let go of its audio.
  if (activePlayer && !(res?.ok && res.entries.some((entry) => entry.id === activePlayer.id && entry.audio === "kept"))) {
    releasePlayer();
  }
  const list = $("history-list");
  const pager = $("history-pager");

  if (!res?.ok) {
    pager.hidden = true;
    historyNotice(`Could not search History: ${res?.error || "unknown error"}`);
    return;
  }
  // Main pulls an offset past the last match back to the last page (after a
  // delete, a clear or a narrower query), so follow it.
  historyPage = Math.floor(res.offset / HISTORY_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(res.total / HISTORY_PAGE_SIZE));
  pager.hidden = pages <= 1;

  if (res.total === 0) {
    historyNotice(res.all === 0 || !query.trim() ? "No transcriptions yet." : `No transcriptions match “${query.trim()}”.`);
    return;
  }
  list.replaceChildren();

  const start = res.offset;
  const slice = res.entries;
  $("history-range").textContent = i18n.t(query.trim() ? "rt.historyRangeMatching" : "rt.historyRange", { from: start + 1, to: start + slice.length, total: res.total });
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
    // `incomplete` means the engine stopped part-way and this is what was
    // recovered — the entry has to say so long after the notification went.
    when.textContent = `${new Date(item.at).toLocaleString(i18n.locale)}${item.cleaned ? i18n.t("rt.tagCleaned") : ""}${
      item.incomplete ? i18n.t("rt.tagIncomplete") : ""
    }${item.audio === "unreadable" ? i18n.t("rt.tagRecordingUnreadable") : ""}`;
    const feedback = document.createElement("span");
    feedback.className = "status err";
    feedback.setAttribute("role", "status");
    const report = (message) => { feedback.textContent = message; };
    const actions = document.createElement("span");
    actions.className = "actions";
    actions.append(historyCopyButton("Copy", item.text, report));
    const correct = document.createElement("button");
    correct.textContent = i18n.t("rt.correct");
    correct.addEventListener("click", async () => {
      report("");
      try {
        const result = await earheart.invoke("correction:open", { id: item.id });
        if (!result.ok) throw new Error(result.error);
      } catch (err) { report(err.message); }
    });
    actions.append(correct);
    if (agentState.enabled) actions.append(agentSendButton(item, li, report));
    if (item.cleaned && typeof item.raw === "string" && item.raw !== item.text) {
      const copyOriginal = historyCopyButton("Copy original", item.raw, report);
      copyOriginal.title = i18n.t("rt.copyTheTranscriptBeforeCleanup");
      actions.append(copyOriginal);
    }
    if (item.audio === "kept") actions.append(...recordingButtons(item, li, report));
    actions.append(historyDeleteButton(item, report));
    meta.append(when, actions);
    li.dataset.id = item.id;
    li.append(text, meta);
    const retry = retryBlock(item, report);
    if (retry) li.append(retry);
    li.append(feedback);
    list.appendChild(li);
    // Still playing this entry's recording from before the redraw: keep it.
    if (activePlayer?.id === item.id) li.insertBefore(activePlayer.audio, li.querySelector(".meta"));
    // The card is laid out as soon as it is attached (the History section is
    // always visible), so overflow past the 3-line clamp is measurable here.
    if (text.scrollHeight > text.clientHeight + 1) {
      const more = document.createElement("button");
      more.className = "more";
      more.textContent = i18n.t("rt.showMore");
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

/* ---------- kept recordings (#343) ---------- */

// The one recording playing (or loaded) in History: { id, audio, url }.
// Released — paused, detached, its blob URL revoked — whenever its entry
// leaves the page, is deleted, or another recording starts.
let activePlayer = null;
// Bumped by every Play and every release: a recording that finishes loading
// after a newer Play, a delete or a clear belongs to nobody and is dropped,
// so at most one player (and one blob URL) ever exists.
let playGeneration = 0;

function releasePlayer() {
  playGeneration += 1;
  if (!activePlayer) return;
  const { audio, url } = activePlayer;
  activePlayer = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  audio.remove();
  URL.revokeObjectURL(url);
}

// What a failed recording action tells the user, by the error main returned.
function recordingError(code) {
  switch (code) {
    case "missing": return "This recording is no longer kept.";
    case "unreadable": return "This recording can't be read: it is damaged, or the key that protects it isn't available. You can delete it.";
    case "insecure": return "Recordings can't be read without the system keyring.";
    case "busy": return "Another retranscription is still running. Try again when it finishes.";
    case "dictating": return "Finish the current dictation, then try again.";
    default: return `Something went wrong (${code}).`;
  }
}

function recordingButtons(item, li, report) {
  const play = document.createElement("button");
  play.className = "play";
  play.type = "button";
  play.textContent = i18n.t("rt.play");
  play.title = i18n.t("rt.playTheRecording");
  play.addEventListener("click", async () => {
    report("");
    if (activePlayer?.id === item.id) {
      activePlayer.audio.play().catch(() => {});
      return;
    }
    releasePlayer();
    const ticket = playGeneration;
    play.disabled = true;
    let res;
    try {
      res = await earheart.invoke("history:audio-get", item.id);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    play.disabled = false;
    // Another Play, a delete or a clear came first, or the card was redrawn
    // away while this loaded: it isn't wanted any more.
    if (ticket !== playGeneration || !li.isConnected) return;
    if (!res?.ok) return report(recordingError(res?.error || "unknown error"));
    const url = URL.createObjectURL(new Blob([res.wav], { type: "audio/wav" }));
    const audio = document.createElement("audio");
    audio.className = "player";
    audio.controls = true; // play, pause and seek
    audio.preload = "auto";
    audio.src = url;
    audio.setAttribute("aria-label", "Recording of this transcription");
    audio.addEventListener("error", () => {
      if (activePlayer?.audio === audio) { releasePlayer(); report(recordingError("unreadable")); }
    });
    activePlayer = { id: item.id, audio, url };
    li.insertBefore(audio, li.querySelector(".meta"));
    audio.play().catch(() => {});
  });

  const exportButton = document.createElement("button");
  exportButton.className = "export";
  exportButton.type = "button";
  exportButton.textContent = i18n.t("rt.export");
  exportButton.title = i18n.t("rt.saveTheRecordingAsA");
  exportButton.addEventListener("click", async () => {
    report("");
    exportButton.disabled = true;
    let res;
    try {
      res = await earheart.invoke("history:audio-export", item.id);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    exportButton.disabled = false;
    if (res?.ok || res?.cancelled) return;
    report(res?.error === "missing" || res?.error === "unreadable" || res?.error === "insecure"
      ? recordingError(res.error)
      : `Couldn't save the file (${res?.error || "unknown error"}). Choose another folder and try again.`);
  });

  const again = document.createElement("button");
  again.className = "retranscribe";
  again.type = "button";
  again.textContent = i18n.t("rt.retranscribe");
  again.title = i18n.t("rt.transcribeTheRecordingAgainWith");
  again.addEventListener("click", async () => {
    report("");
    again.disabled = true;
    again.textContent = i18n.t("rt.retranscribing");
    let res;
    try {
      res = await earheart.invoke("history:retranscribe", item.id);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    // A stored result redraws the page (history:changed); otherwise say why.
    if (!res?.ok && !res?.retry) {
      again.disabled = false;
      again.textContent = i18n.t("rt.retranscribe");
      report(recordingError(res?.error || "unknown error"));
    } else if (res?.ok === false) {
      again.disabled = false;
      again.textContent = i18n.t("rt.retranscribe");
      report(`Couldn't save the retranscription (${res.error}).`);
    }
  });
  return [play, exportButton, again];
}

// The latest retranscription of an entry, under its original: what it said,
// or why there is nothing (failed, or cancelled by a new dictation).
function retryBlock(item, report) {
  const retry = item.retry;
  if (!retry || typeof retry !== "object") return null;
  const box = document.createElement("div");
  box.className = "retry";
  const head = document.createElement("div");
  head.className = "retry-head";
  const when = retry.at ? new Date(retry.at).toLocaleString() : "";
  if (retry.status === "done") {
    head.textContent = `${i18n.t("rt.retranscribedWhen", { when })}${retry.cleaned ? i18n.t("rt.tagCleaned") : ""}${retry.incomplete ? i18n.t("rt.tagIncomplete") : ""}`;
    const text = document.createElement("div");
    text.className = "retry-text";
    text.textContent = retry.text || "(no speech found)";
    box.append(head, text);
    if (retry.text) {
      const copy = historyCopyButton("Copy retranscription", retry.text, report);
      copy.classList.add("retry-copy");
      box.append(copy);
    }
  } else if (retry.status === "cancelled") {
    head.textContent = i18n.t("rt.retranscriptionWhenWasCancelledBy", { when });
    box.append(head);
  } else {
    head.textContent = `Retranscription ${when} failed: ${retry.error || "unknown error"}`;
    box.append(head);
  }
  return box;
}

function historyNoticeAfterDelete(message) {
  const status = $("history-clear-status");
  status.textContent = "";
  status.hidden = false;
  status.textContent = message;
}

function formatMegabytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

// The Keep recordings card: whether it can be on here, what is kept, and
// anything that went wrong keeping it.
let recordingsRequest = 0;
async function renderRecordingsStatus() {
  const request = ++recordingsRequest;
  let status;
  try {
    status = await earheart.invoke("recordings:status");
  } catch {
    status = null;
  }
  if (request !== recordingsRequest || !status) return;
  const keep = $("recordings-keep");
  const reason = $("recordings-reason");
  const historyOn = $("history-enabled").checked;
  // Fail closed: no secure storage, no turning it on (main refuses too).
  keep.disabled = !status.secure && !keep.checked;
  const reasons = [];
  if (!status.secure) reasons.push(status.reason || "Secure storage isn't available, so recordings can't be kept.");
  else if (!historyOn) reasons.push("Turn on History to keep recordings: each one is kept with its transcription.");
  reason.textContent = reasons.join(" ");
  reason.hidden = reasons.length === 0;

  $("recordings-usage").textContent = status.count
    ? `${status.count} recording${status.count === 1 ? "" : "s"} · ${formatMegabytes(status.bytes)}`
    : "No recordings kept";
  $("recordings-clear").disabled = status.count === 0 && status.key !== "lost" && status.key !== "locked";

  const problems = [];
  if (status.key === "locked") problems.push("Kept recordings can't be read: the system keyring that protects them is locked or was replaced. Unlock it, then restart Earheart to play them again; otherwise delete them to keep new ones.");
  if (status.key === "lost") problems.push("The key for kept recordings is missing, so they can't be read. Delete all recordings to start keeping new ones.");
  if (status.lastError && !["insecure", "locked", "lost"].includes(status.lastError.code)) {
    problems.push(status.lastError.code === "too-large"
      ? "The last recording was bigger than the size limit, so it wasn't kept. Its transcription is in History."
      : status.lastError.code === "over-limit"
        ? "The last recording wasn't kept: older recordings over the size limit couldn't be deleted (something may be holding them open). Its transcription is in History."
        : `The last recording couldn't be kept (${status.lastError.code}). Check free disk space; its transcription is in History.`);
  }
  const line = $("recordings-status");
  line.textContent = problems.join(" ");
  line.hidden = problems.length === 0;
}

$("recordings-clear").addEventListener("click", async () => {
  if (!confirm("Delete all kept recordings? Transcriptions stay in History. This can't be undone.")) return;
  releasePlayer();
  let res;
  try {
    res = await earheart.invoke("recordings:clear");
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  await renderRecordingsStatus();
  if (!res?.ok) {
    const line = $("recordings-status");
    line.hidden = false;
    line.textContent = i18n.t("rt.someRecordingsCouldntBeDeleted", { error: res?.error || i18n.t("rt.unknownError") });
  }
  renderHistory();
});

$("history-enabled").addEventListener("change", () => renderRecordingsStatus());

// Deletes one entry, gated like Clear history: it is gone for good. A failed
// delete keeps the card and says why on it; a successful one redraws the
// current page (main keeps the pager in range), not the newest.
function historyDeleteButton(item, report) {
  const button = document.createElement("button");
  button.className = "delete danger";
  button.textContent = i18n.t("rt.delete");
  button.title = i18n.t("rt.deleteThisTranscription");
  button.addEventListener("click", async () => {
    report("");
    // Its kept recording goes with it (main/ipc.js history:delete): say so.
    const question = item.audio
      ? "Delete this transcription and its kept recording? This can't be undone."
      : "Delete this transcription? This can't be undone.";
    if (!confirm(question)) return;
    // Deleted mid-playback: stop and release it before the audio goes.
    if (activePlayer?.id === item.id) releasePlayer();
    button.disabled = true;
    let res;
    try {
      res = await earheart.invoke("history:delete", item.id);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (res?.ok) {
      if (res.audioError) {
        historyNoticeAfterDelete(`Deleted. Its recording couldn't be deleted yet (${res.audioError}); Earheart will try again.`);
      }
      renderHistory();
      return;
    }
    button.disabled = false;
    report(historyEntryDeleteError(res?.error || "unknown error"));
  });
  return button;
}

// Typing filters as you go; each keystroke cancels any answer still on its
// way, and the request itself waits for a pause.
let historySearchTimer = null;
$("history-search").addEventListener("input", (event) => {
  historyQuery = event.target.value;
  historyPage = 0;
  historyRequest += 1;
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(renderHistory, 150);
});

$("history-newer").addEventListener("click", () => {
  historyPage -= 1;
  renderHistory();
});

$("history-older").addEventListener("click", () => {
  historyPage += 1;
  renderHistory();
});

// What a failed delete (Clear history, or one entry) tells the user to do, by
// the reason it failed: a file held open (Windows, an antivirus scan, a
// backup) can be changed once it's let go; a refused write (permissions, a
// locked file attribute) can't until that's fixed.
function historyFileAdvice(code) {
  return code === "EBUSY"
    ? "Close anything that might be using the history file, such as a backup or antivirus scan, and try again."
    : "Check that you can change files in Earheart's settings folder, then try again.";
}

function historyClearError(code) {
  return `Couldn't delete the saved transcriptions, so they're still on this computer (${code}). ${historyFileAdvice(code)}`;
}

function historyEntryDeleteError(code) {
  return `Couldn't delete this transcription, so it's still on this computer (${code}). ${historyFileAdvice(code)}`;
}

$("history-clear").addEventListener("click", async () => {
  // Unlike a removed model, cleared history is gone for good — gate it the
  // same way model removal already is. Every kept recording goes with it
  // (main/ipc.js history:clear), so the question says so.
  if (!confirm("Clear all saved transcriptions and any kept recordings? This can't be undone.")) return;
  const res = await earheart.invoke("history:clear");
  // A failed delete left the transcripts on disk: say so, and keep showing
  // them so the user can try again (#287).
  const status = $("history-clear-status");
  // Emptied first, so a second failure in a row is announced again.
  status.textContent = "";
  status.hidden = res?.ok !== false;
  if (!status.hidden) status.textContent = historyClearError(res.error);
  else if (res?.audioError) {
    status.hidden = false;
    status.textContent = i18n.t("rt.clearedTheTranscriptionsButSome", { audioError: res.audioError });
  }
  releasePlayer();
  renderHistory();
  renderRecordingsStatus();
});

// The History section is always on the panel now, so keep it live. A new
// dictation snaps back to the newest page so it is immediately visible.
// `{ updated: true }` marks a change to entries already listed (a
// retranscription, a recording kept, pruned or deleted): stay on the page.
earheart.on("history:changed", (change) => {
  if (!change?.updated) historyPage = 0;
  renderHistory();
  renderRecordingsStatus();
});

/* ---------- agents (#345) ---------- */

// Send a reviewed transcript to an installed coding agent and follow the task.
// Everything here is built with textContent: briefs and agent output are the
// user's words and an agent's, and may look like markup. Nothing is sent until
// the user presses Send in the review form; the idempotency key below makes a
// repeated press (or a replayed request) start one task, not two.
let agentState = { enabled: false, agents: [], tasks: [], projects: [], permission: "edit" };
let agentRequest = 0;
const agentReplyDrafts = new Map(); // task id -> reply text kept across redraws
let agentOpenReview = null; // { id, remove } — one review form at a time

function agentNewKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function agentButton(label, onClick, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = label;
  if (title) button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

async function refreshAgents() {
  const request = ++agentRequest;
  let res;
  try {
    res = await earheart.invoke("agent:state");
  } catch {
    res = { ok: false };
  }
  if (request !== agentRequest) return;
  const wasEnabled = agentState.enabled;
  agentState = res?.ok ? { enabled: true, ...res } : { enabled: false, agents: [], tasks: [], projects: [], permission: "edit" };
  $("agent-tasks").hidden = !agentState.enabled;
  const detected = $("agents-detected");
  detected.textContent = agentState.enabled
    ? agentState.agents
        .map((a) => `${a.label}: ${a.available ? `found${a.version ? ` (${a.version})` : ""}` : a.reason || "not found"}`)
        .join(" · ")
    : "";
  renderAgentTasks();
  if (wasEnabled !== agentState.enabled) renderHistory();
}

function agentStatusText(task) {
  const base = { starting: "Starting…", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" }[task.status] || task.status;
  return task.status === "running" && task.progress ? `${base} — ${task.progress}` : base;
}

function renderAgentTasks() {
  const list = $("agent-task-list");
  if (!agentState.enabled) { list.replaceChildren(); return; }
  if (!agentState.tasks.length) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = "No agent tasks yet.";
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...agentState.tasks.map(agentTaskItem));
}

function agentTaskItem(task) {
  const li = document.createElement("li");
  li.dataset.id = task.id;
  const title = document.createElement("div");
  title.className = "agent-title";
  title.textContent = `${task.agentLabel} · ${task.project}`;
  const status = document.createElement("div");
  status.className = `agent-status ${task.status}`;
  status.setAttribute("role", "status");
  status.textContent = `${agentStatusText(task)}${task.turns > 1 ? ` · ${task.turns} messages` : ""}${task.error ? ` — ${task.error}` : ""}`;
  const brief = document.createElement("div");
  brief.className = "agent-brief";
  brief.textContent = task.brief;
  li.append(title, status, brief);
  if (task.output) {
    const output = document.createElement("div");
    output.className = "agent-output";
    output.textContent = task.output;
    li.append(output);
  }
  const feedback = document.createElement("span");
  feedback.className = "status err";
  feedback.setAttribute("role", "status");
  const report = (message) => { feedback.textContent = message; };
  const actions = document.createElement("div");
  actions.className = "agent-row";
  // Each action invokes a literal channel (the IPC contract test reads them).
  const act = (call) => async () => {
    report("");
    try {
      const res = await call();
      if (!res?.ok) report(res?.error || "That didn't work.");
    } catch (err) { report(err.message); }
    refreshAgents();
  };
  const active = task.status === "starting" || task.status === "running";
  if (active) actions.append(agentButton("Cancel", act(() => earheart.invoke("agent:cancel", task.id))));
  if (task.resumeCommand) actions.append(agentButton("Copy resume command", act(() => earheart.invoke("agent:copy-resume", task.id)), "Copies a command that opens this session in the agent's own terminal UI"));
  if (!active) actions.append(agentButton("Remove", act(() => earheart.invoke("agent:remove", task.id))));
  li.append(actions);
  if (!active && task.externalId) {
    const row = document.createElement("div");
    row.className = "agent-row";
    const input = document.createElement("textarea");
    input.rows = 2;
    input.placeholder = "Reply to continue this task…";
    input.setAttribute("aria-label", "Reply to this task");
    input.value = agentReplyDrafts.get(task.id) || "";
    input.addEventListener("input", () => agentReplyDrafts.set(task.id, input.value));
    const send = agentButton("Send reply", async () => {
      report("");
      send.disabled = true; // one press, one reply
      try {
        const res = await earheart.invoke("agent:reply", { id: task.id, text: input.value });
        if (res?.ok) agentReplyDrafts.delete(task.id);
        else report(res?.error || "The reply wasn't sent."); // the text stays for a retry
      } catch (err) { report(err.message); }
      send.disabled = false;
      refreshAgents();
    });
    row.append(input, send);
    li.append(row);
  }
  li.append(feedback);
  return li;
}

earheart.on("agent:changed", () => refreshAgents());

function agentSendButton(item, li, report) {
  return agentButton("Send to agent…", () => openAgentReview(item, li, report));
}

function openAgentReview(item, li, report) {
  if (agentOpenReview) agentOpenReview.remove();
  const usable = agentState.agents.filter((a) => a.available);
  const form = document.createElement("div");
  form.className = "agent-review";
  const close = () => { form.remove(); if (agentOpenReview?.form === form) agentOpenReview = null; };
  agentOpenReview = { form, remove: close };
  if (!usable.length) {
    const none = document.createElement("p");
    none.className = "hint";
    none.textContent = "No supported agent was found. Install Codex or Claude Code, or set its path above.";
    form.append(none, agentButton("Close", close));
    li.append(form);
    return;
  }
  const brief = document.createElement("textarea");
  brief.value = item.text;
  brief.setAttribute("aria-label", "Brief to send — review and edit it");
  const agentSelect = document.createElement("select");
  agentSelect.setAttribute("aria-label", "Agent");
  for (const a of usable) agentSelect.append(new Option(a.label, a.id));
  const modelSelect = document.createElement("select");
  modelSelect.setAttribute("aria-label", "Model");
  const syncModels = () => {
    const models = usable.find((a) => a.id === agentSelect.value)?.models || [];
    modelSelect.replaceChildren(new Option("Agent's default model", ""), ...models.map((m) => new Option(m, m)));
    modelSelect.hidden = !models.length; // shown only where the agent supports a choice
  };
  agentSelect.addEventListener("change", syncModels);
  syncModels();
  const projectSelect = document.createElement("select");
  projectSelect.setAttribute("aria-label", "Project folder");
  projectSelect.append(new Option("Choose a project folder…", ""));
  for (const p of agentState.projects) projectSelect.append(new Option(p, p));
  const choose = agentButton("Browse…", async () => {
    const res = await earheart.invoke("agent:pick-project");
    if (res?.ok && res.path) {
      if (![...projectSelect.options].some((o) => o.value === res.path)) projectSelect.append(new Option(res.path, res.path));
      projectSelect.value = res.path;
    } else if (res && !res.ok) feedback.textContent = res.error;
  });
  const disclosure = document.createElement("p");
  disclosure.className = "hint";
  disclosure.textContent = "This brief goes to the agent and its provider, which may process it off-device. Nothing is sent until you press Send.";
  const feedback = document.createElement("span");
  feedback.className = "status err";
  feedback.setAttribute("role", "status");
  const key = agentNewKey(); // one review, one send
  let sent = false;
  const send = agentButton("Send", async () => {
    feedback.textContent = "";
    if (sent) return;
    if (!projectSelect.value) { feedback.textContent = "Choose a project folder first."; return; }
    sent = true;
    send.disabled = true;
    let res;
    try {
      res = await earheart.invoke("agent:send", {
        key, agent: agentSelect.value, model: modelSelect.value, project: projectSelect.value,
        brief: brief.value, historyId: item.id,
      });
    } catch (err) { res = { ok: false, error: err.message }; }
    if (res?.ok) {
      close();
      report("");
      refreshAgents();
      return;
    }
    // A refusal keeps the form and the brief; the same key is safe to retry.
    sent = false;
    send.disabled = false;
    feedback.textContent = res?.error || "The brief wasn't sent.";
  });
  send.className = "";
  const row = document.createElement("div");
  row.className = "agent-row";
  row.append(agentSelect, modelSelect, projectSelect, choose);
  const buttons = document.createElement("div");
  buttons.className = "agent-row";
  buttons.append(send, agentButton("Cancel", close), feedback);
  form.append(brief, row, disclosure, buttons);
  li.append(form);
  brief.focus();
}

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
    el.textContent = i18n.t("rt.couldntOpenTheLogMessage", { message: err.message });
    el.className = "status err";
  }
});

/* ---------- macOS auto-paste (Accessibility + Automation) permissions ---------- */

function setAccessibilityStatus(text, cls = "status") {
  const el = $("accessibility-status");
  el.textContent = text;
  el.className = cls;
}

$("accessibility-fix").addEventListener("click", async () => {
  const btn = $("accessibility-fix");
  btn.disabled = true;
  // The check can sit on a macOS permission prompt for up to half a minute.
  setAccessibilityStatus("Checking… answer the macOS prompt if one appears.");
  try {
    const { text, cls } = permissionFixStatus(await earheart.invoke("permissions:accessibility-fix"));
    setAccessibilityStatus(text, cls);
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
  const status = permissionCheckStatus(await earheart.invoke("permissions:accessibility-check"));
  if (status) setAccessibilityStatus(status.text, status.cls);
});

// Saved setup uses committed settings, independently of unsaved form edits.
let savedSetup = null;
let formBaseline = new Map();
let formReady = false;
let pendingNavigation = null;
function formSnapshot() {
  return new Map([...document.querySelectorAll("input, select, textarea")].map((el) =>
    [el, { value: el.value, checked: el.checked }]));
}
function renderSetupBanner() {
  if (!savedSetup || !modelStatus) return;
  const speech = modelStatus.stt.find((m) => m.id === savedSetup.stt.builtin?.model);
  const unavailable = savedSetup.stt.engine === "builtin" && !speech?.installed;
  $("wizard-banner-title").textContent = unavailable ? "Setup saved." : "You\u0027re set.";
  $("wizard-saved-message").textContent = unavailable
    ? "Your setup is saved. Download speech in Settings → Speech-to-text before dictating."
    : "Your setup is saved — click into any text field and press " + displayHotkey(savedSetup.hotkey) + " to dictate.";
  const id = savedSetup.cleanup.builtin?.model;
  const usesCleanup = savedSetup.cleanup.enabled && savedSetup.cleanup.engine === "builtin";
  const download = usesCleanup && modelDownloads.get(modelDownloadKey("cleanup", id));
  // From status, not only live events: a background cleanup download can fail
  // before this window subscribed to models:done.
  const cleanup = usesCleanup && modelStatus.cleanup.find((m) => m.id === id);
  $("wizard-cleanup-progress").textContent = download
    ? " Cleanup downloading — " + download.message + ". Dictations use raw transcripts until it is ready."
    : cleanup && !cleanup.installed
      ? cleanup.error
        ? " Cleanup download failed (" + cleanup.error + "). Dictations use raw transcripts; retry it in Settings → Cleanup."
        : " Cleanup isn't downloaded. Dictations use raw transcripts; download it in Settings → Cleanup."
      : "";
}
let settingsNavigation = 0;
async function navigateSettings(destination) {
  const navigationVersion = ++settingsNavigation;
  if (!formReady) { pendingNavigation = destination; return; }
  if (destination.fromWizard) {
    const before = formSnapshot();
    const dirty = new Map([...before].filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(formBaseline.get(id))));
    savedSetup = (await earheart.invoke("settings:get")).settings;
    current = savedSetup;
    baseline = sharedBaseline(current);
    await refreshModels();
    populate();
  renderPromptOffer();
    formBaseline = formSnapshot();
    for (const [el, value] of dirty) {
      el.value = value.value;
      if ("checked" in el) el.checked = value.checked;
    }
    syncCleanupEnabled();
    renderStyleLabel(); syncStyleMode();
    syncEngine("stt"); syncEngine("cleanup");
    $("wizard-banner").hidden = false;
  }
  renderSetupBanner();
  if (!["general", "live", "stt", "cleanup", "history", "advanced"].includes(destination.section)) return;
  activateTab(destination.section, { focusSection: true });
  if (destination.section === "history" && typeof destination.query === "string") {
    historyQuery = destination.query.slice(0, 200);
    $("history-search").value = historyQuery;
    historyPage = 0;
    if (destination.entryId) {
      const page = await earheart.invoke("history:search", { query: historyQuery, limit: 50 });
      if (navigationVersion !== settingsNavigation) return;
      const index = page.ok ? page.entries.findIndex(item => item.id === destination.entryId) : -1;
      if (index >= 0) historyPage = Math.floor(index / HISTORY_PAGE_SIZE);
    }
    await renderHistory();
    if (navigationVersion !== settingsNavigation) return;
    const card = [...$("history-list").children].find(item => item.dataset.id === destination.entryId);
    if (card) {
      card.tabIndex = -1;
      card.focus();
      card.scrollIntoView({ block: "center" });
    } else {
      $("history-search").focus();
      if (destination.entryId) {
        $("history-clear-status").hidden = false;
        $("history-clear-status").textContent = "This transcript is no longer in the matching History results.";
      }
    }
  }
  if (destination.model && ["stt", "cleanup"].includes(destination.section)) {
    const target = $(destination.section + "-model-manage");
    target?.scrollIntoView({ block: "center" });
    target?.querySelector("button")?.focus({ preventScroll: true });
  }
}
earheart.on("settings:navigate", (destination) => navigateSettings(destination));
$("wizard-banner-dismiss").addEventListener("click", () => { $("wizard-banner").hidden = true; });

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
      action.textContent = i18n.t("rt.checking");
      status.textContent = "";
      break;
    case "available":
      if (u.method === "install") {
        action.textContent = i18n.t("rt.updateToVlatest", { latest: u.latest });
      } else {
        action.textContent = i18n.t("rt.openDownloadPage");
        if (u.hint) $("update-hint").textContent = u.hint;
      }
      status.textContent = i18n.t("rt.versionLatestIsAvailable", { latest: u.latest });
      status.className = "status ok";
      break;
    case "downloading": {
      const pct = Math.round(((u.progress && u.progress.fraction) || 0) * 100);
      $("update-fill").style.width = `${pct}%`;
      action.textContent = i18n.t("rt.cancel");
      status.textContent = i18n.t("rt.downloadingPct", { pct });
      break;
    }
    case "ready":
      action.textContent = i18n.t("rt.restartToUpdateToVlatest", { latest: u.latest });
      status.textContent = i18n.t("rt.downloaded");
      status.className = "status ok";
      break;
    case "installing":
      action.textContent = i18n.t("rt.restarting");
      status.textContent = "";
      break;
    case "error":
      action.textContent = u.latest ? "Retry update" : "Check for updates";
      status.textContent = u.error || "Update failed";
      status.className = "status err";
      break;
    default:
      // idle — leave any "Up to date ✓" set by a manual check in place
      action.textContent = i18n.t("rt.checkForUpdates");
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
      $("update-status").textContent = i18n.t("rt.upToDate");
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
  baseline = sharedBaseline(current);
  defaults = data.defaults;
  platform = data.platform;
  cleanupStyles = data.cleanupStyles || [];
  promptOffer = data.promptOffer || null;
  keyStorage = data.keyStorage || null;
  // A hotkey that failed at launch shows now, not after a Save — and before
  // the update and model round-trips below.
  renderHotkeyStatus(data.hotkeyStatus);
  renderCommandCapabilities(data.commandCapabilities);
  // The Accessibility permission only exists on macOS.
  if (platform === "darwin") $("accessibility-field").hidden = false;
  $("version").textContent = `v${data.version}`;
  renderUpdateState(await earheart.invoke("updates:get"));
  modelStatus = await earheart.invoke("models:status");
  for (const kind of ["stt", "cleanup"]) for (const info of modelStatus[kind]) {
    if (info.download) modelDownloads.set(modelDownloadKey(kind, info.id), {
      fraction: ModelProgress.fraction({ ...info.download, total: info.download.total || info.bytes }),
      message: ModelProgress.label({ ...info.download, total: info.download.total || info.bytes }),
    });
  }
  renderSetupBanner();
  populateModelSelect("stt");
  populateModelSelect("cleanup");
  populate();
  renderPromptOffer();
  formBaseline = formSnapshot();
  savedSetup = current;
  formReady = true;
  const query = new URLSearchParams(location.search);
  const destination = pendingNavigation || {
    fromWizard: query.has("wizard"), section: query.get("section"), model: query.has("model"),
    ...(query.has("query") ? { query: query.get("query"), entryId: query.get("entryId") } : {}),
  };
  await navigateSettings(destination);
  settingsChangesReady();
  if (destination.section !== "history" || typeof destination.query !== "string") renderHistory();
  refreshAgents();
  loadMicrophones();
  initMicrophonePolicy();
  refreshDuckStatus();
  // The line says what is happening now (lowered, skipped, failed), which
  // changes with every take: keep it current while the window is shown.
  setInterval(() => {
    if (!document.hidden) refreshDuckStatus();
  }, DUCK_STATUS_REFRESH_MS);
})();
