<p align="center">
  <img src="assets/icon.png" width="96" alt="Earheart" />
</p>

<h1 align="center">Earheart</h1>

<p align="center">
  Private, hotkey-driven voice dictation for Windows, macOS and Linux.<br/>
  Press a key, speak, press again — your words appear where you type.
</p>

---

Earheart records your voice when you press a global hotkey, transcribes it
with a speech-to-text service, optionally cleans the transcript up with a
language model, and then **pastes the result into whatever app you're typing
in** (or just copies it to your clipboard).

Both processing steps are **modular, OpenAI-compatible HTTP services**, so you
choose where your voice goes:

- **Fully private**: run the bundled [Parakeet STT server](stt-server/) and an
  [Ollama](https://ollama.com)/llama.cpp model locally — nothing ever leaves
  your machine.
- **Mix and match**: local STT with a hosted LLM for cleanup, or any other
  combination. Switching is just a base URL in Settings.

```
 hotkey ──▶ record mic ──▶ POST /v1/audio/transcriptions ──▶ POST /v1/chat/completions ──▶ paste / clipboard
            (16 kHz WAV)    (Parakeet local, OpenAI,          (optional cleanup: Ollama,
                             Groq, speaches, …)                LM Studio, OpenAI, …)
```

## Features

- **Global hotkey** (default `Ctrl/Cmd+Shift+Space`): press to start, press to
  stop. A small overlay shows recording level and progress without stealing
  focus from the app you're dictating into.
- **Speech-to-text with NVIDIA Parakeet** — the included
  [`earheart-stt`](stt-server/) server runs Parakeet TDT 0.6B v3 (multilingual,
  25 languages) locally via ONNX Runtime, faster than realtime on CPU. Or
  point Earheart at any OpenAI-compatible transcription API.
- **LLM cleanup (optional)** — punctuation, filler-word removal, false starts,
  via any OpenAI-compatible chat API. The prompt is fully editable. If cleanup
  fails, the raw transcript is delivered instead — your words are never lost.
- **Auto-paste or clipboard** — paste straight into the focused app (with
  clipboard restore), or clipboard-only if you prefer to paste yourself.
- **Local history** — recent transcriptions are kept in a local JSON file so a
  mis-aimed paste never loses a dictation. Can be disabled.
- **Small and hackable** — plain JavaScript, zero runtime npm dependencies, no
  bundler. The Python STT server is ~200 lines.

## Getting started

Common tasks are wrapped in a Makefile — run `make help` to list them
(`make install`, `make run`, `make test`, `make run-stt`,
`make dist-win-docker`, …). The underlying commands are shown below.

### 1. Run the app (development)

```bash
git clone https://github.com/cleanunicorn/earheart
cd earheart
npm install
npm start
```

Packaged installers (AppImage/deb, dmg, NSIS) are built with
`npm run dist:linux|mac|win`.

### 2. Start the speech-to-text server

```bash
cd stt-server
uv run earheart-stt            # or: pip install . && earheart-stt
```

The first run downloads the Parakeet model (≈ 2.4 GB; pass
`--quantization int8` for a ≈ 660 MB CPU-friendly variant). It serves on
`http://127.0.0.1:8484/v1`, which is Earheart's default STT endpoint — so
dictation works immediately. See [stt-server/README.md](stt-server/README.md)
for GPU use and other models.

You can also let Earheart launch it for you: Settings → Advanced → "Start a
local STT server with the app".

### 3. (Optional) enable cleanup

Any OpenAI-compatible chat endpoint works. Local example with Ollama:

```bash
ollama pull llama3.1:8b
```

Then in Settings → Cleanup: base URL `http://127.0.0.1:11434/v1`, model
`llama3.1:8b`. For a hosted service instead, use its base URL, API key and
model name (e.g. OpenRouter, Groq, OpenAI).

## Using other services

Anything that implements the OpenAI API shapes works out of the box:

| Component | Endpoint used | Examples |
| --- | --- | --- |
| Speech-to-text | `{base URL}/audio/transcriptions` | `earheart-stt` (local Parakeet), [speaches](https://github.com/speaches-ai/speaches), Groq (`https://api.groq.com/openai/v1`), OpenAI (`https://api.openai.com/v1`) |
| Cleanup | `{base URL}/chat/completions` | Ollama, llama.cpp server, LM Studio, vLLM, OpenRouter, OpenAI, … |

The reverse is also true: `earheart-stt` is a standalone OpenAI-compatible
transcription server, usable from any other dictation app that supports custom
endpoints (e.g. OpenWhispr) or from scripts via the OpenAI SDK.

## Platform notes

### Linux

- **Auto-paste** needs a keystroke tool: `xdotool` (X11) or `wtype`/`ydotool`
  (Wayland). Without one, Earheart falls back to clipboard-only and tells you.

  ```bash
  sudo apt install xdotool        # X11
  sudo apt install wtype          # wlroots Wayland (Sway, Hyprland, …)
  ```

- **Global hotkeys on Wayland**: GNOME and KDE on Wayland prevent apps from
  grabbing global keys. Instead, bind a system keyboard shortcut (GNOME
  Settings → Keyboard → Custom Shortcuts) to:

  ```bash
  earheart --toggle
  ```

  Earheart runs single-instance; a second invocation just toggles dictation in
  the running app.

### macOS

- The first dictation asks for **Microphone** permission.
- Auto-paste simulates Cmd+V via System Events, which requires
  **Accessibility** permission (System Settings → Privacy & Security →
  Accessibility → enable Earheart).

### Windows

- No special permissions needed. Auto-paste uses PowerShell `SendKeys`.

## Privacy

- Audio is held in memory and sent only to the STT endpoint **you** configure;
  with the local Parakeet server, that's `127.0.0.1`.
- Transcripts go only to the cleanup endpoint you configure, and only if
  cleanup is enabled.
- History and settings live in plain local files (Electron's user data
  directory). API keys are stored in that settings file — on shared machines,
  prefer local services or OS-level disk encryption.
- No telemetry, no accounts, no cloud.

## Architecture

```
main/                    Electron main process
  main.js                lifecycle, single-instance, --toggle forwarding
  pipeline.js            record → transcribe → clean → deliver state machine
  hotkeys.js             global shortcut registration
  settings.js            JSON settings with deep-merged defaults
  history.js             local transcription history
  tray.js                tray icon + menu
  windows.js             overlay + settings windows
  services/stt.js        OpenAI-compatible transcription client
  services/cleanup.js    OpenAI-compatible chat client
  services/server-manager.js  optional local STT server autostart
  output/deliver.js      clipboard + per-OS paste keystroke injection
renderer/                overlay (mic capture → 16 kHz WAV) + settings UI
stt-server/              Python: FastAPI + onnx-asr Parakeet server
```

## License

[MIT](LICENSE)
