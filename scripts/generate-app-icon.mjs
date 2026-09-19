// Renders the "Banded disc" mark (option 1a from the Eise Icon Options design page)
// into every raster icon the project needs, locally, with no external service.
//
// Geometry is the design's 64-unit viewBox, verbatim:
//   disc   circle cx=32 cy=32 r=26              filled with the gilt
//   bands  three full-width rects clipped to the disc, knocked out
//   spot   circle cx=41 cy=43.5 r=4.6           knocked out (Great Red Spot)
//
// Two treatments:
//   transparent — knockouts go to alpha 0, so the mark adapts to any ground
//                 (favicon: a light tab shows light bands, a dark tab dark ones)
//   tile        — opaque rounded square in --eise-teal-900, for the desktop icon,
//                 where transparent bands would show the wallpaper through
//
// Usage: node scripts/generate-app-icon.mjs
import { writeFileSync } from 'node:fs';
import { encode } from 'fast-png';

// Design-system tokens (app.vue :root)
const GILT = [0xd9, 0xa9, 0x4a];      // --eise-gilt
const TEAL_900 = [0x09, 0x34, 0x42];  // --eise-teal-900

const SS = 4;                  // supersampling factor per axis
const CORNER_RATIO = 0.2237;   // macOS-style rounded square for the app tile

// The design draws the disc at r=26 inside a 64 box, leaving ~9% padding a side.
// A favicon has no room to spare, so the transparent renders scale the whole mark
// about its centre until the disc touches the canvas edge. The desktop tile keeps
// the inset, which is what macOS icons expect inside their rounded square.
const BLEED = 32 / 26;

const BANDS = [[18, 23], [29.5, 34.5], [41, 46]];
const DISC = { cx: 32, cy: 32, r: 26 };
const SPOT = { cx: 41, cy: 43.5, r: 4.6 };

const inCircle = (x, y, c) => (x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r ** 2;
const inBands = (y) => BANDS.some(([a, b]) => y >= a && y < b);

/**
 * @param {number} size pixels
 * @param {'transparent'|'tile'} mode
 * @returns {Uint8Array} RGBA
 */
function render(size, mode, scale = 1) {
  const out = new Uint8Array(size * size * 4);
  const unit = 64 / size;
  const radius = size * CORNER_RATIO;
  const sub = 1 / SS;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let gold = 0, tile = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + (sx + 0.5) * sub;
          const fy = py + (sy + 0.5) * sub;
          // Scaling the sample point by 1/scale about the centre enlarges every
          // part of the mark together: disc, bands and spot stay in proportion.
          const x = 32 + (fx * unit - 32) / scale;
          const y = 32 + (fy * unit - 32) / scale;
          const onDisc = inCircle(x, y, DISC) && !inBands(y) && !inCircle(x, y, SPOT);
          if (onDisc) gold++;
          if (mode === 'tile') {
            // Rounded-square coverage, measured in pixel space.
            const qx = Math.abs(fx - size / 2) - (size / 2 - radius);
            const qy = Math.abs(fy - size / 2) - (size / 2 - radius);
            const inside = (qx <= 0 || qy <= 0)
              ? true
              : qx * qx + qy * qy <= radius * radius;
            if (inside) tile++;
          }
        }
      }
      const n = SS * SS;
      const g = gold / n;
      const i = (py * size + px) * 4;
      if (mode === 'transparent') {
        out[i] = GILT[0]; out[i + 1] = GILT[1]; out[i + 2] = GILT[2];
        out[i + 3] = Math.round(g * 255);
      } else {
        const t = tile / n;
        for (let c = 0; c < 3; c++) {
          out[i + c] = Math.round(TEAL_900[c] * (1 - g) + GILT[c] * g);
        }
        out[i + 3] = Math.round(t * 255);
      }
    }
  }
  return out;
}

const png = (size, mode) =>
  encode({
    width: size, height: size, channels: 4, depth: 8,
    data: render(size, mode, mode === 'transparent' ? BLEED : 1),
  });

/** ICO container holding PNG-encoded images (supported by every current browser). */
function ico(sizes) {
  const images = sizes.map((s) => ({ size: s, buf: png(s, 'transparent') }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, n) => {
    const e = 6 + 16 * n;
    header.writeUInt8(img.size >= 256 ? 0 : img.size, e);
    header.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(img.buf.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.buf.length;
  });
  return Buffer.concat([header, ...images.map((i) => Buffer.from(i.buf))]);
}

const targets = [
  ['electron/build-resources/icon.png', () => png(1024, 'tile'), 'desktop app icon, inset inside the rounded tile'],
  ['public/favicon.png', () => png(512, 'transparent'), 'referenced as the schema.org logo in pages/index.vue'],
  ['public/icon-512.png', () => png(512, 'transparent'), 'square mark, 512'],
  ['public/icon.png', () => png(1024, 'transparent'), 'square mark, 1024'],
  ['public/favicon.ico', () => ico([16, 32, 48]), 'browser tab icon, full bleed'],
];

for (const [path, make, note] of targets) {
  const buf = make();
  writeFileSync(path, buf);
  console.log(`${path.padEnd(38)} ${String(buf.length).padStart(8)} bytes   ${note}`);
}
