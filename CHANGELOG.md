# Changelog

Written by the release workflow from the title of the pull request that cut
each version (see .github/workflows/auto-release.yml). Earheart reads it twice:
release.yml turns it into the `release-notes.json` asset the in-app updater
shows before you update, and the app ships this file so it can show what
changed right after it updates.

## v0.28.1 — 2026-08-25

- Never cover a chunk that swallowed the words (#103)

## v0.28.0 — 2026-08-22

- Section icons and engine-state color as comprehension aids (#102)

## v0.27.1 — 2026-08-18

- Actually free the memory models hold when Earheart sits idle (#100)

## v0.27.0 — 2026-08-13

- Start silently in the tray instead of opening Settings (#99)

## v0.26.4 — 2026-08-13

- Stop a looping model instead of pasting what it repeated (#98)

## v0.26.3 — 2026-08-12

- Stop long dictations losing words (#96)

## v0.26.2 — 2026-08-12

- Bulk typed-array WAV paths, batched worklet posts, async history writes (#95)

## v0.26.1 — 2026-08-07

- Unwrap the default cleanup prompt so it renders cleanly in Settings (#92)

## v0.26.0 — 2026-08-04

- Retune the default cleanup prompt for dictating to a coding agent (#88)

## v0.25.0 — 2026-08-04

- Tell you what's new before and after you update (#89)

## v0.24.1 — 2026-08-04

- Settle the three settings residuals from #83

## v0.24.0 — 2026-08-02

- Accurate per-parameter cleanup sampling help + settings hint pass
- Paginate the settings history list
- Revive the dead Open error log button

## v0.23.1 — 2026-07-31

- Settle the round-3 residuals
- Settle the round-2 CSS and copy residuals
- Refine the Dismiss relabel and detail tooltip
- Name each performance field in its hint
- Drop the pills' no-op resets

## v0.23.0 — 2026-07-31

- Redesign the UI as a clean, self-evident transcription app

## v0.22.0 — 2026-07-31

- Run sherpa-onnx Whisper models, not just transducers
- Diagnose encoder-decoder repos as such, not as a missing tokens.txt

## v0.21.4 — 2026-07-31

- Stop claiming a repo has no ONNX files when it does

## v0.21.3 — 2026-07-31

- Re-assert the overlay's topmost position on every show

## v0.21.2 — 2026-07-29

- Drop the reels and record head from the transport

## v0.21.1 — 2026-07-28

- Expose the pause key's latched state to assistive tech
- Collapse the update bar under reduced motion
- Widen the dismiss button's hit area
- Lift the unlit take counter to a readable contrast

## v0.21.0 — 2026-07-27

- Level the stacked demo cards at the mini-deck's height
- Give the update outcome its own line
- Align field rhythm and busy-button legibility
- Extract endCapture beside startCapture
- Announce terminal download outcomes to assistive tech

## v0.20.0 — 2026-07-26

- Redesign the recording overlay as a tape transport (#53)

## v0.19.2 — 2026-07-26

- Re-sign the mac bundle on self-update so it launches on Apple Silicon (#51)

## v0.19.1 — 2026-07-20

- Run cleanup on CPU under Windows-on-ARM emulation (#50)

## v0.19.0 — 2026-07-15

- Prompt on the overlay card when a new version is out
- Cut stop-to-text latency for the built-in engines
- Add "Copy last transcription" menu item
- Add a user dictionary of preferred terms
- Harden mic session lifecycle after review
