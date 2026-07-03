#!/usr/bin/env node
// Generates the app and tray icons — an outlined heart with solid waveform
// bars ("earheart", neon style) — as PNGs, with no image dependencies:
// pixels are rendered with signed distance functions and encoded with a
// minimal PNG writer on top of zlib.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/* ---------- minimal PNG encoder ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // Raw scanlines, filter byte 0 per row.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- shapes ---------- */

// Heart: classic implicit curve (x^2 + y^2 - 1)^3 - x^2*y^3 <= 0.
function inHeart(x, y) {
  const f = (x * x + y * y - 1) ** 3 - x * x * y * y * y;
  return f <= 0;
}

function inRoundedRect(x, y, half, radius) {
  const qx = Math.max(Math.abs(x) - (half - radius), 0);
  const qy = Math.max(Math.abs(y) - (half - radius), 0);
  return qx * qx + qy * qy <= radius * radius;
}

// Capsule (rounded vertical bar) centered at (cx, 0).
function inBar(x, y, cx, halfHeight, radius) {
  const dy = Math.max(0, Math.abs(y) - halfHeight);
  const dx = x - cx;
  return dx * dx + dy * dy <= radius * radius;
}

const WAVE_BARS = [
  { cx: -0.5, h: 0.09 },
  { cx: -0.25, h: 0.26 },
  { cx: 0.0, h: 0.44 },
  { cx: 0.25, h: 0.26 },
  { cx: 0.5, h: 0.09 },
];

function inWave(x, y) {
  return WAVE_BARS.some((bar) => inBar(x, y, bar.cx, bar.h, 0.075));
}

// Recording dot, bottom-right of the glyph.
function inDot(x, y, r) {
  const dx = x - 0.58;
  const dy = y + 0.58;
  return dx * dx + dy * dy <= r * r;
}

/* ---------- renderer ---------- */

function mix(a, b, t) {
  return a + (b - a) * t;
}

// opts:
//   bg    [r,g,b] rounded-square background, or null for transparent (tray)
//   grad  [[r,g,b] bottom, [r,g,b] top] vertical gradient for heart and wave
//   dot   true → bottom-right recording dot with a punched gap ring
function render(size, opts) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling grid (4x4) for clean edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHit = 0;
      let heartHit = 0;
      let innerHit = 0;
      let waveHit = 0;
      let dotHit = 0;
      let gapHit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Normalized coords: x right, y up, [-1, 1] across the icon.
          const nx = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const ny = 1 - ((py + (sy + 0.5) / SS) / size) * 2;
          if (opts.bg && inRoundedRect(nx, ny, 1, 0.36)) bgHit++;
          // Heart space: slightly smaller than the canvas, nudged up.
          const hx = nx / 0.62;
          const hy = (ny + 0.06) / 0.62;
          const inH = inHeart(hx, hy);
          if (inH) heartHit++;
          if (inH && inHeart(hx / 0.78, hy / 0.78)) innerHit++;
          if (inH && inWave(nx, ny + 0.02)) waveHit++;
          if (opts.dot) {
            if (inDot(nx, ny, 0.3)) dotHit++;
            else if (inDot(nx, ny, 0.44)) gapHit++;
          }
        }
      }
      const samples = SS * SS;
      const bgA = bgHit / samples;
      const heartA = heartHit / samples;
      const innerA = innerHit / samples;
      const waveA = waveHit / samples;
      const dotA = dotHit / samples;
      const gapA = gapHit / samples;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (opts.bg) {
        r = opts.bg[0];
        g = opts.bg[1];
        b = opts.bg[2];
        a = bgA;
      }
      // Heart drawn as an outline band; the interior keeps a faint tint so
      // the silhouette still reads at tray sizes.
      const t = (1 - py / size) * 0.9;
      const hr = mix(opts.grad[0][0], opts.grad[1][0], t);
      const hg = mix(opts.grad[0][1], opts.grad[1][1], t);
      const hb = mix(opts.grad[0][2], opts.grad[1][2], t);
      const bodyA = heartA - innerA + innerA * 0.16;
      if (bodyA > 0) {
        r = mix(r, hr, bodyA);
        g = mix(g, hg, bodyA);
        b = mix(b, hb, bodyA);
        a = Math.max(a, bodyA);
      }
      // Solid waveform bars in the same gradient — the hero of the mark.
      if (waveA > 0) {
        r = mix(r, hr, waveA);
        g = mix(g, hg, waveA);
        b = mix(b, hb, waveA);
        a = Math.max(a, waveA);
      }
      if (opts.dot) {
        // Gap ring separates the dot from whatever it overlaps.
        a = a * (1 - gapA) * (1 - dotA);
        r = mix(r, 0xff, dotA);
        g = mix(g, 0x20, dotA);
        b = mix(b, 0x38, dotA);
        a = Math.max(a, dotA);
      }
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, rgba);
}

/* ---------- output ---------- */

const CORAL = [
  [0xff, 0x2f, 0x53],
  [0xff, 0x8c, 0xa3],
];
// Recording: red gradient plus the dot badge, unambiguous next to coral.
const RED = [
  [0xe6, 0x0e, 0x33],
  [0xff, 0x5a, 0x63],
];

const out = path.join(__dirname, "..", "assets");
fs.mkdirSync(out, { recursive: true });

fs.writeFileSync(
  path.join(out, "icon.png"),
  render(512, { bg: [0x16, 0x12, 0x1f], grad: CORAL })
);
fs.writeFileSync(path.join(out, "tray.png"), render(32, { grad: CORAL }));
fs.writeFileSync(
  path.join(out, "tray-recording.png"),
  render(32, { grad: RED, dot: true })
);
// macOS tray works best with a 2x variant.
fs.writeFileSync(path.join(out, "tray@2x.png"), render(64, { grad: CORAL }));
fs.writeFileSync(
  path.join(out, "tray-recording@2x.png"),
  render(64, { grad: RED, dot: true })
);

console.log("Icons written to assets/");
