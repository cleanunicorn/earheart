# Voice commands

Issue #344. A separate, explicit mode for **writing or rewriting by voice**:
say what to do ("make this friendlier", "write a two-line thank-you note"),
review the result, then replace the selection or copy it.

Ordinary dictation is unchanged and never turns into a command. Its cleanup
prompt still says the transcript is dictated speech, never instructions, and
nothing you say in a normal dictation is run as one. A command only starts from
its own entry points:

- the **Voice command hotkey** (Settings → General → Voice commands; unset by
  default)
- the tray item **Voice command…**
- `earheart --command` (bind it in your desktop settings where global hotkeys
  are blocked, such as Wayland)

Agent tasks, MCP execution, a spoken "send" grammar and per-app presets are
out of scope: this mode only produces text.

## How a command runs

1. **Capture.** Earheart sends Copy to the app that has the keyboard and reads
   the selection, then puts your clipboard back exactly as it was. With nothing
   selected (or a selection it can't read) the command **drafts** from your
   spoken brief instead, and the card says why.
2. **Speak.** The overlay records you with the same recorder and speech-to-text
   as dictation. Press the hotkey again (or **Finish speaking**) to stop.
3. **Transform.** The instruction and the selection go to the writing model:
   the Cleanup model on your computer by default, or a remote service you
   name. The prompt is its own ([`main/util/transform-turn.js`](../main/util/transform-turn.js));
   the cleanup prompt and its output budget are not involved.
4. **Review.** The card shows the selected text, what you said and the result.
   **Replace selection** pastes the result over the selection. **Copy** puts it
   on the clipboard. Nothing is pasted until you press a button.

The card never takes the keyboard (it is a non-focusable window), so the paste
lands in the app the selection came from.

## What can go wrong, and what happens

The spoken instruction is never pasted, and the selection is never replaced,
except by an explicit **Replace selection** of a complete result over an
unchanged target.

| Situation | Result |
| --- | --- |
| Nothing selected, selection unreadable, app refuses Copy | Drafts from the brief; the card says why |
| Hotkey keys still held when Copy would be sent | Capture refused ("release the hotkey's keys"), nothing is sent |
| macOS secure input active | Capture refused; nothing is read |
| Selection longer than 20,000 characters | Refused (never cut) |
| You cancel (the card at any stage, or the overlay while recording) | Everything stops; nothing is pasted; a late result is dropped |
| Speech not heard / speech service down | Card stays with your selection; **Speak again**. The take is not kept for a dictation retry |
| Model returns nothing, hits its length limit, or times out | Card keeps the selection and what you said; **Retry**; no Apply, no Copy of partial text |
| Focused window changed since capture | Replace is refused; Copy is offered |
| Selection in that window changed (re-read at Apply) | Replace is refused; Copy is offered |
| Window can't be identified (Wayland, probe failed) | Copy only |
| Paste tool fails or clipboard taken over | Result stays on the card; clipboard note shown |
| A new command starts | The previous one is cancelled; its card and late results are ignored (every action carries a command id) |

## Where the text goes

- **Local (default).** Selection and instruction stay on this computer. The
  local engine borrows the Cleanup model, so it must be downloaded (Settings →
  Cleanup). A long selection grows the model's context up to its limit; beyond
  that the command fails before generating.
- **Remote (explicit).** Settings → General → Voice commands → *A remote
  service I name here*. Your **selected text and what you say** are sent to
  that service, and only to it: there is no fallback to the Cleanup or
  Speech-to-text service. Requests use the same transport and plain-language
  errors as the other remote services. The API key is encrypted at rest like
  the others. The card says when a command used a remote service.
- **Speech.** What you say is transcribed by your Speech-to-text setting. If
  that is a remote service, the audio of your spoken instruction goes to it,
  exactly as in dictation.
- **Logs and History.** The selection, instruction and result are never
  logged, saved to History or counted in usage. Logs name only the stage and an
  error's own message.

## Platform capabilities

The commands depend on native keystrokes and window queries, which unit tests
and CI can't prove. This table is what the code does per OS, and what has been
verified.

| | Read the selection | Hotkey modifiers | Identify the window | Secure field | Replace selection |
| --- | --- | --- | --- | --- | --- |
| **macOS** | Cmd+C via System Events (needs Accessibility) | waits for release (AppKit, ≤1.5 s) | frontmost **app** only | detected (`IsSecureEventInputEnabled`) | yes, with the selection re-read at Apply to catch a different window in the same app |
| **Windows** | Ctrl+C via SendKeys | waits for release (`GetAsyncKeyState`, ≤1.5 s) | foreground window handle + process | **not detectable** | yes |
| **Linux X11** | Ctrl+C via `xdotool` (`--clearmodifiers`) | cleared by xdotool, plus a 250 ms wait | active window id (`xdotool`) | **not detectable** | yes |
| **Linux Wayland** | `wtype` or `ydotool` where the compositor allows | 250 ms wait only | **no** | **not detectable** | **no** (Copy only) |

Verification status for this change:

- Unit tests fake the tools and cover every decision above; `make command-smoke`
  drives the real card in Electron (no focus, text-only rendering, Apply/Copy
  rules, cancel, sender checks).
- **Not yet verified by hand on a real desktop:** the native Copy and paste
  paths on macOS, Windows, X11 and Wayland, that the card stays out of focus
  on each, and the macOS secure-input and modifier probes. Until each OS is
  checked, treat Replace as unproven there; Copy always works. The PR records
  which OSes were tried.

Password fields can't be detected outside macOS. Don't run a command with one
focused. The real safety nets are that Replace is always your click, and that
the card shows exactly what was read.

## Settings

Settings → General → Voice commands: the hotkey, the writing model (this
computer, or a remote service with URL, key and model), and **Let me replace the
selection from the result card** (turn off for Copy only). The output length and
timeout live in `settings.json` under `commands` (`maxOutputTokens` 64–8192,
default 1024; `timeoutMs` 5–600 s, default 120 s).

## Code map

| Piece | File |
| --- | --- |
| State machine, stale-id and race rules | [`main/commands/session.js`](../main/commands/session.js) |
| Selection capture, clipboard restore | [`main/commands/selection.js`](../main/commands/selection.js) |
| Per-OS keystrokes, window fingerprint, secure input | [`main/commands/platform.js`](../main/commands/platform.js) |
| Role-checked IPC | [`main/commands/ipc.js`](../main/commands/ipc.js) |
| Wiring, hotkey, local/remote routing | [`main/commands/index.js`](../main/commands/index.js) |
| Prompt and budget | [`main/util/transform-turn.js`](../main/util/transform-turn.js) |
| Remote client | [`main/services/transform.js`](../main/services/transform.js) |
| In-process engine op | `transform` in [`main/engines/engine-worker.js`](../main/engines/engine-worker.js) |
| Command take in the pipeline | `startCommandRecording` in [`main/pipeline.js`](../main/pipeline.js) |
| Card | [`renderer/command.html`](../renderer/command.html) |
