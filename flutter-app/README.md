# Earheart — Flutter rewrite proof-of-concept

An experimental Flutter port of Earheart's core dictation loop: overlay
pill, tray menu, global hotkey, mic capture, in-process Parakeet STT (the
same sherpa-onnx engine the Electron app uses), live preview, and
clipboard/paste delivery. **It is not part of the shipped Electron app.**

Rationale, measured trade-offs, and the phased plan to parity live in
[../docs/flutter-rewrite.md](../docs/flutter-rewrite.md).

## Build & run

Requires a Flutter SDK with Dart ≥ 3.12 (Flutter 3.44 stable or newer):

```bash
flutter pub get
flutter analyze && flutter test
flutter build linux --release
./build/linux/x64/release/bundle/earheart          # tray → Start dictation
```

The built-in engine expects the Parakeet int8 model files (the same four
files the Electron model manager downloads) at:

```
~/.local/share/earheart-flutter/models/parakeet-tdt-0.6b-v3-int8/
  encoder.int8.onnx  decoder.int8.onnx  joiner.int8.onnx  tokens.txt
```

## CLI hooks

```bash
./earheart --smoke-test              # boot everything, print SMOKE OK, exit
./earheart --transcribe some.wav     # decode a 16 kHz WAV, print transcript
```

## Local edits to generated files

These `flutter create`-generated files carry deliberate local edits — keep
them when regenerating:

- `linux/runner/my_application.cc` — never-focusable overlay window + RGBA
  visual
- `linux/CMakeLists.txt` — per-plugin -Wno-error quirks (see the comment at
  the bottom of the file)
- `macos/Runner/Info.plist` — NSMicrophoneUsageDescription +
  NSAppleEventsUsageDescription (dropping them breaks recording/paste on
  macOS with no build error)
- `macos/Runner/DebugProfile.entitlements` + `Release.entitlements` —
  sandbox off, audio-input and Apple Events entitlements
