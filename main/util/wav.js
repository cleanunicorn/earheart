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
 * Decode a WAV buffer to float32 mono samples. Handles PCM16 and 32-bit
 * float, mono or multi-channel (channels are averaged to mono). This is what
 * the in-app Parakeet recognizer needs as input — the renderer hands us the
 * WAV produced by encodeWav(), but we stay lenient so the same path works for
 * connection-test clips and any well-formed RIFF/WAVE file.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} input
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
function decodeWav(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file (missing RIFF/WAVE header)");
  }

  let offset = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  // Walk the chunk list rather than assuming the canonical 44-byte layout, so
  // files with extra chunks (LIST, fact, …) still decode.
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataStart = body;
      // Clamp to the real buffer length; some encoders write a streaming-style
      // size of 0 or a value past EOF.
      dataLen = Math.min(size || buf.length - body, buf.length - body);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new Error("WAV file has no fmt chunk");
  if (dataStart < 0) throw new Error("WAV file has no data chunk");

  const { channels, sampleRate, bitsPerSample, format } = fmt;
  const isFloat = format === 3;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLen / (bytesPerSample * channels));
  const out = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const pos = dataStart + (i * channels + c) * bytesPerSample;
      if (isFloat && bitsPerSample === 32) {
        sum += buf.readFloatLE(pos);
      } else if (bitsPerSample === 16) {
        sum += buf.readInt16LE(pos) / 32768;
      } else if (bitsPerSample === 32) {
        sum += buf.readInt32LE(pos) / 2147483648;
      } else if (bitsPerSample === 8) {
        sum += (buf.readUInt8(pos) - 128) / 128; // 8-bit WAV is unsigned
      } else {
        throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
      }
    }
    out[i] = sum / channels;
  }

  return { samples: out, sampleRate };
}

module.exports = { encodeWav, encodeSilenceWav, decodeWav, SAMPLE_RATE };
