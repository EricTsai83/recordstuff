import { describe, expect, it } from "vitest";
import { DEFAULT_FILE_NAME_TEMPLATE, canonicalFileNameTemplate, fileNameProblem, fileNameProblemText, fileNameTemplateProblem, formatFileName } from "./file-name";

describe("recording file names (2026-10-05)", () => {
  const at = new Date(2026, 0, 2, 3, 4, 5);
  it("names a recording as before by default, and fills each placeholder with local time", () => {
    // recorder.ts formatTimestamp's shape, which recordings-library.ts reads back as the recorded time.
    expect(formatFileName(DEFAULT_FILE_NAME_TEMPLATE, at)).toBe("2026-01-02 03-04-05");
    expect(formatFileName("{year}{month}{day} {hour}.{minute}.{second} demo", at)).toBe("20260102 03.04.05 demo");
    expect(formatFileName("Call {date} {time}", at)).toBe("Call 2026-01-02 03-04-05");
  });
  it("needs a placeholder that changes every second, and refuses unknown or broken ones", () => {
    expect(fileNameTemplateProblem("{date} {time}")).toBeUndefined();
    expect(fileNameTemplateProblem("{hour}h{minute}m{second}s")).toBeUndefined();
    expect(fileNameTemplateProblem("Meeting {date}")).toBe("noTime");
    expect(fileNameTemplateProblem("  ")).toBe("empty");
    expect(fileNameTemplateProblem("{time} {weekday}")).toBe("unknownToken");
    expect(fileNameTemplateProblem("{time} {date")).toBe("unknownToken");
    expect(fileNameTemplateProblem("a:b {time}")).toBe("characters");
    expect(fileNameTemplateProblem(".{time}")).toBe("dot");
    expect(fileNameTemplateProblem("NUL.{second}")).toBe("reserved");
    expect(fileNameProblem("Console.demo")).toBeUndefined();
    expect(fileNameTemplateProblem(`${"x".repeat(120)}{time}`)).toBe("tooLong");
    // Bytes, not only characters: 90 Chinese characters are 270 bytes, past any 255-byte file name (review pass 1, F4).
    expect(fileNameTemplateProblem(`${"錄".repeat(90)}{time}`)).toBe("tooLong");
    expect(fileNameTemplateProblem(`${"錄".repeat(60)}{time}`)).toBeUndefined();
    expect(fileNameProblem("錄".repeat(67))).toBe("tooLong");
    expect(canonicalFileNameTemplate("  {date} {time}  ")).toBe("{date} {time}");
    expect(canonicalFileNameTemplate("{date}")).toBeUndefined();
    expect(canonicalFileNameTemplate(undefined)).toBeUndefined();
  });
  it("refuses a name a file system cannot keep or the library would hide", () => {
    expect(fileNameProblem("Product demo")).toBeUndefined();
    expect(fileNameProblem("Q3 review — 第一場")).toBeUndefined();
    for (const [name, problem] of [["", "empty"], ["a/b", "characters"], ["a\\b", "characters"], ["what?", "characters"], ["tab\there", "characters"],
      [".secret", "dot"], [" lead", "edge"], ["trail.", "edge"], ["trail ", "edge"], ["CON", "reserved"], ["take.recording", "reserved"],
      // Windows reserves a device name before any extension (review pass 2, F2).
      ["CON.demo", "reserved"], ["lpt1.take", "reserved"], ["nul .x", "reserved"]] as const) {
      expect(fileNameProblem(name), name).toBe(problem);
    }
  });
  it("says what is wrong in each language, naming the placeholders as typed", () => {
    expect(fileNameProblemText("noTime", "en")).toBe("Include {time} or {second} so each recording gets its own name.");
    expect(fileNameProblemText("unknownToken", "zh-TW")).toBe("無法辨識的變數。可用 {date} {time} {year} {month} {day} {hour} {minute} {second}。");
    expect(fileNameProblemText("exists", "zh-TW")).toBe("資料夾裡已有同名的檔案。");
  });
});
