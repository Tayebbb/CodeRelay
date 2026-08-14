/**
 * Generates the PWA icon set from the CodeRelay chevron mark — dependency-free.
 *
 * A PNG encoder over node:zlib plus a tiny vector rasterizer (distance-to-
 * segment strokes, supersampled) keeps the repository free of image tooling
 * while still shipping the real PNGs Android and iOS require for install.
 *
 * Run manually after changing the mark:  node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');

// ---------------------------------------------------------------- png encoder

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let crc = -1;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- rasterization

/** The mark, in the favicon's 24-unit space: two chevrons and a slash. */
const SEGMENTS = [
  [8, 7, 4, 12], [4, 12, 8, 17],
  [16, 7, 20, 12], [20, 12, 16, 17],
  [13.5, 5, 10.5, 19],
];
const STROKE = 1.9;

const BG = [0x0b, 0x0b, 0x0e];
const FG = [0x3d, 0x8b, 0xfd];

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * @param size    output pixels
 * @param options maskable: full-bleed square background with the glyph inside
 *                the 80% safe zone; otherwise a rounded square.
 */
function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : size * (7 / 32);
  // Glyph scale: maskable platforms may crop to a circle, so shrink further.
  const glyphScale = (maskable ? 0.62 : 0.8) * (size / 24);
  const offset = (size - 24 * glyphScale) / 2;
  const half = (STROKE * glyphScale) / 2;
  const SS = 3; // 3x3 supersampling

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          // rounded-square coverage
          const ix = Math.max(radius - px, px - (size - radius), 0);
          const iy = Math.max(radius - py, py - (size - radius), 0);
          if (ix * ix + iy * iy > radius * radius) continue;
          bgHits++;

          const gx = (px - offset) / glyphScale;
          const gy = (py - offset) / glyphScale;
          for (const [x1, y1, x2, y2] of SEGMENTS) {
            // both sides in glyph units
            if (distanceToSegment(gx, gy, x1, y1, x2, y2) <= STROKE / 2) {
              fgHits++;
              break;
            }
          }
        }
      }
      const i = (y * size + x) * 4;
      const cover = bgHits / (SS * SS);
      const glyph = fgHits / (SS * SS);
      rgba[i] = BG[0] + (FG[0] - BG[0]) * glyph;
      rgba[i + 1] = BG[1] + (FG[1] - BG[1]) * glyph;
      rgba[i + 2] = BG[2] + (FG[2] - BG[2]) * glyph;
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return rgba;
}

// --------------------------------------------------------------------- write

fs.mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ['icon-180.png', 180, {}], // apple-touch-icon
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, options] of targets) {
  fs.writeFileSync(path.join(OUT_DIR, name), encodePng(size, drawIcon(size, options)));
  console.log(`wrote ${name}`);
}
