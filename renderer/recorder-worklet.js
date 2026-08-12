// AudioWorklet processor: forwards raw Float32 PCM chunks (and an RMS level
// for the visualizer) from the audio thread to the overlay.
//
// Render quanta are batched before posting: at 16 kHz a quantum is 128 samples
// (8ms), and a message per quantum means ~125 posts/sec — each one a copy, a
// structured clone, and one more entry in the overlay's chunk list (a 5-minute
// take used to accumulate ~37k chunks). Coalescing to BATCH_SAMPLES per post
// cuts that traffic 4× with no audible or visual difference: the meter reads
// levels on an animation-frame loop anyway, and 32ms is still twice as fast as
// a 60 Hz refresh consumes them.

const BATCH_SAMPLES = 512; // 32ms at 16 kHz — 4 render quanta per post

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
    this.stopped = false;
    this.batch = new Float32Array(BATCH_SAMPLES);
    this.filled = 0;
    this.sumSquares = 0; // running Σs² over the current batch, for its RMS
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ flushed: true });
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    const samples = this.batch.slice(0, this.filled);
    const rms = Math.sqrt(this.sumSquares / this.filled);
    this.port.postMessage({ samples, rms });
    this.filled = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      let i = 0;
      while (i < channel.length) {
        const take = Math.min(channel.length - i, BATCH_SAMPLES - this.filled);
        for (let j = i; j < i + take; j++) {
          this.sumSquares += channel[j] * channel[j];
        }
        // Copy: the engine reuses the input buffer between calls.
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
