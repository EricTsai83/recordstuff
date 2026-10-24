import { describe, expect, it } from "vitest";
import { codecFrom, isPreviewMessage, previewStats } from "./preview-stream";

describe("codecFrom", () => {
  it("names the codec from an avcC record's profile, compatibility and level", () => {
    expect(codecFrom(new Uint8Array([1, 0x64, 0x00, 0x1e, 0xff]))).toBe("avc1.64001e");
    expect(codecFrom(new Uint8Array([1, 0x42, 0xc0, 0x1f]))).toBe("avc1.42c01f");
  });

  it("refuses what is not an avcC record", () => {
    expect(codecFrom(new Uint8Array([0, 0x64, 0, 0x1e]))).toBeUndefined();
    expect(codecFrom(new Uint8Array([1, 0x64]))).toBeUndefined();
  });
});

describe("isPreviewMessage", () => {
  const chunk = { width: 640, height: 360, data: new Uint8Array(4), key: true, timestamp: 1, sent: 2, n: 1 };
  it("takes a chunk with or without its description, and nothing else", () => {
    expect(isPreviewMessage(chunk)).toBe(true);
    expect(isPreviewMessage({ ...chunk, description: new Uint8Array([1]) })).toBe(true);
    expect(isPreviewMessage({ ...chunk, data: [1, 2] })).toBe(false);
    expect(isPreviewMessage({ ...chunk, key: "yes" })).toBe(false);
    expect(isPreviewMessage(null)).toBe(false);
  });

  it("refuses a malformed or oversized chunk (plan 084)", () => {
    for (const bad of [{ data: new Uint8Array(0) }, { data: new Uint8Array(4 * 1024 * 1024 + 1) }, { description: new Uint8Array(4097) },
      { width: 0 }, { height: 16_385 }, { width: 1.5 }, { n: 0 }, { n: 1.5 }, { n: undefined }, { timestamp: Number.NaN }, { sent: "2" }]) {
      expect(isPreviewMessage({ ...chunk, ...bad }), JSON.stringify(Object.keys(bad))).toBe(false);
    }
    expect(isPreviewMessage({ ...chunk, data: new Uint8Array(4 * 1024 * 1024), description: new Uint8Array(4096) })).toBe(true);
  });
});

describe("previewStats", () => {
  it("counts the frames drawn, the ones never shown and the delay", () => {
    const stats = previewStats();
    const frame = (n: number, sent: number) => ({ width: 640, height: 360, data: new Uint8Array(0), key: false, timestamp: 0, sent, n });
    stats.add(frame(5, 1000), 1004);
    expect(stats.add(frame(8, 1100), 1106)).toBe("640×360 · 2 fps · 2 drawn, 2 not shown · 5.0 ms from the capture process");
    stats.reset();
    expect(stats.add(frame(9, 2000), 2002)).toContain("1 drawn, 0 not shown");
    expect(stats.add(frame(10, 2100), 2110, 2104)).toContain("(6.0 ms of it decoding)");
  });
});
