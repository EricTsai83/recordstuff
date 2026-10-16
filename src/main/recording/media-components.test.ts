import { expect, it } from "vitest";
import { missingMediaComponents } from "./media-components";

it("names the Media Foundation libraries missing from System32, and checks nothing outside Windows", () => {
  const present = new Set(["D:\\Win\\System32\\mfplat.dll"]);
  expect(missingMediaComponents("win32", "D:\\Win", (file) => present.has(file))).toEqual(["mfh264enc.dll", "mfaacenc.dll"]);
  expect(missingMediaComponents("win32", undefined, () => true)).toEqual([]);
  expect(missingMediaComponents("darwin", undefined, () => false)).toEqual([]);
});
