import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import type { RecordingState } from "../shared/state";
import { DEFAULT_HOTKEY, HOTKEY_PRESETS } from "../shared/hotkey";
import {
  errorNotification,
  frameRateDowngradeNotification,
  hotkeyRegistrationFailedNotification,
  savedNotification,
  trayModel,
  type TrayMenuItem,
} from "./tray-model";
import type { AppContext } from "./ui-model";

const mac: AppContext = {
  platform: "darwin",
  language: "zh-TW",
  outputDir: "/Users/eric/Movies/RecordStuff",
  homeDir: "/Users/eric",
  quality: DEFAULT_QUALITY,
  hotkey: { ...DEFAULT_HOTKEY, registered: true },
  updates: { state: { kind: "idle" }, enabled: true },
};
const win: AppContext = {
  platform: "win32",
  language: "zh-TW",
  outputDir: "C:\\Users\\eric\\Videos\\RecordStuff",
  homeDir: "C:\\Users\\eric",
  quality: DEFAULT_QUALITY,
  hotkey: { ...DEFAULT_HOTKEY, registered: true },
  updates: { state: { kind: "idle" }, enabled: true },
};
const STATES: RecordingState[] = [
  { type: "needsPermission", needsRelaunch: false },
  { type: "needsPermission", needsRelaunch: true },
  { type: "idle" },
  { type: "idle", lastSavedPath: "/tmp/a.mp4" },
  { type: "starting" },
  { type: "recording", startedAt: "2026-09-14T00:00:00Z" },
  { type: "stopping" },
];

const labels = (menu: TrayMenuItem[]) => menu.map((m) => (m.kind === "separator" ? "—" : m.label));
const enabledActions = (menu: TrayMenuItem[]) =>
  menu.flatMap((m) => (m.kind === "item" && m.enabled && m.action ? [m.action] : []));

describe("trayModel per state (docs/system-design/desktop.md)", () => {
  it("needsPermission shows the permission actions above the folder and Settings", () => {
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
      "檢查更新…",
      "—",
      "設定…",
      "顯示 log",
      "結束",
    ]);
    expect(m.menu[0]).toMatchObject({ enabled: false });
    expect(enabledActions(m.menu)).toEqual([
      "openPermissionSettings",
      "relaunch",
      "openOutputDir",
      "changeOutputDir",
      "checkUpdates",
      "openSettings",
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
      "檢查更新…",
      "—",
      "設定…",
      "顯示 log",
      "結束",
    ]);
    expect(enabledActions(m.menu)).toEqual([
      "openOutputDir",
      "changeOutputDir",
      "checkUpdates",
      "openSettings",
      "revealLog",
      "quit",
    ]);
  });

  it("idle with a last recording adds the reveal item", () => {
    const m = trayModel({ type: "idle", lastSavedPath: "/Users/eric/Movies/RecordStuff/a.mp4" }, mac);
    expect(labels(m.menu)[1]).toBe("顯示最後一個錄影");
    expect(enabledActions(m.menu)[0]).toBe("revealLastSaved");
  });

  it("idle with an unusable output dir says so on the first line", () => {
    const m = trayModel({ type: "idle", outputDirUnavailable: true }, mac);
    expect(labels(m.menu)[0]).toBe("儲存位置無法使用");
    expect(enabledActions(m.menu)).toContain("changeOutputDir");
  });

  it("starting: idle icon, ellipsis title, Settings, log and quit", () => {
    const m = trayModel({ type: "starting" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("…");
    expect(labels(m.menu)).toEqual(["啟動中，請留意系統權限提示…", "檢查更新…", "—", "設定…", "顯示 log", "結束"]);
    expect(enabledActions(m.menu)).toEqual(["openSettings", "revealLog", "quit"]);
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
      "檢查更新…",
      "—",
      "設定…",
      "顯示 log",
      "結束",
    ]);
    expect(enabledActions(m.menu)).toEqual(["stop", "openSettings", "revealLog", "quit"]);
  });

  it("stopping: idle icon, ellipsis, Settings, log and quit", () => {
    const m = trayModel({ type: "stopping" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("…");
    expect(labels(m.menu)).toEqual(["儲存中…", "檢查更新…", "—", "設定…", "顯示 log", "結束"]);
    expect(enabledActions(m.menu)).toEqual(["openSettings", "revealLog", "quit"]);
  });

  it("Windows shows the abbreviated path and keeps the full path as toolTip", () => {
    const m = trayModel({ type: "idle" }, win);
    const dirItem = m.menu.find((i) => i.kind === "item" && i.action === "openOutputDir");
    expect(dirItem).toMatchObject({ label: "儲存位置：~\\Videos\\RecordStuff", toolTip: win.outputDir });
  });

  it("is a flat command list in every state: no preference ever renders in the tray", () => {
    for (const state of STATES) {
      const menu = trayModel(state, { ...mac, hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: "available", version: "9.0.0" }, enabled: true } }).menu;
      expect(menu.every((entry) => entry.kind === "separator" || entry.kind === "item"), state.type).toBe(true);
      const actions = menu.flatMap((entry) => (entry.kind === "item" && entry.action ? [entry.action] : []));
      expect(actions.every((action) => typeof action === "string"), state.type).toBe(true);
    }
  });

  it("every state ends with enabled Settings, Show log and Quit", () => {
    for (const state of STATES) {
      const menu = trayModel(state, mac).menu;
      expect(menu.at(-4), state.type).toEqual({ kind: "separator" });
      expect(menu.at(-3)).toMatchObject({ label: "設定…", action: "openSettings", enabled: true });
      expect(menu.at(-2)).toMatchObject({ label: "顯示 log", action: "revealLog", enabled: true });
      expect(menu.at(-1)).toMatchObject({ label: "結束", action: "quit", enabled: true });
    }
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

  it("a refused shortcut registration points at Settings, in the user's language", () => {
    expect(hotkeyRegistrationFailedNotification(HOTKEY_PRESETS[0], "darwin", "zh-TW").body).toBe(
      "無法註冊快捷鍵 ⌘⌥⇧R，可能被其他 App 佔用。可以在設定視窗改用其他快捷鍵",
    );
    expect(hotkeyRegistrationFailedNotification(HOTKEY_PRESETS[0], "win32").body).toContain("Ctrl+Alt+Shift+R");
  });
});

describe("English default and language switching", () => {
  it("renders the explicit English context", () => {
    const ctx = { ...mac, language: "en" as const };
    const m = trayModel({ type: "idle" }, ctx);
    expect(labels(m.menu)[0]).toBe("Ready");
    expect(labels(m.menu)).toContain("Settings…");
    expect(savedNotification("/tmp/demo.mp4").body).toBe("Saved demo.mp4");
  });

  it("changes presentation during recording without changing recording controls", () => {
    const state: RecordingState = { type: "recording", startedAt: "2026-09-14T00:00:00Z" };
    const english = trayModel(state, { ...mac, language: "en" });
    const chinese = trayModel(state, { ...mac, language: "zh-TW" });
    expect(english.title).toBe("REC");
    expect(chinese.title).toBe("REC");
    expect(english.tooltip).toBe("RecordStuff: Recording\nRight-click to open the menu");
    expect(chinese.tooltip).toBe("RecordStuff: 錄製中\n右鍵開啟選單");
    expect(enabledActions(english.menu)).toEqual(enabledActions(chinese.menu));
    expect(state.type).toBe("recording");
  });
});

describe("Stop tooltip (plan 016)", () => {
  const withHotkey = (registered = true, enabled = true): AppContext => ({
    ...mac,
    language: "en",
    hotkey: { ...DEFAULT_HOTKEY, enabled, registered },
  });
  const stop = (ctx: AppContext) =>
    trayModel({ type: "recording", startedAt: "2026-09-14T00:00:00Z" }, ctx).menu.find(
      (i) => i.kind === "item" && i.action === "stop",
    );

  it("names the registered accelerator with macOS symbols", () => {
    expect(stop(withHotkey())).toMatchObject({ toolTip: "Start / stop recording with ⌘⌥⇧R" });
  });

  it("says nothing when the shortcut is off or unregistered", () => {
    expect(stop(withHotkey(false))).not.toHaveProperty("toolTip");
    expect(stop(withHotkey(true, false))).not.toHaveProperty("toolTip");
  });
});

describe("update menu", () => {
  it("shows bilingual results and retry while leaving the recording title alone", () => {
    for (const language of ["en", "zh-TW"] as const) {
      const ctx: AppContext = { ...mac, language, updates: { state: { kind: "available", version: "0.2.0" }, enabled: true } };
      const model = trayModel({ type: "idle" }, ctx);
      expect(model.title).toBe("");
      expect(labels(model.menu)).toContain(language === "en" ? "Update available: 0.2.0" : "有可用更新：0.2.0");
      expect(enabledActions(model.menu)).toContain("openUpdate");
      expect(enabledActions(model.menu)).toContain("checkUpdates");
    }
  });
  it("keeps recording controls at the top and hides update results throughout capture", () => {
    const ctx: AppContext = { ...mac, updates: { state: { kind: "available", version: "0.2.0" }, enabled: true } };
    const recording = trayModel({ type: "recording", startedAt: "2026-09-20T00:00:00Z" }, ctx);
    expect(labels(recording.menu).slice(0, 2)).toEqual(["錄製中", "停止"]);
    expect(recording.title).toBe("REC");
    for (const state of [{ type: "starting" }, { type: "recording", startedAt: "2026-09-20T00:00:00Z" }, { type: "stopping" }] as RecordingState[]) {
      const menu = trayModel(state, ctx).menu;
      expect(labels(menu).join()).not.toContain("0.2.0");
      expect(enabledActions(menu)).not.toContain("checkUpdates");
      expect(enabledActions(menu)).not.toContain("openUpdate");
    }
  });
  it("disables checks while pending and shows a successful local timestamp", () => {
    const context: AppContext = { ...mac, updates: { state: { kind: "checking" }, enabled: false } };
    expect(enabledActions(trayModel({ type: "idle" }, context).menu)).not.toContain("checkUpdates");
    context.updates!.state = { kind: "current", checkedAt: 1234567890000 };
    expect(labels(trayModel({ type: "idle" }, context).menu)).toContain(`已是最新版本（檢查時間：${new Date(1234567890000).toLocaleString("zh-TW")}）`);
  });
});
