// Earheart (Flutter rewrite proof-of-concept).
//
// The app's only window IS the overlay pill: frameless, always-on-top,
// skip-taskbar, positioned bottom-center, hidden while idle — matching the
// Electron overlay BrowserWindow (main/windows.js:129). The tray menu and a
// global hotkey drive the pipeline, as in main/main.js.
//
// CLI modes (mirroring the Electron app's smoke hooks):
//   --transcribe <file.wav>   load the model, print the transcript, exit
//   --smoke-test              boot, initialize everything, print OK, exit
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';
import 'package:screen_retriever/screen_retriever.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'overlay.dart';
import 'pipeline.dart';
import 'recorder.dart';
import 'settings.dart';
import 'stt.dart';

const overlayWidth = 420.0;
// Sized for the worst-case recording state: a 3-line live transcript
// (15px × 1.5 line-height) over the 40px control row, plus card padding,
// borders and margins. The card itself hugs its content (bottom-aligned),
// so shorter states just leave transparent space above.
const overlayHeight = 168.0;

late final Settings settings;
late final Pipeline pipeline;
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

  await windowManager.ensureInitialized();
  await hotKeyManager.unregisterAll();

  const options = WindowOptions(
    size: Size(overlayWidth, overlayHeight),
    backgroundColor: Colors.transparent,
    skipTaskbar: true,
    alwaysOnTop: true,
    titleBarStyle: TitleBarStyle.hidden,
  );
  await windowManager.waitUntilReadyToShow(options, () async {
    await windowManager.setAsFrameless();
    await windowManager.setResizable(false);
    await _positionBottomCenter();
    await windowManager.hide();
  });

  pipeline.onShowOverlay = () async {
    await _positionBottomCenter();
    await windowManager.show(inactive: true);
  };
  pipeline.onHideOverlay = () => windowManager.hide();

  await _initTray();
  await _registerHotkey();

  if (args.contains('--smoke-test')) {
    Timer(const Duration(seconds: 2), () async {
      stdout.writeln('SMOKE OK');
      await trayManager.destroy();
      exit(0);
    });
  }

  runApp(const EarheartApp());
}

Future<void> _transcribeFile(String path) async {
  stderr.writeln('loading model from ${settings.stt.modelDir} …');
  await engine.ensureLoaded(settings.stt.modelDir);
  sherpa.initBindings();
  final wave = sherpa.readWave(path);
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

Future<void> _positionBottomCenter() async {
  final display = await screenRetriever.getPrimaryDisplay();
  final w = display.size.width;
  final h = display.size.height;
  await windowManager.setBounds(Rect.fromLTWH((w - overlayWidth) / 2,
      h - overlayHeight - 24, overlayWidth, overlayHeight));
}

// ---- tray ------------------------------------------------------------------

final _trayHandler = _TrayHandler();

class _TrayHandler with TrayListener {
  @override
  void onTrayIconMouseDown() {
    if (Platform.isWindows) pipeline.toggle();
  }

  @override
  void onTrayMenuItemClick(MenuItem item) {
    switch (item.key) {
      case 'toggle':
        pipeline.toggle();
        break;
      case 'cancel':
        pipeline.cancel();
        break;
      case 'mode-paste':
      case 'mode-paste-copy':
      case 'mode-clipboard':
        settings.output.mode = item.key!.substring('mode-'.length);
        settings.save();
        _rebuildTrayMenu();
        break;
      case 'quit':
        trayManager.destroy();
        exit(0);
    }
  }
}

Future<void> _initTray() async {
  try {
    await trayManager.setIcon('assets/icon.png');
    try {
      await trayManager.setToolTip('Earheart — ready');
    } catch (_) {
      // Not implemented on Linux (tray_manager); the menu still works.
    }
    trayManager.addListener(_trayHandler);
    await _rebuildTrayMenu();
    pipeline.addListener(_rebuildTrayMenu);
  } catch (e) {
    // No tray host (headless / minimal desktop): the hotkey still works.
    stderr.writeln('tray unavailable: $e');
  }
}

Future<void> _rebuildTrayMenu() async {
  final st = pipeline.state;
  final toggleLabel = switch (st) {
    PipelineState.idle => 'Start dictation',
    PipelineState.recording => 'Stop & transcribe',
    PipelineState.processing => 'Processing…',
  };
  await trayManager.setContextMenu(Menu(items: [
    MenuItem(
        key: 'toggle',
        label: toggleLabel,
        disabled: st == PipelineState.processing),
    if (st != PipelineState.idle) MenuItem(key: 'cancel', label: 'Cancel'),
    MenuItem.separator(),
    MenuItem.checkbox(
        key: 'mode-paste',
        label: 'Paste into active app',
        checked: settings.output.mode == 'paste'),
    MenuItem.checkbox(
        key: 'mode-paste-copy',
        label: 'Paste and keep on clipboard',
        checked: settings.output.mode == 'paste-copy'),
    MenuItem.checkbox(
        key: 'mode-clipboard',
        label: 'Copy to clipboard only',
        checked: settings.output.mode == 'clipboard'),
    MenuItem.separator(),
    MenuItem(key: 'quit', label: 'Quit Earheart'),
  ]));
}

// ---- hotkey ----------------------------------------------------------------

Future<void> _registerHotkey() async {
  // Default Ctrl/Cmd+Shift+Space, as in settings.js DEFAULTS.hotkey.
  // KNOWN ISSUE (Linux): hotkey_manager maps space to the keypad's KP_Space,
  // so this binding fails there until the plugin's keymap is patched (verified:
  // letter keys bind fine). The full port vendors a one-line fix.
  final hk = HotKey(
    key: LogicalKeyboardKey.space,
    modifiers: [
      Platform.isMacOS ? HotKeyModifier.meta : HotKeyModifier.control,
      HotKeyModifier.shift,
    ],
    scope: HotKeyScope.system,
  );
  try {
    await hotKeyManager.register(hk, keyDownHandler: (_) => pipeline.toggle());
  } catch (e) {
    // Wayland GNOME/KDE refuse global grabs — same caveat as Electron; the
    // full port keeps the `earheart --toggle` single-instance workaround.
    stderr.writeln('global hotkey unavailable: $e');
  }
}

// ---- app -------------------------------------------------------------------

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
