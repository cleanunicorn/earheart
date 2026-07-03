// Output delivery — the Dart port of main/output/deliver.js.
//
// Same contract: write to clipboard, optionally simulate the platform paste
// keystroke, optionally restore the previous clipboard, and degrade to
// clipboard-only (with a note) if no keystroke tool works. Never lose the
// user's words: by the time paste can fail the text is already on the
// clipboard.
import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

import 'settings.dart';

class DeliverResult {
  final String method; // paste | paste-copy | clipboard | cancelled
  final String? note;
  DeliverResult(this.method, [this.note]);
}

Timer? _pendingRestore;

/// Deliver [text] per the output settings. [cancelled] is polled at the two
/// points the Electron original checks its AbortSignal — on entry and again
/// after the paste delay — so a cancel during "Typing…" cannot still paste
/// into the focused app moments later.
Future<DeliverResult> deliver(String text, OutputSettings cfg,
    {bool Function()? cancelled}) async {
  if (cancelled?.call() ?? false) return DeliverResult('cancelled');
  _pendingRestore?.cancel();
  _pendingRestore = null;

  final pasting = cfg.mode == 'paste' || cfg.mode == 'paste-copy';
  String? previous;
  if (cfg.mode == 'paste' && cfg.restoreClipboard) {
    previous = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
  }
  await Clipboard.setData(ClipboardData(text: text));

  if (!pasting) return DeliverResult('clipboard');

  await Future<void>.delayed(Duration(milliseconds: cfg.pasteDelayMs));
  if (cancelled?.call() ?? false) return DeliverResult('cancelled');
  try {
    await _simulatePaste();
  } catch (e) {
    return DeliverResult('clipboard', 'Auto-paste failed: $e');
  }

  if (previous != null) {
    final prev = previous;
    _pendingRestore = Timer(const Duration(seconds: 1), () async {
      _pendingRestore = null;
      final current = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
      if (current == text) {
        await Clipboard.setData(ClipboardData(text: prev));
      }
    });
  }
  return DeliverResult(cfg.mode);
}

Future<void> _simulatePaste() async {
  if (Platform.isMacOS) {
    await _run('osascript', [
      '-e',
      'tell application "System Events" to keystroke "v" using command down',
    ]);
  } else if (Platform.isWindows) {
    await _run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    ]);
  } else {
    await _simulatePasteLinux();
  }
}

bool _isWayland() =>
    Platform.environment['XDG_SESSION_TYPE'] == 'wayland' ||
    (Platform.environment['WAYLAND_DISPLAY'] ?? '').isNotEmpty;

Future<void> _simulatePasteLinux() async {
  final candidates = <List<dynamic>>[];
  if (_isWayland()) {
    candidates.add(['wtype', ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl']]);
    candidates.add(['ydotool', ['key', '29:1', '47:1', '47:0', '29:0']]);
    candidates.add(['xdotool', ['key', '--clearmodifiers', 'ctrl+v']]);
  } else {
    candidates.add(['xdotool', ['key', '--clearmodifiers', 'ctrl+v']]);
  }

  final available = <List<dynamic>>[];
  for (final c in candidates) {
    if (await _commandExists(c[0] as String)) available.add(c);
  }
  if (available.isEmpty) {
    throw StateError(
        'No keystroke tool found (install wtype, ydotool or xdotool)');
  }
  Object? lastErr;
  for (final c in available) {
    try {
      await _run(c[0] as String, (c[1] as List).cast<String>());
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr!;
}

Future<bool> _commandExists(String cmd) async {
  final result = await Process.run('which', [cmd]);
  return result.exitCode == 0;
}

Future<void> _run(String cmd, List<String> args) async {
  final result =
      await Process.run(cmd, args).timeout(const Duration(seconds: 10));
  if (result.exitCode != 0) {
    final stderrText = (result.stderr as String).trim();
    throw StateError(stderrText.isNotEmpty ? stderrText : '$cmd failed');
  }
}
