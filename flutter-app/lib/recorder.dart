// Microphone capture — the Dart port of renderer/overlay.js's recorder.
//
// The Electron app captures in the overlay renderer (getUserMedia + an
// AudioWorklet) at 16 kHz mono and ships WAV over IPC. Here the `record`
// plugin streams PCM16 straight into the process — no IPC hop at all.
// Samples accumulate as float32 (what sherpa-onnx consumes) and an RMS level
// feeds the overlay meter, matching the worklet's {samples, rms} messages.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import 'pcm.dart';
import 'stt.dart' show kSampleRate;

class Recorder {
  // Created lazily: AudioRecorder() registers a platform channel at
  // construction, which would make the class untestable off-device.
  AudioRecorder? _rec;
  final List<Float32List> _chunks = [];
  int _totalSamples = 0;
  StreamSubscription<Uint8List>? _sub;
  Completer<void>? _streamDone;
  final Pcm16Converter _pcm = Pcm16Converter();

  /// 0..1-ish RMS level for the overlay meter.
  final ValueNotifier<double> level = ValueNotifier(0);

  double get seconds => _totalSamples / kSampleRate;

  Future<void> start() async {
    if (_sub != null) return;
    final rec = _rec ??= AudioRecorder();
    if (!await rec.hasPermission()) {
      throw StateError('Microphone permission denied');
    }
    _chunks.clear();
    _totalSamples = 0;
    _pcm.reset();
    final stream = await rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: kSampleRate,
      numChannels: 1,
    ));
    _streamDone = Completer<void>();
    _sub = stream.listen((bytes) {
      final f32 = _pcm.convert(bytes);
      _chunks.add(f32);
      _totalSamples += f32.length;
      if (f32.isNotEmpty) {
        level.value = clamp01(rms(f32) * 4);
      }
    }, onDone: () {
      // An error event may already have completed it (errors don't end the
      // stream, so onDone can still follow).
      if (!(_streamDone?.isCompleted ?? true)) _streamDone?.complete();
    }, onError: (Object _) {
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
    await _teardown(drain: true);
    return snapshot();
  }

  Future<void> cancel() async {
    await _teardown(drain: false);
    _chunks.clear();
    _totalSamples = 0;
  }

  /// Shared stop path. With [drain], the plugin is stopped FIRST and the
  /// stream drained to its close before cancelling the subscription —
  /// cancelling first would discard whatever audio the plugin still had
  /// buffered, clipping the user's last word ("never lose the user's
  /// words"). A cancel doesn't care about buffered audio.
  ///
  /// State is reset unconditionally: the pipeline treats a throwing stop as
  /// survivable (it salvages the snapshot), so a plugin exception here must
  /// not leave `_sub` set — that would make every later start() a silent
  /// no-op and brick recording until app restart. Exceptions still
  /// propagate after the reset.
  Future<void> _teardown({required bool drain}) async {
    final sub = _sub;
    try {
      if (sub != null && drain) {
        try {
          await _rec?.stop();
        } finally {
          // Even if stop() threw, collect what arrived and detach.
          await _streamDone?.future
              .timeout(const Duration(seconds: 2), onTimeout: () {});
          await sub.cancel();
        }
      } else {
        await sub?.cancel();
        await _rec?.stop();
      }
    } finally {
      _sub = null;
      level.value = 0;
    }
  }
}

