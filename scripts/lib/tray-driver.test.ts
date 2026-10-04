import { describe, expect, it } from "vitest";
import { AccessibilityBlockedError, captureRect, parseAxResult, type NativeAx, type NativeMenuItem, type StatusSnapshot } from "./native-ax.mts";
import { TrayDriver, axAccelerator, clickTarget, compareMenu, isSeparator, normalizeAccelerator, parseMenuLogLine, structureProblems } from "./tray-driver.mts";

/** The idle menu read from the maintainer's app on 2026-10-02 (zh-TW, four unread failures), trimmed to what the parser keeps. */
const RECORDED_IDLE: Array<[string, boolean, string, number]> = [
  ["待命中", false, "", 0], ["開始錄影", true, "1", 1], ["", false, "", 0],
  ["尚未確認的錄影失敗：4 筆", false, "", 0], ["查看失敗紀錄…", true, "", 0], ["", false, "", 0],
  ["儲存位置：~/Movies/RecordStuff", true, "", 0], ["更改儲存位置…", true, "", 0], ["", false, "", 0],
  ["設定…", true, ",", 2], ["", false, "", 0], ["顯示 log", true, "", 0], ["結束 RecordStuff", true, "", 0],
];
const native = (rows: Array<[string, boolean, string, number]>): NativeMenuItem[] =>
  rows.map(([title, enabled, cmdChar, cmdModifiers]) => ({ title, enabled, cmdChar, cmdModifiers, selected: false, frame: undefined }));
/** The line the same popup logged. */
const LOGGED_IDLE = `[2026-10-02T14:42:50.949Z] tray: menu opened in idle: [{"label":"待命中","enabled":false},{"label":"開始錄影","enabled":true,"accelerator":"CommandOrControl+Shift+1"},{"separator":true},{"label":"尚未確認的錄影失敗：4 筆","enabled":false},{"label":"查看失敗紀錄…","enabled":true},{"separator":true},{"label":"儲存位置：~/Movies/RecordStuff","enabled":true},{"label":"更改儲存位置…","enabled":true},{"separator":true},{"label":"設定…","enabled":true,"accelerator":"CommandOrControl+Alt+,"},{"separator":true},{"label":"顯示 log","enabled":true},{"label":"結束 RecordStuff","enabled":true}]`;

describe("tray menu comparison (plan 063)", () => {
  it("finds no difference between the recorded native menu and the model it was built from", () => {
    const logged = parseMenuLogLine(LOGGED_IDLE)!;
    expect(logged.state).toBe("idle");
    expect(compareMenu(native(RECORDED_IDLE), logged.menu)).toEqual({ problems: [], notes: [] });
    // That menu predates 2026-10-04: its folder items, Settings… and Show log are now RecordStuff's.
    expect(structureProblems(native(RECORDED_IDLE), "idle", "zh-TW")).toEqual([
      "idle has no enabled Open RecordStuff",
      "idle still lists an item RecordStuff now holds (output folder, Show last recording or Show log)",
    ]);
  });

  it("reports a missing separator, a changed label, a wrong enabled state and a shortcut the model lacks", () => {
    const rows = RECORDED_IDLE.filter((_, i) => i !== 2).map((row): [string, boolean, string, number] => [...row]);
    rows[0] = ["待命", false, "", 0];
    rows[2]![1] = true;
    rows[10] = ["顯示 log", true, "L", 0];
    const { problems } = compareMenu(native(rows), parseMenuLogLine(LOGGED_IDLE)!.menu);
    expect(problems).toContain("the native menu has 12 entries, the model 13");
    expect(problems).toContain('entry 1: label "待命", model "待命中"');
    expect(problems).toContain('entry 3: expected a separator, found "尚未確認的錄影失敗：4 筆"');
  });

  it("compares shortcuts in one form: Command implied unless bit 8, Shift 1, Option 2, Control 4", () => {
    expect(axAccelerator({ cmdChar: "1", cmdModifiers: 1 })).toBe("Command+Shift+1");
    expect(axAccelerator({ cmdChar: ",", cmdModifiers: 2 })).toBe("Command+Option+,");
    expect(axAccelerator({ cmdChar: "k", cmdModifiers: 4 | 1 | 8 })).toBe("Control+Shift+K");
    expect(axAccelerator({ cmdChar: "", cmdModifiers: 0 })).toBeUndefined();
    expect(normalizeAccelerator("CommandOrControl+Shift+1")).toBe("Command+Shift+1");
    expect(normalizeAccelerator("CommandOrControl+Alt+,")).toBe("Command+Option+,");
    expect(normalizeAccelerator("Control+Shift+K")).toBe("Control+Shift+K");
    expect(normalizeAccelerator("CommandOrControl+Plus")).toBe("Command++");
  });

  it("notes a named key it cannot compare instead of failing it", () => {
    const { problems, notes } = compareMenu(native([["開始錄影", true, "", 0]]), [{ label: "開始錄影", enabled: true, accelerator: "CommandOrControl+F5" }]);
    expect(problems).toEqual([]);
    expect(notes[0]).toMatch(/named key/);
  });

  it("checks each state's structure: Start only in idle, Stop only while recording, Open RecordStuff and Quit last", () => {
    const recording = native([["錄影中", false, "", 0], ["停止", true, "1", 1], ["", false, "", 0],
      ["開啟 RecordStuff", true, ",", 2], ["", false, "", 0], ["結束 RecordStuff", true, "", 0]]);
    expect(structureProblems(recording, "recording", "zh-TW")).toEqual([]);
    expect(structureProblems([...recording.slice(0, 3), ...native([["儲存位置：~/Movies/RecordStuff", false, "", 0], ["", false, "", 0]]), ...recording.slice(3)], "recording", "zh-TW"))
      .toEqual(["recording still lists an item RecordStuff now holds (output folder, Show last recording or Show log)"]);
    expect(structureProblems(recording.filter((_, i) => i !== 3), "recording", "zh-TW")).toContain("recording has no enabled Open RecordStuff");
    expect(structureProblems(native(RECORDED_IDLE), "countdown", "zh-TW")).toEqual(expect.arrayContaining(["countdown offers Start recording", "countdown has no enabled Cancel recording"]));
    // A long start offers the same Cancel recording as the countdown (plan 065).
    const starting = native([["啟動中，請留意系統權限提示…", false, "", 0], ["取消錄影", true, "1", 1], ["", false, "", 0],
      ["開啟 RecordStuff", true, ",", 2], ["", false, "", 0], ["結束 RecordStuff", true, "", 0]]);
    expect(structureProblems(starting, "starting", "zh-TW")).toEqual([]);
    expect(structureProblems(starting, "idle", "zh-TW")).toContain("idle offers Cancel recording");
    expect(structureProblems(starting.filter((_, i) => i !== 1), "starting", "zh-TW")).toEqual(["starting has no enabled Cancel recording"]);
    const doubled = native([["", false, "", 0], ["Ready", false, "", 0], ["", false, "", 0], ["", false, "", 0], ["Open RecordStuff", true, "", 0], ["Quit RecordStuff", true, "", 0]]);
    expect(structureProblems(doubled, "idle", "en")).toEqual(expect.arrayContaining(["the menu starts with a separator", "two separators are adjacent", "idle has no enabled Start recording"]));
    expect(isSeparator({ title: "", enabled: false })).toBe(true);
  });
});

describe("native AX helper results", () => {
  it("turns a missing Accessibility permission into a blocked error and other AX errors into failures", () => {
    expect(() => parseAxResult('{"error":-25211}', "status item")).toThrow(AccessibilityBlockedError);
    expect(() => parseAxResult('{"error":-25204}', "status item")).toThrow("status item: AXError -25204");
    expect(parseAxResult<{ banners: unknown[] }>('{"banners":[]}', "banners")).toEqual({ banners: [] });
    expect(captureRect({ x: -573, y: -116, width: 287, height: 270 })).toBe("-581,-124,303,286");
  });
});

/** A status item whose menu opens on a right-click and closes on Escape or a press. */
function fakeAx(): NativeAx & { calls: string[]; open: boolean } {
  const items = native(RECORDED_IDLE);
  const ax = {
    calls: [] as string[],
    open: false,
    async status(): Promise<StatusSnapshot> {
      return { item: { frame: { x: -570, y: -144, width: 34, height: 24 }, title: "" }, menu: ax.open ? { frame: undefined, items } : null };
    },
    async press(_pid: number, index: number) { ax.calls.push(`press ${items[index]!.title}`); ax.open = false; },
    async mouse(button: "left" | "right", x: number, y: number) { ax.calls.push(`${button} ${x},${y}`); if (button === "right") ax.open = true; },
    async key(code: number) { ax.calls.push(`key ${code}`); if (code === 53) ax.open = false; },
    async windows() { throw new Error("unused"); },
    async layout() { throw new Error("unused"); },
    async menuBar() { throw new Error("unused"); },
    async savePasteboard() { throw new Error("unused"); },
    async restorePasteboard() { throw new Error("unused"); },
    async enableWebAccessibility() { throw new Error("unused"); },
    async banners() { return []; },
  };
  return ax;
}

describe("TrayDriver", () => {
  it("opens with a right-click at the item's centre, never a press, and closes with Escape", async () => {
    const ax = fakeAx();
    const driver = new TrayDriver(ax, process.pid, new AbortController().signal, 1000);
    const menu = await driver.open();
    expect(menu.items).toHaveLength(13);
    await expect(driver.open()).rejects.toThrow("already open");
    await driver.close();
    expect(ax.calls).toEqual(["right -553,-132", "key 53"]);
  });

  it("presses an item by exact label, refuses a disabled or missing one, and waits for the menu to close", async () => {
    const ax = fakeAx();
    const driver = new TrayDriver(ax, process.pid, new AbortController().signal, 1000);
    await driver.open();
    await expect(driver.select("待命中")).rejects.toThrow("disabled");
    await expect(driver.select("Start recording")).rejects.toThrow('has no "Start recording"');
    await driver.select("開始錄影");
    expect(ax.calls.at(-1)).toBe("press 開始錄影");
    expect(ax.open).toBe(false);
  });

  it("repeats a right-click that opened nothing, and gives up after the bounded attempts", async () => {
    const ax = fakeAx();
    let clicks = 0;
    ax.mouse = async (button) => { clicks += 1; if (button === "right" && clicks === 2) ax.open = true; };
    const driver = new TrayDriver(ax, process.pid, new AbortController().signal, 5000);
    await driver.open(3, 200);
    expect(clicks).toBe(2);
    expect(driver.clicks).toEqual(["-553,-132 via the Accessibility frame", "-553,-132 via the Accessibility frame"]);
    ax.open = false;
    ax.mouse = async () => undefined;
    const stuck = new TrayDriver(ax, process.pid, new AbortController().signal, 900);
    await expect(stuck.open(3, 200)).rejects.toThrow("the tray menu to open (click 3 of 3) did not happen");
    expect(stuck.clicks).toHaveLength(3);
  });

  it("stops waiting as soon as the round is cancelled", async () => {
    const ax = fakeAx();
    ax.mouse = async () => undefined;
    const controller = new AbortController();
    const driver = new TrayDriver(ax, process.pid, controller.signal, 10_000);
    const opening = driver.open();
    controller.abort(new Error("interrupted"));
    await expect(opening).rejects.toThrow("interrupted");
  });
});

describe("clickTarget: the status item copy a click reaches (macOS 26)", () => {
  const snapshot = (statusWindows: NonNullable<StatusSnapshot["statusWindows"]>): StatusSnapshot =>
    ({ statusWindows, item: { frame: { x: -650, y: -144, width: 66, height: 24 }, title: "REC" }, menu: null });
  // Recorded 2026-10-02 while recording: the portrait display's copy was crowded out, the primary one shown.
  const hidden = { name: "Item-0", onscreen: false, frame: { x: -649, y: -147, width: 64, height: 30 } };
  const primary = { name: "com.ericts.record", onscreen: true, frame: { x: 1319, y: 0, width: 64, height: 30 } };

  it("clicks the frame AX reports while that copy is on screen", () => {
    expect(clickTarget(snapshot([{ ...hidden, onscreen: true }, primary]), "com.ericts.record")).toEqual({ point: { x: -617, y: -132 }, via: "the Accessibility frame" });
  });

  it("falls back to the on-screen window named by the bundle identifier when that copy is crowded out", () => {
    expect(clickTarget(snapshot([hidden, primary]), "com.ericts.record")).toEqual({ point: { x: 1351, y: 15 }, via: "the on-screen com.ericts.record window" });
  });

  it("refuses to click when no copy is visible, never another app's item", () => {
    const other = { name: "com.apple.Spotlight", onscreen: true, frame: { x: 1640, y: 0, width: 31, height: 30 } };
    expect(clickTarget(snapshot([hidden, other, { ...primary, onscreen: false }]), "com.ericts.record")).toMatchObject({ hidden: expect.stringContaining("not on screen") });
  });
});
