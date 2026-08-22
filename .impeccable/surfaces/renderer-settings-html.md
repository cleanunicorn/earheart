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
matching section legend (mic/captions/sparkle/clock/sliders — wayfinding), a
`.state-badge` pill on the STT and Cleanup engine cards that names what
Built-in vs OpenAI-compatible actually means for the user's data ("Runs on
this device — your audio/words never leave it" vs "Sends … to the endpoint
below"; toggled in `syncEngine()`), and one distinct pictogram per "Where the
text goes" radio (single box+cursor, doubled box, clipboard) so the three
destinations read apart before the prose does. Deliberately did not add a
card icon to every card (About, Setup wizard, Updates, Performance,
Auto-paste permission, Dictionary, System prompt stay text-only) — the icon
language is reserved for genuine recognition/consequence aids, not
decoration.

**Colorize pass (2026-08-22, same day, user-requested):** the icon pass above
shipped monochrome first; the user then asked for color on this window
specifically (not the overlay/wizard — same-day follow-up, scoped to
settings.css/html only). Added two new token families, both settings-window-
only and never reusing `--accent` (coral stays the sole hotkey-capture color)
or `--ok`/`--err` (stay reserved for status text/destructive hover):
`--section-*` (general/stt/cleanup/history/advanced — five OKLCH-derived
hues, equal lightness/chroma so no section outranks another, all ≥6.7:1 on
`--ink`) colors the nav-icon/legend-icon pair per section as a constant
landmark independent of the tab's active/hover state — the label text still
uses the pre-existing dim/active grammar untouched. `--state-private` (teal)
/ `--state-external` (amber) recolor the engine `.state-badge` pills
end-to-end (icon, text, wash, edge, via `color-mix()`) because that pill's
whole job is naming a consequence, so color carries meaning there rather than
decorating it. The "Where the text goes" pictograms and every selection/
action control (segmented, radios, switches, buttons) deliberately stayed on
the existing white-is-chosen grammar — those three destinations have no
better/worse relationship to color, and the chosen-is-white convention is a
cross-surface commitment (shared with the overlay's Done-key grammar) this
pass wasn't asked to reopen.

**Review follow-through (2026-08-22, same day):** the two passes above were
recorded here first and DESIGN.md was left saying "everything else is white
and gray" — wrong about the shipped CSS, which CONTRIBUTING.md treats as the
source DESIGN.md is derived from. Both hue families now live in DESIGN.md
proper (frontmatter tokens, two Colors subsections, The Wayfinding Hue Rule
and The Consequence Color Rule, plus Do/Don't entries), so this file is a
record of the decision rather than the only place it exists. Three other
loose ends closed with it: the two engine pills per card moved inside one
stable `aria-live="polite"` slot (they swap by `hidden`, so the announcement
had to come from a container that never moves — the badge names a data-egress
consequence, and a screen reader was hearing only the radio label); the index
rail went 168px → 180px with the window 760 → 772 because the widest entry
plus its new glyph and gap cleared 168px by one pixel in DejaVu Sans; and
`docs/screenshots/settings.png` was re-captured. `scripts/settings-smoke.js`
now asserts the badge follows the radio both ways and sits in a live region,
so the engine-switch behaviour is covered rather than eyeballed.

**Unresolved:** none for this surface. If color is ever wanted on the overlay
or wizard too, that's a DESIGN.md-level decision (shared tokens), not a
settings-only edit — flag it as its own pass rather than drifting the shared
`:root` block through this file.
