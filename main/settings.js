// Settings persistence: a plain JSON file in Electron's userData directory.
// Keys are grouped by concern so modules can take just the slice they need.

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CLEANUP_PROMPT = `You clean up raw speech-to-text transcriptions.

Rules:
- Fix punctuation, capitalization and obvious transcription mistakes.
- Remove filler words (um, uh, you know, like) and false starts.
- Keep the speaker's meaning, wording and tone; do not summarize or expand.
- If the speaker dictates formatting ("new line", "new paragraph"), apply it.
- Output ONLY the cleaned text. No quotes, no preamble, no explanations.`;

const DEFAULTS = {
  // Global hotkey (Electron accelerator format). Press once to start
  // recording, press again to stop and transcribe.
  hotkey: "CommandOrControl+Shift+Space",
  output: {
    mode: "paste", // "paste" = type into focused app, "clipboard" = copy only
    restoreClipboard: true, // after pasting, restore previous clipboard text
    pasteDelayMs: 150, // wait before simulating the paste keystroke
  },
  stt: {
    baseUrl: "http://127.0.0.1:8484/v1",
    apiKey: "",
    model: "parakeet",
    language: "",
    timeoutMs: 120000,
  },
  cleanup: {
    enabled: false,
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    model: "",
    temperature: 0.2,
    timeoutMs: 60000,
    systemPrompt: DEFAULT_CLEANUP_PROMPT,
  },
  audio: {
    deviceId: "", // empty = system default microphone
    maxRecordingSeconds: 300,
  },
  sttServer: {
    // Optionally spawn a local STT server when the app starts.
    autoStart: false,
    command: "uvx earheart-stt",
  },
  history: {
    enabled: true,
    limit: 100,
  },
};

let cached = null;
let filePath = null;

function settingsPath() {
  if (!filePath) filePath = path.join(app.getPath("userData"), "settings.json");
  return filePath;
}

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== "object") return override;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
  }
  return out;
}

function load() {
  if (cached) return cached;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    // First run or unreadable file: fall back to defaults.
  }
  cached = deepMerge(DEFAULTS, stored);
  return cached;
}

function save(next) {
  cached = deepMerge(DEFAULTS, next);
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(cached, null, 2));
  return cached;
}

function get() {
  return load();
}

// True until settings are saved for the first time. Used to show the setup
// wizard exactly once: both finishing and skipping the wizard persist the
// settings file.
function isFirstRun() {
  return !fs.existsSync(settingsPath());
}

module.exports = {
  get,
  save,
  isFirstRun,
  DEFAULTS,
  DEFAULT_CLEANUP_PROMPT,
  deepMerge,
};
