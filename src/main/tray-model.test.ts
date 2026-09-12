import { describe, expect, it } from "vitest";
import type { RecordingState } from "../shared/state";
import { abbreviateHome, errorNotification, savedNotification, trayModel, type TrayContext, type TrayMenuItem } from "./tray-model";

const mac: TrayContext = { platform: "darwin", outputDir: "/Users/eric/Movies/RecordStuff", homeDir: "/Users/eric" };
const win: TrayContext = {
  platform: "win32",
  outputDir: "C:\\Users\\eric\\Videos\\RecordStuff",
  homeDir: "C:\\Users\\eric",
};

const labels = (menu: TrayMenuItem[]) => menu.map((m) => (m.kind === "separator" ? "—" : m.label));
const enabledActions = (menu: TrayMenuItem[]) =>
  menu.flatMap((m) => (m.kind === "item" && m.enabled && m.action ? [m.action] : []));

describe("abbreviateHome", () => {
  it("replaces the home prefix on both path styles", () => {
    expect(abbreviateHome("/Users/eric/Movies/RecordStuff", "/Users/eric")).toBe("~/Movies/RecordStuff");
    expect(abbreviateHome("C:\\Users\\eric\\Videos\\RecordStuff", "C:\\Users\\eric")).toBe("~\\Videos\\RecordStuff");
    expect(abbreviateHome("/Volumes/Ext/Rec", "/Users/eric")).toBe("/Volumes/Ext/Rec");
    expect(abbreviateHome("/Users/eric", "/Users/eric")).toBe("~");
    expect(abbreviateHome("/Users/erica/x", "/Users/eric")).toBe("/Users/erica/x");
  });
});

describe("trayModel per state (plans/001-first-version.md §8)", () => {
  it("needsPermission shows the settings action", () => {
    const m = trayModel({ type: "needsPermission", needsRelaunch: false }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual([
      "需要螢幕錄製權限",
      "開啟系統設定",
      "—",
      "儲存位置：~/Movies/RecordStuff",
      "更改儲存位置…",
      "—",
      "顯示 log",
      "結束",
    ]);
    expect(m.menu[0]).toMatchObject({ enabled: false });
    expect(enabledActions(m.menu)).toEqual(["openPermissionSettings", "openOutputDir", "changeOutputDir", "revealLog", "quit"]);
  });

  it("needsPermission with needsRelaunch shows relaunch instead", () => {
    const m = trayModel({ type: "needsPermission", needsRelaunch: true }, mac);
    expect(labels(m.menu)[1]).toBe("重新啟動");
    expect(enabledActions(m.menu)).toContain("relaunch");
    expect(enabledActions(m.menu)).not.toContain("openPermissionSettings");
  });

  it("idle without a last recording", () => {
    const m = trayModel({ type: "idle" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual(["待命中", "—", "儲存位置：~/Movies/RecordStuff", "更改儲存位置…", "—", "顯示 log", "結束"]);
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

  it("starting: idle icon, ellipsis title, only log and quit", () => {
    const m = trayModel({ type: "starting" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("…");
    expect(labels(m.menu)).toEqual(["啟動中…", "—", "顯示 log", "結束"]);
    expect(enabledActions(m.menu)).toEqual(["revealLog", "quit"]);
  });

  it("recording: red icon, REC title, stop; output dir items greyed", () => {
    const m = trayModel({ type: "recording", startedAt: "2026-09-11T06:30:00Z" }, mac);
    expect(m.icon).toBe("recording");
    expect(m.title).toBe("REC");
    expect(labels(m.menu)).toEqual(["錄製中", "停止", "—", "儲存位置：~/Movies/RecordStuff", "更改儲存位置…", "—", "顯示 log", "結束"]);
    expect(enabledActions(m.menu)).toEqual(["stop", "revealLog", "quit"]);
  });

  it("stopping: idle icon, ellipsis, only log and quit", () => {
    const m = trayModel({ type: "stopping" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("…");
    expect(labels(m.menu)).toEqual(["儲存中…", "—", "顯示 log", "結束"]);
    expect(enabledActions(m.menu)).toEqual(["revealLog", "quit"]);
  });

  it("Windows shows the abbreviated path and keeps the full path as toolTip", () => {
    const m = trayModel({ type: "idle" }, win);
    const dirItem = m.menu.find((i) => i.kind === "item" && i.action === "openOutputDir");
    expect(dirItem).toMatchObject({ label: "儲存位置：~\\Videos\\RecordStuff", toolTip: win.outputDir });
  });

  it("every state yields a menu ending in 顯示 log then 結束, both enabled", () => {
    const states: RecordingState[] = [
      { type: "needsPermission", needsRelaunch: false },
      { type: "idle" },
      { type: "starting" },
      { type: "recording", startedAt: "" },
      { type: "stopping" },
    ];
    for (const state of states) {
      const menu = trayModel(state, mac).menu;
      expect(menu.at(-3)).toEqual({ kind: "separator" });
      expect(menu.at(-2)).toMatchObject({ label: "顯示 log", action: "revealLog", enabled: true });
      expect(menu.at(-1)).toMatchObject({ label: "結束", action: "quit", enabled: true });
    }
  });
});

describe("notification text", () => {
  it("saved notification uses the file name", () => {
    expect(savedNotification("/Users/eric/Movies/RecordStuff/2026-09-11 14-30-00.mp4").body).toBe(
      "已儲存 2026-09-11 14-30-00.mp4",
    );
  });

  it("errors with a partial file mention it; without one say nothing was recorded", () => {
    const kept = errorNotification("capture_host_crashed", "", "/x/2026-09-11 14-30-00.recording.mp4", mac);
    expect(kept.body).toContain("2026-09-11 14-30-00.recording.mp4");
    const none = errorNotification("capture_start_failed", "boom", undefined, mac);
    expect(none.body).toContain("boom");
    expect(none.body).toContain("沒有錄到任何內容");
  });

  it("output_open_failed names the folder and the menu action", () => {
    const text = errorNotification("output_open_failed", "", undefined, mac);
    expect(text.body).toBe("儲存位置無法寫入：~/Movies/RecordStuff。右鍵選單可以更改儲存位置");
  });
});
