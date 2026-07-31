---
name: Earheart
description: The quiet transcription bar — live words as the interface, one coral voice.
colors:
  bar-ink: "#18181b"
  coral-voice: "#fb4d5c"
  text-primary: "#f4f4f5"
  text-status: "#d4d4d8"
  text-dim: "#a1a1aa"
  text-faint: "rgba(255, 255, 255, 0.28)"
  hairline-edge: "rgba(255, 255, 255, 0.1)"
  seam: "rgba(255, 255, 255, 0.08)"
  hover-wash: "rgba(255, 255, 255, 0.08)"
  wash-faint: "rgba(255, 255, 255, 0.04)"
  track: "rgba(255, 255, 255, 0.12)"
  field: "#101013"
  field-edge: "#6b6b74"
  tray: "rgba(0, 0, 0, 0.25)"
  delivered-green: "#34d399"
  failed-red: "#f87171"
  idle-gray: "#71717a"
typography:
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.5
  window-title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 650
    letterSpacing: "-0.01em"
  settings-body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 600
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12.5px"
    fontWeight: 550
  hint:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
  mono-value:
    fontFamily: "ui-monospace, 'Cascadia Code', monospace"
    fontSize: "13px"
    fontWeight: 400
    letterSpacing: "0.02em"
  timer:
    fontFamily: "ui-monospace, 'Cascadia Code', monospace"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "0.03em"
  history-meta:
    fontFamily: "ui-monospace, 'Cascadia Code', monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.02em"
rounded:
  hairline: "2px"
  track: "3px"
  chip: "4px"
  input: "8px"
  icon: "9px"
  row: "10px"
  capsule: "11px"
  panel: "12px"
  pill: "13px"
  card: "16px"
  mini-bar: "18px"
  full: "999px"
  key: "50%"
spacing:
  hairline-gap: "4px"
  tight: "6px"
  gap: "8px"
  row-gap: "10px"
  inset: "12px"
  text-inset: "16px"
components:
  key-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.key}"
    size: "32px"
  key-ghost-hover:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.text-primary}"
  key-done:
    backgroundColor: "{colors.text-primary}"
    textColor: "{colors.bar-ink}"
    rounded: "{rounded.key}"
    size: "32px"
  key-done-hover:
    backgroundColor: "#ffffff"
  key-done-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.text-faint}"
  key-discard-hover:
    backgroundColor: "rgba(248, 113, 113, 0.12)"
    textColor: "{colors.failed-red}"
  pill-primary:
    backgroundColor: "{colors.text-primary}"
    textColor: "{colors.bar-ink}"
    rounded: "{rounded.pill}"
    height: "26px"
    padding: "0 11px"
  pill-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.pill}"
    height: "26px"
    padding: "0 11px"
  update-panel:
    backgroundColor: "rgba(255, 255, 255, 0.05)"
    rounded: "{rounded.panel}"
    padding: "10px 12px"
  card:
    backgroundColor: "{colors.bar-ink}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
  card-wash:
    backgroundColor: "{colors.wash-faint}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.panel}"
    padding: "16px 18px"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.input}"
    padding: "9px 11px"
  button-standard:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.full}"
    padding: "8px 14px"
  button-standard-hover:
    backgroundColor: "rgba(255, 255, 255, 0.14)"
  button-primary:
    backgroundColor: "{colors.text-primary}"
    textColor: "{colors.bar-ink}"
    rounded: "{rounded.full}"
    padding: "9px 20px"
  button-primary-hover:
    backgroundColor: "#ffffff"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.full}"
    padding: "8px 14px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.input}"
    padding: "8px 12px"
  tab-active:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.text-primary}"
---

# Design System: Earheart

## Overview

**Creative North Star: "The Quiet Transcription Bar"**

Earheart is a clean minimal dictation bar played straight — the category canon
of Wispr Flow and superwhisper, held to craft-bar standard. The live words ARE
the interface: a solid near-black strip pinned low on the screen,
hairline-edged, with the transcript growing upward above a single control row.
Every control is a glyph the whole world already reads (pause, check, X);
nothing on the bar needs a manual, a legend, or a label.

One color speaks: a coral accent lifted from the app icon's waveform-heart,
and it means exactly one thing — "Earheart is working with your voice." The
capture dot, the live waveform, and the dictation progress fill wear it;
beyond the bar it appears only in two sanctioned capture moments (see The
Capture Exception). Everything else is white and gray on near-black, with
green and red confined to miniature status signals. The world explicitly
refuses the hardware metaphor: no tape, no lamps, no legends, no eject. The
previous "Tape Transport" service-panel system and the earlier violet/rose
"On-Air Lamp" system are both fully retired; neither may resurface.

**Scope note:** the world now covers every surface. The overlay
(`renderer/overlay.*`), the settings window (`renderer/settings.*`), and the
setup wizard (`renderer/wizard.*`, which layers on `settings.css`) all speak
this language; the framed windows extend the bar's grammar with white-wash
cards, solid inputs, and pill buttons, documented below. The main process
paints framed windows in Bar Ink before load (`INK_COLOR` in
`main/windows.js`), which must stay in sync with `--ink` — the one name the
value carries in both `overlay.css` and `settings.css`. The retired Tape
Transport and On-Air Lamp systems survive only as historical notes.

**Key Characteristics:**
- Solid neutral near-black surfaces; nothing translucent under text
- One coral accent, reserved exclusively for the voice being heard or captured
- Universally-read glyphs in circular ghost keys; one filled white Done key
- Chosen things are white: washes, radio cores, switch tracks, the Save pill
- Hairline edges and subtle white washes instead of shadows
- The live transcript is the hero; chrome stays quiet around it

## Colors

A single-accent dark-neutral palette: near-black ink, four steps of white/gray
text, a small family of white washes and hairlines, one coral voice, and
green/red kept miniature.

### Primary
- **Coral Voice** (`coral-voice`): the app's one expressive color, from the
  icon's waveform-heart. On the overlay it appears only where the user's voice
  is live or being processed: the capture dot (filled) and warming/paused ring
  (hollow), the canvas waveform, and the dictation progress fill. The value is
  duplicated as `WAVE_COLOR` in `overlay.js` and must be kept in sync with
  `--accent` in `overlay.css`. Off the overlay it appears only under The
  Capture Exception below.

### Neutral
- **Bar Ink** (`bar-ink`): every surface — the overlay bar (solid, never
  translucent) and the framed settings/wizard windows, painted before load via
  `INK_COLOR` in `main/windows.js`. Also the glyph/label color on filled-white
  elements.
- **Primary Text** (`text-primary`): settled transcript text, active timer,
  headings and labels, the filled Done key / Save pill, white download fills,
  switch-on tracks, chosen radio cores.
- **Status Text** (`text-status`): the overlay's one-word status next to its
  dot.
- **Dim Text** (`text-dim`): secondary text, hints, the streaming raw tail,
  idle key glyphs, quiet pills, index entries at rest, placeholders. Chosen to
  hold ≥4.5:1 on Bar Ink.
- **Faint Text** (`text-faint`): disabled key glyphs only.
- **Hairline Edge** (`hairline-edge`): card and panel borders.
- **Seam** (`seam`, white 0.08): dividers between regions — header/footer
  borders, the index rail's edge, the legend's trailing hairline, history-card
  borders, the overlay's transcript/controls divider.
- **Hover Wash** (`hover-wash`, white 0.08): ghost-key and quiet-pill hover
  fill, standard pill-button fill, the index's active wash, the held (paused)
  pause key.
- **Faint Wash** (`wash-faint`, white 0.04): card fills, quiet hovers — the
  settings window's card material (cards sit at 0.04–0.05 with a hairline
  edge).
- **Track** (`track`): empty progress/download track fills.
- **Field** (`field`, #101013): input fill — a deliberate step below the ink
  so fields read as wells.
- **Field Edge** (`field-edge`, #6b6b74): the input boundary, chosen to clear
  the 3:1 UI-component contrast bar on the ink (WCAG 1.4.11).
- **Tray** (`tray`, black 0.25): the darker inset model-management trays
  inside cards.

### Status hues
- **Delivered Green** (`delivered-green`): the overlay's "done / pasted"
  status dot; success status text on settings (`.status.ok`).
- **Failed Red** (`failed-red`): the overlay's "error" status dot; fault
  status text on settings (`.status.err`); and the Destructive Hover
  Exception.
- **Idle Gray** (`idle-gray`): the idle / nothing-heard status dot.

### Named Rules
**The One Voice Rule.** Coral is spent only on the dictation itself — the
capture dot, the waveform, the dictation progress fill. When the app talks
about itself (the update prompt, model downloads), it uses the neutral white
grammar: filled white primary pill, white download-bar fill. Never spend coral
on non-voice surfaces.

**The Capture Exception.** On the settings window coral appears exactly once:
a hotkey field mid-capture (`.capturing` — coral border
rgba(251, 77, 92, 0.55), coral wash rgba(251, 77, 92, 0.07), 0-blur coral
ring rgba(251, 77, 92, 0.16)), because the field is literally capturing the
user's key press. The wizard's mini-bar demo is the only other sanctioned
non-overlay coral: it is a depiction of the real bar, not a new use. No third
use exists.

**The Tiny Dot Rule.** Green and red stay miniature: 8px status dots on the
overlay, single lines of 13px status text on settings/wizard (`.status.ok` /
`.status.err`) — never fills, washes, or large surfaces. One deliberate
carve-out: the Destructive Hover Exception. Destructive controls (the
overlay's discard key, `button.danger` pills) are gray at rest and take
Failed Red text plus a red wash (rgba(248, 113, 113, 0.12), pills add a
rgba(248, 113, 113, 0.4) border) on hover only — red names the consequence at
the moment of intent, never at rest.

## Typography

**Body Font:** system-ui (with -apple-system, "Segoe UI", sans-serif)
**Mono Font:** ui-monospace (with "Cascadia Code", monospace) — machine
values only

**Character:** invisible craftsmanship. The native system stack at small,
confident sizes; weight and gray-steps carry the hierarchy, not size jumps.
The transcript is the largest type in the system because the words are the
interface; window chrome never exceeds 16px.

### Hierarchy
- **Body** (500, 15px, 1.5): the live transcript — settled cleaned text in
  Primary Text; the still-streaming raw tail in Dim Text, brightening as it
  settles. The largest type anywhere.
- **Window Title** (650, 16px, -0.01em): the settings header h1 and wizard
  step h2 — the framed windows' largest chrome text.
- **Settings Body** (400, 14px, 1.45): the settings/wizard base text — leads,
  option copy, history text at 13px within it. Running copy holds a ~62ch
  measure.
- **Title / Section** (600, 13px): the update prompt's headline; settings
  section headings (`.legend`) and card titles — quiet sentence case, the
  legend running into a hairline.
- **Label** (550, 12.5px overlay / 13px settings field labels): the overlay's
  one-word status; settings field labels. Pill labels are 12–13px
  (600 primary / 500 quiet).
- **Hint** (400, 12px, 1.55): settings hints, descriptions, toggle
  descriptions, muted text, in Dim Text.
- **Caption** (400, 11.5px): the overlay's detail line and update note, single
  line with ellipsis.
- **Mono values** (400, 13px mono, 0.02em): hotkey accelerators, textareas
  (prompt, dictionary). The version readout is mono with tabular-nums.
- **Timer** (400, 12px mono, tabular-nums, 0.03em): captured-audio time; Dim
  Text at rest, Primary Text while recording.
- **History meta** (400, 11px mono, tabular-nums, 0.02em): timestamp rows
  under history entries.

### Named Rules
**The Pending Text Rule.** Streaming, not-yet-settled words render in Dim Text
and brighten to Primary Text when cleanup settles them — the universal
"pending" signal, done with color alone, no italics or spinners.

**The Machine Values Rule.** Monospace is for machine notation only:
accelerators, timestamps, the version numeral, dictionary and prompt
textareas, `code` and `kbd`. Prose is never mono — the hotkey fields' prose
placeholders ("Click, then press…") explicitly render in the body face even
though the field itself is mono.

## Layout

Three surfaces, one world:

**The overlay bar.** One slim bar pinned to the bottom edge of a transparent
window, 12px margin all around. The card is a column: grip, optional update
panel, transcript (grows freely upward — no clip, no scroll, no mask), then
the 44px control row. The control row reads left to right: status dot + word,
waveform (flexes to fill), timer, pause, Done, discard — with a 4px extra gap
isolating discard from Done. The transcript's 16px side padding aligns its
text column with the control row's left edge. Overlays that appear mid-flow
(the progress bar over the wave area) are absolutely positioned so they never
change the card height; when the transcript actually grows, the card eases its
own height (0.18s). On narrow widths the update panel's actions wrap to a
second line, with the two "no" pills grouped so they wrap together.

**The settings window** (760×780 default, 560×480 minimum, framed, solid Bar
Ink). One continuous page read top to bottom — every control visible, no
hidden-tab shuffle. Header (icon + 16px title + tagline, seam below), then a
deck: a 168px sticky index rail on the left (outside the scroll area, seam on
its right) beside one scrolling column of sections capped at 620px
(`.panel { max-width: 620px }`), then a fixed footer commit row (seam above,
right-aligned, white Save pill). The index is a scroll spy with roving
tabindex: the entry under the read head takes the wash; clicking glides the
page (`scroll-behavior: smooth`) and moves focus to the section legend. Below
600px the index docks horizontally above the page.

**The setup wizard** (620×680, 560×560 minimum). Layers on `settings.css`:
same header and materials. Steps (max-width 640px) center vertically in the
fixed frame via auto margins that collapse when a tall step scrolls. The
footer is the wizard's nav row: Skip on the left, step dots centered,
Back/Next on the right — Next/Get started is the filled white pill. Below
600px the welcome demo stacks vertically.

## Elevation & Depth

Flat by necessity and by conviction. The overlay window is transparent and
focusable:false, so surfaces carry **no drop shadows** — soft shadows band and
halo on transparent windows — and the framed windows keep the same flatness by
conviction. Depth is conveyed by hairline edges, white washes (0.04–0.14 alpha
fills), and one step of solid layering: inputs sink to Field (#101013), model
trays sink to Tray (black 0.25), cards rise on Faint Wash. Every surface under
text is opaque or sits on the solid ink.

### Named Rules
**The No Surface Shadow Rule.** No blurred or offset `box-shadow` on any
surface, card, key, or pill — ever. Two device classes are explicitly *not*
elevation and are sanctioned: (1) the recording dot's coral bloom
(`box-shadow: 0 0 6px rgba(251, 77, 92, 0.45)`; its wizard-demo miniature
uses `0 0 5px rgba(251, 77, 92, 0.5)`) — a light-emission cue on a tiny dot;
and (2) 0-blur box-shadow spreads used as rings — the input focus ring
(`0 0 0 3px rgba(255, 255, 255, 0.1)`) and the hotkey capture ring
(`0 0 0 3px rgba(251, 77, 92, 0.16)`). Zero-blur spreads are
outline-equivalents that hug the border; they cast nothing. True drop shadows
remain banned everywhere.

**The Solid Ground Rule.** Text never sits on translucency over the desktop.
The bar is solid Bar Ink; framed windows are painted Bar Ink before load;
in-window washes are safe because the solid ink is beneath them.

## Shapes

Soft-rounded rectangles, perfect circles, and full pills. The radius scale as
built: 2px hairline rounds (progress tracks, grip), 8px (inputs, selects,
textareas, index entries, model trays), 10px (option rows, history cards),
12px (cards, banners, the overlay's update panel, wizard summary / value /
download cards), 13px-on-26px overlay pills, 16px overlay card
(`overflow: hidden` keeps children inside the corners), 18px the wizard's
mini-bar demo, and fully-rounded 999px pills (settings buttons, the segmented
control). All overlay keys are 32px circles whose clickable area extends to
~42px via an invisible `::before` halo (inset -5px) — the hit area grows, the
painted key does not. Borders are 1px hairlines only (the demo `kbd` keycaps'
2px bottom edge is the lone weighted edge); no decorative borders, no square
corners anywhere.

## Components

### Keys (overlay circular icon buttons)
- **Character:** quiet glyphs everyone already reads; state changes are color
  and fill, never position.
- **Shape:** 32px circle, ~42px invisible hit halo (`::before`, inset -5px).
- **Ghost (pause, discard):** transparent with Dim Text glyph; hover fills
  Hover Wash and brightens the glyph to Primary Text; active presses to
  `scale(0.92)`.
- **Done (`#stop`):** the one filled key — Primary Text fill, Bar Ink glyph,
  pure white on hover; the single strongest thing on the bar. Disabled outside
  a live take: transparent with a Faint Text glyph, but it stays in its slot.
- **Discard (`#cancel`):** a plain X, gray until you mean it; hover applies
  the Destructive Hover Exception (Failed Red glyph + red wash). Carries a 4px
  extra left margin so it isn't hit by reflex next to Done.
- **Pause:** latching (`aria-pressed`); while paused it holds the Hover Wash
  fill and swaps to the play glyph.
- **Focus:** `outline: 2px solid` Primary Text, 2px offset — the universal
  focus treatment across all three surfaces.
- **Named rule — The Keys Keep Their Slots Rule.** Keys disable and fade but
  never leave the row; the row never reflows and no key ever jumps under the
  cursor.

### Pills — overlay (update-prompt text actions)
- **Shape:** fully rounded, 26px tall, 0 11px padding, 12px text.
- **Primary:** filled Primary Text with a Bar Ink label; pure white on hover.
- **Quiet:** transparent with a Dim Text label (weight 500); hover wash +
  brighten, same as ghost keys.

### Pill buttons — settings/wizard (three tiers + danger)
- **Shape:** fully rounded (999px), 8px 14px padding, 13px/500 text; active
  presses to `scale(0.97)`; disabled holds opacity 0.6 (in-flight labels like
  "Checking…" stay readable).
- **Primary (Save / Get started):** the one filled white pill per window —
  Primary Text fill, Bar Ink label, weight 600, 9px 20px padding, pure white
  on hover. The overlay Done key's grammar on a framed window.
- **Standard:** Hover Wash fill (white 0.08), brightening to white 0.14 on
  hover.
- **Ghost:** transparent, 1px rgba(255, 255, 255, 0.14) edge, Dim Text label;
  hover takes Faint Wash + bright text.
- **Danger:** a ghost/standard pill that is gray at rest; hover applies the
  Destructive Hover Exception (red text, rgba(248, 113, 113, 0.12) wash,
  rgba(248, 113, 113, 0.4) border).

### Sticky index (settings navigation)
- 168px rail outside the scroll area; entries are 8px-radius text buttons
  (13px/500, Dim Text) that wash faintly on hover; the active entry takes
  Hover Wash + Primary Text — no markers, no dots. Scroll spy tracks the read
  head; roving tabindex; clicks glide the page and focus the section legend.
  Docks horizontally with a bottom seam below 600px.

### Section headings
- **Legend:** 13px/600 sentence case running into a 1px seam hairline
  (`::after` flex line); `scroll-margin-top: 12px` so anchored scrolls land
  clear of the edge; focusable (tabindex -1) with a keyboard-only ring.

### Cards / Containers
- **White-wash cards:** Faint Wash fill (white 0.04; the overlay update panel
  and setup banner sit at 0.05) + 1px Hairline Edge, 12px radius, 16px 18px
  padding, 13px/600 card titles. Fields inside separate by whitespace only.
- **Banner:** the overlay's update-panel grammar on the settings page — white
  0.05 wash, hairline edge, 12px radius, 11px 14px padding, message left /
  ghost pill right.
- **History cards:** Faint Wash + seam border, 10px radius, 11px 13px padding;
  13px pre-wrapped text above an 11px mono meta row (timestamp left, small
  copy pill right).
- **Model trays:** a darker inset inside a card — Tray fill (black 0.25),
  1px rgba(255, 255, 255, 0.07) edge, 8px radius, 12px 14px padding; holds
  the model note, its download bar, and its buttons.
- **Wizard summary / value / download cards:** Faint Wash + hairline edge,
  12px radius; the summary is a dl of seam-divided rows with mono accelerator
  values; value lists use neutral "–" markers in Dim Text (never emoji — the
  world speaks one color).

### Inputs / Fields
- **Style:** solid Field fill (#101013), 1px Field Edge boundary (#6b6b74 —
  the 3:1 cue against the card), 8px radius, 9px 11px padding, 13px text;
  placeholders in full Dim Text (no opacity). Selects draw their own Dim Text
  caret (hardcoded #a1a1aa in the data URI — keep in sync).
- **Focus:** border brightens to Primary Text white plus the 0-blur ring
  (`box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.1)`) — the "active thing is
  white" grammar; no default outline.
- **Textareas** (prompt, dictionary): mono 13px, vertical resize.
- **Hotkey capture fields:** readonly, mono, click-to-capture; hover hints
  changeability (Dim Text border + white 0.06 fill); while capturing they wear
  The Capture Exception's coral border/wash/ring.

### Segmented control (engine choice)
- A Field-filled pill track (999px, 3px padding, hairline edge) holding pill
  segments; real radios stretched invisibly over each label so the whole
  segment is the target. Chosen segment takes a white 0.14 wash + Primary
  Text; keyboard focus surfaces as a ring on the label.

### Option rows (radios)
- 10px-radius rows, transparent border at rest, Faint Wash on hover; the
  chosen row takes a white 0.07 wash + brightened rgba(255, 255, 255, 0.22)
  edge — chosen is white, like everything chosen in this system. Custom 16px
  radios: Field Edge ring that gains a white core (`inset: 3px`) when chosen.

### Switches & checkboxes
- **Switch:** 40×22px track, white 0.1 fill + hairline edge off, Dim Text
  knob; checked fills the track solid white and the knob goes Bar Ink — the
  filled-white "this is on" grammar. 0.16s ease.
- **Checkbox (`.choice`):** 16px, 4px radius, Field Edge ring; checked fills
  white with an ink check.
- **Slider:** a 4px hairline light track (white 0.15, 2px radius) under a
  16px solid white knob; keyboard-only focus ring. The live readout label is
  the bright element (14px Primary Text).

### Status dot + word (overlay)
- An 8px dot beside one 12.5px word; the dot's fill and motion carry the state
  contract, the word names it. Working states pulse the dot in Dim Text gray;
  done / error / idle are steady Delivered Green / Failed Red / Idle Gray.
- **Named rule — The Filled Dot Contract.** The filled pulsing coral dot +
  moving waveform + running timer together mean "audio is captured right
  now." Mic warm-up is a pulsing hollow coral ring; paused is a steady hollow
  coral ring. Never show the filled dot before samples actually flow.

### Status text (settings/wizard)
- 13px Dim Text lines beside or under their action; `.ok` in Delivered Green,
  `.err` in Failed Red; long unbroken errors wrap (`overflow-wrap: anywhere`).

### Waveform (signature component)
- A live canvas amplitude trace in Coral Voice — the proof of hearing. Columns
  are 2.5px wide, one per 80ms of audio (~31px/s), newest at the right edge,
  gliding left at sub-pixel float coordinates. The backing store tracks the
  CSS box × devicePixelRatio so bars stay crisp at any width.
- Outside capture it dims to a ghost of the take (opacity 0.25); when the
  detail line needs the space it steps back to 0.07.
- `WAVE_COLOR` in `overlay.js` must equal `--accent` in `overlay.css`.

### Progress fills
- Overlay: 3px hairline tracks (Track fill, 2px radius); dictation progress
  fills Coral Voice, the update download fills white. Settings/wizard
  download and update bars (`.dl-bar`): 6px tracks (white 0.12, 3px radius)
  with solid white fills — always white, never coral (One Voice Rule). All
  fills ease `width 0.15s linear`, driven from JS.
- The overlay's dictation progress overlays the bottom of the wave area
  absolutely, so appearing never changes card height.

### Update panel (overlay)
- A quiet in-card note: 12px radius, white 0.05-alpha fill, hairline edge,
  10px 12px padding. Entirely neutral-white grammar — no coral. In solo mode
  the control row hides and the note is the whole card.

### Wizard step dots
- 7px circles, white 0.35 at rest (clearing the 3:1 UI bar on the ink), solid
  white when active; centered in the footer with an sr-only spoken
  counterpart.

### Wizard demo (welcome step)
- Three Faint Wash demo cards with 11px captions: `kbd` keycaps (wash fill,
  6px radius, 2px bottom edge, 11px mono); the **mini quiet bar** — an
  18px-radius miniature of the real bar (ink fill, 0.14 hairline) with pulsing
  6px coral dot (5px bloom), animated coral wave bars on a deliberately
  non-monotonic 7-bar delay cycle, 10px mono timer, and a 16px filled white
  Done circle — the sanctioned demonstration coral; and a typing line behind
  a plain 1px white caret. All demo animations go still under reduced motion.

### Grip (overlay)
- The sheet-grabber convention: 36×4px, 2px radius, white at 0.16 alpha,
  brightening to 0.28 on card hover. Decorative — the whole card drags.

### Motion
- Overlay card entrance: opacity + `translateY(8px) scale(0.98)` → identity,
  0.2s ease; height changes ease 0.18s.
- State changes everywhere: 0.12s ease (keys, pills, tabs, inputs, options);
  switches 0.16s; active presses 0.08s (`scale(0.92)` keys, `scale(0.97)`
  pills).
- Progress fills: `width 0.15s linear` (the incumbent shipped mechanism).
- Dot pulses: opacity 1 → 0.45 — 2s recording (and the wizard's mini-dot),
  1.2s working, 1s warming; the demo wave cycles 1s, the demo typing 4s.
- Settings index clicks glide via `scroll-behavior: smooth`.
- `prefers-reduced-motion`: on the overlay, pulses stop and transitions
  collapse to ~instant; the waveform still updates (it is state, not
  decoration) but stops gliding. On settings/wizard, all transitions and
  animations collapse to 0.01ms, infinite demo animations are forced to a
  single iteration (they go still, not fast), and the scroll glide becomes a
  jump.

## Do's and Don'ts

### Do:
- **Do** keep every surface under text solid; every window is opaque Bar Ink
  (#18181b) — the overlay by its own paint, framed windows via `INK_COLOR` in
  `main/windows.js`, kept in sync with `--ink`.
- **Do** reserve Coral Voice (#fb4d5c) for the dictation itself — capture dot,
  waveform, dictation progress — plus only the two Capture Exception moments
  (a hotkey field mid-capture; the wizard's mini-bar demo). Keep `WAVE_COLOR`
  in `overlay.js` in sync with `--accent`.
- **Do** use the filled-white grammar (Done key, Save / Get started pill,
  switch-on track, radio core, download fill) for the single strongest action,
  the chosen state, or the app talking about itself.
- **Do** keep keys in their slots across all states — disable and fade, never
  remove or reflow.
- **Do** honor the Filled Dot Contract: filled pulsing coral dot only while
  samples flow; pulsing hollow ring for warm-up; steady hollow ring for
  paused.
- **Do** extend hit areas invisibly (`::before` halos to ~42px; radios and
  segments stretched over their whole row) instead of enlarging painted
  controls.
- **Do** set machine values in mono (accelerators, timestamps, version,
  dictionary/prompt textareas) and keep prose — including the hotkey fields'
  placeholders — in the body face.

### Don't:
- **Don't** put blurred or offset drop shadows on any surface, key, or pill;
  the sanctioned exceptions are the recording dot's coral bloom (and its
  wizard-demo miniature) and 0-blur focus/capture rings, which are
  outline-equivalents, not elevation.
- **Don't** use green or red beyond miniature status signals (8px overlay
  dots, one-line settings status text) — except the Destructive Hover
  Exception on the discard key and `button.danger` pills, red on hover only.
- **Don't** reintroduce the hardware metaphor: no tape reels, lamps, legends,
  labels-under-keys, or eject glyphs; the retired Tape Transport and On-Air
  Lamp systems are historical notes only and may not resurface on any
  surface.
- **Don't** spend coral outside the voice and the two Capture Exception
  moments; a third non-overlay coral use is a defect, not a precedent.
- **Don't** make chrome text larger than the transcript (15px) on the bar, or
  larger than the 16px window title on framed windows; the words stay the
  biggest thing in the system.
- **Don't** hide sections behind tabs on the settings page; the page is one
  scrolling column and the index is a map, not a shuffle.
