// Earheart (Flutter rewrite proof-of-concept) — entry point.
//
// Pure wiring, like main/main.js: construct the modules (settings, recorder,
// engine, pipeline), connect them to the tray (tray.dart), the global hotkey
// (hotkey.dart) and the overlay window (window.dart), then hand the UI to
// overlay.dart.
//
// CLI modes (mirroring the Electron app's smoke hooks):
//   --transcribe <file.wav>   load the model, print the transcript, exit
//   --smoke-test              boot, initialize everything, print OK, exit
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'hotkey.dart';
import 'overlay.dart';
import 'pipeline.dart';
import 'recorder.dart';
import 'settings.dart';
import 'stt.dart';
import 'tray.dart';
import 'window.dart';

late final Settings settings;
late final Pipeline pipeline;
late final TrayController tray;
final recorder = Recorder();
final engine = SttEngine();

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  settings = Settings.load();
  pipeline = Pipeline(settings, recorder, engine);

  // Headless STT check: decode a WAV with the same engine the app uses.
  final ti = args.indexOf('--transcribe');
  if (ti != -1 && ti + 1 < args.length) {
    await _transcribeFile(args[ti + 1]);
    return;
  }

  await initOverlayWindow();
  pipeline.onShowOverlay = showOverlay;
  pipeline.onHideOverlay = hideOverlay;
  pipeline.onBeforeDeliver = ensureUnfocusedForPaste;

  tray = TrayController(pipeline, settings, onQuit: _quit);
  await tray.init();
  await registerHotkey(settings.hotkey, pipeline.toggle);

  if (args.contains('--smoke-test')) {
    Timer(const Duration(seconds: 2), () async {
      stdout.writeln('SMOKE OK');
      await tray.dispose();
      exit(0);
    });
  }

  runApp(const EarheartApp());
}

void _quit() {
  tray.dispose();
  exit(0);
}

Future<void> _transcribeFile(String path) async {
  stderr.writeln('loading model from ${settings.stt.modelDir} …');
  await engine.ensureLoaded(settings.stt.modelDir);
  final wave = readWaveFile(path);
  if (wave.sampleRate != kSampleRate) {
    stderr.writeln(
        'warning: ${wave.sampleRate} Hz input; engine expects $kSampleRate');
  }
  final started = DateTime.now();
  final res = await engine.transcribe(wave.samples);
  final wallMs = DateTime.now().difference(started).inMilliseconds;
  stdout.writeln('TRANSCRIPT: ${res.text}');
  stdout.writeln(
      'decodeMs=${res.decodeMs} wallMs=$wallMs audioSec=${(wave.samples.length / kSampleRate).toStringAsFixed(1)}');
  exit(0);
}

class EarheartApp extends StatelessWidget {
  const EarheartApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Earheart',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true),
      home: Scaffold(
        backgroundColor: Colors.transparent,
        body: OverlayCard(pipeline: pipeline, recorder: recorder),
      ),
    );
  }
}
