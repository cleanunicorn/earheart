# Speech-to-text model benchmark

On 2026-11-20, all five shipped STT models were evaluated through Earheart's
actual engine worker. Parakeet v2 full precision had the lowest measured word
error rate on the English subset; Parakeet 110M had the shortest observed
decode time. These are preliminary results: the comparison uses 100 clips,
and timing was measured under uncontrolled host load.

## Results

The same first 100 clips from FLEURS en_us test were used for every model:
52 distinct sentences, 2,196 normalized reference words, and 15.94 minutes of
speech. Lower word error rate (WER) is better. Decode time excludes model
loading and IPC; it is an aggregate scaled to ten seconds of audio, not a
per-request latency percentile. Model sizes use decimal MB.

| Model | Normalized WER | Observed decode per 10 s audio | Model size |
| --- | ---: | ---: | ---: |
| Parakeet TDT 0.6B v2 fp32 | 4.01% | 0.299 s | 2,513 MB |
| Fluid Speech Pro 0.63B int8 | 4.74% | 3.141 s | 801 MB |
| Parakeet TDT 0.6B v3 fp32 | 5.10% | 0.311 s | 2,550 MB |
| Parakeet TDT 110M | 5.87% | 0.104 s | 477 MB |
| Parakeet TDT 0.6B v3 int8 | 5.97% | 0.427 s | 670 MB |

This accuracy pass did not enforce a quiet machine or bracket speed with
repeat baseline measurements. Its timings do **not** establish a controlled
speed ranking or justify changing catalog defaults.

## Accuracy uncertainty

The comparison baseline is v3 int8, as fixed by the evaluation harness; the
app's default at the measured revision is v3 full precision. Differences below
are percentage points relative to v3 int8. Intervals use 1,000 paired bootstrap
resamples grouped by sentence (seed 1), so repeated readings are not treated
as independent sentences.

| Model | WER difference | 95% interval |
| --- | ---: | ---: |
| Parakeet v2 fp32 | −1.96 | −2.99 to −1.04 |
| Fluid Speech Pro int8 | −1.23 | −2.30 to −0.04 |
| Parakeet v3 fp32 | −0.87 | −2.18 to +0.28 |
| Parakeet 110M | −0.09 | −1.51 to +1.14 |

These intervals compare each model with the baseline, not with every other
model. The first 100 clips are a development subset, not a random sample.
FLEURS contains read encyclopaedic speech; these results do not establish
performance on spontaneous dictation or other languages.

## Long single-buffer stress tests

The harness also concatenates speech into approximately one- and five-minute
buffers. These checks are separate from short-clip accuracy; normal Earheart
recordings are [split into shorter chunks](long-recordings.md).

| Model | One-minute WER | Hypothesis/reference word ratio |
| --- | ---: | ---: |
| Parakeet v3 int8 | 4.94% | 0.988 |
| Fluid Speech Pro int8 | 1.85% | 1.000 |
| Parakeet v3 fp32 | 1.85% | 1.000 |
| Parakeet v2 fp32 | 11.11% | 0.901 |
| Parakeet 110M | 4.32% | 1.006 |

All five five-minute checks returned `engine process exited`. The cause was
not diagnosed. The raw harness records WER 1 and word ratio 0 for these errors;
those are failure sentinels, not scored transcripts. Parakeet v2's lower
short-clip WER should also be considered alongside its worse one-minute result.

## Method and evidence

- CPU: AMD Ryzen 9 3900X, 24 logical CPUs, eight inference threads, CPU provider.
- Memory: 61 GiB reported by the harness. Linux 6.17.0-40-generic x64.
- Runtime: Electron 42.11.16, sherpa-onnx-node 1.13.3.
- Source revision: `22635b1c7e18ab9d9f330729b1a3d9c636e2a9ab` (v0.55.0).
- Corpus: [Google FLEURS](https://huggingface.co/datasets/google/fleurs),
  CC BY 4.0, pinned revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`.
- Audio: 16 kHz mono PCM16, level-normalized to −20 dBFS RMS with a 0.99 peak
  ceiling, identically for every model.
- WER normalization: Unicode normalization, lowercase, supported number
  verbalization, punctuation removal, filler removal, and whitespace collapse.
  See [the scoring helpers](../scripts/stt-eval.js) for exact rules.
- Each model uses a fresh worker, a first decode and discarded warm-up, then
  the scored clips. Model file hashes are verified by the harness.

[Raw subset results](evaluations/stt-2026-11-20/subset.json) include per-clip
transcripts, error counts, timings, model hashes, and runtime provenance.
[Summary](evaluations/stt-2026-11-20/summary.json) includes the derived intervals.
Only the machine-local artifact directory in raw command strings was replaced
with `<benchmark-dir>` for publication; measurements are unchanged.

An initial full-corpus run completed the 647-clip v3 int8 baseline at 6.07% WER,
then was stopped during Fluid Speech Pro because of runtime. Its
[preserved result](evaluations/stt-2026-11-20/full-baseline.json) retains the
original `running` status because the overall run was interrupted. It is not
a completed full-corpus comparison and is not mixed into the table above.

## Reproduce

Install the repository dependencies, then run from its root on Linux:

```sh
xvfb-run -a npx electron scripts/eval-stt.js --no-sandbox \
  --pass accuracy --limit 100 \
  --models fluid-speech-pro-int8,parakeet-tdt-0.6b-v3-int8,parakeet-tdt-0.6b-v3,parakeet-tdt-0.6b-v2,parakeet-tdt-110m-en \
  --keep --cache-dir /tmp/earheart-stt-benchmark \
  --out /tmp/earheart-stt-subset.json
node scripts/eval-stt.js --report /tmp/earheart-stt-subset.json
```

The recorded run used Electron's headless Ozone backend because Xvfb was
unavailable in that execution environment. A wrapper removed
`--ozone-platform=headless` from `process.argv` before requiring the unchanged
harness, whose argument parser rejects that Chromium flag. GPU rendering was
disabled; inference used the CPU provider.

Remove `--limit 100` for full-corpus accuracy. Use a separate `--pass speed`
run on a quiet host and the harness's `--combine` mode for a controlled speed
comparison; see [harness instructions](../scripts/eval-stt.js). Downloads can
require several GB. The 51 evaluation-harness tests passed for this run.
