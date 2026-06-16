// Settings persistence: a plain JSON file in Electron's userData directory.
// Keys are grouped by concern so modules can take just the slice they need.

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const catalog = require("./services/model-catalog");

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
    // "paste" = type into focused app (restores clipboard afterwards),
    // "paste-copy" = paste AND keep the transcript on the clipboard,
    // "clipboard" = copy only
    mode: "paste",
    restoreClipboard: true, // after pasting in "paste" mode, restore clipboard
    pasteDelayMs: 150, // wait before simulating the paste keystroke
  },
  stt: {
    // "builtin" = run Parakeet in-app via sherpa-onnx (no Python, no server);
    // "service" = talk to an OpenAI-compatible endpoint (baseUrl below).
    // New installs default to builtin; upgrades are migrated to "service" so
    // an existing HTTP setup keeps working (see load()).
    engine: "builtin",
    localModel: catalog.DEFAULT_STT_MODEL,
    baseUrl: "http://127.0.0.1:8484/v1",
    apiKey: "",
    model: "parakeet",
    language: "",
    timeoutMs: 120000,
  },
  cleanup: {
    // Cleanup is on by default now that it can run fully in-app.
    enabled: true,
    // "builtin" = run a small Gemma GGUF in-app via node-llama-cpp;
    // "service" = any OpenAI-compatible chat endpoint (baseUrl below).
    engine: "builtin",
    localModel: catalog.DEFAULT_CLEANUP_MODEL,
    localModelUri: "", // used when localModel === "custom"
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

// Upgrades from before the in-app engines existed used the HTTP/service path
// exclusively. Their stored settings have no `engine` key, so a plain merge
// would silently flip them to the new "builtin" default and break a working
// remote/server setup. Detect that case and keep them on "service".
function migrate(stored, merged) {
  if (!stored || Object.keys(stored).length === 0) return merged; // fresh install
  if (stored.stt && stored.stt.engine === undefined) merged.stt.engine = "service";
  if (stored.cleanup && stored.cleanup.engine === undefined) {
    merged.cleanup.engine = "service";
  }
  return merged;
}

function load() {
  if (cached) return cached;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    // First run or unreadable file: fall back to defaults.
  }
  cached = migrate(stored, deepMerge(DEFAULTS, stored));
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
  migrate,
};
