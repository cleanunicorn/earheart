<p align="center">
  <img src="assets/icon.png" width="96" alt="Earheart" />
</p>

<h1 align="center">Earheart</h1>

<p align="center">
  Private, hotkey-driven voice dictation for Windows, macOS and Linux.<br/>
  Press a key, speak, press again — your words appear where you type.
</p>

<p align="center">
  <img src="docs/screenshots/overlay-recording.png" width="340" alt="Earheart recording overlay" /><br/>
  <img src="docs/screenshots/overlay-done.png" width="340" alt="Earheart after pasting the transcript" />
</p>

---

Earheart records your voice when you press a global hotkey, transcribes it
with a speech-to-text service, optionally cleans the transcript up with a
language model, and then **pastes the result into whatever app you're typing
in** (or just copies it to your clipboard).

By default everything runs **inside the app, on your computer** — no Python, no
separate server, no accounts, no API keys. The setup wizard downloads two small
models once (speech-to-text and cleanup) and Earheart runs them in-process.

Prefer to host the models yourself? Both steps also speak the
**OpenAI-compatible HTTP contract**, so you can point Earheart at any service:

- **In-app (default)**: NVIDIA Parakeet for speech-to-text and a small Gemma
  model for cleanup, both running locally with nothing to install.
- **Self-hosted / advanced**: the bundled [Parakeet STT server](stt-server/),
  an [Ollama](https://ollama.com)/llama.cpp model, or any hosted API.
- **Mix and match**: in-app STT with a hosted LLM for cleanup, or any other
  combination. Switching is a couple of clicks in Settings.

## Features

- **Global hotkey** (default `Ctrl/Cmd+Shift+Space`): press to start, press to
  stop. A small overlay shows recording level and progress without stealing
  focus from the app you're dictating into.
- **Speech-to-text with NVIDIA Parakeet** — runs Parakeet TDT 0.6B
  (multilingual) **right inside the app** via sherpa-onnx, faster than realtime
  on CPU, with no Python and no server to start. Or point Earheart at any
  OpenAI-compatible transcription API.
- **In-app LLM cleanup** — a small Gemma model (run in-process via
  node-llama-cpp) fixes punctuation, capitalization and strips filler words and
  false starts. On by default; the prompt and model are configurable, and you
  can switch to any OpenAI-compatible chat API. If cleanup fails, the raw
  transcript is delivered instead — your words are never lost.
- **Auto-paste, clipboard, or both** — paste straight into the focused app
  (with clipboard restore), paste *and* keep the transcript on the clipboard,
  or clipboard-only if you prefer to paste yourself.
- **Local history** — recent transcriptions are kept in a local JSON file so a
  mis-aimed paste never loses a dictation. Can be disabled.
- **No telemetry, no accounts, no cloud requirement.**

## Install

### Download a release

Grab the latest installer for your platform from the
[releases page](https://github.com/cleanunicorn/earheart/releases/latest):

| Platform | File | Install |
| --- | --- | --- |
| Windows | `Earheart Setup <version>.exe` | Run the installer (a portable `Earheart <version>.exe` is also available) |
| macOS | `Earheart-<version>.dmg` | Open and drag Earheart to Applications |
| Linux (any distro) | `Earheart-<version>.AppImage` | `chmod +x` the file, then run it |
| Debian / Ubuntu | `earheart_<version>_amd64.deb` | `sudo apt install ./earheart_<version>_amd64.deb` |

> **macOS note:** builds are not yet notarized, so the first launch may be
> blocked by Gatekeeper. Right-click the app → **Open**, or allow it under
> **System Settings → Privacy & Security → Open Anyway**.

Nothing else to install. On first launch the setup wizard downloads the
speech-to-text and cleanup models and runs them inside the app.

### Advanced: self-hosted STT with `uv`

If you'd rather run the standalone [Parakeet STT server](stt-server/) (for GPU
acceleration, sharing it with other tools, etc.), Earheart can launch it as
`uvx earheart-stt`. That needs
[uv](https://docs.astral.sh/uv/getting-started/installation/) installed:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # Linux / macOS
winget install astral-sh.uv                       # Windows
```

Pick **"Connect to a local STT server"** (STT) or a remote service in the
wizard. Hosted transcription APIs (OpenAI, Groq, …) need only a URL and key.

### Build from source

If there's no release for your platform:

```bash
git clone https://github.com/cleanunicorn/earheart
cd earheart
npm install
npm run dist     # installers for the current platform land in dist/
```

(Or run it unpackaged with `npm start`.)

## First run

<p align="center">
  <img src="docs/screenshots/wizard.png" width="560" alt="Earheart setup wizard" />
</p>

On first launch a short setup wizard asks where speech should become text and
where the text should go — hotkey, microphone, speech-to-text, cleanup, output.
The defaults give you fully local, private dictation that runs entirely inside
the app.

On the **"Set up your private models"** step the wizard downloads the
speech-to-text model (Parakeet, ≈ 660 MB) and the cleanup model (a small Gemma,
≈ 0.7 GB) once, showing a progress bar for each. After that everything runs
offline and faster than realtime, even on CPU — your audio and text never leave
your machine.

### Choosing a different cleanup model

In-app cleanup ships with a small Gemma model by default. In the wizard (or
Settings → Cleanup) you can pick a larger Gemma for higher quality, or paste a
**custom Hugging Face GGUF** (`hf:<user>/<repo>/<file>.gguf`).

Prefer your own server? Switch cleanup to "OpenAI-compatible service" and point
it at [Ollama](https://ollama.com), LM Studio, OpenRouter, Groq, OpenAI, etc.:

```bash
ollama pull llama3.1:8b   # then: base URL http://127.0.0.1:11434/v1, model llama3.1:8b
```

## Using Earheart

1. Put your cursor wherever you want text — an email, an editor, a chat box.
2. Press the hotkey (default `Ctrl/Cmd+Shift+Space`). A small pill appears at
   the bottom of the screen showing your mic level; it never steals focus.
3. Speak, then press the hotkey again. Earheart transcribes, optionally cleans
   up, and pastes the result right where you were typing.

Earheart lives in your system tray. From the tray menu you can start a
dictation, open the transcription history, or change any choice you made in
the wizard:

<p align="center">
  <img src="docs/screenshots/settings.png" width="640" alt="Earheart settings window" />
</p>

A mis-aimed paste never loses your words: the History tab keeps recent
transcriptions in a local file (you can turn this off).

## Using other services

Anything that implements the OpenAI API shapes works out of the box:

| Component | Endpoint used | Examples |
| --- | --- | --- |
| Speech-to-text | `{base URL}/audio/transcriptions` | `earheart-stt` (local Parakeet), [speaches](https://github.com/speaches-ai/speaches), Groq (`https://api.groq.com/openai/v1`), OpenAI (`https://api.openai.com/v1`) |
| Cleanup | `{base URL}/chat/completions` | Ollama, llama.cpp server, LM Studio, vLLM, OpenRouter, OpenAI, … |

The reverse is also true: `earheart-stt` is a standalone OpenAI-compatible
transcription server, usable from any other dictation app that supports custom
endpoints (e.g. OpenWhispr) or from scripts via the OpenAI SDK. See
[stt-server/README.md](stt-server/README.md) for GPU use and other models.

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

## Contributing

Want to hack on Earheart? It's plain JavaScript with no bundler. The only
runtime npm dependencies are the two native inference engines that power in-app
models (`sherpa-onnx-node` for STT, `node-llama-cpp` for cleanup); everything
else is the standard library. The standalone Python STT server is ~200 lines. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, architecture
overview, and how to build installers.

## License

[MIT](LICENSE)
