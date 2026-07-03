// AudioWorklet processor: forwards raw Float32 PCM chunks (and an RMS level
// for the visualizer) from the audio thread to the overlay.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // "stop" retires this processor. Returning false from process() makes the
    // node collectable — the overlay's AudioContext is shared and long-lived,
    // so a processor that kept returning true would keep running (and leak)
    // for every past dictation. The {flushed} reply is posted after every
    // sample message this processor ever sent (port messages are ordered), so
    // when the overlay sees it, the last in-flight chunks of the dictation
    // have all arrived and the WAV can be encoded without clipping the tail.
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.stopped = true;
        this.port.postMessage({ flushed: true });
      }
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      let sum = 0;
      for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
      const rms = Math.sqrt(sum / channel.length);
      // Copy: the engine reuses the input buffer between calls.
      this.port.postMessage({ samples: channel.slice(0), rms });
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
