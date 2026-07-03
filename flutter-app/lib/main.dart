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
  if (ti != -1) {
    if (ti + 1 >= args.length) {
      // Don't silently fall through to booting the GUI on a missing arg.
      stderr.writeln('usage: earheart --transcribe <file.wav>');
      await stderr.flush();
      exit(2);
    }
    try {
      await _transcribeFile(args[ti + 1]);
    } catch (e) {
      // Without this the engine event loop keeps running and the CLI hangs
      // instead of failing — missing model files are the likely first hit.
      stderr.writeln('transcribe failed: ${Pipeline.describeError(e)}');
      await stderr.flush();
      exit(1);
    }
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
      await stdout.flush();
      try {
        await tray.dispose();
      } finally {
        // exit unconditionally — a tray teardown throw on a host with no
        // status-notifier service must not leave the smoke run hanging.
        exit(0);
      }
    });
  }

  runApp(const EarheartApp());
}

void _quit() {
  engine.dispose();
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
  // exit() doesn't flush buffered pipe writes — a CI harness reading stdout
  // could see a truncated transcript.
  await stdout.flush();
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
      // The window is fixed at overlayHeight, budgeted for text scale 1.0 —
      // clamp OS accessibility scaling so the pill clips instead of
      // overflowing. The full port should size the window from scaled
      // metrics instead.
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        maxScaleFactor: 1.0,
        child: child!,
      ),
      home: Scaffold(
        backgroundColor: Colors.transparent,
        body: OverlayCard(pipeline: pipeline, recorder: recorder),
      ),
    );
  }
}
