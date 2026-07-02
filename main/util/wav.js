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

/**
 * Decode a mono PCM16 WAV buffer to float32 samples in [-1, 1], the shape the
 * in-process Parakeet engine wants. Walks the RIFF chunk list to find `fmt `
 * (for the sample rate) and `data`, so it tolerates WAVs with extra chunks.
 *
 * Only the format the overlay produces is supported: PCM (format 1), 16-bit,
 * mono. Anything else throws — callers fall back to the HTTP STT path.
 *
 * @param {Buffer} buf
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
function wavToFloat32(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  const { format, channels, sampleRate, bitsPerSample, dataOffset, dataSize } =
    parseRiffChunks(buf);

  if (dataOffset < 0) throw new Error("WAV has no data chunk");
  if (format !== 1 || bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV format (format=${format}, bits=${bitsPerSample})`);
  }

  const frameCount = Math.floor(dataSize / 2 / channels);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    // Mixdown to mono by averaging channels (overlay audio is already mono).
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += buf.readInt16LE(dataOffset + (i * channels + c) * 2);
    }
    samples[i] = acc / channels / 32768;
  }
  return { samples, sampleRate };
}

// Walk the RIFF chunk list once and collect the fmt/data fields both readers
// need. Tolerant by design: absent chunks leave the canonical defaults (16 kHz
// mono PCM16, no data) for the caller to judge — wavToFloat32 validates and
// throws, wavDurationSec floors.
function parseRiffChunks(buf) {
  let sampleRate = SAMPLE_RATE;
  let format = 1;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, buf.length - body);
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    pos = body + size + (size & 1);
  }
  return { format, channels, sampleRate, bitsPerSample, dataOffset, dataSize };
}

/**
 * Duration in seconds of a PCM16 WAV buffer. Walks the RIFF chunk list like
 * wavToFloat32 (rather than assuming a fixed 44-byte header) so extra chunks
 * never skew the result. Best-effort by design — it feeds progress estimates,
 * not decoding — so a malformed buffer yields the 0.01s floor instead of a
 * throw (the floor also keeps downstream divisions safe).
 * @param {Buffer} buf
 * @returns {number} seconds, >= 0.01
 */
function wavDurationSec(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const { channels, sampleRate, dataSize } = parseRiffChunks(buf);
  const frames = dataSize / 2 / Math.max(1, channels);
  return Math.max(0.01, frames / Math.max(1, sampleRate));
}

module.exports = { encodeWav, encodeSilenceWav, wavToFloat32, wavDurationSec, SAMPLE_RATE };
