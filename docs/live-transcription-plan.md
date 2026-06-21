# Live transcription plan

Adding real-time ("type as you talk") transcription to earheart.

Today the flow is batch-only: you press the hotkey, speak, stop, and only then
does any text appear. This plan adds a live transcript that fills in *while you
speak*, in two phases — first a preview in the overlay, later keystrokes into
the focused app.

## Why this isn't a flag

The current pipeline is whole-file by design:

- The overlay buffers all audio in a `chunks[]` array and only encodes a WAV +
  ships it on stop (`renderer/overlay.js:148`, `audio:captured`).
- Both STT backends are whole-file. The builtin engine uses sherpa-onnx's
  `OfflineRecognizer` with Parakeet-TDT (`main/engines/engine-worker.js:57`),
  decoded in one shot. The HTTP path POSTs a complete WAV to
  `/audio/transcriptions` (`main/services/stt.js:29`). Parakeet-TDT is an
  *offline* model — it has no native streaming decoder.

So "stream as I talk" requires either re-transcribing a growing buffer
(Phase 1) or a genuinely streaming-capable recognizer (Phase 2).

## Scope decisions (already made)

- **Target UX:** live preview now, in-app keystrokes later.
- **Engine path:** builtin (in-process, private) Parakeet only. The HTTP /
  server path and a server-streaming endpoint are explicitly out of scope.

## Architecture recap

```
hotkey ─▶ pipeline.toggle()                         (main/pipeline.js:95)
            │
   overlay records mic, buffers chunks[]            (renderer/overlay.js:113)
            │  on stop: encodeWav() ─▶ audio:captured
            ▼
   pipeline.process(): transcribe ─▶ cleanup ─▶ deliver   (main/pipeline.js:144)
            │
   builtin engine, utilityProcess worker            (main/engines/engine-worker.js)
```

- **Main process** orchestrates the pipeline and owns engine state.
- **Overlay renderer** owns the microphone and the UI pill.
- **Engine workers** (`utilityProcess`) run sherpa-onnx STT and Gemma cleanup off
  the main thread. *Today this is a single shared worker* (`engine-worker.js`
  hosts both engines, `host.js` routes to one child); Phase 1 splits this into
  two workers — one for STT, one for cleanup — so they run in parallel (see the
  "Split the engine worker" change below).
- IPC channels are whitelisted in `preload.js:5-42` — any new channel must be
  added there or it is silently dropped.
- Every dictation has a session id (`session`, `main/pipeline.js:38`) echoed in
  overlay messages; events from a stale session are ignored.

---

## Phase 1 — Live preview (chunked, append-only)

> **Superseded note:** this section originally described re-decoding the *whole*
> buffer every tick. That shipped, but measurement showed it's O(n²): decode time
> grew with total length (1.7s at 30s, 6.3s at 73s), crossed the tick interval at
> ~21s, and crashed the app after ~30s. It was replaced with **append-only
> chunking** — the overlay ships audio in ~5s chunks, each transcribed once and
> accumulated; only the in-progress chunk is re-decoded, so decode cost stays flat
> (~370ms per chunk regardless of dictation length). Cleanup, by contrast,
> re-cleans the *whole* committed transcript on each pause and replaces the cleaned
> line — `clean(a)+clean(b)` reads differently from `clean(a+b)`, so cleaning the
> whole thing is what makes the live cleaned line track the authoritative final
> clean. It's O(n) but pause-gated and drop-if-busy, so it stays cheap. The
> two-layer display and lifecycle below are unchanged.

Keep Parakeet offline. While recording, the overlay ships the audio of the
current in-progress chunk; the main process transcribes it and accumulates a
committed transcript, pushing the partial **raw** transcript back to the overlay.
On speech pauses after a chunk commits, the main process re-cleans the **whole
committed transcript** and replaces the partial **cleaned** transcript with the
result. The overlay shows both as two layers (see below). On stop, the existing
final pass (+ cleanup + deliver) runs unchanged over the whole authoritative audio.

No new model, no new dependency, fully private, reuses the whole pipeline.

### Two-layer live display

The overlay shows two stacked layers so the fast-but-jittery raw text and the
slower-but-calm cleaned text don't fight each other:

```
The quick brown fox jumps              ← cleaned (main line, settled)
                          over the lazy umm dog   ← raw tail (faint, still streaming)
```

- **Cleaned line (main, prominent):** the latest cleaned transcript. Updates
  only when a cleanup pass completes, so it changes in calm chunks.
- **Raw tail (faint, trailing):** the portion of the raw transcript *past* the
  end of the cleaned text — i.e. what's been heard but not yet cleaned. Updates
  every raw tick, keeping pace with the voice. As cleanup catches up, the tail
  shrinks and the cleaned line grows.

The two layers are reconciled by prefix: the raw tail is `raw` with the
already-cleaned span removed. Because cleanup runs over the *full* raw text each
time (not per-segment), the cleaned line is internally coherent and re-cleaning a
stable prefix yields stable output, which keeps the main line from flickering.

### Changes

1. **`renderer/overlay.html`** — add a live-transcript element under the meter
   with two layers: a prominent **cleaned** line and a faint **raw tail** that
   follows it inline. Empty until the first partial arrives.

2. **`renderer/overlay.js`**
   - Alongside the existing meter rAF loop, add a partial timer (~1.2 s) that,
     while `recording` is set, calls `encodeWav(recording.chunks)`
     (`overlay.js:81`) and sends `audio:partial { sid, wav }`.
   - Stop and clear the timer in `teardown()` (`overlay.js:185`) so it never
     outlives a session.
   - Handle `pipeline:partial { kind, text }` where `kind` is `"raw"` or
     `"cleaned"`: update the raw tail or the cleaned line respectively, then
     re-derive the tail as `raw` minus the cleaned prefix so the two layers stay
     reconciled. Clear both on `record:start` and on the final `done` status
     (the delivered transcript supersedes the preview).
   - Gate the whole thing on a `livePreview` flag passed in `record:start`
     (see settings below) so it's off-path when disabled.

3. **`preload.js`** — whitelist `audio:partial` (send, overlay → main) and
   `pipeline:partial` (listen, main → overlay) in the channel lists
   (`preload.js:5-42`).

4. **`main/pipeline.js`**
   - Add an `ipcMain.on("audio:partial", …)` handler in `init()`
     (`pipeline.js:209`). It must:
     - **Session-guard:** ignore if `sid !== session` or `state !== "recording"`.
     - **Drop-if-busy (STT):** keep a `partialInFlight` flag; if a previous
       partial decode hasn't returned, skip this one entirely (no queue — we only
       care about the latest audio, and queueing would lag further behind real
       time).
     - Run `runTranscribe(wav, cfg.stt, partialSignal)` on a **separate abort
       scope** from `process()`'s `abortController`, so a partial decode never
       collides with or cancels the final transcription.
     - On success, store the latest `raw` partial and, if still the same session
       and still recording, send `pipeline:partial { kind: "raw", text }` to the
       overlay via `windows.sendToOverlay`.
     - Swallow errors silently (a dropped partial is cosmetic; never surface it
       as a pipeline error).
   - **Partial cleanup (pause-triggered, full-text).** Track the latest raw
     partial and whether it grew since the last tick. When the raw text has been
     **stable for ~1 s** (a speech pause), and cleanup is enabled and not already
     in flight, run `runCleanup(latestRaw, cfg.cleanup, …)` over the **full** raw
     transcript (not a segment) on its own abort scope, and send
     `pipeline:partial { kind: "cleaned", text }`. Cleaning the whole text each
     time keeps punctuation coherent across pauses and is idempotent on stable
     prefixes, so the cleaned line stays calm. Same drop-if-busy discipline as
     STT; a cleanup in flight blocks a new one.
   - Pass the `livePreview` flag into the `record:start` payload in
     `startRecording()` (`pipeline.js:113`).
   - In `process()` (`pipeline.js:144`), cancel/ignore any in-flight partial
     **decode and cleanup** before the final transcribe + cleanup so they don't
     overlap on the single-instance engine worker.

5. **Split the engine worker into two (`host.js`, `index.js`).** Today a single
   `utilityProcess` hosts both engines and serializes every request, so partial
   STT and partial cleanup would block each other. Run them in **two separate
   workers** so the raw tail (STT) and the cleaned line (cleanup) decode in
   parallel.
   - **`engine-worker.js`** — no change. It already handles both engine types via
     its `HANDLERS` map; we just fork it twice and only ever send STT requests to
     one instance and cleanup requests to the other.
   - **`main/engines/host.js`** — convert the module-level singleton (`child`,
     `nextId`, `pending`, `exitListeners`) into a `createHost({ serviceName })`
     factory returning an instance with the same `{ request, stop, onExit }`
     surface. Each instance owns its own child and lazily forks on first
     `request` (the existing `spawn()` behavior, unchanged).
   - **`main/engines/index.js`** — hold two host instances, `sttHost` and
     `cleanupHost`; route `load-stt`/`transcribe`/`unload-stt` to the first and
     `load-cleanup`/`clean`/`unload-cleanup` to the second. Split `forgetLoaded`,
     `unloadIdle`, `stop`, and the `onExit` hook so each worker's lifecycle is
     independent (e.g. unload the heavy LLM while keeping the STT recognizer
     warm). **Lazy spawn:** because each host forks on first request, a
     batch-only user who never triggers cleanup never spawns the 2nd worker;
     streaming users get full parallelism.
   - Within each worker, requests are still serialized, so the drop-if-busy rule
     still applies *per stage* (don't pile up STT partials; don't pile up cleanup
     passes) — but STT and cleanup no longer block each other, and a crash in one
     worker no longer takes down the other.

6. **`main/settings.js`** — add `stt.livePreview` (default decided below). Surface
   it in Settings (`renderer/settings.*`) as a toggle.

### Guardrails

- **Cost grows with utterance length.** The offline recognizer re-decodes the
  *entire* buffer each tick, so a 60 s dictation re-decodes ~60 s of audio every
  1.2 s near the end. Cap it: stop issuing partials past a threshold
  (e.g. 30 s) and leave the last partial on screen with a "still listening…"
  hint, or scale the interval up as the buffer grows. Decide the threshold
  before coding.
- **Two workers, serialized within each.** STT and cleanup now run in separate
  workers, so they no longer block each other — the raw tail and the cleaned line
  decode in parallel. *Within* each worker requests are still serial, so the
  drop-if-busy rule still applies per stage (don't queue STT partials; don't
  queue cleanup passes). Before the final pass, cancel/ignore the in-flight
  partials in *both* workers so they don't overlap the authoritative final
  transcribe + cleanup. Verify a partial in flight at stop doesn't delay the
  final result.
- **Pause-triggered, full-text cleanup.** Cleanup runs over the *entire* raw
  transcript on each pause, not per-segment — a long pause is not a sentence end,
  so segmenting would corrupt punctuation. The pause trigger doubles as the
  throttle: it keeps full-text cleanup from running every tick, which is what
  makes repeatedly cleaning a growing transcript affordable. Tune the
  stability window (~1 s) so normal mid-sentence pauses don't fire it constantly
  on long dictations.
- **Default off vs. on.** Live preview adds steady CPU load while recording.
  Lean toward defaulting it **on** for short dictations but make the toggle
  prominent; revisit after measuring decode latency on the default model.

### Done when

- Speaking shows a faint raw tail in the overlay within ~1–2 s that keeps pace
  with your voice.
- On pauses, the cleaned main line fills in behind the raw tail and the tail
  shrinks, without the main line flickering.
- Stopping still produces the same final, cleaned, delivered text as today — the
  preview is purely additive and the batch path is untouched on the happy path.
  The final delivered text should closely match the last cleaned preview (a
  nice-to-have signal that streaming cleanup is faithful).
- Toggling `stt.livePreview` off restores exactly the current behavior (no
  `audio:partial` traffic, no partial cleanup).
- Cancelling mid-dictation tears down the partial timer and drops any in-flight
  partial decode and cleanup.

---

## Phase 2 — Keystrokes into the focused app (later)

The real "type as you talk" experience: words appear directly in whatever app
has focus as you speak. This is a larger change and is deliberately deferred;
Phase 1's `pipeline:partial` IPC and the overlay live-text element carry over as
scaffolding.

### Sketch

- **Streaming recognizer.** Add sherpa-onnx `OnlineRecognizer` with a
  streaming-capable model (e.g. a streaming Zipformer) in
  `engine-worker.js`, alongside the existing offline recognizer. The overlay
  feeds PCM frames continuously (the worklet already produces frame chunks,
  `overlay.js:148`) instead of re-encoding whole WAVs; the worker runs the
  `acceptWaveform` → `isReady` → `decode` → `getResult` loop with endpoint
  detection.
- **Keep Parakeet for the final pass.** Streaming models are generally less
  accurate than offline Parakeet-TDT. Use the streaming model for the live
  preview/keystrokes and still run Parakeet once on stop for the authoritative
  transcript (then reconcile). This means two models resident — account for the
  memory and the idle-unload logic (`pipeline.js:55`).
- **Incremental injection.** Extend `main/output/deliver.js` with a mode that
  types committed words into the focused app as they stabilize and reconciles
  when a partial is revised (backspace/replace). This is the fiddly part —
  cursor races, undo stacks, and the interaction with the final cleanup pass
  (which rewrites text the user already saw typed) all need handling.

Decide Phase 2's exact shape after Phase 1 ships and the live-preview UX is
validated.

---

## SWOT analysis

A structured read on this plan (Phase 1 first, Phase 2 deferred).

### Strengths

- **Zero new dependencies or models in Phase 1.** Rolling re-transcribe reuses
  the existing offline Parakeet engine and the whole pipeline — small, reviewable
  diff, nothing to download.
- **Stays private and offline.** No server, no network — preserves earheart's
  core "no audio leaves your machine" promise.
- **Purely additive on the happy path.** The batch record → transcribe → clean →
  deliver flow is untouched; live preview is layered on top and gated behind a
  toggle, so the failure mode degrades to today's behavior.
- **Stateless partials.** `transcribe` already creates a fresh stream per call
  (`engine-worker.js:80`), so repeated whole-buffer decodes need no engine
  change and carry no cross-call state to corrupt.
- **Reusable scaffolding.** The `pipeline:partial` IPC and overlay live-text
  element built in Phase 1 carry straight into Phase 2.
- **Worker split is a standalone win.** Separating STT and cleanup into two
  workers buys true parallelism *and* crash isolation (a native crash in one
  engine no longer kills the other) and independent idle-unload — improvements
  that hold even apart from streaming.

### Weaknesses

- **Not true streaming.** Phase 1 re-decodes the *entire* buffer each tick, so
  cost grows with utterance length and latency is the decode time of the whole
  clip — fine for ~15–30 s, sluggish for minutes.
- **Engine layer refactor.** Splitting the single worker into two (host factory,
  two instances, per-worker lifecycle) touches the whole engine facade
  (`host.js`, `index.js`). Modest and well-contained, but it's net-new plumbing
  that the batch-only path didn't need.
- **Higher *peak* resource use under streaming.** Two workers, and during
  streaming both models now work *simultaneously* rather than time-slicing one
  CPU. Parallelism trades latency for peak CPU + RAM pressure — material on
  laptops, the primary platform. (Lazy spawn keeps batch-only users unaffected.)
- **Cleaned preview can still revise.** Streaming cleanup makes the preview match
  the final closely, but the cleaned line still updates in chunks as cleanup
  catches up, so earlier cleaned text can change when later context arrives. The
  two-layer display contains this (it's expected on the main line) but it isn't
  zero-jitter.

### Opportunities

- **Validate the UX cheaply.** Phase 1 answers "does seeing partials actually
  feel good?" before committing to the much larger Phase 2 work.
- **Natural path to keystroke injection.** If the preview lands well, Phase 2
  (streaming recognizer + in-app typing) is the marquee feature competitors
  (Wispr Flow, etc.) charge for.
- **Settings surface for tuning.** The `stt.livePreview` toggle + interval/length
  caps become knobs users can tune to their hardware.
- **Informs a future streaming model choice.** Real-world partial-latency data
  from Phase 1 guides which streaming model to pick in Phase 2.

### Threats

- **Decode latency may be too high to feel "live."** If a whole-buffer decode on
  the default int8 model takes >1–2 s on typical hardware, the raw tail lags
  enough to feel broken rather than real-time — the core risk to Phase 1.
- **Cleanup may not keep up.** Gemma 1B cleaning a growing full transcript on
  every pause may fall far behind on long dictations, leaving a large faint raw
  tail and a stale cleaned line. Mitigated by the pause trigger and by cleanup
  being allowed to lag, but worth measuring alongside decode latency.
- **Phase 2 accuracy regression.** Streaming models are less accurate than
  offline Parakeet-TDT; the two-model reconcile (live stream vs. final Parakeet)
  is complex and can surface visible corrections.
- **Incremental injection is genuinely hard.** Cursor races, undo stacks, and the
  final cleanup rewriting already-typed text are real, fiddly failure modes in
  Phase 2.
- **Memory pressure in Phase 2.** Keeping a streaming model *and* Parakeet
  resident competes with the existing idle-unload logic (`pipeline.js:55`) and
  raises the app's footprint.

### Takeaway

Phase 1 is low-risk, high-information, and cheap to build — the right first move,
with the single make-or-break unknown being **decode latency on the default
model**. Measure that early (a quick timing harness on a representative clip)
before investing in the overlay UI; if it's too slow, raise the partial interval,
cap by length, or jump straight to evaluating a Phase 2 streaming model. Phase 2
carries the real engineering risk and should only start once Phase 1 proves the
UX is worth it.

## Out of scope

- **Server-streaming endpoint** (a WebSocket on `stt-server`). Only benefits the
  HTTP path; the builtin in-process engine — earheart's private default — would
  gain nothing, so it's excluded per the engine-path decision above.
- **Streaming the HTTP `/audio/transcriptions` client.** Same reason.
