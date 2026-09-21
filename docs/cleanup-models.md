# Cleanup models: survey and benchmark

Which locally-runnable model should Earheart ship for transcript cleanup? This
page records the candidates, why each one was measured or skipped, how they
were measured, and the numbers. The harness is
[`scripts/bench-cleanup.mjs`](../scripts/bench-cleanup.mjs); its scoring is
[`scripts/cleanup-metrics.js`](../scripts/cleanup-metrics.js), pinned by
`test/cleanup-metrics.test.js`.

Measured 2026-09-21 on an **AMD Ryzen 9 3900X (24 logical threads), RTX 3080
10 GB, 60 GB RAM, Linux 6.17**. That is not a laptop: absolute times on a
MacBook will differ, and the ranking is what carries over. The host was shared
with other jobs during the run, so every timing sits next to the 1-minute load
average it was taken under.

## Result

**No candidate clears the catalog bar, so none is added.** Two come close,
and they are the ones to look at next:

- **Granite 4.0 Micro** (ibm-granite, Apache-2.0, 2.10 GB) and **Qwen3 4B
  Instruct 2507** (unsloth, Apache-2.0, 2.50 GB) remove every filler on
  FLUENT — 0 left over five seeds and 5/5 clean runs, where the shipped
  Gemma 3 4B leaves all 30 — with no fidelity failure on FLUENT (both styles)
  or REPORTED, and are faster than Gemma 3 4B on the CPU under the cross-run
  lock: **18.6 s** and **21.1 s** against **22.0 s** per FLUENT clean (median;
  fastest single cleans 18.4 s and 21.0 s against 21.6 s).
- They fail one criterion: median content-word retention **0.95** and
  **0.94** against Gemma 3 4B's **1.00**. Gemma reaches 1.00 by copying the
  dictation through, fillers included. What the two drop, read from the saved
  outputs: both collapse the restart "we ask the user to kind of like this is
  where the user goes to connect with us" to "we ask the user to connect with
  us" (the prompt's false-start rule); Granite drops "that exists already"
  (a small real loss); Qwen reads "a lot more roles optional a lot more fields
  optional" as a self-correction and keeps only "fields", and on two seeds
  writes "multi-step", which the word count scores as losing "multiple step".
  Whether "retention no lower than the comparator's" should be measured
  against a comparator that copies is the maintainer's call; the bar was frozen
  before the candidates ran and is not changed after seeing them. If one is
  added, **Granite 4.0 Micro first**: faster (18.6 s vs 21.1 s), smaller
  (2.10 GB vs 2.50 GB), higher retention (0.95 vs 0.94), and its one real loss
  is a redundant clause.
- **No default promotion is recommended.** Nothing near the 1B default's size
  qualifies: Qwen3.5 0.8B leaves 20 fillers against 1B's 30 but regresses on
  `polished` (4 against 0) and fails fidelity there on 2 of 5 seeds; LFM2 1.2B
  and 2.6B remove every filler by deleting a quarter to two fifths of the text
  (retention 0.62 / 0.74, every FLUENT run fails) and are not shippable under
  their licence anyway.
- In the 12B tier, Gemma 3 12B already leaves 0 fillers (5/5 clean runs), so
  under the strict bar nothing can beat it. Mistral Nemo 12B deletes content
  (retention 0.65) and is slower; LFM2.5 8B-A1B reasons in a `<think>` block
  until the generation cap on every run, so the app would deliver the raw
  transcript each time.

### Results (first pass, CPU)

Fillers and repeats are counted on the model's own output (five seeds
summed); "delivered" is after the `stripStumbles` backstop; fidelity fails,
ratio and retention are FLUENT/`clean` unless labelled; echo/refusal/runaway
is FLUENT `clean · polished`. The wall-clock column here is the first pass;
see the next table for how busy the machine was.

| model | FLUENT clean: fillers/repeats (model) | clean runs | FLUENT polished: fillers/repeats | delivered after backstop (clean) | fidelity fails clean/polished | ratio | retention | echo/refusal/runaway | REPORTED: stumbles · fidelity fails | CPU wall ms median [min–max] | load avg | TTFT ms | decode tok/s | load ms | size | chat wrapper |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3.5-0.8b | 20/0 | 0/5 | 4/0 | 0/0 | 0/2 | 0.99 | 1.00 | 0/0/0 · 0/0/0 | 1 · 2 | 6854 [6573–8151] | 10.7 | 1828 | 43.9 | 1132 | 0.56 GB | JinjaTemplateChatWrapper |
| lfm2-1.2b | 0/0 | 0/5 | 0/0 | 0/0 | 5/5 | 0.60 | 0.62 | 0/0/0 · 1/0/0 | 8 · 6 | 4891 [4691–5352] | 14.7 | 2232 | 49.3 | 890 | 0.73 GB | ChatMLChatWrapper |
| gemma-3-1b | 30/0 | 0/5 | 0/0 | 0/0 | 0/5 | 1.00 | 1.00 | 0/0/0 · 0/0/0 | 0 · 5 | 7484 [7417–14594] | – | 2030 | 43.0 | 891 | 0.81 GB | GemmaChatWrapper |
| lfm2-2.6b | 0/0 | 0/5 | 0/0 | 0/0 | 5/5 | 0.69 | 0.74 | 0/0/0 · 0/0/0 | 0 · 10 | 11294 [8147–12817] | 12.9 | 4999 | 24.3 | 1640 | 1.56 GB | ChatMLChatWrapper |
| granite-4.0-micro | 0/0 | 5/5 | 0/0 | 0/0 | 0/0 | 0.91 | 0.95 | 0/0/0 · 0/0/0 | 0 · 0 | 19099 [18945–19291] | 10.5 | 6842 | 17.1 | 2114 | 2.10 GB | JinjaTemplateChatWrapper |
| phi-3.5-mini | 0/0 | 2/5 | 0/0 | 0/0 | 3/5 | 0.87 | 0.89 | 0/0/0 · 0/0/0 | 0 · 2 | 23675 [23330–24913] | 11.6 | 9735 | 14.2 | 2303 | 2.39 GB | JinjaTemplateChatWrapper |
| gemma-3-4b | 30/0 | 0/5 | 5/0 | 0/0 | 0/0 | 1.00 | 1.00 | 0/0/0 · 0/0/0 | 0 · 0 | 22172 [21888–26722] | 13.1 | 5748 | 14.6 | 2531 | 2.49 GB | GemmaChatWrapper |
| qwen3-4b-2507 | 0/0 | 5/5 | 0/0 | 0/0 | 0/0 | 0.91 | 0.94 | 0/0/0 · 0/0/0 | 0 · 0 | 21024 [20981–21174] | 11.8 | 7311 | 15.0 | 2641 | 2.50 GB | QwenChatWrapper |
| gemma-3-4b-qat | 6/0 | 0/5 | 0/0 | 0/0 | 0/5 | 0.93 | 0.98 | 0/0/0 · 0/0/0 | 0 · 5 | 22387 [19861–51366] | 21.7 | 7188 | 14.3 | 2345 | 2.53 GB | GemmaChatWrapper |
| ministral-3-3b | 0/0 | 0/5 | 0/0 | 0/0 | 5/5 | 0.68 | 0.65 | 0/0/0 · 0/0/0 | 0 · 9 | 36301 [22429–72022] | 33.4 | 8847 | 7.3 | 1304 | 3.65 GB | JinjaTemplateChatWrapper |
| lfm2.5-8b-a1b | 40/0 | 0/5 | 38/0 | 30/0 | 5/5 | 1.27 | 1.00 | 5/0/5 · 5/0/5 | 111 · 10 | 12572 [11543–19260] | 25.2 | 3866 | 32.6 | 4918 | 5.16 GB | ChatMLChatWrapper |
| gemma-3-12b | 0/0 | 5/5 | 0/0 | 0/0 | 0/1 | 0.97 | 0.98 | 0/0/0 · 0/0/0 | 0 · 0 | 61879 [60770–94892] | 18.7 | 18894 | 5.3 | 6338 | 7.30 GB | GemmaChatWrapper |
| mistral-nemo-12b | 0/0 | 0/5 | 0/0 | 0/0 | 5/5 | 0.68 | 0.65 | 0/0/0 · 0/0/0 | 0 · 10 | 116644 [101837–164617] | 37.6 | 71736 | 2.2 | 7387 | 7.48 GB | MistralChatWrapper |

### Speed passes and load

The benchmark machine was shared with a parallel speech-to-text evaluation.
Each pass is labelled by the 1-minute load average at its start, its peak
(sampled after every clean) and its end: **quiet** when it never exceeded
14 (about what this benchmark's 12 threads produce on their own), otherwise
**contended**. The verdict trio — Gemma 3 4B, Granite 4.0 Micro and Qwen3 4B
2507, the rows where speed could decide — was re-run back to back while holding
the two runs' shared CPU lock (`flock cpu-quiet.lock`), so no other heavy job
of either run was allowed to start. Those locked passes are the headline
timings. Gemma 3 4B's locked pass still counts as contended by load: the
1-minute average was still falling from earlier work when it started (28.2 at
start, 14.4 at end), and one clean took 107 s. Its median, 22.0 s, matches its
first pass (22.2 s). The load-gated re-run of Gemma 3 4B (29.8 s) ran under
peak load 48 and is shown for transparency only. A Granite re-run stopped
partway (contended from the start) is not shown. Gemma 3 1B's first pass
predates load recording; the one `uptime` sample taken during it read 24.55,
so treat it as contended.

| model | pass | 1-min load: start · peak · end | load label | FLUENT/clean wall ms median [min–max] |
|---|---|---|---|---|
| qwen3.5-0.8b | first pass | 9.2 · 33.0 · 23.4 | contended | 6854 [6573–8151] |
| lfm2-1.2b | first pass | 14.5 · 15.8 · 15.2 | contended | 4891 [4691–5352] |
| gemma-3-1b | first pass | – · – · – | load not recorded | 7484 [7417–14594] |
| lfm2-2.6b | first pass | 10.0 · 16.7 · 14.9 | contended | 11294 [8147–12817] |
| granite-4.0-micro | first pass | 4.0 · 13.5 · 13.2 | quiet | 19099 [18945–19291] |
| granite-4.0-micro | locked re-run | 13.3 · 13.7 · 13.5 | quiet | 18558 [18372–19819] |
| phi-3.5-mini | first pass | 6.7 · 16.7 · 14.0 | contended | 23675 [23330–24913] |
| gemma-3-4b | first pass | 14.0 · 37.9 · 21.1 | contended | 22172 [21888–26722] |
| gemma-3-4b | re-run (bench-rerun) | 12.9 · 48.4 · 38.3 | contended | 29793 [28839–86030] |
| gemma-3-4b | locked re-run | 28.2 · 44.4 · 14.4 | contended | 22009 [21571–107076] |
| qwen3-4b-2507 | first pass | 6.7 · 35.2 · 23.5 | contended | 21024 [20981–21174] |
| qwen3-4b-2507 | locked re-run | 8.9 · 13.2 · 13.2 | quiet | 21117 [21079–21212] |
| gemma-3-4b-qat | first pass | 8.6 · 43.2 · 43.2 | contended | 22387 [19861–51366] |
| ministral-3-3b | first pass | 17.9 · 49.6 · 43.1 | contended | 36301 [22429–72022] |
| lfm2.5-8b-a1b | first pass | 12.7 · 44.5 · 44.5 | contended | 12572 [11543–19260] |
| gemma-3-12b | first pass | 13.5 · 33.8 · 18.6 | contended | 61879 [60770–94892] |
| mistral-nemo-12b | first pass | 20.8 · 47.4 · 20.4 | contended | 116644 [101837–164617] |

### The catalog bar, candidate by candidate

Speed uses each model's least-contended pass (a locked pass first, then the
lowest peak load); the next column checks the verdict against the fastest
single clean across all of a model's passes.

| candidate | vs | licence | quality (clean, strictly fewer) | polished (no more) | fidelity | speed: least-contended median ≤ | speed: min of all passes ≤ | adds to catalog |
|---|---|---|---|---|---|---|---|---|
| qwen3.5-0.8b | gemma-3-1b | apache-2.0 ✓ | yes (20 vs 30) | no | no (fails 0/2, retention 1.00 vs 1.00) | yes (6854 [first pass] vs 7484 [first pass]) | yes (6573 vs 7417) | **no** |
| lfm2-1.2b | gemma-3-1b | lfm1.0 ✗ | yes (0 vs 30) | yes | no (fails 5/5, retention 0.62 vs 1.00) | yes (4891 [first pass] vs 7484 [first pass]) | yes (4691 vs 7417) | **no** |
| lfm2-2.6b | gemma-3-1b | lfm1.0 ✗ | yes (0 vs 30) | yes | no (fails 5/5, retention 0.74 vs 1.00) | no (11294 [first pass] vs 7484 [first pass]) | no (8147 vs 7417) | **no** |
| granite-4.0-micro | gemma-3-4b | apache-2.0 ✓ | yes (0 vs 30) | yes | no (fails 0/0, retention 0.95 vs 1.00) | yes (18558 [locked re-run] vs 22009 [locked re-run]) | yes (18372 vs 21571) | **no** |
| phi-3.5-mini | gemma-3-4b | mit ✓ | yes (0 vs 30) | yes | no (fails 3/5, retention 0.89 vs 1.00) | no (23675 [first pass] vs 22009 [locked re-run]) | no (23330 vs 21571) | **no** |
| qwen3-4b-2507 | gemma-3-4b | apache-2.0 ✓ | yes (0 vs 30) | yes | no (fails 0/0, retention 0.94 vs 1.00) | yes (21117 [locked re-run] vs 22009 [locked re-run]) | yes (20981 vs 21571) | **no** |
| gemma-3-4b-qat | gemma-3-4b | gemma ✓ | yes (6 vs 30) | yes | no (fails 0/5, retention 0.98 vs 1.00) | no (22387 [first pass] vs 22009 [locked re-run]) | yes (19861 vs 21571) | **no** |
| ministral-3-3b | gemma-3-4b | apache-2.0 ✓ | yes (0 vs 30) | yes | no (fails 5/5, retention 0.65 vs 1.00) | no (36301 [first pass] vs 22009 [locked re-run]) | no (22429 vs 21571) | **no** |
| lfm2.5-8b-a1b | gemma-3-12b | lfm1.0 ✗ | no (40 vs 0) | no | no (fails 5/5, retention 1.00 vs 0.98) | yes (12572 [first pass] vs 61879 [first pass]) | yes (11543 vs 60770) | **no** |
| mistral-nemo-12b | gemma-3-12b | apache-2.0 ✓ | no (0 vs 0) | yes | no (fails 5/5, retention 0.65 vs 0.98) | no (116644 [first pass] vs 61879 [first pass]) | no (101837 vs 60770) | **no** |

### Spot checks

All 325 saved outputs were checked by script for text the guards could miss
(quotes, preambles, labels, `<think>`, "Note"), and every failed run was
tallied by the guard that failed it. By hand: every FLUENT output of Granite
4.0 Micro and Qwen3 4B 2507 (above), and at least one flagged output of every
model. What they showed:

- The guards' failures are real. Gemma 3 1B on REPORTED dropped the closing
  sentence ("They just need to provide access to the Gmail account") and turned
  a musing into a question; its FLUENT `polished` output rewrites "more roles
  optional" into "more roles, optional fields, and fields to be added".
  Mistral Nemo and Ministral summarize FLUENT into a shorter paraphrase.
- One gap: a Mistral Nemo REPORTED reply was wrapped whole in quotation marks,
  which the prompt forbids and no guard caught. `detectEcho` now flags it; it
  was 1 of 325 outputs and that run had already failed other guards.
- LFM2.5 8B-A1B's outputs open with `<think>` ("We need to produce cleaned
  transcript according to rules…"); it never reaches the cleaned text before
  the cap.
- The GPU pass changes quality, not just speed: Gemma 3 1B on CUDA left 16
  fillers instead of 30 but failed fidelity on 5/5 FLUENT runs. The GPU
  numbers are a speed footnote only.

### GPU footnote

RTX 3080 10 GB (CUDA), FLUENT/`clean`, five seeds. Never part of the bar.

| GPU footnote (FLUENT/clean) | backend | wall ms median [min–max] | decode tok/s | fillers/repeats | fidelity fails |
|---|---|---|---|---|---|
| qwen3.5-0.8b | cuda | 1173 [910–1214] | 207.5 | 20/0 | 0/5 |
| lfm2-1.2b | cuda | 384 [326–473] | 412.9 | 0/0 | 5/5 |
| gemma-3-1b | cuda | 917 [748–1060] | 189.7 | 16/0 | 5/5 |
| lfm2-2.6b | cuda | 689 [680–754] | 243.4 | 0/0 | 5/5 |
| granite-4.0-micro | cuda | 1659 [1512–1683] | 146.6 | 0/0 | 0/5 |
| phi-3.5-mini | cuda | 1448 [1333–1455] | 163.4 | 0/0 | 2/5 |
| gemma-3-4b | cuda | 2392 [2113–2435] | 118.5 | 30/0 | 0/5 |
| qwen3-4b-2507 | cuda | 1691 [1664–1705] | 133.9 | 0/0 | 0/5 |
| gemma-3-4b-qat | cuda | 2102 [1901–2171] | 124.0 | 5/0 | 0/5 |
| ministral-3-3b | cuda | 1248 [1100–1340] | 126.5 | 0/0 | 5/5 |
| lfm2.5-8b-a1b | cuda | 1100 [1078–1261] | 294.9 | 40/0 | 5/5 |
| gemma-3-12b | cuda | 4576 [4396–4690] | 60.2 | 0/0 | 0/5 |
| mistral-nemo-12b | cuda | 2396 [2272–2471] | 71.1 | 0/0 | 5/5 |

Hardware: AMD Ryzen 9 3900X 12-Core Processor (24 logical CPUs), 61 GB RAM, Linux 6.17.0-40-generic; CPU backend, node-llama-cpp threads ideal/current 12/12; seeds 17,29,43,61,79. Headline speed passes were taken holding the cross-run CPU lock.


## What a candidate has to be

The built-in engine is `node-llama-cpp` 3.18.1, which bundles llama.cpp
**b8390** and loads **one GGUF file** (`loadModel({ modelPath })` in
`main/engines/engine-worker.js`). A candidate must be:

- **instruct-tuned**, with a chat template node-llama-cpp resolves (the harness
  records the wrapper it picked; `GeneralChatWrapper` would mean the template
  was not understood);
- a **single-file GGUF** (a split `…-00001-of-00002.gguf` is out;
  `test/engines.test.js` now enforces this for the catalog);
- an **architecture b8390 knows** (checked with
  `strings node_modules/@node-llama-cpp/linux-x64/bins/linux-x64/libllama.b8390.so | grep -xc <arch>`);
- on an **ungated** Hugging Face repo whose owner is not `google`,
  `meta-llama` or `mistralai` (those return HTTP 401 to anonymous downloads);
- roughly **0.5–12 B parameters** at Q4, like the shipped tiers;
- under a licence the catalog can carry: **Apache-2.0, MIT or the Gemma
  Terms** (the shipped precedent). Anything else is measured and recorded here,
  never added.

Every row below was checked with
`node scripts/bench-cleanup.mjs --probe <owner/repo> <file>` on 2026-09-21
(architecture, template, licence, gating, pinned commit, sha256, bytes).
"Thinking" means the chat template mentions `<think>` or `enable_thinking`.

## Measured

| model (repo · file) | arch | bytes | licence | thinking in template | nearest shipped Gemma (bytes) | catalog-eligible |
|---|---|---|---|---|---|---|
| **Gemma 3 1B** (shipped default) · ggml-org/gemma-3-1b-it-GGUF · `gemma-3-1b-it-Q4_K_M.gguf` | gemma3 | 806,058,240 | gemma | no | — | shipped |
| **Gemma 3 4B** (shipped) · ggml-org/gemma-3-4b-it-GGUF · `gemma-3-4b-it-Q4_K_M.gguf` | gemma3 | 2,489,757,856 | gemma | no | — | shipped |
| **Gemma 3 12B** (shipped, id `gemma-4-12b`) · ggml-org/gemma-3-12b-it-GGUF · `gemma-3-12b-it-Q4_K_M.gguf` | gemma3 | 7,300,574,976 | gemma | no | — | shipped |
| Qwen3.5 0.8B · ggml-org/Qwen3.5-0.8B-GGUF · `Qwen3.5-0.8B-Q4_0.gguf` (no Q4_K_M published) | qwen35 | 563,036,064 | apache-2.0 | yes (hybrid) | 1B | yes |
| LFM2 1.2B · LiquidAI/LFM2-1.2B-GGUF · `LFM2-1.2B-Q4_K_M.gguf` | lfm2 | 730,893,248 | lfm1.0 | no | 1B | **no** (licence) |
| LFM2 2.6B · LiquidAI/LFM2-2.6B-GGUF · `LFM2-2.6B-Q4_K_M.gguf` | lfm2 | 1,563,668,704 | lfm1.0 | no | 1B | **no** (licence) |
| Granite 4.0 Micro · ibm-granite/granite-4.0-micro-GGUF · `granite-4.0-micro-Q4_K_M.gguf` | granite | 2,099,502,528 | apache-2.0 | no | 4B | yes |
| Phi-3.5 Mini · bartowski/Phi-3.5-mini-instruct-GGUF · `Phi-3.5-mini-instruct-Q4_K_M.gguf` | phi3 | 2,393,232,672 | mit | no | 4B | yes |
| Qwen3 4B Instruct 2507 · unsloth/Qwen3-4B-Instruct-2507-GGUF · `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | qwen3 | 2,497,281,120 | apache-2.0 | template parses `<think>` in past turns; this Instruct build emitted none (0 echo in 15 runs) | 4B | yes |
| Gemma 3 4B QAT (control) · ggml-org/gemma-3-4b-it-qat-GGUF · `gemma-3-4b-it-qat-Q4_0.gguf` | gemma3 | 2,526,080,992 | gemma (card has no tag; same family and terms as shipped) | no | 4B | yes |
| Ministral 3 3B · ggml-org/Ministral-3-3B-Instruct-2512-GGUF · `Ministral-3-3B-Instruct-2512-Q8_0.gguf` (only Q8_0 published) | mistral3 | 3,651,679,744 | apache-2.0 | no | 4B | yes |
| LFM2.5 8B-A1B (MoE, ~1B active) · LiquidAI/LFM2.5-8B-A1B-GGUF · `LFM2.5-8B-A1B-Q4_K_M.gguf` | lfm2moe | 5,155,564,768 | lfm1.0 | yes | 12B | **no** (licence) |
| Mistral Nemo 12B · bartowski/Mistral-Nemo-Instruct-2407-GGUF · `Mistral-Nemo-Instruct-2407-Q4_K_M.gguf` | llama | 7,477,208,192 | apache-2.0 | no | 12B | yes |

The gemma-3-4b QAT build is a control, not a contender: same weights family,
quantization-aware Q4_0. It separates "a better model" from "a better quant".

## Skipped, with the reason

| candidate | reason | evidence |
|---|---|---|
| ggml-org/gemma-4-E2B-it-GGUF (2,841,481,184 B), gemma-4-E4B-it-GGUF (4,590,807,392 B) | **Engine cannot load it:** architecture `gemma4` is not in llama.cpp b8390. Needs a node-llama-cpp bump (a runtime-dependency change, out of scope) | probe `arch: gemma4`; `grep -xc gemma4` → 0 (`gemma3` → 1) |
| ggml-org/Laguna-XS-2.1-GGUF | Engine cannot load it (`laguna` not in b8390); also 19.6 GB, outside the size band; licence `openmdw-1.1` | probe; `grep -xc laguna` → 0 |
| Qwen/Qwen2.5-7B-Instruct-GGUF | **Split GGUF:** Q4_K_M is `…-00001-of-00002.gguf` + `…-00002-of-00002.gguf` | probe `split: true` |
| Qwen/Qwen2.5-3B-Instruct-GGUF | **Licence** `qwen-research` (non-commercial) | probe |
| unsloth/Qwen3-4B-GGUF and the other non-2507 Qwen3 sizes | Hybrid-thinking predecessor of Qwen3-4B-Instruct-2507, which is measured at the same size | probe `thinking: true` (template has `enable_thinking`) |
| ggml-org/Nemotron-3-Nano-4B-GGUF | Only BF16 and Q8_0 published; a reasoning-first model (template built around `<think>`) | repo file list |
| microsoft/Phi-3-mini-4k-instruct-gguf | Superseded by Phi-3.5 Mini (measured); no Q4_K_M, only `…-q4.gguf` | repo file list |
| tiiuae/Falcon3-3B-Instruct-GGUF | Licence `falcon-llm-license` | probe |
| google/\*, meta-llama/\*, mistralai/\* | Gated (HTTP 401 anonymous); rejected by `test/engines.test.js` | — |
| Qwen3.5 9B+, Qwen3.6/3.8 27B, gpt-oss-20b, GLM-4.7-Flash, Qwen3.5-35B-A3B | Outside the 0.5–12 B band | sizes from the HF API |
| gemma-3-1b / 12b QAT | Redundant with the 4B QAT control | — |
| community re-quants without upstream provenance ("abliterated", "uncensored", distills) | No licence metadata or provenance to pin | — |

**Reserves** (loadable and eligible, not measured because the shortlist
already covers their size band with newer weights):
HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF (llama, apache-2.0, 1,055,609,536 B),
Qwen/Qwen2.5-1.5B-Instruct-GGUF (qwen2, apache-2.0, 1,117,320,736 B),
ggml-org/SmolLM3-3B-GGUF (smollm3, apache-2.0, hybrid thinking,
1,915,305,312 B), bartowski/Llama-3.2-3B-Instruct-GGUF (llama, `llama3.2`
licence → not addable, 2,019,377,696 B).

## How it was measured

- **Prompt: exactly what ships.** The default config's base prompt and style
  directive through `resolveCleanup` (`main/cleanup-styles.js`), wrapped in
  the single user turn the engine sends (`main/util/cleanup-turn.js`, shared
  with the worker), no system role, 4096-token context, the worker's
  generation cap (`cleanMaxTokens`). No candidate-specific prompt, template or
  sampling: a model that only wins under a different prompt is a follow-up.
- **Inputs** (`scripts/dictation-corpus.js`): FLUENT (one long, mostly fluent
  dictation with 6 fillers — the shape where the shipped models copy the
  fillers through) under `clean` (the shipped default style) and `polished`;
  REPORTED (two filler-dense paragraphs) under `clean`. Five fixed seeds
  (17, 29, 43, 61, 79) for every model, so runs pair up.
- **Quality, as the model returned it.** Fillers (`um`/`uh`/`erm`) and
  repeats the backstop would collapse, counted on the model's own output. The
  delivered count after `stripStumbles` is reported too, but it cannot decide
  anything: the backstop brings every model close to zero.
- **Fidelity guards**, any failure fails the run: output/input length ratio
  (FLUENT 0.85–1.05, others 0.70–1.10); content-word retention ≥ 0.90 (function
  words and fillers excluded); every negation, scope word, number and
  code-like token kept; no echo of the prompt, its labels or `<think>`; no
  preamble or code fence; no refusal; not empty; and no runaway (a `maxTokens`
  stop, which the app answers by delivering the raw transcript). Novel content
  words are reported alongside.
- **Speed, on the CPU**: `getLlama({ gpu: false })` with no thread override —
  the app's own CPU path — which resolved to **12 threads** on this machine
  (`cpuMathCores` 12). Per clean: wall-clock from the prompt call to its result
  (the headline), time to first token, and decode tokens/s. The context's
  token history is cleared before each timed clean, so every clean pays full
  prefill; in the app, prime-cleanup can hide the prompt's share of that, so
  these are upper bounds, equal for every model. Load time is model + 4096
  context. A GPU pass (FLUENT/`clean` only) is a footnote and never decides
  anything. Where speed could decide a verdict, the pass was repeated holding a
  CPU lock shared with the other benchmark on the machine; the bar uses each
  model's least-contended pass and the report shows the fastest clean of all
  passes beside it.
- **The catalog bar** (`meetsBar`): against the shipped Gemma nearest in file
  size, a candidate must have a shippable licence; strictly fewer model-stage
  fillers + repeats on FLUENT/`clean` over the five seeds and no fewer clean
  runs; no more on FLUENT/`polished`; no fidelity failure on FLUENT and a
  median retention at least the Gemma's; and a median FLUENT/`clean`
  wall-clock no slower. A quality tie is not a win, even when faster.

## Reproduce

```sh
# one model (download it first; outputs go outside the repo)
node scripts/bench-cleanup.mjs --out=/tmp/bench --id=gemma-3-4b gemma-3-4b-it-Q4_K_M.gguf
# GPU footnote
node scripts/bench-cleanup.mjs --out=/tmp/bench --id=gemma-3-4b --gpu gemma-3-4b-it-Q4_K_M.gguf
# check a candidate on Hugging Face without downloading it
node scripts/bench-cleanup.mjs --probe unsloth/Qwen3-4B-Instruct-2507-GGUF Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

```sh
# the tables on this page, from saved runs (extra passes: --also / --locked)
node scripts/bench-cleanup.mjs --report /tmp/bench --locked=/tmp/bench-locked \
  --licences=granite-4.0-micro=apache-2.0,qwen3-4b-2507=apache-2.0,…
```

Each run writes `manifest.json` (file, sha256, backend, threads, chat
wrapper, hardware, load average), `runs.jsonl`, `summary.json` and every raw
output under `--out/<id>/`.
