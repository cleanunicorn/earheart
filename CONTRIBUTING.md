# Contributing to Earheart

Earheart is intentionally small and hackable: plain JavaScript, only a couple
of runtime npm dependencies (the native STT and cleanup engines), no bundler.
The Python STT server is ~200 lines. If you can read Electron docs, you can
read this whole codebase in an afternoon.

## Development setup

Requires Node 22+ (an `.nvmrc` is provided, so `nvm use` picks it up).

```bash
git clone https://github.com/cleanunicorn/earheart
cd earheart
npm install
npm start
```

Common tasks are wrapped in a Makefile — run `make help` to list them:

| Task | What it does |
| --- | --- |
| `make install` | Install app dependencies (npm) |
| `make run` | Run the app in development |
| `make test` | Run unit tests (`node --test`) |
| `make smoke` | Boot the app headlessly and exit (CI-style sanity check) |
| `make icons` | Regenerate app/tray icons into `assets/` |
| `make screenshots` | Regenerate README screenshots into `docs/screenshots/` |
| `make dist` | Build installers for the current platform |
| `make dist-linux` / `dist-mac` / `dist-win` | Per-platform packages |
| `make dist-win-docker` | Cross-build Windows packages from Linux via Docker+Wine |
| `make release` | Cut a release manually (`BUMP=patch\|minor\|major`) |
| `make install-stt` | Create the stt-server virtualenv and install it (uv) |
| `make run-stt` | Run the local Parakeet STT server |
| `make clean` | Remove build output |

## Running the STT server from a checkout

```bash
cd stt-server
uv run earheart-stt            # or: pip install . && earheart-stt
```

The first run downloads the Parakeet model (≈ 2.4 GB; pass
`--quantization int8` for a ≈ 660 MB CPU-friendly variant). It serves on
`http://127.0.0.1:8484/v1`, Earheart's default STT endpoint. See
[stt-server/README.md](stt-server/README.md) for options, GPU providers and
other models.

## Tests

```bash
npm test                       # unit tests (node --test, no test framework)
make smoke                     # boots the full app with --smoke-test and exits
npx electron scripts/engine-smoke.js --no-sandbox   # boot the engine worker, round-trip a ping
```

The engine-smoke step forks the in-process engine `utilityProcess` worker and
round-trips a request, so a broken worker or a native-addon load failure
surfaces here rather than at runtime. CI runs all three on every platform.
Built-in models download to Electron's `userData/models` on first use; the
smoke checks don't need them present.

## Building installers

Packaged installers (AppImage/deb, dmg, NSIS + portable) are built with
electron-builder:

```bash
npm run dist:linux
npm run dist:mac               # run on macOS
npm run dist:win               # run on Windows, or: make dist-win-docker
```

Output lands in `dist/`. Release builds for all three platforms run in CI on
tag pushes (`v*`) — see [.github/workflows/release.yml](.github/workflows/release.yml).

## Releasing

Releases are cut **automatically when a PR merges to master**, sized by the
conventional-commit prefix of the PR title
([.github/workflows/auto-release.yml](.github/workflows/auto-release.yml)):

| PR title | Release |
| --- | --- |
| `feat!: …` (any `type!:`) | major |
| `feat: …` | minor |
| `fix: …`, `perf: …`, `refactor: …` | patch |
| anything else (`chore:`, `docs:`, free-form, `[skip release]`) | none |

The workflow bumps `package.json`, commits `release: vX.Y.Z` to master, tags
it, and dispatches the release builds. Those builds create the GitHub release
as a draft, each platform uploads its installers into it, and the release is
flipped live only after all three platforms succeed — so a half-built release
is never published.

To cut a release manually instead:

```bash
make release BUMP=minor    # patch | minor | major (default patch)
```

## Architecture

```
main/                    Electron main process
  main.js                lifecycle, single-instance, --toggle forwarding
  pipeline.js            record → transcribe → clean → deliver state machine
  hotkeys.js             global shortcut registration
  settings.js            JSON settings with deep-merged defaults
  history.js             local transcription history
  tray.js                tray icon + menu
  windows.js             overlay + settings + setup wizard windows
  services/stt.js        OpenAI-compatible transcription client
  services/cleanup.js    OpenAI-compatible chat client
  services/models-remote.js   list a remote service's models (Settings)
  engines/               in-process STT + cleanup (no separate executable)
    registry.js          downloadable model catalogue
    model-manager.js     streaming, atomic, checksum-verified downloads
    engine-worker.js     utilityProcess: sherpa-onnx (STT) + node-llama-cpp
    host.js / index.js   parent-side worker lifecycle + facade
  output/deliver.js      clipboard + per-OS paste keystroke injection
renderer/                overlay (mic capture → 16 kHz WAV), settings UI,
                         first-run wizard (incl. model download step)
stt-server/              Python: FastAPI + onnx-asr Parakeet server (optional)
```

The pipeline routes each stage to the in-process engine or the HTTP client
based on `stt.engine` / `cleanup.engine` ("builtin" | "remote").
The native runtimes are loaded lazily inside the worker, so the app boots and
the HTTP paths keep working even if a model isn't downloaded.

Design constraints worth keeping:

- **Few runtime npm dependencies.** The app stays close to Electron's built-ins
  and the platform's own tools (PowerShell, AppleScript, xdotool/wtype). The
  only runtime deps are the two native engines — `sherpa-onnx-node` (STT) and
  `node-llama-cpp` (cleanup) — which ship prebuilt binaries and are unpacked
  from the asar (`asarUnpack` in `electron-builder.yml`). Models are downloaded
  at first run, not bundled.
- **The overlay window owns the microphone.** The main process never touches
  audio; it receives a finished WAV from the renderer.
- **Never lose the user's words.** If cleanup fails, deliver the raw
  transcript; if paste fails, fall back to the clipboard; history keeps the
  text either way.

## README screenshots

The screenshots in [docs/screenshots/](docs/screenshots/) are captured
headlessly from the real windows (wizard, settings, overlay in staged
recording/done states). If the UI changes, re-capture them:

```bash
make screenshots       # runs scripts/screenshots.js under xvfb
```
