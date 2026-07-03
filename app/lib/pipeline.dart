// The dictation pipeline — the Dart port of main/pipeline.js.
//
// State machine:
//   idle ──hotkey──▶ recording ──hotkey──▶ processing ──▶ idle
//                        │                     │
//                        └──cancel──▶ idle ◀───┘ (error/cancel)
//
// Every dictation gets a session id; events from a torn-down session are
// ignored instead of corrupting the current one — same discipline as the
// Electron pipeline. Recording happens in-process here (no renderer hop):
// the recorder streams PCM straight into Dart.
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'deliver.dart';
import 'recorder.dart';
import 'settings.dart';
import 'stt.dart';

enum PipelineState { idle, recording, processing }

/// What the overlay is currently showing. Unlike the Electron original there
/// is no IPC string boundary here, so the phase is a real enum and the
/// overlay can switch on it exhaustively.
enum OverlayPhase { idle, recording, transcribing, delivering, done, empty, error }

class OverlayStatus {
  final OverlayPhase phase;
  final String? detail;
  const OverlayStatus(this.phase, [this.detail]);
}

class Pipeline extends ChangeNotifier {
  final Settings settings;
  final Recorder recorder;
  final SttEngine engine;

  /// Called when the overlay should appear / disappear.
  void Function()? onShowOverlay;
  void Function()? onHideOverlay;

  PipelineState state = PipelineState.idle;
  OverlayStatus status = const OverlayStatus(OverlayPhase.idle);
  String partialText = '';
  int _session = 0;
  Timer? _liveTimer;
  Timer? _maxTimer;
  Timer? _hideTimer;

  Pipeline(this.settings, this.recorder, this.engine);

  void toggle() {
    if (state == PipelineState.idle) {
      _startRecording();
    } else if (state == PipelineState.recording) {
      _stopRecording();
    }
    // While processing the hotkey is ignored; cancel comes from the overlay
    // or the tray menu.
  }

  void _setState(PipelineState next, OverlayStatus s) {
    state = next;
    status = s;
    notifyListeners();
  }

  Future<void> _startRecording() async {
    final sid = ++_session;
    _hideTimer?.cancel();
    partialText = '';
    _setState(PipelineState.recording, const OverlayStatus(OverlayPhase.recording));
    onShowOverlay?.call();
    // Warm the model while recording so live preview / the final decode
    // don't pay the cold-load cost — mirrors pipeline.js startRecording.
    engine.ensureLoaded(settings.stt.modelDir).catchError((_) {});
    try {
      await recorder.start();
    } catch (e) {
      if (sid != _session) return;
      _fail('$e', sid);
      return;
    }
    // Cancel (or a fast stop) may have raced the mic setup: recorder.cancel()
    // ran while start() was still opening the stream, so nothing was torn
    // down and the mic would stay hot forever. Same race the Electron
    // renderer handles with its generation check + stopWhenReady.
    if (sid != _session || state != PipelineState.recording) {
      await recorder.cancel();
      return;
    }
    _maxTimer = Timer(Duration(seconds: settings.maxRecordingSeconds), () {
      if (sid == _session && state == PipelineState.recording) {
        _stopRecording();
      }
    });
    if (settings.stt.livePreviewEnabled) {
      _liveTimer = Timer.periodic(
          Duration(milliseconds: settings.stt.livePreviewIntervalMs),
          (_) => _livePreviewTick(sid));
    }
  }

  /// Live preview: decode everything captured so far, drop-if-busy — the
  /// same "partials are best-effort" contract as live-preview.js.
  Future<void> _livePreviewTick(int sid) async {
    if (sid != _session || state != PipelineState.recording) return;
    if (!engine.loaded || engine.busy) return;
    final samples = recorder.snapshot();
    if (samples.length < kSampleRate ~/ 2) return; // <0.5s: nothing to say yet
    try {
      final res = await engine.transcribe(samples);
      if (sid != _session || state != PipelineState.recording) return;
      if (res.text.isNotEmpty) {
        partialText = res.text;
        notifyListeners();
      }
    } catch (_) {
      // Best-effort; the final pass is authoritative.
    }
  }

  Future<void> _stopRecording() async {
    // Leave `recording` synchronously, before the first await: a second
    // hotkey press (or key auto-repeat, or the max-recording timer racing
    // the hotkey) must not run the processing pass twice — that would paste
    // the transcript twice. The Electron original guards this in both the
    // renderer teardown and the audio:captured handler.
    if (state != PipelineState.recording) return;
    final sid = _session;
    _setState(PipelineState.processing,
        const OverlayStatus(OverlayPhase.transcribing));
    _liveTimer?.cancel();
    _maxTimer?.cancel();
    final samples = await recorder.stop();
    if (sid != _session) return;
    await _process(sid, samples);
  }

  Future<void> _process(int sid, Float32List samples) async {
    _setState(PipelineState.processing, const OverlayStatus(OverlayPhase.transcribing));
    try {
      await engine.ensureLoaded(settings.stt.modelDir);
      if (sid != _session) return;
      final res = await engine.transcribe(samples);
      if (sid != _session) return;

      if (res.text.isEmpty) {
        _setState(PipelineState.idle, const OverlayStatus(OverlayPhase.empty));
        _hideSoon(sid, 1800);
        return;
      }

      // NOTE: cleanup phase goes here in the full port; on failure it must
      // fall back to the raw transcript (never lose the user's words).

      _setState(
          PipelineState.processing, const OverlayStatus(OverlayPhase.delivering));
      final result = await deliver(res.text, settings.output);
      if (sid != _session) return;

      final preview =
          res.text.length > 120 ? '${res.text.substring(0, 120)}…' : res.text;
      _setState(PipelineState.idle,
          OverlayStatus(OverlayPhase.done, result.note ?? preview));
      _hideSoon(sid, result.note != null ? 4000 : 1600);
    } catch (e) {
      if (sid != _session) return;
      _fail('$e', sid);
    }
  }

  void _fail(String message, int sid) {
    _setState(PipelineState.idle, OverlayStatus(OverlayPhase.error, message));
    _hideSoon(sid, 5000);
  }

  void _hideSoon(int sid, int ms) {
    _hideTimer?.cancel();
    _hideTimer = Timer(Duration(milliseconds: ms), () {
      if (sid == _session && state == PipelineState.idle) {
        onHideOverlay?.call();
      }
    });
  }

  Future<void> cancel() async {
    _session++;
    _liveTimer?.cancel();
    _maxTimer?.cancel();
    if (state == PipelineState.recording) {
      await recorder.cancel();
    }
    partialText = '';
    _setState(PipelineState.idle, const OverlayStatus(OverlayPhase.idle));
    onHideOverlay?.call();
  }
}
