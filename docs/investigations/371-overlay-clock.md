# Overlay clock stall investigation (#371)

The initial investigation (`e9e97c0`) added regression coverage and measurements
without changing production capture. The maintainer subsequently approved the
bounded same-take recovery in this thread. The approved follow-up and its
validation are recorded below; the baseline evidence remains separate.

## Scope and method

Baseline: main `37508c21bf73ca6fa16413db1660d0e0031f9648`, verified through the
GitHub commits API on 2026-11-08. The renderer is unchanged in this investigation.
No comparison here attributes the failure to #370.

Environment: Ubuntu 26.04.1 x64, Linux 6.17.0-40-generic, AMD Ryzen 9 3900X
(12 cores / 24 threads), Node 24.14.1 for tests;
Electron 42.11.16, Chromium 148.0.7778.280, Electron Node 24.19.0 for capture.
Dependencies installed with `npm ci` and `npx --no install-electron`.

The host's default Xvfb crashes during NVIDIA EGL initialization. All successful
Electron launches use `-screen 0 1280x720x24 -extension GLX`. GPU initialization
warnings remain. These counts must not be pooled with the issue's earlier host
measurements; the display configuration and Chromium version may affect rates.

`scripts/overlay-clock-stress.js` supplies three core cases, each in a fresh isolated
profile and one persistent overlay page:

- `overlay`: the real renderer receives `record:start`, immediately followed by
  `record:stop`, then a new SID records a full take. Session 2 must terminate as
  `record:cancelled`. Session 3 must become live and return a nonempty, non-silent
  WAV for its SID after 1.2 seconds. Stop is never replaced with cancel in the
  reproduction sequence.
- `runtime`: uses the overlay window and warmed context, but replaces the
  application's capture lifecycle with a small graph using platform APIs and
  the real recorder worklet. The constraints, sample rate, graph topology and
  immediate stop/disconnect/track-stop/suspend ordering match the application.
  It verifies samples for the new SID, without application WAV encoding.
- `runtime-serial`: the same minimal graph, but suspend waits for the preceding
  resume promise and the next resume waits for that suspend. This tests a whole
  transition chain, beyond merely awaiting an in-flight suspend before resume.

The harness subscribes to terminal IPC by sender and SID and removes every
listener in `finally`. Failure cleanup cancels the overlay instead of waiting
for an impossible `audio:captured`. Minimal-runtime failures close and rebuild
the failed context before the next iteration to avoid counting one permanent
stall repeatedly. This is harness isolation, not application recovery.

Clock observations pair `currentTime` with renderer `performance.now()` at
roughly 100 ms intervals. Lifecycle logs include call and promise-completion
state/time for resume, suspend and close; a port listener counts all posts.
A flat clock across measured wall time with no new posts is stronger evidence
than `state === "running"`. Polling intervals are observed, not assumed.
Instrumentation adds overhead and can affect race frequency.

Sampling rule fixed before baseline: 120 iterations per condition. Extend both
overlay and runtime to 600 under a load condition only if overlay has at least
two frozen-clock failures and runtime has none. Otherwise retain the 120 sample
and report its limits. The serial control is 120 iterations. Loaded means a
continuous `make test` loop on this checkout, with no second capture harness
running concurrently. Unloaded means no intentional test load.

Example:

```sh
xvfb-run -a -s '-screen 0 1280x720x24 -extension GLX' \
  npx electron scripts/overlay-clock-stress.js --no-sandbox overlay 120
# Repeat with runtime and runtime-serial.
# For loaded samples, run `while true; do make test >load.log 2>&1; done`
# in another shell and retain the log and test exit results.
```

## Deterministic coverage

`test/overlay-engine.test.js` runs the real overlay and worklet in the VM. It
checks a running context with no rendering: the watchdog fires at 10 seconds,
releases the microphone, closes the cached context and permits the next SID to
capture with a fresh engine. It also covers pending-acquisition stop followed
by reuse, held posts from retired nodes, watchdog ownership across supersession,
a stale microphone grant releasing its own track without parking the current
session, and a stopped take finishing its held tail under its own SID after a new
take starts. A pending permission grant can outlast the sample watchdog without
timing out. These tests cover handling and ownership, not Chromium's root cause.

The fixture now gives each context its own clock, each queued post its originating
node and each granted stream its own track with observable release. Before that
change, the new tests failed on untracked track state and wrong-node message
routing. Existing cue/capture tests still run through the real worklet.

## Results and interpretation

The unloaded overlay baseline produced 3 failures / 120 iterations. A preliminary
2-iteration harness pilot also produced one stall; that pilot is reported
separately and excluded from the baseline counts.

For example, iteration 10 of the baseline recorded this timeline (milliseconds
from renderer `performance.now()`, audio time in seconds):

| Event | Wall ms | State | Audio time |
| --- | ---: | --- | ---: |
| Session 2 resume called | 14641.8 | suspended | 13.184 |
| Session 2 suspend called | 14643.7 | suspended | 13.184 |
| Suspend completed | 14643.9 | suspended | 13.192 |
| Earlier resume completed | 14644.0 | running | 13.192 |
| Session 3 resume called | 14654.3 | running | 13.192 |
| Session 3 resume completed | 14654.6 | running | 13.192 |
| Last pre-timeout observation | 24649.5 | running | 13.192 |
| Watchdog closes engine | 24655.9 | suspended | 13.192 |

The last observation still had SID 1021, zero chunks and a live, unmuted,
enabled track. The post counter remained 1 (the prior node's flush confirmation)
throughout. The application then emitted `record:error` for SID 1021. This
reproduces the issue's signature, rather than just a slow `getUserMedia`.

The three baseline failures all exhibit suspend completion before the earlier
resume completion. That ordering is a candidate trigger, not proof by itself:
successful iterations also contain overlapping transitions. The Web Audio
specification distinguishes control and rendering threads and asynchronously
completes state transitions; reported state alone does not establish clock
progress. See [AudioContext resume and suspend algorithms](https://www.w3.org/TR/webaudio/#dom-audiocontext-resume).

The application extension completed 0/480, for an unloaded aggregate of 3/600.
Extensions are additional fresh-profile batches, not continuations of the original
page. The runtime extension completed 0/480, for an aggregate of 0/600. Both
loaded cases had failures,
so the predeclared rule does not extend those cases beyond 120.

| Case | Unloaded failures / iterations | Loaded failures / iterations |
| --- | ---: | ---: |
| Application | 3 / 600 | 4 / 120 |
| Minimal runtime | 0 / 600 | 4 / 120 |
| Serialized minimal runtime | 0 / 120 | 0 / 120 |
| 30 ms gap (exploratory) | 0 / 10 | not run |

No passing sample alone establishes a fix or the absence of a race. The serial
control changes timing as well as ordering, so its passing counts do not prove
that awaiting transitions is sufficient. The gap sample is too small to rule
out timing sensitivity. These sequential runs do not control all host background
activity or estimate a stable population failure rate.

An additional exploratory `runtime-gap` case gives the minimal graph 30 ms
between cancellation and the next start, without serializing its earlier
resume/suspend. This tests timing sensitivity: in many successful minimal
iterations both resume promises complete together during session 3, whereas
the failing application traces complete the earlier resume before session 3.
This control is a separate sample, not pooled with `runtime`.

The loaded 120-iteration samples have 4 failures in the application and 4 in
the minimal runtime. Minimal-runtime iteration 40 recorded `currentTime = 52.832` from wall time 53602.4 to 64467.3 ms (10864.9 ms), `state = running`,
SID 1081, zero samples, a live/unmuted/enabled track and an unchanged post count.
Its first resume completed after suspend, then the next resume completed
immediately without advancing the clock. This reproduces the signature without
calling the application's start/stop/generation/cue/status code. It does not
isolate Chromium internals from the platform audio backend or prove an upstream
bug. The graph still uses the application's window, warm-up and recorder module.

## Recovery proposal and approval

The reviewed plan required maintainer approval before changing production capture
recovery; that approval was given in this thread. The approved behavior is one same-take rebuild only when **no first sample
post has arrived**, the granted track remains live/enabled/unmuted, resume has
resolved, the context reports running, and its clock has remained unchanged
for at least one measured second across multiple wall-clock probes. Keep the
existing ten-second overall startup deadline and the Starting status, reuse the
selected granted stream on a fresh 16 kHz context/worklet, and retry at most once.
If the new graph also fails, release it and send the existing SID-scoped error.
Stop/discard/supersession must invalidate the rebuild and release its nodes;
retired callbacks must not claim the successor's samples, watchdog or cues.

The implementation is validated with deterministic tests for frozen versus advancing clocks,
late old posts, retry exhaustion, stop/discard/supersession during every await,
cue-on capture alignment and cleanup, followed by smoke and matched stress runs.
A serialized transition chain is another experiment; a passing stress sample
for that control would not establish a fix by itself. The initial investigation commit includes neither remedy; the approved
follow-up implements the bounded rebuild.

## Initial investigation validation and limits

The full unit suite currently fails at module load in
`test/release-contract.test.js`: main's `37508c2` removes `AGENTS.md`, but the test
still reads it. The load loop also exposed a ducking latency assertion under CPU
contention (674 ms against a 600 ms budget). Those failures are retained and
reported separately; they are not changes to the microphone lifecycle tests.
The final unloaded `make test` run has the same sole release-contract module-load
failure: 1640 pass, 3 skip, 1 failing file. All six new engine tests pass. A separate
run of the remaining `*.test.js` files has 1638 pass, 3 skip and no failures.
After the harness listener-cleanup adjustment, all four modes pass two sanity
iterations each; these are validation probes, excluded from the table above.
Raw JSONL timelines, environment/version records, exit statuses, smoke logs,
unit logs and the analysis script are retained under this BB thread's
`issue-371` storage directory. The continuous load loop completed 23 test runs;
each failed on the pre-existing release-contract error, and the retained history
also contains one ducking timing failure. Load-run exit statuses, the last full
load log and the followed log history are retained (the earliest overwritten
load logs are not available).

`make smoke`, `make engine-smoke`, `make overlay-smoke` (99 checks), and
`make settings-smoke` (211 checks) pass using a temporary `xvfb-run` wrapper that
supplies the display flags above; the Makefile is unchanged. The native engine
smoke successfully loaded both STT and cleanup addons. macOS and Windows capture
were not exercised on this Linux host.


## Approved recovery implementation

Before the first sample post, the overlay probes `currentTime` every 250 ms.
After resume resolves, a running context whose clock stays unchanged for at
least one measured second is eligible for one replacement, provided its granted
track is live, enabled and unmuted. The probe uses `performance.now()` and stops
on the first sample post, including samples inside a start-cue guard. An
advancing clock with delayed posts and a muted/ended track use the normal
watchdog instead. Recovery does not run after recording has become live.

The retry retires the old source and worklet, closes the context and warms a
fresh 16 kHz engine. It reconnects the same stream under the same SID, keeps the
Starting status until real samples arrive and arms no second clock probe. The
original ten-second watchdog and all session timers remain in place. A failed
replacement releases the stream and reports one error. Stop/discard/cancellation
or a superseding take invalidates any pending reconnect.

The cache now publishes pending contexts so reset can close a replacement whose
module is still loading. A late warm-up success or failure cannot publish over a
newer context or clear its cached promise. The normal overlap of resume and graph
setup is retained; this change handles a measured stall rather than claiming to
correct Chromium's transition ordering.

`test/overlay-clock-recovery.test.js` covers one retry on the same stream/SID,
original-deadline exhaustion, advancing clocks with delayed posts, ineligible
tracks/states, unresolved resume, wall-clock jumps, stop/discard/cancel and
supersession during replacement, module and suspend completion after timeout,
late resume after cancellation, construction failure cleanup, retired messages
and exact cue-guard WAV samples. This supplements the original engine and cue
integration tests.

The harness accepts `--freeze-first` in overlay mode: the first real engine stays
suspended while its state/resume surface reports running. The replacement is
unmodified and must capture non-silent fake-device audio. Two injected native
iterations passed; the first replacement closed the frozen engine approximately
1000.9 ms after its resume and returned a non-silent WAV under SID 1001. This
validates the recovery handling independently of whether a probabilistic run
happens to encounter the Chromium/runtime stall.

Post-change native sampling was fixed at 120 unloaded and 120 loaded application
iterations, with the same environment, capture checks and continuous unit-test
load as the initial investigation. Both samples finished with zero failures and
zero observed retries. No natural stall appeared in those samples; the initial
investigation itself had 0/480 in one application batch, so the passing stress
samples alone establish no fix. The deterministic and injected native failures
provide the direct evidence for the approved handling behavior.

All 19 new recovery tests passed in the final suite. Final full `make test`:
1659 pass, 3 skip, 1 failing file, the same pre-existing release-contract read of
missing `AGENTS.md`. All remaining `*.test.js` files: 1657 pass, 3 skip, zero
failures. All seven complete load-loop test runs have that same sole existing
failure, with their full individual logs retained. The app/engine/overlay/settings
smoke checks all pass, including overlay 99/99, settings 211/211 and both native
engine imports, using the previously documented Xvfb workaround. macOS/Windows
validation remains for the platform CI gates.

Follow-up raw evidence is retained under the `issue-371/recovery` directory in
this BB thread's storage, separate from the pre-approval measurements.
