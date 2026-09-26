// Generates every icon from code so the repo has no hand-drawn binaries:
//   resources/trayIdleTemplate.png(@2x)       macOS template: ring
//   resources/trayBusyTemplate.png(@2x)       macOS template: hourglass (starting, saving)
//   resources/trayCountdownTemplate.png(@2x)  macOS template: stopwatch (plan 040)
//   resources/trayRecordingTemplate.png(@2x)  macOS template: filled dot
//   resources/trayWarningTemplate.png(@2x)    macOS template: ring with a badge
//   resources/tray-<state>.ico                Windows (plan 034): the app icon's dark rounded base
//                                             with a white ring, red centre, amber "!", hourglass
//                                             or stopwatch; 16/20/24/32/48 px entries
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
const RED = [230, 57, 70, 255];
const WHITE = [255, 255, 255, 255];
const DARK = [28, 28, 30, 255];
const AMBER = [255, 185, 0, 255];
// Rim of the Windows tray base: separates it from a dark taskbar.
const EDGE = [120, 120, 126, 255];

function idleShape(size) {
  const c = size / 2;
  return ring(c, c, size * 0.36, size * 0.24);
}

function recordingShape(size) {
  const c = size / 2;
  return circle(c, c, size * 0.36);
}

/** Axis-aligned box in fractions of the icon size. */
function box(size, x0, x1, y0, y1) {
  return (x, y) => x >= size * x0 && x <= size * x1 && y >= size * y0 && y <= size * y1;
}

// Hourglass outline (plan 040): bars across the top and bottom joined by two
// strokes 0.09 wide that narrow to a waist 0.07 wide at the centre. A ring
// with three dots inside was tried first and read as too faint at 16 pt.
function busyShape(size) {
  const top = box(size, 0.22, 0.78, 0.10, 0.19);
  const bottom = box(size, 0.22, 0.78, 0.81, 0.90);
  const stroke = 0.09;
  const waist = 0.07 / 2;
  // Outer edge meets each bar just inside its ends.
  const rim = 0.25;
  return (x, y) => {
    if (top(x, y) || bottom(x, y)) return true;
    const nx = x / size, ny = y / size;
    if (ny <= 0.19 || ny >= 0.81) return false;
    const t = Math.abs(ny - 0.5) / 0.31;
    const outer = waist + stroke + (rim - waist - stroke) * t;
    const inner = outer - stroke;
    const d = Math.abs(nx - 0.5);
    return d >= inner && d <= outer;
  };
}

// Stopwatch (plan 040): ring, crown, stem, a hand pointing up and a hub.
function countdownShape(size) {
  const c = size / 2;
  const cy = size * 0.56;
  const parts = [
    ring(c, cy, size * 0.31, size * 0.20),
    box(size, 0.40, 0.60, 0.05, 0.14),
    box(size, 0.46, 0.54, 0.13, 0.27),
    box(size, 0.46, 0.54, 0.40, 0.56),
    circle(c, cy, size * 0.07),
  ];
  return (x, y) => parts.some((part) => part(x, y));
}

// One template image: existing ring with a lower-right exclamation badge.
// Knock out a halo so both light and dark menu bars retain the badge silhouette.
function warningShape(size) {
  const base = idleShape(size);
  const halo = circle(size * .76, size * .76, size * .27);
  const badge = circle(size * .76, size * .76, size * .22);
  return (x, y) => {
    const nx = x / size, ny = y / size;
    const mark = Math.abs(nx - .76) < .045 && ((ny > .60 && ny < .78) || (ny > .83 && ny < .91));
    return (base(x, y) && !halo(x, y)) || (badge(x, y) && !mark);
  };
}

mkdirSync("resources", { recursive: true });
mkdirSync("build", { recursive: true });

// macOS template images: black + alpha only.
for (const [name, shapeOf] of [
  ["trayIdleTemplate", idleShape],
  ["trayBusyTemplate", busyShape],
  ["trayCountdownTemplate", countdownShape],
  ["trayRecordingTemplate", recordingShape],
  ["trayWarningTemplate", warningShape],
]) {
  writeFileSync(`resources/${name}.png`, png(16, rasterize(16, [{ shape: shapeOf(16), rgba: BLACK }])));
  writeFileSync(`resources/${name}@2x.png`, png(32, rasterize(32, [{ shape: shapeOf(32), rgba: BLACK }])));
}

// Windows tray icons (plan 034). An ICO has no template mode, so one image
// must read on light, dark and accent-coloured taskbars alike: each state sits
// on the app icon's dark rounded base, whose grey rim keeps its edge on a dark
// taskbar. A white ring with an empty centre is idle; a red centre is
// recording, so the two differ in shape and in grey level, not only in hue;
// an amber "!" inside a ring (thinner at 16 px to leave it room) is the
// warning; busy and countdown keep 040's hourglass and stopwatch. A version
// without the base needed a dark outline that turned the white ring into a
// thin double line on a light taskbar. Geometry is in pixels per ICO entry so
// edges land on the pixel grid at every scale: Windows shows 16 px at 100%,
// 20 at 125%, 24 at 150% and 32 at 200%; 48 serves larger shell views.
const WINDOWS_TRAY = {
  16: { margin: 1, corner: 3, edge: 1, ring: 5.5, stroke: 2, warningStroke: 1.5, dot: 2.5,
    mark: [1, -3, 0, 1, 3], glass: [4, -5, 2, 5, 1.6, 1.4], watch: [1, 4.5, 1.5, 2, -6, -4.5, 1, 1, 1, 1.5] },
  20: { margin: 1, corner: 4, edge: 1, ring: 7, stroke: 2, warningStroke: 2, dot: 4,
    mark: [1, -4, 1, 2, 4], glass: [5, -7, 2, 7, 1.8, 1.6], watch: [1, 6, 2, 2, -8, -6, 1, 1, 1, 1.75] },
  24: { margin: 1, corner: 5, edge: 1, ring: 8.5, stroke: 2.5, warningStroke: 2.5, dot: 4.75,
    mark: [1, -5, 1, 3, 5], glass: [6, -8, 2, 8, 2, 1.8], watch: [1, 7, 2.5, 3, -10, -8, 1, 1, 1, 2] },
  32: { margin: 2, corner: 6, edge: 1, ring: 11, stroke: 3, warningStroke: 3, dot: 6.5,
    mark: [2, -7, 1, 3, 7], glass: [8, -11, 3, 11, 2.6, 2.4], watch: [1.5, 9.5, 3, 4, -13, -10.5, 1.5, 1.5, 1.5, 2.5] },
  48: { margin: 3, corner: 9, edge: 1.5, ring: 16.5, stroke: 4.5, warningStroke: 4.5, dot: 10.5,
    mark: [3, -10, 2, 5, 10], glass: [12, -16, 4, 16, 3.8, 3.4], watch: [2, 14, 4.5, 6, -19.5, -15.5, 2, 2, 2.5, 3.5] },
};

/** Axis-aligned box in pixels. */
function rect(x0, x1, y0, y1) {
  return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function union(...shapes) {
  return (x, y) => shapes.some((shape) => shape(x, y));
}

function offset(shape, dx, dy) {
  return (x, y) => shape(x - dx, y - dy);
}

/** Offsets are from the icon centre c, in pixels. */
function exclamation(c, [halfWidth, barTop, barEnd, dotTop, dotEnd]) {
  return union(
    rect(c - halfWidth, c + halfWidth, c + barTop, c + barEnd),
    rect(c - halfWidth, c + halfWidth, c + dotTop, c + dotEnd),
  );
}

// busyShape in pixels: bars `bar` thick at `top` and `bottom`, joined by two
// strokes whose outer edges run from just inside the bar ends to `waist`.
function hourglass(c, [halfWidth, top, bar, bottom, stroke, waist]) {
  const y0 = c + top, y1 = c + bottom;
  const span = c - (y0 + bar);
  return (x, y) => {
    if (x < c - halfWidth || x > c + halfWidth || y < y0 || y > y1) return false;
    if (y <= y0 + bar || y >= y1 - bar) return true;
    const t = Math.abs(y - c) / span; // 0 at the waist, 1 at a bar
    const outer = waist + stroke / 2 + (halfWidth - 0.5 - waist - stroke / 2) * t;
    const d = Math.abs(x - c);
    return d <= outer && d >= outer - stroke;
  };
}

// countdownShape in pixels. The hand stops `gap` short of the ring: joined to
// the stem it would read as a power symbol at 16 px.
function stopwatch(c, [dy, radius, stroke, crownHalf, crownTop, crownBottom, stemHalf, handHalf, gap, hub]) {
  const cy = c + dy;
  return union(
    ring(c, cy, radius, radius - stroke),
    rect(c - crownHalf, c + crownHalf, c + crownTop, c + crownBottom),
    rect(c - stemHalf, c + stemHalf, c + crownBottom, cy - radius + stroke / 2),
    rect(c - handHalf, c + handHalf, cy - radius + stroke + gap, cy),
    circle(c, cy, hub),
  );
}

function windowsTrayLayers(state, size) {
  const g = WINDOWS_TRAY[size];
  const c = size / 2;
  const side = size - 2 * g.margin;
  const inset = g.margin + g.edge;
  const layers = [
    { shape: offset(roundedSquare(side, g.corner), g.margin, g.margin), rgba: EDGE },
    { shape: offset(roundedSquare(side - 2 * g.edge, g.corner - g.edge), inset, inset), rgba: DARK },
  ];
  const whiteRing = ring(c, c, g.ring, g.ring - g.stroke);
  switch (state) {
    case "idle":
      return [...layers, { shape: whiteRing, rgba: WHITE }];
    case "recording":
      return [...layers, { shape: whiteRing, rgba: WHITE }, { shape: circle(c, c, g.dot), rgba: RED }];
    case "warning":
      return [...layers, { shape: ring(c, c, g.ring, g.ring - g.warningStroke), rgba: WHITE }, { shape: exclamation(c, g.mark), rgba: AMBER }];
    case "busy":
      return [...layers, { shape: hourglass(c, g.glass), rgba: WHITE }];
    case "countdown":
      return [...layers, { shape: stopwatch(c, g.watch), rgba: WHITE }];
  }
  throw new Error(`unknown tray state ${state}`);
}

for (const state of ["idle", "busy", "countdown", "recording", "warning"]) {
  const entries = Object.keys(WINDOWS_TRAY).map(Number).map((size) => ({
    size,
    data: png(size, rasterize(size, windowsTrayLayers(state, size))),
  }));
  writeFileSync(`resources/tray-${state}.ico`, ico(entries));
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
