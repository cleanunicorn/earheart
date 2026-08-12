// AudioWorklet processor: forwards raw Float32 PCM chunks (and an RMS level
// for the visualizer) from the audio thread to the overlay.
//
// Render quanta are batched before posting: a 128-sample quantum at 16 kHz is
// 8ms, so a message per quantum means ~125 posts/sec — each one a structured
// clone and one more entry in the overlay's chunk list (a 5-minute take used
// to accumulate ~37k chunks). Coalescing to ~32ms per post cuts that traffic
// 4× with no audible or visual difference: the meter reads levels on an
// animation-frame loop anyway, and 32ms still outpaces a 60 Hz refresh. Each
// post costs exactly one copy — the slice out of the reused batch buffer —
// because the slice's buffer is transferred with the message, not cloned.

// ~32ms of audio in whole 128-sample render quanta, derived from the rate the
// overlay actually created the context with (the AudioWorkletGlobalScope
// `sampleRate` global), so the timing holds if that rate ever changes.
const BATCH_SAMPLES = Math.max(1, Math.round((sampleRate * 0.032) / 128)) * 128;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // "stop" retires this processor. Returning false from process() makes the
    // node collectable — the overlay's AudioContext is shared and long-lived,
    // so a processor that kept returning true would keep running (and leak)
    // for every past dictation. Before the {flushed} reply, any partly filled
    // batch is posted, so the reply is still ordered after every sample this
    // processor ever captured — when the overlay sees it, the dictation's tail
    // has fully arrived and the WAV can be encoded without clipping.
    //
    // "drain" flushes without stopping: the overlay sends it when the user
    // pauses, so the partial batch — which holds the last pre-pause syllable —
    // is handed over BEFORE the overlay starts discarding paused-era messages.
    // The {drained} confirm is ordered after that post, so when the overlay
    // sees it, everything captured before the pause has safely arrived.
    this.stopped = false;
    this.batch = new Float32Array(BATCH_SAMPLES);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ flushed: true });
      } else if (event.data === "drain") {
        this.flush();
        this.port.postMessage({ drained: true });
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    const samples = this.batch.slice(0, this.filled);
    this.filled = 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    // Transfer, don't clone: the slice above is already a private copy, so
    // moving its buffer makes the whole post zero additional bytes.
    this.port.postMessage({ samples, rms }, [samples.buffer]);
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // Copy: the engine reuses the input buffer between calls. The split
      // loop tolerates a quantum that would overfill the batch — the spec
      // reserves the right to vary the render quantum size.
      let i = 0;
      while (i < channel.length) {
        const take = Math.min(channel.length - i, BATCH_SAMPLES - this.filled);
        this.batch.set(channel.subarray(i, i + take), this.filled);
        this.filled += take;
        i += take;
        if (this.filled === BATCH_SAMPLES) this.flush();
      }
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
