// Settings store — a minimal port of main/settings.js.
//
// Persisted as JSON in the user's config directory. The POC only carries the
// keys the vertical slice needs; the full schema ports 1:1 later.
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

String _homeDir() =>
    Platform.environment['HOME'] ??
    Platform.environment['USERPROFILE'] ??
    '.';

/// Electron accelerator syntax (settings.js DEFAULTS.hotkey). Single source
/// for the constructor default, the load fallback, and hotkey.dart's
/// parse-failure fallback.
const kDefaultHotkey = 'CommandOrControl+Shift+Space';

class OutputSettings {
  /// "paste" | "paste-copy" | "clipboard"
  String mode;
  bool restoreClipboard;
  int pasteDelayMs;

  OutputSettings({
    this.mode = 'paste',
    this.restoreClipboard = true,
    this.pasteDelayMs = 150,
  });

  Map<String, dynamic> toJson() => {
        'mode': mode,
        'restoreClipboard': restoreClipboard,
        'pasteDelayMs': pasteDelayMs,
      };

  static OutputSettings fromJson(Map<String, dynamic>? j) => OutputSettings(
        mode: j?['mode'] as String? ?? 'paste',
        restoreClipboard: j?['restoreClipboard'] as bool? ?? true,
        pasteDelayMs: j?['pasteDelayMs'] as int? ?? 150,
      );
}

class SttSettings {
  /// Directory containing encoder/decoder/joiner/tokens for the builtin model.
  String modelDir;
  bool livePreviewEnabled;
  int livePreviewIntervalMs;

  SttSettings({
    required this.modelDir,
    this.livePreviewEnabled = true,
    this.livePreviewIntervalMs = 1200,
  });

  Map<String, dynamic> toJson() => {
        'modelDir': modelDir,
        'livePreview': {
          'enabled': livePreviewEnabled,
          'intervalMs': livePreviewIntervalMs,
        },
      };

  static SttSettings fromJson(Map<String, dynamic>? j) => SttSettings(
        modelDir: j?['modelDir'] as String? ?? defaultModelDir(),
        livePreviewEnabled:
            (j?['livePreview']?['enabled'] as bool?) ?? true,
        livePreviewIntervalMs:
            (j?['livePreview']?['intervalMs'] as int?) ?? 1200,
      );

  static String defaultModelDir() => p.join(_homeDir(), '.local', 'share',
      'earheart-flutter', 'models', 'parakeet-tdt-0.6b-v3-int8');
}

class Settings {
  /// Electron accelerator syntax; registered at startup via hotkey.dart.
  String hotkey;
  OutputSettings output;
  SttSettings stt;
  int maxRecordingSeconds;

  Settings({
    this.hotkey = kDefaultHotkey,
    required this.output,
    required this.stt,
    this.maxRecordingSeconds = 300,
  });

  /// Test seam: when set, load()/save() use this directory instead of the
  /// user's config dir (same pattern as deliver()'s simulatePaste).
  static String? configDirOverride;

  static File _file() => File(p.join(
      configDirOverride ?? p.join(_homeDir(), '.config', 'earheart-flutter'),
      'settings.json'));

  static Settings load() {
    try {
      final raw = _file().readAsStringSync();
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return Settings(
        hotkey: j['hotkey'] as String? ?? kDefaultHotkey,
        output: OutputSettings.fromJson(j['output'] as Map<String, dynamic>?),
        stt: SttSettings.fromJson(j['stt'] as Map<String, dynamic>?),
        maxRecordingSeconds: j['audio']?['maxRecordingSeconds'] as int? ?? 300,
      );
    } catch (e) {
      // Defaults for a missing file are the normal first run; an EXISTING
      // file we can't read must not be silently discarded (the next save
      // would overwrite the user's config — and later, stored API keys).
      if (_file().existsSync()) {
        stderr.writeln('earheart: unreadable settings.json, '
            'falling back to defaults: $e');
      }
      return Settings(
        output: OutputSettings(),
        stt: SttSettings(modelDir: SttSettings.defaultModelDir()),
      );
    }
  }

  void save() {
    final f = _file();
    f.parent.createSync(recursive: true);
    // The full port stores API keys in this file; don't leave it (or its
    // directory) readable to other local users. Tighten permissions BEFORE
    // the content lands — chmod-after-write would leave the first save
    // world-readable for a window. Windows relies on per-user profile ACLs.
    if (!Platform.isWindows) {
      f.createSync();
      _chmod('700', f.parent.path);
      _chmod('600', f.path);
    }
    f.writeAsStringSync(const JsonEncoder.withIndent('  ').convert({
      'hotkey': hotkey,
      'output': output.toJson(),
      'stt': stt.toJson(),
      'audio': {'maxRecordingSeconds': maxRecordingSeconds},
    }));
  }

  static void _chmod(String mode, String path) {
    final result = Process.runSync('chmod', [mode, path]);
    if (result.exitCode != 0) {
      stderr.writeln('earheart: chmod $mode $path failed: '
          '${(result.stderr as String).trim()}');
    }
  }
}
