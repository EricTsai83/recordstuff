import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../../shared/quality";
import { DEFAULT_HOTKEY, SETTINGS_SHORTCUT } from "../../shared/hotkey";

/** Former defaults and suggestions: valid custom values, no longer offered. */
const LEGACY_HOTKEYS = ["CommandOrControl+Alt+Shift+R", "CommandOrControl+Shift+R", "CommandOrControl+Alt+R"];
import type { RecordingState } from "../../shared/state";
import { translate as t } from "../../shared/i18n";
import { dayHeading, shortTime, proposesHotkey, settingsAction, settingsChecked, settingsView } from "./settings-model";
import type { LibraryState, RecordingFile } from "../library/recordings-library";
import type { AppContext } from "../app/ui-model";

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
  it("offers data cleanup only when capture is settled, refuses forged and quitting requests, and translates its scope", () => {
    expect(settingsAction(idle, context, "localData", "clear")).toBe("clearAppData");
    expect(settingsAction({ type: "needsPermission", needsRelaunch: false }, context, "localData", "clear")).toBe("clearAppData");
    for (const state of busy) {
      expect(group(state, context, "localData")?.enabled).toBe(false);
      expect(settingsAction(state, context, "localData", "clear")).toBeUndefined();
    }
    expect(settingsAction(idle, { ...context, quitting: true }, "localData", "clear")).toBeUndefined();
    expect(settingsAction(idle, context, "localData", "deleteRecordings")).toBeUndefined();
    const zh = group(idle, { ...context, language: "zh-TW" }, "localData")!;
    expect(zh.choices[0]?.label).toBe("清除並結束…");
    expect(zh.note ?? zh.info).toContain("錄影檔會保留");
  });
  it("puts the macOS notification permission behind the ⓘ", () => {
    const zh = { ...context, language: "zh-TW" as const };
    expect(group(idle, zh, "notifications")).toMatchObject({ info: t("macOS must also allow RecordStuff in System Settings → Notifications.", "zh-TW") });
    expect(group(idle, zh, "notifications")?.note).toBeUndefined();
    expect(group(idle, context, "notifications")?.info).toBe("macOS must also allow RecordStuff in System Settings → Notifications.");
    // Off: the same help trigger explains where failures remain; the permission no longer matters.
    const off = group(idle, { ...context, notifications: false }, "notifications")!;
    expect(off.note).toBeUndefined();
    expect(off.info).toBe("Failures still appear in the menu bar and the Troubleshooting tab.");
    expect(group(idle, { ...context, platform: "win32" }, "notifications")).not.toHaveProperty("info");
    expect(group(idle, { ...context, platform: "win32" }, "notifications")).not.toHaveProperty("note");
    // Windows has a system tray, not a menu bar (plan 064).
    expect(group(idle, { ...context, platform: "win32", notifications: false }, "notifications")?.info).toBe("Failures still appear in the system tray and the Troubleshooting tab.");
    expect(group(idle, { ...context, platform: "win32", notifications: false, language: "zh-TW" }, "notifications")?.info).toBe("失敗仍會顯示在系統匣與「疑難排解」分頁。");
    // Only status notes stay visible; the remaining explanations sit behind an ⓘ.
    expect(group(idle, context, "screen")).not.toHaveProperty("note");
    expect(group(idle, context, "videoQuality")?.info).toBe("Higher quality keeps more detail but makes larger files.");
    expect(group(idle, context, "resolutionCap")?.info).toBe("Scales larger screens down, keeping the aspect ratio. Smaller ones are not enlarged.");
  });
  it("offers every preference with a stable id and exactly one committed choice", () => {
    const view = settingsView(idle, context);
    expect(view.groups.map((entry) => entry.id)).toEqual([
      "screen",
      "hideSystemUi",
      "outputFolder",
      "fileName",
      "countdown",
      "countdownSound",
      "microphone",
      "microphoneDevice",
      "systemAudio",
      "systemGain",
      "studioControls",
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
      // Keyboard Shortcuts (plan 073): read-only lists, one per category.
      "shortcutList:global",
      "shortcutList:window",
      "shortcutList:recordings",
      "shortcutList:player",
      "shortcutList:fullScreen",
      "log",
      "localData",
      "about",
    ]);
    for (const entry of view.groups) {
      expect(entry.choices.filter((choice) => choice.checked), entry.id).toHaveLength(entry.kind === "actions" || entry.kind === "shortcutList" ? 0 : 1);
      // The input device waits for the microphone's switch, which is off by default (plan 074); the Recording Studio's
      // mutes for a recording (plan 075, D19).
      expect(entry.enabled, entry.id).toBe(entry.id !== "microphoneDevice" && entry.id !== "systemAudio");
    }
    expect(checked(idle, context, "countdown")).toBe("3");
    expect(checked(idle, context, "countdownSound")).toBe("on");
    expect(checked(idle, context, "hideSystemUi")).toBe("off");
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

  it("offers hiding the menu bar and Dock on macOS, locked while recording, and shows why Windows cannot (plan 076, D6)", () => {
    const row = group(idle, context, "hideSystemUi")!;
    expect(row).toMatchObject({ label: "Hide menu bar and Dock", control: "switch", tab: "recording", section: "source", enabled: true });
    expect(row.info).toBe("Recordings leave out the menu bar, the Dock, desktop icons and widgets; you still see them. A menu you open is still recorded, as part of its app.");
    expect(checked(idle, { ...context, hideSystemUi: true }, "hideSystemUi")).toBe("on");
    expect(settingsAction(idle, context, "hideSystemUi", "on")).toEqual({ setHideSystemUi: true });
    expect(settingsAction(idle, { ...context, hideSystemUi: true }, "hideSystemUi", "off")).toEqual({ setHideSystemUi: false });
    for (const state of busy) {
      expect(group(state, context, "hideSystemUi")?.enabled, state.type).toBe(false);
      expect(settingsAction(state, context, "hideSystemUi", "on"), state.type).toBeUndefined();
    }
    expect(group(idle, { ...context, language: "zh-TW" }, "hideSystemUi")?.label).toBe("隱藏選單列與 Dock");

    const windows = { ...context, platform: "win32" as const, hideSystemUi: true };
    expect(group(idle, windows, "hideSystemUi")).toMatchObject({ label: "Hide taskbar", enabled: false,
      note: "Windows cannot leave the taskbar out of a recording." });
    expect(checked(idle, windows, "hideSystemUi")).toBe("off");
    expect(settingsAction(idle, windows, "hideSystemUi", "on")).toBeUndefined();
    expect(group(idle, { ...windows, language: "zh-TW" }, "hideSystemUi")?.note).toBe("Windows 無法把工作列排除在錄影之外。");
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
      .toEqual(["source", "source", "source", "source", "countdown", "countdown", "audio", "audio", "video", "video", "video"]);
  });
});

describe("camera (plan 075)", () => {
  const on = (camera: Partial<NonNullable<AppContext["camera"]>> = {}): AppContext =>
    ({ ...context, camera: { enabled: true, available: true, access: "granted", ...camera } });

  it("is not shown until it is available, and then is a switch, off by default, in the Recording tab's Camera section", () => {
    expect(group(idle, context, "camera")).toBeUndefined();
    expect(group(idle, { ...context, camera: { enabled: true, available: false } }, "camera")).toBeUndefined();
    const row = group(idle, on({ enabled: false }), "camera")!;
    expect(row).toMatchObject({ label: "Camera", control: "switch", tab: "recording", section: "camera", sectionHeading: "Camera" });
    expect(checked(idle, on({ enabled: false }), "camera")).toBe("off");
    expect(checked(idle, on(), "camera")).toBe("on");
    expect(settingsAction(idle, on({ enabled: false }), "camera", "on")).toEqual({ setCamera: true });
    expect(settingsAction(idle, on(), "camera", "off")).toEqual({ setCamera: false });
    expect(group(idle, { ...on(), language: "zh-TW" }, "camera")).toMatchObject({ label: "相機", sectionHeading: "相機" });
  });

  it("is locked while a session runs", () => {
    for (const state of busy) {
      expect(group(state, on(), "camera")?.enabled, state.type).toBe(false);
      expect(settingsAction(state, on(), "camera", "off"), state.type).toBeUndefined();
    }
  });

  it("shows a macOS denial with the pane that changes it, only while the switch is on", () => {
    const denied = group(idle, on({ access: "denied" }), "camera")!;
    expect(denied.diagnostics).toEqual([expect.objectContaining({ kind: "current", heading: "Camera access is off",
      guidance: "Allow RecordStuff in System Settings → Privacy & Security → Camera, or turn Camera off." })]);
    expect(denied.actions).toEqual([expect.objectContaining({ id: "openSettings", label: "Open camera settings…" })]);
    expect(settingsAction(idle, on({ access: "denied" }), "camera", "openSettings")).toBe("openCameraSettings");
    expect(group(idle, on({ access: "restricted" }), "camera")?.diagnostics).toHaveLength(1);
    expect(group(idle, on({ enabled: false, access: "denied" }), "camera")).not.toHaveProperty("diagnostics");
    expect(group(idle, on(), "camera")).not.toHaveProperty("diagnostics");
    expect(group(idle, on(), "camera")).not.toHaveProperty("actions");
    expect(group(idle, on({ access: "not-determined" }), "camera")).toMatchObject({ noteKind: "status",
      note: "macOS asks for camera access when you next record." });
    expect(group(idle, { ...on({ access: "denied" }), language: "zh-TW" }, "camera")?.diagnostics?.[0]?.guidance).toContain("隱私權與安全性 → 相機");
  });

  it("names Windows's camera privacy page while it is on there, which has no status to read", () => {
    const windows = { ...context, platform: "win32" as const, camera: { enabled: true, available: true } };
    const row = group(idle, windows, "camera")!;
    expect(row.note).toContain("Settings → Privacy & security → Camera");
    expect(row).not.toHaveProperty("diagnostics");
    expect(settingsAction(idle, windows, "camera", "openSettings")).toBe("openCameraSettings");
    expect(group(idle, { ...windows, camera: { enabled: false, available: true } }, "camera")).not.toHaveProperty("note");
  });
});

describe("the camera's rows (plan 075, step 7)", () => {
  const layout = { width: 0.2, height: 0.2, rounding: 1, mirror: false, positions: [] };
  const devices = [{ id: "built-in", name: "FaceTime HD Camera", default: true }, { id: "iphone", name: "iPhone Camera", default: false }];
  const on = (camera: Partial<NonNullable<AppContext["camera"]>> = {}): AppContext =>
    ({ ...context, camera: { enabled: true, available: true, access: "granted", layout, devices, ...camera } });
  const ids = (ctx: AppContext, state = idle) => settingsView(state, ctx).groups.filter((g) => g.section === "camera").map((g) => g.id);
  const studio = (ctx: AppContext, state = idle) => settingsView(state, ctx).groups.filter((g) => g.tab === "studio").map((g) => g.id);

  it("follow the switch: the device in Recording settings with the way to the Studio, the shape in the Studio (D19)", () => {
    expect(ids(on())).toEqual(["camera", "cameraDevice", "cameraStudio"]);
    expect(group(idle, on(), "cameraStudio")).toMatchObject({ kind: "actions", choices: [{ id: "openStudio", label: "Arrange in Recording Studio…", enabled: true }] });
    // The way there stays open whether or not the device may change: the camera off, or a recording.
    expect(settingsAction(idle, on(), "cameraStudio", "openStudio")).toBe("openStudio");
    expect(settingsAction(idle, on({ enabled: false }), "cameraStudio", "openStudio")).toBe("openStudio");
    expect(settingsAction({ type: "recording", startedAt: "2026-10-17T00:00:00Z" }, on({ session: { hidden: false } }), "cameraStudio", "openStudio")).toBe("openStudio");
    expect(studio(on())).toEqual(["studioCamera", "cameraWidth", "cameraHeight", "cameraRatio", "cameraRounding", "cameraMirror", "systemAudio", "systemGain", "studioControls"]);
    expect(ids(context)).toEqual([]);
    expect(studio(context), "no camera: the Studio keeps its audio and controls").toEqual(["systemAudio", "systemGain", "studioControls"]);
    expect(group(idle, on(), "cameraWidth")).toMatchObject({ control: "slider", slider: { min: 5, max: 60, step: 1, value: 20, unit: "percent" } });
    expect(group(idle, on(), "cameraRounding")).toMatchObject({ control: "slider", slider: { min: 0, max: 100, value: 100 } });
    expect(group(idle, on(), "cameraRatio")?.choices.map((c) => [c.id, c.checked])).toEqual([["1:1", true], ["4:3", false], ["3:4", false], ["16:9", false]]);
    expect(checked(idle, on(), "cameraMirror")).toBe("off");
    expect(group(idle, { ...on(), language: "zh-TW" }, "cameraMirror")).toMatchObject({ label: "錄影時鏡像" });
  });

  it("offer the system default, named after the camera it is now, then each camera, and say when the chosen one is missing", () => {
    expect(group(idle, on(), "cameraDevice")?.choices.map((c) => [c.id, c.label, c.checked])).toEqual([
      ["systemDefault", "System default (FaceTime HD Camera)", true], ["built-in", "FaceTime HD Camera", false], ["iphone", "iPhone Camera", false]]);
    expect(settingsAction(idle, on(), "cameraDevice", "iphone")).toEqual({ setCameraDevice: { id: "iphone", label: "iPhone Camera" } });
    const missing = group(idle, on({ device: { id: "usb", label: "USB Camera" } }), "cameraDevice")!;
    expect(missing.choices.at(-1)).toMatchObject({ id: "usb", label: "USB Camera — Not connected", checked: true, enabled: false });
    expect(missing.note).toBe("Recordings use the system default camera until USB Camera is connected.");
  });

  it("send a slider's whole percent within range as the shape, and a ratio button or the mirror", () => {
    expect(settingsAction(idle, on(), "cameraWidth", "35")).toEqual({ setCameraShape: { width: 0.35 } });
    expect(settingsAction(idle, on(), "cameraRounding", "0")).toEqual({ setCameraShape: { rounding: 0 } });
    for (const bad of ["4", "61", "3.5", "-1", "", "abc"]) expect(settingsAction(idle, on(), "cameraHeight", bad), bad).toBeUndefined();
    expect(settingsAction(idle, on(), "cameraRatio", "16:9")).toEqual({ setCameraRatio: "16:9" });
    expect(settingsAction(idle, on(), "cameraMirror", "on")).toEqual({ setCameraShape: { mirror: true } });
    // Off: the rows wait for the switch.
    expect(settingsAction(idle, on({ enabled: false }), "cameraWidth", "30")).toBeUndefined();
    expect(group(idle, on({ enabled: false }), "cameraRatio")?.enabled).toBe(false);
  });

  it("keep the shape usable while a recording composes the camera, and lock the device", () => {
    const recording = { type: "recording" as const, startedAt: "2026-10-17T00:00:00Z" };
    const live = on({ session: { hidden: false } });
    expect(group(recording, live, "cameraWidth")?.enabled).toBe(true);
    expect(group(recording, live, "cameraMirror")?.enabled).toBe(true);
    expect(settingsAction(recording, live, "cameraWidth", "30")).toEqual({ setCameraShape: { width: 0.3 } });
    expect(group(recording, live, "cameraDevice")?.enabled).toBe(false);
    expect(group(recording, live, "camera")?.enabled).toBe(false);
    // A recording without the camera keeps the rows locked with the others.
    expect(settingsAction(recording, on(), "cameraWidth", "30")).toBeUndefined();
  });
});

describe("the Recording Studio's controls (plan 075, D19)", () => {
  const controls = (state: RecordingState, ctx: AppContext = context) => group(state, ctx, "studioControls")!;
  it("name the state and offer what the tray offers now, with the elapsed time while recording", () => {
    expect(controls(idle)).toMatchObject({ tab: "studio", kind: "actions", label: "Ready", choices: [{ id: "start", enabled: true }] });
    expect(settingsAction(idle, context, "studioControls", "start")).toBe("start");
    expect(controls({ type: "countdown", remaining: 2 })).toMatchObject({ label: "Recording starts in 2 s", choices: [{ id: "cancel", enabled: true }] });
    expect(settingsAction({ type: "starting" }, context, "studioControls", "cancel")).toBe("cancelCountdown");
    const recording = { type: "recording" as const, startedAt: "2026-10-17T00:00:00Z" };
    expect(controls(recording)).toMatchObject({ label: "Recording", elapsedSince: "2026-10-17T00:00:00Z", choices: [{ id: "stop", enabled: true }] });
    expect(controls({ type: "stopping" })).toMatchObject({ label: "Saving…", choices: [{ id: "saving", enabled: false }] });
    expect(controls(idle).elapsedSince).toBeUndefined();
  });
  it("offer Live preview between recordings where the engine makes one, Stop preview while there is one, and say why one could not start (D20)", () => {
    const mac = { ...context, camera: { enabled: false, available: true } };
    expect(controls(idle, mac).choices.map((c) => [c.id, c.enabled])).toEqual([["preview", true], ["start", true]]);
    expect(settingsAction(idle, mac, "studioControls", "preview")).toBe("startPreview");
    expect(controls(idle, context).choices.map((c) => c.id), "none without the engine's preview (Windows)").toEqual(["start"]);
    const starting = { ...mac, studio: { preview: { live: false }, showing: false } };
    expect(controls(idle, starting)).toMatchObject({ label: "Starting preview…", choices: [{ id: "stopPreview" }, { id: "start", enabled: true }] });
    const live = { ...mac, studio: { preview: { live: true }, showing: true } };
    expect(controls(idle, live).label).toBe("Previewing");
    expect(settingsAction(idle, live, "studioControls", "stopPreview")).toBe("stopPreview");
    expect(settingsAction(idle, live, "studioControls", "start"), "Start takes it").toBe("start");
    expect(controls(idle, { ...mac, studio: { showing: false, previewFailure: "camera_unavailable" } }).note).toMatch(/^Live preview could not start: /);
    expect(controls({ type: "recording", startedAt: "2026-10-17T00:00:00Z" }, live).choices.map((c) => c.id), "a recording has no preview to start").toEqual(["stop"]);
  });
  it("wait for screen recording's permission, whose fix the status card offers, in either of its steps", () => {
    for (const needsRelaunch of [false, true]) {
      const state = { type: "needsPermission" as const, needsRelaunch };
      expect(controls(state)).toMatchObject({ label: "Screen recording permission required", choices: [{ id: "start", enabled: false }] });
      expect(settingsAction(state, context, "studioControls", "start")).toBeUndefined();
    }
  });
});

describe("the Recording Studio's audio (plan 075, D19)", () => {
  const recording = { type: "recording" as const, startedAt: "2026-10-17T00:00:00Z" };
  it("shows each input's meter and mute for the recording in progress, the microphone's while it records one", () => {
    expect(group(idle, context, "systemAudio")).toMatchObject({ tab: "studio", control: "meter", meter: { source: "system" }, enabled: false,
      note: "Its level shows, and it can be muted, while recording." });
    expect(group(idle, context, "microphoneAudio")).toBeUndefined();
    expect(group(idle, { ...context, microphone: { enabled: true } }, "microphoneAudio")).toMatchObject({ enabled: false, meter: { source: "microphone" } });
    const live = { ...context, audioSession: { systemMuted: true, microphone: { muted: false } } };
    expect(group(recording, live, "systemAudio")).toMatchObject({ enabled: true, choices: [{ id: "mute", checked: true }, { id: "unmute", checked: false }] });
    expect(group(recording, live, "systemAudio")?.note).toBeUndefined();
    expect(checked(recording, live, "microphoneAudio")).toBe("unmute");
    expect(settingsAction(recording, live, "systemAudio", "unmute")).toEqual({ setAudioMuted: { source: "system", muted: false } });
    expect(settingsAction(recording, live, "microphoneAudio", "mute")).toEqual({ setAudioMuted: { source: "microphone", muted: true } });
    // A recording without the microphone: no row for it, though its switch is on for the next.
    expect(group(recording, { ...live, microphone: { enabled: true }, audioSession: { systemMuted: false } }, "microphoneAudio")).toBeUndefined();
    expect(settingsAction(idle, context, "systemAudio", "mute"), "nothing to mute between recordings").toBeUndefined();
    // Each input's fader (D21): saved, offered between and during recordings, the microphone's only with its meter.
    expect(group(idle, { ...context, audioGain: { system: -6, microphone: 3 } }, "systemGain")).toMatchObject({ tab: "studio", control: "slider", enabled: true,
      label: "System audio volume", slider: { min: -60, max: 12, step: 1, value: -6, unit: "decibels" }, choices: [{ id: "-6", label: "−6 dB", checked: true }] });
    expect(group(idle, context, "systemGain")?.slider?.value, "absent is 0 dB").toBe(0);
    expect(group(idle, { ...context, audioGain: { system: -60, microphone: 0 } }, "systemGain")?.choices[0]?.label).toBe("−∞ dB");
    expect(group(idle, { ...context, microphone: { enabled: true }, language: "zh-TW" }, "microphoneGain")).toMatchObject({ label: "麥克風音量", enabled: true });
    expect(group(idle, context, "microphoneGain")).toBeUndefined();
    expect(settingsAction(recording, live, "systemGain", "12")).toEqual({ setAudioGain: { source: "system", db: 12 } });
    expect(settingsAction(recording, live, "microphoneGain", "-60")).toEqual({ setAudioGain: { source: "microphone", db: -60 } });
    expect(settingsAction(idle, context, "systemGain", "-7")).toEqual({ setAudioGain: { source: "system", db: -7 } });
    for (const choice of ["13", "-61", "1.5", "loud"]) expect(settingsAction(idle, context, "systemGain", choice), choice).toBeUndefined();
    expect(settingsAction(idle, context, "microphoneGain", "0"), "no microphone: no fader").toBeUndefined();
    expect(group(recording, { ...live, language: "zh-TW" }, "systemAudio")).toMatchObject({ label: "系統聲音", sectionHeading: "音訊" });
  });
});

describe("the camera's preview (plan 075, step 7)", () => {
  const layout = { width: 0.2, height: 0.3, rounding: 0.5, mirror: true, positions: [{ display: "primary", x: 0.1, y: 0.2 }, { display: "9", x: 0.4, y: 0.6 }] };
  const displays = [
    { id: "1", label: "Built-in", logicalWidth: 1512, logicalHeight: 982, scaleFactor: 2, internal: true, primary: true, menuBar: 33 },
    { id: "9", label: "Studio", logicalWidth: 1080, logicalHeight: 1920, scaleFactor: 1, internal: false, primary: false },
  ];
  const devices = [{ id: "iphone", name: "iPhone Camera", default: true }];
  const on = (camera: Partial<NonNullable<AppContext["camera"]>> = {}, more: Partial<AppContext> = {}): AppContext =>
    ({ ...context, displays, camera: { enabled: true, available: true, access: "granted", layout, devices, ...camera }, ...more });
  const preview = (state: RecordingState, ctx: AppContext) => group(state, ctx, "cameraPreview");
  const recording = { type: "recording" as const, startedAt: "2026-10-17T00:00:00Z" };

  it("shows the display the recording captures, its menu bar, and the bubble where the recording puts it", () => {
    expect(settingsView(idle, on()).groups.filter((g) => g.tab === "studio").map((g) => g.id).slice(0, 2), "the Studio's first row").toEqual(["cameraPreview", "studioCamera"]);
    expect(preview(idle, on())).toMatchObject({ control: "cameraPreview", enabled: true, cameraPreview: {
      mode: "live", display: { width: 1512, height: 982, menuBar: 33 }, bubble: { width: 0.2, height: 0.3, rounding: 0.5, mirror: true },
      x: 0.1, y: 0.2, camera: "iPhone Camera" } });
    // Another display: its own position; hiding the menu bar takes the band away.
    const studio = on({}, { display: { kind: "display", id: "9", label: "Studio" }, hideSystemUi: true });
    expect(preview(idle, studio)?.cameraPreview).toMatchObject({ display: { width: 1080, height: 1920, menuBar: 0 }, x: 0.4, y: 0.6 });
    expect(preview(idle, { ...on(), displays: [] }), "no display to show").toBeUndefined();
    // The chosen camera by the name it has now, which the page matches; a renamed one keeps its stored label meanwhile.
    expect(preview(idle, on({ device: { id: "iphone", label: "Old iPhone name" } }))?.cameraPreview?.camera).toBe("iPhone Camera");
  });

  it("says why there is no picture: the switch off, access not allowed, a recording without the camera yet", () => {
    expect(preview(idle, on({ enabled: false }))?.cameraPreview).toMatchObject({ mode: "off", status: "Turn on Camera to see it here." });
    expect(preview(idle, on({ access: "denied" }))?.cameraPreview).toMatchObject({ mode: "off", status: "Allow camera access to see it here." });
    expect(preview({ type: "starting" }, on())?.cameraPreview).toMatchObject({ mode: "off", status: "Shown here once the recording starts." });
    expect(preview(recording, on({ session: { hidden: false } }))?.cameraPreview).toMatchObject({ mode: "recording" });
    expect(preview(recording, on({ session: { hidden: false } }))?.cameraPreview?.status).toBeUndefined();
    expect(preview(idle, { ...on(), language: "zh-TW" })).toMatchObject({ label: "預覽" });
    // A Live preview's picture, with the camera off: the engine's, with no bubble to place (D20).
    expect(preview(idle, on({ enabled: false }, { studio: { preview: { live: true }, showing: true } }))?.cameraPreview)
      .toMatchObject({ mode: "recording", composed: false });
    expect(preview(idle, on({ enabled: false }, { studio: { preview: { live: true }, showing: true } }))?.cameraPreview?.status).toBeUndefined();
    expect(preview(idle, on({ session: { hidden: false } }, { studio: { preview: { live: true }, showing: true } }))?.cameraPreview)
      .toMatchObject({ mode: "recording", composed: true });
  });

  it("sends where the bubble was let go of on the display shown, also while recording, and nothing out of range", () => {
    expect(settingsAction(idle, on(), "cameraPreview", "0.25,1")).toEqual({ setCameraPosition: { display: "1", x: 0.25, y: 1 } });
    expect(settingsAction(recording, on({ session: { hidden: false } }), "cameraPreview", "0,0.5")).toEqual({ setCameraPosition: { display: "1", x: 0, y: 0.5 } });
    for (const bad of ["1.5,0", "-0.1,0", "0.5", "0.5,0.5,0", "NaN,0", "0.1234567,0", "", "x,y"]) expect(settingsAction(idle, on(), "cameraPreview", bad), bad).toBeUndefined();
    expect(settingsAction(idle, on({ enabled: false }), "cameraPreview", "0.5,0.5")).toBeUndefined();
    expect(settingsAction(recording, on(), "cameraPreview", "0.5,0.5"), "a recording without the camera").toBeUndefined();
  });
});

describe("microphone (plan 074)", () => {
  const devices = [
    { id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", default: true },
    { id: "usb-mic", name: "USB Microphone", default: false },
  ];
  const on = (microphone: Partial<NonNullable<AppContext["microphone"]>> = {}): AppContext =>
    ({ ...context, microphone: { enabled: true, devices, access: "granted", ...microphone } });

  it("is a switch, off by default, in the Recording tab's Audio section after the countdown, and says to use headphones", () => {
    const row = group(idle, context, "microphone")!;
    expect(row).toMatchObject({ label: "Microphone", control: "switch", tab: "recording", section: "audio" });
    expect(row.info).toContain("headphones");
    expect(checked(idle, context, "microphone")).toBe("off");
    expect(checked(idle, on(), "microphone")).toBe("on");
    expect(settingsAction(idle, context, "microphone", "on")).toEqual({ setMicrophone: true });
    expect(settingsAction(idle, on(), "microphone", "off")).toEqual({ setMicrophone: false });
    expect(group(idle, { ...on(), language: "zh-TW" }, "microphone")).toMatchObject({ label: "麥克風", sectionHeading: "音訊" });
  });

  it("is locked with the input device while a session runs", () => {
    for (const state of busy) {
      expect(group(state, on(), "microphone")?.enabled, state.type).toBe(false);
      expect(group(state, on(), "microphoneDevice")?.enabled, state.type).toBe(false);
      expect(settingsAction(state, on(), "microphone", "off"), state.type).toBeUndefined();
      expect(settingsAction(state, on(), "microphoneDevice", "usb-mic"), state.type).toBeUndefined();
    }
  });

  it("shows a macOS denial with the pane that changes it, only while the switch is on", () => {
    const denied = group(idle, on({ access: "denied" }), "microphone")!;
    expect(denied.diagnostics).toEqual([expect.objectContaining({ kind: "current", heading: "Microphone access is off" })]);
    expect(denied.actions).toEqual([expect.objectContaining({ id: "openSettings", label: "Open microphone settings…" })]);
    expect(settingsAction(idle, on({ access: "denied" }), "microphone", "openSettings")).toBe("openMicrophoneSettings");
    expect(group(idle, on({ access: "restricted" }), "microphone")?.diagnostics).toHaveLength(1);
    expect(group(idle, { ...context, microphone: { enabled: false, access: "denied" } }, "microphone")).not.toHaveProperty("diagnostics");
    expect(group(idle, on(), "microphone")).not.toHaveProperty("diagnostics");
    expect(group(idle, on({ access: "not-determined" }), "microphone")).toMatchObject({ noteKind: "status",
      note: "macOS asks for microphone access when you next record." });
    expect(group(idle, { ...on({ access: "denied" }), language: "zh-TW" }, "microphone")?.diagnostics?.[0]?.heading).toBe("未允許取用麥克風");
    // Windows has no status to read and no pane to link.
    const windows = group(idle, { ...on(), platform: "win32", microphone: { enabled: true, devices } }, "microphone")!;
    expect(windows).not.toHaveProperty("diagnostics");
    expect(windows).not.toHaveProperty("actions");
    expect(settingsAction(idle, { ...on(), platform: "win32" }, "microphone", "openSettings")).toBeUndefined();
  });

  it("offers the system default, named after the device it is now, then each listed input", () => {
    const row = group(idle, on(), "microphoneDevice")!;
    expect(row).toMatchObject({ label: "Input device", control: "menu", section: "audio", enabled: true });
    expect(row.choices.map(c => [c.id, c.label, c.checked])).toEqual([
      ["systemDefault", "System default (MacBook Pro Microphone)", true],
      ["BuiltInMicrophoneDevice", "MacBook Pro Microphone", false],
      ["usb-mic", "USB Microphone", false],
    ]);
    expect(settingsAction(idle, on(), "microphoneDevice", "usb-mic")).toEqual({ setMicrophoneDevice: { id: "usb-mic", label: "USB Microphone" } });
    expect(settingsAction(idle, on({ device: { id: "usb-mic", label: "USB Microphone" } }), "microphoneDevice", "systemDefault")).toEqual({ setMicrophoneDevice: null });
    expect(checked(idle, on({ device: { id: "usb-mic", label: "USB Microphone" } }), "microphoneDevice")).toBe("usb-mic");
    expect(group(idle, { ...on(), language: "zh-TW" }, "microphoneDevice")?.choices[0]?.label).toBe("跟隨系統（MacBook Pro Microphone）");
    // Off: the stored input is kept but cannot be chosen until the microphone is on.
    expect(group(idle, { ...on(), microphone: { enabled: false, devices } }, "microphoneDevice")?.enabled).toBe(false);
    expect(settingsAction(idle, { ...on(), microphone: { enabled: false, devices } }, "microphoneDevice", "usb-mic")).toBeUndefined();
  });

  it("keeps a chosen input that is not connected selected and says the default is used until it is back", () => {
    const missing = on({ device: { id: "headset", label: "AirPods" } });
    const row = group(idle, missing, "microphoneDevice")!;
    expect(row.choices.at(-1)).toMatchObject({ id: "headset", label: "AirPods — Not connected", enabled: false, checked: true });
    expect(row).toMatchObject({ noteKind: "status", note: "Recordings use the system default input until AirPods is connected." });
    expect(settingsAction(idle, missing, "microphoneDevice", "headset")).toBeUndefined();
    // Before the inputs are listed nothing is known to be missing: the stored one is simply shown.
    const unlisted = group(idle, { ...context, microphone: { enabled: true, device: { id: "headset", label: "AirPods" } } }, "microphoneDevice")!;
    expect(unlisted.choices.map(c => [c.id, c.label, c.checked])).toEqual([["systemDefault", "System default", false], ["headset", "AirPods", true]]);
    expect(unlisted).not.toHaveProperty("note");
  });
});

describe("recording locks every preference except the language", () => {
  it.each(busy)("$type", (state) => {
    const view = settingsView(state, context);
    expect(view.hint).toBe("Recording in progress; only language, appearance and icon click can change.");
    // The Recording Studio's controls stop or cancel what runs (D19).
    // The Recording Studio's controls stop or cancel what runs (D19); its faders change the sound from the next on (D21).
    for (const entry of view.groups) expect(entry.enabled, entry.id).toBe(["outputFolder", "trayClick", "language", "appearance", "log", "about", "studioControls", "systemGain"].includes(entry.id) || entry.kind === "shortcutList");
    // The folder row keeps only Show in Finder: Change… waits for the session to end.
    expect(view.groups.find(entry => entry.id === "outputFolder")?.choices.map(choice => [choice.id, choice.enabled])).toEqual([["change", false], ["reveal", true]]);
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
  it("offers nothing but Quit and says why, as the tray does", () => {
    const ctx: AppContext = { ...context, quitting: true, recordingResults: [
      { id: "f", code: "disk_full", detail: "", occurredAt: "2026-09-24T12:00:00Z", outcome: "empty", acknowledged: false }] };
    const view = settingsView(idle, ctx);
    // Said once, by the status card; the hint under its title would only repeat it.
    expect(view.status?.title).toBe("Quitting once the recording is saved or cleaned up…");
    expect(view.hint).toBe("");
    // Quit stays, as in the tray, so a Relaunch still waiting can become a plain quit; About's links do not.
    expect(view.groups.filter(g => g.enabled).map(g => g.id)).toEqual(["about"]);
    expect(view.groups.find(g => g.id === "about")!.choices.filter(c => c.enabled).map(c => c.id)).toEqual(["quit"]);
    expect(settingsAction(idle, ctx, "about", "quit")).toBe("quit");
    expect(settingsAction(idle, ctx, "about", "website")).toBeUndefined();
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
    expect(settingsView(idle, context).groups.filter(g => g.tab === "recording").map(g => g.id)).toEqual(["screen", "hideSystemUi", "outputFolder", "fileName", "countdown", "countdownSound", "microphone", "microphoneDevice", "videoQuality", "resolutionCap", "frameRate"]);
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
    expect(settingsView({ type: "countdown", remaining: 2 }, context).hint).toBe("Recording in progress; only language, appearance and icon click can change.");
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
    const off = group(idle, { ...context, notifications: false }, "notifications")?.info ?? "";
    expect(off).toContain(t("Failures still appear in the menu bar and the Troubleshooting tab.", "en"));
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
    expect(group(idle, { ...context, notifications: false }, "notifications")?.info).not.toContain("System Settings");
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
  it("names each live choice with its size in pixels; a missing display has none to give", () => {
    expect(group(idle, selected, "screen")!.choices.map((c) => c.label)).toEqual(["Primary display · 3840×2160", "Studio (Primary) · 3840×2160"]);
    expect(group(idle, { ...selected, displays: [] }, "screen")!.choices.map((c) => c.label)).toEqual(["Primary display", "Studio — Unavailable"]);
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
  it("draws the arrangement once every live screen knows its place, and a menu otherwise", () => {
    const side = { id: "8", label: "", logicalWidth: 1080, logicalHeight: 1920, scaleFactor: 1, internal: false, primary: false, x: -1080, y: -400 };
    const placed = { ...selected, displays: [{ ...d, x: 0, y: 0 }, side] };
    const screen = group(idle, placed, "screen")!;
    expect(screen.control).toBe("arrangement");
    expect(screen.choices.map((c) => c.display)).toEqual([undefined,
      { x: 0, y: 0, width: 1920, height: 1080, primary: true, name: "Studio", pixels: "3840×2160" },
      { x: -1080, y: -400, width: 1080, height: 1920, primary: false, name: "Display 8", pixels: "1080×1920" }]);
    // One screen without a place, or none at all to place, keeps the menu.
    expect(group(idle, { ...placed, displays: [{ ...d, x: 0, y: 0 }, { ...d, id: "8" }] }, "screen")!.control).toBe("menu");
    expect(group(idle, { ...placed, displays: [] }, "screen")!.control).toBe("menu");
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
    ["screen", "menu", "source"], ["hideSystemUi", "switch", "source"], ["outputFolder", "menu", "source"], ["fileName", "text", "source"], ["countdown", "segmented", "countdown"], ["countdownSound", "switch", "countdown"],
    ["microphone", "switch", "audio"], ["microphoneDevice", "menu", "audio"], ["systemAudio", "meter", "studioAudio"], ["systemGain", "slider", "studioAudio"], ["studioControls", "menu", "studioControls"],
    ["videoQuality", "segmented", "video"],
    ["resolutionCap", "menu", "video"], ["frameRate", "menu", "video"],
    ["trayClick", "menu", "controls"], ["hotkey", "menu", "controls"], ["notifications", "switch", "controls"],
    ["language", "segmented", "display"], ["appearance", "segmented", "display"],
    ["updateChecks", "switch", "updates"], ["updates", "menu", "updates"],
    ...["global", "window", "recordings", "player", "fullScreen"].map(category => [`shortcutList:${category}`, undefined, `shortcutList:${category}`]),
    ["log", "menu", "diagnostics"], ["localData", "menu", "cleanup"], ["about", "menu", "about"],
  ]);
  // Appearance is three icons, one click each (2026-10-05); no other row is.
  expect(groups.filter(g => g.iconChoices).map(g => [g.id, g.choices.map(c => c.id)])).toEqual([["appearance", ["system", "light", "dark"]]]);
  expect(group(idle, { ...context, notifications: false }, "notifications")?.noteKind).toBe("explanation");
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
  expect(choices[0]!.label).toBe("Recommended: ⇧⌘1");
  expect(group(idle, { ...context, language: "zh-TW" }, "hotkey")!.choices[0]!.label).toBe("建議：⇧⌘1");
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
  expect(settingsView(idle, ctx).recordingResults?.[0]).toMatchObject({ code: "disk_full", outcomeState: "pending" });
  expect(settingsAction(idle, ctx, "recordingResult:failure-1", "acknowledge")).toBeUndefined();
  const done = { ...ctx, recordingResults: [{ ...result, outcome: "partial" as const, partialPath: "/tmp/a.recording.mp4" }] };
  expect(settingsAction(idle, done, "recordingResult:failure-1", "acknowledge")).toEqual({ recordingResult: { id: "failure-1", action: "acknowledge" } });
  expect(settingsAction(idle, done, "recordingResult:old", "acknowledge")).toBeUndefined();
  expect(settingsAction({ type: "recording", startedAt: "" }, done, "recordingResult:failure-1", "folder")).toBeUndefined();
  expect(settingsAction({ type: "recording", startedAt: "" }, done, "recordingResult:failure-1", "reveal")).toBeDefined();
  expect(settingsView(idle, done).recordingResults?.[0]?.outcome).toContain("may not play");
  expect(settingsView(idle, done).recordingResults?.[0]).toMatchObject({ code: "disk_full", outcomeState: "partial" });
  const unknown = { ...ctx, recordingResults: [{ ...result, outcome: "unknown" as const, recordingPath: "/tmp/unconfirmed.mp4" }] };
  expect(settingsView(idle, unknown).recordingResults?.[0]).toMatchObject({ code: "disk_full", outcomeState: "unknown", fileName: "unconfirmed.mp4" });
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
  it("always offers Troubleshooting last, after Recordings, the Recording Studio, Recording and General, counting unread failures in its label and accessible name", () => {
    expect(settingsView(idle, context).tabs).toEqual([
      { id: "library", label: "Recordings" }, { id: "studio", label: "Recording Studio" }, { id: "recording", label: "Recording settings" }, { id: "general", label: "General" },
      { id: "shortcuts", label: "Keyboard Shortcuts" }, { id: "failures", label: "Troubleshooting" },
    ]);
    const results = [{ ...base, id: "a", acknowledged: false }, { ...base, id: "b", acknowledged: false }, { ...base, id: "c", acknowledged: true }];
    expect(settingsView(idle, { ...context, recordingResults: results }).tabs[5]).toEqual({
      id: "failures", label: "Troubleshooting (2)", accessibleLabel: "Troubleshooting, 2 unread recording failures",
    });
    expect(settingsView(idle, { ...context, language: "zh-TW", recordingResults: results }).tabs.map((tab) => tab.label))
      .toEqual(["錄影檔", "錄影工作室", "錄影設定", "一般", "鍵盤快捷鍵", "疑難排解（2）"]);
    expect(settingsView(idle, { ...context, language: "zh-TW", recordingResults: results }).tabs[5]!.accessibleLabel).toBe("疑難排解，2 筆未確認失敗紀錄");
    expect(settingsView(idle, { ...context, recordingResults: [results[2]!] }).tabs[5]).toEqual({ id: "failures", label: "Troubleshooting" });
    // One unread failure is said in the singular.
    expect(settingsView(idle, { ...context, recordingResults: [results[0]!] }).tabs[5]!.accessibleLabel).toBe("Troubleshooting, 1 unread recording failure");
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
    // Restored by name: deleting TZ leaves Windows in the last zone set, and later tests would read Lima times.
    const zone = process.env["TZ"] ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
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
      process.env["TZ"] = zone;
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

  it("locks Change… while starting, counting down, recording or saving, but keeps Show in Finder, as the Recordings cards do", () => {
    for (const state of [{ type: "starting" }, { type: "countdown", remaining: 2 }, { type: "recording", startedAt: "x" }, { type: "stopping" }] as RecordingState[]) {
      expect(settingsAction(state, context, "outputFolder", "change"), state.type).toBeUndefined();
      expect(settingsAction(state, context, "outputFolder", "reveal"), state.type).toBe("openOutputDir");
    }
    // A quit in progress still offers nothing.
    expect(settingsAction({ type: "recording", startedAt: "x" }, { ...context, quitting: true }, "outputFolder", "reveal")).toBeUndefined();
  });

  it("orders General as the icon's click, Shortcut, Notifications, Language, Appearance, Updates and About, headings moving with their groups", () => {
    const general = settingsView(idle, context).groups.filter((g) => g.tab === "general");
    expect(general.map((g) => g.id)).toEqual(["trayClick", "hotkey", "notifications", "language", "appearance", "updateChecks", "updates", "about"]);
    expect(general.find((g) => g.id === "updateChecks")?.sectionHeading).toBe("Updates");
  });

  it("heads each section once, on its first row, in both languages", () => {
    const headings = (language: "en" | "zh-TW") => settingsView(idle, { ...context, language }).groups
      .filter((g) => g.sectionHeading).map((g) => [g.id, g.sectionHeading]);
    expect(headings("en")).toEqual([
      ["screen", "Source and output"], ["countdown", "Before recording"], ["microphone", "Audio"], ["systemAudio", "Audio"], ["studioControls", "Recording controls"], ["videoQuality", "Video"],
      ["trayClick", "Controls and notifications"], ["language", "Language and appearance"], ["updateChecks", "Updates"],
      ["shortcutList:global", "Anywhere"], ["shortcutList:window", "RecordStuff window"], ["shortcutList:recordings", "Recordings"],
      ["shortcutList:player", "Player"], ["shortcutList:fullScreen", "Full-screen video"],
      ["log", "Diagnostic tools"], ["localData", "Reset and cleanup"],
    ]);
    expect(headings("zh-TW").map(([, heading]) => heading)).toEqual(["來源與輸出", "錄影開始前", "音訊", "音訊", "錄影控制", "影像", "操作與通知", "語言與外觀", "更新",
      "任何地方", "RecordStuff 視窗", "錄影檔", "播放器", "全螢幕影片", "診斷工具", "重設與清理"]);
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
    reason: "Another app may be using ⌥⌘,." })]);
  const conflict = group(idle, { ...context, settingsShortcut: { kind: "conflict" } }, "hotkey");
  expect(conflict?.actions).toBeUndefined();
  expect(conflict?.diagnostics?.[0]?.reason).toBe("⌥⌘, is the recording shortcut, so it does not open RecordStuff.");
  expect(group(idle, { ...context, settingsShortcut: { kind: "registered", accelerator: "CommandOrControl+Alt+," } }, "hotkey")?.diagnostics).toBeUndefined();
  expect(failed?.diagnostics?.[0]?.guidance).toBe("Open RecordStuff from the menu bar icon, or retry once the other app releases it.");
  const windows = { ...context, platform: "win32" as const, settingsShortcut: { kind: "failed" as const, accelerator: "CommandOrControl+Alt+,", reason: "taken" } };
  expect(group(idle, windows, "hotkey")?.diagnostics?.[0]?.guidance).toBe("Open RecordStuff from the system tray icon, or retry once the other app releases it.");
  // Named as it is there: Ctrl+Shift+,, since Windows sends AltGr as Ctrl+Alt (2026-10-05).
  expect(group(idle, windows, "hotkey")?.diagnostics?.[0]?.reason).toBe("Another app may be using Ctrl+Shift+,.");
  expect(group(idle, { ...windows, language: "zh-TW" }, "hotkey")?.diagnostics?.[0]?.guidance).toBe("可從系統匣圖示開啟 RecordStuff，或待其他 App 釋放後重試。");
});

describe("the status card", () => {
  it("names a save in the background while idle, slow or not, and locks nothing (2026-10-09)", () => {
    const view = settingsView(idle, { ...context, saving: [{ file: "Demo.mp4", slow: false }] });
    expect(view.status).toMatchObject({ tone: "busy", phase: "saving", title: "Saving Demo.mp4…", detail: "" });
    expect(view.hint).toBe("");
    expect(settingsView(idle, { ...context, saving: [{ file: "Demo.mp4", slow: true }] }).status?.title)
      .toBe("Still saving Demo.mp4. The drive may not be responding.");
    // A problem that stops the next recording still comes first.
    expect(settingsView({ type: "idle", outputDirUnavailable: true }, { ...context, saving: [{ file: "Demo.mp4", slow: false }] }).status?.tone).toBe("attention");
  });
  it("has nothing to say while ready, whatever the click and the shortcut: the page shows no card then", () => {
    for (const ctx of [context, { ...context, trayClick: "menu" as const }, { ...context, hotkey: { ...context.hotkey, registered: false } }, { ...context, platform: "win32" as const, language: "zh-TW" as const }]) {
      expect(settingsView(idle, ctx).status).toEqual({ tone: "ready", phase: "idle", title: t("Ready to record", ctx.language), detail: "" });
    }
  });
  it("names the state like the tray while the lock hint explains it, leaving Stop and Cancel to the tray", () => {
    expect(busy.map((state) => settingsView(state, context).status)).toEqual([
      { tone: "busy", phase: "starting", title: "Starting… Check for system permission prompts", detail: "" },
      { tone: "busy", phase: "countdown", title: "Recording starts in 2 s", detail: "" },
      { tone: "recording", phase: "recording", title: "Recording", detail: "" },
      { tone: "busy", phase: "stopping", title: "Saving…", detail: "" },
    ]);
    expect(settingsView(idle, { ...context, quitting: true }).status).toEqual({ tone: "busy", phase: "quitting", title: "Quitting once the recording is saved or cleaned up…", detail: "" });
    expect(settingsView(idle, { ...context, quitting: true, quitStep: "metadata" }).status).toEqual({ tone: "busy", phase: "quitting", title: "Quitting once settings and failure history are saved…", detail: "" });
  });
  it("turns to attention for what stops the next recording, with the fix as its action", () => {
    // Like the tray's permission steps: the system pane first, and Relaunch for access that may already be granted.
    expect(settingsView({ type: "needsPermission", needsRelaunch: false }, context).status).toMatchObject({ tone: "attention",
      action: { id: "permission", label: "Open Settings" }, secondaryAction: { id: "relaunch", label: "Already allowed? Relaunch" } });
    expect(settingsView({ type: "needsPermission", needsRelaunch: false }, { ...context, language: "zh-TW" }).status?.secondaryAction?.label).toBe("已經允許了？重新啟動");
    // Once only a relaunch can help, it is the action itself, offered once.
    expect(settingsView({ type: "needsPermission", needsRelaunch: true }, context).status).toMatchObject({ action: { id: "relaunch" } });
    expect(settingsView({ type: "needsPermission", needsRelaunch: true }, context).status?.secondaryAction).toBeUndefined();
    expect(settingsView({ type: "needsPermission", needsRelaunch: false }, { ...context, quitting: true }).status?.secondaryAction).toBeUndefined();
    expect(settingsView({ type: "idle", outputDirUnavailable: true }, context).status).toMatchObject({ tone: "attention", title: "Output folder unavailable", action: { id: "folder" } });
    const gone = { ...context, display: { kind: "display" as const, id: "9", label: "Gone" } };
    // The way back, once there is a Primary display to go back to.
    expect(settingsView(idle, gone).status).toEqual({ tone: "attention", phase: "idle", title: "Selected display is unavailable", detail: "" });
    const withPrimary = { ...gone, displays: [{ id: "1", label: "Built-in", logicalWidth: 1512, logicalHeight: 982, scaleFactor: 2, internal: true, primary: true }] };
    expect(settingsView(idle, withPrimary).status?.action).toEqual({ id: "primary", label: "Use Primary display" });
    expect(settingsAction(idle, withPrimary, "status", "primary")).toEqual({ setDisplay: { kind: "primary" } });
    expect(settingsAction(idle, withPrimary, "status", "folder")).toBeUndefined();
  });
  it("offers Reset beside an unreadable failure history, which resolves only while the history is unreadable (plan 078)", () => {
    const failed = { ...context, historyFailed: true };
    expect(settingsView(idle, failed)).toMatchObject({
      recordingHistoryStatus: "Could not read the failure history, so new failures cannot be saved. Resetting keeps the file as a backup.",
      recordingHistoryReset: { label: "Reset failure history…", enabled: true },
    });
    expect(settingsView(idle, context)).not.toHaveProperty("recordingHistoryReset");
    expect(settingsAction(idle, failed, "recordingHistory", "reset")).toBe("resetFailureHistory");
    expect(settingsAction(idle, context, "recordingHistory", "reset")).toBeUndefined();
    expect(settingsAction(idle, { ...failed, quitting: true }, "recordingHistory", "reset")).toBeUndefined();
  });

  it("puts a Windows without Media Foundation before any other fix, with Optional features as its action (plan 078)", () => {
    const missing = { ...context, mediaComponentsMissing: true };
    expect(settingsView({ type: "idle", outputDirUnavailable: true }, missing).status).toMatchObject({
      tone: "attention", title: "Windows's media components are missing, so recording cannot start.", action: { id: "mediaComponents", label: "Open Optional features" },
    });
    expect(settingsAction({ type: "idle" }, missing, "status", "mediaComponents")).toBe("openOptionalFeatures");
    expect(settingsAction({ type: "idle" }, context, "status", "mediaComponents")).toBeUndefined();
  });
  it("resolves only the offered fix to the tray's own action: never a start, a stop or anything while quitting", () => {
    expect(settingsAction({ type: "idle", outputDirUnavailable: true }, context, "status", "folder")).toBe("changeOutputDir");
    expect(settingsAction({ type: "needsPermission", needsRelaunch: false }, context, "status", "permission")).toBe("openPermissionSettings");
    expect(settingsAction({ type: "needsPermission", needsRelaunch: true }, context, "status", "relaunch")).toBe("relaunch");
    expect(settingsAction({ type: "needsPermission", needsRelaunch: false }, context, "status", "relaunch")).toBe("relaunch");
    expect(settingsAction({ type: "needsPermission", needsRelaunch: false }, { ...context, quitting: true }, "status", "relaunch")).toBeUndefined();
    expect(settingsAction({ type: "idle", outputDirUnavailable: true }, context, "status", "relaunch")).toBeUndefined();
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
      .toBe("每分鐘約 350 MB（3024 × 1964、60 fps）。");
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
  it("lists every video newest first by its name, with its day, time, length, size and id-only URLs", () => {
    const view = settingsView(idle, library({})).library!;
    expect(view.summary).toBe("2 recordings · 2.4 GB");
    expect(view.folder).toBe("~/recordings");
    expect(view.items).toEqual([
      { id: "id-2026-10-04 14-02-11.mp4", name: "2026-10-04 14-02-11.mp4", day: "Today", title: "2026-10-04 14-02-11", time: new Date(2026, 9, 4, 14, 2).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" }),
        duration: "1:23", size: "180 MB", thumbnail: "recordstuff-media://thumb/id-2026-10-04 14-02-11.mp4?v=v1", video: "recordstuff-media://video/id-2026-10-04 14-02-11.mp4?v=v1" },
      expect.objectContaining({ day: "Yesterday", title: "Product demo", time: new Date(2026, 9, 3, 9, 30).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" }), duration: "1:02:05", size: "2.2 GB" }),
    ]);
    expect(settingsView(idle, { ...library({}), language: "zh-TW" }).library!.summary).toBe("2 個錄影・2.4 GB");
    expect(settingsView(idle, library({ files: [files[0]!] })).library!.summary).toBe("1 recording · 180 MB");
  });
  it("names each recording's subfolder and lists the folders the library offers (plan 071)", () => {
    const view = settingsView(idle, library({
      files: [files[0]!, { ...files[1]!, path: "/tmp/recordings/Demos/Product demo.mp4", folder: "Demos" }],
      folders: [{ name: "Demos", empty: false }, { name: "Empty", empty: true }],
    })).library!;
    expect(view.items.map(item => item.folder)).toEqual([undefined, "Demos"]);
    expect(view.items[0]).not.toHaveProperty("folder");
    expect(view.folders).toEqual([{ name: "Demos", empty: false }, { name: "Empty", empty: true }]);
    expect(settingsView(idle, library({ folders: [] })).library).not.toHaveProperty("folders");
    // Favorites and the category shown, only while their categories are listed (2026-10-09).
    const folders = [{ name: "Demos", empty: false }, { name: "Talks", empty: true }];
    const remembered = (extra: Partial<AppContext>) => settingsView(idle, { ...library({ folders }), ...extra }).library!;
    expect(remembered({ libraryFavorites: ["Talks", "Gone", "Demos"], libraryShown: "Demos" })).toMatchObject({ favorites: ["Talks", "Demos"], shown: { folder: "Demos" } });
    expect(remembered({ libraryShown: null }).shown).toEqual({ folder: null });
    expect(remembered({ libraryFavorites: ["Gone"], libraryShown: "Gone" })).not.toHaveProperty("shown");
    expect(remembered({ libraryFavorites: ["Gone"] })).not.toHaveProperty("favorites");
  });
  it("says it is loading or cannot read the folder instead of claiming it is empty", () => {
    expect(settingsView(idle, library({ loading: true, files: [] })).library).toEqual({ folder: "~/recordings", layout: "grid", previewSound: false, status: "Loading recordings…", items: [] });
    expect(settingsView(idle, library({ failed: true, files: [] })).library?.status).toBe("Could not read the output folder. Check the folder and its drive, or choose another folder.");
    expect(settingsView(idle, library({ files: [] })).library).toEqual({ folder: "~/recordings", layout: "grid", previewSound: false, items: [] });
    expect(settingsView(idle, context)).not.toHaveProperty("library");
  });
  it("resolves only listed ids and offered actions, even while recording", () => {
    const ctx = library({});
    expect(settingsAction(idle, ctx, "recordingFile:id-Product demo.mp4", "trash")).toEqual({ recordingFile: { id: "id-Product demo.mp4", action: "trash" } });
    expect(settingsAction(busy[2]!, ctx, "recordingFile:id-Product demo.mp4", "drag")).toEqual({ recordingFile: { id: "id-Product demo.mp4", action: "drag" } });
    expect(settingsAction(idle, ctx, "recordingFile:/etc/passwd", "open")).toBeUndefined();
    expect(settingsAction(idle, ctx, "recordingFile:id-Product demo.mp4", "delete")).toBeUndefined();
  });
  it("offers the layout at any time and Undo only while a recording waits to go to the Trash (2026-10-05)", () => {
    const ctx = library({});
    expect(settingsView(idle, { ...ctx, libraryLayout: "list" }).library?.layout).toBe("list");
    expect(settingsAction(busy[2]!, ctx, "library", "list")).toEqual({ setLibraryLayout: "list" });
    expect(settingsAction(idle, ctx, "library", "shelf")).toBeUndefined();
    expect(settingsChecked(idle, { ...ctx, libraryLayout: "list" }, "library", "list")).toBe(true);
    // The previews' sound (2026-10-14): muted unless saved on, switchable while recording.
    expect(settingsView(idle, ctx).library?.previewSound).toBe(false);
    expect(settingsView(idle, { ...ctx, libraryPreviewSound: true }).library?.previewSound).toBe(true);
    expect(settingsAction(busy[2]!, ctx, "library", "previewSound:on")).toEqual({ setLibraryPreviewSound: true });
    expect(settingsAction(idle, ctx, "library", "previewSound:off")).toEqual({ setLibraryPreviewSound: false });
    expect(settingsAction(idle, ctx, "library", "previewSound")).toBeUndefined();
    expect(settingsChecked(idle, { ...ctx, libraryPreviewSound: true }, "library", "previewSound:on")).toBe(true);
    expect(settingsChecked(idle, ctx, "library", "previewSound:on")).toBe(false);
    expect(settingsChecked(idle, ctx, "library", "previewSound:off")).toBe(true);
    expect(settingsAction(idle, ctx, "library", "undoTrash")).toBeUndefined();
    const waiting = library({ trashed: { name: "Product demo.mp4" } });
    expect(settingsAction(idle, waiting, "library", "undoTrash")).toBe("undoTrash");
    expect(settingsView(idle, waiting).library?.trashed).toEqual({ name: "Product demo.mp4", message: "Moved Product demo.mp4 to the Trash.", undo: "Undo" });
    expect(settingsView(idle, { ...waiting, platform: "win32", language: "zh-TW" }).library?.trashed?.message).toBe("已將 Product demo.mp4 移到資源回收筒。");
    expect(settingsView(idle, library({ trashFailed: "Product demo.mp4" })).library?.notice).toBe("Could not move Product demo.mp4 to the Trash. It is back in the folder.");
    // A quit in progress offers nothing but Quit.
    expect(settingsAction(idle, { ...waiting, quitting: true }, "library", "undoTrash")).toBeUndefined();
  });
});

describe("the file name pattern (2026-10-05)", () => {
  it("is a text row under Source and output with an example and its placeholders, locked while recording", () => {
    const at = { ...context, now: new Date(2026, 9, 5, 14, 2, 11) };
    expect(group(idle, at, "fileName")).toMatchObject({ label: "File name format", control: "text", section: "source", enabled: true,
      note: "Example: 2026-10-05 14-02-11.mp4", choices: [{ id: "{date} {time}", checked: true }] });
    expect(group(idle, at, "fileName")?.info).toContain("{date} {time} {year} {month} {day} {hour} {minute} {second}");
    expect(group(idle, { ...at, fileNameTemplate: "Demo {year}{month}{day}-{time}" }, "fileName")?.note).toBe("Example: Demo 20261005-14-02-11.mp4");
    expect(group(idle, { ...at, language: "zh-TW" }, "fileName")).toMatchObject({ label: "檔名格式", note: "範例：2026-10-05 14-02-11.mp4" });
    expect(group(busy[2]!, at, "fileName")?.enabled).toBe(false);
  });
  it("accepts any usable pattern typed, trimmed, and refuses one that cannot name a file or would repeat", () => {
    expect(settingsAction(idle, context, "fileName", "  Demo {date} {time} ")).toEqual({ setFileNameTemplate: "Demo {date} {time}" });
    expect(settingsAction(idle, context, "fileName", "Demo {date}")).toBeUndefined();
    expect(settingsAction(idle, context, "fileName", "a:b {time}")).toBeUndefined();
    expect(settingsAction(idle, context, "fileName", "{time} {weekday}")).toBeUndefined();
    expect(settingsAction(idle, context, "fileName", 42)).toBeUndefined();
    expect(settingsAction(busy[2]!, context, "fileName", "Demo {time}")).toBeUndefined();
    expect(settingsChecked(idle, { ...context, fileNameTemplate: "Demo {time}" }, "fileName", " Demo {time}")).toBe(true);
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
  it("gives Show log a row of its own under Troubleshooting, before separately grouped data cleanup, leaving the credit in General, usable while recording", () => {
    const general = settingsView(idle, context).groups.filter(g => g.tab === "general").map(g => g.id);
    expect(general.at(-1)).toBe("about");
    expect(settingsView(idle, context).groups.filter(g => g.tab === "failures").map(g => g.id)).toEqual(["log", "localData"]);
    expect(group(idle, context, "log")).toMatchObject({ label: "Log file", kind: "actions", tab: "failures", sectionHeading: "Diagnostic tools", choices: [{ id: "show", label: "Show log" }] });
    expect(group(idle, { ...context, language: "zh-TW" }, "log")).toMatchObject({ label: "記錄檔（log）", tab: "failures", sectionHeading: "診斷工具", choices: [{ label: "顯示 log" }] });
    expect(settingsAction(busy[2]!, context, "log", "show")).toBe("revealLog");
    expect(group(idle, context, "about")?.choices.map(c => c.id)).toEqual(["website", "source", "quit", "hide"]);
  });
  it("offers Quit RecordStuff in the window, since closing it leaves the menu-bar recorder running (2026-10-05)", () => {
    expect(group(idle, { ...context, language: "zh-TW" }, "about")?.choices.find(c => c.id === "quit")).toMatchObject({ label: "結束 RecordStuff", enabled: true });
    // Also while recording: the quit waits for the recording to be saved, as the tray's Quit does.
    expect(settingsAction(busy[2]!, context, "about", "quit")).toBe("quit");
    expect(group(idle, { ...context, language: "zh-TW" }, "about")?.choices.find(c => c.id === "hide")).toMatchObject({ label: "隱藏 RecordStuff", enabled: true });
    expect(settingsAction(busy[2]!, context, "about", "hide")).toBe("hideSettings");
    expect(settingsAction(idle, { ...context, quitting: true }, "about", "hide")).toBeUndefined();
  });
});

describe("Keyboard Shortcuts tab (plan 073)", () => {
  const rows = (ctx: AppContext) => settingsView(idle, ctx).groups.filter(g => g.kind === "shortcutList").flatMap(g => g.shortcuts ?? []);
  const row = (ctx: AppContext, id: string) => rows(ctx).find(entry => entry.id === id)!;
  const win: AppContext = { ...context, platform: "win32" };

  it("lists every catalog row read-only on its own tab, offering no choice main would act on", () => {
    const groups = settingsView(idle, context).groups.filter(g => g.kind === "shortcutList");
    expect(groups.every(g => g.tab === "shortcuts" && g.choices.length === 0 && g.actions === undefined)).toBe(true);
    expect(rows(context).map(entry => entry.id)).toEqual(["record", "open", "close", "undoTrash", "zoomIn", "zoomOut", "zoomReset",
      "clearSearch", "playPause", "seek", "volume", "mute", "fullScreen", "seekPage", "seekEnds", "leaveFullScreen"]);
    for (const group of groups) expect(settingsAction(idle, context, group.id, "record"), group.id).toBeUndefined();
  });

  it("shows each platform's keys, symbols on macOS and names elsewhere", () => {
    expect([row(context, "record").keys, row(context, "record").spoken]).toEqual([[["⇧", "⌘", "1"]], ["⇧⌘1"]]);
    expect([row(win, "record").keys, row(win, "record").spoken]).toEqual([[["Ctrl", "Shift", "1"]], ["Ctrl+Shift+1"]]);
    expect(row(context, "open").spoken).toEqual(["⌥⌘,"]);
    expect(row(win, "open").spoken).toEqual(["Ctrl+Shift+,"]);
    expect(row(context, "close").spoken).toEqual(["⌘W", "Esc"]);
    expect(row(win, "close").spoken).toEqual(["Ctrl+W", "Esc"]);
    expect(row(context, "zoomIn").keys).toEqual([["⌘", "+"]]);
    expect(row(win, "zoomOut").keys).toEqual([["Ctrl", "-"]]);
    expect(row(win, "seek").keys).toEqual([["←"], ["→"]]);
    expect(row(context, "seekPage")).toMatchObject({ keys: [["Page Up"], ["Page Down"]], where: "On the seek bar" });
    expect(row(context, "leaveFullScreen")).toMatchObject({ spoken: ["Esc", "⌘W", "F"], gesture: "Double-click" });
  });

  it("follows the recording shortcut's choice and registration, with Change… only there", () => {
    const custom: AppContext = { ...context, hotkey: { enabled: true, accelerator: "CommandOrControl+Alt+R", registered: true } };
    expect(row(custom, "record")).toMatchObject({ spoken: ["⌥⌘R"], change: "Change in General" });
    expect(row(custom, "record")).not.toHaveProperty("status");
    expect(rows(context).filter(entry => entry.change).map(entry => entry.id)).toEqual(["record"]);
    const off: AppContext = { ...custom, hotkey: { ...custom.hotkey, enabled: false } };
    expect(row(off, "record")).toMatchObject({ spoken: ["⌥⌘R"], status: { kind: "off", label: "Off" } });
    const failed: AppContext = { ...context, hotkey: { ...DEFAULT_HOTKEY, registered: false } };
    expect(row(failed, "record").status).toEqual({ kind: "unavailable", label: "Unavailable", reason: "Another app may be using this shortcut." });
    expect(row({ ...failed, language: "zh-TW" }, "record").status?.label).toBe("無法使用");
    expect(row({ ...failed, platform: "win32" }, "record").status?.kind).toBe("unavailable");
  });

  it("marks Open RecordStuff unavailable when its registration failed or the recording shortcut took it", () => {
    expect(row(context, "open")).not.toHaveProperty("status");
    expect(row({ ...context, settingsShortcut: { kind: "failed", accelerator: SETTINGS_SHORTCUT, reason: "taken" } }, "open").status)
      .toEqual({ kind: "unavailable", label: "Unavailable", reason: "Another app may be using ⌥⌘,." });
    expect(row({ ...win, settingsShortcut: { kind: "conflict" } }, "open").status)
      .toEqual({ kind: "unavailable", label: "Unavailable", reason: "Ctrl+Shift+, is the recording shortcut, so it does not open RecordStuff." });
  });
});
