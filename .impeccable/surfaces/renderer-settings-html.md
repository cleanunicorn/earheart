---
version: 1
slug: "renderer-settings-html"
primary_target: "renderer/settings.html"
related_targets: ["renderer/settings.css","renderer/settings.js","renderer/wizard.html","renderer/wizard.css","renderer/wizard.js","main/windows.js"]
---

# Surface brief: settings window (+ setup wizard)

**Scope:** the framed settings window (`renderer/settings.{html,css,js}`, window
chrome in `main/windows.js`) and the first-run wizard
(`renderer/wizard.{html,css,js}` — wizard.css layers on settings.css and shares
its tokens; the settings-contract test guards that coupling).

**Visitor mode:** Operate. Opened occasionally to fix one thing (hotkey clash,
endpoint, model, updates) or right after the wizard; find-one-setting-fast,
keyboard-first operation, and scannability outrank expression.

**Audience & job:** developers and power users configuring engines/endpoints;
motor/RSI users needing forgiving targets and no fiddly interactions.

**Chosen direction (committed 2026-07-31, migrates both surfaces off the
retired Tape Transport "service panel"):** **The Quiet Transcription Bar on a
framed window** — the overlay's committed world (see DESIGN.md) applied to the
settings page and wizard. Structure carried over intact from the prior
direction (it was never the problem): one continuous scrolling page with a
sticky index on the left (scroll spy, glide on click, docks horizontally under
600px), fixed footer commit row; wizard steps centered in a fixed frame.
Material language replaced wholesale: solid near-black ink #18181b, white-wash
cards (white 0.04–0.05) with hairline edges, sentence-case section headings
running into a hairline, plain solid inputs (#101013, 3:1 boundary #6b6b74),
fully-rounded pill buttons, one filled white Save (the overlay's Done-key
grammar). **Chosen things are white**: the active index entry's wash, selected
option rows, radio cores, checkbox fills, engaged switch tracks, the selected
segment. Downloads and update bars fill white (One Voice Rule — the app
talking about itself). Green/red only as status text (`.status.ok/.err`) and
the destructive hover (danger buttons). Mono only for machine values:
accelerators, timestamps, version, and the dictionary/prompt textareas.

**The Capture Exception:** coral #fb4d5c appears on this window exactly once —
a hotkey field mid-capture (border + wash + ring), because the field is
literally capturing your key press. The one moment settings itself records.

**Wizard demo:** the welcome step's miniature is now a mini quiet bar
(`.mini-bar`: pulsing coral dot, coral wave bars, mono timer, filled white ✓)
— a true preview of the real overlay. Step dots are white when active
(`.dot.active`), 35% white otherwise.

**Memorable moment:** the wizard's mini bar already dictating — the exact bar
you're about to meet — and the index wash sliding section to section.

**Constraints:** settings.js/wizard.js drive everything by element id, class
name (.capturing, .active, .disabled, .status ok/err, .dl-*, .ghost, .danger,
.dot, .accel) and radio-group name (contract-tested); CSP forbids inline
styles; `[hidden]` must win; keyboard-first (roving-tabindex index, visible
focus rings — 2px white); prefers-reduced-motion collapses glide/pulses;
windows paint `#18181b` before load (INK_COLOR in windows.js, kept in sync
with `--ink`).

**Copy (2026-07-31):** dictation-forward language — "start dictating", "Max
dictation length (s)", card title "Dictation", "the dictation bar". Everything
else preserved verbatim.

**Resolved earlier, still true:** progress fills use `width 0.15s linear`;
sliders are a light track under a white knob; em-dash-heavy copy is the
product's incumbent voice, kept; tray menu remains unstyled platform UI.

**Visual-aid icon pass (2026-08-22):** added one small monoline glyph system
(16–18px, `stroke="currentColor"`, no fill except `.tab-icon`'s sliders/legend
knobs) reused in three places rather than scattered per-card: the index and
matching section legend (mic/captions/sparkle/clock/sliders — wayfinding, dims
with the tab's own currentColor, no new rule needed), a `.state-badge` pill on
the STT and Cleanup engine cards that names what Built-in vs OpenAI-compatible
actually means for the user's data ("Runs on this device — your
audio/words never leave it" vs "Sends … to the endpoint below"; toggled in
`syncEngine()`, no color-coding — text-dim register, not a status color), and
one distinct pictogram per "Where the text goes" radio (single box+cursor,
doubled box, clipboard) so the three destinations read apart before the prose
does. Deliberately did not add a card icon to every card (About, Setup wizard,
Updates, Performance, Auto-paste permission, Dictionary, System prompt stay
text-only) — the icon language is reserved for genuine recognition/consequence
aids, not decoration.

**Unresolved:** none for this surface.
