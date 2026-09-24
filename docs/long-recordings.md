# Long recordings: why built-in speech is decoded one utterance at a time

A long dictation used to reach the built-in speech engine as one buffer in two
cases: when the live preview's snapshot was unusable (a chunk failed, or heard
speech and decoded nothing), and when no chunk had committed yet. That broke
two ways:

- **Words went missing** (#168). The shipped model, Parakeet TDT 0.6B v3
  int8, kept 0.839 of the words over 124.5 s and 0.449 over 310.9 s.
- **The engine died** (#169). Under Electron's `utilityProcess` the STT
  worker exited on any single buffer over ~163 s. The dictation was lost.

Both are fixed by
[`main/chunked-decode.js`](../main/chunked-decode.js): every built-in decode,
final and live preview alike, is split at the pauses in the speech (and never
longer than 20 s), decoded one piece at a time, and joined. This page records
the evidence behind that design. The harness is
[`scripts/eval-long-decode.js`](../scripts/eval-long-decode.js); its gate is
pinned by `test/eval-long-decode.test.js`.

Measured 2026-09-22 on an **AMD Ryzen 9 3900X (24 logical threads), 60 GB RAM,
Linux 6.17**, Electron 42.4.1, sherpa-onnx-node 1.13.3, 8 decode threads (the
app's), through the app's own engine worker.

## Result

The default model on FLEURS en_us recordings: distinct sentences from one
speaker, 300 ms apart. Each recording is held to its own sentences decoded one
clip at a time (the short-clip WER below; the whole 647-clip corpus gives
6.07 % with `scripts/eval-stt.js`). The gate is word ratio ≥ 0.95 and WER no
more than 3 points above that baseline.

| audio | short-clip WER (gate) | one buffer (before) | pauses + 20 s cap (now) | worker decode time, before → now |
| --- | --- | --- | --- | --- |
| 124.5 s | 4.5 % (≤ 7.5 %) | ratio 0.839, WER 20.6 % | **ratio 1.016, WER 6.8 %** (38 pieces, longest 9.6 s, 1 accepted empty) | 8.9 s → 7.0 s |
| 182.9 s | 4.4 % (≤ 7.4 %) | worker exits (code 133) | **ratio 1.017, WER 6.9 %** (54 pieces, longest 13.0 s, 2 accepted empty) | — → 10.1 s |
| 310.9 s | 6.2 % (≤ 9.2 %) | worker exits (code 133) | **ratio 1.013, WER 8.2 %** (87 pieces, longest 14.7 s, 4 accepted empty) | — → 18.1 s |

"Accepted empty" pieces heard sound the speech probe calls speech but decoded
to nothing even with silence around them (see below); in these runs they were
breaths and clicks after finished sentences.

After each run, the same worker answered a short decode, so it survives.

## Why pauses, not just a shorter buffer

The first plan was to cap each decode at 60 s. That fixes the crash but not the
lost words, and a smaller cap doesn't fix them either:

| audio | cap 20 s, no pause cuts | cap 60 s, no pause cuts |
| --- | --- | --- |
| 124.5 s | ratio 0.862, WER 16.7 % | ratio 0.621, WER 39.5 % |
| 182.9 s | ratio 0.871, WER 16.2 % | ratio 0.551, WER 46.6 % |
| 310.9 s | ratio 0.837, WER 21.4 % | ratio 0.534, WER 49.8 % |

The loss is not about length. It happens at the boundary between utterances.
Two sentences that each transcribe correctly on their own come back as only
one of them when joined in one 10.5 s buffer. Joined with a 300 ms gap, they
come back as nothing at all:

| buffer | int8 (shipped) | fp32 |
| --- | --- | --- |
| A alone (4.6 s), B alone (5.6 s) | both correct | both correct |
| A + 300 ms + B | **"" (nothing)** | both sentences |
| A + 1 s + B | only A | both sentences |
| B + 300 ms + A | only B | both sentences |

A longer buffer holds more such boundaries, which is why the loss grows with
length. The fp32 model survives that pair, but it also loses words over long
buffers: 0.772 on one 124.5 s buffer, and 0.79–0.88 with 60 s pieces. Only
pieces of ≤ 20 s pass. So switching models would not fix this (and fp32 is a
3.8× larger download). Decoding one utterance at a time works, and it works
with the shipped model.

How short a pause counts. The clips' own leading and trailing silence was
trimmed and the sentences joined with shorter gaps; cut with the shipped
`splitPoints` at each threshold. Plain Node, int8, ~165 s:

| gap between sentences | cut at pauses ≥ 150 ms | ≥ 200 ms (shipped) | ≥ 250 ms |
| --- | --- | --- | --- |
| 150 ms | ratio 1.017, WER 6.2 % | 1.015, 6.2 % | 0.979, 9.1 % |
| 250 ms | ratio 1.023, WER 7.3 % | 1.023, 6.9 % | 1.023, 6.7 % |
| 400 ms | ratio 1.029, WER 7.1 % | 1.021, 6.0 % | 1.017, 5.4 % |

On the recordings above, 150 ms also cut inside sentences often enough to
leave fragments the model decodes to nothing: 3 such pieces in 124.5 s (WER
10.9 %) against 1 at 200 ms (6.8 %); 6 against 4 in 310.9 s (9.6 % vs 8.2 %).
So a pause counts from 200 ms. "Quiet" is the overlay's own silence level
(RMS < 0.012 after auto gain control), scored with a 50 ms window sliding in
5 ms steps, so a pause's length decides and its alignment doesn't: 200 ms is
always a cut, 180 ms never. The cut goes to the middle of the pause. Speech
that runs past 20 s without a pause is cut at the quietest moment in the 10 s
before the ceiling, using the same search the overlay uses for its forced
chunk boundaries (`renderer/chunk-boundary.js`).

The live preview's chunk decodes use the same splitter. Their committed text
becomes the start of the final transcript verbatim, and a 10–20 s chunk often
holds two sentences: the exact case above. If a live chunk decodes only in
part, the decode throws. That breaks the snapshot, so the final pass decodes
the audio again instead of committing a hole.

**What this doesn't cover.** A speaker who never pauses for 200 ms (or a room
too noisy to reach the silence level) gets 20 s pieces only. That is the
0.84–0.87 column above. FLEURS is read speech with clean gaps, not dictation
through Earheart's microphone path.

## When the worker dies anyway

Pieces are decoded from the main process, so a finished piece is text that
survives a worker crash on a later one. A piece whose worker exited or timed
out is retried once on a fresh worker. If it still fails, it is skipped and
the rest continue. After two pieces in a row fail because the worker died,
the rest are not tried. A piece that holds audible speech (by the overlay's
own speech probe, `renderer/speech-probe.js`) but decodes to no text is
decoded once more with 250 ms of silence around it (less when that would
pass the 20 s cap; none, and no retry, for a piece already at the cap). In the lab that rescued
the words lost that way; what still came back empty were breaths and clicks
after finished sentences, which the probe (biased toward "speech" on
purpose) also calls speech. Checked against each sentence decoded alone
with token timestamps, none of those pieces held a word missing from the
final transcript; all were 0.7–1.2 s long. So a still-empty piece of up to
2 s (`EMPTY_SPEECH_MAX_SEC`) is accepted as empty, logged with its range and
length, and — like a failed piece — filled from a broken live-preview
snapshot's chunk over it (see below), without marking the result
incomplete. A longer one is too long to be a breath: it counts as lost, and
the dictation is marked incomplete. The same happens when nothing in the
recording decoded at all: the live preview's words or an error follow,
never a silent empty result. The limit: a missed utterance of 2 s or less
still isn't reported.
Whatever was recovered is delivered: the committed live-preview text and the
finished pieces. With a broken snapshot, its committed chunks' boundaries are
cut points of the final pass too, so each chunk covers whole pieces; a chunk
over a piece that failed stands in for every piece under it, so its words are
neither lost nor repeated. It goes through
the normal cleanup and paste, with a notification ("transcription
interrupted"). The overlay's done card says "— incomplete" and the History
entry is marked `incomplete: true` and shows it, so the dictation is still
identifiable once the notification is gone. Only a run
that recovers nothing at all is an error. Engine failures carry stable codes
(`ENGINE_EXITED` with the process exit code, `ENGINE_TIMEOUT`).
`engines.restartStt()` retires a wedged STT worker without touching cleanup.

## Why the worker died (#169)

**Diagnosis: the worker crashes when ONNX Runtime asks for its first 1 GiB
block.** That happens on any single buffer over ~163 s.

- Electron's exit code is **133 = 128 + SIGTRAP**. That is how Chromium's
  deliberate `IMMEDIATE_CRASH` shows up (CHECK failures, allocator
  out-of-memory). The kernel's OOM killer would show SIGKILL (137). The host
  has 60 GB, and plain Node decodes the same buffers without trouble.
- Bisected through the app's host: **162 s decodes, 165 s exits.**
- In plain Node, `strace -e mmap` gives the largest single allocation during
  the decode. It grows in powers of two, the way ORT's arena extends: 256 MiB
  at 20–60 s, 512 MiB at 120–162 s, **1 GiB from 165 s**. The 1 GiB request
  appears at exactly the length where the Electron worker starts dying.
- Electron routes the utility process's `malloc` through Chromium's allocator
  rather than glibc. The likely mechanism is that allocator refusing the
  1 GiB request and crashing. That last step is inferred: no native stack was
  captured (`ELECTRON_ENABLE_STACK_DUMPING` printed nothing for the utility
  process).

A piece of ≤ 20 s peaks at 256 MiB, a quarter of the size that crashes.

## Reproduce

Build the corpus and model cache once (outside the repo), then run the
measurement:

```sh
xvfb-run -a npx electron scripts/eval-stt.js --no-sandbox --pass accuracy \
  --models parakeet-tdt-0.6b-v3-int8 --keep --cache-dir <cache> --out <acc.json>

# before/after table (exit 1 if a pieces run misses the gate)
xvfb-run -a npx electron scripts/eval-long-decode.js --no-sandbox \
  --cache-dir <cache> --out <run.json> --single
# cap-only table
xvfb-run -a npx electron scripts/eval-long-decode.js --no-sandbox \
  --cache-dir <cache> --out <run.json> --no-pauses --caps 20,60
# another model (download it into <cache> first)
… --model parakeet-tdt-0.6b-v3 --single --caps 20,60 --no-pauses
```

On macOS and Windows, drop `xvfb-run -a`. The two-sentence pair is FLEURS
sentences 10 and 11 of the 120 s recording ("The governor's office said…",
"In some areas boiling water…"). The pause-threshold and allocation numbers
come from short lab scripts over the same cache (plain Node,
`sherpa-onnx-node` directly). The allocation numbers use `strace -f -e
trace=mmap`.
