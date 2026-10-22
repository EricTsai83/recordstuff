import { describe, expect, it } from "vitest";
import { UsageError, chooseElement, insideAny, lockRefusal, overlayRefusal, parseInputCommand, pointRefusal, startMismatch, systemEventsDenied } from "./native-input.mts";
import { scrollDeltas, type WindowElement } from "../runner/native-ax.mts";

describe("parseInputCommand", () => {
  it("reads each command, with the Settings window by default", () => {
    expect(parseInputCommand(["elements"])).toEqual({ kind: "elements", window: "RecordStuff" });
    expect(parseInputCommand(["press", " 錄影設定 ", "--window", "Other"])).toEqual({ kind: "press", title: "錄影設定", window: "Other" });
    expect(parseInputCommand(["--window", "Other", "elements"])).toEqual({ kind: "elements", window: "Other" });
    expect(parseInputCommand(["click", "-961", "643.5"])).toEqual({ kind: "click", x: -961, y: 643.5 });
    expect(parseInputCommand(["scroll", "900", "600", "-3"])).toEqual({ kind: "scroll", x: 900, y: 600, lines: -3 });
    expect(parseInputCommand(["shortcut"])).toEqual({ kind: "shortcut", which: "record" });
    expect(parseInputCommand(["shortcut", "settings"])).toEqual({ kind: "shortcut", which: "settings" });
  });

  it("refuses what it cannot act on exactly", () => {
    for (const args of [[], ["tap"], ["press"], ["press", "  "], ["click", "1"], ["click", "1", "y"], ["click", "1", ""], ["scroll", "1", "2", "0"],
      ["scroll", "1", "2", "1.5"], ["scroll", "1", "2", "101"], ["shortcut", "quit"], ["shortcut", "record", "--window", "x"], ["elements", "--window"],
      ["elements", "extra"]]) {
      expect(() => parseInputCommand(args), args.join(" ")).toThrow(UsageError);
    }
  });
});

const frame = { x: 10, y: 20, width: 100, height: 30 };
const element = (title: string, enabled = true, role = "AXButton"): WindowElement => ({ role, title, enabled, frame });

describe("chooseElement", () => {
  it("takes the one enabled element with that exact title", () => {
    const elements = [element("錄影設定", false, "AXRow"), element("錄影設定"), element("錄影設定檔")];
    expect(chooseElement(elements, "錄影設定")).toEqual({ ok: true, element: elements[1] });
  });

  it("refuses a disabled, missing or repeated title and says what is there", () => {
    expect(chooseElement([element("相機裝置", false)], "相機裝置")).toEqual({ ok: false, reason: '"相機裝置" is disabled' });
    const missing = chooseElement([element("BenQ Monitor"), element(""), element("MacBook Pro的麥克風")], "FreeClip");
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toContain('enabled titles: "BenQ Monitor", "MacBook Pro的麥克風"');
    const twice = chooseElement([element("搜尋裝置"), element("搜尋裝置")], "搜尋裝置");
    expect(!twice.ok && twice.reason).toContain("2 enabled elements");
  });

  it("skips a card scrolled out of view, which Chromium reads as a 1 pt sliver at the window's edge (2026-10-23)", () => {
    const sliver: WindowElement = { role: "AXButton", title: "播放 01-13-01", enabled: true, frame: { x: 707, y: 933, width: 358, height: 1 } };
    expect(chooseElement([sliver], "播放 01-13-01")).toEqual({ ok: false, reason: '"播放 01-13-01" is scrolled out of view; scroll it into the window first' });
    const partly: WindowElement = { ...sliver, frame: { ...sliver.frame, y: 924, height: 10 } };
    expect(chooseElement([sliver, partly], "播放 01-13-01")).toEqual({ ok: true, element: partly });
    const missing = chooseElement([sliver], "x");
    expect(!missing.ok && missing.reason).toContain("visible enabled titles: (none)");
  });
});

describe("insideAny", () => {
  it("accepts a point inside or on the edge of a window and refuses one outside them all", () => {
    const windows = [undefined, { x: -1080, y: -147, width: 1080, height: 1920 }, { x: 439, y: 176, width: 1043, height: 758 }];
    expect(insideAny(windows, 1273, 459)).toBe(true);
    expect(insideAny(windows, -1080, -147)).toBe(true);
    expect(insideAny(windows, 300, 100)).toBe(false);
    expect(insideAny([], 0, 0)).toBe(false);
  });
});

describe("startMismatch", () => {
  const exe = "/repo/dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff";
  const start = (run: string, executable: string) =>
    `[2026-10-22T15:43:24.991Z] start: RecordStuff 2.2.0; run ${run}; electron 44.3.0; darwin 25.6.0; packaged true; executable ${executable}`;

  it("accepts the bundle's own latest start", () => {
    expect(startMismatch([start("20261022T151704716Z-73659", "/Applications/RecordStuff.app/Contents/MacOS/RecordStuff"), start("20261022T154324939Z-90278", exe), "[x] hotkey: registered CommandOrControl+Shift+1"], 90278, exe)).toBeUndefined();
  });

  it("refuses a log whose latest start is another copy or another process", () => {
    // 077's round: macOS relaunched the older copy in /Applications, which writes the same log.
    expect(startMismatch([start("20261022T152655445Z-79538", "/Applications/RecordStuff.app/Contents/MacOS/RecordStuff")], 79538, exe)).toContain("/Applications");
    expect(startMismatch([start("20261022T152655445Z-79538", exe)], 80832, exe)).toContain("not pid 80832");
    expect(startMismatch(["[x] ready"], 1, exe)).toBe("the app log has no process start");
  });
});

describe("pointRefusal", () => {
  const windows = [{ x: 439, y: 176, width: 1043, height: 758 }];
  const own = { pid: 29342, window: "RecordStuff", titles: ["60 fps", "RecordStuff"] };
  it("allows a point in the bundle's window that the bundle owns on screen", () => {
    expect(pointRefusal(windows, own, 29342, 1383, 806)).toBeUndefined();
    // 2026-10-23: Chromium answered the same option's point once with the option and once with a container; both pass.
    expect(pointRefusal(windows, { ...own, titles: ["錄影設定", "RecordStuff"] }, 29342, 1383, 886, "RecordStuff")).toBeUndefined();
  });
  it("refuses a point outside its windows, or under another app's window there", () => {
    expect(pointRefusal(windows, own, 29342, 10, 10)).toBe("10,10 is outside every window of pid 29342");
    // System Settings over the Settings window: the click would reach it, not RecordStuff.
    expect(pointRefusal(windows, { pid: 61102, window: "系統設定", titles: [] }, 29342, 700, 500)).toContain("covered by pid 61102, not pid 29342");
    expect(pointRefusal(windows, undefined, 29342, 700, 500)).toContain("covered by something that cannot be identified");
  });
  it("refuses a press under another of the bundle's windows", () => {
    expect(pointRefusal(windows, { pid: 29342, window: "錄影工作室", titles: [] }, 29342, 900, 500, "RecordStuff")).toBe('900,500 is covered by the window "錄影工作室", not "RecordStuff"; bring "RecordStuff" to the front first');
    expect(pointRefusal(windows, { pid: 29342, window: null, titles: [] }, 29342, 900, 500, "RecordStuff")).toContain("something outside any window");
  });
});

describe("overlayRefusal", () => {
  // 2026-10-23: the frame-rate list opened over the resolution cap; the hit test at the cap's centre fell through to it.
  const list = { x: 1339, y: 834, width: 87, height: 72 };
  const cap: WindowElement = { role: "AXComboBox", title: "解析度上限", enabled: true, frame: { x: 1349, y: 857, width: 77, height: 29 } };
  const option: WindowElement = { role: "AXOption", title: "60 fps", enabled: true, frame: { x: 1343, y: 870, width: 79, height: 32 }, layer: 0 };
  it("refuses an element under an open list it is not part of, and allows the list's own options", () => {
    expect(overlayRefusal(cap, [list])).toBe('"解析度上限" lies under an open list or menu at 1339,834; close it first');
    expect(overlayRefusal(option, [list])).toBeUndefined();
    // An option of another open list drawn over this one is still refused.
    expect(overlayRefusal(option, [list, { x: 1300, y: 860, width: 200, height: 60 }])).toContain("at 1300,860");
    expect(overlayRefusal(cap, [])).toBeUndefined();
    expect(overlayRefusal({ ...cap, frame: { ...cap.frame, y: 600 } }, [list])).toBeUndefined();
  });
});

describe("lockRefusal", () => {
  it("blocks input to a locked session only", () => {
    expect(lockRefusal(true)).toContain("the screen is locked");
    expect(lockRefusal(false)).toBeUndefined();
    expect(lockRefusal(undefined)).toBeUndefined();
  });
});

describe("systemEventsDenied", () => {
  it("treats a refused Automation or Accessibility grant as blocked and anything else as a failure", () => {
    expect(systemEventsDenied("execution error: Not authorized to send Apple events to System Events. (-1743)")).toBe(true);
    expect(systemEventsDenied("System Events got an error: osascript is not allowed to send keystrokes. (1002)")).toBe(true);
    expect(systemEventsDenied("osascript is not allowed assistive access. (-25211)")).toBe(true);
    expect(systemEventsDenied("execution error: Can’t get key code 18. (-1728)")).toBe(false);
  });
});

describe("scrollDeltas", () => {
  it("sends one line per notch, summing to exactly the lines asked for", () => {
    expect(scrollDeltas(6)).toEqual([-1, -1, -1, -1, -1, -1]);
    expect(scrollDeltas(-3)).toEqual([1, 1, 1]);
    for (const lines of [1, 6, -3, 100]) expect(scrollDeltas(lines).reduce((a, b) => a + b, 0)).toBe(-lines);
  });
});
