import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY,
  VIDEO_BITRATE_MAX,
  VIDEO_BITRATE_MIN,
  AUDIO_BITS_PER_SECOND,
  describeCapture,
  effectiveQuality,
  fitWithinCap,
  frameRateDowngrade,
  isCaptureReport,
  isFrameRateAvailable,
  isQualitySettings,
  videoBitsPerSecond,
  type CaptureReport,
} from "./quality";

describe("isQualitySettings", () => {
  it("accepts every supported combination and rejects anything else", () => {
    expect(isQualitySettings(DEFAULT_QUALITY)).toBe(true);
    expect(isQualitySettings({ videoQuality: "economy", resolutionCap: "4k", frameRate: 60 })).toBe(true);
    // A settings.json written before the audio quality setting was removed still validates.
    expect(isQualitySettings({ ...DEFAULT_QUALITY, audioQuality: "standard" })).toBe(true);
    expect(isQualitySettings({ ...DEFAULT_QUALITY, frameRate: 24 })).toBe(false);
    expect(isQualitySettings({ ...DEFAULT_QUALITY, frameRate: "30" })).toBe(false);
    expect(isQualitySettings({ ...DEFAULT_QUALITY, resolutionCap: "720p" })).toBe(false);
    expect(isQualitySettings({ ...DEFAULT_QUALITY, videoQuality: undefined })).toBe(false);
    expect(isQualitySettings(null)).toBe(false);
    expect(isQualitySettings("standard")).toBe(false);
  });
});

describe("frame rate availability", () => {
  it("60 fps only on macOS until other platforms are verified; a stored 60 is clamped at use", () => {
    expect(isFrameRateAvailable(60, "darwin")).toBe(true);
    expect(isFrameRateAvailable(60, "win32")).toBe(false);
    expect(isFrameRateAvailable(30, "win32")).toBe(true);
    const sixty = { ...DEFAULT_QUALITY, frameRate: 60 as const };
    expect(effectiveQuality(sixty, "darwin")).toBe(sixty);
    expect(effectiveQuality(sixty, "win32")).toEqual({ ...sixty, frameRate: 30 });
  });
});

describe("fitWithinCap", () => {
  it("returns the source unchanged for 'source' and for sources within the cap", () => {
    expect(fitWithinCap({ width: 5120, height: 2880 }, "source")).toEqual({ width: 5120, height: 2880 });
    expect(fitWithinCap({ width: 1920, height: 1080 }, "1080p")).toEqual({ width: 1920, height: 1080 });
    expect(fitWithinCap({ width: 1280, height: 720 }, "1080p")).toEqual({ width: 1280, height: 720 });
    expect(fitWithinCap({ width: 2560, height: 1440 }, "1440p")).toEqual({ width: 2560, height: 1440 });
    expect(fitWithinCap({ width: 3840, height: 2160 }, "4k")).toEqual({ width: 3840, height: 2160 });
  });

  it("scales down keeping the aspect ratio", () => {
    expect(fitWithinCap({ width: 3840, height: 2160 }, "1080p")).toEqual({ width: 1920, height: 1080 });
    expect(fitWithinCap({ width: 5120, height: 2880 }, "1440p")).toEqual({ width: 2560, height: 1440 });
    // 16:10 MacBook: the height bound is what limits it.
    expect(fitWithinCap({ width: 2880, height: 1800 }, "1080p")).toEqual({ width: 1728, height: 1080 });
  });

  it("swaps the bounds for a portrait source", () => {
    expect(fitWithinCap({ width: 2160, height: 3840 }, "1080p")).toEqual({ width: 1080, height: 1920 });
    expect(fitWithinCap({ width: 1080, height: 1920 }, "1080p")).toEqual({ width: 1080, height: 1920 });
  });

  it("limits an ultra-wide source by width and keeps its ratio", () => {
    expect(fitWithinCap({ width: 3440, height: 1440 }, "1080p")).toEqual({ width: 1920, height: 804 });
    expect(fitWithinCap({ width: 5120, height: 1440 }, "1440p")).toEqual({ width: 2560, height: 720 });
  });

  it("produces even dimensions", () => {
    const fitted = fitWithinCap({ width: 3000, height: 2001 }, "1080p");
    expect(fitted.width % 2).toBe(0);
    expect(fitted.height % 2).toBe(0);
    expect(fitted.height).toBe(1080);
  });
});

describe("videoBitsPerSecond", () => {
  it("keeps the shipped 8 Mbps baseline for standard 1080p30", () => {
    expect(videoBitsPerSecond({ width: 1920, height: 1080 }, 30, "standard")).toBe(8_100_000);
  });

  it("orders the levels and scales with pixels and frame rate", () => {
    const size = { width: 1920, height: 1080 };
    const economy = videoBitsPerSecond(size, 30, "economy");
    const standard = videoBitsPerSecond(size, 30, "standard");
    const high = videoBitsPerSecond(size, 30, "high");
    expect(economy).toBeLessThan(standard);
    expect(standard).toBeLessThan(high);
    expect(videoBitsPerSecond(size, 60, "standard")).toBe(16_200_000);
    expect(videoBitsPerSecond({ width: 3840, height: 2160 }, 30, "standard")).toBe(32_300_000);
  });

  it("clamps to the bounds", () => {
    expect(videoBitsPerSecond({ width: 640, height: 360 }, 30, "economy")).toBe(VIDEO_BITRATE_MIN);
    expect(videoBitsPerSecond({ width: 5120, height: 2880 }, 60, "high")).toBe(VIDEO_BITRATE_MAX);
  });
});

describe("AUDIO_BITS_PER_SECOND", () => {
  it("is one fixed AAC target (Chromium clamps to ~160 kbps whatever is asked)", () => {
    expect(AUDIO_BITS_PER_SECOND).toBe(256_000);
  });
});

const report: CaptureReport = { videoBitsPerSecond: 8_100_000, audioBitsPerSecond: 256_000, warnings: [] };

describe("isCaptureReport", () => {
  it("requires finite bitrates and a string array of warnings; other fields are optional numbers", () => {
    expect(isCaptureReport(report)).toBe(true);
    expect(isCaptureReport({ ...report, width: 1920, height: 1080, frameRate: 59.94, sampleRate: 48_000, channelCount: 2 })).toBe(true);
    expect(isCaptureReport({ ...report, frameRate: null })).toBe(false);
    expect(isCaptureReport({ ...report, audioBitsPerSecond: Infinity })).toBe(false);
    expect(isCaptureReport({ videoBitsPerSecond: 1, audioBitsPerSecond: 1 })).toBe(false);
    expect(isCaptureReport(undefined)).toBe(false);
  });
});

describe("frameRateDowngrade", () => {
  const sixty = { ...DEFAULT_QUALITY, frameRate: 60 as const };
  it("flags 60 requested with a track at or below 30", () => {
    expect(frameRateDowngrade(sixty, { ...report, frameRate: 30 })).toBe(30);
    expect(frameRateDowngrade(sixty, { ...report, frameRate: 29.97 })).toBe(30);
    expect(frameRateDowngrade(sixty, { ...report, frameRate: 24 })).toBe(24);
  });
  it("does not flag 30 requested, an unknown rate, or a rate above 30", () => {
    expect(frameRateDowngrade(DEFAULT_QUALITY, { ...report, frameRate: 15 })).toBeUndefined();
    expect(frameRateDowngrade(sixty, report)).toBeUndefined();
    expect(frameRateDowngrade(sixty, { ...report, frameRate: 60 })).toBeUndefined();
    expect(frameRateDowngrade(sixty, { ...report, frameRate: 45 })).toBeUndefined();
  });
});

describe("describeCapture", () => {
  it("marks unreported fields as unknown and labels bitrates as targets", () => {
    expect(describeCapture(DEFAULT_QUALITY, report)).toBe(
      "requested video=standard cap=source fps=30; " +
        "track size=unknown fps=unknown sampleRate=unknown channels=unknown; " +
        "target videoBps=8100000 audioBps=256000",
    );
  });
  it("includes every reported field and warnings", () => {
    const line = describeCapture(
      { ...DEFAULT_QUALITY, resolutionCap: "1080p" },
      { ...report, width: 1920, height: 1080, frameRate: 30, sampleRate: 48_000, channelCount: 2, warnings: ["a", "b"] },
    );
    expect(line).toContain("cap=1080p");
    expect(line).toContain("track size=1920x1080 fps=30 sampleRate=48000 Hz channels=2");
    expect(line).toContain("warnings: a; b");
  });
});
