import { describe, expect, it } from "vitest";
import type { RecordingResultView, SettingsGroup, SettingsView } from "../../../shared/settings-panel";
import { settingsNews } from "./news";

const group = (fields: Partial<SettingsGroup> = {}): SettingsGroup => ({ id: "updates", label: "Updates", tab: "general", control: "select",
  enabled: true, choices: [], noteKind: "status", ...fields } as SettingsGroup);
const result = (id: string, fields: Partial<RecordingResultView> = {}): RecordingResultView => ({ id, code: "capture_failed", outcomeState: "empty",
  reason: `Capture ${id} stopped.`, day: "Today", time: "2:02 PM", outcome: "No recording was kept.", guidance: "", actions: [], acknowledged: false,
  ...fields } as RecordingResultView);
const view = (fields: Partial<SettingsView> = {}): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "",
  tabs: [], groups: [group()], ...fields });
const context = { selectedTab: "general" as const, returned: new Set<string>() };

describe("what the Settings page reads out", () => {
  it("reads a note that changed on the open tab, and nothing when only the language changed", () => {
    const noted = view({ groups: [group({ note: "RecordStuff is up to date." })] });
    expect(settingsNews(view(), noted, context)).toBe("RecordStuff is up to date.");
    expect(settingsNews(view(), noted, { ...context, selectedTab: "recording" })).toBe("");
    expect(settingsNews(view({ language: "zh-TW" }), noted, context)).toBe("");
    expect(settingsNews(noted, noted, context)).toBe("");
  });

  it("reads a new failure before older news, but not rows paged in or the history arriving from disk", () => {
    const known = result("a");
    const before = view({ groups: [group()], recordingResults: [known] });
    expect(settingsNews(before, view({ groups: [group({ note: "Checking…" })], recordingResults: [result("new"), known] }), context))
      .toBe("Capture new stopped. No recording was kept. Checking…");
    expect(settingsNews(before, view({ recordingResults: [known, result("older")] }), context)).toBe("");
    expect(settingsNews(view({ recordingHistoryStatus: "Loading…" } as Partial<SettingsView>), view({ recordingResults: [result("a")] }), context)).toBe("");
  });

  it("says a state the status card newly shows once, and why main ended the shortcut editor first", () => {
    const counting = (title: string): SettingsView => view({ status: { tone: "busy", phase: "countdown", title, detail: "" } });
    expect(settingsNews(view(), counting("Starting in 3"), context)).toBe("Starting in 3.");
    expect(settingsNews(counting("Starting in 3"), counting("Starting in 2"), context)).toBe("");
    expect(settingsNews(view(), view(), { ...context, endedNotice: "Editing ended; the shortcut is unchanged." }))
      .toBe("Editing ended; the shortcut is unchanged.");
  });
});
