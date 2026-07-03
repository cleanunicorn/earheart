import 'dart:io';

import 'package:earheart/settings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('OutputSettings', () {
    test('round-trips non-default values', () {
      final s = OutputSettings(
          mode: 'paste-copy', restoreClipboard: false, pasteDelayMs: 400);
      final back = OutputSettings.fromJson(s.toJson());
      expect(back.mode, 'paste-copy');
      expect(back.restoreClipboard, false);
      expect(back.pasteDelayMs, 400);
    });

    test('null / empty json yields documented defaults', () {
      for (final j in [null, <String, dynamic>{}]) {
        final s = OutputSettings.fromJson(j);
        expect(s.mode, 'paste');
        expect(s.restoreClipboard, true);
        expect(s.pasteDelayMs, 150);
      }
    });
  });

  group('SttSettings', () {
    test('round-trips non-default values including nested livePreview', () {
      final s = SttSettings(
          modelDir: '/models/x',
          livePreviewEnabled: false,
          livePreviewIntervalMs: 2500);
      final back = SttSettings.fromJson(s.toJson());
      expect(back.modelDir, '/models/x');
      expect(back.livePreviewEnabled, false);
      expect(back.livePreviewIntervalMs, 2500);
    });

    test('null json yields defaults', () {
      final s = SttSettings.fromJson(null);
      expect(s.modelDir, SttSettings.defaultModelDir());
      expect(s.livePreviewEnabled, true);
      expect(s.livePreviewIntervalMs, 1200);
    });
  });

  group('save/load disk round trip', () {
    late Directory dir;

    setUp(() {
      dir = Directory.systemTemp.createTempSync('earheart-settings-test');
      Settings.configDirOverride = dir.path;
    });

    tearDown(() {
      Settings.configDirOverride = null;
      dir.deleteSync(recursive: true);
    });

    test('save() then load() preserves every key', () {
      // The real desync guard: a key rename in save() that load() doesn't
      // know about would silently reset every user setting to defaults.
      final s = Settings(
        hotkey: 'Control+Alt+D',
        output: OutputSettings(mode: 'clipboard', restoreClipboard: false),
        stt: SttSettings(modelDir: '/m', livePreviewEnabled: false),
        maxRecordingSeconds: 42,
      )..save();
      final back = Settings.load();
      expect(back.hotkey, s.hotkey);
      expect(back.output.mode, 'clipboard');
      expect(back.output.restoreClipboard, false);
      expect(back.stt.modelDir, '/m');
      expect(back.stt.livePreviewEnabled, false);
      expect(back.maxRecordingSeconds, 42);
    });

    test('missing file yields defaults', () {
      final s = Settings.load();
      expect(s.hotkey, kDefaultHotkey);
      expect(s.output.mode, 'paste');
    });

    test('malformed JSON yields defaults instead of throwing', () {
      File('${dir.path}/settings.json').writeAsStringSync('{not json');
      final s = Settings.load();
      expect(s.hotkey, kDefaultHotkey);
      expect(s.maxRecordingSeconds, 300);
    });

    test('saved file and config dir are owner-only on POSIX', () {
      Settings(
        output: OutputSettings(),
        stt: SttSettings(modelDir: '/m'),
      ).save();
      final fileMode = File('${dir.path}/settings.json').statSync().mode;
      expect(fileMode & 0x3F, 0, reason: 'group/other bits must be clear');
      final dirMode = Directory(dir.path).statSync().mode;
      expect(dirMode & 0x3F, 0,
          reason: 'config dir must not be listable by others');
    }, skip: Platform.isWindows);
  });
}
