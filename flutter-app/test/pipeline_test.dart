// Pins the pipeline's session/stale-event discipline — the invariant the
// "never lose the user's words" promise rests on.
import 'dart:async';
import 'dart:typed_data';

import 'package:earheart/pipeline.dart';
import 'package:earheart/recorder.dart';
import 'package:earheart/settings.dart';
import 'package:earheart/stt.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeRecorder extends Recorder {
  Float32List data = Float32List(kSampleRate); // 1s of silence
  bool cancelled = false;

  @override
  Future<void> start() async {}

  @override
  Future<Float32List> stop() async => data;

  @override
  Future<void> cancel() async {
    cancelled = true;
  }

  @override
  Float32List snapshot() => data;
}

class FakeEngine extends SttEngine {
  String result = 'hello world';
  bool throwOnTranscribe = false;
  Completer<void>? gate; // when set, transcribe blocks on it
  int transcribeCalls = 0;

  @override
  bool get loaded => true;

  @override
  Future<void> ensureLoaded(String modelDir) async {}

  @override
  Future<TranscribeResult> transcribe(Float32List samples) async {
    transcribeCalls++;
    if (gate != null) await gate!.future;
    if (throwOnTranscribe) throw StateError('decode blew up');
    return TranscribeResult(result, 1);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  String? clipboard;
  late FakeRecorder recorder;
  late FakeEngine engine;
  late Pipeline pipeline;

  Settings testSettings() => Settings(
        output: OutputSettings(mode: 'clipboard'), // no keystroke path
        stt: SttSettings(
            modelDir: '/unused',
            livePreviewEnabled: true,
            livePreviewIntervalMs: 10),
      );

  setUp(() {
    clipboard = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        clipboard = (call.arguments as Map)['text'] as String?;
      }
      return null;
    });
    recorder = FakeRecorder();
    engine = FakeEngine();
    pipeline = Pipeline(testSettings(), recorder, engine);
  });

  Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 5));

  test('happy path: record → stop → done, text delivered', () async {
    pipeline.toggle();
    await settle();
    expect(pipeline.state, PipelineState.recording);
    pipeline.toggle();
    await settle();
    expect(pipeline.state, PipelineState.idle);
    expect(pipeline.status.phase, OverlayPhase.done);
    expect(pipeline.status.method, 'clipboard');
    expect(clipboard, 'hello world');
  });

  test('double toggle while stopping does not process twice', () async {
    pipeline.toggle();
    await settle();
    pipeline.toggle();
    pipeline.toggle(); // auto-repeat / double press
    await settle();
    expect(engine.transcribeCalls, 1);
    expect(clipboard, 'hello world');
  });

  test('cancel mid-processing drops the result', () async {
    engine.gate = Completer<void>();
    pipeline.toggle();
    await settle();
    pipeline.toggle();
    await settle();
    expect(pipeline.state, PipelineState.processing);
    await pipeline.cancel();
    engine.gate!.complete(); // decode finishes after the cancel
    await settle();
    expect(pipeline.state, PipelineState.idle);
    expect(pipeline.status.phase, OverlayPhase.idle);
    expect(clipboard, isNull, reason: 'stale session must not deliver');
  });

  test('empty transcript reports the empty state', () async {
    engine.result = '';
    pipeline.toggle();
    await settle();
    pipeline.toggle();
    await settle();
    expect(pipeline.status.phase, OverlayPhase.empty);
    expect(clipboard, isNull);
  });

  test('engine failure reports a humanized error', () async {
    engine.throwOnTranscribe = true;
    pipeline.toggle();
    await settle();
    pipeline.toggle();
    await settle();
    expect(pipeline.status.phase, OverlayPhase.error);
    expect(pipeline.status.detail, 'decode blew up');
  });

  test('hotkey is ignored while processing', () async {
    engine.gate = Completer<void>();
    pipeline.toggle();
    await settle();
    pipeline.toggle();
    await settle();
    expect(pipeline.state, PipelineState.processing);
    pipeline.toggle(); // must be a no-op
    await settle();
    expect(pipeline.state, PipelineState.processing);
    engine.gate!.complete();
    await settle();
    expect(pipeline.state, PipelineState.idle);
  });

  test('live preview fills partialText and is cleared when processing starts',
      () async {
    pipeline.toggle();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(pipeline.partialText, 'hello world');
    pipeline.toggle();
    await settle();
    expect(pipeline.partialText, '',
        reason: 'the live preview belongs to the recording phase only');
  });

  test('cancel while recording tears the recorder down', () async {
    pipeline.toggle();
    await settle();
    await pipeline.cancel();
    expect(recorder.cancelled, true);
    expect(pipeline.state, PipelineState.idle);
  });
}
