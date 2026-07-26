# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: developers & power users.** Keyboard-centric technical users who live
in editors, terminals, chat, and docs. Comfortable with endpoints, self-hosting,
and Ollama — but they still expect the out-of-box path to require zero setup.
Their needs win when design decisions conflict.

**Served audience: motor/RSI users.** People who type all day and feel it, or
cannot type comfortably at all. For them dictation is relief or necessity, so
minimal-interaction flows and reliability matter above all (confirmed
commitment; see Accessibility & Inclusion).

Situation for both: mid-task inside someone else's app — an editor, an email, a
chat box. The job: turn speech into clean text exactly where the cursor is,
faster than typing, without giving up privacy.

## Product Purpose

Earheart is private, hotkey-driven voice dictation for Windows, macOS, and
Linux. Press a global hotkey, speak, press again — speech is transcribed
(NVIDIA Parakeet), optionally cleaned up by a small LLM (punctuation, filler
words, false starts), and pasted into whatever app has focus, or copied to the
clipboard.

**Success:** become the go-to open-source dictation app — the name people reach
for instead of paid cloud tools. Stars, downloads, and contributors are the
scoreboard.

## Positioning

**Lead claim (confirmed): private by default, zero setup.** Both engines run
in-process out of the box — no cloud, no account, no separate program, no
Python, nothing ever leaves the machine — and it still takes zero
configuration. The first-run wizard downloads two small models and everything
after runs locally, faster than realtime on CPU.

Supporting truths (real, but not the lead):

- **Open, modular, yours** — MIT open source; every stage is an
  OpenAI-compatible HTTP endpoint you can repoint (local server, Ollama,
  hosted APIs). Switching is just a base URL in Settings.
- **Never loses your words** — raw-transcript fallback when cleanup fails,
  local history against mis-aimed pastes, clipboard restore.
- **Cross-platform equal citizen** — first-class Linux support (X11 and
  Wayland) alongside Windows and macOS, which desktop dictation rarely offers.

## Operating Context

- Lives in the system tray. UI surfaces: a low always-on-top overlay strip at
  the bottom of the screen (status lamp, level meter, live transcript,
  progress — never steals focus), a settings window, a first-run wizard, and
  the tray menu.
- Used mid-task inside other applications; the overlay must never interrupt or
  take focus from the app being dictated into.
- Global hotkey (default `Ctrl/Cmd+Shift+Space`) starts and stops dictation.
  On GNOME/KDE Wayland, users bind a system shortcut to `earheart --toggle`
  (single-instance).
- First run: a wizard walks through hotkey → microphone → speech-to-text →
  cleanup → output, then downloads the on-device models (≈670 MB Parakeet +
  ≈800 MB Gemma) with a progress bar. One-time download.
- Distributed via GitHub releases: Windows installer + portable exe, macOS
  dmg (arm64 + Intel), Linux AppImage + deb. Self-updates from GitHub releases
  with checksum verification.
- Platform frictions that are part of the product experience: macOS build is
  unsigned (one-time `xattr` quarantine strip, documented; updates clear it
  automatically); macOS needs Microphone + Accessibility permissions; Linux
  auto-paste needs `xdotool`/`wtype`/`ydotool`, with clipboard-only fallback.

## Capabilities and Constraints

- In-process engines by default: Parakeet TDT 0.6B v3 via sherpa-onnx
  (multilingual, 25 languages, faster than realtime on CPU) and a small Gemma
  cleanup model via node-llama-cpp. Larger cleanup models selectable.
- Every stage is modular: any OpenAI-compatible endpoint works — STT via
  `{base}/audio/transcriptions`, cleanup via `{base}/chat/completions`
  (Ollama, llama.cpp, LM Studio, vLLM, Groq, OpenRouter, OpenAI, …).
- Live transcript in the overlay while speaking (built-in engine), with a
  cleaned-up version settling in behind the raw words on pauses. Progress
  bars are estimated from measured decode speed and deliberately stop short
  of the end rather than overpromise.
- Output modes: auto-paste with clipboard restore, paste + keep on clipboard,
  or clipboard-only. Local JSON history of recent transcriptions (can be
  disabled). Editable cleanup prompt. Optional start-on-login.
- **Core engineering constraint: never lose the user's words.** If cleanup
  fails, the raw transcript is delivered. Any pipeline change must preserve
  the raw-transcript fallbacks.
- Tech constraints: plain JavaScript Electron app, no bundler, only two
  runtime dependencies (the native engines). Stay close to Electron built-ins
  and platform tools rather than adding npm packages. Node 22+.
- No telemetry, no accounts, no cloud requirement. Settings and history are
  plain local files; API keys live in the settings file (documented tradeoff).
- Release process is automated: Conventional-Commit PR titles drive version
  bumps; merging to `main` can auto-publish a multi-platform release.
- Companion project: `stt-server/` — an optional Python FastAPI Parakeet
  server, itself a standalone OpenAI-compatible transcription endpoint usable
  by other dictation apps and scripts.

## Brand Commitments

- Name: **Earheart**. Existing app icon and tray icons in `assets/`.
- License: MIT; open-source identity is part of the brand.
- Voice (confirmed as a good default, **not binding**): plain-spoken,
  friendly, technically honest, reassuring without overpromising — e.g. the
  README's "This does **not** mean the app is broken." Future surfaces may
  evolve the voice.

## Evidence on Hand

- Real product screenshots in `docs/screenshots/` (overlay recording /
  processing / done, setup wizard, settings window); regenerable with
  `make screenshots`.
- App icon and tray assets in `assets/`.
- Star-history chart SVGs are generated to the `star-history` branch by a
  GitHub Action (may 404 until the workflow has run).
- **Absent — do not fabricate:** testimonials, case studies, press mentions,
  user counts, download numbers, formal benchmarks, and pricing (the app is
  free). Performance claims are limited to what the README states
  ("faster than realtime on CPU").

## Product Principles

1. **Private by default, configurable by choice.** The out-of-box path never
   sends anything off-machine; power users can repoint any stage at any
   endpoint they trust.
2. **Never lose the user's words.** Every failure path still delivers the raw
   transcript; history catches mis-aimed pastes.
3. **Stay out of the way.** Dictation happens inside someone else's app —
   never steal focus, never interrupt, never demand attention mid-flow.
4. **Zero setup before power.** Defaults work with nothing installed or
   configured; depth (endpoints, prompts, models, servers) stays available
   underneath, one Settings field away.
5. **Honest about state and limits.** Progress that deliberately
   under-promises, docs that admit rough edges (unsigned macOS build, Wayland
   hotkeys) and hand the user the fix.

## Accessibility & Inclusion

- **Keyboard-first operation (confirmed):** every flow — wizard, settings,
  overlay actions — must be fully usable without a mouse.
- **Motor/RSI users are a served audience (confirmed):** minimal-interaction
  flows, forgiving timing, no fiddly targets.
- Screen-reader support: not established as a commitment (explicitly left
  undecided; revisit if the audience broadens).
