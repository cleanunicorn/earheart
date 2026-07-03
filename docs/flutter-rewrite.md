# Flutter rewrite — plan and proof-of-concept

Status: **proof-of-concept working** (Linux, 2026-07). The `app/` directory
contains a Flutter port of the vertical slice — overlay pill, tray menu,
global hotkey, mic capture, in-process Parakeet STT, live preview, and
paste delivery — that builds and passes a headless smoke test plus a real
transcription round-trip with the production `parakeet-tdt-0.6b-v3-int8`
model.

## Why (measured, not guessed)

| Metric | Electron 0.15.0 | Flutter POC | Notes |
| --- | --- | --- | --- |
| Linux distributable | 511 MB AppImage | 52 MB bundle | Much of Electron's size is node-llama-cpp GPU backend variants; a llama.cpp backend adds ~10–30 MB to Flutter. Still roughly 5–10× smaller. |
| Windows installer | 377 MB | (untested) | Same story expected. |
| Idle RSS (hidden, Xvfb) | 97 MB (all processes) | 83 MB | Modest at idle. The gap grows while dictating: Electron adds an overlay renderer + two utilityProcess workers; Flutter stays one process + one isolate. |
| STT decode | sherpa-onnx-node 1.13.3 | sherpa_onnx (Dart) 1.13.3 | **Same native library, officially supported Dart bindings.** POC decoded 7.2 s of audio in 674 ms (≈10× realtime) on CPU. |
| Runtime deps | Chromium + Node | none (AOT native) | No Chromium CVE/upgrade treadmill; faster cold start. |

Non-measured advantages:

- **One typed codebase** (Dart) instead of main/renderer/preload JS with an
  IPC contract; the recorder streams PCM straight into the pipeline — the
  overlay-renderer→main WAV hop and the whole preload allowlist disappear.
- **Mobile path**: the same `lib/` compiles to Android/iOS, so a phone
  dictation app / keyboard becomes a realistic follow-on. Electron has no
  path there.
- Pixel-identical UI across the three desktops.

Honest disadvantages / risks:

- **Cleanup engine is the big one.** node-llama-cpp has no first-class Dart
  equivalent (`llama_cpp_dart` is young). Options, in order of preference:
  (a) vendor a small FFI binding over llama.cpp's C API (we use one model,
  one prompt shape — the needed surface is tiny); (b) ship a `llama-server`
  sidecar process and reuse the existing remote-cleanup HTTP client;
  (c) keep cleanup remote-only at first. The raw-transcript fallback makes
  any of these safe.
- **Desktop plugin ecosystem is thinner than Electron's.** One afternoon
  found three small gaps we had to own: `tray_manager` lacks `setToolTip`
  on Linux, `hotkey_manager` maps the space key to `KP_Space` on Linux
  (letter keys bind fine — needs a one-line upstream patch or vendored
  fork), and two plugins fail `-Werror` builds on new clang. All shallow,
  none blocking, but that's the trade.
- **Multi-window is Flutter desktop's weak spot.** Overlay + settings +
  wizard as simultaneous windows needs either `desktop_multi_window`
  (alpha-quality) or a cleaner two-process design: the single-instance
  logic we already need for `--toggle` can open Settings as a second
  process of the same binary.
- Wayland global-hotkey limits are identical to Electron (bind a system
  shortcut to `earheart --toggle`); Flutter solves nothing there.
- A rewrite of ~9k lines of polished JS carries regression risk on a
  product whose core promise is "never lose the user's words". CI, the
  smoke tests, and the settings/history migration below are the guardrails.
- Linux desktop accessibility (screen readers) is weaker in Flutter than
  in Chromium.

## POC architecture (mirrors the Electron modules)

| Electron | Flutter | State |
| --- | --- | --- |
| `main/pipeline.js` state machine | `lib/pipeline.dart` | ported (sessions, stale-event discipline, hide timers) |
| `main/engines/engine-worker.js` (utilityProcess) | `lib/stt.dart` (long-lived Isolate) | ported; same OfflineRecognizer config (`nemo_transducer`, 16 kHz) |
| `renderer/overlay.js` recorder (getUserMedia + worklet) | `lib/recorder.dart` (`record` plugin, PCM16 stream) | ported; RMS level for the meter |
| `main/live-preview.js` | drop-if-busy periodic decode in `pipeline.dart` | simplified (full re-decode, no chunk commit yet) |
| `main/output/deliver.js` | `lib/deliver.dart` | ported 1:1 (modes, clipboard restore, per-OS keystroke tools, degrade-to-clipboard note) |
| `main/windows.js` overlay BrowserWindow | main window via `window_manager` + GTK runner tweaks | frameless, always-on-top, skip-taskbar, bottom-center; `gtk_window_set_accept_focus(FALSE)` + RGBA visual in `linux/runner/my_application.cc` |
| `main/tray.js` | `lib/main.dart` `_initTray` (`tray_manager`) | ported (state-driven labels, output-mode radios) |
| `main/settings.js` | `lib/settings.dart` | minimal slice only |

CLI hooks mirror the repo's: `--smoke-test` (boot, print `SMOKE OK`, exit)
and `--transcribe <wav>` (headless decode; used to prove the engine).

## Try it

```bash
cd app
~/Development/flutter/bin/flutter build linux --release
./build/linux/x64/release/bundle/earheart            # tray menu → Start dictation
./build/linux/x64/release/bundle/earheart --transcribe some-16k.wav
```

The POC expects the Parakeet int8 model at
`~/.local/share/earheart-flutter/models/parakeet-tdt-0.6b-v3-int8/`
(same four files the Electron model manager downloads).

## Phased plan to parity

1. **Spike** *(done — this POC)*: overlay, tray, hotkey, record, STT, paste.
2. **Core parity (~1–2 weeks)**: full settings schema + migration from the
   Electron `settings.json`/`history.json` (read the old userData path so
   upgrades are seamless); history; autostart; single-instance +
   `--toggle`; overlay drag/persisted position and grow-upward transcript;
   determinate progress (port `util/rtf.js`); max-recording cap; proper
   live preview (committed chunks + pause-gated cleanup pass).
3. **Engines (~1–2 weeks, riskiest)**: model manager (downloads, sha256,
   `.part`/`.complete` markers — ports 1:1, it's plain HTTP+fs) + registry;
   cleanup via one of the three llama.cpp options above; idle unload
   (kill/respawn the isolate).
4. **Settings & wizard UI (~1–2 weeks)**: second-process windows (or
   `desktop_multi_window`); all five settings tabs; wizard; remote
   STT/cleanup HTTP clients (trivial ports); HF model browser.
5. **Packaging & updates (~1 week)**: CI matrix; AppImage/deb, dmg, NSIS;
   port `updates.js` (feed parsing, checksum verify, per-platform swap —
   plain process/file logic, ports directly).
6. **Beta & cutover**: ship both for a release or two; the stt-server and
   all remote-endpoint behavior are unchanged.

Realistic total: **5–8 weeks of focused work** to true parity, most of the
risk concentrated in phase 3 (cleanup engine) and phase 4 (multi-window).

## Verified so far / still to verify

- ✅ Linux: build, boot, tray init, window flags, STT round-trip (10× RT).
- ⬜ Mic capture end-to-end (needs a desktop session with a microphone).
- ⬜ Hotkey on a real session (space-key mapping patch; Wayland caveats).
- ⬜ macOS/Windows builds (plugins all claim support; unverified here).
- ⬜ Cleanup engine choice (phase 3 decision).
