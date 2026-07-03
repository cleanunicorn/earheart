// Overlay window behavior — the sliver of main/windows.js the POC needs.
//
// The app's only window IS the overlay pill: frameless, always-on-top,
// skip-taskbar, positioned bottom-center, hidden while idle. On Linux the
// GTK runner additionally sets accept_focus=FALSE (never steal keyboard
// focus — the Electron overlay's focusable:false); see
// linux/runner/my_application.cc.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:screen_retriever/screen_retriever.dart';
import 'package:window_manager/window_manager.dart';

const overlayWidth = 420.0;
// Sized for the worst-case recording state: a 3-line live transcript
// (15px × 1.5 line-height) over the 40px control row, plus card padding,
// borders and margins. The card itself hugs its content (bottom-aligned),
// so shorter states just leave transparent space above.
const overlayHeight = 168.0;

Future<void> initOverlayWindow() async {
  await windowManager.ensureInitialized();
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
    await positionBottomCenter();
    await windowManager.hide();
  });
}

Future<void> positionBottomCenter() async {
  final display = await screenRetriever.getPrimaryDisplay();
  await windowManager.setBounds(Rect.fromLTWH(
      (display.size.width - overlayWidth) / 2,
      display.size.height - overlayHeight - 24,
      overlayWidth,
      overlayHeight));
}

Future<void> showOverlay() async {
  await positionBottomCenter();
  await windowManager.show(inactive: true);
}

Future<void> hideOverlay() => windowManager.hide();

/// The overlay must never hold keyboard focus when the paste keystroke
/// fires. Linux is covered by the runner's accept_focus=FALSE; Flutter has
/// no cross-platform "non-activatable window" flag yet, so on macOS/Windows
/// a Stop/Cancel click can focus the window — blur right before delivery as
/// a POC stopgap. The full port needs a native non-activating panel per
/// platform.
Future<void> ensureUnfocusedForPaste() async {
  if (Platform.isLinux) return;
  try {
    await windowManager.blur();
  } catch (_) {
    // Best effort; delivery falls back to the clipboard on paste failure.
  }
}
