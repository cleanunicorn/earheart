<p align="center">
  <img src="assets/icon.png" width="96" alt="Earheart" />
</p>

<h1 align="center">Earheart</h1>

<p align="center">
  Private, hotkey-driven voice dictation for Windows, macOS and Linux.<br/>
  Press a key, speak, press again — your words appear where you type.
</p>

<p align="center">
  <img src="docs/screenshots/overlay-recording.png" width="340" alt="Earheart overlay showing a live transcript while recording" /><br/>
  <img src="docs/screenshots/overlay-done.png" width="340" alt="Earheart overlay confirming the transcript was pasted" />
</p>

<p align="center">
  <sub>The overlay transcribes live as you speak, then confirms where the text landed — without stealing focus.</sub>
</p>

---

Earheart records your voice when you press a global hotkey, transcribes it
with a speech-to-text service, optionally cleans the transcript up with a
language model, and then **pastes the result into whatever app you're typing
in** (or just copies it to your clipboard).

Out of the box both steps run **inside the app, on your computer** — no
separate program, no Python, no account. The setup wizard downloads a small
[Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) speech model and
a small [Gemma](https://huggingface.co/google) cleanup model (with a progress
bar) and runs them in-process. Nothing ever leaves your machine.

Prefer to point Earheart elsewhere? Both steps are also **modular,
OpenAI-compatible HTTP clients**, so you can choose where your voice goes:

- **Built-in (default)**: Parakeet + Gemma run in-process — fully private,
  nothing to install.
- **Local server**: run the [Parakeet STT server](stt-server/) and an
  [Ollama](https://ollama.com)/llama.cpp model yourself.
- **Mix and match**: local STT with a hosted LLM for cleanup, or any other
  combination. Switching is just a base URL in Settings.

## Features

- **Global hotkey** (default `Ctrl/Cmd+Shift+Space`): press to start, press to
  stop. A small overlay shows recording level and progress without stealing
  focus from the app you're dictating into.
- **Speech-to-text with NVIDIA Parakeet** — by default Parakeet TDT 0.6B v3
  (multilingual, 25 languages) runs **in-process** via sherpa-onnx / ONNX
  Runtime, faster than realtime on CPU and with no network hop. Or point
  Earheart at any OpenAI-compatible transcription API, or run the optional
  [`earheart-stt`](stt-server/) server yourself.
- **Live transcript while you speak (on by default)** — with the built-in
  engine the overlay fills in the text as you talk, with a cleaned-up version
  settling in behind the raw words on pauses. The final transcript on stop is
  unchanged. Toggle it under Settings → Speech-to-text.
- **LLM cleanup (on by default)** — punctuation, filler-word removal, false
  starts. By default a small Gemma model runs **in-process**; or point cleanup
  at any OpenAI-compatible chat API. The prompt is fully editable. If cleanup
  fails, the raw transcript is delivered instead — your words are never lost.
- **Auto-paste, clipboard, or both** — paste straight into the focused app
  (with clipboard restore), paste *and* keep the transcript on the clipboard,
  or clipboard-only if you prefer to paste yourself.
- **Start on login (optional)** — have Earheart launch into the tray
  automatically when you sign in, so the hotkey is always ready. Off by
  default; toggle it under Settings → General. Works on Windows, macOS and
  Linux.
- **Local history** — recent transcriptions are kept in a local JSON file so a
  mis-aimed paste never loses a dictation. Can be disabled.
- **No telemetry, no accounts, no cloud requirement.**

## Install

### 1. Download the right file for your OS

Open the **[latest release page](https://github.com/cleanunicorn/earheart/releases/latest)**
and, under **Assets**, download the file that matches your system. `<version>`
is just the version number (e.g. `0.8.0`).

**🪟 Windows**

- **Most people:** `Earheart-Setup-<version>.exe` — the installer.
- Don't want to install? `Earheart-<version>.exe` — a portable build you can
  run directly.

**🍎 macOS**

- **Apple Silicon (M1/M2/M3/M4):** `Earheart-<version>-arm64.dmg`
- **Intel Macs:** `Earheart-<version>.dmg`
- Not sure which Mac you have? Click  → **About This Mac** and look at
  "Chip" / "Processor".

**🐧 Linux**

- **Any distro:** `Earheart-<version>.AppImage` — works everywhere.
- **Debian / Ubuntu:** `earheart_<version>_amd64.deb` — installs as a normal
  package.

### 2. Install it

| Your download | What to do |
| --- | --- |
| `Earheart-Setup-<version>.exe` | Double-click and follow the installer. |
| `Earheart-<version>.exe` (portable) | Just double-click to run — no install. |
| `Earheart-<version>*.dmg` | Open it, then drag **Earheart** into **Applications**. (See the macOS note below — the first launch needs one extra step.) |
| `Earheart-<version>.AppImage` | In a terminal: `chmod +x Earheart-*.AppImage`, then double-click or run it. |
| `earheart_<version>_amd64.deb` | `sudo apt install ./earheart_<version>_amd64.deb` |

> **⚠️ macOS first launch: "Earheart is damaged and can't be opened"**
>
> This does **not** mean the app is broken. Earheart isn't signed/notarized
> yet, so macOS quarantines it. After dragging Earheart to Applications, run
> this once in Terminal:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/Earheart.app
> ```
>
> Then open Earheart normally. (The "right-click → Open" trick only clears the
> milder "unidentified developer" warning, not the "damaged" one.) More detail
> in [macOS notes](#macos) below.
>
> You only ever do this once: Earheart updates itself from GitHub releases
> (see below), and updates installed from inside the app clear the quarantine
> automatically.

That's it — the built-in engines need nothing else installed. The first-run
wizard downloads the speech and cleanup models for you.

### Updates

Earheart checks GitHub releases for a new version on startup and twice a day
(toggle under Settings → Advanced → Updates) and shows a notification plus an
**Update to vX.Y.Z** entry in the tray menu when one is out. One click
downloads the release, verifies its checksum and reinstalls in place:

- **Windows (installed):** the new installer runs silently and the app
  relaunches. The portable exe can't update itself — the app opens the
  releases page instead.
- **macOS:** the app bundle is swapped and the quarantine attribute is
  stripped automatically, so the updated app opens normally — no `xattr`
  needed after the first manual install.
- **Linux (AppImage):** the AppImage file is replaced in place (same path, so
  launchers and autostart keep working) and the app relaunches. A `.deb`
  install opens the releases page instead (upgrading needs `sudo`).

### Advanced: a local STT server with `uv`

If you'd rather run the [Parakeet STT server](stt-server/) as a separate
process (e.g. to share it with other tools or use a GPU), start it yourself and
point Earheart's speech-to-text at its URL (default `http://127.0.0.1:8484/v1`)
in Settings → Speech-to-text. Running it needs
[uv](https://docs.astral.sh/uv/getting-started/installation/) installed:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # Linux / macOS
winget install astral-sh.uv                       # Windows
cd stt-server && uv run earheart-stt              # start the server
```

Or point Earheart at a hosted transcription service (OpenAI, Groq, …) —
Settings → Speech-to-text lets you enter its URL and API key instead.

> **Upgrading from 0.4.x?** The in-process engines are new defaults; your
> existing configured STT/cleanup endpoints are preserved and keep working
> (migrated to the "remote" engine). The old "start a local STT server
> automatically" option has been removed — run the server yourself as above.

### Build from source

If there's no release for your platform (requires Node 22+):

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

On first launch a short setup wizard walks through hotkey, microphone,
speech-to-text, cleanup and output. It sets up the **on-device engines** for
both speech-to-text and cleanup, so first-run dictation is fully local and
private with nothing to configure. Prefer a remote service? Switch any time in
Settings → Speech-to-text or Settings → Cleanup.

The wizard's last step downloads the models that run on your machine — a small
Parakeet speech model (≈ 670 MB) and a small Gemma cleanup model (≈ 800 MB) —
showing a progress bar as it goes. It's a one-time download; everything after
that is faster than realtime, even on CPU. You can pick a larger, higher-
quality cleanup model in the wizard or later in Settings → Cleanup.

### Transcript cleanup

Cleanup is **on by default** and runs the built-in Gemma model in-process: a
language model fixes punctuation and removes filler words and false starts,
with no network hop. You can disable it, pick a larger built-in model, or edit
the prompt in Settings → Cleanup.

Prefer to run cleanup elsewhere? Any OpenAI-compatible chat endpoint works. A
fully local example with [Ollama](https://ollama.com):

```bash
ollama pull llama3.1:8b
```

Then in Settings → Cleanup: base URL
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

- **"Earheart is damaged and can't be opened"** on first launch means
  Gatekeeper has quarantined the download — the app is unsigned and not yet
  notarized, not corrupt. Drag it to Applications, then strip the quarantine
  attribute once:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Earheart.app
  ```

  After that it opens normally. (Right-click → **Open** only works for the
  "unidentified developer" prompt, not the "damaged" one.)

- The first dictation asks for **Microphone** permission.
- Auto-paste simulates Cmd+V via System Events, which requires
  **Accessibility** permission (System Settings → Privacy & Security →
  Accessibility → enable Earheart). If auto-paste stops working later, use
  Settings → Advanced → **Fix auto-paste permission** to re-check it and jump
  to the right System Settings pane.

### Windows

- No special permissions needed. Auto-paste uses PowerShell `SendKeys`.

## Privacy

- With the built-in engines (the default), audio and transcripts never leave
  the app process — there is no network hop and no localhost socket.
- If you point speech-to-text at an HTTP service instead, audio is held in
  memory and sent only to the STT endpoint **you** configure (e.g. `127.0.0.1`
  for the optional local Parakeet server).
- Transcripts go to an external cleanup endpoint only if you switch cleanup to
  a remote service; the default Gemma cleanup stays on your machine.
- History and settings live in plain local files (Electron's user data
  directory). API keys are stored in that settings file — on shared machines,
  prefer local services or OS-level disk encryption.
- No telemetry, no accounts, no cloud.

## Contributing

Want to hack on Earheart? It's plain JavaScript with no bundler and only two
runtime dependencies (the native STT and cleanup engines). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, architecture
overview, and how to build installers.

## License

[MIT](LICENSE)
