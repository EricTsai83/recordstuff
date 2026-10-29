import { describe, expect, it } from "vitest";
import { hasEditableMarker, offeredVersions, recordingTitle, sourceFiles, versionName, videoIsOriginal, type VersionSubject } from "./versions";

const plain: VersionSubject = { fileName: "Meeting.mp4", edited: false };
const cut: VersionSubject = { fileName: "Meeting.mp4", edited: true };
const editable: VersionSubject = { fileName: "Meeting.recordstuff.mp4", edited: false, editable: { camera: true, sounds: ["system", "microphone"], mix: true } };

describe("the versions a recording offers (plan 100)", () => {
  it("offers an unedited plain recording its Video, the file itself, and Sound only", () => {
    expect(offeredVersions(plain)).toEqual(["video", "sound"]);
    expect(videoIsOriginal(plain)).toBe(true);
  });

  it("offers an edited plain recording its Original too, and its Video is made", () => {
    expect(offeredVersions(cut)).toEqual(["video", "sound", "original"]);
    expect(videoIsOriginal(cut)).toBe(false);
  });

  it("offers an editable recording every version, Video without the camera only with a camera", () => {
    expect(offeredVersions(editable)).toEqual(["video", "sound", "original", "screenOnly", "sources"]);
    expect(offeredVersions({ ...editable, editable: { camera: false, sounds: ["system"] } })).toEqual(["video", "sound", "original", "sources"]);
    expect(videoIsOriginal({ ...editable, edited: true })).toBe(false);
  });
});

describe("the names versions leave with (D3, D8, D9)", () => {
  it("names the editable original's title without its marker, and only that marker", () => {
    expect(recordingTitle("Meeting.recordstuff.mp4")).toBe("Meeting");
    expect(recordingTitle("Meeting.RecordStuff.mp4")).toBe("Meeting");
    expect(recordingTitle("Meeting.mp4")).toBe("Meeting");
    expect(recordingTitle("v1.2.mp4")).toBe("v1.2");
    // A name that is nothing but the marker keeps it, so a title is never empty.
    expect(recordingTitle(".recordstuff.mp4")).toBe(".recordstuff");
    expect(hasEditableMarker("Meeting.recordstuff.mp4")).toBe(true);
    expect(hasEditableMarker("Meeting.mp4")).toBe(false);
  });

  it("gives an unedited plain recording's Video its own name: it is the file", () => {
    expect(versionName("video", plain)).toBe("Meeting.mp4");
    expect(versionName("sound", plain)).toBe("Meeting (sound).m4a");
  });

  it("never names a version its source's own name: an edited plain recording's Video is (edited)", () => {
    expect(versionName("video", cut)).toBe("Meeting (edited).mp4");
    expect(versionName("video", cut, "zh-TW")).toBe("Meeting（剪輯版）.mp4");
    // Case and accents as the file system compares them.
    expect(versionName("video", { fileName: "café.MP4", edited: true })).toBe("café (edited).mp4");
    expect(versionName("original", cut)).toBe("Meeting (original).mp4");
    expect(versionName("original", { fileName: "Clip.mov", edited: true })).toBe("Clip (original).mov");
  });

  it("names an editable recording's versions as finished files, and only its original is marked", () => {
    expect(versionName("video", editable)).toBe("Meeting.mp4");
    expect(versionName("video", editable, "zh-TW")).toBe("Meeting.mp4");
    expect(versionName("original", editable)).toBe("Meeting.recordstuff.mp4");
    expect(versionName("screenOnly", editable)).toBe("Meeting (screen only).mp4");
    expect(versionName("screenOnly", editable, "zh-TW")).toBe("Meeting（僅畫面）.mp4");
    expect(versionName("sound", editable, "zh-TW")).toBe("Meeting（聲音）.m4a");
    expect(versionName("sources", editable)).toBe("Meeting sources");
    // One made before the marker existed would leave its Video under its own name: (edited) instead.
    expect(versionName("video", { ...editable, fileName: "Meeting.mp4" })).toBe("Meeting (edited).mp4");
  });

  it("takes a title as it is, never as a placeholder", () => {
    expect(versionName("sound", { fileName: "{title}.mp4", edited: false })).toBe("{title} (sound).m4a");
  });
});

describe("a recording's sources (D7)", () => {
  it("copies the screen, the camera and each input's own track, after the mix", () => {
    expect(sourceFiles(editable)).toEqual([
      { track: "screen", role: "screen", name: "Meeting - Screen.mp4" },
      { track: "camera", role: "camera", name: "Meeting - Camera.mp4" },
      { track: "sound1", role: "system", name: "Meeting - System sound.m4a" },
      { track: "sound2", role: "microphone", name: "Meeting - Microphone.m4a" },
    ]);
  });

  it("takes the first input from the played track without a mix, and leaves a silent one out", () => {
    const old: VersionSubject = { fileName: "Old.mp4", edited: false, editable: { camera: false, sounds: ["microphone", "silent"] } };
    expect(sourceFiles(old, "zh-TW")).toEqual([
      { track: "screen", role: "screen", name: "Old - 畫面.mp4" },
      { track: "sound0", role: "microphone", name: "Old - 麥克風.m4a" },
    ]);
  });

  it("has none for a plain recording", () => {
    expect(sourceFiles(cut)).toEqual([]);
  });
});
