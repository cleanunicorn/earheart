// System tray — the Dart port of main/tray.js.
//
// The menu is state-driven: the toggle entry's label follows the pipeline
// (Start dictation / Stop & transcribe / Processing…), Cancel appears only
// while a dictation is active, and the output-mode radios write settings
// immediately, exactly like the Electron menu.
import 'dart:io';

import 'package:tray_manager/tray_manager.dart';

import 'pipeline.dart';
import 'settings.dart';

class TrayController with TrayListener {
  final Pipeline pipeline;
  final Settings settings;
  final void Function() onQuit;

  TrayController(this.pipeline, this.settings, {required this.onQuit});

  Future<void> init() async {
    try {
      await trayManager.setIcon('assets/icon.png');
      try {
        await trayManager.setToolTip('Earheart — ready');
      } catch (_) {
        // Not implemented on Linux (tray_manager); the menu still works.
      }
      trayManager.addListener(this);
      await _rebuild();
      pipeline.addListener(_rebuild);
    } catch (e) {
      // No tray host (headless / minimal desktop): the hotkey still works.
      stderr.writeln('tray unavailable: $e');
    }
  }

  Future<void> dispose() => trayManager.destroy();

  @override
  void onTrayIconMouseDown() {
    if (Platform.isWindows) pipeline.toggle();
  }

  @override
  void onTrayMenuItemClick(MenuItem item) {
    final key = item.key;
    if (key == null) return;
    if (key.startsWith('mode-')) {
      settings.output.mode = key.substring('mode-'.length);
      settings.save();
      _rebuild();
      return;
    }
    switch (key) {
      case 'toggle':
        pipeline.toggle();
      case 'cancel':
        pipeline.cancel();
      case 'quit':
        onQuit();
    }
  }

  static const _outputModes = [
    ('paste', 'Paste into active app'),
    ('paste-copy', 'Paste and keep on clipboard'),
    ('clipboard', 'Copy to clipboard only'),
  ];

  Future<void> _rebuild() async {
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
      for (final (mode, label) in _outputModes)
        MenuItem.checkbox(
            key: 'mode-$mode',
            label: label,
            checked: settings.output.mode == mode),
      MenuItem.separator(),
      MenuItem(key: 'quit', label: 'Quit Earheart'),
    ]));
  }
}
