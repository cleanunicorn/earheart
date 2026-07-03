// Global hotkey — the Dart port of main/hotkeys.js.
//
// Registers the accelerator persisted in settings (Electron accelerator
// syntax, e.g. "CommandOrControl+Shift+Space"), falling back to the default
// if the string can't be parsed. On Wayland GNOME/KDE global grabs are
// refused — same caveat as Electron; the full port keeps the
// `earheart --toggle` single-instance workaround.
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';

import 'settings.dart' show kDefaultHotkey;

Future<void> registerHotkey(String accelerator, void Function() onTrigger) async {
  await hotKeyManager.unregisterAll();
  final hk = parseAccelerator(accelerator) ?? parseAccelerator(kDefaultHotkey)!;
  try {
    await hotKeyManager.register(hk, keyDownHandler: (_) => onTrigger());
  } catch (e) {
    stderr.writeln('global hotkey unavailable: $e');
  }
}

/// Parse an Electron accelerator string into a HotKey, or null if any part
/// is unknown.
///
/// KNOWN ISSUE (Linux): hotkey_manager maps the space key to the keypad's
/// KP_Space, so a Space binding fails there until the plugin's keymap is
/// patched (verified: letter keys bind fine). The full port vendors a
/// one-line fix.
HotKey? parseAccelerator(String accelerator) {
  final parts =
      accelerator.split('+').map((s) => s.trim()).where((s) => s.isNotEmpty);
  final modifiers = <HotKeyModifier>[];
  LogicalKeyboardKey? key;
  for (final part in parts) {
    switch (part.toLowerCase()) {
      case 'commandorcontrol' || 'cmdorctrl':
        modifiers
            .add(Platform.isMacOS ? HotKeyModifier.meta : HotKeyModifier.control);
      case 'command' || 'cmd' || 'meta' || 'super':
        modifiers.add(HotKeyModifier.meta);
      case 'control' || 'ctrl':
        modifiers.add(HotKeyModifier.control);
      case 'shift':
        modifiers.add(HotKeyModifier.shift);
      case 'alt' || 'option':
        modifiers.add(HotKeyModifier.alt);
      default:
        if (key != null) return null; // two non-modifier parts
        key = _keyByName(part);
        if (key == null) return null;
    }
  }
  if (key == null) return null;
  return HotKey(key: key, modifiers: modifiers, scope: HotKeyScope.system);
}

LogicalKeyboardKey? _keyByName(String name) {
  const named = {
    'space': LogicalKeyboardKey.space,
    'enter': LogicalKeyboardKey.enter,
    'return': LogicalKeyboardKey.enter,
    'tab': LogicalKeyboardKey.tab,
    'escape': LogicalKeyboardKey.escape,
    'esc': LogicalKeyboardKey.escape,
    'backspace': LogicalKeyboardKey.backspace,
    'delete': LogicalKeyboardKey.delete,
    'home': LogicalKeyboardKey.home,
    'end': LogicalKeyboardKey.end,
    'pageup': LogicalKeyboardKey.pageUp,
    'pagedown': LogicalKeyboardKey.pageDown,
    'up': LogicalKeyboardKey.arrowUp,
    'down': LogicalKeyboardKey.arrowDown,
    'left': LogicalKeyboardKey.arrowLeft,
    'right': LogicalKeyboardKey.arrowRight,
  };
  final n = name.toLowerCase();
  final fromMap = named[n];
  if (fromMap != null) return fromMap;
  // F1..F24.
  if (n.length >= 2 && n[0] == 'f') {
    final fn = int.tryParse(n.substring(1));
    if (fn != null && fn >= 1 && fn <= 24) {
      return LogicalKeyboardKey.findKeyByKeyId(
          LogicalKeyboardKey.f1.keyId + (fn - 1));
    }
  }
  // Printable single characters: logical key ids for ASCII match the
  // lowercase code point (keyA == 0x61, digit1 == 0x31, ...).
  if (n.length == 1) return LogicalKeyboardKey.findKeyByKeyId(n.codeUnitAt(0));
  return null;
}
