# Earheart — Agent guide

Guidance for AI agents (and humans) contributing to **Earheart**.

Earheart is a hotkey-driven voice dictation app (Electron) that speaks a prompt
into Claude Code, Codex, Cursor, or any focused window, fully local. A change is
done when its code, tests, and docs land together in one reviewed PR with CI
green on Linux, macOS, and Windows. This project follows GitHub flow: `main` is
always releasable, all work happens on short-lived branches, and every change
lands through a reviewed pull request.

Read [README.md](README.md) for setup, and [CONTRIBUTING.md](CONTRIBUTING.md)
for the full architecture. This file is the operational checklist for *how to
work* here.

## Prerequisites

- **Node.js ≥ 22 + npm** — `.nvmrc` is provided, so `nvm use` picks it up.
- **The `gh` CLI** — for opening PRs.
- **A display for the smoke checks** — on Linux, the `make` smoke targets
  already wrap Electron in `xvfb-run -a` (install Xvfb); on macOS and Windows
  run the underlying `npx electron …` commands directly, as CI does.
- **GNU Make** — for the `make` targets (on Windows, run the underlying
  commands instead).
- **`uv`** — only if you touch the optional Python server in `stt-server/`.
- **No keys needed.** Built-in models download to Electron's `userData/models`
  on first use; tests and smoke checks don't need them present.

## Commands

The Makefile wraps most tasks; `make help` lists them all.

- **Install / bootstrap:** `make install`
- **Run locally:** `make run`
- **Lint / format / type-check:** none — plain JavaScript, no linter configured.
- **Test (all):** `make test` (`node --test`, no framework)
- **Test (single file):** `node --test test/pipeline.test.js`
- **Smoke checks (Linux):** `make smoke`, `make overlay-smoke`,
  `make settings-smoke` (each wraps `xvfb-run -a`), and
  `xvfb-run -a npx electron scripts/engine-smoke.js --no-sandbox` (no make
  target)
- **Smoke checks (macOS / Windows):** the same commands without `xvfb-run`:
  `npx electron . --smoke-test --no-sandbox`, then
  `npx electron scripts/<engine|overlay|settings>-smoke.js --no-sandbox`
- **STT server tests:** `cd stt-server && uv run --extra test python -m pytest`
- **Build:** `make dist` (current platform)

Always run the tests and smoke checks before opening a PR.

## Golden rules

1. **Never commit or push directly to `main`.** Always branch, always PR.
   GitHub does not enforce this (no branch protection), so it is on you. `main`
   is the release branch — merging to it can auto-publish a release (see
   [Release automation](#release-automation)).
2. **Start every feature or fix in its own worktree.** Never switch branches in
   a shared checkout — parallel agents and humans work here at the same time
   (see [Create a branch](#2-create-a-branch--in-a-worktree)).
3. **Never force-push a shared branch.**
4. **Keep `main` green.** Run the checks locally before opening a PR (see
   [Run the checks](#5-run-the-checks-locally)).
5. **Prefer the project's task runner.** Use a `make` target where one exists
   rather than hand-rolling its command. CI runs the underlying commands itself
   (see [ci.yml](.github/workflows/ci.yml)), so when you change a Makefile
   target, change the matching CI step too.
6. **Never disable, skip, or delete a test to make a build pass.** If a test is
   wrong, say so and propose the fix.
7. **The PR title is load-bearing.** It decides whether a release ships and
   how big, and a release-affecting title becomes the release note users see in
   the app, so it must be a valid Conventional Commits string (see
   [PR titles](#pr-titles)).
8. **Never lose the user's words.** If cleanup fails, deliver the raw
   transcript; if paste fails, fall back to the clipboard; history keeps the
   text either way. Preserve these fallbacks whenever you touch the pipeline.
9. **Few runtime npm dependencies.** Stay close to Electron built-ins and
   platform tools (PowerShell, AppleScript, xdotool/wtype). The only runtime
   deps are the two native engines, `sherpa-onnx-node` and `node-llama-cpp`.

## Communication

- Always explain the reasoning behind decisions and approaches.
- When claiming something works or is fixed, prove it — a passing test, a
  script that validates the behavior, or a clear explanation of why. Don't just
  assert.
- When uncertain, say so rather than presenting a guess as fact.
- End each response with a confidence indicator: 🟢 High | 🟡 Medium | 🔴 Low

## The GitHub flow, step by step

### 1. Start from an up-to-date `main`

```bash
git fetch origin main
```

The next step branches from `origin/main` directly, so there is no need to
check out `main` (it may already be checked out in another worktree).

### 2. Create a branch — in a worktree

**Never edit a checkout of `main` directly.** Create the worktree before the
first edit, do the whole change there, and open the PR from it:

```bash
git worktree add ../earheart-<short-topic> -b <type>/<short-topic> origin/main
cd ../earheart-<short-topic>
make install
```

Worktrees live as siblings of the main checkout (`../earheart-<short-topic>`),
so nothing needs to be gitignored. If the harness has a worktree tool (e.g.
Claude Code's `EnterWorktree`), use it. After the PR merges, remove it with
`git worktree remove ../earheart-<short-topic>`.

Branch names are short, lowercase, hyphenated, and prefixed by intent. Match the
Conventional Commits type you expect the PR to use (see [Commit](#4-commit)):

```
feat/<short-description>      # new feature
fix/<short-description>       # bug fix
refactor/<short-description>  # internal change, no behavior change
perf/<short-description>      # performance work
docs/<short-description>      # documentation only
chore/<short-description>     # tooling, deps, housekeeping
```

Examples: `fix/windows-autostart-readback`, `feat/overlay-copy-button`.

### 3. Make focused changes

- One logical change per PR — and a whole feature *is* one logical change.
  Ship its code, tests, and docs together; don't split it across a chain of
  dependent PRs. Don't bundle an unrelated refactor into a fix either.
- Match the surrounding style: plain JavaScript (CommonJS), no bundler, small
  pure helpers that are unit-tested on their own.
- Keep diffs focused: everything in the diff should serve that one change.
  Focused is about relevance, not size — don't ship half a feature to keep the
  diff short.
- **Fix it everywhere.** When you fix a problem, search the repo for the same
  problem — the *shape*, not the literal text — and fix every instance in the
  same PR. One instance fixed while identical ones remain is an incomplete fix.
  Confirm the scope first if the sweep passes ~10 instances or reaches
  generated or vendored code.

### 4. Commit

Commits follow [Conventional Commits](https://www.conventionalcommits.org):

```
type(optional-scope): short imperative description
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`. Add `!` before the colon for a breaking change.

```
fix: read back start-on-boot state correctly on Windows
feat(overlay): add a copy-to-clipboard button
chore!: drop support for Node 20
```

Write in the imperative mood ("add", not "added"). Keep the subject under ~72
characters and explain the *why* in the body when it isn't obvious.

### 5. Run the checks locally

Do not open a PR with these failing — they mirror what CI runs on every
platform:

```bash
# Linux
make test
make smoke
xvfb-run -a npx electron scripts/engine-smoke.js --no-sandbox
make overlay-smoke
make settings-smoke
```

The `make` smoke targets already call `xvfb-run -a`, so don't wrap them again.
On macOS and Windows, use the plain `npx electron …` commands from
[Commands](#commands) (as [ci.yml](.github/workflows/ci.yml) does). If you touched
`stt-server/`, also run its pytest suite (see [Commands](#commands)).

### 6. Push and open a PR

```bash
git push -u origin HEAD
gh pr create --base main --fill
```

Target **`main`**.

## PR titles

The PR title follows the same Conventional Commits format as commits:

```
type(optional scope)!: description
```

A GitHub Action ([pr-title.yml](.github/workflows/pr-title.yml)) fails on an
invalid title. It is not a required check, so it won't stop a merge — never
merge with it red. For a release-affecting title, the title also becomes the
user-facing release note — write it for users: `feat: paginate the settings
history list`, not `feat: pagination`.

## PR description

Keep it short and useful:

- **What** changed and **why** (the motivation/problem).
- **Numbers, not adjectives.** Anything you claim improved carries the value you
  measured, the threshold it is judged against, and how to reproduce it —
  `3.73:1 → 7.13:1 (AA needs 4.5:1)`, `make test: 269 pass`, `-412 lines`.
  A table when there is more than one pair. "Not measured" beats a vague
  adjective.
- **The gap**, for a bug fix: what was supposed to catch this, why it didn't,
  and what now would. Give it its own heading — it is the half of the fix a
  reviewer can't reconstruct from the diff.
- **The sweep**, for any fix: the search you ran for other instances of the
  problem, and its count — found, fixed, and left (with why).
- **How to test** / what you ran (`make test`, the smoke checks, manual steps).
- **Linked issues**: `Closes #123` when it resolves one.
- Screenshots for UI changes — re-capture README shots with `make screenshots`
  if the UI changed.
- When the change is mostly a removal, lead with what is **gone** (net lines,
  the concepts dropped) and add an explicit **Kept:** line.

## After opening the PR

- Make sure **CI is green on all three platforms** (Linux/macOS/Windows) — the
  native engines ship per-OS binaries, so all three matter.
- If the PR-title check fails, edit the title — it re-validates on edit.
- Address review feedback by pushing more commits to the same branch.
- Don't merge your own release-affecting PR without confirmation from a
  maintainer unless explicitly asked to.

## Release automation

- **Is `main` protected?** No — no branch protection or rulesets, and no
  required status checks. The PR-only and green-CI rules are convention.
- **What does merging trigger?** For a release-affecting title (table below),
  [auto-release.yml](.github/workflows/auto-release.yml) bumps `package.json`,
  writes the PR title into `CHANGELOG.md`, commits `release: vX.Y.Z`, tags it,
  and dispatches the multi-platform release builds. The release goes live only
  after all three platforms build successfully.
- **Does the PR title/prefix decide the bump?** Yes.

| PR title prefix | Release effect |
| --- | --- |
| `feat!: …` (any `type!:`) | **major** |
| `feat: …` | **minor** |
| `fix: …`, `perf: …`, `refactor: …` | **patch** |
| `docs:`, `style:`, `test:`, `build:`, `ci:`, `chore:`, `revert:` | **none** |
| any title containing `[skip release]` | **none** (overrides every row above) |

A no-release merge doesn't touch `package.json` or `CHANGELOG.md`, so its title
never reaches the in-app release notes.

> ⚠️ Choose the prefix deliberately — it decides whether (and how big) a release
> ships when the PR merges.

`CHANGELOG.md` is generated from PR titles — don't hand-edit it.

## Project map (where things live)

```
main/                Electron main process (pipeline, hotkeys, settings, tray, windows)
  pipeline.js        record → transcribe → clean → deliver state machine
  services/          OpenAI-compatible STT + cleanup HTTP clients, updater feed
  engines/           in-process STT + cleanup (utilityProcess workers, native addons)
  output/deliver.js  clipboard + per-OS paste injection
renderer/            overlay (mic → 16 kHz WAV, live preview), settings, wizard
stt-server/          optional Python FastAPI Parakeet server
scripts/             icons, screenshots, release notes, smoke tests, model evals
test/                unit tests (node --test)
.github/workflows/   ci, pr-title, auto-release, release
DESIGN.md            the UI design system — read before changing renderer CSS
PRODUCT.md           product truth: users, positioning, principles
```

The pipeline routes each stage to the in-process engine or the HTTP client
based on `stt.engine` / `cleanup.engine` (`"builtin"` | `"remote"`). STT and
cleanup each run in their own `utilityProcess` worker, so a native crash in one
can't take down the other. **The overlay window owns the microphone** — the main
process never touches raw audio; it receives finished WAVs from the renderer.

See [CONTRIBUTING.md](CONTRIBUTING.md#architecture) for the full architecture.

## Conventions

- **Naming:** files kebab-case; tests are `test/<area>.test.js`.
- **Configuration:** user settings are JSON with deep-merged defaults in
  `main/settings.js`.
- **UI:** [DESIGN.md](DESIGN.md) governs the overlay, settings, and wizard. Two
  hardcoded values must stay in sync with the CSS: `WAVE_COLOR` ↔ `--accent`,
  `INK_COLOR` ↔ `--ink`.
- **Error handling:** degrade, don't drop — every failure path still delivers
  the user's text (see Golden rule 8).

## Testing

- **Framework / runner:** Node's built-in `node --test`, no framework. Electron
  behavior is covered by the smoke scripts in `scripts/`.
- **Location & naming:** `test/<area>.test.js`. `*-contract.test.js` files
  guard couplings between files: `ipc-contract` checks IPC channels across
  main, preload, and renderer; `overlay-contract` and `settings-contract`
  check renderer scripts against their HTML/CSS.
- **What to cover:** happy path, error paths, and edge cases for new code.
- **Fixtures / stubs:** no network or models needed; the STT server suite uses
  synthetic WAVs and fake recognizers.

## Security

- Never commit secrets, API keys, credentials, or sensitive data.
- Always validate and sanitize user and external input.
- Built-in catalog models are SHA-256 verified on download
  (`main/engines/model-manager.js`). User-added models have no `sha256`, so
  they only get size and HTTP-validator checks. Pin a checksum for anything new
  the app ships in its catalog.

## Hazards

### Never commit a symlink, `node_modules`, or `dist`

**Run `make install` in each new worktree; never symlink `node_modules` from
another checkout, and never stage it.**

A committed `node_modules` symlink breaks every fresh clone: a link to another
checkout's absolute path dangles (`ENOENT`), and a link to itself loops
(`ELOOP`). CI's install step doesn't notice, because `npm ci` rebuilds
`node_modules` over it.

This reached `main` in #107: a `node_modules` symlink to the main checkout's
absolute path. It dropped the local suite from 251 passing to 19 failures until
#112 removed it. Today `.gitignore` ignores a `node_modules` symlink too, so
plain `git add -A` won't stage it, and `repo-hygiene` in
[ci.yml](.github/workflows/ci.yml) fails on any tracked symlink (#117).

```sh
make install          # in each new worktree
git status --short    # review before committing; stage paths explicitly
```

`git add -f` on an ignored path is the remaining way in — don't use it for
`node_modules`, `dist`, or a symlink.

## Start here

The fastest path to understanding this codebase:

[README.md](README.md) → [main/pipeline.js](main/pipeline.js) →
[main/engines/index.js](main/engines/index.js)
