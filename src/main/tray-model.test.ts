import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import type { RecordingState } from "../shared/state";
import { DEFAULT_HOTKEY, HOTKEY_PRESETS } from "../shared/hotkey";
import {
  abbreviateHome,
  errorNotification,
  frameRateDowngradeNotification,
  hotkeyRegistrationFailedNotification,
  savedNotification,
  trayModel,
  type TrayContext,
  type TrayMenuItem,
} from "./tray-model";

const mac: TrayContext = {
  platform: "darwin",
  language: "zh-TW",
  outputDir: "/Users/eric/Movies/RecordStuff",
  homeDir: "/Users/eric",
  quality: DEFAULT_QUALITY,
};
const win: TrayContext = {
  platform: "win32",
  language: "zh-TW",
  outputDir: "C:\\Users\\eric\\Videos\\RecordStuff",
  homeDir: "C:\\Users\\eric",
  quality: DEFAULT_QUALITY,
};

const labels = (menu: TrayMenuItem[]) => menu.map((m) => (m.kind === "separator" ? "—" : m.label));
const enabledActions = (menu: TrayMenuItem[]) =>
  menu.flatMap((m) => (m.kind === "item" && m.enabled && m.action ? [m.action] : []));
const submenu = (menu: TrayMenuItem[], label: string): TrayMenuItem[] => {
  const entry = menu.find((m) => m.kind === "submenu" && m.label === label);
  if (!entry || entry.kind !== "submenu") throw new Error(`no submenu ${label}`);
  return entry.items;
};
const qualitySubmenus = (menu: TrayMenuItem[]) => submenu(menu, "錄製品質").map((m) => (m.kind === "submenu" ? m.label : m.kind));

describe("abbreviateHome", () => {
  it("replaces the home prefix on both path styles", () => {
    expect(abbreviateHome("/Users/eric/Movies/RecordStuff", "/Users/eric")).toBe("~/Movies/RecordStuff");
    expect(abbreviateHome("C:\\Users\\eric\\Videos\\RecordStuff", "C:\\Users\\eric")).toBe("~\\Videos\\RecordStuff");
    expect(abbreviateHome("/Volumes/Ext/Rec", "/Users/eric")).toBe("/Volumes/Ext/Rec");
    expect(abbreviateHome("/Users/eric", "/Users/eric")).toBe("~");
    expect(abbreviateHome("/Users/erica/x", "/Users/eric")).toBe("/Users/erica/x");
  });
});

describe("trayModel per state (docs/system-design/recording.md)", () => {
  it("needsPermission shows the settings action", () => {
    const m = trayModel({ type: "needsPermission", needsRelaunch: false }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual([
      "需要螢幕錄製權限",
      "開啟系統設定",
      "已經允許了？重新啟動 RecordStuff",
      "—",
      "儲存位置：~/Movies/RecordStuff",
      "更改儲存位置…",
      "錄製品質",
      "—",
      "語言",
      "顯示 log",
      "結束",
    ]);
    expect(m.menu[0]).toMatchObject({ enabled: false });
    expect(enabledActions(m.menu)).toEqual([
      "openPermissionSettings",
      "relaunch",
      "openOutputDir",
      "changeOutputDir",
      "revealLog",
      "quit",
    ]);
  });

  // after the user grants the permission, macOS keeps refusing this
  // process, so stage 1 never reports granted and `needsRelaunch` stays false.
  // A restart is the only way out, so it must be reachable in this state too.
  it("needsPermission offers the relaunch even while needsRelaunch is false", () => {
    const m = trayModel({ type: "needsPermission", needsRelaunch: false }, mac);
    const relaunch = m.menu.find((entry) => entry.kind === "item" && entry.action === "relaunch");
    expect(relaunch).toMatchObject({ kind: "item", enabled: true });
    // The wording must not claim a grant we cannot see, and must say why a
    // restart is needed.
    expect(relaunch && relaunch.kind === "item" ? relaunch.toolTip : undefined).toContain("重新啟動");
  });

  it("needsPermission with needsRelaunch shows only the relaunch", () => {
    const m = trayModel({ type: "needsPermission", needsRelaunch: true }, mac);
    expect(labels(m.menu)[1]).toBe("重新啟動");
    expect(enabledActions(m.menu)).toContain("relaunch");
    expect(enabledActions(m.menu)).not.toContain("openPermissionSettings");
  });

  it("idle without a last recording", () => {
    const m = trayModel({ type: "idle" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual([
      "待命中",
      "—",
      "儲存位置：~/Movies/RecordStuff",
      "更改儲存位置…",
      "錄製品質",
      "—",
      "語言",
      "顯示 log",
      "結束",
    ]);
    expect(enabledActions(m.menu)).toEqual(["openOutputDir", "changeOutputDir", "revealLog", "quit"]);
  });

  it("idle with a last recording adds the reveal item", () => {
    const m = trayModel({ type: "idle", lastSavedPath: "/Users/eric/Movies/RecordStuff/a.mp4" }, mac);
    expect(labels(m.menu)[1]).toBe("顯示最後一個錄影");
    expect(enabledActions(m.menu)).toEqual(["revealLastSaved", "openOutputDir", "changeOutputDir", "revealLog", "quit"]);
  });

  it("idle with an unusable output dir says so on the first line", () => {
    const m = trayModel({ type: "idle", outputDirUnavailable: true }, mac);
    expect(labels(m.menu)[0]).toBe("儲存位置無法使用");
    expect(enabledActions(m.menu)).toContain("changeOutputDir");
  });

  it("starting: idle icon, ellipsis title, language, log and quit", () => {
    const m = trayModel({ type: "starting" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("…");
    expect(labels(m.menu)).toEqual(["啟動中，請留意系統權限提示…", "—", "錄製品質", "—", "語言", "顯示 log", "結束"]);
    expect(m.menu[2]).toEqual({ kind: "item", label: "錄製品質", enabled: false });
    expect(enabledActions(m.menu)).toEqual(["revealLog", "quit"]);
  });

  it("recording: red icon, REC title, stop; output dir items greyed", () => {
    const m = trayModel({ type: "recording", startedAt: "2026-09-11T06:30:00Z" }, mac);
    expect(m.icon).toBe("recording");
    expect(m.title).toBe("REC");
    expect(labels(m.menu)).toEqual([
      "錄製中",
      "停止",
      "—",
      "儲存位置：~/Movies/RecordStuff",
      "更改儲存位置…",
      "錄製品質",
      "—",
      "語言",
      "顯示 log",
      "結束",
    ]);
    expect(m.menu[5]).toEqual({ kind: "item", label: "錄製品質", enabled: false });
    expect(enabledActions(m.menu)).toEqual(["stop", "revealLog", "quit"]);
  });

  it("stopping: idle icon, ellipsis, language, log and quit", () => {
    const m = trayModel({ type: "stopping" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("…");
    expect(labels(m.menu)).toEqual(["儲存中…", "—", "錄製品質", "—", "語言", "顯示 log", "結束"]);
    expect(m.menu[2]).toEqual({ kind: "item", label: "錄製品質", enabled: false });
    expect(enabledActions(m.menu)).toEqual(["revealLog", "quit"]);
  });

  it("Windows shows the abbreviated path and keeps the full path as toolTip", () => {
    const m = trayModel({ type: "idle" }, win);
    const dirItem = m.menu.find((i) => i.kind === "item" && i.action === "openOutputDir");
    expect(dirItem).toMatchObject({ label: "儲存位置：~\\Videos\\RecordStuff", toolTip: win.outputDir });
  });

  it("every state ends with enabled Show log and Quit actions", () => {
    const states: RecordingState[] = [
      { type: "needsPermission", needsRelaunch: false },
      { type: "idle" },
      { type: "starting" },
      { type: "recording", startedAt: "" },
      { type: "stopping" },
    ];
    for (const state of states) {
      const menu = trayModel(state, mac).menu;
      expect(menu.at(-4)).toEqual({ kind: "separator" });
      expect(menu.at(-2)).toMatchObject({ label: "顯示 log", action: "revealLog", enabled: true });
      expect(menu.at(-1)).toMatchObject({ label: "結束", action: "quit", enabled: true });
    }
  });
});

describe("Recording quality submenu", () => {
  it("shows the three groups with their current value in the label", () => {
    const m = trayModel({ type: "idle" }, mac);
    expect(qualitySubmenus(m.menu)).toEqual([
      "影像品質：標準",
      "解析度上限：原尺寸",
      "幀率：30 fps",
    ]);
    const custom = trayModel(
      { type: "idle" },
      { ...mac, quality: { videoQuality: "economy", resolutionCap: "1080p", frameRate: 60 } },
    );
    expect(qualitySubmenus(custom.menu)).toEqual([
      "影像品質：精省",
      "解析度上限：1080p",
      "幀率：60 fps",
    ]);
  });

  it("each group is a radio list with exactly the current choice checked and a setQuality action", () => {
    const m = trayModel({ type: "idle" }, mac);
    const groups = submenu(m.menu, "錄製品質");
    const video = groups[0];
    expect(video?.kind).toBe("submenu");
    if (video?.kind !== "submenu") return;
    expect(video.items).toEqual([
      { kind: "radio", label: "精省", enabled: true, checked: false, action: { setQuality: { videoQuality: "economy" } } },
      { kind: "radio", label: "標準", enabled: true, checked: true, action: { setQuality: { videoQuality: "standard" } } },
      { kind: "radio", label: "高品質", enabled: true, checked: false, action: { setQuality: { videoQuality: "high" } } },
    ]);
    for (const group of groups) {
      if (group.kind !== "submenu") continue;
      expect(group.items.filter((i) => i.kind === "radio" && i.checked)).toHaveLength(1);
    }
    const cap = groups[1];
    if (cap?.kind === "submenu") {
      expect(cap.items.map((i) => (i.kind === "radio" ? i.label : ""))).toEqual(["1080p", "1440p", "4K", "原尺寸"]);
    }
  });

  it("offers 60 fps on macOS and disables it with an explanation on Windows", () => {
    const macFps = submenu(trayModel({ type: "idle" }, mac).menu, "錄製品質")[2];
    if (macFps?.kind !== "submenu") throw new Error("no fps submenu");
    expect(macFps.items).toEqual([
      { kind: "radio", label: "30 fps", enabled: true, checked: true, action: { setQuality: { frameRate: 30 } } },
      { kind: "radio", label: "60 fps", enabled: true, checked: false, action: { setQuality: { frameRate: 60 } } },
    ]);
    const winFps = submenu(trayModel({ type: "idle" }, win).menu, "錄製品質")[2];
    if (winFps?.kind !== "submenu") throw new Error("no fps submenu");
    expect(winFps.items[1]).toMatchObject({ label: "60 fps（此平台尚未驗證，暫不開放）", enabled: false, checked: false });
  });

  it("is available in needsPermission too", () => {
    const m = trayModel({ type: "needsPermission", needsRelaunch: false }, mac);
    expect(qualitySubmenus(m.menu)).toHaveLength(3);
  });
});

describe("notification text", () => {
  it("frame-rate downgrade names both numbers", () => {
    expect(frameRateDowngradeNotification(60, 30, "zh-TW").body).toBe("系統只提供 30 fps，本次以 30 fps 錄製（設定為 60 fps）");
  });

  it("saved notification uses the file name", () => {
    expect(savedNotification("/Users/eric/Movies/RecordStuff/2026-09-11 14-30-00.mp4", "zh-TW").body).toBe(
      "已儲存 2026-09-11 14-30-00.mp4",
    );
  });

  it("errors with a partial file mention it; without one say nothing was recorded", () => {
    const kept = errorNotification("capture_host_crashed", "/x/2026-09-11 14-30-00.recording.mp4", mac);
    expect(kept.body).toContain("2026-09-11 14-30-00.recording.mp4");
    const none = errorNotification("capture_start_failed", undefined, mac);
    expect(none.body).toContain("沒有錄到任何內容");
  });

  it("output_open_failed names the folder and the menu action", () => {
    const text = errorNotification("output_open_failed", undefined, mac);
    expect(text.body).toBe("儲存位置無法寫入：~/Movies/RecordStuff。右鍵選單可以更改儲存位置");
  });
});

describe("English default and language switching", () => {
  it("defaults an older context to English and exposes both language actions", () => {
    const { language: _language, ...ctx } = mac;
    const m = trayModel({ type: "idle" }, ctx);
    expect(labels(m.menu)[0]).toBe("Ready");
    expect(submenu(m.menu, "Language")).toEqual([
      { kind: "radio", label: "English", enabled: true, checked: true, action: { setLanguage: "en" } },
      { kind: "radio", label: "繁體中文", enabled: true, checked: false, action: { setLanguage: "zh-TW" } },
    ]);
    expect(savedNotification("/tmp/demo.mp4").body).toBe("Saved demo.mp4");
  });

  it("changes presentation during recording without changing recording controls", () => {
    const state: RecordingState = { type: "recording", startedAt: "2026-09-14T00:00:00Z" };
    const english = trayModel(state, { ...mac, language: "en" });
    const chinese = trayModel(state, { ...mac, language: "zh-TW" });
    expect(english.title).toBe("REC");
    expect(chinese.title).toBe("REC");
    expect(english.tooltip).toBe("RecordStuff: Recording");
    expect(chinese.tooltip).toBe("RecordStuff: 錄製中");
    expect(enabledActions(english.menu)).toEqual(enabledActions(chinese.menu));
    expect(submenu(chinese.menu, "語言")[1]).toMatchObject({ checked: true });
    expect(english.menu.find((m) => m.kind === "item" && m.label === "Recording quality")).toMatchObject({ enabled: false });
    expect(state.type).toBe("recording");
  });
});

describe("Shortcut submenu (plan 016)", () => {
  const withHotkey = (registered = true, enabled = true): TrayContext => ({
    ...mac,
    language: "en",
    hotkey: { ...DEFAULT_HOTKEY, enabled, registered },
  });
  const shortcutEntry = (menu: TrayMenuItem[]) =>
    menu.find((m) => m.kind === "submenu" && (m.label.startsWith("Shortcut") || m.label.startsWith("快捷鍵")));

  it("is absent for callers that do not provide a hotkey context", () => {
    expect(shortcutEntry(trayModel({ type: "idle" }, mac).menu)).toBeUndefined();
  });

  it("shows the registered accelerator with macOS symbols, one radio per preset plus Off", () => {
    const m = trayModel({ type: "idle" }, withHotkey());
    const entry = shortcutEntry(m.menu);
    expect(entry).toMatchObject({ kind: "submenu", label: "Shortcut: ⌘⌥⇧R", enabled: true });
    const items = submenu(m.menu, "Shortcut: ⌘⌥⇧R");
    expect(items).toEqual([
      { kind: "radio", label: "⌘⌥⇧R", enabled: true, checked: true, action: { setHotkey: { enabled: true, accelerator: HOTKEY_PRESETS[0] } } },
      { kind: "radio", label: "⌘⇧R", enabled: true, checked: false, action: { setHotkey: { enabled: true, accelerator: HOTKEY_PRESETS[1] } } },
      { kind: "radio", label: "⌘⌥R", enabled: true, checked: false, action: { setHotkey: { enabled: true, accelerator: HOTKEY_PRESETS[2] } } },
      { kind: "radio", label: "Off", enabled: true, checked: false, action: { setHotkey: { enabled: false, accelerator: HOTKEY_PRESETS[0] } } },
    ]);
    // Electron splits radio groups at separators and checks one item per group:
    // Off must share the presets' group or it would show checked too (review F1).
    expect(items.some((i) => i.kind === "separator")).toBe(false);
    expect(items.filter((i) => i.kind === "radio" && i.checked)).toHaveLength(1);
    // The menu sits between quality and the footer in every state that shows it.
    const names = labels(m.menu);
    expect(names.indexOf("Shortcut: ⌘⌥⇧R")).toBe(names.indexOf("Recording quality") + 1);
  });

  it("spells out a refused registration instead of hiding the conflict", () => {
    const m = trayModel({ type: "idle" }, withHotkey(false));
    expect(shortcutEntry(m.menu)).toMatchObject({ label: "Shortcut unavailable (in use by another app): ⌘⌥⇧R", enabled: true });
    const zh = trayModel({ type: "idle" }, { ...withHotkey(false), language: "zh-TW" });
    expect(labels(zh.menu)).toContain("快捷鍵無法使用（被其他 App 佔用）：⌘⌥⇧R");
    expect(hotkeyRegistrationFailedNotification(HOTKEY_PRESETS[0], "darwin", "zh-TW").body).toBe(
      "無法註冊快捷鍵 ⌘⌥⇧R，可能被其他 App 佔用。右鍵選單可以改用其他快捷鍵",
    );
    expect(hotkeyRegistrationFailedNotification(HOTKEY_PRESETS[0], "win32").body).toContain("Ctrl+Alt+Shift+R");
  });

  it("Off is checked while disabled and the remembered accelerator is kept in the Off action", () => {
    const m = trayModel({ type: "idle" }, { ...mac, hotkey: { enabled: false, accelerator: HOTKEY_PRESETS[1], registered: false } });
    expect(shortcutEntry(m.menu)).toMatchObject({ label: "快捷鍵：關閉", enabled: true });
    const items = submenu(m.menu, "快捷鍵：關閉");
    expect(items.filter((i) => i.kind === "radio" && i.checked).map((i) => (i.kind === "radio" ? i.label : ""))).toEqual(["關閉"]);
    expect(items.at(-1)).toMatchObject({ action: { setHotkey: { enabled: false, accelerator: HOTKEY_PRESETS[1] } } });
  });

  it("is visible but locked outside idle/needsPermission, like quality", () => {
    const ctx = withHotkey();
    expect(shortcutEntry(trayModel({ type: "needsPermission", needsRelaunch: false }, ctx).menu)).toMatchObject({ enabled: true });
    for (const state of [
      { type: "starting" },
      { type: "recording", startedAt: "2026-09-14T00:00:00Z" },
      { type: "stopping" },
    ] as RecordingState[]) {
      expect(shortcutEntry(trayModel(state, ctx).menu)).toMatchObject({ label: "Shortcut: ⌘⌥⇧R", enabled: false });
    }
  });

  it("uses Windows-style names off macOS and reminds of the shortcut on Stop", () => {
    const m = trayModel({ type: "idle" }, { ...win, language: "en", hotkey: { ...DEFAULT_HOTKEY, registered: true } });
    expect(shortcutEntry(m.menu)).toMatchObject({ label: "Shortcut: Ctrl+Alt+Shift+R" });
    const rec = trayModel({ type: "recording", startedAt: "2026-09-14T00:00:00Z" }, withHotkey());
    expect(rec.menu.find((i) => i.kind === "item" && i.label === "Stop")).toMatchObject({
      toolTip: "Start / stop recording with ⌘⌥⇧R",
    });
    const unregistered = trayModel({ type: "recording", startedAt: "2026-09-14T00:00:00Z" }, withHotkey(false));
    expect(unregistered.menu.find((i) => i.kind === "item" && i.label === "Stop")).not.toHaveProperty("toolTip");
  });
});
