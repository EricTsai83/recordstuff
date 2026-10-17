import { describe, expect, it } from "vitest";
import { nv12Planes, previewStats } from "./nv12";

describe("nv12Planes", () => {
  it("splits a frame into its luma and chroma planes", () => {
    const data = new Uint8Array(4 * 2 * 3 / 2).map((_, i) => i);
    const planes = nv12Planes({ width: 4, height: 2, data, sent: 0, n: 1 });
    expect([...planes!.luma]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...planes!.chroma]).toEqual([8, 9, 10, 11]);
  });

  it("refuses a frame whose size and bytes disagree", () => {
    expect(nv12Planes({ width: 4, height: 2, data: new Uint8Array(11), sent: 0, n: 1 })).toBeUndefined();
    expect(nv12Planes({ width: 3, height: 2, data: new Uint8Array(9), sent: 0, n: 1 })).toBeUndefined();
    expect(nv12Planes({ width: 4, height: 2, data: [] as unknown as Uint8Array, sent: 0, n: 1 })).toBeUndefined();
  });
});

describe("previewStats", () => {
  it("counts the frames drawn, the ones that never arrived and the delay", () => {
    const stats = previewStats();
    const frame = (n: number, sent: number) => ({ width: 640, height: 360, data: new Uint8Array(0), sent, n });
    stats.add(frame(5, 1000), 1004);
    expect(stats.add(frame(8, 1100), 1106)).toBe("640×360 · 2 fps · 2 drawn, 2 not received · 5.0 ms from the capture process");
    stats.reset();
    expect(stats.add(frame(9, 2000), 2002)).toContain("1 drawn, 0 not received");
  });
});
