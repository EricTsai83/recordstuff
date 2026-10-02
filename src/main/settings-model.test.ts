import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import { DEFAULT_HOTKEY, SETTINGS_SHORTCUT } from "../shared/hotkey";

/** Former defaults and suggestions: valid custom values, no longer offered. */
const LEGACY_HOTKEYS = ["CommandOrControl+Alt+Shift+R", "CommandOrControl+Shift+R", "CommandOrControl+Alt+R"];
import type { RecordingState } from "../shared/state";
import { translate as t } from "../shared/i18n";
import { failureDay, failureTime, proposesHotkey, settingsAction, settingsChecked, settingsView } from "./settings-model";
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
  it("titles the capture warning by what it is about and joins the notifications note as sentences in each language", () => {
    const zh = { ...context, language: "zh-TW" as const, captureWarning: "無法確認解析度上限。" };
    expect(group(idle, zh, "screen")?.diagnostics?.at(-1)).toMatchObject({ kind: "history", heading: "錄影解析度" });
    expect(group(idle, { ...context, captureWarning: "x" }, "screen")?.diagnostics?.at(-1)?.heading).toBe("Recording resolution");
    expect(group(idle, zh, "notifications")?.note).toBe(
      `${t("Shows a notification when a recording is saved or an error occurs.", "zh-TW")}${t("macOS must also allow RecordStuff in System Settings → Notifications.", "zh-TW")}`);
    expect(group(idle, context, "notifications")?.note).toBe(
      "Shows a notification when a recording is saved or an error occurs. macOS must also allow RecordStuff in System Settings → Notifications.");
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
      "hotkey",
      "notifications",
      "language",
      "appearance",
      "updateChecks",
      "updates",
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
  });

  it("never leaks an action to the renderer", () => {
    for (const entry of settingsView(idle, context).groups) {
      for (const choice of entry.choices) expect(Object.keys(choice).sort()).toEqual(["checked", "enabled", "id", "label"]);
    }
  });

  it("translates titles, hints and labels, and reflects a committed language", () => {
    const view = settingsView(idle, { ...context, language: "zh-TW" });
    expect(view.language).toBe("zh-TW");
    expect(view.title).toBe("RecordStuff - 設定");
    expect(view.hint).toBe("");
    expect(group(idle, { ...context, language: "zh-TW" }, "videoQuality")?.label).toBe("影像品質");
    expect(settingsView(idle, context).title).toBe("RecordStuff - Settings");
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
      diagnostics: [{ kind: "current", heading: "Shortcut unavailable", reason: "Unavailable: another app may be using this shortcut.", guidance: "Recording is still available from the menu. Choose another shortcut." }],
    });
    expect(checked(idle, conflicted, "hotkey")).toBe(DEFAULT_HOTKEY.accelerator);
    expect(group(idle, { ...conflicted, language: "zh-TW" }, "hotkey")?.diagnostics?.[0]?.reason).toBe("無法使用：這個快捷鍵可能被其他 App 佔用。");
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

describe("recording locks every preference except the language", () => {
  it.each(busy)("$type", (state) => {
    const view = settingsView(state, context);
    expect(view.hint).toBe("Recording in progress. Only language and appearance can change until it ends.");
    for (const entry of view.groups) expect(entry.enabled, entry.id).toBe(["language", "appearance", "about"].includes(entry.id));
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
    expect(view.hint).toBe("Quitting… RecordStuff quits once the recording is saved or cleaned up.");
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
    expect(countdown).toMatchObject({ label: "Countdown", control: "segmented", tab: "recording", section: "recording", noteKind: "explanation" });
    expect(countdown.choices.map((c) => [c.id, c.label, c.checked])).toEqual([["0", "Off", false], ["3", "3 s", true], ["5", "5 s", false], ["10", "10 s", false]]);
    expect(countdown.note).toContain("top-right of the recorded screen");
    const zh = group(idle, { ...context, language: "zh-TW" }, "countdown")!;
    expect([zh.label, ...zh.choices.map((c) => c.label)]).toEqual(["倒數", "關閉", "3 秒", "5 秒", "10 秒"]);
    expect(zh.note).toContain("右上角");
    expect(checked(idle, { ...context, countdown: 0 }, "countdown")).toBe("0");
  });

  it("names the shortcut as a way to cancel only while it works", () => {
    expect(group(idle, context, "countdown")!.note).toContain("press the shortcut");
    for (const hotkey of [{ ...context.hotkey, enabled: false }, { ...context.hotkey, registered: false }]) {
      expect(group(idle, { ...context, hotkey }, "countdown")!.note).toBe(
        "Before recording starts, the digits appear at the top-right of the recorded screen. Click the menu bar icon to cancel.");
      expect(group(idle, { ...context, hotkey, language: "zh-TW" }, "countdown")!.note).toBe("開始錄製前，數字會顯示在被錄製螢幕的右上角。按一下選單列圖示即可取消。");
    }
  });

  it("resolves each choice to setCountdown and is locked while starting, counting down, recording or saving", () => {
    for (const value of [0, 3, 5, 10] as const) expect(settingsAction(idle, context, "countdown", String(value))).toEqual({ setCountdown: value });
    expect(settingsAction(idle, context, "countdown", "4")).toBeUndefined();
    for (const state of [{ type: "starting" }, { type: "countdown", remaining: 2 }, { type: "recording", startedAt: "x" }, { type: "stopping" }] as RecordingState[]) {
      expect(group(state, context, "countdown")?.enabled, state.type).toBe(false);
      expect(settingsAction(state, context, "countdown", "5"), state.type).toBeUndefined();
    }
    expect(settingsView({ type: "countdown", remaining: 2 }, context).hint).toBe("Recording in progress. Only language and appearance can change until it ends.");
    expect(settingsChecked(idle, { ...context, countdown: 10 }, "countdown", "10")).toBe(true);
  });
});

describe("countdown sound (plan 046)", () => {
  it("is a switch directly after Countdown with the note that it is not recorded, in both languages", () => {
    const sound = group(idle, context, "countdownSound")!;
    expect(sound).toMatchObject({ label: "Countdown sound", control: "switch", tab: "recording", section: "recording", noteKind: "explanation", enabled: true });
    expect(sound.choices.map((c) => [c.id, c.label, c.checked])).toEqual([["on", "On", true], ["off", "Off", false]]);
    expect(sound.note).toBe("A short tick plays with each digit. It stops before recording starts and is not recorded.");
    const zh = group(idle, { ...context, language: "zh-TW" }, "countdownSound")!;
    expect([zh.label, ...zh.choices.map((c) => c.label)]).toEqual(["倒數音效", "開啟", "關閉"]);
    expect(zh.note).toContain("不會被錄進去");
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
    expect(off).toContain(t("Notifications are off. Recording failures remain visible in the menu bar and in Settings → Failures.", "en"));
    // The macOS caveat is about a permission the user did not choose; it would
    // only confuse the reading of a switch the user did choose to turn off.
    expect(off).not.toContain("System Settings");
    expect(group(idle, { ...context, notifications: false }, "notifications")?.choices.find((c) => c.checked)?.id).toBe("off");
  });

  /** Claiming an OS state the app cannot read would be worse than saying nothing. */
  it("names the macOS recovery path in the note without reporting a permission state", () => {
    const note = group(idle, context, "notifications")?.note ?? "";
    expect(note).toContain("System Settings");
    expect(note).not.toMatch(/denied|authoriz/i);
    expect(group(idle, { ...context, platform: "win32" }, "notifications")?.note).not.toContain("System Settings");
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
      expect(screen.note).not.toContain("unavailable");
      expect(settingsAction(idle, ctx, "screen", "primary")).toEqual({ setDisplay: { kind: "primary" } });
    }
  });
  it("keeps last source failure visible with notifications off without calling it disconnected", () => {
    const ctx = { ...selected, notifications: false, displayFailure: "source_missing" as const };
    expect(group(idle, ctx, "screen")?.diagnostics?.[0]).toMatchObject({ kind: "history", heading: "Last recording failure" });
    expect(group(idle, ctx, "screen")?.diagnostics?.[0]?.reason).toContain("Display is connected");
    expect(group(idle, ctx, "screen")?.recovery).toBeUndefined();
    expect(group(idle, ctx, "screen")?.choices.find((c) => c.checked)?.enabled).toBe(true);
  });
});


it("declares presentation without changing choice identities, and authorizes only fixed links", () => {
  const groups = settingsView(idle, context).groups;
  expect(groups.map(g => [g.id, g.control, g.section])).toEqual([
    ["screen", "menu", "recording"], ["outputFolder", "menu", "recording"], ["countdown", "segmented", "recording"], ["countdownSound", "switch", "recording"],
    ["videoQuality", "segmented", "recording"],
    ["resolutionCap", "menu", "recording"], ["frameRate", "menu", "recording"],
    ["hotkey", "menu", "hotkey"], ["notifications", "switch", "notifications"],
    ["language", "segmented", "language"], ["appearance", "menu", "appearance"],
    ["updateChecks", "switch", "updates"], ["updates", "menu", "updates"], ["about", "menu", "about"],
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
  expect(settingsView(idle, done).recordingResults?.[0]?.outcome).toContain("may not be playable");
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
  expect(view.guidance).toContain("previous recording failure");
  expect(settingsAction(idle, ctx, "recordingResult:old", "relaunch")).toBeUndefined();
  expect(settingsAction({ type: "needsPermission", needsRelaunch: true }, ctx, "recordingResult:old", "relaunch")).toBeDefined();
});

it("retains audio-device guidance for a restored Windows audio failure", () => {
  const result = { id: "old-audio", occurredAt: "2026-09-25T00:00:00Z", code: "no_audio_track" as const,
    detail: "", outcome: "empty" as const, acknowledged: false, restored: true };
  const ctx = { ...context, platform: "win32" as const, recordingResults: [result] };
  expect(settingsView(idle, ctx).recordingResults?.[0]?.guidance).toContain("audio devices");
  expect(settingsAction(idle, ctx, "recordingResult:old-audio", "relaunch")).toBeUndefined();
});

it("gives accurate persistence guidance, retries only what retrying can fix and shows saving/loading state", () => {
  const base = { id: "f", occurredAt: "2026-09-25T00:00:00Z", code: "disk_full" as const, detail: "", outcome: "empty" as const, acknowledged: false };
  const row = (extra: object, language: "en" | "zh-TW" = "en", historyLoading = false) =>
    settingsView(idle, { ...context, language, historyLoading, recordingResults: [{ ...base, ...extra }] });
  const io = row({ persistenceFailed: "io" }).recordingResults![0]!;
  expect(io.persistenceWarning).toContain("retries automatically");
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
  it("always offers a third tab after General, counting unread failures in its label and accessible name", () => {
    expect(settingsView(idle, context).tabs).toEqual([
      { id: "recording", label: "Recording settings" }, { id: "general", label: "General" }, { id: "failures", label: "Failures", accessibleLabel: "Recording failures" },
    ]);
    const results = [{ ...base, id: "a", acknowledged: false }, { ...base, id: "b", acknowledged: false }, { ...base, id: "c", acknowledged: true }];
    expect(settingsView(idle, { ...context, recordingResults: results }).tabs[2]).toEqual({
      id: "failures", label: "Failures (2)", accessibleLabel: "Recording failures, 2 unread",
    });
    expect(settingsView(idle, { ...context, language: "zh-TW", recordingResults: results }).tabs.map((tab) => tab.label))
      .toEqual(["錄影", "一般", "失敗紀錄（2）"]);
    expect(settingsView(idle, { ...context, language: "zh-TW", recordingResults: results }).tabs[2]!.accessibleLabel).toBe("失敗紀錄，2 筆未確認");
    expect(settingsView(idle, { ...context, recordingResults: [results[2]!] }).tabs[2]).toEqual({ id: "failures", label: "Failures", accessibleLabel: "Recording failures" });
  });

  it("names the day a row is grouped under: Today, Yesterday, then the date with the year only for an earlier year", () => {
    const now = new Date(2026, 8, 28, 9, 30);
    expect(failureDay(new Date(2026, 8, 28, 0, 5), now, "en")).toBe("Today");
    expect(failureDay(new Date(2026, 8, 27, 23, 55), now, "en")).toBe("Yesterday");
    expect(failureDay(new Date(2026, 8, 24, 12), now, "en")).toBe("September 24");
    expect(failureDay(new Date(2025, 11, 31, 12), now, "en")).toBe("December 31, 2025");
    expect(failureDay(new Date(2026, 8, 28, 0, 5), now, "zh-TW")).toBe("今天");
    expect(failureDay(new Date(2026, 8, 27, 12), now, "zh-TW")).toBe("昨天");
    expect(failureDay(new Date(2026, 8, 24, 12), now, "zh-TW")).toBe("9月24日");
    expect(failureDay(new Date(2025, 11, 31, 12), now, "zh-TW")).toBe("2025年12月31日");
    // Across a month boundary, Yesterday is the previous calendar day.
    expect(failureDay(new Date(2026, 8, 30, 22), new Date(2026, 9, 1, 1), "en")).toBe("Yesterday");
  });

  it("gives each row a short local time, its day, the file name and the full path, without a repeated heading", () => {
    expect(failureTime(new Date(2026, 8, 28, 14, 5), "en")).toBe("2:05 PM");
    expect(failureTime(new Date(2026, 8, 28, 14, 5), "zh-TW")).toBe("下午2:05");
    const occurredAt = new Date(2026, 8, 28, 14, 5).toISOString();
    const row = settingsView(idle, { ...context, now: new Date(2026, 8, 28, 20), recordingResults: [{ ...base, id: "p", occurredAt, acknowledged: false,
      outcome: "partial", partialPath: "/Users/me/Movies/RecordStuff/2026-09-28 14-05-00.recording.mp4" }] }).recordingResults![0]!;
    expect(row).toMatchObject({ day: "Today", time: "2:05 PM", fileName: "2026-09-28 14-05-00.recording.mp4",
      file: "/Users/me/Movies/RecordStuff/2026-09-28 14-05-00.recording.mp4" });
    expect(row).not.toHaveProperty("heading");
  });
});

describe("Output folder in Settings → Recording (plan 048)", () => {
  it("shows the path after Screen with Change… and Show in Finder through the tray's handlers", () => {
    const folder = group(idle, context, "outputFolder")!;
    expect(folder).toMatchObject({ label: "Output folder", kind: "actions", tab: "recording", section: "recording", enabled: true, note: "~/recordings" });
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

  it("orders General as Shortcut, Notifications, Language, Appearance, Updates and About, headings moving with their groups", () => {
    const general = settingsView(idle, context).groups.filter((g) => g.tab === "general");
    expect(general.map((g) => g.id)).toEqual(["hotkey", "notifications", "language", "appearance", "updateChecks", "updates", "about"]);
    expect(general.find((g) => g.id === "updateChecks")?.sectionHeading).toBe("Updates");
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
  expect(failed?.diagnostics).toEqual([expect.objectContaining({ heading: "Settings shortcut unavailable",
    reason: "⌘⌥, could not be registered to open Settings; another app may use it." })]);
  const conflict = group(idle, { ...context, settingsShortcut: { kind: "conflict" } }, "hotkey");
  expect(conflict?.actions).toBeUndefined();
  expect(conflict?.diagnostics?.[0]?.reason).toBe("⌘⌥, is the recording shortcut, so it does not open Settings.");
  expect(group(idle, { ...context, settingsShortcut: { kind: "registered", accelerator: "CommandOrControl+Alt+," } }, "hotkey")?.diagnostics).toBeUndefined();
});
