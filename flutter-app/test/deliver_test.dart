import 'package:earheart/deliver.dart';
import 'package:earheart/settings.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  String? clipboard;
  var getDataCalls = 0;

  setUp(() {
    clipboard = null;
    getDataCalls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      switch (call.method) {
        case 'Clipboard.setData':
          clipboard = (call.arguments as Map)['text'] as String?;
          return null;
        case 'Clipboard.getData':
          getDataCalls++;
          return clipboard == null ? null : {'text': clipboard};
      }
      return null;
    });
  });

  test('clipboard mode copies and returns without simulating a paste', () async {
    var pasted = false;
    final result = await deliver(
        'hello', OutputSettings(mode: 'clipboard'),
        simulatePaste: () async => pasted = true);
    expect(result.method, 'clipboard');
    expect(result.note, isNull);
    expect(clipboard, 'hello');
    expect(pasted, false);
  });

  test('paste-copy never reads the previous clipboard', () async {
    final result = await deliver(
        'hello', OutputSettings(mode: 'paste-copy', pasteDelayMs: 1),
        simulatePaste: () async {});
    expect(result.method, 'paste-copy');
    expect(getDataCalls, 0, reason: 'paste-copy must not capture/restore');
    expect(clipboard, 'hello');
  });

  test('paste mode with restoreClipboard captures the previous contents',
      () async {
    clipboard = 'before';
    final result = await deliver(
        'hello', OutputSettings(mode: 'paste', pasteDelayMs: 1),
        simulatePaste: () async {});
    expect(result.method, 'paste');
    expect(getDataCalls, greaterThan(0));
    expect(clipboard, 'hello');
  });

  test('cancelled on entry delivers nothing', () async {
    final result = await deliver('hello', OutputSettings(mode: 'paste'),
        cancelled: () => true, simulatePaste: () async {});
    expect(result.method, 'cancelled');
    expect(clipboard, isNull);
  });

  test('cancel during the paste delay stops before the keystroke', () async {
    var cancelled = false;
    var pasted = false;
    final future = deliver(
        'hello', OutputSettings(mode: 'paste', pasteDelayMs: 30),
        cancelled: () => cancelled, simulatePaste: () async => pasted = true);
    cancelled = true; // flips during the delay window
    final result = await future;
    expect(result.method, 'cancelled');
    expect(pasted, false);
    expect(clipboard, 'hello', reason: 'text stays available on the clipboard');
  });

  test('a failing paste degrades to clipboard with a note', () async {
    final result = await deliver(
        'hello', OutputSettings(mode: 'paste', pasteDelayMs: 1),
        simulatePaste: () async => throw StateError('no tool'));
    expect(result.method, 'clipboard');
    expect(result.note, contains('Auto-paste failed'));
    expect(clipboard, 'hello');
  });
}
