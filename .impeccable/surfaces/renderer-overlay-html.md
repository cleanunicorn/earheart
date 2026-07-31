---
version: 1
slug: "renderer-overlay-html"
primary_target: "renderer/overlay.html"
related_targets: ["renderer/overlay.css","renderer/overlay.js","main/windows.js"]
---

# Surface brief: dictation overlay

**Scope:** the always-on-top dictation overlay (`renderer/overlay.{html,css,js}`, geometry in `main/windows.js`) across all its states: starting, recording, paused, transcribing, cleaning, delivering, done, empty, error, update prompt.

**Visitor mode:** Operate. The user is mid-task in another app, glancing for 5–60 seconds. State legibility, finish/discard affordance, and never stealing focus outrank expression.

**Audience & job:** developers and power users (plus motor/RSI users) dictating into whatever has focus; the job is confidence that capture is live, words are landing, and one key ends it.

**Chosen direction (committed 2026-07-31, replaces The Tape Transport on this surface):** **The Quiet Transcription Bar** — the category standard played straight at Wispr Flow / superwhisper craft (the standing exit: the user asked for a minimal, clean, instantly-evident transcription UI; no concept seed). A solid neutral near-black bar (#18181b, hairline edges) where the live words are the interface: status dot + one word ("Listening…", "Pasted") on the left, the live coral waveform (accent #fb4d5c, drawn from the app icon's waveform-heart) center, monospace timer, then three universally-read circular keys — pause ∥ (play ▶ while paused), **Done** ✓ as the one filled white key, discard ✕ (red on hover). The accent means "Earheart is working with your voice": capture dot, waveform, progress fills. Green/red exist only as tiny terminal status dots. No metaphor hardware: the tape ribbon, lamps, printed legends, square stop, and eject key are retired on this surface.

**Memorable moment:** your words appearing live above the coral waveform as you speak — obviously transcription, no manual needed.

**Constraints:** transparent focusable:false window — no drop shadows, solid surfaces under text; strict local CSP (no external assets); plain JS, no new runtime deps; preserve all pipeline/IPC/drag/height-report behavior and DOM ids consumed by scripts (`card`, `meter`, `timer`, `status-text`, `detail-text`, `progress`, `progress-fill`, `pause`, `stop`, `cancel`); window geometry fixed at 500×95 base; honor prefers-reduced-motion; the waveform is a metaphor for live capture only — nothing implies audio is stored (discard cancels).

**State grammar:** filled coral dot pulsing = audio is being captured right now (never shown before samples flow); hollow coral ring pulsing = mic warming; hollow ring steady = paused; neutral dot pulsing = working (transcribing/cleaning/delivering); green = delivered, red = failed, gray = idle/empty. Detail line (paste preview, error, hint) replaces the waveform's space when present; the frozen waveform survives stop as a dim ghost of the take. Pause latches (`aria-pressed`), Done is disabled outside a live take but keeps its slot — the row never reflows.

**Carried over from the prior direction (still true):** latching PAUSE key with paused-span-excluded capture (guarded by overlay-smoke); global pause hotkey over `record:pause-toggle`; update prompt raised only between dictations, solo variant hides the control row.

**Unresolved / follow-up:** settings window + setup wizard still wear the retired Tape Transport "service panel" style — migrating them to the quiet-bar language is the agreed next pass (user chose "overlay first").
