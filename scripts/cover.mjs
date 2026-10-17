// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-blue gradient, a
// stack of shipping containers with their status lights, and a pulse line.
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [10, 18, 32];
const BLUE = [16, 84, 140];
const WHITE = [238, 244, 250];
const GREEN = [70, 210, 120];
const RED = [235, 80, 70];
const AMBER = [255, 176, 48];
const COLORS = [
  [32, 120, 190],
  [20, 150, 160],
  [48, 96, 170],
  [24, 132, 120],
  [60, 110, 200],
  [30, 140, 180],
];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

// The stack: [center x, center y, color, light].
const BOXES = [
  [190, 400, 0, GREEN],
  [390, 400, 1, GREEN],
  [590, 400, 2, RED],
  [290, 300, 3, GREEN],
  [490, 300, 4, AMBER],
  [390, 200, 5, GREEN],
];

function pixel(x, y) {
  let color = mix(DARK, BLUE, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  for (const [cx, cy, c, light] of BOXES) {
    const box = roundedBox(x, y, cx, cy, 92, 44, 6);
    color = mix(color, WHITE, smooth(0, Math.abs(box) - 2) * 0.9);
    color = mix(color, COLORS[c], smooth(0, box + 2));
    // Corrugation: vertical ribs.
    if (box < -6 && Math.abs(x - cx) < 70) {
      const rib = Math.abs(((x - cx + 70) % 14) - 7);
      color = mix(color, DARK, smooth(1.5, rib) * 0.35);
    }
    // The status light on the door side.
    color = mix(color, light, smooth(8, Math.hypot(x - (cx + 76), y - (cy - 24))));
  }
  // A pulse line above the stack.
  // Segments [x0, y0, x1, y1]; the distance is measured to each segment.
  const PULSE = [
    [220, 90, 370, 90],
    [370, 90, 390, 40],
    [390, 40, 415, 130],
    [415, 130, 430, 90],
    [430, 90, 580, 90],
  ];
  for (const [x0, y0, x1, y1] of PULSE) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
    color = mix(color, AMBER, smooth(3, d));
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
