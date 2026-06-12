// Minimal WAV (RIFF, PCM16) helpers used by the main process.

const SAMPLE_RATE = 16000;

/**
 * Encode mono PCM16 samples as a WAV file buffer.
 * @param {Int16Array} samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

/**
 * A silent WAV clip, used by connection tests.
 * @param {number} seconds
 */
function encodeSilenceWav(seconds) {
  return encodeWav(new Int16Array(Math.round(SAMPLE_RATE * seconds)));
}

module.exports = { encodeWav, encodeSilenceWav, SAMPLE_RATE };
