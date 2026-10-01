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
longer than 20 s), decoded one piece at a time, and joined. Dictation adds
hesitations and noise to that, which the splitter handles too ([Dictation:
hesitations and noise](#dictation-hesitations-and-noise)). This page records
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

| audio | short-clip WER (gate) | one buffer (before) | every pause + 20 s cap (v0.33.3–v0.34.1) | worker decode time, before → now |
| --- | --- | --- | --- | --- |
| 124.5 s | 4.5 % (≤ 7.5 %) | ratio 0.839, WER 20.6 % | **ratio 1.016, WER 6.8 %** (38 pieces, longest 9.6 s, 1 accepted empty) | 8.9 s → 7.0 s |
| 182.9 s | 4.4 % (≤ 7.4 %) | worker exits (code 133) | **ratio 1.017, WER 6.9 %** (54 pieces, longest 13.0 s, 2 accepted empty) | — → 10.1 s |
| 310.9 s | 6.2 % (≤ 9.2 %) | worker exits (code 133) | **ratio 1.013, WER 8.2 %** (87 pieces, longest 14.7 s, 4 accepted empty) | — → 18.1 s |

"Accepted empty" pieces heard sound the speech probe calls speech but decoded
to nothing even with silence around them (see below); in these runs they were
breaths and clicks after finished sentences.

This table is the cut-at-every-pause splitter as it shipped from v0.33.3. The
splitter that ships now also joins fragments and absorbs clicks, which did
better on these same recordings and left no accepted-empty pieces: see
[Dictation: hesitations and noise](#dictation-hesitations-and-noise).

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
always a pause, 180 ms never. The cut goes to the middle of the pause. (The
app then keeps a pause from being a cut when what it would cut off is a
fragment, and treats a click inside it as part of the pause — see
[Dictation: hesitations and noise](#dictation-hesitations-and-noise).) Speech
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
through Earheart's microphone path — which is what the next section is about.

## Dictation: hesitations and noise

Cutting at every pause was measured on read speech, and dictation is not read
speech. People stop mid-sentence to think, for longer than 200 ms, and the
room clicks, taps and breathes in the gaps. Each of those pauses was a cut, so
the model was handed fragments with no context: the word after a hesitation
on its own, half of a word, a keyboard tap. It decodes them badly in a way
cleanup can't repair, because cleanup is told never to guess words. A user's
History entry (v0.34.1) shows both:

> Okay, so Let me do this. USA You will I see. A You you you uh A Oh, Monaco
> winner. Meta. Alpex. So what Ever is it? Happening. Um Okay. …

Every capital mid-sentence ("Let", "Ever", "And", "But") is a piece start,
decoded alone; "whatever" was cut in two. "A", "You you you", "uh", "Oh" are
the kind of words the model makes up for a click or a breath.

Two changes in [`main/util/split-silence.js`](../main/util/split-silence.js),
turned on by [`main/chunked-decode.js`](../main/chunked-decode.js):

- **Noise is part of the pause.** Sound shorter than 0.15 s (in 5 ms window
  hops, so a real click of ~0.1 s or less) with at least 0.1 s of quiet on
  each side — or the buffer's edge, where the hotkey's own click lands — no
  longer splits the pause it sits in. A consonant burst inside a word has
  shorter closures around it, so it is never taken for a click. A very short
  word (about 0.1 s) between two pauses looks the same as a click, so
  absorbed sound is never thrown away: the cut goes in the pause's longest
  quiet stretch, not through the sound, and squeezing (below) only drops
  quiet. The decoder still hears it. A piece
  that still has no sound and that the speech probe doesn't call speech is
  not decoded at all (only when the recording is more than one piece: a
  one-piece recording's answer, or error, is the dictation's).
- **Fragments join a neighbour.** A stretch holding less than 2 s of speech
  joins the neighbour across the shorter pause, smallest first, as long as
  the merged piece stays within the 20 s cap. Inside a merged piece every
  pause longer than 0.5 s reaches the decoder shortened to 0.5 s (its middle
  is dropped), so a long pause doesn't spend the cap on silence. The cap is
  checked on the squeezed audio itself, after any cuts a broken live-preview
  snapshot adds: a range that would still pass 20 s is cut at the cap as
  before. Stretches of
  2 s or more still cut at every pause, so two sentences still don't share a
  decode (#168).

### The dictation recordings

`--dictation` builds each recording from the same FLEURS sentences and keeps
their text as the reference, but shapes it like a dictation
(`dictationRecording` in the harness, seeded and reproducible): 0–2
hesitations of 0.4–1.2 s inside each sentence, at its quietest 100 ms between
25 % and 75 % of the clip (usually between words, sometimes inside one); 0.8–
2.5 s between sentences, with a ~0.3 s breath in half the gaps and a click in
40 %; the hotkey's click at the start and end; a room floor at 0.002 RMS. It
is a model of dictation, not a recording of it: the voices are still read
speech.

### Result

`--before` runs the old behaviour (cut at every pause, decode every piece) next
to the shipped one in the same session. Same machine as above, 2026-10-01,
Electron 42.4.1.

WER, with word ratio in brackets. A ratio over 1 is words added: the
invented ones.

| model | recording | audio | before: every pause | now | pieces, before → now |
| --- | --- | --- | --- | --- | --- |
| fp32 (default) | dictation | 155.2 s | 12.5 % (1.035) | **5.5 % (0.990)** | 67 → 24 |
| fp32 (default) | dictation | 225.0 s | 10.8 % (1.035) | **5.2 % (0.992)** | 92 → 32 |
| fp32 (default) | dictation | 382.4 s | 11.5 % (1.038) | **6.2 % (0.995)** | 150 → 54 |
| fp32 (default) | read | 124.5 s | 6.8 % (0.994) | **5.1 % (0.981)** | 38 → 18 |
| fp32 (default) | read | 182.9 s | 7.1 % (1.010) | **4.6 % (0.990)** | 54 → 26 |
| fp32 (default) | read | 310.9 s | 8.1 % (1.010) | **5.9 % (0.989)** | 87 → 44 |
| int8 | dictation | 155.2 s | 12.2 % (1.051) | **5.5 % (0.997)** | 67 → 24 |
| int8 | dictation | 225.0 s | 11.9 % (1.056) | **6.9 % (1.008)** | 92 → 32 |
| int8 | dictation | 382.4 s | 13.0 % (1.047) | **8.6 % (1.001)** | 150 → 54 |
| int8 | read | 124.5 s | 6.8 % (1.016) | **4.5 % (1.000)** | 38 → 18 |
| int8 | read | 182.9 s | 6.9 % (1.017) | **4.6 % (1.002)** | 54 → 26 |
| int8 | read | 310.9 s | 8.2 % (1.013) | **6.2 % (0.999)** | 87 → 44 |

Every "now" run passes the gate (word ratio ≥ 0.95, WER within 3 points of
the recording's short-clip WER, 4.0–6.2 %); no piece failed, none came back
empty, and the longest worker input was 16.1 s.

Keeping a sound that was taken for noise (above) costs a little where it
really was a click: before that rule the shipped run measured 5.0–5.2 % on
the fp32 dictation recordings and 4.4–5.6 % on fp32 read. Hearing a stray
click is the price of never deleting a short word.

The read recordings got better too: the 1–2 s pieces that cutting at every
pause produced there (the "accepted empty" breaths and clicks above among
them) were costing words, and joining them did not bring back the #168 loss —
the word ratio stays at 0.981–1.002.

### Choosing the thresholds

A sweep over the int8 model on the 300 s target (310.9 s read, 382.4 s
dictation for seed 1), WER, run with `minUtteranceSec` and `minSoundSec` set
through a lab script over the same harness. Measured before the review
fixes that keep absorbed sound (the Result table above is after them):

| recording | before | noise only | fragments < 2 s only | **both (shipped)** | fragments < 3 s + noise |
| --- | --- | --- | --- | --- | --- |
| read | 8.2 % | 6.6 % | 6.6 % | **6.1 %** | 5.7 % |
| dictation, seed 1 | 13.0 % | 10.7 % | 8.6 % | **8.6 %** | 7.1 % |
| dictation, seed 2 | 12.6 % | 11.5 % | 8.7 % | **8.5 %** | 7.5 % |

Each change helps alone, and together they help most. 3 s scored a little
better, but without the noise handling its dictation word ratio fell to
0.979 / 0.968 (seed 1 / 2), the direction #168 went; 2 s kept it at
0.982–1.004 and is what ships. 1 s merged too little: 11.5 / 9.1 % without
the noise handling, 10.4 / 9.9 % with it.

**What this doesn't cover.** The dictation recordings are synthetic. A
fragment can still be decoded alone when joining it either way would pass the
20 s cap, and noise longer than 0.15 s (a cough, a chair) is still sound: it
joins a neighbour like a fragment, so the model hears it in context rather
than alone.

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
after finished sentences (before the dictation handling, which now folds a
click into its pause and a breath into a neighbouring piece), which the probe (biased toward "speech" on
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

# dictation-shaped recordings, old and new splitting side by side
# (--seed N picks the shape, default 1; the sweep below used seeds 1 and 2)
xvfb-run -a npx electron scripts/eval-long-decode.js --no-sandbox \
  --cache-dir <cache> --out <run.json> --dictation --before
# read recordings, old and new splitting side by side
xvfb-run -a npx electron scripts/eval-long-decode.js --no-sandbox \
  --cache-dir <cache> --out <run.json> --before
# one buffer vs pieces (exit 1 if a pieces run misses the gate)
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
