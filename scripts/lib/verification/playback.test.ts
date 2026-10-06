import { describe, expect, it } from "vitest";
import { judgePlayback, meanAbsDiff, parseBounds, parseDocumentState, parseVolumeSettings, playbackScript, type PlaybackObservations } from "./playback.mts";

describe("QuickTime replies", () => {
  it("reads the flat list osascript prints for a document", () => {
    expect(parseDocumentState("10.3, 0.0, false, false, 1920, 1080\n")).toEqual({ duration: 10.3, currentTime: 0, playing: false, muted: false, width: 1920, height: 1080 });
    expect(parseDocumentState("1.0E+1, 2.5, true, true, 3840, 2160").duration).toBe(10);
  });

  it("refuses a reply it cannot read rather than guessing", () => {
    expect(() => parseDocumentState("10.3, 0.0, false, 1920, 1080")).toThrow(/Unexpected QuickTime document state/);
    expect(() => parseDocumentState("10.3, 0.0, missing value, false, 1920, 1080")).toThrow(/Unexpected/);
  });

  it("turns window bounds into a screencapture rectangle", () => {
    expect(parseBounds("100, 50, 1060, 620")).toEqual({ x: 100, y: 50, width: 960, height: 570 });
    expect(() => parseBounds("100, 50, 100, 620")).toThrow(/Unexpected QuickTime window bounds/);
  });

  it("reads the system output volume and mute", () => {
    expect(parseVolumeSettings("output volume:50, input volume:75, alert volume:100, output muted:false")).toEqual({ volume: 50, muted: false });
    expect(parseVolumeSettings("output volume:missing value, output muted:missing value")).toEqual({});
  });

  it("quotes the seek position without an exponent", () => {
    expect(playbackScript.seek(0.0000001)).toBe('tell application "QuickTime Player" to set current time of document 1 to 0.000');
  });
});

describe("meanAbsDiff", () => {
  it("averages the gray-level change", () => {
    expect(meanAbsDiff(Uint8Array.of(0, 10, 255), Uint8Array.of(0, 20, 0))).toBeCloseTo((10 + 255) / 3);
  });

  it("refuses screenshots of different sizes", () => {
    expect(() => meanAbsDiff(Uint8Array.of(1), Uint8Array.of(1, 2))).toThrow(/differ in size/);
  });
});

describe("judgePlayback", () => {
  const good: PlaybackObservations = {
    expected: { duration: 10.3, width: 1920, height: 1080, audio: true },
    opened: { duration: 10.3, currentTime: 0, playing: false, muted: false, width: 1920, height: 1080 },
    played: { from: 0, to: 1.98, playing: true, waitedSeconds: 2.02 },
    seeks: [{ requested: 2.575, reached: 2.567 }, { requested: 2.575, reached: 2.567 }, { requested: 7.725, reached: 7.717 }],
    picture: { change: 12.4, noise: 0.08 },
    ended: { stopped: true, currentTime: 10.3 },
    output: { volume: 50, muted: false },
  };
  const failed = (o: PlaybackObservations): string[] => judgePlayback(o).checks.filter(c => c.status === "fail").map(c => c.name);

  it("passes a file that opens, plays, seeks and ends as recorded; audio is only reported", () => {
    const { checks, verdict } = judgePlayback(good);
    expect(verdict).toBe("pass");
    expect(checks.find(c => c.name.startsWith("Audio"))).toMatchObject({ status: "info" });
  });

  it("fails a player that does not advance in real time", () => {
    expect(failed({ ...good, played: { ...good.played, to: 0.4 } })).toEqual(["Plays in real time"]);
    expect(failed({ ...good, played: { ...good.played, playing: false } })).toEqual(["Plays in real time"]);
  });

  it("fails a frozen picture, and a change no larger than the repeat's noise", () => {
    expect(failed({ ...good, picture: { change: 0.2, noise: 0 } })).toEqual(["The picture follows the seek"]);
    expect(failed({ ...good, picture: { change: 2, noise: 0.6 } })).toEqual(["The picture follows the seek"]);
  });

  it("fails a duration, size or end that does not match the file", () => {
    expect(failed({ ...good, opened: { ...good.opened, duration: 9.1 }, ended: { stopped: true, currentTime: 9.1 } })).toEqual(["Opens with the file's duration"]);
    expect(failed({ ...good, opened: { ...good.opened, width: 1280, height: 720 } })).toEqual(["Opens at the file's dimensions"]);
    expect(failed({ ...good, ended: { stopped: false, currentTime: 9.6 } })).toEqual(["Plays to the end and stops"]);
    expect(failed({ ...good, seeks: [{ requested: 2.575, reached: 3.2 }] })).toEqual(["Seeks land where asked"]);
  });
});
