// Generates every icon from code so the repo has no hand-drawn binaries:
//   resources/trayIdleTemplate.png(@2x)       macOS template: ring
//   resources/trayRecordingTemplate.png(@2x)  macOS template: filled dot
//   resources/tray-idle.ico / tray-recording.ico  Windows: gray ring / red dot
//   build/icon.png                            512px app icon for electron-builder
//   build/icon.icns                           native macOS icon set (generated on macOS)
//   build/background.png (@2x)                DMG drag-to-Applications background
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
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
function rasterize(width, layers, height = width) {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
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
      const o = (y * width + x) * 4;
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

function png(width, rgba, height = width) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
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
function appIcon(size) {
  const c = size / 2;
  return png(
      size,
      rasterize(size, [
        { shape: roundedSquare(size, size * 0.22), rgba: DARK },
        { shape: ring(c, c, size * 0.34, size * 0.3), rgba: WHITE },
        { shape: circle(c, c, size * 0.22), rgba: RED },
      ]),
    );
}

writeFileSync("build/icon.png", appIcon(512));

// DMG background: the installer UI is the familiar "drag the app onto the
// Applications folder" layout used by most macOS apps, so the image is only
// a neutral canvas with an arrow between the two icon slots. No text is drawn:
// it would need font rendering and a translation, and the two icons already
// explain the gesture. Layout coordinates in points (1x) must match the
// window/icon positions in electron-builder.yml (window 540×380, icon
// centers at x=130/410, y=190; iconSize 128).
const BACKGROUND_WIDTH = 540;
const BACKGROUND_HEIGHT = 380;
const CANVAS = [242, 242, 247, 255]; // Apple systemGray6 light; readable in dark mode too
const ARROW = [142, 142, 147, 255]; // systemGray

/** Right-pointing arrow: rectangular shaft plus triangular head, all in points. */
function arrow(x0, x1, cy, shaft, head) {
  const headStart = x1 - head;
  return (x, y) => {
    if (x < x0 || x > x1) return false;
    if (x <= headStart) return Math.abs(y - cy) <= shaft / 2;
    const t = (x1 - x) / head; // 1 at head base, 0 at tip
    return Math.abs(y - cy) <= t * head * 0.5;
  };
}

function background(scale) {
  const w = BACKGROUND_WIDTH * scale;
  const h = BACKGROUND_HEIGHT * scale;
  const shape = arrow(215 * scale, 325 * scale, 190 * scale, 10 * scale, 40 * scale);
  return png(w, rasterize(w, [
    { shape: () => true, rgba: CANVAS },
    { shape, rgba: ARROW },
  ], h), h);
}

writeFileSync("build/background.png", background(1));
writeFileSync("build/background@2x.png", background(2));

// Avoid electron-builder's PNG -> ICNS conversion: its legacy 16/32px
// representations rendered as noise in macOS privacy settings. Ship the
// native ICNS in the repo so Windows development does not need iconutil.
if (process.platform === "darwin") {
  const scratch = mkdtempSync(path.join(tmpdir(), "recordstuff-icons-"));
  const iconset = path.join(scratch, "RecordStuff.iconset");
  try {
    mkdirSync(iconset);
    const images = new Map();
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        if (!images.has(pixels)) images.set(pixels, appIcon(pixels));
        writeFileSync(path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`), images.get(pixels));
      }
    }
    execFileSync("/usr/bin/iconutil", ["-c", "icns", "-o", path.resolve("build/icon.icns"), iconset]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  console.log("macOS ICNS unchanged; run pnpm icons on macOS after changing the app artwork.");
}

console.log("icons written to resources/ and build/");
