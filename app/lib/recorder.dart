// Microphone capture — the Dart port of renderer/overlay.js's recorder.
//
// The Electron app captures in the overlay renderer (getUserMedia + an
// AudioWorklet) at 16 kHz mono and ships WAV over IPC. Here the `record`
// plugin streams PCM16 straight into the process — no IPC hop at all.
// Samples accumulate as float32 (what sherpa-onnx consumes) and an RMS level
// feeds the overlay meter, matching the worklet's {samples, rms} messages.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

const int kSampleRate = 16000;

class Recorder {
  final AudioRecorder _rec = AudioRecorder();
  final List<Float32List> _chunks = [];
  int _totalSamples = 0;
  StreamSubscription<Uint8List>? _sub;
  Completer<void>? _streamDone;

  /// 0..1-ish RMS level for the overlay meter.
  final ValueNotifier<double> level = ValueNotifier(0);

  bool get recording => _sub != null;
  double get seconds => _totalSamples / kSampleRate;

  Future<void> start() async {
    if (_sub != null) return;
    if (!await _rec.hasPermission()) {
      throw StateError('Microphone permission denied');
    }
    _chunks.clear();
    _totalSamples = 0;
    final stream = await _rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: kSampleRate,
      numChannels: 1,
    ));
    _streamDone = Completer<void>();
    _sub = stream.listen((bytes) {
      final f32 = _pcm16ToFloat32(bytes);
      _chunks.add(f32);
      _totalSamples += f32.length;
      double sum = 0;
      for (final s in f32) {
        sum += s * s;
      }
      if (f32.isNotEmpty) {
        level.value = _clamp01(math.sqrt(sum / f32.length) * 4);
      }
    }, onDone: () => _streamDone?.complete(), onError: (Object _) {
      if (!(_streamDone?.isCompleted ?? true)) _streamDone?.complete();
    });
  }

  /// Everything captured so far (for live-preview partial decodes).
  Float32List snapshot() {
    final out = Float32List(_totalSamples);
    var offset = 0;
    for (final c in _chunks) {
      out.setAll(offset, c);
      offset += c.length;
    }
    return out;
  }

  /// Stop and return the full recording.
  Future<Float32List> stop() async {
    // Stop the plugin FIRST and drain the stream to its close before
    // cancelling the subscription — cancelling first would discard whatever
    // audio the plugin still had buffered, clipping the user's last word
    // ("never lose the user's words").
    if (_sub != null) {
      await _rec.stop();
      await _streamDone?.future
          .timeout(const Duration(seconds: 2), onTimeout: () {});
      await _sub?.cancel();
      _sub = null;
    }
    level.value = 0;
    return snapshot();
  }

  Future<void> cancel() async {
    await _sub?.cancel();
    _sub = null;
    await _rec.stop();
    level.value = 0;
    _chunks.clear();
    _totalSamples = 0;
  }

  void dispose() {
    _sub?.cancel();
    _rec.dispose();
  }
}

Float32List _pcm16ToFloat32(Uint8List bytes) {
  final pcm = bytes.buffer.asInt16List(
      bytes.offsetInBytes, bytes.lengthInBytes ~/ 2);
  final out = Float32List(pcm.length);
  for (var i = 0; i < pcm.length; i++) {
    out[i] = pcm[i] / 32768.0;
  }
  return out;
}

double _clamp01(double v) => v < 0 ? 0 : (v > 1 ? 1 : v);
