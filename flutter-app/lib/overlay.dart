// The overlay pill — the Dart port of renderer/overlay.{html,css,js}.
//
// One widget renders every pipeline status: recording (level meter + live
// transcript + timer), transcribing/delivering (progress pulse), done/empty/
// error (message). In Electron this is a separate always-on-top renderer;
// here it's just the app's (only) window, styled as the same dark pill.
import 'dart:async';

import 'package:flutter/material.dart';

import 'pipeline.dart';
import 'recorder.dart';

// Palette mirroring renderer/overlay.css so the two implementations stay
// visually interchangeable: record red, processing amber, done green, a
// neutral slate for empty/error, and the two text tones.
const kPanel = Color(0xFF201C2C);
const kRecordRed = Color(0xFFFF5470);
const kProcessingAmber = Color(0xFFFFB347);
const kDoneGreen = Color(0xFF4ADE80);
const kMuted = Color(0xFF94A3B8);
const kTextPrimary = Color(0xFFF6F4FB);
const kTextDetail = Color(0xFFB8B3C4);

class OverlayCard extends StatefulWidget {
  final Pipeline pipeline;
  final Recorder recorder;
  const OverlayCard({super.key, required this.pipeline, required this.recorder});

  @override
  State<OverlayCard> createState() => _OverlayCardState();
}

class _OverlayCardState extends State<OverlayCard> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    widget.pipeline.addListener(_onChange);
    // Drive the recording timer text.
    _ticker = Timer.periodic(
        const Duration(milliseconds: 250), (_) => setState(() {}));
  }

  void _onChange() => setState(() {});

  @override
  void dispose() {
    widget.pipeline.removeListener(_onChange);
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.pipeline;
    return Align(
      alignment: Alignment.bottomCenter,
      child: Container(
        margin: const EdgeInsets.all(12),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          // Solid panel (overlay.css --panel): faint-text contrast must never
          // depend on whatever happens to be behind the overlay.
          color: kPanel,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: Colors.white.withValues(alpha: 0.16)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (p.partialText.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  p.partialText,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  // The transcript is the hero (overlay.css #transcript):
                  // bigger and brighter than the status row, never dimmer.
                  style: const TextStyle(
                      color: kTextPrimary,
                      fontSize: 15,
                      height: 1.5,
                      fontWeight: FontWeight.w500),
                ),
              ),
            _statusRow(p),
          ],
        ),
      ),
    );
  }

  Widget _statusRow(Pipeline p) {
    switch (p.status.phase) {
      case OverlayPhase.recording:
        return Row(mainAxisSize: MainAxisSize.min, children: [
          const _PulsingDot(color: kRecordRed),
          const SizedBox(width: 8),
          _Meter(level: widget.recorder.level),
          const SizedBox(width: 10),
          Text(_fmt(widget.recorder.seconds),
              style: const TextStyle(
                  color: kTextDetail,
                  fontSize: 13,
                  // Tabular digits so the timer doesn't jiggle every second.
                  fontFeatures: [FontFeature.tabularFigures()])),
          const SizedBox(width: 10),
          // Stop is the commit action and wears the filled record-red circle;
          // Cancel stays a ghost with a separating gap so the destructive
          // action isn't hit by reflex (overlay.css gives #stop the same
          // emphasis and extra margin).
          _iconBtn(Icons.stop, 'Stop & transcribe', () => p.toggle(),
              filled: true),
          const SizedBox(width: 4),
          _iconBtn(Icons.close, 'Cancel', () => p.cancel()),
        ]);
      case OverlayPhase.transcribing:
      case OverlayPhase.delivering:
        return Row(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(
                  strokeWidth: 2, color: kProcessingAmber)),
          const SizedBox(width: 10),
          // liveRegion: the Electron overlay marks this aria-live="polite" so
          // screen-reader users hear whether their dictation landed.
          Semantics(
            liveRegion: true,
            child: Text(
                p.status.phase == OverlayPhase.transcribing
                    ? 'Transcribing…'
                    : 'Typing…',
                style: const TextStyle(color: kTextPrimary, fontSize: 13)),
          ),
          const SizedBox(width: 10),
          _iconBtn(Icons.close, 'Cancel', () => p.cancel()),
        ]);
      case OverlayPhase.done:
        // Title reflects what actually happened (overlay.js does the same):
        // a clipboard fallback or clipboard-only mode must not claim "Pasted",
        // and a degraded delivery (note) must not wear the green check.
        final note = p.status.note;
        if (note != null) {
          return _message(
              Icons.help_outline, kProcessingAmber, 'Copied to clipboard',
              note);
        }
        final title = switch (p.status.method) {
          'paste' => 'Pasted',
          'paste-copy' => 'Pasted & copied',
          _ => 'Copied to clipboard',
        };
        return _message(
            Icons.check_circle, kDoneGreen, title, p.status.detail);
      case OverlayPhase.empty:
        return _message(Icons.help_outline, kMuted, 'Nothing heard',
            'Try again closer to the mic');
      case OverlayPhase.error:
        return _message(
            Icons.error_outline, kMuted, 'Failed', p.status.detail);
      case OverlayPhase.idle:
        return const SizedBox.shrink();
    }
  }

  Widget _message(IconData icon, Color color, String title, String? detail) {
    return Semantics(
      liveRegion: true,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(icon, color: color, size: 16),
      const SizedBox(width: 8),
      Flexible(
        child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title,
                  style: const TextStyle(color: kTextPrimary, fontSize: 13)),
              if (detail != null && detail.isNotEmpty)
                Text(detail,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style:
                        const TextStyle(color: kTextDetail, fontSize: 11)),
            ]),
        ),
      ]),
    );
  }

  Widget _iconBtn(IconData icon, String tooltip, VoidCallback onTap,
      {bool filled = false}) {
    return IconButton(
      icon: Icon(icon, size: 18, color: filled ? Colors.white : kTextDetail),
      tooltip: tooltip,
      padding: EdgeInsets.zero,
      // ~40px targets like the reference's deliberately expanded hit areas —
      // a mis-hit on Cancel destroys the dictation.
      constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
      style: filled
          ? IconButton.styleFrom(
              backgroundColor: kRecordRed, shape: const CircleBorder())
          : null,
      onPressed: onTap,
    );
  }

  String _fmt(double seconds) {
    final s = seconds.floor();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }
}

class _Meter extends StatelessWidget {
  final ValueNotifier<double> level;
  const _Meter({required this.level});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<double>(
      valueListenable: level,
      builder: (_, v, _) => Row(
        mainAxisSize: MainAxisSize.min,
        children: List.generate(12, (i) {
          final active = v * 12 > i;
          return Container(
            width: 3,
            height: 6 + i * 1.2,
            margin: const EdgeInsets.symmetric(horizontal: 1),
            decoration: BoxDecoration(
              color: active ? kDoneGreen : Colors.white24,
              borderRadius: BorderRadius.circular(1.5),
            ),
          );
        }),
      ),
    );
  }
}

class _PulsingDot extends StatefulWidget {
  final Color color;
  const _PulsingDot({required this.color});

  @override
  State<_PulsingDot> createState() => _PulsingDotState();
}

class _PulsingDotState extends State<_PulsingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 900))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween(begin: 0.35, end: 1.0).animate(_c),
      child: Container(
        width: 10,
        height: 10,
        decoration:
            BoxDecoration(color: widget.color, shape: BoxShape.circle),
      ),
    );
  }
}
