// AudioWorklet processor: forwards raw Float32 PCM chunks (and an RMS level
// for the visualizer) from the audio thread to the overlay.

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
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
