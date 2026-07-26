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
  key-edge: "rgba(255, 240, 214, 0.12)"
  rec: "#ff4438"
  busy: "#ffb03a"
  done: "#59c98a"
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
rounded:
  track: "2px"
  well: "6px"
  pill: "7px"
  key: "9px"
  note: "10px"
  card: "12px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
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
    backgroundColor: "#342a1e"
    textColor: "{colors.ivory}"
    rounded: "{rounded.key}"
    size: "34px"
  transport-key-stop:
    backgroundColor: "#3a1611"
    textColor: "#ffb4ac"
    rounded: "{rounded.key}"
    size: "34px"
  transport-key-stop-hover:
    backgroundColor: "#4a1b14"
    textColor: "#ffb4ac"
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
    backgroundColor: "#ffc262"
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
    backgroundColor: "rgba(255, 176, 58, 0.07)"
    textColor: "{colors.ivory}"
    rounded: "{rounded.note}"
    padding: "10px 12px"
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

The finish is flat matte throughout. The only glow in the world comes from
things that are lit — status lamps, the backlit STOP key, the playhead — never
from ambience. Depth is machined into the faceplate (inset wells, inset top
highlights), never cast under it: the overlay window is transparent, and a
drop shadow would band and halo against the desktop. Motion is mechanical
physics, not decoration: reels spin at different speeds, keys travel when
pressed, tape glides at a fixed write speed, and all of it collapses to
instant state changes under `prefers-reduced-motion`. Text is quiet system UI
silk-screened in ivory onto the faceplate; the machine's own numerals are
monospace.

Confirmed rejections, from the shipped overlay itself: no cast shadows on the
transparent window; no translucent surface under text (the faceplate is solid
so the written tape and the warm raw tail never depend on what shows through
behind the overlay); no category-standard pulsing-dot pill.

**Key Characteristics:**

- Interface as instrument: every state is a lamp, a reel speed, or a written
  trace — never an abstract spinner.
- Warm-black and oxide materials; saturated color exists only in lamps.
- Depth by inset: wells sink into the faceplate; nothing floats above it.
- Glow means lit: lamp blooms and key backlight are the world's only shadows.
- Honest state: the machine never claims to be listening before samples flow.

### Legacy note: the superseded "On-Air Lamp" system

The settings window and setup wizard (`renderer/settings.css`,
`renderer/wizard.css`) still ship the previous violet-black / rose "On-Air
Lamp" system and have not yet migrated. That system is superseded, not
current: new surfaces follow the Tape Transport world documented here;
settings and wizard carry the legacy system pending migration. Never blend
the two worlds on one surface.

## Colors

A warm-black machine built from browns, umbers, and ivory, with saturated
color reserved for four legended lamps.

### Primary

- **Rec Lamp Red** (#ff4438): the recording lamp — lit and pulsing only while
  audio is actually being captured, and as the tint of the backlit STOP key
  (fill #3a1611, glyph #ffb4ac, border rgba(255,68,56,0.5)). The lit REC
  legend reads in #ff958c.
- **Oxide** (#d29a5a): the signal written onto the tape, drawn at
  rgba(210,154,90,0.9) on the ribbon. Material, not a lamp: deliberately
  muted so the saturated red stays reserved.
- **Raw Warm** (#e7b57e): the freshly-written, not-yet-settled transcript
  tail — bright and warm off the head, cooling to ivory as cleanup settles it.
  Carries a faint warmth glow (text-shadow rgba(231,181,126,0.25)).

### Secondary

The remaining lamps of the fixed status vocabulary:

- **Busy Lamp Amber** (#ffb03a): the machine working — transcribing,
  cleaning, delivering — and the machine talking about itself (the update
  service note's lamp, its progress fill, and its primary pill, hover
  #ffc262). Lit BUSY legend reads in #ffc76e.
- **Done Lamp Green** (#59c98a): delivered. Lit DONE legend reads in #8fdcae.
- **Inert Warm Grey** (#9b9187): idle, error, or empty — a warm, deliberately
  unalarming unlit lamp.

### Neutral

The machine's materials, dark to light:

- **Recess Black** (#0f0c09): wells sunk into the faceplate — the tape window
  and the counter cell — and the reel hub windows.
- **Faceplate Black** (#1c1713): the card itself; warm black, solid so text
  never sits over the desktop.
- **Key Cap** (#2a2118): machined transport key caps (hover #342a1e), edged
  in **Key Edge** (rgba(255,240,214,0.12)).
- **Tape Umber** (#35291d): the ribbon the signal is written onto (the wound
  tape packs on the reels are the close sibling #3a2c1f).
- **Unlit Ivory** (#a89b88): unlit legends and secondary text; holds ≥4.5:1
  on Faceplate Black.
- **Reel Aluminum** (#b4a894): reel flanges and hubs, and the record head's
  shoe.
- **Silk-Screen Ivory** (#f2e9da): primary text and legends, printed onto the
  faceplate; also the hairline **Machine Edge** (rgba(255,240,214,0.14)) and
  every warm-white translucent detail (grip knurling, seams, head slit).

### Named Rules

**The Lamp Vocabulary Rule.** Status colors are a fixed legended vocabulary:
REC red = capturing, BUSY amber = working (or the machine talking about
itself), DONE green = delivered, inert warm grey = idle or fault. Never
repurpose a lamp color for decoration, and never invent a second color for a
meaning that already has a lamp.

**The Oxide-Is-Material Rule.** The written trace is Oxide — muted, material,
the take itself. Saturated red is reserved for the REC lamp and the backlit
STOP key. If the tape glows lamp-red, the lamp means nothing.

## Typography

**Display Font:** none — the machine has no display tier.
**Body Font:** system-ui (with -apple-system, "Segoe UI", sans-serif)
**Label/Mono Font:** ui-monospace (with "Cascadia Code", monospace)

**Character:** silk-screen printing on an instrument: small, quiet system UI
in ivory, with personality carried by weight, tracking, and the machine's own
monospace numerals — never by typeface.

### Hierarchy

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
  the lamp (REC/BUSY/DONE/PAUSE/ERR) — the only uppercase in the world.
- **Counter** (ui-monospace, 13px, 0.04em, tabular-nums): the take counter.
  Digits go to 45% opacity outside recording — still readable, clearly not
  running.

### Named Rules

**The Machine-Numerals Rule.** Anything the machine counts — the take
counter — is monospace with `font-variant-numeric: tabular-nums`, seated in a
recessed cell. Human words are never monospace.

## Layout

A fixed-size, frameless, transparent, bottom-anchored Electron window — the
window is the layout. Base size 500×95px; the card sits inside a 12px margin
and grows *upward* as the transcript or update note fills it (the main
process resizes the window instantly; the card eases its own height so
content slides rather than pops).

Card anatomy, top to bottom: knurled drag rail (44×5px, centered) → optional
update service note → live transcript → transport row. The transport row is a
fixed 46px strip inset 12px, gapped 8px: lamp block (30px) → supply reel
(30px) → tape window (flexes to fill — the hero owns all leftover width) →
take-up reel → counter cell (min 52×30px) → PAUSE → STOP → eject, with an extra 4px
gap isolating the destructive eject. The transcript's 16px side padding
shares one left edge with the machine below it. Update-note actions wrap to a
second line rather than squeeze; when the update arrives with no dictation
behind it, the transport row hides and the note is the whole card.

Spacing rhythm: 4 / 6 / 8 / 12 / 16px.

## Elevation & Depth

**The Depth-Is-Inset Rule.** The overlay window is transparent, and soft
shadows band and halo on transparent windows — so the card carries **no drop
shadow, ever**. Depth is machined *into* the faceplate instead: wells recess
(`inset 0 1px 3px rgba(0,0,0,0.55)`), edges catch light as inset top
highlights, and the card's lift comes from its solid surface and hairline
Machine Edge border. Every outward glow in the system is a *lit thing*, not
elevation.

### Shadow Vocabulary

- **Recessed well** (`box-shadow: inset 0 1px 3px rgba(0,0,0,0.55)`): the
  tape window and counter cell, sunk into the faceplate.
- **Machined edge** (`inset 0 1px 0 rgba(255,240,214,0.05–0.07)`): the inset
  top light on the card and every key cap.
- **Lamp bloom** (`0 0 9px 1px` in the lamp's color at 0.4–0.5 alpha; the
  service lamp `0 0 6px rgba(255,176,58,0.6)`): the material of a lit lamp.
- **Key backlight** (`0 0 10px rgba(255,68,56,0.35)`, hover 0.5): the STOP
  key while there's a take to stop — the machine telling you which key it
  expects.
- **Playhead glow** (`0 0 6px rgba(255,176,58,0.8)`): the 2px #ffe3b0
  playhead riding the progress fill's leading edge.

## Shapes

Machined rectangles on a tight radius scale: 12px for the faceplate card,
10px for the service note, 9px for key caps (12px on their invisible hit
halo), 7px for text pills, 6px for recessed wells, 2–2.5px for tracks and the
grip rail. Circles mean *rotation and light*: reels, hub windows, and the
11px status lamp. Borders are 1px warm-white hairlines (Machine Edge, Key
Edge); the record head is a 1px ivory slit with a 5×6px aluminum shoe riding
the well's top edge. Keys paint 34px but offer a ~42px hit area via an inset
−4px pseudo-element.

## Components

### Transport keys

- **Shape:** machined caps, 34×34px, 9px radius, Key Cap fill, Key Edge
  border, inset top light; glyphs are inline SVG in currentColor.
- **Hover:** surface warms to #342a1e (0.12s ease).
- **Press:** the key travels — `translateY(1px) scale(0.96)` at 0.08s.
- **Focus:** 2px Silk-Screen Ivory outline, offset 2px.
- **PAUSE (latching):** a quiet key in Unlit Ivory that latches a live take:
  while paused it sits pressed — sunk into the faceplate (Recess Black fill,
  deeper inset well, `translateY(1px)`) with an ivory glyph — and pressing it
  again resumes the same take. Inert (unlit, disabled for AT) whenever there
  is no live take to hold.
- **STOP (backlit):** #3a1611 fill, rgba(255,68,56,0.5) border, #ffb4ac
  glyph, red backlight glow — lit while there's a take to stop (a paused
  take still counts). Outside a take it goes unlit and inert (glyph at 22% ivory, pointer-events off,
  disabled for AT) but **stays in its slot**.
- **Eject (cancel):** a standard key with the eject glyph in Unlit Ivory,
  warming to ivory on hover; offset an extra 4px from STOP so the
  destructive discard is never hit by reflex.

**The Keys-Stay-In-Their-Slots Rule.** A machine doesn't remove its keys.
Keys that don't currently apply go unlit and inert — `visibility`/state, not
`display` — so neighboring keys never jump.

### Pills (service-note actions)

- **Style:** 26px-tall text buttons, 7px radius, 12px/600; primary filled
  Busy Lamp Amber with dark #241703 text (hover #ffc262); quiet variants
  transparent with Unlit Ivory text, hovering to an 8% ivory wash.

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
starts with the first samples, and its digits go unlit (45% opacity) outside
recording.

### Playhead progress

Overlaid along the bottom of the tape window (absolute — appearing never
changes card height): a 3px track in 12% ivory, Busy Lamp Amber fill easing
width at 0.15s linear, with the glowing #ffe3b0 playhead riding the leading
edge. A completed bar holds at 100% for 400ms — the phase's closing
statement — then hides. The update note reuses the same track/fill grammar.

### Update service note

The machine talking about itself: a note pinned to the faceplate above the
transcript, 10px radius, amber-washed (rgba(255,176,58,0.07) fill,
rgba(255,176,58,0.35) border), led by a 7px amber service lamp with bloom.
Its amber marks it as self-referential — the REC/DONE vocabulary below
belongs to the dictation. Actions are pills; the two "stop bothering me"
exits are grouped so they wrap together.

### The Overlay Strip (signature)

The whole system in one 500px-wide strip: solid Faceplate Black card, 12px
radius, Machine Edge hairline, machined top light, no cast shadow, pinned to
the bottom of the screen and never stealing focus. Knurled grip rail up top
(the card is the drag surface; the rail is the cue), live transcript growing
upward, and the transport row along the bottom. It enters by its own fade —
opacity + 8px rise + 0.98 scale over 0.2s — because the window can't ease.

## Do's and Don'ts

### Do:

- **Do** keep the lamp vocabulary fixed: REC red capturing, BUSY amber
  working or self-referential, DONE green delivered, inert warm grey for
  idle/fault (The Lamp Vocabulary Rule).
- **Do** express depth by inset — recessed wells (`inset 0 1px 3px
  rgba(0,0,0,0.55)`) and inset top lights — and reserve outward glow for lit
  things: lamp blooms, key backlight, the playhead.
- **Do** keep motion mechanical and honest: 0.12s ease for key/surface
  states, 0.08s key travel, 0.15s linear progress, 0.18s card height,
  0.2s card entrance; reels pause (keeping their angle) rather than reset;
  collapse everything under `prefers-reduced-motion` while still updating
  state.
- **Do** paint 34px keys but offer ~42px hit areas (inset −4px
  pseudo-element), and isolate destructive keys with extra gap.
- **Do** set machine numerals in monospace tabular-nums, and dim (never
  hide) readouts that aren't running.
- **Do** keep the faceplate solid; text and tape must never depend on what
  shows through behind the transparent window.

### Don't:

- **Don't** cast a shadow on the overlay card — soft shadows band and halo on
  transparent windows; depth is inset, never cast (The Depth-Is-Inset Rule).
- **Don't** paint the written tape in lamp red — the trace is muted Oxide;
  saturated red belongs to the REC lamp and the backlit STOP key (The
  Oxide-Is-Material Rule).
- **Don't** show the filled recording lamp before samples flow — warming up
  is a hollow ring (The Filled-Lamp Contract).
- **Don't** remove keys that don't apply — unlit and inert in their slots,
  so the eject key never jumps (The Keys-Stay-In-Their-Slots Rule).
- **Don't** blend worlds: settings/wizard carry the legacy On-Air Lamp
  system pending migration; new surfaces are Tape Transport only, and no
  surface mixes the two palettes.
- **Don't** invite the user to talk before the mic is live — the card says
  "Starting mic…" until the first samples arrive.
