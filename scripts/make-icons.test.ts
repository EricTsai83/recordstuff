/**
 * `pnpm icons` is the only source of the tray and app artwork: a fresh run
 * must reproduce every committed file byte for byte, and each tray state must
 * ship at the sizes the tray loads (plans 040 and 034).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATES = ["Idle", "Busy", "Countdown", "Recording", "Warning"];
// Windows notification-area scales 100/125/150/200%, plus 48 px.
const WINDOWS_SIZES = [16, 20, 24, 32, 48];
let out: string;

beforeAll(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-icons-"));
  execFileSync(process.execPath, [path.join(ROOT, "scripts/make-icons.mjs")], { cwd: out, stdio: "pipe" });
}, 60_000);
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

function pngSize(data: Buffer): [number, number] {
  expect(data.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

function icoEntries(data: Buffer): Buffer[] {
  const count = data.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => data.subarray(data.readUInt32LE(6 + i * 16 + 12)));
}

/** RGBA of an unfiltered 8-bit RGBA PNG, which is what the generator writes. */
function pngPixels(data: Buffer): Buffer {
  const [width, height] = pngSize(data);
  const idat: Buffer[] = [];
  for (let at = 8; at < data.length; at += 12 + data.readUInt32BE(at)) {
    if (data.subarray(at + 4, at + 8).toString("ascii") === "IDAT") idat.push(data.subarray(at + 8, at + 8 + data.readUInt32BE(at)));
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * stride], "PNG filter").toBe(0);
    raw.copy(rgba, y * width * 4, y * stride + 1, (y + 1) * stride);
  }
  return rgba;
}

/** Grey level over black, so transparent pixels count as 0. */
function luminance(rgba: Buffer, at: number): number {
  return (0.2126 * rgba[at]! + 0.7152 * rgba[at + 1]! + 0.0722 * rgba[at + 2]!) * (rgba[at + 3]! / 255);
}

describe("make-icons", () => {
  it("reproduces every committed asset byte for byte", () => {
    const generated = ["resources", "build"].flatMap((dir) =>
      fs.readdirSync(path.join(out, dir)).map((name) => path.join(dir, name)));
    // The ICNS is only generated on macOS.
    expect(generated.length).toBeGreaterThanOrEqual(STATES.length * 3 + 3);
    for (const file of generated) {
      expect(fs.readFileSync(path.join(out, file)).equals(fs.readFileSync(path.join(ROOT, file))), file).toBe(true);
    }
  });

  it("ships a 16 pt template with its @2x and a five-size Windows ICO for every tray state", () => {
    for (const state of STATES) {
      expect(pngSize(fs.readFileSync(path.join(out, `resources/tray${state}Template.png`))), state).toEqual([16, 16]);
      expect(pngSize(fs.readFileSync(path.join(out, `resources/tray${state}Template@2x.png`))), state).toEqual([32, 32]);
      const entries = icoEntries(fs.readFileSync(path.join(out, `resources/tray-${state.toLowerCase()}.ico`)));
      expect(entries.map((entry) => pngSize(entry)), state).toEqual(WINDOWS_SIZES.map((size) => [size, size]));
    }
  });

  it("draws distinct shapes for busy and countdown", () => {
    const pixels = (state: string): Buffer => fs.readFileSync(path.join(out, `resources/tray${state}Template@2x.png`));
    const all = STATES.map(pixels);
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) expect(all[i]!.equals(all[j]!), `${STATES[i]} vs ${STATES[j]}`).toBe(false);
    }
  });

  it("keeps Windows corners transparent and tells every state apart without colour at each size", () => {
    const decoded = STATES.map((state) => icoEntries(fs.readFileSync(path.join(out, `resources/tray-${state.toLowerCase()}.ico`))).map(pngPixels));
    for (const [index, size] of WINDOWS_SIZES.entries()) {
      const images = decoded.map((entries) => entries[index]!);
      for (const [s, rgba] of images.entries()) {
        for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]] as const) {
          expect(rgba[(y * size + x) * 4 + 3], `${STATES[s]} ${size} px corner`).toBe(0);
        }
      }
      // A visible grey step on a meaningful area, not a hue change or a stray edge pixel.
      for (let i = 0; i < images.length; i += 1) {
        for (let j = i + 1; j < images.length; j += 1) {
          let differing = 0;
          for (let at = 0; at < size * size * 4; at += 4) {
            if (Math.abs(luminance(images[i]!, at) - luminance(images[j]!, at)) > 48) differing += 1;
          }
          expect(differing, `${STATES[i]} vs ${STATES[j]} at ${size} px`).toBeGreaterThanOrEqual(size / 2);
        }
      }
    }
  });
});
