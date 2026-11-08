# Double-tap activation

Off by default. Under Settings → General → **Hotkey activation**, choose
*Double-tap to start* to start hands-free dictation with two quick presses of
the record hotkey instead of one.

| Situation | Behaviour |
| --- | --- |
| Two presses within the **double-tap window** while idle | Starts one dictation, about 0.12 s after the second press |
| One press while idle | Nothing |
| One press while dictating | Stops at once (no delay) |
| Key held down | Auto-repeat never latches; the key is ignored until it has been quiet for 0.3 s |
| Second tap still held when the dictation starts | The held key's repeats don't stop it; stopping is ignored for 0.7 s after a latch |

The window defaults to **500 ms** and can be set from 250 to 1000 ms
(Settings → General), so people who need more time between taps can have it.

## How it works

Electron's `globalShortcut` reports key-down only: no key-up, and a held key
repeats the callback. The recognizer (`main/double-tap.js`) therefore uses press
timestamps alone: presses closer than 100 ms are auto-repeat, and after the
second press it waits `SETTLE_MS` (120 ms) with no further press before it
starts. Pending state is reset on every pipeline state change and settings
save, and cancelled on quit. True hold-to-talk would need a native key hook
and is out of scope.

## What follows the mode

Only the record hotkey and `earheart --tap` follow the activation mode. The
tray menu and `earheart --toggle` always toggle, and pause/discard are
unaffected. Switching mode mid-dictation never strands a recording: a single
press stops in either mode.

## Platforms

- **Windows, macOS, Linux/X11**: the built-in hotkey works as above.
- **Wayland** (where apps can't grab global keys): bind a system shortcut to
  `earheart --tap`. Each launch is timestamped when it reaches the running app,
  but process-spawn time adds jitter, so raise the window if double taps are
  missed.
