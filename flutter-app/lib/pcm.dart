// PCM16 little-endian → Float32 conversion for the mic capture path.
//
// Kept free of plugin types so it is unit-testable (the Electron twin of
// this math is pinned by test/unit.test.js "wavToFloat32 round-trips PCM16
// samples"). The converter is stateful: a stream chunk may end mid-sample,
// so a trailing low byte is carried into the next chunk instead of being
// dropped (which would desync every later sample), and it never assumes the
// incoming view starts at an even buffer offset.
import 'dart:math' as math;
import 'dart:typed_data';

class Pcm16Converter {
  int _carry = -1; // pending low byte of a split sample, or -1

  /// Convert a chunk of PCM16LE bytes to floats in [-1, 1).
  Float32List convert(Uint8List bytes) {
    var start = 0;
    var pending = _carry;
    final total = (bytes.length + (pending >= 0 ? 1 : 0)) ~/ 2;
    final out = Float32List(total);
    var o = 0;
    if (pending >= 0 && bytes.isNotEmpty) {
      out[o++] = _toFloat(pending | (bytes[0] << 8));
      pending = -1;
      start = 1;
    }
    final even = start + ((bytes.length - start) & ~1);
    for (var i = start; i < even; i += 2) {
      out[o++] = _toFloat(bytes[i] | (bytes[i + 1] << 8));
    }
    _carry = even < bytes.length ? bytes[even] : pending;
    return out;
  }

  /// Drop any half-consumed sample (e.g. when a recording is cancelled).
  void reset() => _carry = -1;

  static double _toFloat(int lo16) {
    var v = lo16 & 0xFFFF;
    if (v >= 0x8000) v -= 0x10000; // sign-extend
    return v / 32768.0;
  }
}

/// Root-mean-square of a sample block, for the overlay level meter.
double rms(Float32List samples) {
  if (samples.isEmpty) return 0;
  double sum = 0;
  for (final s in samples) {
    sum += s * s;
  }
  return math.sqrt(sum / samples.length);
}

double clamp01(double v) => v < 0 ? 0 : (v > 1 ? 1 : v);
