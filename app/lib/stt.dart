// In-process STT engine — the Dart port of main/engines/engine-worker.js.
//
// The Electron app runs sherpa-onnx in a utilityProcess worker so a long
// decode never blocks the UI. The Dart equivalent is a long-lived Isolate:
// the recognizer is created inside the isolate and requests round-trip over
// SendPorts. sherpa_onnx is the same native library (same version) the
// Electron app uses via sherpa-onnx-node.
//
// Lifecycle rules (mirroring the Electron engine host):
// - a failed load is never cached: the next dictation retries;
// - `loaded` is true only after a successful load reply;
// - a dying worker fails everything in flight and respawns on next use;
// - changing the model directory tears the worker down and reloads.
import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

class TranscribeResult {
  final String text;
  final int decodeMs;
  TranscribeResult(this.text, this.decodeMs);
}

class SttEngine {
  SendPort? _commands;
  Isolate? _isolate;
  ReceivePort? _results;
  ReceivePort? _lifecycle;
  Future<void>? _loading;
  String? _loadedDir;
  bool _ready = false;
  int _nextId = 0;
  final Map<int, Completer<Map<String, dynamic>>> _pending = {};

  bool get loaded => _ready;
  bool busy = false;

  /// Load the model, retrying after failures and respawning when [modelDir]
  /// changes. Concurrent callers share the in-flight load.
  Future<void> ensureLoaded(String modelDir) {
    final pending = _loading;
    if (pending != null && _loadedDir == modelDir) return pending;
    final future = () async {
      if (pending != null) {
        // A different model is loading/loaded: let it settle, then replace.
        try {
          await pending;
        } catch (_) {}
        _shutdown();
      }
      await _load(modelDir);
    }();
    _loading = future;
    _loadedDir = modelDir;
    // A failed load must not be cached forever — a first run without the
    // model files would otherwise fail every dictation until app restart.
    // Callers still observe the error through the returned future.
    unawaited(future.then((_) {}, onError: (Object _) {
      if (identical(_loading, future)) {
        _loading = null;
        _loadedDir = null;
      }
    }));
    return future;
  }

  Future<void> _load(String modelDir) async {
    final ready = ReceivePort();
    final lifecycle = ReceivePort();
    _isolate = await Isolate.spawn(_engineMain, ready.sendPort,
        onExit: lifecycle.sendPort, onError: lifecycle.sendPort);
    _lifecycle = lifecycle..listen((_) => _onWorkerDeath());
    try {
      final commands = await ready.first as SendPort;
      final results = ReceivePort();
      commands.send({'type': 'init', 'replyTo': results.sendPort});
      _results = results
        ..listen((msg) {
          final m = msg as Map<String, dynamic>;
          _pending.remove(m['id'])?.complete(m);
        });
      _commands = commands;
      final res = await _request({'type': 'load', 'modelDir': modelDir});
      if (res['ok'] != true) {
        throw StateError('STT model load failed: ${res['error']}');
      }
      _ready = true;
    } catch (e) {
      // Never leave a half-loaded worker behind: `loaded` stays false and
      // the isolate dies so the next attempt starts clean.
      _shutdown();
      rethrow;
    } finally {
      ready.close();
    }
  }

  /// The worker died (native crash in a decode, or an uncaught isolate
  /// error): fail everything in flight so the pipeline surfaces an error
  /// instead of hanging forever at "Transcribing…", and reset so the next
  /// dictation respawns a fresh worker.
  void _onWorkerDeath() {
    final waiting = List.of(_pending.values);
    _pending.clear();
    for (final c in waiting) {
      c.completeError(StateError('STT worker died'));
    }
    _shutdown();
    _loading = null;
    _loadedDir = null;
  }

  Future<Map<String, dynamic>> _request(Map<String, dynamic> msg) {
    final id = _nextId++;
    final c = Completer<Map<String, dynamic>>();
    _pending[id] = c;
    _commands!.send({...msg, 'id': id});
    return c.future;
  }

  /// Decode 16 kHz mono float32 samples to text.
  Future<TranscribeResult> transcribe(Float32List samples) async {
    if (_commands == null) throw StateError('engine not loaded');
    busy = true;
    try {
      final res = await _request({'type': 'transcribe', 'samples': samples});
      if (res['ok'] != true) throw StateError('decode failed: ${res['error']}');
      return TranscribeResult(res['text'] as String, res['decodeMs'] as int);
    } finally {
      busy = false;
    }
  }

  void _shutdown() {
    _results?.close();
    _results = null;
    _lifecycle?.close();
    _lifecycle = null;
    _isolate?.kill(priority: Isolate.immediate);
    _isolate = null;
    _commands = null;
    _ready = false;
  }

  /// Tear the worker down entirely (the full port's idle-unload hook).
  void dispose() {
    _shutdown();
    _loading = null;
    _loadedDir = null;
  }
}

// ---- isolate side ----------------------------------------------------------

void _engineMain(SendPort ready) {
  final commands = ReceivePort();
  ready.send(commands.sendPort);

  sherpa.OfflineRecognizer? recognizer;
  SendPort? replyTo;

  commands.listen((msg) {
    final m = msg as Map<String, dynamic>;
    switch (m['type'] as String) {
      case 'init':
        replyTo = m['replyTo'] as SendPort;
        break;
      case 'load':
        try {
          sherpa.initBindings();
          final dir = m['modelDir'] as String;
          // Same config as engine-worker.js: NeMo transducer (Parakeet TDT),
          // 16 kHz features, CPU provider.
          recognizer = sherpa.OfflineRecognizer(sherpa.OfflineRecognizerConfig(
            model: sherpa.OfflineModelConfig(
              transducer: sherpa.OfflineTransducerModelConfig(
                encoder: p.join(dir, 'encoder.int8.onnx'),
                decoder: p.join(dir, 'decoder.int8.onnx'),
                joiner: p.join(dir, 'joiner.int8.onnx'),
              ),
              tokens: p.join(dir, 'tokens.txt'),
              modelType: 'nemo_transducer',
              numThreads: 2,
              debug: false,
            ),
          ));
          replyTo!.send({'id': m['id'], 'ok': true});
        } catch (e) {
          replyTo!.send({'id': m['id'], 'ok': false, 'error': '$e'});
        }
        break;
      case 'transcribe':
        try {
          final samples = m['samples'] as Float32List;
          final started = DateTime.now();
          final stream = recognizer!.createStream();
          stream.acceptWaveform(samples: samples, sampleRate: 16000);
          recognizer!.decode(stream);
          final text = recognizer!.getResult(stream).text.trim();
          stream.free();
          final decodeMs = DateTime.now().difference(started).inMilliseconds;
          replyTo!.send(
              {'id': m['id'], 'ok': true, 'text': text, 'decodeMs': decodeMs});
        } catch (e) {
          replyTo!.send({'id': m['id'], 'ok': false, 'error': '$e'});
        }
        break;
    }
  });
}
