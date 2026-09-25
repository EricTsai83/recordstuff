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
      "notifications",
      "updateChecks",
      "updates",
      "language",
      "appearance",
      "about",
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
    expect(view.title).toBe("RecordStuff - 設置");
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
      diagnostics: [{ kind: "current", heading: "Shortcut unavailable", reason: "Unavailable: another app is using this shortcut.", guidance: "Recording is still available from the menu. Choose another shortcut." }],
    });
    expect(checked(idle, conflicted, "hotkey")).toBe(HOTKEY_PRESETS[0]);
    expect(group(idle, { ...conflicted, language: "zh-TW" }, "hotkey")?.diagnostics?.[0]?.reason).toBe("無法使用：這個快捷鍵被其他 App 佔用。");
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
    expect(off).toContain(t("Notifications are off. Recording failures remain visible in the menu bar and Recording failures.", "en"));
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
    ["screen", "menu", "recording"], ["videoQuality", "segmented", "recording"],
    ["resolutionCap", "menu", "recording"], ["frameRate", "menu", "recording"],
    ["hotkey", "menu", "hotkey"], ["notifications", "switch", "notifications"],
    ["updateChecks", "switch", "updates"], ["updates", "menu", "updates"],
    ["language", "segmented", "language"], ["appearance", "menu", "appearance"], ["about", "menu", "about"],
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
  }
});


it("offers one recommended shortcut and only the currently saved custom value", () => {
  const recommended = DEFAULT_HOTKEY.accelerator;
  const choices = group(idle, context, "hotkey")!.choices;
  expect(choices.map(c => c.id)).toEqual([recommended, "off"]);
  expect(choices[0]!.label).toBe("Recommended: ⌘⇧1");
  expect(group(idle, { ...context, language: "zh-TW" }, "hotkey")!.choices[0]!.label).toBe("建議：⌘⇧1");
  for (const accelerator of [...HOTKEY_PRESETS.slice(1), "Control+Shift+F20"]) {
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

it("offers result actions by exact failure identity with recording and cleanup locks", () => {
  const result = { id: "failure-1", occurredAt: "2026-09-24T12:00:00Z", code: "disk_full" as const,
    detail: "ENOSPC", outcome: "pending" as const, acknowledged: false };
  const ctx = { ...context, notifications: false, recordingResults: [result] };
  expect(settingsView(idle, ctx).recordingResults?.[0]?.pending).toBe(true);
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
  const result = { id: "old", occurredAt: "2026-09-25T00:00:00Z", code: "permission_needs_relaunch" as const,
    detail: "", outcome: "empty" as const, acknowledged: true, restored: true, persistenceFailed: "io" as const };
  const ctx = { ...context, platform: "darwin" as const, recordingResults: [result] };
  const view = settingsView(idle, ctx).recordingResults![0]!;
  expect(view.actions.find(a => a.id === "retry")).toMatchObject({ label: "Retry saving reminder", enabled: true });
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
