// In-process STT engine — the Dart port of main/engines/engine-worker.js.
//
// The Electron app runs sherpa-onnx in a utilityProcess worker so a long
// decode never blocks the UI. The Dart equivalent is a long-lived Isolate:
// the recognizer is created inside the isolate and requests round-trip over
// SendPorts. sherpa_onnx is the same native library (same version) the
// Electron app uses via sherpa-onnx-node.
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
  Future<void>? _loading;
  int _nextId = 0;
  final Map<int, Completer<Map<String, dynamic>>> _pending = {};

  bool get loaded => _commands != null;
  bool busy = false;

  /// Load the model once; concurrent callers share the same load.
  Future<void> ensureLoaded(String modelDir) {
    _loading ??= _load(modelDir);
    return _loading!;
  }

  Future<void> _load(String modelDir) async {
    final ready = ReceivePort();
    _isolate = await Isolate.spawn(_engineMain, ready.sendPort);
    final results = ReceivePort();
    _commands = await ready.first as SendPort;
    _commands!.send({'type': 'init', 'replyTo': results.sendPort});
    results.listen((msg) {
      final m = msg as Map<String, dynamic>;
      final c = _pending.remove(m['id']);
      if (c == null) return;
      c.complete(m);
    });
    final res = await _request({'type': 'load', 'modelDir': modelDir});
    if (res['ok'] != true) {
      throw StateError('STT model load failed: ${res['error']}');
    }
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
      return TranscribeResult(
          res['text'] as String, res['decodeMs'] as int);
    } finally {
      busy = false;
    }
  }

  void dispose() {
    _isolate?.kill(priority: Isolate.immediate);
    _isolate = null;
    _commands = null;
    _loading = null;
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
          final decodeMs =
              DateTime.now().difference(started).inMilliseconds;
          replyTo!
              .send({'id': m['id'], 'ok': true, 'text': text, 'decodeMs': decodeMs});
        } catch (e) {
          replyTo!.send({'id': m['id'], 'ok': false, 'error': '$e'});
        }
        break;
    }
  });
}
