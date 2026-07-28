---
name: Earheart
description: Private, hotkey-driven voice dictation for the desktop
colors:
  face: "#1c1713"
  face-edge: "rgba(255, 240, 214, 0.14)"
  recess: "#0f0c09"
  ribbon: "#35291d"
  oxide: "#d29a5a"
  ivory: "#f2e9da"
  ivory-dim: "#a89b88"
  alu: "#b4a894"
  key: "#2a2118"
  key-hover: "#342a1e"
  key-edge: "rgba(255, 240, 214, 0.12)"
  panel: "#221b15"
  panel-edge: "rgba(255, 240, 214, 0.1)"
  seam: "rgba(255, 240, 214, 0.07)"
  well-edge: "#776a58"
  rec: "#ff4438"
  busy: "#ffb03a"
  busy-hover: "#ffc262"
  busy-wash: "rgba(255, 176, 58, 0.07)"
  busy-line: "rgba(255, 176, 58, 0.35)"
  done: "#59c98a"
  ok-text: "#8fdcae"
  err-text: "#ffb4ac"
  inert: "#9b9187"
  raw-warm: "#e7b57e"
typography:
  transcript:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.5
  status:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 600
  detail:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10.5px"
    fontWeight: 400
  note-title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 600
  note-body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
  legend:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "8px"
    fontWeight: 700
    letterSpacing: "0.08em"
  counter:
    fontFamily: "ui-monospace, 'Cascadia Code', monospace"
    fontSize: "13px"
    fontWeight: 400
    letterSpacing: "0.04em"
  panel-title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 650
    letterSpacing: "-0.01em"
  reading:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 500
  machine-value:
    fontFamily: "ui-monospace, 'Cascadia Code', monospace"
    fontSize: "13px"
    fontWeight: 400
    letterSpacing: "0.02em"
  hint:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
  meta-mono:
    fontFamily: "ui-monospace, 'Cascadia Code', monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.02em"
  silk-legend:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.1em"
rounded:
  bar: "1px"
  track: "2px"
  sub-well: "4px"
  well: "6px"
  pill: "7px"
  mini-face: "8px"
  key: "9px"
  note: "10px"
  capsule: "11px"
  card: "12px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  xxl: "24px"
components:
  faceplate:
    backgroundColor: "{colors.face}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.card}"
  transport-key:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.key}"
    size: "34px"
  transport-key-hover:
    backgroundColor: "{colors.key-hover}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.key}"
    size: "34px"
  transport-key-stop:
    backgroundColor: "#3a1611"
    textColor: "{colors.err-text}"
    rounded: "{rounded.key}"
    size: "34px"
  transport-key-stop-hover:
    backgroundColor: "#4a1b14"
    textColor: "{colors.err-text}"
    rounded: "{rounded.key}"
    size: "34px"
  counter-cell:
    backgroundColor: "{colors.recess}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.well}"
    height: "30px"
    width: "52px"
  tape-window:
    backgroundColor: "{colors.recess}"
    rounded: "{rounded.well}"
    height: "34px"
  pill-primary:
    backgroundColor: "{colors.busy}"
    textColor: "#241703"
    rounded: "{rounded.pill}"
    height: "26px"
    padding: "0 10px"
  pill-primary-hover:
    backgroundColor: "{colors.busy-hover}"
    textColor: "#241703"
    rounded: "{rounded.pill}"
    height: "26px"
    padding: "0 10px"
  pill-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ivory-dim}"
    rounded: "{rounded.pill}"
    height: "26px"
    padding: "0 10px"
  update-note:
    backgroundColor: "{colors.busy-wash}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.note}"
    padding: "10px 12px"
  group-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.card}"
    padding: "16px 18px"
  input-well:
    backgroundColor: "{colors.recess}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.well}"
    padding: "9px 11px"
  key-button:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.key}"
    padding: "8px 14px"
  key-button-hover:
    backgroundColor: "{colors.key-hover}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.key}"
    padding: "8px 14px"
  save-key:
    backgroundColor: "{colors.busy}"
    textColor: "#241703"
    rounded: "{rounded.key}"
    padding: "9px 20px"
  save-key-hover:
    backgroundColor: "{colors.busy-hover}"
    textColor: "#241703"
    rounded: "{rounded.key}"
    padding: "9px 20px"
  ghost-key:
    backgroundColor: "transparent"
    textColor: "{colors.ivory-dim}"
    rounded: "{rounded.key}"
    padding: "8px 14px"
  switch:
    backgroundColor: "{colors.recess}"
    rounded: "{rounded.capsule}"
    width: "40px"
    height: "22px"
  switch-on:
    backgroundColor: "{colors.busy}"
    rounded: "{rounded.capsule}"
    width: "40px"
    height: "22px"
  history-take:
    backgroundColor: "{colors.recess}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.well}"
    padding: "11px 13px"
---

# Design System: Earheart

## Overview

**Creative North Star: "The Tape Transport"**

Earheart's overlay is a machine you can watch working: a miniature reel-to-reel
lying along the bottom of the screen. Dictation is not a pulsing dot in a
pill — it is signal being physically written onto moving tape. The world is a
warm-black instrument faceplate with wells sunk into it: an umber tape ribbon
carrying the oxide-written waveform past a fixed record head, aluminum reels
whose hub windows make rotation visible, a mechanical counter, legended status
lamps, and machined transport keys. A glance tells the whole story: lamp lit,
reels turning, your words being written onto tape and appearing above; the
backlit square key stops, eject discards.

The Tape Transport now covers **every surface**. The settings window and the
setup wizard are "the service panel": the same machine opened up for
maintenance — one continuous scrolling faceplate with a sticky printed index
(its amber lamp marks the section under the read head), machined group panels,
inputs sunk in as recessed wells, key-cap buttons, aluminum switch slugs, and
an amber-backlit Save key. The earlier violet/rose "On-Air Lamp" system is
fully retired and exists nowhere in the product.

The finish is flat matte throughout. The only glow in the world comes from
things that are lit — status lamps, the backlit STOP and Save keys, the
playhead — never from ambience. Depth is machined into the faceplate (inset
wells, inset top highlights), never cast under it: the overlay window is
transparent, and a drop shadow would band and halo against the desktop.
Motion is mechanical physics, not decoration: reels spin at different speeds,
keys travel when pressed, tape glides at a fixed write speed, the service
panel glides tape-style to indexed sections, and all of it collapses to
instant state changes under `prefers-reduced-motion`. Text is quiet system UI
silk-screened in ivory onto the faceplate; the machine's own numerals and
notation are monospace.

Confirmed rejections, from the shipped surfaces themselves: no cast shadows on
the transparent overlay window; no translucent surface under text (the
faceplate is solid so the written tape and the warm raw tail never depend on
what shows through behind the overlay); no category-standard pulsing-dot
pill; no hidden-tab shuffle in settings (every control lives on one visible
panel).

**Key Characteristics:**

- Interface as instrument: every state is a lamp, a reel speed, or a written
  trace — never an abstract spinner.
- Warm-black and oxide materials; saturated color exists only in lamps.
- Depth by inset: wells sink into the faceplate; nothing floats above it.
- Glow means lit: lamp blooms and key backlights are the world's only shadows.
- Honest state: the machine never claims to be listening before samples flow.
- One world everywhere: the overlay is the machine running; settings and
  wizard are the same machine on the service bench.

## Colors

A warm-black machine built from browns, umbers, and ivory, with saturated
color reserved for four legended lamps.

### Primary

- **Rec Lamp Red** (#ff4438): the recording lamp — lit and pulsing only while
  audio is actually being captured, and as the tint of the backlit STOP key
  (fill #3a1611, glyph #ffb4ac, border rgba(255,68,56,0.5)). The lit REC
  legend reads in #ff958c. On the service panel, a hotkey-capture field that
  is literally recording your key press borrows this vocabulary: red border
  rgba(255,68,56,0.55), red wash rgba(255,68,56,0.07), red focus halo.
- **Oxide** (#d29a5a): the signal written onto the tape, drawn at
  rgba(210,154,90,0.9) on the ribbon. Material, not a lamp: deliberately
  muted so the saturated red stays reserved. On the service panel it is the
  focus color of a well being written into (focus border + halo
  rgba(210,154,90,0.22)) and the wizard demo's typing caret.
- **Raw Warm** (#e7b57e): the freshly-written, not-yet-settled transcript
  tail — bright and warm off the head, cooling to ivory as cleanup settles it.
  Carries a faint warmth glow (text-shadow rgba(231,181,126,0.25)).

### Secondary

The remaining lamps of the fixed status vocabulary:

- **Busy Lamp Amber** (#ffb03a): the machine working — transcribing,
  cleaning, delivering — and the machine talking about itself: the update
  note's lamp and pills (hover #ffc262), and across the service panel the
  active index lamp, the selected option's wash, the lit radio/checkbox
  sockets, the engaged switch channel, download fills, wizard step lamps, and
  the backlit Save key. Lit BUSY legend reads in #ffc76e. The self-reference
  wash is **Busy Wash** (rgba(255,176,58,0.07)) edged by **Busy Line**
  (rgba(255,176,58,0.35)).
- **Done Lamp Green** (#59c98a): delivered. Its lit-legend tone **OK Text**
  (#8fdcae) is the service panel's success status text.
- **Inert Warm Grey** (#9b9187): idle, error, or empty — a warm, deliberately
  unalarming unlit lamp.
- **Err Text** (#ffb4ac): the STOP key's glyph tone, reused as the service
  panel's fault status text and the tint of danger keys.

### Neutral

The machine's materials, dark to light:

- **Recess Black** (#0f0c09): wells sunk into the faceplate — the tape
  window, the counter cell, every service-panel input, the segmented track,
  radio/checkbox sockets, switch channels, history takes, and model trays —
  and the reel hub windows.
- **Faceplate Black** (#1c1713): the card and every window itself; warm
  black, solid so text never sits over the desktop. Settings and wizard
  windows paint it as their native background.
- **Panel** (#221b15): a machined group panel, one shade off the faceplate;
  edged in **Panel Edge** (rgba(255,240,214,0.1)) and separated from
  neighboring regions by recessed **Seam** hairlines (rgba(255,240,214,0.07)).
- **Key Cap** (#2a2118): machined transport keys and service-panel buttons
  (hover **Key Hover** #342a1e), edged in **Key Edge**
  (rgba(255,240,214,0.12)).
- **Tape Umber** (#35291d): the ribbon the signal is written onto (the wound
  tape packs on the reels are the close sibling #3a2c1f); also the service
  panel's scrollbar thumb.
- **Well Edge** (#776a58): the recessed input's boundary against the panel —
  holds ≥3:1 for the WCAG 1.4.11 UI-component bar.
- **Unlit Ivory** (#a89b88): unlit legends, secondary text, hints, and
  placeholders (used at full color, never via opacity); holds ≥4.5:1 on
  Faceplate Black.
- **Reel Aluminum** (#b4a894): reel flanges and hubs, the record head's shoe,
  the switch slug, and the fader knob.
- **Silk-Screen Ivory** (#f2e9da): primary text and legends, printed onto the
  faceplate; also the hairline **Machine Edge** (rgba(255,240,214,0.14)) and
  every warm-white translucent detail (grip knurling, seams, head slit).

### Named Rules

**The Lamp Vocabulary Rule.** Status colors are a fixed legended vocabulary:
REC red = capturing, BUSY amber = working (or the machine talking about
itself), DONE green = delivered, inert warm grey = idle or fault. Never
repurpose a lamp color for decoration, and never invent a second color for a
meaning that already has a lamp.

**The Service-Amber Rule.** On the service panel, amber always means "the
machine marking its own configuration": the you-are-here index lamp, the
selected option's Busy Wash + Busy Line, lit sockets, engaged switches, the
backlit Save. REC red appears on the service panel only while a hotkey field
is actually capturing a key press — the one moment settings itself records.

**The Oxide-Is-Material Rule.** The written trace is Oxide — muted, material,
the take itself. Saturated red is reserved for the REC lamp and the backlit
STOP key. If the tape glows lamp-red, the lamp means nothing.

## Typography

**Display Font:** none — the machine has no display tier.
**Body Font:** system-ui (with -apple-system, "Segoe UI", sans-serif)
**Label/Mono Font:** ui-monospace (with "Cascadia Code", monospace)

**Character:** silk-screen printing on an instrument: small, quiet system UI
in ivory, with personality carried by weight, tracking, and the machine's own
monospace numerals and notation — never by typeface.

### Hierarchy

The overlay's tiers:

- **Transcript** (500, 15px, 1.5): the live dictation filling the top of the
  card — the largest running text in the product because it *is* the product.
  Settled text in Silk-Screen Ivory; the streaming tail in Raw Warm,
  subordinate only in weight, not legibility. Long words wrap
  (`overflow-wrap: anywhere`) rather than overflow.
- **Status** (600, 12px): the machine display's line over the tape window
  ("Transcribing…", "Pasted"), with a faint VFD warmth
  (text-shadow rgba(255,240,214,0.18)). Single line, ellipsized.
- **Note title** (600, 13px): the update service note's heading.
- **Note body / detail** (400, 11px / 10.5px): secondary lines in Unlit
  Ivory.
- **Legend** (700, 8px, 0.08em, UPPERCASE): the printed micro-legend under
  the lamp (REC/BUSY/DONE/PAUSE/ERR).
- **Counter** (ui-monospace, 13px, 0.04em, tabular-nums): the take counter.
  Digits go to 55% opacity outside recording — still readable (5.4:1 on
  Recess Black, clearing AA), clearly not running.

The service panel's tiers (settings + wizard):

- **Panel title** (650, 16px, −0.01em): the nameplate heading and wizard step
  titles — the largest type in the product, and still only 16px.
- **Reading** (400, 14px, 1.45): the panel's base body size — leads and the
  fader's live readout. Running copy holds a ~62ch measure.
- **Control** (500–600, 13px): field labels, card titles (600), index
  entries, buttons, option/toggle text, status lines, history text.
- **Machine value** (ui-monospace, 13px, 0.02em): hotkey accelerator fields —
  the counter tier applied to notation. The version readout is the same tier
  with tabular-nums.
- **Hint** (400, 12px, 1.55): explanatory copy under fields, toggle
  descriptions, inline `code` chips (mono, 12px), all in Unlit Ivory.
- **Meta mono** (ui-monospace, 11px, 0.02em, tabular-nums): history take
  timestamps — the machine's own record of when.
- **Silk-screen legend** (700, 10px, 0.1em, UPPERCASE): the printed section
  legends over machined seams — with the lamp legends, the only uppercase in
  the world.

### Named Rules

**The Machine-Numerals Rule.** Anything the machine counts or records — the
take counter, the version readout, history timestamps — is monospace with
`font-variant-numeric: tabular-nums`. Human words are never monospace, with
one named exception below.

**The Machine-Instructions Exception.** The dictionary and system-prompt
textareas are data, not prose — exact-spelling terms and model instructions
the machine consumes verbatim — so they are set in mono (13px, 1.55), as are
hotkey accelerators and `kbd` caps. If a human reads it as a sentence, it's
sans; if the machine executes it, it's mono.

## Layout

**The overlay** is a fixed-size, frameless, transparent, bottom-anchored
Electron window — the window is the layout. Base size 500×95px; the card sits
inside a 12px margin and grows *upward* as the transcript or update note
fills it (the main process resizes the window instantly; the card eases its
own height so content slides rather than pops).

Card anatomy, top to bottom: knurled drag rail (44×5px, centered) → optional
update service note → live transcript → transport row. The transport row is a
fixed 46px strip inset 12px, gapped 8px: lamp block (30px) → supply reel
(30px) → tape window (flexes to fill — the hero owns all leftover width) →
take-up reel → counter cell (min 52×30px) → PAUSE → STOP → eject, with an
extra 4px gap isolating the destructive eject. The transcript's 16px side
padding shares one left edge with the machine below it. Update-note actions
wrap to a second line rather than squeeze; when the update arrives with no
dictation behind it, the transport row hides and the note is the whole card.

**The service panel** (settings, 760×780, min 560×480) and **the wizard**
(620×680, min 560×560) are solid native windows painted Faceplate Black
(`backgroundColor: #1c1713`) with `color-scheme: dark` so native selects and
dialogs render dark. Settings anatomy: nameplate header (icon + title +
one-line pitch, seam below, machined top light) → the deck: a 168px printed
index rail on the left (sticky by construction — it sits outside the scroll
area) beside one scrolling column holding every section at once, content
capped at 620px with 24px gutters → a fixed footer commit row (seam above,
Save right-aligned). Sections are legend + machined panels; fields stack
inside a panel separated by whitespace only (the panel already frames the
group). Two-column moments use a simple 1fr/1fr grid, 12px gap. Below 600px
wide, the index docks horizontally above the panel. Clicking an index entry
glides the panel to the section (`scroll-behavior: smooth`, 12px
scroll-margin); the scroll spy lights the lamp of the section under the read
head. The wizard reuses the same frame with steps centered vertically in the
fixed window, the step-lamp row in the footer between Skip and the nav keys.

Spacing rhythm: 4 / 6 / 8 / 12 / 16 / 24px.

## Elevation & Depth

**The Depth-Is-Inset Rule.** The overlay window is transparent, and soft
shadows band and halo on transparent windows — so the card carries **no drop
shadow, ever**, and the solid service panel keeps the same physics for
coherence: panels are machined into the faceplate, not floated over it. Depth
is inset everywhere — wells recess (`inset 0 1px 3px rgba(0,0,0,0.55)`),
edges catch light as inset top highlights, and lift comes from solid surfaces
and hairline edges. Every outward glow in the system is a *lit thing*, not
elevation.

### Shadow Vocabulary

- **Recessed well** (`box-shadow: inset 0 1px 3px rgba(0,0,0,0.55)`): the
  tape window, counter cell, every service-panel input, the segmented track,
  and switch channels, sunk into the faceplate.
- **Recessed sub-well** (`inset 0 1px 3px rgba(0,0,0,0.45)`): the shallower
  sink of history takes and model trays — wells inside a panel, and sockets
  (`inset 0 1px 2px rgba(0,0,0,0.55)`) for 16px radios and checkboxes.
- **Machined edge** (`inset 0 1px 0 rgba(255,240,214,0.05–0.07)`): the inset
  top light on the card, every panel, and every key cap.
- **Lamp bloom** (`0 0 9px 1px` in the lamp's color at 0.4–0.5 alpha; the
  7px service/index/step lamps `0 0 6px rgba(255,176,58,0.6)`; lit sockets
  `0 0 5px rgba(255,176,58,0.55)`): the material of a lit lamp.
- **Key backlight — STOP** (`0 0 10px rgba(255,68,56,0.35)`, hover 0.5): the
  STOP key while there's a take to stop — the machine telling you which key
  it expects.
- **Key backlight — Save** (`inset 0 1px 0 rgba(255,255,255,0.25), 0 0 10px
  rgba(255,176,58,0.25)`, hover 12px/0.4): the same "this is the key I
  expect" grammar in the self-referential amber.
- **Playhead glow** (`0 0 6px rgba(255,176,58,0.8)`): the 2px #ffe3b0
  playhead riding a progress fill's leading edge — overlay and download bars
  alike.
- **Focus halo** (`0 0 0 3px rgba(210,154,90,0.22)` on wells; capturing
  fields swap to `rgba(255,68,56,0.16)`): a written-signal glow, layered over
  the well's inset. Keys, toggles, and tabs use the 2px ivory outline
  instead.

## Shapes

Machined rectangles on a tight radius scale: 12px for the faceplate card and
group panels, 11px for the switch capsule (height/2), 10px for service notes,
banners, and wizard cards, 9px for key caps and option rows (12px on the
keys' invisible hit halo), 8px for the wizard's miniature faceplate, 7px for
text pills and segment caps, 6px for recessed wells (inputs, history takes,
trays, `kbd` caps), 4px for sub-wells (download tracks, checkbox sockets,
`code` chips, the mini stop key), 2–2.5px for tracks and the grip rail, 1px
for the mini deck's signal bars. Circles mean *rotation and light*: reels,
hub windows, the 11px status lamp, 7px index/service/step lamps, 16px radio
sockets, and the aluminum switch slug and fader knob. Borders are 1px
warm-white hairlines (Machine Edge, Panel Edge, Key Edge, Seam) except the
solid Well Edge that must clear 3:1; the record head is a 1px ivory slit with
a 5×6px aluminum shoe riding the well's top edge. Keys paint 34px but offer a
~42px hit area via an inset −4px pseudo-element.

## Components

### Transport keys

- **Shape:** machined caps, 34×34px, 9px radius, Key Cap fill, Key Edge
  border, inset top light; glyphs are inline SVG in currentColor.
- **Hover:** surface warms to Key Hover #342a1e (0.12s ease).
- **Press:** the key travels — `translateY(1px) scale(0.96)` at 0.08s.
- **Focus:** 2px Silk-Screen Ivory outline, offset 2px.
- **PAUSE (latching):** a quiet key in Unlit Ivory that latches a live take:
  while paused it sits pressed — sunk into the faceplate (Recess Black fill,
  deeper inset well, `translateY(1px)`) with an ivory glyph — and pressing it
  again resumes the same take. Inert (unlit, disabled for AT) whenever there
  is no live take to hold.
- **STOP (backlit):** #3a1611 fill, rgba(255,68,56,0.5) border, #ffb4ac
  glyph, red backlight glow — lit while there's a take to stop (a paused
  take still counts). Outside a take it goes unlit and inert (glyph at 22%
  ivory, pointer-events off, disabled for AT) but **stays in its slot**.
- **Eject (cancel):** a standard key with the eject glyph in Unlit Ivory,
  warming to ivory on hover; offset an extra 4px from STOP so the
  destructive discard is never hit by reflex.

**The Keys-Stay-In-Their-Slots Rule.** A machine doesn't remove its keys.
Keys that don't currently apply go unlit and inert — `visibility`/state, not
`display` — so neighboring keys never jump.

### Pills (service-note actions)

- **Style:** 26px-tall text buttons, 7px radius, 12px/600; primary filled
  Busy Lamp Amber with dark #241703 text (hover Busy Hover #ffc262); quiet
  variants transparent with Unlit Ivory text, hovering to an 8% ivory wash.

### Tape window (the hero)

A recessed well (34px tall, 6px radius) that flexes to fill the space between
the reels. Inside it: the Tape Umber ribbon (canvas, darkened edges), the
oxide-written signal sliding from the fixed record head (at 40% of the
window's width, matching `TAPE_HEAD_X`) toward the take-up reel — one column
per 80ms of captured audio (≈31px/s tape speed), 2.5px per column, mirrored
amplitude, peaks allowed to overshoot the ribbon. The frozen tape *is* the
take: history survives stop and processing, and fresh tape threads only when
the next session starts. During non-recording phases the written tape dims to
22% and the well doubles as the machine's text display (status + detail,
centered).

### Lamp block

An 11px round lamp over its printed micro-legend. Starting: hollow REC ring
(2px Rec Lamp Red border, 1s pulse). Recording: filled Rec Lamp Red with
bloom, 2s pulse. Working: Busy Lamp Amber with bloom, 1.4s pulse. Done: Done
Lamp Green, steady. Error/empty: Inert Warm Grey, legend ERR/—. Paused: a
STEADY hollow REC ring — armed but deliberately not capturing — with legend
PAUSE; only the warming mic's hollow ring pulses.

**The Filled-Lamp Contract.** The lit pulsing lamp + written tape + running
counter mean "audio is being captured right now." While the mic warms up the
lamp is a hollow ring — the card only promises it's getting there. Never show
the filled lamp before samples flow.

### Reels

30px SVG reels in Reel Aluminum: wound tape pack (#3a2c1f), 1.6px flange
ring, solid hub with three Recess Black windows that make rotation visible.
The take-up reel turns a touch faster than the supply reel (1.8s vs 2.3s per
revolution) — the small asymmetry that makes it read as a machine, not a
loop. Processing plays the reels back faster (0.9s; delivering 1.4s), and
`animation-play-state: paused` (not `none`) keeps each reel's angle so the
tape stops where it stopped.

### Counter cell

A recessed cell (min 52×30px, 6px radius, Recess Black, inset well shadow)
holding the monospace take counter. It counts *captured* audio only — it
starts with the first samples, and its digits go unlit (55% opacity) outside
recording.

### Playhead progress

Overlaid along the bottom of the tape window (absolute — appearing never
changes card height): a 3px track in 12% ivory, Busy Lamp Amber fill easing
width at 0.15s linear, with the glowing #ffe3b0 playhead riding the leading
edge. A completed bar holds at 100% for 400ms — the phase's closing
statement — then hides. The update note and the service panel's download
bars reuse the same track/fill/playhead grammar.

### Update service note

The machine talking about itself: a note pinned to the faceplate above the
transcript, 10px radius, amber-washed (Busy Wash fill, Busy Line border), led
by a 7px amber service lamp with bloom. Its amber marks it as
self-referential — the REC/DONE vocabulary below belongs to the dictation.
Actions are pills; the two "stop bothering me" exits are grouped so they wrap
together. The settings window's setup-complete banner is the same note
grammar, with a ghost key to dismiss.

### The Overlay Strip (signature)

The whole system in one 500px-wide strip: solid Faceplate Black card, 12px
radius, Machine Edge hairline, machined top light, no cast shadow, pinned to
the bottom of the screen and never stealing focus. Knurled grip rail up top
(the card is the drag surface; the rail is the cue), live transcript growing
upward, and the transport row along the bottom. It enters by its own fade —
opacity + 8px rise + 0.98 scale over 0.2s — because the window can't ease.

### Printed index (settings navigation)

The service panel's table of contents: a 168px rail of quiet text entries
(13px/500, Unlit Ivory, 7px radius), each led by an unlit 7px lamp
(rgba(255,240,214,0.4) — bright enough to clear the 3:1 UI-component bar on
the faceplate, so the socket reads as present-but-off). The section under
the read head lights its lamp
amber with the service bloom and its label warms to ivory (`aria-current`,
scroll spy); hover is a 4% ivory wash. Clicking glides the panel; while a
click-initiated glide is in flight the chosen lamp holds so the spy doesn't
strobe through passing sections. Compact windows dock the rail horizontally
above the panel.

### Machined group panels

Each settings group is a panel bolted to the faceplate: Panel fill (#221b15),
1px Panel Edge hairline, 12px radius, inset top light, **no cast shadow**,
16×18px padding, 13px/600 card title. Sections open with the silk-screened
legend (10px/700/0.1em uppercase) running into a 1px Seam. The wizard's demo
cards, summary, and value cards are the same panel at 10px radius.

### Input wells

- **Style:** every text input, select, and textarea is a recessed well —
  Recess Black fill, 1px Well Edge border (#776a58, ≥3:1), 6px radius,
  `inset 0 1px 3px rgba(0,0,0,0.55)`, 9×11px padding, 13px text; placeholders
  in full Unlit Ivory (never opacity).
- **Focus:** the well's edge takes Oxide plus the written-signal halo
  (`0 0 0 3px rgba(210,154,90,0.22)`) — the slot the machine is writing into.
- **Selects:** self-drawn Unlit Ivory caret (inline SVG data URI, hex kept in
  sync with #a89b88), `appearance: none`.
- **Hotkey capture:** accelerator fields are mono machine values; populated
  fields hint changeability with a Well Edge→Unlit Ivory hover plus a 10%
  ivory wash (the recess is too dark for the 4-5% wash to register); while
  armed they go REC — red border, red wash, red halo — because the field is
  literally recording your key press.
- **Textareas (machine instructions):** mono 13px/1.55, vertical resize only.

### Key-cap buttons (service panel)

- **Standard:** the transport key grammar as a text button — Key Cap fill,
  Key Edge border, 9px radius, inset top light, 13px/500, 8×14px padding;
  hover Key Hover, press travels `translateY(1px) scale(0.98)` at 0.08s,
  focus 2px ivory outline. Disabled keys go inert at 45% opacity — never
  brightening, never travelling.
- **Save (backlit primary):** filled Busy Lamp Amber with #241703 text,
  600 weight, 9×20px padding, amber backlight (hover Busy Hover, glow up) —
  the machine's "this is the key I expect."
- **Ghost:** transparent with Key Edge border and Unlit Ivory text, warming
  to a 5% ivory wash.
- **Danger:** a standard key whose text is Err Text; hover takes a red wash
  (rgba(255,68,56,0.09)) and red border — the STOP key's tint.

### Selection controls

- **Segmented selector:** a recessed track (Recess Black, 9px radius, well
  inset, 3px padding) holding flat segments; the engaged segment becomes a
  machined key cap (Key Cap fill, Key Edge, inset light), the other stays
  sunk and unlit. The real radio stretches invisibly over the whole segment;
  keyboard focus surfaces on the label.
- **Option rows:** 9px-radius rows that take the amber service wash when
  chosen (Busy Wash fill, Busy Line border); their radios are lamps in
  wells — 16px recessed sockets that light a glowing amber core when
  selected.
- **Checkboxes:** the same socket squared off (4px radius, 2px-radius amber
  core).
- **Slide switch:** a 40×22px recessed channel (11px capsule) with a 16px
  Reel Aluminum slug; engaging it lights the channel amber and the slug takes
  the lit pill's dark #241703, sliding 18px at 0.16s ease.
- **Fader (range):** the light-track grammar — a 4px track in 15% ivory under
  a 16px aluminum knob; the live readout beside it is the bright element
  (14px ivory). Keyboard focus is the ivory outline at 3px offset.

### Download bars

The playhead grammar at service-panel scale: a 7px track (4px radius, 10%
ivory) whose Busy Lamp Amber fill eases width at 0.15s linear with the
glowing #ffe3b0 tip riding the leading edge. Model trays (`.model-manage`)
are recessed sub-wells holding the note, the bar, and the keys; the wizard's
download items wrap the same bars in panels.

### History takes

Each transcription is a take: a recessed sub-well (Recess Black, 6px radius,
`inset 0 1px 3px rgba(0,0,0,0.45)`, 11×13px padding) with the words on top
(13px/1.5, pre-wrap) and the machine's own numerals below — an 11px mono
tabular timestamp row with a small copy key.

### Wizard chrome

The wizard is the service panel walking you through the machine. Steps center
vertically in the fixed frame; step position is a row of 7px lamps in the
footer — unlit stops in 40% ivory (the index's unlit-lamp tone), the current
one lit amber with bloom,
spoken as "Step N of 7" via an sr-only counterpart. The welcome demo is three
panels: machined `kbd` key caps (6px radius, 2px bottom edge, mono 11px) →
**the mini deck**, a miniature of the real recording strip on an 8px-radius
faceplate (36px tall): pulsing 6px REC lamp, two dashed-ring aluminum reels
turning at the real transport's 2.3s/1.8s asymmetry, five 2.5px oxide signal
bars (1px radius) rising and falling, a 10px mono timer, and a 16px backlit
mini stop key (4px radius) → text typing itself out behind a 1px Oxide caret
(4s steps loop). The summary panel lists choices as seam-divided rows,
accelerators in mono.

## Do's and Don'ts

### Do:

- **Do** keep the lamp vocabulary fixed: REC red capturing, BUSY amber
  working or self-referential, DONE green delivered, inert warm grey for
  idle/fault (The Lamp Vocabulary Rule).
- **Do** express depth by inset — recessed wells (`inset 0 1px 3px
  rgba(0,0,0,0.55)`, sub-wells 0.45) and inset top lights — and reserve
  outward glow for lit things: lamp blooms, the STOP and Save backlights,
  the playhead, the focus halo.
- **Do** keep motion mechanical and honest: 0.12s ease for key/surface
  states, 0.08s key travel, 0.15s linear progress, 0.16s switch slide,
  0.18s card height, 0.2s card entrance; reels pause (keeping their angle)
  rather than reset; under `prefers-reduced-motion` collapse transitions to
  instant, stop infinite animations still (`animation-iteration-count: 1`,
  or `animation-play-state`/`none` in the overlay), and make the panel glide
  an instant jump — while still updating state.
- **Do** paint 34px keys but offer ~42px hit areas (inset −4px
  pseudo-element), and isolate destructive keys with extra gap.
- **Do** set machine numerals and machine notation in monospace —
  tabular-nums for anything counted — and dim (never hide) readouts that
  aren't running.
- **Do** keep the faceplate solid; text and tape must never depend on what
  shows through behind the transparent window, and the service panel's
  windows paint #1c1713 natively with `color-scheme: dark`.
- **Do** keep every control visible on the service panel — one scrolling
  faceplate with a printed index; the index navigates, it never hides.

### Don't:

- **Don't** cast a shadow anywhere — soft shadows band and halo on the
  transparent overlay, and the service panel keeps the same physics: panels
  are machined in, never floated (The Depth-Is-Inset Rule).
- **Don't** paint the written tape in lamp red — the trace is muted Oxide;
  saturated red belongs to the REC lamp, the backlit STOP key, and a hotkey
  field mid-capture (The Oxide-Is-Material Rule).
- **Don't** show the filled recording lamp before samples flow — warming up
  is a hollow ring (The Filled-Lamp Contract).
- **Don't** remove keys that don't apply — unlit and inert in their slots,
  so the eject key never jumps (The Keys-Stay-In-Their-Slots Rule).
- **Don't** reintroduce the retired violet/rose "On-Air Lamp" palette — it
  exists nowhere in the product; every surface is Tape Transport.
- **Don't** set human prose in monospace — mono is for what the machine
  counts or executes: counters, timestamps, accelerators, version numbers,
  and the dictionary/prompt instruction wells (The Machine-Instructions
  Exception).
- **Don't** invite the user to talk before the mic is live — the card says
  "Starting mic…" until the first samples arrive.
