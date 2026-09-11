// Generates every icon from code so the repo has no hand-drawn binaries:
//   resources/trayIdleTemplate.png(@2x)       macOS template: ring
//   resources/trayRecordingTemplate.png(@2x)  macOS template: filled dot
//   resources/tray-idle.ico / tray-recording.ico  Windows: gray ring / red dot
//   build/icon.png                            512px app icon for electron-builder
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const SUPER = 4; // supersampling factor for anti-aliased edges

/** Coverage (0..1) of a pixel by the shape; shape(x, y) returns true inside. */
function coverage(shape, px, py) {
  let hit = 0;
  for (let sy = 0; sy < SUPER; sy++) {
    for (let sx = 0; sx < SUPER; sx++) {
      if (shape(px + (sx + 0.5) / SUPER, py + (sy + 0.5) / SUPER)) hit++;
    }
  }
  return hit / (SUPER * SUPER);
}

function circle(cx, cy, r) {
  return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function ring(cx, cy, outer, inner) {
  const o = circle(cx, cy, outer);
  const i = circle(cx, cy, inner);
  return (x, y) => o(x, y) && !i(x, y);
}

function roundedSquare(size, radius) {
  return (x, y) => {
    const dx = Math.max(radius - x, 0, x - (size - radius));
    const dy = Math.max(radius - y, 0, y - (size - radius));
    return dx * dx + dy * dy <= radius * radius;
  };
}

/** layers: [{ shape, rgba: [r,g,b,a] }] painted in order with alpha blending. */
function rasterize(size, layers) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (const layer of layers) {
        const c = coverage(layer.shape, x, y) * (layer.rgba[3] / 255);
        if (c === 0) continue;
        const [lr, lg, lb] = layer.rgba;
        const na = c + a * (1 - c);
        r = (lr * c + r * a * (1 - c)) / na;
        g = (lg * c + g * a * (1 - c)) / na;
        b = (lb * c + b * a * (1 - c)) / na;
        a = na;
      }
      const o = (y * size + x) * 4;
      px[o] = Math.round(r);
      px[o + 1] = Math.round(g);
      px[o + 2] = Math.round(b);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = [];
  const blobs = [];
  let offset = 6 + entries.length * 16;
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
    blobs.push(data);
  }
  return Buffer.concat([header, ...dir, ...blobs]);
}

const BLACK = [0, 0, 0, 255];
// Mid gray reads on both the dark (default) and light Windows taskbars.
const GRAY = [128, 128, 128, 255];
const RED = [230, 57, 70, 255];
const WHITE = [255, 255, 255, 255];
const DARK = [28, 28, 30, 255];

function idleShape(size) {
  const c = size / 2;
  return ring(c, c, size * 0.36, size * 0.24);
}

function recordingShape(size) {
  const c = size / 2;
  return circle(c, c, size * 0.36);
}

mkdirSync("resources", { recursive: true });
mkdirSync("build", { recursive: true });

// macOS template images: black + alpha only.
for (const [name, shapeOf] of [
  ["trayIdleTemplate", idleShape],
  ["trayRecordingTemplate", recordingShape],
]) {
  writeFileSync(`resources/${name}.png`, png(16, rasterize(16, [{ shape: shapeOf(16), rgba: BLACK }])));
  writeFileSync(`resources/${name}@2x.png`, png(32, rasterize(32, [{ shape: shapeOf(32), rgba: BLACK }])));
}

// Windows tray icons: gray ring when idle, red dot when recording.
for (const [name, shapeOf, color] of [
  ["tray-idle", idleShape, GRAY],
  ["tray-recording", recordingShape, RED],
]) {
  const entries = [16, 24, 32, 48].map((size) => ({
    size,
    data: png(size, rasterize(size, [{ shape: shapeOf(size), rgba: color }])),
  }));
  writeFileSync(`resources/${name}.ico`, ico(entries));
}

// App icon: red dot with a white ring on a dark rounded square.
{
  const size = 512;
  const c = size / 2;
  writeFileSync(
    "build/icon.png",
    png(
      size,
      rasterize(size, [
        { shape: roundedSquare(size, size * 0.22), rgba: DARK },
        { shape: ring(c, c, size * 0.34, size * 0.3), rgba: WHITE },
        { shape: circle(c, c, size * 0.22), rgba: RED },
      ]),
    ),
  );
}

console.log("icons written to resources/ and build/");
