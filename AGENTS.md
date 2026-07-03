# AGENTS.md

Guidance for AI agents (and humans) contributing to **Earheart**. This project
follows the **GitHub flow**: `master` is always releasable, all work happens on
short-lived branches, and every change lands through a reviewed pull request.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for full setup, build, and architecture
details. This file is the operational checklist for *how to work* here.

## Golden rules

1. **Never commit directly to `master`.** It is protected and is the release
   branch — merging to it auto-publishes a release (see below). Always branch.
2. **Never push to `master` or force-push a shared branch.**
3. **The PR title is load-bearing.** It drives the released version bump, so it
   must be a valid Conventional Commits string (see [PR titles](#pr-titles)).
4. **Keep `master` green.** Run the checks locally before opening a PR.
5. **Never lose the user's words.** A core design constraint of the app — if you
   touch the pipeline, preserve the raw-transcript fallbacks.

## The GitHub flow, step by step

### 1. Start from an up-to-date `master`

```bash
git checkout master
git pull origin master
```

### 2. Create a branch

Branch names are short, lowercase, hyphenated, and prefixed by intent. Match the
Conventional Commits type you expect the PR to use:

```
feat/<short-description>      # new feature
fix/<short-description>       # bug fix
refactor/<short-description>  # internal change, no behavior change
docs/<short-description>      # documentation only
chore/<short-description>     # tooling, deps, housekeeping
```

Examples: `feat/overlay-copy-button`, `fix/windows-autostart-readback`,
`docs/agents-guide`.

```bash
git checkout -b fix/windows-autostart-readback
```

### 3. Make focused changes

- One logical change per PR. Don't bundle an unrelated refactor into a fix.
- Match the surrounding style: plain JavaScript, no bundler, few runtime deps.
  Stay close to Electron built-ins and platform tools rather than adding npm
  packages — the only runtime deps are the two native engines.
- Keep diffs small and reviewable.

### 4. Commit

Commit messages follow Conventional Commits too (the **PR title** is what gates
the release, but consistent commits keep history readable):

```
type(optional-scope): short imperative description
```

Examples:

```
fix: read back start-on-boot state correctly on Windows
feat(overlay): add a copy-to-clipboard button
docs: add AGENTS.md contributor guide
```

Write in the imperative mood ("add", not "added"). Keep the subject under ~72
characters and explain the *why* in the body when it isn't obvious.

### 5. Run the checks locally

Match what CI runs on every platform — do not open a PR with these failing:

```bash
npm test                                            # unit tests (node --test)
make smoke                                           # boot app headlessly and exit
npx electron scripts/engine-smoke.js --no-sandbox    # boot engine worker, round-trip a ping
npx electron scripts/overlay-smoke.js --no-sandbox   # fake-mic overlay: capture/UI sync checks
```

`make help` lists every wrapped task. On Linux the smoke checks need a display —
CI wraps them with `xvfb-run`.

### 6. Push and open a PR

```bash
git push -u origin fix/windows-autostart-readback
gh pr create --base master --fill
```

Target **`master`**. Then set a valid title and a clear body (see below).

## PR titles

The title **must** follow Conventional Commits — a GitHub Action
([pr-title.yml](.github/workflows/pr-title.yml)) blocks the merge otherwise, and
[auto-release.yml](.github/workflows/auto-release.yml) turns the prefix into the
released version bump.

```
type(optional scope)!: description
```

| PR title prefix | Release effect |
| --- | --- |
| `feat!: …` (any `type!:`) | **major** |
| `feat: …` | **minor** |
| `fix: …`, `perf: …`, `refactor: …` | **patch** |
| `docs:`, `style:`, `test:`, `build:`, `ci:`, `chore:`, `revert:` | **none** |

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`. Add `!` before the colon for a breaking change
(→ major). Requires a colon **and a single space**, then a non-empty description.

Examples:

```
feat(overlay): add a copy-to-clipboard button
fix: accept first mouse so overlay controls work
chore!: drop support for Node 20
```

> ⚠️ Choose the prefix deliberately — it decides whether (and how big) a release
> ships when the PR merges. A `chore:`/`docs:` title ships no release.

## PR description

Keep it short and useful:

- **What** changed and **why** (the motivation/problem).
- **How to test** / what you ran (`npm test`, `make smoke`, manual steps).
- **Linked issues**: `Closes #123` when it resolves one.
- Screenshots for UI changes — re-capture README shots with `make screenshots`
  if the UI changed.

## After opening the PR

- Make sure **CI is green** on all three platforms (Linux/macOS/Windows) — the
  native engines ship per-OS binaries, so all three matter.
- If the **PR title** check fails, edit the title (it re-validates on edit).
- Address review feedback by pushing more commits to the same branch.
- Don't merge your own release-affecting PR without confirmation from a
  maintainer unless explicitly asked to.

## What merging does (so you pick the right title)

When a PR merges to `master`, [auto-release.yml](.github/workflows/auto-release.yml)
reads the PR title's prefix and, for a release-affecting type, bumps
`package.json`, commits `release: vX.Y.Z`, tags it, and dispatches the
multi-platform release builds. The release goes live only after all three
platforms build successfully. So:

- A `feat`/`fix`/`perf`/`refactor` (or `!`) title **publishes a release**.
- A `chore`/`docs`/`style`/`test`/`build`/`ci`/`revert` title does **not**.

## Project map (where things live)

```
main/                Electron main process (pipeline, hotkeys, settings, tray, windows)
  services/          OpenAI-compatible STT + cleanup HTTP clients
  engines/           in-process STT + cleanup (utilityProcess workers, native addons)
  output/deliver.js  clipboard + per-OS paste injection
renderer/            overlay (mic → 16 kHz WAV, live preview), settings, wizard
stt-server/          optional Python FastAPI Parakeet server
scripts/             icons, screenshots, engine smoke test
.github/workflows/   ci, pr-title, auto-release, release
```

See [CONTRIBUTING.md](CONTRIBUTING.md#architecture) for the full architecture
and design constraints.
