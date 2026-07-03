import 'dart:typed_data';

import 'package:earheart/pcm.dart';
import 'package:flutter_test/flutter_test.dart';

Uint8List pcmBytes(List<int> samples) {
  final b = ByteData(samples.length * 2);
  for (var i = 0; i < samples.length; i++) {
    b.setInt16(i * 2, samples[i], Endian.little);
  }
  return b.buffer.asUint8List();
}

void main() {
  group('Pcm16Converter', () {
    test('round-trips PCM16 boundary samples to [-1, 1)', () {
      final out = Pcm16Converter().convert(pcmBytes([-32768, 32767, 0, 16384]));
      expect(out, hasLength(4));
      expect(out[0], -1.0);
      expect(out[1], closeTo(32767 / 32768, 1e-9));
      expect(out[2], 0.0);
      expect(out[3], closeTo(0.5, 1e-9));
    });

    test('empty input yields empty output', () {
      expect(Pcm16Converter().convert(Uint8List(0)), isEmpty);
    });

    test('carries a sample split across two chunks', () {
      final bytes = pcmBytes([1000, -2000, 3000]);
      final c = Pcm16Converter();
      // Split mid-sample: 3 bytes then 3 bytes.
      final a = c.convert(Uint8List.sublistView(bytes, 0, 3));
      final b = c.convert(Uint8List.sublistView(bytes, 3));
      expect([...a, ...b], hasLength(3));
      expect(([...a, ...b]).map((v) => (v * 32768).round()).toList(),
          [1000, -2000, 3000]);
    });

    test('handles views at odd buffer offsets', () {
      // Build a buffer whose PCM data starts at byte 1.
      final raw = Uint8List(1 + 4);
      raw.setAll(1, pcmBytes([-32768, 32767]));
      final view = Uint8List.sublistView(raw, 1);
      expect(view.offsetInBytes, 1);
      final out = Pcm16Converter().convert(view);
      expect(out[0], -1.0);
      expect(out[1], closeTo(32767 / 32768, 1e-9));
    });

    test('reset drops a half-consumed sample', () {
      final c = Pcm16Converter();
      c.convert(Uint8List.fromList([0x42])); // dangling low byte
      c.reset();
      final out = c.convert(pcmBytes([123]));
      expect(out.map((v) => (v * 32768).round()).toList(), [123]);
    });
  });

  group('rms / clamp01', () {
    test('rms of a constant block is its magnitude', () {
      expect(rms(Float32List.fromList([0.5, -0.5, 0.5, -0.5])),
          closeTo(0.5, 1e-9));
    });

    test('rms of silence and empty input is 0', () {
      expect(rms(Float32List(8)), 0);
      expect(rms(Float32List(0)), 0);
    });

    test('clamp01 bounds', () {
      expect(clamp01(-0.1), 0);
      expect(clamp01(0.3), 0.3);
      expect(clamp01(1.7), 1);
    });
  });
}
