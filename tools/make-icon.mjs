/**
 * Draws the app icon: the X8 mark in neon on a dark tile.
 *
 *   npm run icon
 *
 * Writes build/icon.png (512 px, the master), build/icon.ico (16 to 256 px, for the Windows
 * executable) and public/icon.png (128 px, the page icon and the About box).
 *
 * Every size is drawn on its own from distance functions, not scaled down from the master.
 * Small sizes get heavier strokes and no glow, so the mark stays crisp in the taskbar.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const HOT = [255, 43, 214];
const AQUA = [25, 230, 193];
const UV = [122, 77, 255];
const CENTRE = [30, 12, 54];
const EDGE = [7, 2, 15];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// --- distance functions, in tile units (the tile spans 0 to 1) ------------------------------

function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const h = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - ax - dx * h, py - ay - dy * h);
}

function box(px, py, cx, cy, hx, hy) {
  const qx = Math.abs(px - cx) - hx;
  const qy = Math.abs(py - cy) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

function roundBox(px, py, cx, cy, hx, hy, r) {
  return box(px, py, cx, cy, hx - r, hy - r) - r;
}

/** Geometry of the mark for one icon size. */
function layout(size) {
  const small = size <= 48;
  const scale = small ? 1.16 : 1;
  const height = 0.46 * scale;
  const stroke = Math.max(0.088 * scale, 1.9 / size);
  const xWidth = 0.3 * scale;
  const eightWidth = 0.27 * scale;
  const gap = 0.07 * scale;
  const left = 0.5 - (xWidth + gap + eightWidth) / 2;
  return {
    small,
    top: 0.5 - height / 2,
    bottom: 0.5 + height / 2,
    half: stroke / 2,
    x: { left, right: left + xWidth },
    eight: { left: left + xWidth + gap, right: left + xWidth + gap + eightWidth },
    glow: small ? 0 : 0.045,
    inset: small ? 0 : 0.035,
    border: Math.max(1 / size, 0.012),
  };
}

/** The X: two strokes, cut flat where they meet the top and bottom of the letter. */
function letterX(px, py, g) {
  const { left, right } = g.x;
  const strokes = Math.min(
    segment(px, py, left, g.top, right, g.bottom),
    segment(px, py, left, g.bottom, right, g.top),
  );
  const bounds = box(px, py, (left + right) / 2, (g.top + g.bottom) / 2, (right - left) / 2, (g.bottom - g.top) / 2);
  return Math.max(strokes - g.half * 1.12, bounds);
}

/** The 8: two stacked rounded loops sharing their middle stroke, the upper one narrower. */
function letter8(px, py, g) {
  const { left, right } = g.eight;
  const cx = (left + right) / 2;
  const width = right - left;
  const middle = g.top + (g.bottom - g.top) * 0.46;
  const loop = (top, bottom, w) => {
    const hx = w / 2 - g.half;
    const hy = (bottom - top) / 2 - g.half;
    return Math.abs(roundBox(px, py, cx, (top + bottom) / 2, hx, hy, Math.min(hx, hy) * 0.62)) - g.half;
  };
  return Math.min(loop(g.top, middle + g.half, width * 0.9), loop(middle - g.half, g.bottom, width));
}

// --- shading ---------------------------------------------------------------------------------

/** Colour and coverage of one sample. */
function shade(u, v, size, g) {
  const tileHalf = 0.5 - g.inset;
  const tile = roundBox(u, v, 0.5, 0.5, tileHalf, tileHalf, 0.2 * tileHalf * 2);
  if (tile > 0) return null;

  // Background: a violet glow in the middle, near black at the edges, with scanlines.
  const radial = clamp(Math.hypot(u - 0.5, v - 0.56) / 0.62, 0, 1);
  let colour = mix(CENTRE, EDGE, smoothstep(0, 1, radial));
  if (size >= 64) {
    const period = size >= 256 ? 3 : 2;
    if (Math.floor((v * size) / (period / 2)) % 2 === 1) colour = colour.map((c) => c * 0.72);
  }

  // The letters, each with a glow in its own colour and a white-hot core.
  const letters = [
    [letterX(u, v, g), HOT],
    [letter8(u, v, g), AQUA],
  ];
  for (const [d, tint] of letters) {
    if (g.glow > 0 && d > 0) {
      const glow = Math.exp(-d / g.glow) * 0.75;
      colour = mix(colour, tint, clamp(glow, 0, 1));
    }
  }
  for (const [d, tint] of letters) {
    const px = 1 / size;
    const inside = clamp(0.5 - d / px, 0, 1);
    if (inside <= 0) continue;
    const depth = g.small ? 0 : clamp(-d / g.half, 0, 1);
    const core = mix(tint, [255, 255, 255], depth * depth * 0.55);
    colour = mix(colour, core, inside);
  }

  // A thin rim running from magenta through ultraviolet to aqua.
  if (-tile < g.border) {
    const along = clamp((u + v) / 2, 0, 1);
    const rim = along < 0.5 ? mix(HOT, UV, along * 2) : mix(UV, AQUA, (along - 0.5) * 2);
    colour = mix(colour, rim, 0.85);
  }
  return colour;
}

/** Renders one size with 4 x 4 samples per pixel. Returns RGBA bytes, rows top to bottom. */
function render(size) {
  const g = layout(size);
  const pixels = new Uint8Array(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let gr = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = shade((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size, size, g);
          if (!c) continue;
          r += c[0];
          gr += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(gr / a);
        pixels[i + 2] = Math.round(b / a);
      }
      pixels[i + 3] = Math.round((a / (n * n)) * 255);
    }
  }
  return pixels;
}

// --- file formats ----------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 32-bit bitmap entry, which every part of Windows reads, including at small sizes. */
function bitmap(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  out.writeUInt32LE(40, 0);
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8); // colour and mask stacked
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(32, 14);
  out.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // bottom up
    for (let x = 0; x < size; x++) {
      const from = (row * size + x) * 4;
      const to = 40 + (y * size + x) * 4;
      out[to] = rgba[from + 2];
      out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from];
      out[to + 3] = rgba[from + 3];
      if (rgba[from + 3] === 0) {
        const mask = 40 + size * size * 4 + y * maskRow + (x >> 3);
        out[mask] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

function ico(sizes) {
  const images = sizes.map((size) => {
    const rgba = render(size);
    return { size, data: size >= 256 ? png(size, rgba) : bitmap(size, rgba) };
  });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header[at] = size >= 256 ? 0 : size;
    header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`${path}  (${(data.length / 1024).toFixed(0)} KB)`);
}

write('build/icon.png', png(512, render(512)));
write('build/icon.ico', ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
write('public/icon.png', png(128, render(128)));
