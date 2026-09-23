import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import { DEFAULT_HOTKEY, HOTKEY_PRESETS } from "../shared/hotkey";
import type { RecordingState } from "../shared/state";
import { translate as t } from "../shared/i18n";
import { settingsAction, settingsChecked, settingsView } from "./settings-model";
import type { AppContext } from "./ui-model";

const context: AppContext = {
  platform: "darwin",
  outputDir: "/tmp/recordings",
  homeDir: "/tmp",
  quality: DEFAULT_QUALITY,
  language: "en",
  hotkey: { ...DEFAULT_HOTKEY, registered: true },
  updates: { state: { kind: "idle" }, enabled: true },
  notifications: true,
  displays: [], display: { kind: "primary" },
};
const idle: RecordingState = { type: "idle" };
const busy: RecordingState[] = [
  { type: "starting" },
  { type: "recording", startedAt: "2026-09-20T00:00:00Z" },
  { type: "stopping" },
];
const group = (state: RecordingState, ctx: AppContext, id: string) =>
  settingsView(state, ctx).groups.find((candidate) => candidate.id === id);
const checked = (state: RecordingState, ctx: AppContext, id: string) =>
  group(state, ctx, id)?.choices.find((choice) => choice.checked)?.id;

describe("settingsView", () => {
  it("offers every preference with a stable id and exactly one committed choice", () => {
    const view = settingsView(idle, context);
    expect(view.groups.map((entry) => entry.id)).toEqual([
      "screen",
      "videoQuality",
      "resolutionCap",
      "frameRate",
      "hotkey",
      "updateChecks",
      "updates",
      "notifications",
      "language",
    ]);
    for (const entry of view.groups) {
      expect(entry.choices.filter((choice) => choice.checked), entry.id).toHaveLength(entry.kind === "actions" ? 0 : 1);
      expect(entry.enabled, entry.id).toBe(true);
    }
    expect(checked(idle, context, "videoQuality")).toBe("standard");
    expect(checked(idle, context, "resolutionCap")).toBe("source");
    expect(checked(idle, context, "frameRate")).toBe("30");
    expect(checked(idle, context, "hotkey")).toBe(HOTKEY_PRESETS[0]);
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
    expect(view.title).toBe("設定");
    expect(view.hint).toBe("變更會自動儲存。");
    expect(group(idle, { ...context, language: "zh-TW" }, "videoQuality")?.label).toBe("影像品質");
    expect(settingsView(idle, context).title).toBe("Settings");
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
      note: "Unavailable: another app is using this shortcut.",
    });
    expect(checked(idle, conflicted, "hotkey")).toBe(HOTKEY_PRESETS[0]);
    expect(group(idle, { ...conflicted, language: "zh-TW" }, "hotkey")?.note).toBe("無法使用：這個快捷鍵被其他 App 佔用。");
    // A registered shortcut needs no warning at all.
    expect(group(idle, context, "hotkey")).not.toHaveProperty("note");
  });

  it("checks Off while disabled and keeps the remembered accelerator", () => {
    const off = { ...context, hotkey: { enabled: false, accelerator: HOTKEY_PRESETS[1], registered: false } };
    expect(checked(idle, off, "hotkey")).toBe("off");
    expect(group(idle, off, "hotkey")).not.toHaveProperty("note");
    expect(settingsAction(idle, off, "hotkey", "off")).toEqual({
      setHotkey: { enabled: false, accelerator: HOTKEY_PRESETS[1] },
    });
  });
});

describe("recording locks every preference except the language", () => {
  it.each(busy)("$type", (state) => {
    const view = settingsView(state, context);
    expect(view.hint).toBe("Recording in progress. Recording settings are locked.");
    for (const entry of view.groups) expect(entry.enabled, entry.id).toBe(entry.id === "language");
    expect(settingsAction(state, context, "language", "zh-TW")).toEqual({ setLanguage: "zh-TW" });
    for (const [group, choice] of [["videoQuality", "high"], ["frameRate", "60"], ["hotkey", "off"], ["updateChecks", "off"]]) {
      expect(settingsAction(state, context, group, choice), group).toBeUndefined();
    }
  });

  it("needsPermission is not a recording: everything stays editable", () => {
    const state: RecordingState = { type: "needsPermission", needsRelaunch: false };
    expect(settingsView(state, context).hint).toBe("Changes are saved automatically.");
    expect(settingsAction(state, context, "frameRate", "60")).toEqual({ setQuality: { frameRate: 60 } });
  });
});

describe("settingsAction only resolves what is offered right now", () => {
  it("maps each id to the action the tray would have raised", () => {
    expect(settingsAction(idle, context, "videoQuality", "economy")).toEqual({ setQuality: { videoQuality: "economy" } });
    expect(settingsAction(idle, context, "resolutionCap", "1080p")).toEqual({ setQuality: { resolutionCap: "1080p" } });
    expect(settingsAction(idle, context, "frameRate", "60")).toEqual({ setQuality: { frameRate: 60 } });
    expect(settingsAction(idle, context, "updateChecks", "off")).toEqual({ setUpdateChecks: false });
    expect(settingsAction(idle, context, "hotkey", HOTKEY_PRESETS[1])).toEqual({
      setHotkey: { enabled: true, accelerator: HOTKEY_PRESETS[1] },
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
    ctx.updates.state = { kind: "current", checkedAt: 1234567890000 };
    expect(group(idle, ctx, "updates")?.note).toContain(new Date(1234567890000).toLocaleString("en"));
    expect(settingsAction(idle, ctx, "updates", "open")).toBeUndefined();
  });
  it("places quality controls in Recording", () => {
    expect(settingsView(idle, context).groups.filter(g => g.tab === "recording").map(g => g.id)).toEqual(["screen", "videoQuality", "resolutionCap", "frameRate"]);
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
    expect(off).toContain(t("Notifications are off. An interrupted or unsaved recording will not tell you; check the output folder to confirm a recording was saved.", "en"));
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
      expect(screen.note).toContain("Selected display is unavailable");
      expect(settingsAction(idle, ctx, "screen", "primary")).toEqual({ setDisplay: { kind: "primary" } });
    }
  });
  it("keeps last source failure visible with notifications off without calling it disconnected", () => {
    const ctx = { ...selected, notifications: false, displayFailure: "source_missing" as const };
    expect(group(idle, ctx, "screen")?.note).toContain("Last display failure: Display is connected");
    expect(group(idle, ctx, "screen")?.choices.find((c) => c.checked)?.enabled).toBe(true);
  });
});
