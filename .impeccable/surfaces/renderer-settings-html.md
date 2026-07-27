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

**Chosen direction (committed 2026-07-26, seed d6f88d13, migrates both surfaces
off the retired On-Air Lamp system):** **The service panel** — one continuous
Tape Transport faceplate read top to bottom (no hidden tab panels), with a
sticky printed index on the left whose amber lamp tracks the section under the
read head (scroll spy; glide on click, collapsed under reduced motion; the
index docks horizontally under 600px). Instrument-quiet grammar: machined group
panels (hairline ivory edge + inset top light, never cast shadows), inputs as
recessed wells, key-cap buttons with press travel, aluminum switch slugs, the
amber-backlit Save key, silk-screened uppercase section legends (10px/700/0.1em
— the only uppercase besides lamp legends), REC-red armed state on
hotkey-capture fields, amber service wash for selection, DONE-green/STOP-red
status text, machine values (accelerators, timestamps, version) in 13px/11px
mono. The wizard reuses all of it; its welcome demo is a miniature of the real
tape deck (lamp, dashed-ring reels, oxide signal, backlit mini stop), and its
step dots are lamps.

**Memorable moment:** the printed index lamp sliding section to section as the
panel glides — and the wizard's miniature deck already recording.

**Constraints:** settings.js/wizard.js drive everything by element id and
radio-group name (contract-tested); CSP forbids inline styles; `[hidden]` must
win; all copy preserved verbatim; keyboard-first (roving-tabindex index, arrows
both axes, ivory focus rings); prefers-reduced-motion collapses glide, lamps,
reels; windows paint `#1c1713` before load (windows.js backgroundColor).

**Resolved at finish:** progress fills use the world's `width 0.15s linear`;
sliders use the light-track grammar (a dark recessed channel vanishes at 4-8px
heights); em-dash-heavy copy is the product's incumbent voice, kept.

**Unresolved:** none for this surface; tray menu remains unstyled platform UI.
