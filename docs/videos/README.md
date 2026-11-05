# Earheart demo videos

Two compositions of the same 48-second demo, ready to share on social media:

| Video | Resolution | Aspect ratio |
| --- | --- | --- |
| [Horizontal MP4](earheart-horizontal.mp4?raw=true) | 1920 × 1080 | 16:9 |
| [Vertical MP4](earheart-vertical.mp4?raw=true) | 1080 × 1920 | 9:16 |

Both exports use H.264 video at 30 fps and AAC stereo audio, with an original
electronic soundtrack. On-screen text explains the flow with sound off. The
vertical cut uses a dedicated portrait layout with stacked before-and-after
cards, rather than a crop of the horizontal cut.

The sequence covers the hotkey, live dictation, on-device cleanup, paste into
the focused app, and private processing with the built-in engines. The
12-second cleanup sequence illustrates filler removal, false-start resolution,
and rephrasing. This example uses the optional **Polished** cleanup style;
**Clean**, the default, preserves the speaker's wording while removing fillers
and stumbles. See [cleanup styles](../../main/cleanup-styles.js).

These are illustrated workflows using Earheart's branding and a staged overlay,
not recordings of live inference or measurements of processing speed. The
prompt is left for the user to review and submit. The visuals and soundtrack
were generated for this project with Pillow, NumPy, and FFmpeg.

The [poster](poster.jpg) is the horizontal end card used in the main README.
Videos live under `docs/`, outside the application's packaging file list.
