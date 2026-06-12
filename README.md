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

Both processing steps are **modular, OpenAI-compatible HTTP services**, so you
choose where your voice goes:

- **Fully private**: run the bundled [Parakeet STT server](stt-server/) and an
  [Ollama](https://ollama.com)/llama.cpp model locally — nothing ever leaves
  your machine.
- **Mix and match**: local STT with a hosted LLM for cleanup, or any other
  combination. Switching is just a base URL in Settings.

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

### For fully local dictation: install `uv`

Out of the box Earheart transcribes with its bundled local
[Parakeet STT server](stt-server/), which it launches as `uvx earheart-stt`.
That needs [uv](https://docs.astral.sh/uv/getting-started/installation/)
installed — one command:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # Linux / macOS
winget install astral-sh.uv                       # Windows
```

If you'd rather use a hosted transcription service (OpenAI, Groq, …) you can
skip this — the setup wizard lets you enter its URL and API key instead.

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
where the text should go — hotkey, microphone, speech-to-text, optional
cleanup, output. The defaults give you fully local, private dictation: keep
"On this computer" and Earheart starts the Parakeet server alongside the app.

The first transcription downloads the Parakeet model (≈ 2.4 GB, or ≈ 660 MB
with the `int8` variant), so it takes a few minutes — everything after that is
faster than realtime, even on CPU.

### Optional: transcript cleanup

If you enable cleanup, a language model fixes punctuation and removes filler
words and false starts. Any OpenAI-compatible chat endpoint works. A fully
local example with [Ollama](https://ollama.com):

```bash
ollama pull llama3.1:8b
```

Then in the wizard (or Settings → Cleanup): base URL
`http://127.0.0.1:11434/v1`, model `llama3.1:8b`. For a hosted service
instead, use its base URL, API key and model name (e.g. OpenRouter, Groq,
OpenAI).

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

Want to hack on Earheart? It's plain JavaScript with zero runtime npm
dependencies and no bundler, and the Python STT server is ~200 lines. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, architecture
overview, and how to build installers.

## License

[MIT](LICENSE)
