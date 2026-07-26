---
version: 1
slug: "renderer-overlay-html"
primary_target: "renderer/overlay.html"
related_targets: ["renderer/overlay.css","renderer/overlay.js","main/windows.js"]
---

# Surface brief: recording overlay

**Scope:** the always-on-top dictation overlay (`renderer/overlay.{html,css,js}`, geometry in `main/windows.js`) across all its states: starting, recording, transcribing, cleaning, delivering, done, empty, error, update prompt.

**Visitor mode:** Operate. The user is mid-task in another app, glancing for 5–60 seconds. State legibility, stop/cancel affordance, and never stealing focus outrank expression.

**Audience & job:** developers and power users (plus motor/RSI users) dictating into whatever has focus; the job is confidence that capture is live, words are landing, and one key ends it.

**Chosen direction (committed 2026-07-26, seed d2b6eb8d, replaces the surface's prior On-Air Lamp rendition):** **The Tape Transport** — the overlay as a miniature reel-to-reel: warm-black instrument faceplate, legended lamp block (REC red / BUSY amber / DONE green / inert warm grey), voice visibly written onto a tape ribbon moving between two turning reels past the record head, odometer counter, machined transport keys (square STOP backlit while recording, eject = cancel). Processing = the machine reading the tape back (playhead sweep as progress). Live transcript above: fresh raw words warm, cooling as they settle into the cleaned line.

**Memorable moment:** your voice being written onto moving tape in real time — the screen-recording that sells the README.

**Constraints:** transparent focusable:false window — no drop shadows, solid surfaces under text; strict local CSP (no external assets); plain JS, no new runtime deps; preserve all pipeline/IPC/drag/height-report behavior and existing status copy verbatim; honor prefers-reduced-motion; the tape is a metaphor for live capture only — nothing implies audio is stored (cancel ejects).

**Unresolved:** whether settings/wizard later migrate to the deck's front-panel language (out of scope here); eject-glyph comprehension for cancel (flagged for finish review).
