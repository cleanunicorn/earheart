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

  test('a full save-shaped map parses back the same values', () {
    // Mirrors the map Settings.save() writes; a key rename desyncing save()
    // from fromJson would silently reset every user setting to defaults.
    final saved = {
      'hotkey': 'Control+Alt+D',
      'output': OutputSettings(mode: 'clipboard').toJson(),
      'stt': SttSettings(modelDir: '/m', livePreviewEnabled: false).toJson(),
      'audio': {'maxRecordingSeconds': 42},
    };
    expect(saved['hotkey'], 'Control+Alt+D');
    final out = OutputSettings.fromJson(saved['output'] as Map<String, dynamic>);
    final stt = SttSettings.fromJson(saved['stt'] as Map<String, dynamic>);
    expect(out.mode, 'clipboard');
    expect(stt.modelDir, '/m');
    expect(stt.livePreviewEnabled, false);
    expect((saved['audio'] as Map<String, dynamic>)['maxRecordingSeconds'], 42);
  });
}
