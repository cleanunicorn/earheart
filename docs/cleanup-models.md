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
  FLUENT/`clean` — 0 left over five seeds and 5/5 clean runs, where the
  shipped Gemma 3 4B leaves 35 (all 30 "um"/"uh" plus "kind of like" in every
  run); on `polished` Granite keeps "kind of like" twice, Qwen none, Gemma 3 4B
  leaves 5 — with no fidelity failure on FLUENT (both styles)
  or REPORTED. On the CPU they took **18.6 s** and **21.1 s** per FLUENT
  clean (median of quiet passes taken under the cross-run lock; fastest single
  clean across all their passes 18.4 s and 21.0 s). **The speed comparison is
  indicative, not proven:** Gemma 3 4B was never timed on a quiet machine —
  all five of its passes ran contended, with medians from 22.0 to 30.7 s. Its
  least contended pass (the first, which started at a 1-minute load of 14.0)
  took 22.2 s, and its fastest single clean in any pass 21.6 s. Against those,
  Granite is about 15–16% faster and Qwen about 3–5% — a margin that
  contention on the comparator alone could produce.
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
  added, **Granite 4.0 Micro first**: faster (18.6 s vs 21.1 s, both quiet),
  smaller (2.10 GB vs 2.50 GB), higher retention (0.95 vs 0.94), and its one
  real loss is a redundant clause. Qwen is the cleaner of the two on
  `polished` (0 left against Granite's 2 "kind of like").
- **No default promotion is recommended.** Nothing near the 1B default's size
  qualifies: Qwen3.5 0.8B leaves 25 fillers against 1B's 35 but regresses on
  `polished` (7 against 4) and fails fidelity there on 2 of 5 seeds; LFM2 1.2B
  and 2.6B remove every filler by deleting a quarter to two fifths of the text
  (retention 0.62 / 0.74, every FLUENT run fails) and are not shippable under
  their licence anyway.
- In the 12B tier, Gemma 3 12B already leaves 0 fillers (5/5 clean runs), so
  under the strict bar nothing can beat it. Mistral Nemo 12B deletes content
  (retention 0.65) and is slower; LFM2.5 8B-A1B reasons in a `<think>` block
  until the generation cap on every run, so the app would deliver the raw
  transcript each time.

### What the review changed

After review the scoring was fixed in four places, and every saved run was
re-scored from its raw output (`--rescore`; no model was re-run): a filler
the directive names beyond um/uh/erm now counts ("kind of like", "you know",
"I mean", …); an all-caps "UM" is skipped, as the backstop does; a run fails
fidelity if more than 10% of its content words are new; and a reply wrapped
in quotes counts as echo. **No verdict moved** — still 0 of 10 candidates —
and the Q6 facts stand: Granite and Qwen still leave **0** fillers on
FLUENT/`clean`, and their retention is unchanged (0.95, 0.94). What did move
(stumbles · clean runs · fidelity fails, before → after):

| model | FLUENT clean: fillers/repeats/other fillers (model) | clean runs | FLUENT polished: fillers/repeats/other | delivered after backstop (clean): fillers/repeats/other | fidelity fails clean/polished | ratio | retention | novel | echo/refusal/runaway | REPORTED: stumbles · fidelity fails | CPU wall ms median [min–max] | load avg | TTFT ms | decode tok/s | load ms | size | chat wrapper |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3.5-0.8b | 20/0/5 | 0/5 | 4/0/3 | 0/0/5 | 0/2 | 0.99 | 1.00 | 0.00 | 0/0/0 · 0/0/0 | 2 · 2 | 6854 [6573–8151] | 10.7 | 1828 | 43.9 | 1132 | 0.56 GB | JinjaTemplateChatWrapper |
| lfm2-1.2b | 0/0/0 | 0/5 | 0/0/0 | 0/0/0 | 5/5 | 0.60 | 0.62 | 0.15 | 0/0/0 · 1/0/0 | 8 · 6 | 4891 [4691–5352] | 14.7 | 2232 | 49.3 | 890 | 0.73 GB | ChatMLChatWrapper |
| gemma-3-1b | 30/0/5 | 0/5 | 0/0/4 | 0/0/5 | 0/5 | 1.00 | 1.00 | 0.00 | 0/0/0 · 0/0/0 | 0 · 5 | 7484 [7417–14594] | – | 2030 | 43.0 | 891 | 0.81 GB | GemmaChatWrapper |
| lfm2-2.6b | 0/0/0 | 0/5 | 0/0/0 | 0/0/0 | 5/5 | 0.69 | 0.74 | 0.10 | 0/0/0 · 0/0/0 | 0 · 10 | 11294 [8147–12817] | 12.9 | 4999 | 24.3 | 1640 | 1.56 GB | ChatMLChatWrapper |
| granite-4.0-micro | 0/0/0 | 5/5 | 0/0/2 | 0/0/0 | 0/0 | 0.91 | 0.95 | 0.00 | 0/0/0 · 0/0/0 | 0 · 0 | 19099 [18945–19291] | 10.5 | 6842 | 17.1 | 2114 | 2.10 GB | JinjaTemplateChatWrapper |
| phi-3.5-mini | 0/0/0 | 2/5 | 0/0/0 | 0/0/0 | 3/5 | 0.87 | 0.89 | 0.00 | 0/0/0 · 0/0/0 | 0 · 2 | 23675 [23330–24913] | 11.6 | 9735 | 14.2 | 2303 | 2.39 GB | JinjaTemplateChatWrapper |
| gemma-3-4b | 30/0/5 | 0/5 | 5/0/0 | 0/0/5 | 0/0 | 1.00 | 1.00 | 0.00 | 0/0/0 · 0/0/0 | 15 · 0 | 22172 [21888–26722] | 13.1 | 5748 | 14.6 | 2531 | 2.49 GB | GemmaChatWrapper |
| qwen3-4b-2507 | 0/0/0 | 5/5 | 0/0/0 | 0/0/0 | 0/0 | 0.91 | 0.94 | 0.01 | 0/0/0 · 0/0/0 | 5 · 0 | 21024 [20981–21174] | 11.8 | 7311 | 15.0 | 2641 | 2.50 GB | QwenChatWrapper |
| gemma-3-4b-qat | 6/0/0 | 0/5 | 0/0/0 | 0/0/0 | 0/5 | 0.93 | 0.98 | 0.00 | 0/0/0 · 0/0/0 | 0 · 5 | 22387 [19861–51366] | 21.7 | 7188 | 14.3 | 2345 | 2.53 GB | GemmaChatWrapper |
| ministral-3-3b | 0/0/0 | 0/5 | 0/0/0 | 0/0/0 | 5/5 | 0.68 | 0.65 | 0.20 | 0/0/0 · 0/0/0 | 0 · 9 | 36301 [22429–72022] | 33.4 | 8847 | 7.3 | 1304 | 3.65 GB | JinjaTemplateChatWrapper |
| lfm2.5-8b-a1b | 40/0/14 | 0/5 | 38/0/9 | 30/0/5 | 5/5 | 1.27 | 1.00 | 0.26 | 5/0/5 · 5/0/5 | 144 · 10 | 12572 [11543–19260] | 25.2 | 3866 | 32.6 | 4918 | 5.16 GB | ChatMLChatWrapper |
| gemma-3-12b | 0/0/0 | 5/5 | 0/0/0 | 0/0/0 | 0/1 | 0.97 | 0.98 | 0.01 | 0/0/0 · 0/0/0 | 0 · 0 | 61879 [60770–94892] | 18.7 | 18894 | 5.3 | 6338 | 7.30 GB | GemmaChatWrapper |
| mistral-nemo-12b | 0/0/0 | 0/5 | 0/0/0 | 0/0/0 | 5/5 | 0.68 | 0.65 | 0.19 | 0/0/0 · 0/0/0 | 0 · 10 | 116644 [101837–164617] | 37.6 | 71736 | 2.2 | 7387 | 7.48 GB | MistralChatWrapper |

Every other model's numbers are unchanged. One reply (Mistral Nemo, REPORTED)
became an echo failure it already was for other reasons. The speed rows
gained two more locked passes of Gemma 3 4B (above).

The final review changed one more column. "Delivered after backstop" now
also counts the directive's other fillers. `stripStumbles` never removes
them, so a model that keeps "kind of like" hands it to the user. Gemma 3
1B, Gemma 3 4B and Qwen3.5 0.8B went from 0/0 to **0/0/5** (one per
FLUENT/`clean` run). LFM2.5 8B-A1B shows 30/0/5 because every one of its
runs hit the cap, so the raw transcript is what gets delivered. No verdict
moved: the bar reads the model's own output, never the delivered column.

### Results (first pass, CPU)

Fillers, repeats and the directive's other fillers ("kind of like", "you
know", …) are counted on the model's own output (five seeds summed); "delivered" is after the `stripStumbles` backstop; fidelity fails,
ratio and retention are FLUENT/`clean` unless labelled; echo/refusal/runaway
is FLUENT `clean · polished`. The wall-clock column here is the first pass;
see the next table for how busy the machine was.

| model | FLUENT clean: fillers/repeats/other fillers (model) | clean runs | FLUENT polished: fillers/repeats/other | delivered after backstop (clean) | fidelity fails clean/polished | ratio | retention | novel | echo/refusal/runaway | REPORTED: stumbles · fidelity fails | CPU wall ms median [min–max] | load avg | TTFT ms | decode tok/s | load ms | size | chat wrapper |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3.5-0.8b | 20/0/5 | 0/5 | 4/0/3 | 0/0 | 0/2 | 0.99 | 1.00 | 0.00 | 0/0/0 · 0/0/0 | 2 · 2 | 6854 [6573–8151] | 10.7 | 1828 | 43.9 | 1132 | 0.56 GB | JinjaTemplateChatWrapper |
| lfm2-1.2b | 0/0/0 | 0/5 | 0/0/0 | 0/0 | 5/5 | 0.60 | 0.62 | 0.15 | 0/0/0 · 1/0/0 | 8 · 6 | 4891 [4691–5352] | 14.7 | 2232 | 49.3 | 890 | 0.73 GB | ChatMLChatWrapper |
| gemma-3-1b | 30/0/5 | 0/5 | 0/0/4 | 0/0 | 0/5 | 1.00 | 1.00 | 0.00 | 0/0/0 · 0/0/0 | 0 · 5 | 7484 [7417–14594] | – | 2030 | 43.0 | 891 | 0.81 GB | GemmaChatWrapper |
| lfm2-2.6b | 0/0/0 | 0/5 | 0/0/0 | 0/0 | 5/5 | 0.69 | 0.74 | 0.10 | 0/0/0 · 0/0/0 | 0 · 10 | 11294 [8147–12817] | 12.9 | 4999 | 24.3 | 1640 | 1.56 GB | ChatMLChatWrapper |
| granite-4.0-micro | 0/0/0 | 5/5 | 0/0/2 | 0/0 | 0/0 | 0.91 | 0.95 | 0.00 | 0/0/0 · 0/0/0 | 0 · 0 | 19099 [18945–19291] | 10.5 | 6842 | 17.1 | 2114 | 2.10 GB | JinjaTemplateChatWrapper |
| phi-3.5-mini | 0/0/0 | 2/5 | 0/0/0 | 0/0 | 3/5 | 0.87 | 0.89 | 0.00 | 0/0/0 · 0/0/0 | 0 · 2 | 23675 [23330–24913] | 11.6 | 9735 | 14.2 | 2303 | 2.39 GB | JinjaTemplateChatWrapper |
| gemma-3-4b | 30/0/5 | 0/5 | 5/0/0 | 0/0 | 0/0 | 1.00 | 1.00 | 0.00 | 0/0/0 · 0/0/0 | 15 · 0 | 22172 [21888–26722] | 13.1 | 5748 | 14.6 | 2531 | 2.49 GB | GemmaChatWrapper |
| qwen3-4b-2507 | 0/0/0 | 5/5 | 0/0/0 | 0/0 | 0/0 | 0.91 | 0.94 | 0.01 | 0/0/0 · 0/0/0 | 5 · 0 | 21024 [20981–21174] | 11.8 | 7311 | 15.0 | 2641 | 2.50 GB | QwenChatWrapper |
| gemma-3-4b-qat | 6/0/0 | 0/5 | 0/0/0 | 0/0 | 0/5 | 0.93 | 0.98 | 0.00 | 0/0/0 · 0/0/0 | 0 · 5 | 22387 [19861–51366] | 21.7 | 7188 | 14.3 | 2345 | 2.53 GB | GemmaChatWrapper |
| ministral-3-3b | 0/0/0 | 0/5 | 0/0/0 | 0/0 | 5/5 | 0.68 | 0.65 | 0.20 | 0/0/0 · 0/0/0 | 0 · 9 | 36301 [22429–72022] | 33.4 | 8847 | 7.3 | 1304 | 3.65 GB | JinjaTemplateChatWrapper |
| lfm2.5-8b-a1b | 40/0/14 | 0/5 | 38/0/9 | 30/0 | 5/5 | 1.27 | 1.00 | 0.26 | 5/0/5 · 5/0/5 | 144 · 10 | 12572 [11543–19260] | 25.2 | 3866 | 32.6 | 4918 | 5.16 GB | ChatMLChatWrapper |
| gemma-3-12b | 0/0/0 | 5/5 | 0/0/0 | 0/0 | 0/1 | 0.97 | 0.98 | 0.01 | 0/0/0 · 0/0/0 | 0 · 0 | 61879 [60770–94892] | 18.7 | 18894 | 5.3 | 6338 | 7.30 GB | GemmaChatWrapper |
| mistral-nemo-12b | 0/0/0 | 0/5 | 0/0/0 | 0/0 | 5/5 | 0.68 | 0.65 | 0.19 | 0/0/0 · 0/0/0 | 0 · 10 | 116644 [101837–164617] | 37.6 | 71736 | 2.2 | 7387 | 7.48 GB | MistralChatWrapper |

### Speed passes and load

The benchmark machine was shared with a parallel speech-to-text evaluation.
Each pass is labelled by the 1-minute load average at its start, its peak
(sampled after every clean) and its end: **quiet** when it never exceeded
14 (about what this benchmark's 12 threads produce on their own), otherwise
**contended**. The verdict trio — Gemma 3 4B, Granite 4.0 Micro and Qwen3 4B
2507, the rows where speed could decide — was re-run while holding the two
runs' shared CPU lock (`flock cpu-quiet.lock`), which stops the other run
from *starting* heavy work but not work it already has in flight. Granite's
and Qwen's locked passes were quiet. **Gemma 3 4B was never timed quiet:**
its first locked pass started while the 1-minute average was still falling
from earlier work (28.2 at start; one clean took 107 s), and two more locked
passes, each started below 14, rose to about 22 while the other run's worker
(already running, about 7.6 cores) kept going — medians 30.7 and 30.3 s.
Across its five passes Gemma 3 4B's median ranges from 22.0 to 30.7 s.

The bar's speed rule takes each model's "least contended" pass — a locked
pass first, then the lowest peak load — which for Gemma 3 4B is locked re-run
3 at 30.3 s. That makes its speed column read "yes" for Phi-3.5 Mini and the
QAT control even though no verdict turns on it (both fail fidelity); the
next column, against Gemma's fastest single clean (21.6 s), is the stricter
check. The load-gated re-run of Gemma 3 4B (29.8 s) is shown for
transparency; a Granite re-run stopped partway (contended from the start) is
not shown. Gemma 3 1B's first pass predates load recording; the one `uptime`
sample taken during it read 24.55, so treat it as contended.

| model | pass | 1-min load: start · peak · end | load label | FLUENT/clean wall ms median [min–max] |
|---|---|---|---|---|
| qwen3.5-0.8b | first pass | 9.2 · 33.0 · 23.4 | contended | 6854 [6573–8151] |
| lfm2-1.2b | first pass | 14.5 · 15.8 · 15.2 | contended | 4891 [4691–5352] |
| gemma-3-1b | first pass | – · – · – | load not recorded | 7484 [7417–14594] |
| lfm2-2.6b | first pass | 10.0 · 16.7 · 14.9 | contended | 11294 [8147–12817] |
| granite-4.0-micro | first pass | 4.0 · 13.5 · 13.2 | quiet | 19099 [18945–19291] |
| granite-4.0-micro | locked re-run 1 | 13.3 · 13.7 · 13.5 | quiet | 18558 [18372–19819] |
| phi-3.5-mini | first pass | 6.7 · 16.7 · 14.0 | contended | 23675 [23330–24913] |
| gemma-3-4b | first pass | 14.0 · 37.9 · 21.1 | contended | 22172 [21888–26722] |
| gemma-3-4b | re-run (bench-rerun) | 12.9 · 48.4 · 38.3 | contended | 29793 [28839–86030] |
| gemma-3-4b | locked re-run 1 | 28.2 · 44.4 · 14.4 | contended | 22009 [21571–107076] |
| gemma-3-4b | locked re-run 2 | 13.5 · 22.4 · 22.4 | contended | 30726 [30229–31274] |
| gemma-3-4b | locked re-run 3 | 11.4 · 21.9 · 20.3 | contended | 30339 [30237–30759] |
| qwen3-4b-2507 | first pass | 6.7 · 35.2 · 23.5 | contended | 21024 [20981–21174] |
| qwen3-4b-2507 | locked re-run 1 | 8.9 · 13.2 · 13.2 | quiet | 21117 [21079–21212] |
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
| qwen3.5-0.8b | gemma-3-1b | apache-2.0 ✓ | yes (25 vs 35) | no | no (fails 0/2, retention 1.00 vs 1.00) | yes (6854 [first pass] vs 7484 [first pass]) | yes (6573 vs 7417) | **no** |
| lfm2-1.2b | gemma-3-1b | lfm1.0 ✗ | yes (0 vs 35) | yes | no (fails 5/5, retention 0.62 vs 1.00) | yes (4891 [first pass] vs 7484 [first pass]) | yes (4691 vs 7417) | **no** |
| lfm2-2.6b | gemma-3-1b | lfm1.0 ✗ | yes (0 vs 35) | yes | no (fails 5/5, retention 0.74 vs 1.00) | no (11294 [first pass] vs 7484 [first pass]) | no (8147 vs 7417) | **no** |
| granite-4.0-micro | gemma-3-4b | apache-2.0 ✓ | yes (0 vs 35) | yes | no (fails 0/0, retention 0.95 vs 1.00) | yes (18558 [locked re-run 1] vs 30339 [locked re-run 3]) | yes (18372 vs 21571) | **no** |
| phi-3.5-mini | gemma-3-4b | mit ✓ | yes (0 vs 35) | yes | no (fails 3/5, retention 0.89 vs 1.00) | yes (23675 [first pass] vs 30339 [locked re-run 3]) | no (23330 vs 21571) | **no** |
| qwen3-4b-2507 | gemma-3-4b | apache-2.0 ✓ | yes (0 vs 35) | yes | no (fails 0/0, retention 0.94 vs 1.00) | yes (21117 [locked re-run 1] vs 30339 [locked re-run 3]) | yes (20981 vs 21571) | **no** |
| gemma-3-4b-qat | gemma-3-4b | gemma ✓ | yes (6 vs 35) | yes | no (fails 0/5, retention 0.98 vs 1.00) | yes (22387 [first pass] vs 30339 [locked re-run 3]) | yes (19861 vs 21571) | **no** |
| ministral-3-3b | gemma-3-4b | apache-2.0 ✓ | yes (0 vs 35) | yes | no (fails 5/5, retention 0.65 vs 1.00) | no (36301 [first pass] vs 30339 [locked re-run 3]) | no (22429 vs 21571) | **no** |
| lfm2.5-8b-a1b | gemma-3-12b | lfm1.0 ✗ | no (54 vs 0) | no | no (fails 5/5, retention 1.00 vs 0.98) | yes (12572 [first pass] vs 61879 [first pass]) | yes (11543 vs 60770) | **no** |
| mistral-nemo-12b | gemma-3-12b | apache-2.0 ✓ | no (0 vs 0) | yes | no (fails 5/5, retention 0.65 vs 0.98) | no (116644 [first pass] vs 61879 [first pass]) | no (101837 vs 60770) | **no** |

### Spot checks

Two model-free passes over the saved runs (`$OUT` as in Reproduce), then
reading by hand.

Outputs that open like a reply rather than the cleaned text, or carry
reasoning — the shapes a guard could miss — listed per model for reading:

```sh
grep -lE '^\s*("|“|Note|Here|Sure|Cleaned|Transcript)|<think>|\(Note' "$OUT"/*/raw/*.txt |
  awk -F/ '{print $(NF-2)}' | sort | uniq -c
```

On this run's 325 outputs: lfm2.5-8b-a1b 20 (and 5 on the GPU pass), all
`<think>`; lfm2-1.2b 1 (a summary opening "User wants to…", already failed);
mistral-nemo-12b 1 (wrapped in quotes, which no guard caught — see below).

Every failed run by the guard that failed it (a run can fail several):

```sh
cat "$OUT"/*/runs.jsonl | node -e '
const { FIDELITY } = require("./scripts/cleanup-metrics");
const rows = require("fs").readFileSync(0, "utf8").trim().split("\n").map(JSON.parse);
const failed = rows.filter((r) => !r.score.fidelityOk), by = {};
for (const { corpus, score: s } of failed) {
  const [lo, hi] = corpus === "fluent" ? FIDELITY.ratio.fluent : FIDELITY.ratio.other;
  const hits = { runaway: s.runaway, echo: s.echo, refusal: s.refusal, empty: s.empty,
    critical: s.criticalLost > 0, ratio: s.ratio < lo || s.ratio > hi,
    retention: s.retention < FIDELITY.minRetention, novel: s.novel > FIDELITY.maxNovel };
  for (const [k, v] of Object.entries(hits)) if (v) by[k] = (by[k] || 0) + 1;
}
console.log(`${rows.length} runs, ${failed.length} failed fidelity; failures by guard:`, by);'
```

On this run: 325 runs, 162 failed — retention 135, ratio 126, novel 97,
echo 27, runaway 27, critical 8.

By hand: every FLUENT output of Granite 4.0 Micro and Qwen3 4B 2507 (above),
every output the first command listed, and at least one failed output of
every model. What they showed:

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

## Disk

The run had a ~20 GB budget for model weights on a disk shared with another
evaluation. The procedure (also in the reproduce loop below): `df -h /` before
every download, the file's sha256 checked against its pin, and the file
deleted as soon as its `summary.json` was written. The record, from the run
log of 2026-09-21 (every download and deletion; times local):

<details>
<summary>Download and deletion ledger (21 downloads)</summary>

| downloaded | model | for | free on `/` before | eval weights already on disk | bytes, sha256 verified | deleted |
|---|---|---|---|---|---|---|
| 05:21 | gemma-3-1b | first pass | 124G | 0 | 806,058,240 | 05:32 |
| 05:21 | gemma-3-4b | first pass | 123G | 806 MB | 2,489,757,856 | 05:40 |
| 05:22 | gemma-3-12b | first pass | 121G | 3,295 MB | 7,300,574,976 | 06:03 |
| 06:03 | qwen3.5-0.8b | first pass | 122G | 0 | 563,036,064 | 06:06 |
| 06:06 | lfm2-1.2b | first pass | 121G | 0 | 730,893,248 | 06:08 |
| 06:08 | lfm2-2.6b | first pass | 122G | 0 | 1,563,668,704 | 06:11 |
| 06:11 | granite-4.0-micro | first pass | 122G | 0 | 2,099,502,528 | 06:18 |
| 06:18 | phi-3.5-mini | first pass | 122G | 0 | 2,393,232,672 | 06:26 |
| 06:26 | qwen3-4b-2507 | first pass | 122G | 0 | 2,497,281,120 | 06:34 |
| 06:34 | gemma-3-4b-qat | first pass | 122G | 0 | 2,526,080,992 | 06:43 |
| 06:43 | ministral-3-3b | first pass | 121G | 0 | 3,651,679,744 | 06:58 |
| 06:58 | lfm2.5-8b-a1b | first pass | 121G | 0 | 5,155,564,768 | 07:06 |
| 07:06 | mistral-nemo-12b | first pass | 121G | 0 | 7,477,208,192 | 07:34 |
| 07:34 | gemma-3-4b | gated re-run | 120G | 0 | 2,489,757,856 | ≤ 07:45 ¹ |
| 07:45 | granite-4.0-micro | gated re-run (stopped) | 121G | 0 | 2,099,502,528 | 08:08 ² |
| 07:58 | gemma-3-4b | locked re-run 1 | 119G | 2,099 MB ² | 2,489,757,856 | 08:05 |
| 08:08 | qwen3-4b-2507 | locked re-run 1 | 120G | 0 | 2,497,281,120 | 08:13 |
| 09:51 | gemma-3-4b | locked re-run 2 | 122G | 0 | 2,489,757,856 | 09:57 |
| 09:58 | gemma-3-4b | locked re-run 3 | 122G | 0 | 2,489,757,856 | 10:04 |
| 10:34 | gemma-3-1b | first-batch check (V-12) | 122G | 0 | 806,058,240 | 10:36 |
| 10:34 | qwen3.5-0.8b | first-batch check (V-12) | 122G | 806 MB | 563,036,064 | 10:36 |

¹ The gated re-run's script deleted the file without logging it; the next
download (07:45) found 0 MB of eval weights on disk.
² That re-run was stopped mid-pass; its file stayed until the locked trio
deleted it at 08:08, which is the 2,099 MB the 07:58 download found.

</details>

From that record: free space never fell below **119 GB**; the most weights on
disk at once was **10.6 GB** (the three shipped Gemmas, fetched together at the
start; one model at a time after that); no candidate was skipped for disk or
for time; and every file was deleted — nothing was left at hand-back. One
more download is not in the ledger because it bypassed the download script: at
09:48 a mistaken run of the reproduce block fetched gemma-3-1b to `/tmp` and
ran two minutes of benchmark before it was stopped; the file was deleted at
09:51 and nothing from it is used. Only the raw outputs and JSON (a few MB)
were kept, outside the repository.

## Pins (probed 2026-09-21)

What every row above was judged on: the Hugging Face commit `resolve/main`
pointed to on 2026-09-21, and that file's sha256 and size (the headers the
registry's refresh recipe pins from). `--probe` reads today's `main`, so a
later probe may differ; this checks a row against its pinned revision instead:

```sh
curl -sI "https://huggingface.co/<repo>/resolve/<commit>/<file>" | grep -iE '^x-(linked-etag|linked-size)'
```

The measured models' downloaded bytes were verified against these sha256
values before each run, and each run's `manifest.json` records the hash
again.

| repo · file | commit | sha256 | bytes |
|---|---|---|---|
| ggml-org/gemma-3-1b-it-GGUF · `gemma-3-1b-it-Q4_K_M.gguf` | `f9c28bcd85737ffc5aef028638d3341d49869c27` | `8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135` | 806,058,240 |
| ggml-org/gemma-3-4b-it-GGUF · `gemma-3-4b-it-Q4_K_M.gguf` | `d0976223747697cb51e056d85c532013931fe52e` | `882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863` | 2,489,757,856 |
| ggml-org/gemma-3-12b-it-GGUF · `gemma-3-12b-it-Q4_K_M.gguf` | `ec0cbabd8dbff316f659876a50202295c3c4a314` | `7bb69bff3f48a7b642355d64a90e481182a7794707b3133890646b1efa778ff5` | 7,300,574,976 |
| ggml-org/Qwen3.5-0.8B-GGUF · `Qwen3.5-0.8B-Q4_0.gguf` | `8fea620810c4afa23dd6443f999a48574c1611a3` | `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf` | 563,036,064 |
| LiquidAI/LFM2-1.2B-GGUF · `LFM2-1.2B-Q4_K_M.gguf` | `5399e76c648f4eb8c053feb1ab747277dea5bf8b` | `55175400e3f509a9616227afeffd58d87e80b9f628a5d3d54ada884d85221fed` | 730,893,248 |
| LiquidAI/LFM2-2.6B-GGUF · `LFM2-2.6B-Q4_K_M.gguf` | `a759abdc5955d4ca97763e5cb7ff3940589ba898` | `384bc877b6c37064982f96885bef69e4475919f5969218ed4e3b9399ae0340df` | 1,563,668,704 |
| ibm-granite/granite-4.0-micro-GGUF · `granite-4.0-micro-Q4_K_M.gguf` | `ec48475f0c811d812fbfb61975717a9c36eeb652` | `97c417dcc0534b0737c74016fb2af083cb17c3b51eaac621192d23961b7024eb` | 2,099,502,528 |
| bartowski/Phi-3.5-mini-instruct-GGUF · `Phi-3.5-mini-instruct-Q4_K_M.gguf` | `6d70da17e749a471ccb62ade694486011a75cda3` | `e4165e3a71af97f1b4820da61079826d8752a2088e313af0c7d346796c38eff5` | 2,393,232,672 |
| unsloth/Qwen3-4B-Instruct-2507-GGUF · `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | `a06e946bb6b655725eafa393f4a9745d460374c9` | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` | 2,497,281,120 |
| ggml-org/gemma-3-4b-it-qat-GGUF · `gemma-3-4b-it-qat-Q4_0.gguf` | `bbcac0d065076c47042838c0675c602411b0dd4c` | `ee91c3e7a4ab95d8c95672f9fcb58bf236b257e9f217966bcf53a5a6df4ab49a` | 2,526,080,992 |
| ggml-org/Ministral-3-3B-Instruct-2512-GGUF · `Ministral-3-3B-Instruct-2512-Q8_0.gguf` | `742ab8db17d5c8ee5dc8f5afb5acfc2da1c33b26` | `70c6e5b77435062a46bfa3f0b9fa21744a10161ed23eabe9fdc47b3fb6711ad3` | 3,651,679,744 |
| LiquidAI/LFM2.5-8B-A1B-GGUF · `LFM2.5-8B-A1B-Q4_K_M.gguf` | `49c14831707011e64d70b2ebd8462ba08d608434` | `4923ec14f06b968b74d663e5949867d2d9c3bf13a20b8be1a9f9af39989b2bb0` | 5,155,564,768 |
| bartowski/Mistral-Nemo-Instruct-2407-GGUF · `Mistral-Nemo-Instruct-2407-Q4_K_M.gguf` | `a2dd64a0a76ea1bdb2bb6ab6fa5496b003c7c908` | `7c1a10d202d8788dbe5628dc962254d10654c853cae6aaeca0618f05490d4a46` | 7,477,208,192 |
| ggml-org/gemma-4-E2B-it-GGUF · `gemma-4-E2B-it-Q4_0.gguf` | `b4243c156154b6dca9324415f8c7ccc098b4aed1` | `8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52` | 2,841,481,184 |
| ggml-org/gemma-4-E4B-it-GGUF · `gemma-4-E4B-it-Q4_0.gguf` | `b8093469224f83f5c38f691eb906c380e9e63114` | `a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2` | 4,590,807,392 |
| ggml-org/Laguna-XS-2.1-GGUF · `Laguna-XS-2.1-Q4_K_M.gguf` | `273068c9ae4ee6efea803da861aa404d115d3023` | `0a8301bc1b8509b27ed39ec86b98278c03341db6311c065326bd6629cd7304d6` | 19,563,570,240 |
| Qwen/Qwen2.5-7B-Instruct-GGUF · `qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf` | `bb5d59e06d9551d752d08b292a50eb208b07ab1f` | `dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db` | 3,993,201,344 |
| Qwen/Qwen2.5-3B-Instruct-GGUF · `qwen2.5-3b-instruct-q4_k_m.gguf` | `7dabda4d13d513e3e842b20f0d435c732f172cbe` | `626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d` | 2,104,932,768 |
| unsloth/Qwen3-4B-GGUF · `Qwen3-4B-Q4_K_M.gguf` | `22c9fc8a8c7700b76a1789366280a6a5a1ad1120` | `f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a` | 2,497,281,312 |
| microsoft/Phi-3-mini-4k-instruct-gguf · `Phi-3-mini-4k-instruct-q4.gguf` | `a64113399c2f6b8ad3e11c394733a2ddadaa7f33` | `8a83c7fb9049a9b2e92266fa7ad04933bb53aa1e85136b7b30f1b8000ff2edef` | 2,393,231,072 |
| tiiuae/Falcon3-3B-Instruct-GGUF · `Falcon3-3B-Instruct-q4_k_m.gguf` | `142f28a7f0ec90e701157ec3c4e9842e9471dfcd` | `ac9bc2edb58a961f77db11ae89e7f23b610d8b15c2ef603d1e7cb390c50d1aad` | 2,005,684,448 |
| HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF · `smollm2-1.7b-instruct-q4_k_m.gguf` | `2d4a76a30b4af41ecd395c35725ac11688d4cfe4` | `decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33` | 1,055,609,536 |
| Qwen/Qwen2.5-1.5B-Instruct-GGUF · `qwen2.5-1.5b-instruct-q4_k_m.gguf` | `91cad51170dc346986eccefdc2dd33a9da36ead9` | `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` | 1,117,320,736 |
| ggml-org/SmolLM3-3B-GGUF · `SmolLM3-Q4_K_M.gguf` | `4965cb60b150737b68a0408c36aeefb65078f894` | `8334b850b7bd46238c16b0c550df2138f0889bf433809008cc17a8b05761863e` | 1,915,305,312 |
| bartowski/Llama-3.2-3B-Instruct-GGUF · `Llama-3.2-3B-Instruct-Q4_K_M.gguf` | `5ab33fa94d1d04e903623ae72c95d1696f09f9e8` | `6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff` | 2,019,377,696 |

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
- **Quality, as the model returned it.** Fillers (`um`/`uh`/`erm`, skipping
  an all-caps "UM" as the backstop does), repeats the backstop would collapse,
  and the directive's other fillers where they are unmistakably fillers (`er`,
  `mm`, "kind of like", ", like,", a sentence-opening "Like,"/"So like", "I
  mean," and a filler "you know" — never "something like X" or "do you know"),
  all counted on the model's own output. The
  delivered count after `stripStumbles` is reported too, but it cannot decide
  anything: the backstop brings every model close to zero.
- **Fidelity guards**, any failure fails the run: output/input length ratio
  (FLUENT 0.85–1.05, others 0.70–1.10); content-word retention ≥ 0.90 (function
  words and fillers excluded); at most 10% of the output's content words new
  (words the speaker never said); every negation, scope word, number and
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
  context. Decode tokens/s leaves out the first `onToken` batch, whose size
  is recorded per clean; on this engine it was 1 token in every clean checked
  (8 of 8, gemma-3-1b and qwen3.5-0.8b), so the published rates, which
  assumed 1, stand. A GPU pass (FLUENT/`clean` only) is a footnote and never decides
  anything. Where speed could decide a verdict, the pass was repeated holding a
  CPU lock shared with the other benchmark on the machine; the bar uses each
  model's least-contended pass and the report shows the fastest clean of all
  passes beside it.
- **The catalog bar** (`meetsBar`): against the shipped Gemma nearest in file
  size, a candidate must have a shippable licence; strictly fewer model-stage
  fillers + repeats + other fillers on FLUENT/`clean` over the five seeds and no fewer clean
  runs; no more on FLUENT/`polished`; no fidelity failure on FLUENT and a
  median retention at least the Gemma's; and a median FLUENT/`clean`
  wall-clock no slower. A quality tie is not a win, even when faster.

## Reproduce

Everything below runs from the repository root and writes outside it. It is
the exact sequence behind this page: 13 models, one at a time (download,
check, CPU pass, GPU pass, delete), then the verdict trio re-timed under a CPU
lock, then Gemma 3 4B's extra passes, then the tables. The whole run takes
about two and a half hours on the hardware above and never holds more than
one model's weights (at most 7.5 GB) on disk.

```sh
OUT=/tmp/cleanup-bench          # saved runs: manifests, scores, raw outputs
MODELS=/tmp/cleanup-models      # weights, one model at a time
LOCK=/tmp/cpu-quiet.lock        # any lock file every heavy job on the machine agrees on
mkdir -p "$OUT" "$OUT-rerun" "$OUT-locked" "$OUT-locked2" "$OUT-locked3" "$MODELS"

fetch() {  # <repo> <commit> <file>: download a pinned file after a disk check
  df -h /                        # the run kept eval weights under ~20 GB
  curl -fL -o "$MODELS/$3" "https://huggingface.co/$1/resolve/$2/$3" </dev/null
  sha256sum "$MODELS/$3"         # compare with the Pins table above
}

# 1. Every measured model: id, repo, pinned commit, file.
while read -r id repo commit file; do
  fetch "$repo" "$commit" "$file"
  node scripts/bench-cleanup.mjs --out="$OUT" --id="$id" "$MODELS/$file" </dev/null
  node scripts/bench-cleanup.mjs --out="$OUT" --id="$id" --gpu "$MODELS/$file" </dev/null
  rm "$MODELS/$file"             # delete before the next download
done <<'PINS'
gemma-3-1b ggml-org/gemma-3-1b-it-GGUF f9c28bcd85737ffc5aef028638d3341d49869c27 gemma-3-1b-it-Q4_K_M.gguf
gemma-3-4b ggml-org/gemma-3-4b-it-GGUF d0976223747697cb51e056d85c532013931fe52e gemma-3-4b-it-Q4_K_M.gguf
gemma-3-12b ggml-org/gemma-3-12b-it-GGUF ec0cbabd8dbff316f659876a50202295c3c4a314 gemma-3-12b-it-Q4_K_M.gguf
qwen3.5-0.8b ggml-org/Qwen3.5-0.8B-GGUF 8fea620810c4afa23dd6443f999a48574c1611a3 Qwen3.5-0.8B-Q4_0.gguf
lfm2-1.2b LiquidAI/LFM2-1.2B-GGUF 5399e76c648f4eb8c053feb1ab747277dea5bf8b LFM2-1.2B-Q4_K_M.gguf
lfm2-2.6b LiquidAI/LFM2-2.6B-GGUF a759abdc5955d4ca97763e5cb7ff3940589ba898 LFM2-2.6B-Q4_K_M.gguf
granite-4.0-micro ibm-granite/granite-4.0-micro-GGUF ec48475f0c811d812fbfb61975717a9c36eeb652 granite-4.0-micro-Q4_K_M.gguf
phi-3.5-mini bartowski/Phi-3.5-mini-instruct-GGUF 6d70da17e749a471ccb62ade694486011a75cda3 Phi-3.5-mini-instruct-Q4_K_M.gguf
qwen3-4b-2507 unsloth/Qwen3-4B-Instruct-2507-GGUF a06e946bb6b655725eafa393f4a9745d460374c9 Qwen3-4B-Instruct-2507-Q4_K_M.gguf
gemma-3-4b-qat ggml-org/gemma-3-4b-it-qat-GGUF bbcac0d065076c47042838c0675c602411b0dd4c gemma-3-4b-it-qat-Q4_0.gguf
ministral-3-3b ggml-org/Ministral-3-3B-Instruct-2512-GGUF 742ab8db17d5c8ee5dc8f5afb5acfc2da1c33b26 Ministral-3-3B-Instruct-2512-Q8_0.gguf
lfm2.5-8b-a1b LiquidAI/LFM2.5-8B-A1B-GGUF 49c14831707011e64d70b2ebd8462ba08d608434 LFM2.5-8B-A1B-Q4_K_M.gguf
mistral-nemo-12b bartowski/Mistral-Nemo-Instruct-2407-GGUF a2dd64a0a76ea1bdb2bb6ab6fa5496b003c7c908 Mistral-Nemo-Instruct-2407-Q4_K_M.gguf
PINS

# 2. Re-time the rows where speed could decide a verdict, FLUENT only, each
#    pass holding the shared CPU lock so no other heavy job runs beside it.
while read -r id repo commit file; do
  fetch "$repo" "$commit" "$file"
  flock "$LOCK" node scripts/bench-cleanup.mjs --out="$OUT-locked" --id="$id" --corpus=fluent "$MODELS/$file" </dev/null
  rm "$MODELS/$file"
done <<'PINS'
gemma-3-4b ggml-org/gemma-3-4b-it-GGUF d0976223747697cb51e056d85c532013931fe52e gemma-3-4b-it-Q4_K_M.gguf
granite-4.0-micro ibm-granite/granite-4.0-micro-GGUF ec48475f0c811d812fbfb61975717a9c36eeb652 granite-4.0-micro-Q4_K_M.gguf
qwen3-4b-2507 unsloth/Qwen3-4B-Instruct-2507-GGUF a06e946bb6b655725eafa393f4a9745d460374c9 Qwen3-4B-Instruct-2507-Q4_K_M.gguf
PINS

# 3. The other Gemma 3 4B passes in the speed table, in the order they ran.
#    None was quiet; they are listed for transparency, and the bar's rule
#    picks the last one (see "Speed passes and load").
G4="ggml-org/gemma-3-4b-it-GGUF d0976223747697cb51e056d85c532013931fe52e gemma-3-4b-it-Q4_K_M.gguf"
# 3a. A re-run that started only once the 1-minute load was below 14.
fetch $G4
until awk '{exit !($1 < 14)}' /proc/loadavg; do sleep 15; done
node scripts/bench-cleanup.mjs --out="$OUT-rerun" --id=gemma-3-4b --corpus=fluent "$MODELS/gemma-3-4b-it-Q4_K_M.gguf" </dev/null
# 3b, 3c. Two more passes holding the lock, each started below load 14.
for pass in 2 3; do
  flock "$LOCK" sh -c 'until awk "{exit !(\$1 < 14)}" /proc/loadavg; do sleep 15; done
    node scripts/bench-cleanup.mjs --out="$0" --id=gemma-3-4b --corpus=fluent "$1" </dev/null' \
    "$OUT-locked$pass" "$MODELS/gemma-3-4b-it-Q4_K_M.gguf"
done
rm "$MODELS/gemma-3-4b-it-Q4_K_M.gguf"

# 4. Re-score every pass with the current scoring (only needed if it changed
#    since the runs), then print every table on this page. The order of
#    --locked decides the "locked re-run 1/2/3" labels.
for d in "$OUT" "$OUT-rerun" "$OUT-locked" "$OUT-locked2" "$OUT-locked3"; do
  node scripts/bench-cleanup.mjs --rescore "$d"
done
node scripts/bench-cleanup.mjs --report "$OUT" --also="$OUT-rerun" \
  --locked="$OUT-locked" --locked="$OUT-locked2" --locked="$OUT-locked3" \
  --licences=qwen3.5-0.8b=apache-2.0,lfm2-1.2b=lfm1.0,lfm2-2.6b=lfm1.0,granite-4.0-micro=apache-2.0,phi-3.5-mini=mit,qwen3-4b-2507=apache-2.0,gemma-3-4b-qat=gemma,ministral-3-3b=apache-2.0,lfm2.5-8b-a1b=lfm1.0,mistral-nemo-12b=apache-2.0
```

The shipped Gemmas need no `--licences` entry (they are "gemma"); a candidate
missing from it reports as "unknown", which the bar treats as not shippable.
Step 3 and the `--also`/`--locked` arguments reproduce the extra Gemma 3 4B
passes in the speed table. On a quiet machine they will time differently;
here all of them ran contended.

Check a candidate on Hugging Face without downloading it:

```sh
node scripts/bench-cleanup.mjs --probe unsloth/Qwen3-4B-Instruct-2507-GGUF Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

Each run writes `manifest.json` (file, sha256, backend, threads, chat
wrapper, hardware, load average), `runs.jsonl`, `summary.json` and every raw
output under `--out/<id>/`.
