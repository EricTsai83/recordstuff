import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import { DEFAULT_HOTKEY, SETTINGS_SHORTCUT } from "../shared/hotkey";

/** Former defaults and suggestions: valid custom values, no longer offered. */
const LEGACY_HOTKEYS = ["CommandOrControl+Alt+Shift+R", "CommandOrControl+Shift+R", "CommandOrControl+Alt+R"];
import type { RecordingState } from "../shared/state";
import { translate as t } from "../shared/i18n";
import { dayHeading, shortTime, formatDuration, proposesHotkey, settingsAction, settingsChecked, settingsView } from "./settings-model";
import type { LibraryState, RecordingFile } from "./recordings-library";
import type { AppContext } from "./ui-model";

const context: AppContext = {
  platform: "darwin",
  outputDir: "/tmp/recordings",
  homeDir: "/tmp",
  quality: DEFAULT_QUALITY,
  countdown: 3, countdownSound: true,
  language: "en",
  hotkey: { ...DEFAULT_HOTKEY, registered: true },
  updates: { state: { kind: "idle" }, enabled: true },
  notifications: true,
  displays: [], display: { kind: "primary" },
};
const idle: RecordingState = { type: "idle" };
const busy: RecordingState[] = [
  { type: "starting" },
  { type: "countdown", remaining: 2 },
  { type: "recording", startedAt: "2026-09-20T00:00:00Z" },
  { type: "stopping" },
];
const group = (state: RecordingState, ctx: AppContext, id: string) =>
  settingsView(state, ctx).groups.find((candidate) => candidate.id === id);
const checked = (state: RecordingState, ctx: AppContext, id: string) =>
  group(state, ctx, id)?.choices.find((choice) => choice.checked)?.id;

describe("settingsView", () => {
  it("titles the capture warning by what it is about and puts the macOS notification permission behind the ⓘ", () => {
    const zh = { ...context, language: "zh-TW" as const, captureWarning: "無法確認解析度上限。" };
    expect(group(idle, zh, "screen")?.diagnostics?.at(-1)).toMatchObject({ kind: "history", heading: "錄影解析度" });
    expect(group(idle, { ...context, captureWarning: "x" }, "screen")?.diagnostics?.at(-1)?.heading).toBe("Recording resolution");
    expect(group(idle, zh, "notifications")).toMatchObject({ info: t("macOS must also allow RecordStuff in System Settings → Notifications.", "zh-TW") });
    expect(group(idle, zh, "notifications")?.note).toBeUndefined();
    expect(group(idle, context, "notifications")?.info).toBe("macOS must also allow RecordStuff in System Settings → Notifications.");
    // Off: the status stays on screen, and the permission no longer matters.
    const off = group(idle, { ...context, notifications: false }, "notifications")!;
    expect([off.noteKind, off.info]).toEqual(["status", undefined]);
    expect(off.note).toBe("Failures still appear in the menu bar and the Failures tab.");
    expect(group(idle, { ...context, platform: "win32" }, "notifications")).not.toHaveProperty("info");
    expect(group(idle, { ...context, platform: "win32" }, "notifications")).not.toHaveProperty("note");
    // Windows has a system tray, not a menu bar (plan 064).
    expect(group(idle, { ...context, platform: "win32", notifications: false }, "notifications")?.note).toBe("Failures still appear in the system tray and the Failures tab.");
    expect(group(idle, { ...context, platform: "win32", notifications: false, language: "zh-TW" }, "notifications")?.note).toBe("失敗仍會顯示在系統匣與「失敗紀錄」分頁。");
    // Only status notes stay visible; the remaining explanations sit behind an ⓘ.
    expect(group(idle, context, "screen")).not.toHaveProperty("note");
    expect(group(idle, context, "videoQuality")?.info).toBe("Higher quality keeps more detail but makes larger files.");
    expect(group(idle, context, "resolutionCap")?.info).toBe("Scales larger screens down, keeping the aspect ratio. Smaller ones are not enlarged.");
  });
  it("offers every preference with a stable id and exactly one committed choice", () => {
    const view = settingsView(idle, context);
    expect(view.groups.map((entry) => entry.id)).toEqual([
      "screen",
      "outputFolder",
      "countdown",
      "countdownSound",
      "videoQuality",
      "resolutionCap",
      "frameRate",
      // General (plan 048): everyday preferences first, maintenance beside the About footer.
      "trayClick",
      "hotkey",
      "notifications",
      "language",
      "appearance",
      "updateChecks",
      "updates",
      "log",
      "about",
    ]);
    for (const entry of view.groups) {
      expect(entry.choices.filter((choice) => choice.checked), entry.id).toHaveLength(entry.kind === "actions" ? 0 : 1);
      expect(entry.enabled, entry.id).toBe(true);
    }
    expect(checked(idle, context, "countdown")).toBe("3");
    expect(checked(idle, context, "countdownSound")).toBe("on");
    expect(checked(idle, context, "videoQuality")).toBe("standard");
    expect(checked(idle, context, "resolutionCap")).toBe("source");
    expect(checked(idle, context, "frameRate")).toBe("30");
    expect(checked(idle, context, "hotkey")).toBe(DEFAULT_HOTKEY.accelerator);
    expect(checked(idle, context, "updateChecks")).toBe("on");
    expect(checked(idle, context, "language")).toBe("en");
    // A context without the choice is an app from before it: the click that records.
    expect(checked(idle, context, "trayClick")).toBe("record");
    expect(checked(idle, { ...context, trayClick: "menu" }, "trayClick")).toBe("menu");
  });

  it("never leaks an action to the renderer", () => {
    for (const entry of settingsView(idle, context).groups) {
      for (const choice of entry.choices) expect(Object.keys(choice).sort()).toEqual(["checked", "enabled", "id", "label"]);
    }
  });

  it("translates titles, hints and labels, and reflects a committed language", () => {
    const view = settingsView(idle, { ...context, language: "zh-TW" });
    expect(view.language).toBe("zh-TW");
    // Named after the app, not translated (2026-10-04).
    expect(view.title).toBe("RecordStuff");
    expect(view.hint).toBe("");
    expect(group(idle, { ...context, language: "zh-TW" }, "videoQuality")?.label).toBe("影像品質");
    expect(settingsView(idle, context).title).toBe("RecordStuff");
  });

  it("keeps an unverified frame rate visible, selectable only where it is verified", () => {
    const macFps = group(idle, context, "frameRate")!.choices;
    expect(macFps.map((choice) => [choice.id, choice.label, choice.enabled])).toEqual([
      ["30", "30 fps", true],
      ["60", "60 fps", true],
    ]);
    const winFps = group(idle, { ...context, platform: "win32" }, "frameRate")!.choices;
    expect(winFps[1]).toMatchObject({ id: "60", enabled: false, label: "60 fps (unverified on this platform)" });
  });

  it("states a refused shortcut registration instead of hiding the conflict", () => {
    const conflicted = { ...context, hotkey: { ...DEFAULT_HOTKEY, registered: false } };
    expect(group(idle, conflicted, "hotkey")).toMatchObject({
      label: "Shortcut",
      diagnostics: [{ kind: "current", heading: "Shortcut unavailable", reason: "Another app may be using this shortcut.", guidance: "Record from the menu, or choose another shortcut." }],
    });
    expect(checked(idle, conflicted, "hotkey")).toBe(DEFAULT_HOTKEY.accelerator);
    expect(group(idle, { ...conflicted, language: "zh-TW" }, "hotkey")?.diagnostics?.[0]?.reason).toBe("這個快捷鍵可能被其他 App 佔用。");
    // A registered shortcut needs no warning at all.
    expect(group(idle, context, "hotkey")).not.toHaveProperty("note");
  });

  it("checks Off while disabled and keeps the remembered accelerator", () => {
    const off = { ...context, hotkey: { enabled: false, accelerator: LEGACY_HOTKEYS[0]!, registered: false } };
    expect(checked(idle, off, "hotkey")).toBe("off");
    expect(group(idle, off, "hotkey")).not.toHaveProperty("note");
    expect(settingsAction(idle, off, "hotkey", "off")).toEqual({
      setHotkey: { enabled: false, accelerator: LEGACY_HOTKEYS[0]! },
    });
  });
});

describe("tabs follow sections", () => {
  it("puts the source, countdown and video sections on Recording settings and never splits a section across tabs", () => {
    const groups = settingsView(idle, context).groups;
    const tabs = new Map<string, Set<string>>();
    for (const group of groups) tabs.set(group.section!, (tabs.get(group.section!) ?? new Set()).add(group.tab));
    expect([...tabs.values()].every(sectionTabs => sectionTabs.size === 1)).toBe(true);
    expect(groups.filter(group => group.tab === "recording").map(group => group.section))
      .toEqual(["source", "source", "countdown", "countdown", "video", "video", "video"]);
  });
});

describe("recording locks every preference except the language", () => {
  it.each(busy)("$type", (state) => {
    const view = settingsView(state, context);
    expect(view.hint).toBe("Recording in progress; only language and appearance can change.");
    for (const entry of view.groups) expect(entry.enabled, entry.id).toBe(["trayClick", "language", "appearance", "log", "about"].includes(entry.id));
    expect(settingsAction(state, context, "trayClick", "menu")).toEqual({ setTrayClick: "menu" });
    expect(settingsAction(state, context, "language", "zh-TW")).toEqual({ setLanguage: "zh-TW" });
    for (const [group, choice] of [["videoQuality", "high"], ["frameRate", "60"], ["hotkey", "off"], ["updateChecks", "off"]]) {
      expect(settingsAction(state, context, group, choice), group).toBeUndefined();
    }
  });

  it("needsPermission is not a recording: everything stays editable", () => {
    const state: RecordingState = { type: "needsPermission", needsRelaunch: false };
    expect(settingsView(state, context).hint).toBe("");
    expect(settingsAction(state, context, "frameRate", "60")).toEqual({ setQuality: { frameRate: 60 } });
  });
});

describe("settingsAction only resolves what is offered right now", () => {
  it("maps each id to the action the tray would have raised", () => {
    expect(settingsAction(idle, context, "videoQuality", "economy")).toEqual({ setQuality: { videoQuality: "economy" } });
    expect(settingsAction(idle, context, "resolutionCap", "1080p")).toEqual({ setQuality: { resolutionCap: "1080p" } });
    expect(settingsAction(idle, context, "frameRate", "60")).toEqual({ setQuality: { frameRate: 60 } });
    expect(settingsAction(idle, context, "updateChecks", "off")).toEqual({ setUpdateChecks: false });
    expect(settingsAction(idle, context, "hotkey", LEGACY_HOTKEYS[0]!)).toEqual({
      setHotkey: { enabled: true, accelerator: LEGACY_HOTKEYS[0]! },
    });
  });

  it("refuses unknown, disabled, absent and non-string ids", () => {
    const cases: Array<[unknown, unknown]> = [
      ["quit", "now"],
      ["language", "fr"],
      ["videoQuality", "ultra"],
      ["hotkey", "Command+Q"],
      [null, "economy"],
      ["videoQuality", {}],
      [undefined, undefined],
    ];
    for (const [group, choice] of cases) expect(settingsAction(idle, context, group, choice), String(group)).toBeUndefined();
    // Offered but unavailable on this platform.
    expect(settingsAction(idle, { ...context, platform: "win32" }, "frameRate", "60")).toBeUndefined();
  });
});

describe("settingsChecked reports whether a save took effect", () => {
  it("is true only for the committed choice", () => {
    expect(settingsChecked(idle, context, "frameRate", "30")).toBe(true);
    expect(settingsChecked(idle, context, "frameRate", "60")).toBe(false);
    expect(settingsChecked(idle, { ...context, quality: { ...DEFAULT_QUALITY, frameRate: 60 } }, "frameRate", "60")).toBe(true);
    expect(settingsChecked(idle, context, "nope", "30")).toBe(false);
    // A locked group still reports the truth; only `settingsAction` gates writes.
    expect(settingsChecked(busy[0]!, context, "frameRate", "30")).toBe(true);
  });
});

describe("a remembered shortcut that is now the Settings shortcut", () => {
  it("is not offered once Off, because choosing it again is refused, but stays selectable while it is the current one", () => {
    const off: AppContext = { ...context, hotkey: { enabled: false, accelerator: SETTINGS_SHORTCUT, registered: false } };
    const choice = (ctx: AppContext) => group(idle, ctx, "hotkey")?.choices.find(c => c.id === SETTINGS_SHORTCUT);
    expect(choice(off)).toMatchObject({ enabled: false, checked: false });
    expect(settingsAction(idle, off, "hotkey", SETTINGS_SHORTCUT)).toBeUndefined();
    const current: AppContext = { ...off, hotkey: { enabled: true, accelerator: SETTINGS_SHORTCUT, registered: true } };
    expect(choice(current)).toMatchObject({ enabled: true, checked: true });
    // The recommended combination is never the Settings one.
    expect(group(idle, off, "hotkey")?.choices.find(c => c.id === DEFAULT_HOTKEY.accelerator)?.enabled).toBe(true);
  });
});

describe("a quit in progress", () => {
  it("offers nothing but says why, as the tray does", () => {
    const ctx: AppContext = { ...context, quitting: true, recordingResults: [
      { id: "f", code: "disk_full", detail: "", occurredAt: "2026-09-24T12:00:00Z", outcome: "empty", acknowledged: false }] };
    const view = settingsView(idle, ctx);
    expect(view.hint).toBe("Quitting once the recording is saved or cleaned up…");
    expect(view.groups.filter(g => g.enabled).map(g => g.id)).toEqual([]);
    expect(view.recordingResults?.flatMap(r => r.actions).filter(a => a.enabled)).toEqual([]);
    expect(settingsAction(idle, ctx, "language", "zh-TW")).toBeUndefined();
    expect(settingsAction(idle, ctx, "recordingResult:f", "acknowledge")).toBeUndefined();
    // The same context without the quit still offers them.
    expect(settingsAction(idle, { ...ctx, quitting: false }, "language", "zh-TW")).toEqual({ setLanguage: "zh-TW" });
    expect(settingsView(idle, { ...ctx, quitting: false }).recordingResults?.[0]?.actions.some(a => a.enabled)).toBe(true);
  });
});

describe("update actions in General", () => {
  it("offers manual checks even when startup checks are off", () => {
    const ctx = { ...context, updates: { state: { kind: "idle" } as const, enabled: false } };
    expect(group(idle, ctx, "updates")).toMatchObject({ tab: "general", kind: "actions" });
    expect(settingsAction(idle, ctx, "updates", "check")).toBe("checkUpdates");
    for (const state of busy) expect(settingsAction(state, ctx, "updates", "check")).toBeUndefined();
  });
  it("disables duplicate checks and exposes results and retry", () => {
    const ctx: AppContext = { ...context, updates: { state: { kind: "checking" }, enabled: true } };
    expect(settingsAction(idle, ctx, "updates", "check")).toBeUndefined();
    for (const state of [{ kind: "available", version: "9.0.0" }, { kind: "failed" }] as const) {
      ctx.updates.state = state;
      expect(settingsAction(idle, ctx, "updates", "open")).toBe("openUpdate");
      expect(settingsAction(idle, ctx, "updates", "check")).toBe("checkUpdates");
    }
    // Each result is a status note, which the page reads out; the button only offers what to do about it.
    ctx.updates.state = { kind: "available", version: "9.0.0" };
    expect(group(idle, ctx, "updates")).toMatchObject({ noteKind: "status", note: "Version 9.0.0 is available." });
    expect(group(idle, ctx, "updates")?.choices.find(c => c.id === "open")?.label).toBe("Download 9.0.0…");
    ctx.updates.state = { kind: "failed" };
    expect(group(idle, ctx, "updates")).toMatchObject({ noteKind: "status", note: "Could not check for updates." });
    expect(group(idle, { ...ctx, language: "zh-TW" }, "updates")).toMatchObject({ note: "無法檢查更新。" });
    ctx.updates.state = { kind: "current", checkedAt: 1234567890000 };
    expect(group(idle, ctx, "updates")?.note).toContain(new Date(1234567890000).toLocaleString("en"));
    expect(settingsAction(idle, ctx, "updates", "open")).toBeUndefined();
  });
  it("places quality controls in Recording", () => {
    expect(settingsView(idle, context).groups.filter(g => g.tab === "recording").map(g => g.id)).toEqual(["screen", "outputFolder", "countdown", "countdownSound", "videoQuality", "resolutionCap", "frameRate"]);
  });
});

describe("countdown group (plan 040)", () => {
  it("offers Off, 3, 5 and 10 seconds as a segmented control after Screen, with the cancel note", () => {
    const countdown = group(idle, context, "countdown")!;
    expect(countdown).toMatchObject({ label: "Countdown", control: "segmented", tab: "recording", section: "countdown", noteKind: "explanation" });
    expect(countdown.choices.map((c) => [c.id, c.label, c.checked])).toEqual([["0", "Off", false], ["3", "3 s", true], ["5", "5 s", false], ["10", "10 s", false]]);
    expect(countdown).not.toHaveProperty("note");
    expect(countdown.info).toBe("Click the menu bar icon or press the shortcut to cancel.");
    const zh = group(idle, { ...context, language: "zh-TW" }, "countdown")!;
    expect([zh.label, ...zh.choices.map((c) => c.label)]).toEqual(["倒數", "關閉", "3 秒", "5 秒", "10 秒"]);
    expect(zh.info).toBe("按一下選單列圖示或按快捷鍵即可取消。");
    expect(checked(idle, { ...context, countdown: 0 }, "countdown")).toBe("0");
  });

  it("names the shortcut as a way to cancel only while it works", () => {
    expect(group(idle, context, "countdown")!.info).toContain("press the shortcut");
    for (const hotkey of [{ ...context.hotkey, enabled: false }, { ...context.hotkey, registered: false }]) {
      expect(group(idle, { ...context, hotkey }, "countdown")!.info).toBe("Click the menu bar icon to cancel.");
      expect(group(idle, { ...context, hotkey, language: "zh-TW" }, "countdown")!.info).toBe("按一下選單列圖示即可取消。");
    }
  });

  it("points Windows at the system tray icon instead of the menu bar (plan 064)", () => {
    const windows = { ...context, platform: "win32" as const };
    expect(group(idle, windows, "countdown")!.info).toBe("Click the system tray icon or press the shortcut to cancel.");
    expect(group(idle, { ...windows, language: "zh-TW" }, "countdown")!.info).toBe("按一下系統匣圖示或按快捷鍵即可取消。");
    const hotkey = { ...context.hotkey, enabled: false };
    expect(group(idle, { ...windows, hotkey }, "countdown")!.info).toBe("Click the system tray icon to cancel.");
    expect(group(idle, { ...windows, hotkey, language: "zh-TW" }, "countdown")!.info).toBe("按一下系統匣圖示即可取消。");
  });

  it("resolves each choice to setCountdown and is locked while starting, counting down, recording or saving", () => {
    for (const value of [0, 3, 5, 10] as const) expect(settingsAction(idle, context, "countdown", String(value))).toEqual({ setCountdown: value });
    expect(settingsAction(idle, context, "countdown", "4")).toBeUndefined();
    for (const state of [{ type: "starting" }, { type: "countdown", remaining: 2 }, { type: "recording", startedAt: "x" }, { type: "stopping" }] as RecordingState[]) {
      expect(group(state, context, "countdown")?.enabled, state.type).toBe(false);
      expect(settingsAction(state, context, "countdown", "5"), state.type).toBeUndefined();
    }
    expect(settingsView({ type: "countdown", remaining: 2 }, context).hint).toBe("Recording in progress; only language and appearance can change.");
    expect(settingsChecked(idle, { ...context, countdown: 10 }, "countdown", "10")).toBe(true);
  });
});

describe("countdown sound (plan 046)", () => {
  it("is a switch directly after Countdown whose ⓘ says the tick is not recorded, in both languages", () => {
    const sound = group(idle, context, "countdownSound")!;
    expect(sound).toMatchObject({ label: "Countdown sound", control: "switch", tab: "recording", section: "countdown", noteKind: "explanation", enabled: true });
    expect(sound.choices.map((c) => [c.id, c.label, c.checked])).toEqual([["on", "On", true], ["off", "Off", false]]);
    expect(sound).not.toHaveProperty("note");
    expect(sound.info).toBe("The tick is not recorded.");
    const zh = group(idle, { ...context, language: "zh-TW" }, "countdownSound")!;
    expect([zh.label, ...zh.choices.map((c) => c.label)]).toEqual(["倒數音效", "開啟", "關閉"]);
    expect(zh.info).toBe("提示音不會被錄進影片。");
    expect(checked(idle, { ...context, countdownSound: false }, "countdownSound")).toBe("off");
  });

  it("resolves both ids to setCountdownSound", () => {
    expect(settingsAction(idle, context, "countdownSound", "off")).toEqual({ setCountdownSound: false });
    expect(settingsAction(idle, context, "countdownSound", "on")).toEqual({ setCountdownSound: true });
    expect(settingsAction(idle, context, "countdownSound", "loud")).toBeUndefined();
  });

  it("is disabled while the countdown is Off, keeping its value", () => {
    const off = { ...context, countdown: 0 as const };
    expect(group(idle, off, "countdownSound")?.enabled).toBe(false);
    expect(checked(idle, off, "countdownSound")).toBe("on");
    expect(checked(idle, { ...off, countdownSound: false }, "countdownSound")).toBe("off");
    expect(settingsAction(idle, off, "countdownSound", "off")).toBeUndefined();
  });

  it("is locked while starting, counting down, recording or saving", () => {
    for (const state of [{ type: "starting" }, { type: "countdown", remaining: 2 }, { type: "recording", startedAt: "x" }, { type: "stopping" }] as RecordingState[]) {
      expect(group(state, context, "countdownSound")?.enabled, state.type).toBe(false);
      expect(settingsAction(state, context, "countdownSound", "off"), state.type).toBeUndefined();
    }
  });
});

describe("notifications in General", () => {
  it("reflects the committed switch and maps both ids to the action", () => {
    expect(checked(idle, context, "notifications")).toBe("on");
    expect(checked(idle, { ...context, notifications: false }, "notifications")).toBe("off");
    expect(settingsAction(idle, context, "notifications", "off")).toEqual({ setNotifications: false });
    expect(settingsAction(idle, context, "notifications", "on")).toEqual({ setNotifications: true });
  });

  it("is locked while a capture is running, like every other preference", () => {
    for (const state of busy) expect(settingsAction(state, context, "notifications", "off")).toBeUndefined();
  });

  /** Off is obeyed, not compensated for: the cost is stated where the choice is. */
  it("states what turning it off costs and where to look instead", () => {
    const off = group(idle, { ...context, notifications: false }, "notifications")?.note ?? "";
    expect(off).toContain(t("Failures still appear in the menu bar and the Failures tab.", "en"));
    // The macOS caveat is about a permission the user did not choose; it would
    // only confuse the reading of a switch the user did choose to turn off.
    expect(off).not.toContain("System Settings");
    expect(group(idle, { ...context, notifications: false }, "notifications")?.choices.find((c) => c.checked)?.id).toBe("off");
  });

  /** Claiming an OS state the app cannot read would be worse than saying nothing. */
  it("names the macOS recovery path behind the ⓘ without reporting a permission state", () => {
    const info = group(idle, context, "notifications")?.info ?? "";
    expect(info).toContain("System Settings");
    expect(info).not.toMatch(/denied|authoriz/i);
    expect(group(idle, { ...context, notifications: false }, "notifications")?.info).toBeUndefined();
  });

  /** One card: changing the switch and checking the OS are one decision. */
  it("carries the settings pane as an action in the switch's own card, on macOS only", () => {
    const mac = group(idle, context, "notifications");
    expect(mac?.actions?.map((a) => a.id)).toEqual(["openSettings"]);
    expect(settingsAction(idle, context, "notifications", "openSettings")).toBe("openNotificationSettings");
    // The action has no committed value and must not be mistaken for one.
    expect(mac?.actions?.every((a) => !a.checked)).toBe(true);
    expect(settingsChecked(idle, context, "notifications", "openSettings")).toBe(false);

    const win = group(idle, { ...context, platform: "win32" }, "notifications");
    expect(win?.actions).toBeUndefined();
    expect(settingsAction(idle, { ...context, platform: "win32" }, "notifications", "openSettings")).toBeUndefined();
  });
});

it("accepts canonical custom candidates only in the unlocked shortcut group", () => {
  expect(settingsAction(idle, context, "hotkey", "Shift+Control+F12")).toEqual({ setHotkey: { enabled: true, accelerator: "Control+Shift+F12" } });
  expect(settingsAction(idle, context, "hotkey", "CommandOrControl+Space")).toBeUndefined();
  // Reserved combinations follow the platform (plan 064): Spotlight's chord is free on Windows, Ctrl+Q is not.
  const windows = { ...context, platform: "win32" as const };
  expect(settingsAction(idle, windows, "hotkey", "CommandOrControl+Space")).toEqual({ setHotkey: { enabled: true, accelerator: "CommandOrControl+Space" } });
  expect(settingsAction(idle, windows, "hotkey", "Control+Q")).toBeUndefined();
  for (const state of busy) expect(settingsAction(state, context, "hotkey", "Control+F12")).toBeUndefined();
  const ctx = { ...context, hotkey: { enabled: true, registered: true, accelerator: "Control+Shift+F12" } };
  expect(checked(idle, ctx, "hotkey")).toBe("Control+Shift+F12");
  expect(settingsChecked(idle, ctx, "hotkey", "Shift+Control+F12")).toBe(true);
});

describe("screen choice", () => {
  const d = { id: "7", label: "Studio", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: false, primary: true };
  const selected: AppContext = { ...context, displays: [d], display: { kind: "display", id: "7", label: "Studio" } };
  it("offers live ids, authorizes the main-owned label and locks while busy", () => {
    expect(group(idle, selected, "screen")?.tab).toBe("recording");
    expect(checked(idle, selected, "screen")).toBe("7");
    expect(settingsAction(idle, selected, "screen", "7")).toEqual({ setDisplay: selected.display });
    expect(settingsAction(idle, selected, "screen", "unknown")).toBeUndefined();
    for (const state of busy) expect(settingsAction(state, selected, "screen", "primary")).toBeUndefined();
  });
  it("retains one disabled stale choice, including duplicate ids", () => {
    for (const displays of [[], [d, d]]) {
      const ctx = { ...selected, displays };
      const screen = group(idle, ctx, "screen")!;
      expect(screen.choices.filter((c) => c.id === "7")).toHaveLength(1);
      expect(screen.choices.find((c) => c.checked)).toMatchObject({ id: "7", enabled: false });
      expect(settingsAction(idle, ctx, "screen", "7")).toBeUndefined();
      expect(screen.diagnostics?.[0]?.heading).toBe("Selected display is unavailable");
      expect(screen.note).toBeUndefined();
      expect(settingsAction(idle, ctx, "screen", "primary")).toEqual({ setDisplay: { kind: "primary" } });
    }
  });
  it("keeps last source failure visible with notifications off without calling it disconnected", () => {
    const ctx = { ...selected, notifications: false, displayFailure: "source_missing" as const };
    expect(group(idle, ctx, "screen")?.diagnostics?.[0]).toMatchObject({ kind: "history", heading: "Last recording failure" });
    expect(group(idle, ctx, "screen")?.diagnostics?.[0]?.reason).toContain("capture source is unavailable");
    expect(group(idle, ctx, "screen")?.recovery).toBeUndefined();
    expect(group(idle, ctx, "screen")?.choices.find((c) => c.checked)?.enabled).toBe(true);
  });
});


it("declares presentation without changing choice identities, and authorizes only fixed links", () => {
  const groups = settingsView(idle, context).groups;
  expect(groups.map(g => [g.id, g.control, g.section])).toEqual([
    ["screen", "menu", "source"], ["outputFolder", "menu", "source"], ["countdown", "segmented", "countdown"], ["countdownSound", "switch", "countdown"],
    ["videoQuality", "segmented", "video"],
    ["resolutionCap", "menu", "video"], ["frameRate", "menu", "video"],
    ["trayClick", "menu", "controls"], ["hotkey", "menu", "controls"], ["notifications", "switch", "controls"],
    ["language", "segmented", "display"], ["appearance", "menu", "display"],
    ["updateChecks", "switch", "updates"], ["updates", "menu", "updates"], ["log", "menu", "support"], ["about", "menu", "about"],
  ]);
  expect(group(idle, { ...context, notifications: false }, "notifications")?.noteKind).toBe("status");
  expect(group(idle, context, "videoQuality")?.noteKind).toBe("explanation");
  expect(group(idle, context, "updates")?.noteKind).toBe("status");
  expect(settingsAction(busy[0]!, context, "about", "website")).toBe("openWebsite");
  expect(settingsAction(busy[0]!, context, "about", "source")).toBe("openSource");
  expect(settingsAction(idle, context, "about", "https://evil.example")).toBeUndefined();
});

it("offers Primary recovery only for a current blocker with a resolvable alternative, and retains history on reconnect", () => {
  const display = { id: "1", label: "Internal", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true };
  const ctx: AppContext = { ...context, displays: [display], display: { kind: "display", id: "2", label: "External" }, displayFailure: "target_removed" };
  const screen = group(idle, ctx, "screen")!;
  expect(screen.recovery).toEqual({ choice: "primary", label: "Use Primary display" });
  expect(screen.diagnostics?.map(d => d.kind)).toEqual(["current", "history"]);
  expect(screen.choices.find(c => c.checked)?.label).toBe("External — Unavailable");
  ctx.displays.push({ ...display, id: "2", label: "External", primary: false });
  expect(group(idle, ctx, "screen")?.recovery).toBeUndefined();
  expect(group(idle, ctx, "screen")?.diagnostics?.map(d => d.kind)).toEqual(["history"]);
  ctx.displays = [];
  expect(group(idle, ctx, "screen")?.recovery).toBeUndefined();
});


it("offers appearance during recording and rejects unknown themes", () => {
  for (const appearance of ["system", "light", "dark"] as const) {
    expect(checked(idle, { ...context, appearance }, "appearance")).toBe(appearance);
    expect(settingsAction({ type: "starting" }, context, "appearance", appearance)).toEqual({ setAppearance: appearance });
  }
  expect(settingsAction(idle, context, "appearance", "unknown")).toBeUndefined();
});


it("keeps the previous update result visible while checking again", () => {
  for (const previous of [{ kind: "current", checkedAt: 1000 }, { kind: "available", version: "0.2.0" }, { kind: "failed" }] as const) {
    const before = group(idle, { ...context, updates: { enabled: true, state: previous } }, "updates")!;
    const during = group(idle, { ...context, updates: { enabled: true, state: { kind: "checking", previous } } }, "updates")!;
    expect(during.note).toBe(before.note);
    expect(during.choices.map(c => c.id)).toEqual(before.choices.map(c => c.id));
    expect(during.choices[0]!.label).toBe("Checking for updates…");
    // Busy, not unavailable: the pressed button keeps keyboard focus (plan 053), and main still refuses it.
    expect(during.choices.every(c => c.enabled && c.busy === true)).toBe(true);
    expect(before.choices.some(c => "busy" in c)).toBe(false);
  }
});


it("offers one recommended shortcut and only the currently saved custom value", () => {
  const recommended = DEFAULT_HOTKEY.accelerator;
  const choices = group(idle, context, "hotkey")!.choices;
  expect(choices.map(c => c.id)).toEqual([recommended, "off"]);
  expect(choices[0]!.label).toBe("Recommended: ⌘⇧1");
  expect(group(idle, { ...context, language: "zh-TW" }, "hotkey")!.choices[0]!.label).toBe("建議：⌘⇧1");
  for (const accelerator of [...LEGACY_HOTKEYS, "Control+Shift+F20"]) {
    const custom = { ...context, hotkey: { enabled: true, registered: true, accelerator } };
    const customChoices = group(idle, custom, "hotkey")!.choices;
    expect(customChoices.map(c => c.id)).toEqual([recommended, accelerator, "off"]);
    expect(customChoices[1]).toMatchObject({ checked: true });
    expect(customChoices[1]!.label).toContain("(custom)");
    // Returning to the recommendation has no remembered custom/history item.
    const restored = { ...custom, hotkey: { ...custom.hotkey, accelerator: recommended } };
    expect(group(idle, restored, "hotkey")!.choices.map(c => c.id)).toEqual([recommended, "off"]);
  }
});

it("lists a Windows Ctrl capture of the recommended keys as the recommendation, not a second custom entry", () => {
  const recommended = DEFAULT_HOTKEY.accelerator;
  // Off macOS the editor captures Ctrl as Control, which presses the same keys as CommandOrControl.
  const windows = { ...context, platform: "win32" as const, hotkey: { enabled: true, registered: true, accelerator: "Control+Shift+1" } };
  const choices = group(idle, windows, "hotkey")!.choices;
  expect(choices.map(c => c.id)).toEqual([recommended, "off"]);
  expect(choices[0]).toMatchObject({ checked: true, label: "Recommended: Ctrl+Shift+1" });
  expect(settingsChecked(idle, windows, "hotkey", recommended)).toBe(true);
  // On macOS Control is not Command, so the same value stays a custom shortcut.
  const mac = group(idle, { ...windows, platform: "darwin" }, "hotkey")!.choices;
  expect(mac.map(c => c.id)).toEqual([recommended, "Control+Shift+1", "off"]);
  expect(settingsChecked(idle, { ...windows, platform: "darwin" }, "hotkey", recommended)).toBe(false);
});

it("offers result actions by exact failure identity with recording and cleanup locks", () => {
  const result = { id: "failure-1", occurredAt: "2026-09-24T12:00:00Z", code: "disk_full" as const,
    detail: "ENOSPC", outcome: "pending" as const, acknowledged: false };
  const ctx = { ...context, notifications: false, recordingResults: [result] };
  expect(settingsAction(idle, ctx, "recordingResult:failure-1", "acknowledge")).toBeUndefined();
  const done = { ...ctx, recordingResults: [{ ...result, outcome: "partial" as const, partialPath: "/tmp/a.recording.mp4" }] };
  expect(settingsAction(idle, done, "recordingResult:failure-1", "acknowledge")).toEqual({ recordingResult: { id: "failure-1", action: "acknowledge" } });
  expect(settingsAction(idle, done, "recordingResult:old", "acknowledge")).toBeUndefined();
  expect(settingsAction({ type: "recording", startedAt: "" }, done, "recordingResult:failure-1", "folder")).toBeUndefined();
  expect(settingsAction({ type: "recording", startedAt: "" }, done, "recordingResult:failure-1", "reveal")).toBeDefined();
  expect(settingsView(idle, done).recordingResults?.[0]?.outcome).toContain("may not play");
});

it("offers macOS permission recovery with pending relaunch locked and no macOS action on Windows", () => {
  const result = { id: "permission-a", occurredAt: "2026-09-24T12:00:00Z", code: "permission_denied" as const, detail: "", outcome: "pending" as const, acknowledged: false };
  const ctx = { ...context, platform: "darwin" as const, recordingResults: [result] };
  const group = "recordingResult:permission-a";
  expect(settingsAction(idle, ctx, group, "permission")).toBeDefined();
  expect(settingsAction(idle, ctx, group, "relaunch")).toBeUndefined();
  const done = { ...ctx, recordingResults: [{ ...result, outcome: "empty" as const }] };
  expect(settingsAction(idle, done, group, "relaunch")).toBeDefined();
  const windows = { ...done, platform: "win32" as const };
  expect(settingsAction(idle, windows, group, "permission")).toBeUndefined();
  expect(settingsAction(idle, windows, group, "relaunch")).toBeUndefined();
  expect(settingsView(idle, windows).recordingResults?.[0]?.guidance).not.toContain("System Settings");
});

it("offers persistence retry for an acknowledged result and bases restored relaunch on current state", () => {
  const result = { id: "old", occurredAt: "2026-09-25T00:00:00Z", code: "permission_denied" as const,
    detail: "", outcome: "empty" as const, acknowledged: true, restored: true, persistenceFailed: "io" as const };
  const ctx = { ...context, platform: "darwin" as const, recordingResults: [result] };
  const view = settingsView(idle, ctx).recordingResults![0]!;
  expect(view.actions.find(a => a.id === "retry")).toMatchObject({ label: "Retry saving the record", enabled: true });
  expect(view.guidance).toContain("earlier session");
  expect(settingsAction(idle, ctx, "recordingResult:old", "relaunch")).toBeUndefined();
  expect(settingsAction({ type: "needsPermission", needsRelaunch: true }, ctx, "recordingResult:old", "relaunch")).toBeDefined();
});

it("retains audio-device guidance for a restored Windows audio failure", () => {
  const result = { id: "old-audio", occurredAt: "2026-09-25T00:00:00Z", code: "no_audio_track" as const,
    detail: "", outcome: "empty" as const, acknowledged: false, restored: true };
  const ctx = { ...context, platform: "win32" as const, recordingResults: [result] };
  expect(settingsView(idle, ctx).recordingResults?.[0]?.guidance).toContain("default playback device");
  expect(settingsAction(idle, ctx, "recordingResult:old-audio", "relaunch")).toBeUndefined();
});

it("gives accurate persistence guidance, retries only what retrying can fix and shows saving/loading state", () => {
  const base = { id: "f", occurredAt: "2026-09-25T00:00:00Z", code: "disk_full" as const, detail: "", outcome: "empty" as const, acknowledged: false };
  const row = (extra: object, language: "en" | "zh-TW" = "en", historyLoading = false) =>
    settingsView(idle, { ...context, language, historyLoading, recordingResults: [{ ...base, ...extra }] });
  const io = row({ persistenceFailed: "io" }).recordingResults![0]!;
  expect(io.persistenceWarning).toContain("keeps retrying");
  expect(io.actions.map(a => a.id)).toContain("retry");
  const blocked = row({ persistenceFailed: "blocked" }).recordingResults![0]!;
  expect(blocked.persistenceWarning).toContain("will not overwrite");
  expect(blocked.persistenceWarning).not.toContain("disk space");
  expect(blocked.actions.map(a => a.id)).not.toContain("retry");
  expect(settingsAction(idle, { ...context, recordingResults: [{ ...base, persistenceFailed: "blocked" }] }, "recordingResult:f", "retry")).toBeUndefined();
  expect(row({ persistenceFailed: "tooLarge" }).recordingResults![0]!.persistenceWarning).toContain("Remove reviewed failures");
  expect(row({ persistenceFailed: "tooLarge" }, "zh-TW").recordingResults![0]!.persistenceWarning).toContain("失敗紀錄過大");
  expect(row({ saving: "acknowledge" }).recordingResults![0]).toMatchObject({ saving: "Saving this change…", acknowledged: false });
  expect(row({}).recordingResults![0]!.saving).toBeUndefined();
  expect(row({}, "zh-TW", true).recordingHistoryStatus).toBe("正在載入失敗紀錄…");
  expect(row({}).recordingHistoryStatus).toBeUndefined();
});

describe("Recording failures tab (plan 047)", () => {
  const base = { occurredAt: "2026-09-24T12:00:00Z", code: "disk_full" as const, detail: "ENOSPC", outcome: "empty" as const };
  it("always offers Failures last, after Recordings, Recording and General, counting unread failures in its label and accessible name", () => {
    expect(settingsView(idle, context).tabs).toEqual([
      { id: "library", label: "Recordings" }, { id: "recording", label: "Recording settings" }, { id: "general", label: "General" }, { id: "failures", label: "Failures", accessibleLabel: "Recording failures" },
    ]);
    const results = [{ ...base, id: "a", acknowledged: false }, { ...base, id: "b", acknowledged: false }, { ...base, id: "c", acknowledged: true }];
    expect(settingsView(idle, { ...context, recordingResults: results }).tabs[3]).toEqual({
      id: "failures", label: "Failures (2)", accessibleLabel: "Recording failures, 2 unread",
    });
    expect(settingsView(idle, { ...context, language: "zh-TW", recordingResults: results }).tabs.map((tab) => tab.label))
      .toEqual(["錄影檔", "錄影設定", "一般", "失敗紀錄（2）"]);
    expect(settingsView(idle, { ...context, language: "zh-TW", recordingResults: results }).tabs[3]!.accessibleLabel).toBe("失敗紀錄，2 筆未確認");
    expect(settingsView(idle, { ...context, recordingResults: [results[2]!] }).tabs[3]).toEqual({ id: "failures", label: "Failures", accessibleLabel: "Recording failures" });
  });

  it("names the day a row is grouped under: Today, Yesterday, then the date with the year only for an earlier year", () => {
    const now = new Date(2026, 8, 28, 9, 30);
    expect(dayHeading(new Date(2026, 8, 28, 0, 5), now, "en")).toBe("Today");
    expect(dayHeading(new Date(2026, 8, 27, 23, 55), now, "en")).toBe("Yesterday");
    expect(dayHeading(new Date(2026, 8, 24, 12), now, "en")).toBe("September 24");
    expect(dayHeading(new Date(2025, 11, 31, 12), now, "en")).toBe("December 31, 2025");
    expect(dayHeading(new Date(2026, 8, 28, 0, 5), now, "zh-TW")).toBe("今天");
    expect(dayHeading(new Date(2026, 8, 27, 12), now, "zh-TW")).toBe("昨天");
    expect(dayHeading(new Date(2026, 8, 24, 12), now, "zh-TW")).toBe("9月24日");
    expect(dayHeading(new Date(2025, 11, 31, 12), now, "zh-TW")).toBe("2025年12月31日");
    // Across a month boundary, Yesterday is the previous calendar day.
    expect(dayHeading(new Date(2026, 8, 30, 22), new Date(2026, 9, 1, 1), "en")).toBe("Yesterday");
  });

  it("gives each row a short local time, its day, the file name and the full path, without a repeated heading", () => {
    expect(shortTime(new Date(2026, 8, 28, 14, 5), "en")).toBe("2:05 PM");
    expect(shortTime(new Date(2026, 8, 28, 14, 5), "zh-TW")).toBe("下午2:05");
    const occurredAt = new Date(2026, 8, 28, 14, 5).toISOString();
    const row = settingsView(idle, { ...context, now: new Date(2026, 8, 28, 20), recordingResults: [{ ...base, id: "p", occurredAt, acknowledged: false,
      outcome: "partial", partialPath: "/Users/me/Movies/RecordStuff/2026-09-28 14-05-00.recording.mp4" }] }).recordingResults![0]!;
    expect(row).toMatchObject({ day: "Today", time: "2:05 PM", fileName: "2026-09-28 14-05-00.recording.mp4",
      file: "/Users/me/Movies/RecordStuff/2026-09-28 14-05-00.recording.mp4" });
    expect(row).not.toHaveProperty("heading");
  });

  it("names times in the system zone of each view, even after the zone changes to one with the same offset (review batch 1)", () => {
    const zone = process.env["TZ"];
    try {
      // January in New York and July in Lima are both UTC−5; a formatter kept across views would read 1:00 PM.
      process.env["TZ"] = "America/New_York";
      expect(shortTime(new Date("2026-01-15T17:00:00Z"), "en")).toBe("12:00 PM");
      // The same failure, shown again after the change on the same day, is not a cached row from the old zone (review batch 2).
      const occurredAt = "2026-07-15T17:00:00.000Z";
      const result = { ...base, id: "z", occurredAt, acknowledged: false };
      const show = (): string => settingsView(idle, { ...context, now: new Date("2026-01-15T17:00:00Z"), recordingResults: [result] }).recordingResults![0]!.time;
      expect(show()).toBe("1:00 PM");
      process.env["TZ"] = "America/Lima";
      expect(shortTime(new Date("2026-07-15T17:00:00Z"), "en")).toBe("12:00 PM");
      expect(show()).toBe("12:00 PM");
    } finally {
      if (zone === undefined) delete process.env["TZ"]; else process.env["TZ"] = zone;
    }
  });
});

describe("Output folder in Settings → Recording (plan 048)", () => {
  it("shows the path after Screen with Change… and Show in Finder through the tray's handlers", () => {
    const folder = group(idle, context, "outputFolder")!;
    expect(folder).toMatchObject({ label: "Output folder", kind: "actions", tab: "recording", section: "source", enabled: true, note: "~/recordings" });
    expect(folder.choices.map((c) => [c.id, c.label, c.enabled])).toEqual([["change", "Change…", true], ["reveal", "Show in Finder", true]]);
    expect(settingsAction(idle, context, "outputFolder", "change")).toBe("changeOutputDir");
    expect(settingsAction(idle, context, "outputFolder", "reveal")).toBe("openOutputDir");
    expect(settingsAction(idle, context, "outputFolder", "/tmp")).toBeUndefined();
    const zh = group(idle, { ...context, language: "zh-TW" }, "outputFolder")!;
    expect([zh.label, ...zh.choices.map((c) => c.label)]).toEqual(["儲存位置", "更改…", "在 Finder 中顯示"]);
    expect(group(idle, { ...context, platform: "win32" }, "outputFolder")!.choices[1]!.label).toBe("Open folder");
  });

  it("is locked while starting, counting down, recording or saving, as the tray's folder items are", () => {
    for (const state of [{ type: "starting" }, { type: "countdown", remaining: 2 }, { type: "recording", startedAt: "x" }, { type: "stopping" }] as RecordingState[]) {
      expect(group(state, context, "outputFolder")?.enabled, state.type).toBe(false);
      expect(settingsAction(state, context, "outputFolder", "change"), state.type).toBeUndefined();
      expect(settingsAction(state, context, "outputFolder", "reveal"), state.type).toBeUndefined();
    }
  });

  it("orders General as the icon's click, Shortcut, Notifications, Language, Appearance, Updates and About, headings moving with their groups", () => {
    const general = settingsView(idle, context).groups.filter((g) => g.tab === "general");
    expect(general.map((g) => g.id)).toEqual(["trayClick", "hotkey", "notifications", "language", "appearance", "updateChecks", "updates", "log", "about"]);
    expect(general.find((g) => g.id === "updateChecks")?.sectionHeading).toBe("Updates");
  });

  it("heads each section once, on its first row, in both languages", () => {
    const headings = (language: "en" | "zh-TW") => settingsView(idle, { ...context, language }).groups
      .filter((g) => g.sectionHeading).map((g) => [g.id, g.sectionHeading]);
    expect(headings("en")).toEqual([
      ["screen", "Source and output"], ["countdown", "Before recording"], ["videoQuality", "Video"],
      ["trayClick", "Controls and notifications"], ["language", "Language and appearance"], ["updateChecks", "Updates"], ["log", "Troubleshooting"],
    ]);
    expect(headings("zh-TW").map(([, heading]) => heading)).toEqual(["來源與輸出", "錄影開始前", "影像", "操作與通知", "語言與外觀", "更新", "疑難排解"]);
    expect(group(idle, context, "updates")?.label).toBe("Manual check");
  });
});

it("pages failure projections while preserving the total unread count", () => {
  const recordingResults = Array.from({ length: 120 }, (_, index) => ({
    id: "failure-" + index, occurredAt: "2026-09-28T00:00:00Z", code: "capture_failed" as const,
    detail: "", outcome: "empty" as const, acknowledged: false,
  }));
  const first = settingsView(idle, { ...context, recordingResults, historyLimit: 50 });
  expect(first.recordingResults).toHaveLength(50);
  expect(first.recordingResultsRemaining).toBe(70);
  expect(first.tabs.find(tab => tab.id === "failures")?.label).toContain("120");
  const second = settingsView(idle, { ...context, recordingResults, historyLimit: 100 });
  expect(second.recordingResults).toHaveLength(100);
  expect(second.recordingResults?.[0]).toBe(first.recordingResults?.[0]);
});


it("routes shortcut retry only while the failed registration can be changed", () => {
  const failed = { ...context, hotkey: { ...DEFAULT_HOTKEY, registered: false } };
  expect(settingsAction(idle, failed, "hotkey", "retryRegistration")).toBe("retryShortcuts");
  expect(settingsAction(idle, context, "hotkey", "retryRegistration")).toBeUndefined();
  for (const state of busy) expect(settingsAction(state, failed, "hotkey", "retryRegistration")).toBeUndefined();
  // The retry is the card's action, not a combination: its checked state is the action's, never a hotkey comparison.
  expect(settingsChecked(idle, failed, "hotkey", "retryRegistration")).toBe(false);
  expect(proposesHotkey("hotkey", "retryRegistration")).toBe(false);
  expect(proposesHotkey("hotkey", "off")).toBe(false);
  expect(proposesHotkey("hotkey", "CommandOrControl+Shift+K")).toBe(true);
  expect(proposesHotkey("language", "CommandOrControl+Shift+K")).toBe(false);
});

it("explains a Settings shortcut that is not registered, not only a retry button", () => {
  const failed = group(idle, { ...context, settingsShortcut: { kind: "failed", accelerator: "CommandOrControl+Alt+,", reason: "taken" } }, "hotkey");
  expect(failed?.actions?.map(action => action.id)).toEqual(["retryRegistration"]);
  expect(failed?.diagnostics).toEqual([expect.objectContaining({ heading: "The shortcut for RecordStuff is unavailable",
    reason: "Another app may be using ⌘⌥,." })]);
  const conflict = group(idle, { ...context, settingsShortcut: { kind: "conflict" } }, "hotkey");
  expect(conflict?.actions).toBeUndefined();
  expect(conflict?.diagnostics?.[0]?.reason).toBe("⌘⌥, is the recording shortcut, so it does not open Settings.");
  expect(group(idle, { ...context, settingsShortcut: { kind: "registered", accelerator: "CommandOrControl+Alt+," } }, "hotkey")?.diagnostics).toBeUndefined();
  expect(failed?.diagnostics?.[0]?.guidance).toBe("Open RecordStuff from the menu bar icon, or retry once the other app releases it.");
  const windows = { ...context, platform: "win32" as const, settingsShortcut: { kind: "failed" as const, accelerator: "CommandOrControl+Alt+,", reason: "taken" } };
  expect(group(idle, windows, "hotkey")?.diagnostics?.[0]?.guidance).toBe("Open RecordStuff from the system tray icon, or retry once the other app releases it.");
  expect(group(idle, { ...windows, language: "zh-TW" }, "hotkey")?.diagnostics?.[0]?.guidance).toBe("可從系統匣圖示開啟 RecordStuff，或待其他 App 釋放後重試。");
});

describe("the status card", () => {
  it("has nothing to say while ready, whatever the click and the shortcut: the page shows no card then", () => {
    for (const ctx of [context, { ...context, trayClick: "menu" as const }, { ...context, hotkey: { ...context.hotkey, registered: false } }, { ...context, platform: "win32" as const, language: "zh-TW" as const }]) {
      expect(settingsView(idle, ctx).status).toEqual({ tone: "ready", title: t("Ready to record", ctx.language), detail: "" });
    }
  });
  it("names the state like the tray while the lock hint explains it, leaving Stop and Cancel to the tray", () => {
    expect(busy.map((state) => settingsView(state, context).status)).toEqual([
      { tone: "busy", title: "Starting… Check for system permission prompts", detail: "" },
      { tone: "busy", title: "Recording starts in 2 s", detail: "" },
      { tone: "recording", title: "Recording", detail: "" },
      { tone: "busy", title: "Saving…", detail: "" },
    ]);
    expect(settingsView(idle, { ...context, quitting: true }).status).toEqual({ tone: "busy", title: "Quitting once the recording is saved or cleaned up…", detail: "" });
  });
  it("turns to attention for what stops the next recording, with the fix as its action", () => {
    expect(settingsView({ type: "needsPermission", needsRelaunch: false }, context).status).toMatchObject({ tone: "attention", action: { id: "permission", label: "Open System Settings" } });
    expect(settingsView({ type: "needsPermission", needsRelaunch: true }, context).status?.action?.id).toBe("relaunch");
    expect(settingsView({ type: "idle", outputDirUnavailable: true }, context).status).toMatchObject({ tone: "attention", title: "Output folder unavailable", action: { id: "folder" } });
    const gone = { ...context, display: { kind: "display" as const, id: "9", label: "Gone" } };
    // The way back, once there is a Primary display to go back to.
    expect(settingsView(idle, gone).status).toEqual({ tone: "attention", title: "Selected display is unavailable", detail: "" });
    const withPrimary = { ...gone, displays: [{ id: "1", label: "Built-in", logicalWidth: 1512, logicalHeight: 982, scaleFactor: 2, internal: true, primary: true }] };
    expect(settingsView(idle, withPrimary).status?.action).toEqual({ id: "primary", label: "Use Primary display" });
    expect(settingsAction(idle, withPrimary, "status", "primary")).toEqual({ setDisplay: { kind: "primary" } });
    expect(settingsAction(idle, withPrimary, "status", "folder")).toBeUndefined();
  });
  it("resolves only the offered fix to the tray's own action: never a start, a stop or anything while quitting", () => {
    expect(settingsAction({ type: "idle", outputDirUnavailable: true }, context, "status", "folder")).toBe("changeOutputDir");
    expect(settingsAction({ type: "needsPermission", needsRelaunch: false }, context, "status", "permission")).toBe("openPermissionSettings");
    expect(settingsAction({ type: "needsPermission", needsRelaunch: true }, context, "status", "relaunch")).toBe("relaunch");
    expect(settingsAction(idle, context, "status", "folder")).toBeUndefined();
    for (const state of [idle, ...busy]) for (const id of ["start", "stop", "cancel"]) expect(settingsAction(state, context, "status", id)).toBeUndefined();
    expect(settingsAction({ type: "idle", outputDirUnavailable: true }, { ...context, quitting: true }, "status", "folder")).toBeUndefined();
  });
  it("puts the running version under the credit", () => {
    expect(group(idle, { ...context, version: "1.3.0" }, "about")?.note).toBe("Version 1.3.0");
    expect(group(idle, { ...context, version: "1.3.0", language: "zh-TW" }, "about")?.note).toBe("版本 1.3.0");
    expect(group(idle, context, "about")).not.toHaveProperty("note");
  });
});

describe("the Video section's size estimate", () => {
  const retina = { ...context, displays: [{ id: "1", label: "Built-in", logicalWidth: 1512, logicalHeight: 982, scaleFactor: 2, internal: true, primary: true }] };
  it("states about how much a minute takes on the selected screen, following every Video choice", () => {
    expect(group(idle, retina, "frameRate")?.footnote).toBe("About 180 MB per minute at 3024 × 1964, 30 fps.");
    expect(group(idle, { ...retina, quality: { ...DEFAULT_QUALITY, resolutionCap: "1080p" } }, "frameRate")?.footnote)
      .toBe("About 54 MB per minute at 1662 × 1080, 30 fps.");
    expect(group(idle, { ...retina, quality: { ...DEFAULT_QUALITY, frameRate: 60 }, language: "zh-TW" }, "frameRate")?.footnote)
      .toBe("每分鐘約 700 MB（3024 × 1964、60 fps）。");
    // Windows records 30 fps whatever is stored, and the estimate says what it will record.
    expect(group(idle, { ...retina, platform: "win32", quality: { ...DEFAULT_QUALITY, frameRate: 60 } }, "frameRate")?.footnote).toContain("30 fps");
  });
  it("says nothing without a screen to measure", () => {
    expect(group(idle, context, "frameRate")).not.toHaveProperty("footnote");
    expect(group(idle, { ...retina, display: { kind: "display", id: "9", label: "Gone" } }, "frameRate")).not.toHaveProperty("footnote");
  });
});

describe("the Recordings tab", () => {
  const now = new Date(2026, 9, 4, 15, 0);
  const file = (name: string, recordedAt: Date, extra: Partial<RecordingFile> = {}): RecordingFile =>
    ({ id: `id-${name}`, path: `/tmp/recordings/${name}`, name, size: 176_000_000, recordedAt: recordedAt.getTime(), version: "v1", ...extra });
  const files = [
    file("2026-10-04 14-02-11.mp4", new Date(2026, 9, 4, 14, 2, 11), { duration: 83.4 }),
    file("Product demo.mp4", new Date(2026, 9, 3, 9, 30), { size: 2_200_000_000, duration: 3725 }),
  ];
  const library = (state: Partial<LibraryState>): AppContext => ({ ...context, now, library: { dir: "/tmp/recordings", loading: false, failed: false, files, ...state } });
  it("lists every video newest first with its day, time or name, length, size and id-only URLs", () => {
    const view = settingsView(idle, library({})).library!;
    expect(view.summary).toBe("2 recordings · 2.4 GB");
    expect(view.folder).toBe("~/recordings");
    expect(view.items).toEqual([
      { id: "id-2026-10-04 14-02-11.mp4", name: "2026-10-04 14-02-11.mp4", day: "Today", title: new Date(2026, 9, 4, 14, 2).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" }),
        duration: "1:23", size: "180 MB", thumbnail: "recordstuff-media://thumb/id-2026-10-04 14-02-11.mp4?v=v1", video: "recordstuff-media://video/id-2026-10-04 14-02-11.mp4?v=v1" },
      expect.objectContaining({ day: "Yesterday", title: "Product demo", duration: "1:02:05", size: "2.2 GB" }),
    ]);
    expect(settingsView(idle, { ...library({}), language: "zh-TW" }).library!.summary).toBe("2 個錄影・2.4 GB");
    expect(settingsView(idle, library({ files: [files[0]!] })).library!.summary).toBe("1 recording · 180 MB");
  });
  it("says it is loading or cannot read the folder instead of claiming it is empty", () => {
    expect(settingsView(idle, library({ loading: true, files: [] })).library).toEqual({ folder: "~/recordings", status: "Loading recordings…", items: [] });
    expect(settingsView(idle, library({ failed: true, files: [] })).library?.status).toBe("Could not read the output folder. Check the folder and its drive, or choose another folder.");
    expect(settingsView(idle, library({ files: [] })).library).toEqual({ folder: "~/recordings", items: [] });
    expect(settingsView(idle, context)).not.toHaveProperty("library");
  });
  it("resolves only listed ids and offered actions, even while recording", () => {
    const ctx = library({});
    expect(settingsAction(idle, ctx, "recordingFile:id-Product demo.mp4", "trash")).toEqual({ recordingFile: { id: "id-Product demo.mp4", action: "trash" } });
    expect(settingsAction(busy[2]!, ctx, "recordingFile:id-Product demo.mp4", "drag")).toEqual({ recordingFile: { id: "id-Product demo.mp4", action: "drag" } });
    expect(settingsAction(idle, ctx, "recordingFile:/etc/passwd", "open")).toBeUndefined();
    expect(settingsAction(idle, ctx, "recordingFile:id-Product demo.mp4", "delete")).toBeUndefined();
  });
  it("prints lengths as minutes and seconds, with hours from an hour", () => {
    expect([formatDuration(0), formatDuration(59.6), formatDuration(83), formatDuration(3725)]).toEqual(["0:00", "1:00", "1:23", "1:02:05"]);
  });
});

describe("the icon's left click (2026-10-04)", () => {
  it("is a menu in General, in both languages, whose ⓘ says the right click opens the menu", () => {
    expect(group(idle, context, "trayClick")).toMatchObject({ label: "Icon click", control: "menu", info: "A right click always opens the menu.",
      choices: [{ id: "menu", label: "Open the menu", checked: false }, { id: "record", label: "Start / stop recording", checked: true }] });
    expect(group(idle, { ...context, platform: "win32", language: "zh-TW" }, "trayClick")?.choices.map(c => c.label)).toEqual(["開啟選單", "開始／停止錄影"]);
    expect(settingsAction(idle, context, "trayClick", "toggle")).toBeUndefined();
  });
  it("tells how to cancel a countdown by the chosen click", () => {
    const menu = { ...context, trayClick: "menu" as const };
    expect(group(idle, menu, "countdown")?.info).toBe("Choose Cancel recording from the menu bar icon, or press the shortcut.");
    expect(group(idle, { ...menu, hotkey: { ...menu.hotkey, enabled: false } }, "countdown")?.info).toBe("Choose Cancel recording from the menu bar icon.");
    expect(group(idle, context, "countdown")?.info).toBe("Click the menu bar icon or press the shortcut to cancel.");
  });
});

describe("the menu's support items in RecordStuff (2026-10-04)", () => {
  it("gives Show log a row of its own under Troubleshooting, last before the credit, usable while recording", () => {
    const general = settingsView(idle, context).groups.filter(g => g.tab === "general").map(g => g.id);
    expect(general.slice(-2)).toEqual(["log", "about"]);
    expect(group(idle, context, "log")).toMatchObject({ label: "Log file", kind: "actions", sectionHeading: "Troubleshooting", choices: [{ id: "show", label: "Show log" }] });
    expect(group(idle, { ...context, language: "zh-TW" }, "log")).toMatchObject({ label: "記錄檔（log）", sectionHeading: "疑難排解", choices: [{ label: "顯示 log" }] });
    expect(settingsAction(busy[2]!, context, "log", "show")).toBe("revealLog");
    expect(group(idle, context, "about")?.choices.map(c => c.id)).toEqual(["website", "source"]);
  });
});
