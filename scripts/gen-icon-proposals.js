#!/usr/bin/env node
// Renders five candidate icon redesigns (app icon + tray idle + tray
// recording each) so a variant can be picked by eye before it replaces the
// shipped assets. Same zero-dependency approach as gen-icons.js: shapes are
// signed-distance tests, pixels are supersampled, PNGs are hand-encoded.
//
// Outputs:
//   assets/proposals/<n>-<key>/  icon.png, tray.png, tray@2x.png,
//                                tray-recording.png, tray-recording@2x.png
//   docs/icon-proposals/         one preview sheet per variant + overview.png
//
// Once a variant is chosen, fold its palette into gen-icons.js and delete
// this script together with the proposal assets.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/* ---------- minimal PNG encoder (same as gen-icons.js) ---------- */

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
  ihdr[8] = 8;
  ihdr[9] = 6;
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

/* ---------- shapes (same geometry as gen-icons.js) ---------- */

function inHeart(x, y) {
  const f = (x * x + y * y - 1) ** 3 - x * x * y * y * y;
  return f <= 0;
}

function inRoundedRect(x, y, half, radius) {
  const qx = Math.max(Math.abs(x) - (half - radius), 0);
  const qy = Math.max(Math.abs(y) - (half - radius), 0);
  return qx * qx + qy * qy <= radius * radius;
}

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
//   bg        [r,g,b] rounded-square background, or null for transparent
//   grad      [[r,g,b] bottom, [r,g,b] top] vertical heart gradient
//   outline   true → heart drawn as a band, interior lightly tinted
//   wave      "punch" (cut through), "white" (drawn), "solid" (heart color)
//   dot       true → bottom-right recording dot with a punched gap ring
const DOT_COLOR = [0xff, 0x20, 0x38];

function renderRGBA(size, opts) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
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
          const nx = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const ny = 1 - ((py + (sy + 0.5) / SS) / size) * 2;
          if (opts.bg && inRoundedRect(nx, ny, 1, 0.36)) bgHit++;
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
      // Heart body coverage: full for solid hearts; for outline hearts the
      // band is opaque and the interior keeps a faint tint for presence.
      const bodyA = opts.outline ? heartA - innerA + innerA * 0.16 : heartA;
      if (bodyA > 0) {
        const t = (1 - py / size) * 0.9;
        const hr = mix(opts.grad[0][0], opts.grad[1][0], t);
        const hg = mix(opts.grad[0][1], opts.grad[1][1], t);
        const hb = mix(opts.grad[0][2], opts.grad[1][2], t);
        r = mix(r, hr, bodyA);
        g = mix(g, hg, bodyA);
        b = mix(b, hb, bodyA);
        a = Math.max(a, bodyA);
      }
      if (waveA > 0) {
        if (opts.wave === "white") {
          r = mix(r, 0xff, waveA);
          g = mix(g, 0xff, waveA);
          b = mix(b, 0xff, waveA);
          a = Math.max(a, waveA);
        } else if (opts.wave === "solid") {
          const t = (1 - py / size) * 0.9;
          r = mix(r, mix(opts.grad[0][0], opts.grad[1][0], t), waveA);
          g = mix(g, mix(opts.grad[0][1], opts.grad[1][1], t), waveA);
          b = mix(b, mix(opts.grad[0][2], opts.grad[1][2], t), waveA);
          a = Math.max(a, waveA);
        } else {
          a = a * (1 - waveA);
        }
      }
      if (opts.dot) {
        // Gap ring separates the dot from whatever it overlaps.
        a = a * (1 - gapA) * (1 - dotA);
        r = mix(r, DOT_COLOR[0], dotA);
        g = mix(g, DOT_COLOR[1], dotA);
        b = mix(b, DOT_COLOR[2], dotA);
        a = Math.max(a, dotA);
      }
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

function renderPng(size, opts) {
  return encodePng(size, size, renderRGBA(size, opts));
}

/* ---------- variants ---------- */

const CORAL = [
  [0xff, 0x2f, 0x53],
  [0xff, 0x8c, 0xa3],
];
const RED = [
  [0xe6, 0x0e, 0x33],
  [0xff, 0x5a, 0x63],
];

const VARIANTS = [
  {
    key: "coral",
    name: "Coral",
    blurb: "The app icon's coral gradient heart, brought to the tray as-is.",
    app: { bg: [0x1d, 0x1a, 0x26], grad: CORAL, wave: "white" },
    tray: { grad: CORAL, wave: "punch" },
    rec: { grad: RED, wave: "punch", dot: true },
  },
  {
    key: "ember",
    name: "Ember",
    blurb: "Warm amber-to-pink sunset gradient; unmissable on any taskbar.",
    app: {
      bg: [0x26, 0x12, 0x1f],
      grad: [
        [0xff, 0x2e, 0x63],
        [0xff, 0xa6, 0x2b],
      ],
      wave: "white",
    },
    tray: {
      grad: [
        [0xff, 0x2e, 0x63],
        [0xff, 0xa6, 0x2b],
      ],
      wave: "punch",
    },
    rec: { grad: RED, wave: "punch", dot: true },
  },
  {
    key: "aurora",
    name: "Aurora",
    blurb: "Violet-to-cyan gradient; a cooler, techy departure from coral.",
    app: {
      bg: [0x0f, 0x12, 0x24],
      grad: [
        [0x8b, 0x5c, 0xf6],
        [0x22, 0xd3, 0xee],
      ],
      wave: "white",
    },
    tray: {
      grad: [
        [0x8b, 0x5c, 0xf6],
        [0x22, 0xd3, 0xee],
      ],
      wave: "punch",
    },
    rec: { grad: RED, wave: "punch", dot: true },
  },
  {
    key: "badge",
    name: "Badge",
    blurb: "The tray icon is a miniature of the app icon — dark rounded square with the coral heart.",
    app: { bg: [0x1d, 0x1a, 0x26], grad: CORAL, wave: "white" },
    tray: { bg: [0x23, 0x20, 0x2e], grad: CORAL, wave: "white" },
    rec: { bg: [0x23, 0x20, 0x2e], grad: RED, wave: "white", dot: true },
  },
  {
    key: "neon",
    name: "Neon",
    blurb: "Outlined heart with solid waveform bars — the wave becomes the hero.",
    app: { bg: [0x16, 0x12, 0x1f], grad: CORAL, wave: "solid", outline: true },
    tray: { grad: CORAL, wave: "solid", outline: true },
    rec: { grad: RED, wave: "solid", outline: true, dot: true },
  },
];

/* ---------- preview sheets ---------- */

function fillRect(dst, dstW, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * dstW + x) * 4;
      dst[i] = color[0];
      dst[i + 1] = color[1];
      dst[i + 2] = color[2];
      dst[i + 3] = 255;
    }
  }
}

function blit(dst, dstW, src, srcSize, ox, oy) {
  for (let y = 0; y < srcSize; y++) {
    for (let x = 0; x < srcSize; x++) {
      const si = (y * srcSize + x) * 4;
      const sa = src[si + 3] / 255;
      if (sa === 0) continue;
      const di = ((oy + y) * dstW + (ox + x)) * 4;
      dst[di] = Math.round(src[si] * sa + dst[di] * (1 - sa));
      dst[di + 1] = Math.round(src[si + 1] * sa + dst[di + 1] * (1 - sa));
      dst[di + 2] = Math.round(src[si + 2] * sa + dst[di + 2] * (1 - sa));
      dst[di + 3] = 255;
    }
  }
}

const SHEET_W = 720;
const SHEET_H = 240;

// Panels: app icon on light gray | tray on a dark taskbar | tray on a light
// taskbar. Tray states are shown at 64px and at the native 32px underneath.
function renderSheet(variant) {
  const sheet = Buffer.alloc(SHEET_W * SHEET_H * 4);
  fillRect(sheet, SHEET_W, 0, 0, 240, SHEET_H, [0xe9, 0xe9, 0xee]);
  fillRect(sheet, SHEET_W, 240, 0, 240, SHEET_H, [0x1c, 0x1c, 0x22]);
  fillRect(sheet, SHEET_W, 480, 0, 240, SHEET_H, [0xf3, 0xf3, 0xf3]);

  blit(sheet, SHEET_W, renderRGBA(176, variant.app), 176, 32, 32);

  const idle64 = renderRGBA(64, variant.tray);
  const rec64 = renderRGBA(64, variant.rec);
  const idle32 = renderRGBA(32, variant.tray);
  const rec32 = renderRGBA(32, variant.rec);
  for (const panelX of [240, 480]) {
    blit(sheet, SHEET_W, idle64, 64, panelX + 44, 56);
    blit(sheet, SHEET_W, rec64, 64, panelX + 132, 56);
    blit(sheet, SHEET_W, idle32, 32, panelX + 60, 160);
    blit(sheet, SHEET_W, rec32, 32, panelX + 148, 160);
  }
  return sheet;
}

/* ---------- output ---------- */

const root = path.join(__dirname, "..");
const docsDir = path.join(root, "docs", "icon-proposals");
fs.mkdirSync(docsDir, { recursive: true });

const sheets = [];
VARIANTS.forEach((variant, index) => {
  const n = index + 1;
  const dir = path.join(root, "assets", "proposals", `${n}-${variant.key}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "icon.png"), renderPng(512, variant.app));
  fs.writeFileSync(path.join(dir, "tray.png"), renderPng(32, variant.tray));
  fs.writeFileSync(path.join(dir, "tray@2x.png"), renderPng(64, variant.tray));
  fs.writeFileSync(path.join(dir, "tray-recording.png"), renderPng(32, variant.rec));
  fs.writeFileSync(path.join(dir, "tray-recording@2x.png"), renderPng(64, variant.rec));

  const sheet = renderSheet(variant);
  sheets.push(sheet);
  fs.writeFileSync(
    path.join(docsDir, `${n}-${variant.key}.png`),
    encodePng(SHEET_W, SHEET_H, sheet)
  );
});

// Overview: all variant sheets stacked with thin separators.
const SEP = 12;
const totalH = SHEET_H * sheets.length + SEP * (sheets.length - 1);
const overview = Buffer.alloc(SHEET_W * totalH * 4);
fillRect(overview, SHEET_W, 0, 0, SHEET_W, totalH, [0x0d, 0x0d, 0x10]);
sheets.forEach((sheet, i) => {
  const oy = i * (SHEET_H + SEP);
  for (let y = 0; y < SHEET_H; y++) {
    sheet.copy(
      overview,
      ((oy + y) * SHEET_W) * 4,
      y * SHEET_W * 4,
      (y + 1) * SHEET_W * 4
    );
  }
});
fs.writeFileSync(path.join(docsDir, "overview.png"), encodePng(SHEET_W, totalH, overview));

console.log(`Wrote ${VARIANTS.length} proposals to assets/proposals/ and previews to docs/icon-proposals/`);
