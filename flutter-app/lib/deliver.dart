// Output delivery — the Dart port of main/output/deliver.js.
//
// Same contract: write to clipboard, optionally simulate the platform paste
// keystroke, optionally restore the previous clipboard, and degrade to
// clipboard-only (with a note) if no keystroke tool works. Never lose the
// user's words: by the time paste can fail the text is already on the
// clipboard.
import 'dart:async';
import 'dart:convert';
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
/// into the focused app moments later. [simulatePaste] overrides the OS
/// keystroke (tests only — the real path shells out to platform tools).
Future<DeliverResult> deliver(String text, OutputSettings cfg,
    {bool Function()? cancelled,
    Future<void> Function()? simulatePaste}) async {
  if (cancelled?.call() ?? false) return DeliverResult('cancelled');
  _pendingRestore?.cancel();
  _pendingRestore = null;

  final pasting = cfg.mode == 'paste' || cfg.mode == 'paste-copy';
  String? previous;
  if (cfg.mode == 'paste' && cfg.restoreClipboard) {
    // An empty clipboard reads as null here but must still be restorable
    // (Electron's clipboard.readText() returns '' and restores it).
    previous = (await Clipboard.getData(Clipboard.kTextPlain))?.text ?? '';
  }
  await Clipboard.setData(ClipboardData(text: text));

  if (!pasting) return DeliverResult('clipboard');

  await Future<void>.delayed(Duration(milliseconds: cfg.pasteDelayMs));
  if (cancelled?.call() ?? false) return DeliverResult('cancelled');
  try {
    await (simulatePaste ?? _simulatePaste)();
  } catch (e) {
    // Overlay-facing text: strip Dart's "Bad state:" prefix like the
    // pipeline's describeError does for every other user-visible error.
    final why = e is StateError ? e.message : '$e';
    return DeliverResult('clipboard', 'Auto-paste failed: $why');
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
  final candidates = <(String, List<String>)>[
    if (_isWayland()) ...[
      ('wtype', ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl']),
      ('ydotool', ['key', '29:1', '47:1', '47:0', '29:0']),
    ],
    // XWayland apps can still be reachable via xdotool; on X11 it is the tool.
    ('xdotool', ['key', '--clearmodifiers', 'ctrl+v']),
  ];

  final available = <(String, List<String>)>[];
  for (final c in candidates) {
    if (await _commandExists(c.$1)) available.add(c);
  }
  if (available.isEmpty) {
    throw StateError(
        'No keystroke tool found (install wtype, ydotool or xdotool)');
  }
  Object? lastErr;
  for (final (cmd, args) in available) {
    try {
      await _run(cmd, args);
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
  // Process.run(...).timeout() would abandon a hung tool but leave it
  // running — its Ctrl+V could still fire long after we reported failure.
  // Kill the child on timeout instead (execFile's timeout does the same).
  final process = await Process.start(cmd, args);
  // Tolerate non-UTF-8 tool output: a strict decoder would turn stray bytes
  // into a FormatException that masks (or outlives) the real result.
  final stderrText =
      process.stderr.transform(const Utf8Decoder(allowMalformed: true)).join();
  unawaited(process.stdout.drain<void>());
  var timedOut = false;
  final killTimer = Timer(const Duration(seconds: 10), () {
    timedOut = true;
    process.kill(ProcessSignal.sigkill);
  });
  final code = await process.exitCode;
  killTimer.cancel();
  if (timedOut) throw StateError('$cmd timed out');
  if (code != 0) {
    final err = (await stderrText).trim();
    throw StateError(err.isNotEmpty ? err : '$cmd failed');
  }
}
