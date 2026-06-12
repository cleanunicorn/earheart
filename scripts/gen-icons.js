#!/usr/bin/env node
// Generates the app and tray icons (a heart with a waveform — "earheart")
// as PNGs, with no image dependencies: pixels are rendered with signed
// distance functions and encoded with a minimal PNG writer on top of zlib.

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

function inWave(x, y, scale) {
  return WAVE_BARS.some((bar) =>
    inBar(x, y, bar.cx * scale, bar.h * scale, 0.075 * scale)
  );
}

/* ---------- renderers ---------- */

function mix(a, b, t) {
  return a + (b - a) * t;
}

// Renders one icon. `style`: "app" (rounded square bg + heart + wave) or
// "glyph" (transparent bg, solid-color heart + punched-out wave).
function render(size, style, glyphColor) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling grid (4x4) for clean edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHit = 0;
      let heartHit = 0;
      let waveHit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Normalized coords: x right, y up, [-1, 1] across the icon.
          const nx = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const ny = 1 - ((py + (sy + 0.5) / SS) / size) * 2;
          if (style === "app" && inRoundedRect(nx, ny, 1, 0.36)) bgHit++;
          // Heart space: slightly smaller than the canvas, nudged up.
          const hx = nx / 0.62;
          const hy = (ny + 0.06) / 0.62;
          const inH = inHeart(hx, hy);
          if (inH) heartHit++;
          if (inH && inWave(nx, ny + 0.02, 1)) waveHit++;
        }
      }
      const samples = SS * SS;
      const bgA = bgHit / samples;
      const heartA = heartHit / samples;
      const waveA = waveHit / samples;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (style === "app") {
        // Dark rounded square.
        r = 0x1d;
        g = 0x1a;
        b = 0x26;
        a = bgA;
      }
      if (heartA > 0) {
        // Vertical coral gradient.
        const t = (1 - py / size) * 0.9;
        const hr = style === "app" ? mix(0xff, 0xff, t) : glyphColor[0];
        const hg = style === "app" ? mix(0x47, 0x84, t) : glyphColor[1];
        const hb = style === "app" ? mix(0x66, 0x9c, t) : glyphColor[2];
        r = mix(r, hr, heartA);
        g = mix(g, hg, heartA);
        b = mix(b, hb, heartA);
        a = Math.max(a, heartA);
      }
      if (waveA > 0) {
        if (style === "app") {
          // White waveform on the heart.
          r = mix(r, 0xff, waveA);
          g = mix(g, 0xff, waveA);
          b = mix(b, 0xff, waveA);
        } else {
          // Punch the waveform out of the glyph so it works at tray sizes.
          a = a * (1 - waveA);
        }
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

const out = path.join(__dirname, "..", "assets");
fs.mkdirSync(out, { recursive: true });

fs.writeFileSync(path.join(out, "icon.png"), render(512, "app"));
fs.writeFileSync(path.join(out, "tray.png"), render(32, "glyph", [0xe8, 0xe4, 0xf0]));
fs.writeFileSync(
  path.join(out, "tray-recording.png"),
  render(32, "glyph", [0xff, 0x54, 0x70])
);
// macOS tray works best with a 2x variant.
fs.writeFileSync(path.join(out, "tray@2x.png"), render(64, "glyph", [0xe8, 0xe4, 0xf0]));
fs.writeFileSync(
  path.join(out, "tray-recording@2x.png"),
  render(64, "glyph", [0xff, 0x54, 0x70])
);

console.log("Icons written to assets/");
