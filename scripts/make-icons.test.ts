/**
 * `pnpm icons` is the only source of the tray and app artwork: a fresh run
 * must reproduce every committed file byte for byte, and each tray state must
 * ship at the sizes the tray loads (plan 040).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATES = ["Idle", "Busy", "Countdown", "Recording", "Warning"];
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

function icoSizes(data: Buffer): number[] {
  const count = data.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => pngSize(data.subarray(data.readUInt32LE(6 + i * 16 + 12)))[0]);
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

  it("ships a 16 pt template with its @2x and a Windows ICO for every tray state", () => {
    for (const state of STATES) {
      expect(pngSize(fs.readFileSync(path.join(out, `resources/tray${state}Template.png`))), state).toEqual([16, 16]);
      expect(pngSize(fs.readFileSync(path.join(out, `resources/tray${state}Template@2x.png`))), state).toEqual([32, 32]);
      expect(icoSizes(fs.readFileSync(path.join(out, `resources/tray-${state.toLowerCase()}.ico`))), state).toEqual([16, 24, 32, 48]);
    }
  });

  it("draws distinct shapes for busy and countdown", () => {
    const pixels = (state: string): Buffer => fs.readFileSync(path.join(out, `resources/tray${state}Template@2x.png`));
    const all = STATES.map(pixels);
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) expect(all[i]!.equals(all[j]!), `${STATES[i]} vs ${STATES[j]}`).toBe(false);
    }
  });
});
