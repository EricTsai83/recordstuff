import { describe, expect, it } from "vitest";
import type { AppContext } from "../../app/ui-model";
import { DEFAULT_CAMERA_LAYOUT } from "../../../shared/camera-layout";
import { DEFAULT_HOTKEY } from "../../../shared/hotkey";
import { DEFAULT_QUALITY } from "../../../shared/quality";
import type { RecordingState } from "../../../shared/state";
import { settingsAction, settingsChecked, settingsView } from "../settings-model";

const idle: RecordingState = { type: "idle" };
const base: AppContext = {
  platform: "darwin", outputDir: "/tmp/recordings", homeDir: "/tmp", quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true,
  language: "en", hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: "idle" }, enabled: true }, notifications: true,
  displays: [], display: { kind: "primary" },
  microphone: { enabled: true, access: "not-determined" },
  camera: { enabled: true, available: true, access: "not-determined", layout: DEFAULT_CAMERA_LAYOUT },
};
const open = (ctx: Partial<AppContext> = {}): AppContext => ({ ...base, onboarding: { open: true }, ...ctx });
const offered = (state: RecordingState, ctx: AppContext): string[] =>
  ["screen:open", "screen:relaunch", "microphone:on", "microphone:off", "microphone:allow", "microphone:settings",
    "camera:on", "camera:off", "camera:allow", "camera:settings", "finish", "studio"].filter(choice => settingsAction(state, ctx, "onboarding", choice));

describe("the first-launch guide (2026-10-26)", () => {
  it("is in the view only while open on macOS, and never while a quit runs", () => {
    expect(settingsView(idle, base).onboarding).toBeUndefined();
    expect(settingsView(idle, open({ platform: "win32" })).onboarding).toBeUndefined();
    expect(settingsView(idle, open({ quitting: true })).onboarding).toBeUndefined();
    expect(settingsView(idle, open()).onboarding).toEqual({
      screen: "granted",
      microphone: { enabled: true, access: "ask", locked: false },
      camera: { enabled: true, access: "ask", locked: false },
      shortcut: "⇧⌘1",
    });
  });

  it("says where the screen's grant stands and offers System Settings and a relaunch until it is allowed", () => {
    const needed: RecordingState = { type: "needsPermission", needsRelaunch: false };
    const relaunch: RecordingState = { type: "needsPermission", needsRelaunch: true };
    expect(settingsView(needed, open()).onboarding?.screen).toBe("needed");
    expect(settingsView(relaunch, open()).onboarding?.screen).toBe("relaunch");
    expect(settingsAction(needed, open(), "onboarding", "screen:open")).toBe("openPermissionSettings");
    expect(settingsAction(relaunch, open(), "onboarding", "screen:relaunch")).toBe("relaunch");
    expect(settingsAction(idle, open(), "onboarding", "screen:open")).toBeUndefined();
  });

  it("takes the screen first: no input's switch or Allow is offered until it is allowed (native round)", () => {
    const needed: RecordingState = { type: "needsPermission", needsRelaunch: true };
    expect(offered(needed, open())).toEqual(["screen:open", "screen:relaunch", "finish", "studio"]);
  });

  it("asks macOS only through Allow, for an input that is on and never asked", () => {
    expect(settingsAction(idle, open(), "onboarding", "microphone:allow")).toBe("askMicrophone");
    expect(settingsAction(idle, open(), "onboarding", "camera:allow")).toBe("askCamera");
    const off = open({ microphone: { enabled: false, access: "not-determined" } });
    expect(settingsAction(idle, off, "onboarding", "microphone:allow")).toBeUndefined();
    const granted = open({ microphone: { enabled: true, access: "granted" } });
    expect(settingsView(idle, granted).onboarding?.microphone.access).toBe("granted");
    expect(settingsAction(idle, granted, "onboarding", "microphone:allow")).toBeUndefined();
  });

  it("offers System Settings for a refused input, which reads as refused even with its switch off", () => {
    const refused = open({ camera: { enabled: false, available: true, access: "denied", layout: DEFAULT_CAMERA_LAYOUT } });
    expect(settingsView(idle, refused).onboarding?.camera).toEqual({ enabled: false, access: "denied", locked: false });
    expect(settingsAction(idle, refused, "onboarding", "camera:settings")).toBe("openCameraSettings");
    expect(settingsAction(idle, refused, "onboarding", "camera:allow")).toBeUndefined();
  });

  it("switches an input's own setting without asking, and reports a switch applied only when it reads so", () => {
    // The guide's own switches save only, so turning one back on never asks macOS (review F2).
    expect(settingsAction(idle, open(), "onboarding", "microphone:off")).toEqual({ setOnboardingInput: { input: "microphone", enabled: false } });
    expect(settingsAction(idle, open(), "onboarding", "camera:on")).toEqual({ setOnboardingInput: { input: "camera", enabled: true } });
    expect(settingsChecked(idle, open(), "onboarding", "microphone:on")).toBe(true);
    expect(settingsChecked(idle, open(), "onboarding", "microphone:off")).toBe(false);
    expect(settingsChecked(idle, open(), "onboarding", "finish")).toBe(true);
  });

  it("locks the inputs while recording, keeping the way to finish", () => {
    const recording: RecordingState = { type: "recording", startedAt: new Date().toISOString() };
    expect(settingsView(recording, open()).onboarding?.microphone.locked).toBe(true);
    expect(offered(recording, open())).toEqual(["finish", "studio"]);
  });

  it("leaves out the camera where there is none, and the shortcut while it is off", () => {
    const view = settingsView(idle, open({ camera: { enabled: false, available: false, layout: DEFAULT_CAMERA_LAYOUT },
      hotkey: { ...DEFAULT_HOTKEY, enabled: false, registered: false } })).onboarding;
    expect(view).not.toHaveProperty("camera");
    expect(view).not.toHaveProperty("shortcut");
  });

  it("finishes, or finishes into the Recording Studio, and offers nothing once closed", () => {
    expect(settingsAction(idle, open(), "onboarding", "finish")).toEqual({ finishOnboarding: {} });
    expect(settingsAction(idle, open(), "onboarding", "studio")).toEqual({ finishOnboarding: { then: "studio" } });
    expect(offered(idle, base)).toEqual([]);
  });

  it("is opened again from General on macOS only", () => {
    const row = settingsView(idle, base).groups.find(group => group.id === "setupGuide");
    expect(row).toMatchObject({ tab: "general", kind: "actions", sectionHeading: "Getting started", choices: [{ id: "open", label: "Open setup guide…" }] });
    expect(settingsAction(idle, base, "setupGuide", "open")).toBe("showOnboarding");
    expect(settingsView(idle, { ...base, platform: "win32" }).groups.some(group => group.id === "setupGuide")).toBe(false);
  });
});
