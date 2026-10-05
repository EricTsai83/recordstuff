import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import type { RecordingState } from "../shared/state";
import { DEFAULT_HOTKEY } from "../shared/hotkey";
import {
  trayHintNotification,
  updateAvailableNotification,
  frameRateDowngradeNotification,
  hotkeyRegistrationFailedNotification,
  recordingFailureNotification,
  savedNotification,
  recordMenu,
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
  countdown: 3, countdownSound: true,
  hotkey: { ...DEFAULT_HOTKEY, registered: true },
  updates: { state: { kind: "idle" }, enabled: true },
  notifications: true,
  displays: [], display: { kind: "primary" },
};
const win: AppContext = {
  platform: "win32",
  language: "zh-TW",
  outputDir: "C:\\Users\\eric\\Videos\\RecordStuff",
  homeDir: "C:\\Users\\eric",
  quality: DEFAULT_QUALITY,
  countdown: 3, countdownSound: true,
  hotkey: { ...DEFAULT_HOTKEY, registered: true },
  updates: { state: { kind: "idle" }, enabled: true },
  notifications: true,
  displays: [], display: { kind: "primary" },
};
const STATES: RecordingState[] = [
  { type: "needsPermission", needsRelaunch: false },
  { type: "needsPermission", needsRelaunch: true },
  { type: "idle" },
  { type: "starting" },
  { type: "countdown", remaining: 3 },
  { type: "recording", startedAt: "2026-09-14T00:00:00Z" },
  { type: "stopping" },
];

const labels = (menu: TrayMenuItem[]) => menu.map((m) => (m.kind === "separator" ? "—" : m.label));
const enabledActions = (menu: TrayMenuItem[]) =>
  menu.flatMap((m) => (m.kind === "item" && m.enabled && m.action ? [m.action] : []));

describe("trayModel per state (docs/system-design/desktop.md)", () => {
  it("needsPermission shows the permission actions above Open RecordStuff", () => {
    const m = trayModel({ type: "needsPermission", needsRelaunch: false }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual(["需要螢幕錄製權限", "開啟系統設定", "已經允許了？重新啟動 RecordStuff", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    expect(m.menu[0]).toMatchObject({ enabled: false });
    expect(enabledActions(m.menu)).toEqual(["openPermissionSettings", "relaunch", "openSettings", "showLastRecording", "quit"]);
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

  it("idle", () => {
    const m = trayModel({ type: "idle" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual(["待命中", "開始錄影", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    expect(enabledActions(m.menu)).toEqual(["start", "openSettings", "showLastRecording", "quit"]);
  });

  it("idle with an unusable output dir says so on the first line and offers its fix beside Start", () => {
    const m = trayModel({ type: "idle", outputDirUnavailable: true }, mac);
    expect(labels(m.menu).slice(0, 4)).toEqual(["儲存位置無法使用", "開始錄影", "更改儲存位置…", "—"]);
    expect(m.menu[2]).toMatchObject({ action: "changeOutputDir", toolTip: mac.outputDir });
  });

  it("starting: hourglass, no title, Open RecordStuff and quit", () => {
    const m = trayModel({ type: "starting" }, mac);
    expect(m.icon).toBe("busy");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual(["啟動中，請留意系統權限提示…", "取消錄影", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    expect(enabledActions(m.menu)).toEqual(["cancelCountdown", "openSettings", "showLastRecording", "quit"]);
  });

  it("starting names the shortcut on Cancel recording, as the countdown does (plan 065)", () => {
    const cancel = (ctx: AppContext) => trayModel({ type: "starting" }, ctx).menu.find((i) => i.kind === "item" && i.action === "cancelCountdown");
    expect(cancel(mac)).toMatchObject({ label: "取消錄影", toolTip: "以 ⇧⌘1 取消錄影", accelerator: "CommandOrControl+Shift+1" });
    expect(cancel({ ...mac, language: "en" })).toMatchObject({ label: "Cancel recording", toolTip: "Cancel recording with ⇧⌘1", accelerator: "CommandOrControl+Shift+1" });
    for (const hotkey of [{ ...DEFAULT_HOTKEY, registered: false }, { ...DEFAULT_HOTKEY, enabled: false, registered: true }]) {
      expect(cancel({ ...mac, hotkey })).not.toHaveProperty("toolTip");
      expect(cancel({ ...mac, hotkey })).not.toHaveProperty("accelerator");
    }
  });

  it("recording: red icon, REC title, Stop, Open RecordStuff and quit", () => {
    const m = trayModel({ type: "recording", startedAt: "2026-09-11T06:30:00Z" }, mac);
    expect(m.icon).toBe("recording");
    expect(m.title).toBe("REC");
    expect(labels(m.menu)).toEqual(["錄影中", "停止", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    expect(enabledActions(m.menu)).toEqual(["stop", "openSettings", "showLastRecording", "quit"]);
  });

  it("stopping: hourglass, no title, Open RecordStuff and quit", () => {
    const m = trayModel({ type: "stopping" }, mac);
    expect(m.icon).toBe("busy");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual(["儲存中…", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    expect(enabledActions(m.menu)).toEqual(["openSettings", "showLastRecording", "quit"]);
  });

  it("countdown: stopwatch without a title, a status line and Cancel recording naming the shortcut", () => {
    const ctx = { ...mac, hotkey: { ...DEFAULT_HOTKEY, registered: true } };
    const m = trayModel({ type: "countdown", remaining: 3 }, ctx);
    expect(m.icon).toBe("countdown");
    expect(m.title).toBe("");
    expect(m.tooltip).toBe("RecordStuff: 3 秒後開始錄影");
    expect(labels(m.menu)).toEqual(["3 秒後開始錄影", "取消錄影", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    expect(enabledActions(m.menu)).toEqual(["cancelCountdown", "openSettings", "showLastRecording", "quit"]);
    expect(m.menu.find((i) => i.kind === "item" && i.action === "cancelCountdown")).toMatchObject({ toolTip: "以 ⇧⌘1 取消錄影", accelerator: "CommandOrControl+Shift+1" });
    expect(trayModel({ type: "countdown", remaining: 1 }, ctx).menu[0]).toMatchObject({ label: "1 秒後開始錄影", enabled: false });
    const english = trayModel({ type: "countdown", remaining: 2 }, { ...ctx, language: "en" });
    expect(english.tooltip).toBe("RecordStuff: Recording starts in 2 s");
    expect(labels(english.menu).slice(0, 2)).toEqual(["Recording starts in 2 s", "Cancel recording"]);
  });

  it("Cancel recording has no shortcut tooltip when none is registered", () => {
    for (const hotkey of [{ ...DEFAULT_HOTKEY, registered: false }, { ...DEFAULT_HOTKEY, enabled: false, registered: true }]) {
      const cancel = trayModel({ type: "countdown", remaining: 3 }, { ...mac, hotkey }).menu.find((i) => i.kind === "item" && i.action === "cancelCountdown");
      expect(cancel).not.toHaveProperty("toolTip");
    }
  });

  it("the warning badge replaces only the idle ring, never busy, countdown or recording", () => {
    const unread = { ...mac, recordingResults: [{ id: "f", code: "disk_full" as const, detail: "", occurredAt: "2026-09-26T00:00:00Z", outcome: "empty" as const, acknowledged: false }] };
    const icons = STATES.map((state) => [state.type, trayModel(state, unread).icon]);
    expect(icons).toEqual([
      ["needsPermission", "warning"], ["needsPermission", "warning"], ["idle", "warning"],
      ["starting", "busy"], ["countdown", "countdown"], ["recording", "recording"], ["stopping", "busy"],
    ]);
    // Only REC changes the item width: every other state has an empty title.
    expect(STATES.map((state) => trayModel(state, mac).title)).toEqual(["", "", "", "", "", "REC", ""]);
  });

  it("keeps the output folder, the last recording and the log out of every menu: RecordStuff holds them (2026-10-04)", () => {
    for (const state of STATES) {
      const actions = trayModel(state, { ...mac, recordingResults: [{ id: "f", code: "disk_full" as const, detail: "", occurredAt: "2026-09-26T00:00:00Z", outcome: "empty" as const, acknowledged: true }] }).menu
        .flatMap((m) => (m.kind === "item" && m.action ? [m.action] : []));
      for (const gone of ["openOutputDir", "changeOutputDir", "revealLog", "openRecordingResult"]) expect(actions, `${state.type} ${gone}`).not.toContain(gone);
    }
  });

  it("a quit waiting on recording work says so with the busy icon instead of looking ready (plan 035)", () => {
    const unread = [{ id: "f", code: "disk_full" as const, detail: "", occurredAt: "2026-09-26T00:00:00Z", outcome: "empty" as const, acknowledged: false }];
    for (const state of [{ type: "idle" } as const, { type: "needsPermission", needsRelaunch: false } as const]) {
      const m = trayModel(state, { ...mac, quitting: true, recordingResults: unread });
      expect(m.icon).toBe("busy");
      expect(m.tooltip.split("\n")[0]).toBe("RecordStuff: 錄影存檔或清理完成後即結束…");
      expect(labels(m.menu)).toEqual(["錄影存檔或清理完成後即結束…", "—", "尚未確認的錄影失敗：1 筆", "查看失敗紀錄…", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    }
    const english = trayModel({ type: "idle" }, { ...mac, language: "en", quitting: true });
    expect(english.menu[0]).toMatchObject({ label: "Quitting once the recording is saved or cleaned up…", enabled: false });
    // Once recording work has settled, a quit still waiting names the saves it waits on, not a recording.
    expect(trayModel({ type: "idle" }, { ...mac, language: "en", quitting: true, quitStep: "metadata" }).menu[0])
      .toMatchObject({ label: "Quitting once settings and failure history are saved…", enabled: false });
    expect(trayModel({ type: "idle" }, { ...mac, quitting: true, quitStep: "metadata" }).menu[0]).toMatchObject({ label: "設定與失敗紀錄儲存完成後即結束…" });
    // A capture still running keeps its own state; the quit stops it, so its Stop is shown but not offered.
    const recording = trayModel({ type: "recording", startedAt: "2026-09-14T00:00:00Z" }, { ...mac, quitting: true });
    expect(recording.title).toBe("REC");
    expect(labels(recording.menu)).toContain("停止");
  });

  it("offers only Quit while a quit is in progress, since every other action is ignored until it ends", () => {
    for (const state of STATES) {
      const quitting = trayModel(state, { ...mac, quitting: true, recordingResults: [{ id: "f", code: "disk_full", detail: "", occurredAt: "2026-09-26T00:00:00Z", outcome: "empty", acknowledged: false }] });
      expect(enabledActions(quitting.menu), state.type).toEqual(["quit"]);
    }
    expect(enabledActions(trayModel({ type: "idle" }, mac).menu)).toContain("openSettings");
  });

  it("says in every state that a quit was postponed, beside the state, since its banner may not be seen (plan 056)", () => {
    const zh = trayModel({ type: "idle" }, { ...mac, quitDeferred: "media" });
    expect(labels(zh.menu).slice(0, 3)).toEqual(["待命中", "錄影工作仍在進行，暫不結束或重新啟動；完成後請再試一次。", "開始錄影"]);
    expect(zh.menu[1]).toMatchObject({ enabled: false });
    expect(zh.tooltip.split("\n").slice(0, 2)).toEqual(["RecordStuff: 待命中", "錄影工作仍在進行，暫不結束或重新啟動；完成後請再試一次。"]);
    const saving = trayModel({ type: "stopping" }, { ...mac, language: "en", quitDeferred: "metadata" });
    expect(labels(saving.menu).slice(0, 2)).toEqual(["Saving…", "Quit or relaunch postponed: settings or the log are being written. Try again in a moment."]);
    expect(labels(trayModel({ type: "idle" }, mac).menu)).not.toContain("錄影工作仍在進行，暫不結束或重新啟動；完成後請再試一次。");
  });

  it("says an error box is waiting for the recording, even while it records (plan 056)", () => {
    const m = trayModel({ type: "recording", startedAt: "2026-09-14T00:00:00Z" }, { ...mac, language: "en", errorBoxHeld: true, quitDeferred: "media" });
    expect(m.title).toBe("REC");
    expect(labels(m.menu).slice(0, 4)).toEqual(["Recording", "An unexpected error occurred. See the log for details.",
      "Quit or relaunch postponed: recording work is pending. Try again when it finishes.", "Stop"]);
    expect(m.tooltip.split("\n")[1]).toBe("An unexpected error occurred. See the log for details.");
    // The log is in RecordStuff → General, which stays open to reach mid-recording.
    expect(enabledActions(m.menu)).toContain("openSettings");
  });

  it("keeps a Windows tooltip within the 127 characters the notification area shows, marking the cut", () => {
    const english = { ...win, language: "en" as const, errorBoxHeld: true, quitDeferred: "metadata" as const };
    const recording = trayModel({ type: "recording", startedAt: "2026-09-14T00:00:00Z" }, english).tooltip;
    expect(recording.length).toBeLessThanOrEqual(127);
    expect(recording.startsWith("RecordStuff: Recording\nAn unexpected error occurred.")).toBe(true);
    expect(recording.endsWith("…")).toBe(true);
    // A tooltip that fits, and every macOS tooltip, stays whole.
    expect(trayModel({ type: "idle" }, { ...win, language: "en" }).tooltip).toBe("RecordStuff: Ready");
    const macTooltip = trayModel({ type: "recording", startedAt: "2026-09-14T00:00:00Z" }, { ...english, platform: "darwin" }).tooltip;
    expect(macTooltip.length).toBeGreaterThan(127);
    expect(macTooltip).not.toContain("…\n");
  });

  it("Windows offers the same short menu, the folder's fix keeping its full path as toolTip", () => {
    expect(labels(trayModel({ type: "idle" }, win).menu)).toEqual(["待命中", "開始錄影", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    expect(trayModel({ type: "idle", outputDirUnavailable: true }, win).menu.find((i) => i.kind === "item" && i.action === "changeOutputDir")).toMatchObject({ toolTip: win.outputDir });
  });

  it("is a flat command list in every state: no preference ever renders in the tray", () => {
    for (const state of STATES) {
      const menu = trayModel(state, { ...mac, hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: "available", version: "9.0.0" }, enabled: true } }).menu;
      expect(menu.every((entry) => entry.kind === "separator" || entry.kind === "item"), state.type).toBe(true);
      const actions = menu.flatMap((entry) => (entry.kind === "item" && entry.action ? [entry.action] : []));
      expect(actions.every((action) => typeof action === "string"), state.type).toBe(true);
    }
  });

  it("every state ends with an enabled Open RecordStuff and Show last recording, then Quit RecordStuff in its own group", () => {
    for (const state of STATES) {
      const menu = trayModel(state, mac).menu;
      expect(menu.at(-5), state.type).toEqual({ kind: "separator" });
      expect(menu.at(-4)).toMatchObject({ label: "開啟 RecordStuff", action: "openSettings", enabled: true });
      // The window on Recordings with the newest take focused, in every state, as Open RecordStuff is.
      expect(menu.at(-3)).toMatchObject({ label: "顯示最後一個錄影", action: "showLastRecording", enabled: true });
      expect(menu.at(-2)).toEqual({ kind: "separator" });
      expect(menu.at(-1)).toMatchObject({ label: "結束 RecordStuff", action: "quit", enabled: true });
    }
  });
});

describe("notification text", () => {
  it("frame-rate downgrade names both numbers", () => {
    expect(frameRateDowngradeNotification(60, 30, "zh-TW").body).toBe("系統無法提供 60 fps，本次以 30 fps 錄影。");
  });

  it("saved notification uses the file name", () => {
    expect(savedNotification("/Users/eric/Movies/RecordStuff/2026-09-11 14-30-00.mp4", "darwin", "zh-TW").body).toBe(
      "已儲存 2026-09-11 14-30-00.mp4",
    );
  });

  it("a recording stopped by the disk guard says so in the saved notification", () => {
    expect(savedNotification("/Volumes/Small/demo.mp4", "darwin", "en", "lowDisk").body).toBe(
      "Saved demo.mp4. Stopped early: the disk is almost full.",
    );
    expect(savedNotification("/Volumes/Small/demo.mp4", "darwin", "zh-TW", "lowDisk").body).toBe("已儲存 demo.mp4。磁碟空間即將用盡，已提前停止錄影。");
  });

  it("a recording stopped because the Mac went to sleep says so in the saved notification (plan 050)", () => {
    expect(savedNotification("/Users/eric/Movies/RecordStuff/demo.mp4", "darwin", "en", "sleep").body).toBe(
      "Saved demo.mp4. Stopped because the Mac went to sleep.",
    );
    expect(savedNotification("/Users/eric/Movies/RecordStuff/demo.mp4", "darwin", "zh-TW", "sleep").body).toBe("已儲存 demo.mp4。Mac 進入睡眠，已停止錄影。");
  });

  it("off macOS the sleep notice names the computer, not the Mac (plan 064)", () => {
    expect(savedNotification("/home/eric/Videos/RecordStuff/demo.mp4", "win32", "en", "sleep").body).toBe(
      "Saved demo.mp4. Stopped because the computer went to sleep.",
    );
    expect(savedNotification("/home/eric/Videos/RecordStuff/demo.mp4", "win32", "zh-TW", "sleep").body).toBe("已儲存 demo.mp4。電腦進入睡眠，已停止錄影。");
  });

  it("a failure notification joins its reason and the result hint as sentences in each language (plan 035 D1)", () => {
    expect(recordingFailureNotification("output_write_failed", "zh-TW")).toEqual({ title: "錄影失敗", body: "寫入錄影失敗。點此查看詳情。" });
    expect(recordingFailureNotification("output_open_failed", "zh-TW").body).toBe("無法寫入儲存位置。點此查看詳情。");
    expect(recordingFailureNotification("output_write_failed", "en")).toEqual({ title: "Recording failed", body: "Could not write the recording. Click for details." });
  });
  it("a refused shortcut registration points at RecordStuff's window, in the user's language", () => {
    expect(hotkeyRegistrationFailedNotification(DEFAULT_HOTKEY.accelerator, "darwin", "zh-TW").body).toBe(
      "無法註冊 ⇧⌘1，可能被其他 App 佔用。請開啟 RecordStuff 改用其他快捷鍵。",
    );
    expect(hotkeyRegistrationFailedNotification(DEFAULT_HOTKEY.accelerator, "win32").body).toContain("Ctrl+Shift+1");
  });
});

describe("English default and language switching", () => {
  it("renders the explicit English context", () => {
    const ctx = { ...mac, language: "en" as const };
    const m = trayModel({ type: "idle" }, ctx);
    expect(labels(m.menu)[0]).toBe("Ready");
    expect(labels(m.menu)).toContain("Open RecordStuff");
    expect(labels(m.menu).slice(0, 2)).toEqual(["Ready", "Start recording"]);
    expect(labels(m.menu).at(-1)).toBe("Quit RecordStuff");
    expect(savedNotification("/tmp/demo.mp4", "darwin").body).toBe("Saved demo.mp4");
  });

  it("changes presentation during recording without changing recording controls", () => {
    const state: RecordingState = { type: "recording", startedAt: "2026-09-14T00:00:00Z" };
    const english = trayModel(state, { ...mac, language: "en" });
    const chinese = trayModel(state, { ...mac, language: "zh-TW" });
    expect(english.title).toBe("REC");
    expect(chinese.title).toBe("REC");
    expect(english.tooltip).toBe("RecordStuff: Recording");
    expect(chinese.tooltip).toBe("RecordStuff: 錄影中");
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
    expect(stop(withHotkey())).toMatchObject({ toolTip: "Start / stop recording with ⇧⌘1" });
  });

  it("says nothing when the shortcut is off or unregistered", () => {
    expect(stop(withHotkey(false))).not.toHaveProperty("toolTip");
    expect(stop(withHotkey(true, false))).not.toHaveProperty("toolTip");
  });
});

describe("updates live in settings", () => {
  it("keeps settings reachable without update commands in the tray", () => {
    const ctx: AppContext = { ...mac, updates: { state: { kind: "available", version: "0.2.0" }, enabled: true } };
    const actions = enabledActions(trayModel({ type: "idle" }, ctx).menu);
    expect(actions).toContain("openSettings");
    expect(actions).not.toContain("checkUpdates");
    expect(actions).not.toContain("openUpdate");
  });
});

describe("first-run hint", () => {
  /** The same notification spends macOS's one authorization prompt, in context. */
  it("names the surface the app actually lives in on each platform", () => {
    expect(trayHintNotification("darwin", "en").body).toContain("menu bar");
    expect(trayHintNotification("win32", "en").body).toContain("system tray");
    expect(trayHintNotification("darwin", "zh-TW").body).toContain("選單列");
    expect(trayHintNotification("win32", "zh-TW").body).toContain("系統匣");
  });
});

it("only advertises a working Settings key and explains unavailable access in both languages", () => {
  for (const language of ["en", "zh-TW"] as const) {
    const ctx = { ...mac, language, settingsShortcut: { kind: "registered" as const, accelerator: "CommandOrControl+Alt+," } };
    // Shown as the native right-aligned accelerator, not typed into the label (plan 048).
    expect(trayModel({ type: "recording", startedAt: 0 } as any, ctx).menu).toContainEqual(expect.objectContaining({ action: "openSettings", enabled: true,
      label: language === "en" ? "Open RecordStuff" : "開啟 RecordStuff", accelerator: "CommandOrControl+Alt+," }));
    for (const status of [{ kind: "conflict" as const }, { kind: "failed" as const, accelerator: "CommandOrControl+Alt+,", reason: "OS" }]) {
      const menu = trayModel({ type: "idle" }, { ...ctx, settingsShortcut: status }).menu;
      const settings = menu.find(item => item.kind === "item" && item.action === "openSettings");
      expect(settings).toMatchObject({ enabled: true, label: language === "en" ? "Open RecordStuff" : "開啟 RecordStuff" });
      expect(settings).not.toHaveProperty("accelerator");
      expect(menu.some(item => item.kind === "item" && !item.enabled && item.label.includes(language === "en" ? "The shortcut for RecordStuff" : "開啟 RecordStuff 的快捷鍵"))).toBe(true);
    }
  }
});

describe("display tray feedback", () => {
  it("keeps default Ready and names an explicit target", () => {
    const ctx: AppContext = { ...mac, language: "en", displays: [{ id: "7", label: "Studio", logicalWidth: 100, logicalHeight: 100, scaleFactor: 1, internal: false, primary: true }] };
    expect(trayModel({ type: "idle" }, ctx).menu[0]).toMatchObject({ label: "Ready" });
    expect(trayModel({ type: "idle" }, { ...ctx, display: { kind: "display", id: "7", label: "Old label" } }).menu[0]).toMatchObject({ label: "Ready — Studio" });
  });
  it("distinguishes current absence from last source failure with notifications off", () => {
    const ctx: AppContext = { ...mac, language: "en", notifications: false, display: { kind: "display", id: "7", label: "Studio" }, displayFailure: "source_missing" };
    const menu = trayModel({ type: "idle" }, ctx).menu;
    expect(menu[0]).toMatchObject({ label: "Selected display is unavailable. Choose another screen." });
    expect(menu[1]).toMatchObject({ label: "Last display failure: The display's capture source is unavailable. Retry or choose another screen." });
  });
  it("offers Use Primary display as the way back from a chosen display that is gone, as Settings does", () => {
    const primary = { id: "1", label: "Built-in", logicalWidth: 1512, logicalHeight: 982, scaleFactor: 2, internal: true, primary: true };
    const gone: AppContext = { ...mac, language: "en", display: { kind: "display", id: "7", label: "Studio" }, displays: [primary] };
    const labels = (ctx: AppContext): string[] => trayModel({ type: "idle" }, ctx).menu.flatMap(entry => entry.kind === "item" ? [entry.label] : []);
    expect(labels(gone).slice(0, 3)).toEqual(["Selected display is unavailable. Choose another screen.", "Start recording", "Use Primary display"]);
    expect(trayModel({ type: "idle" }, gone).menu.find(entry => entry.kind === "item" && entry.label === "Use Primary display"))
      .toMatchObject({ enabled: true, action: { setDisplay: { kind: "primary" } } });
    expect(labels({ ...gone, language: "zh-TW" })).toContain("使用主螢幕");
    // No primary to go back to, or the display is back: nothing to offer.
    expect(labels({ ...gone, displays: [] })).not.toContain("Use Primary display");
    expect(labels({ ...gone, displays: [primary, { ...primary, primary: false }] })).not.toContain("Use Primary display");
    expect(labels({ ...gone, displays: [primary, { ...primary, id: "7", primary: false }] })).not.toContain("Use Primary display");
    // An unavailable folder's fix is the one shown; a busy recorder offers no settings change.
    expect(trayModel({ type: "idle", outputDirUnavailable: true }, gone).menu.some(entry => entry.kind === "item" && entry.label === "Use Primary display")).toBe(false);
    expect(trayModel({ type: "recording", startedAt: "x" }, gone).menu.some(entry => entry.kind === "item" && entry.label === "Use Primary display")).toBe(false);
  });
});

it("uses one badged idle icon, prioritizes REC and leaves reviewed failures to RecordStuff", () => {
  const result = { id: "f", code: "disk_full" as const, detail: "", occurredAt: "2026-09-24T12:00:00Z", outcome: "empty" as const, acknowledged: false };
  const ctx = { ...mac, notifications: false, recordingResults: [result] };
  expect(trayModel({ type: "idle" }, ctx).icon).toBe("warning");
  const recording = trayModel({ type: "recording", startedAt: "" }, ctx);
  expect(recording.icon).toBe("recording");
  expect(recording.title).toBe("REC");
  expect(recording.menu).toContainEqual(expect.objectContaining({ action: "openRecordingResult" }));
  expect(trayModel({ type: "idle" }, ctx).icon).toBe("warning");
  const acknowledged = trayModel({ type: "idle" }, { ...ctx, recordingResults: [{ ...result, acknowledged: true }] });
  expect(acknowledged.icon).toBe("idle");
  // Nothing is left to do about them: the Failures tab keeps them (2026-10-04).
  expect(acknowledged.menu).not.toContainEqual(expect.objectContaining({ action: "openRecordingResult" }));
});

it("keeps the warning while an older failure is unread and counts unread results", () => {
  const a = { id: "a", code: "disk_full" as const, detail: "", occurredAt: "2026-09-25T00:00:00Z", outcome: "empty" as const, acknowledged: false };
  const ctx = { ...mac, recordingResults: [{ ...a, id: "b", acknowledged: true }, a] };
  expect(trayModel({ type: "idle" }, ctx)).toMatchObject({ icon: "warning", tooltip: expect.stringContaining("1") });
  expect(trayModel({ type: "idle" }, { ...ctx, recordingResults: [a, { ...a, id: "b" }] }).tooltip).toContain("2");
  expect(trayModel({ type: "idle" }, { ...ctx, recordingResults: [] }).icon).toBe("idle");
});

describe("one group order in every state (plan 048)", () => {
  const failure = { id: "f", code: "disk_full" as const, detail: "", occurredAt: "2026-09-27T12:00:00Z", outcome: "empty" as const };
  const histories = { none: [], unread: [{ ...failure, acknowledged: false }], reviewed: [{ ...failure, acknowledged: true }] };

  it("puts the state first, unread failures next, then RecordStuff and Quit, in both languages", () => {
    const idle = (history: keyof typeof histories, language: "en" | "zh-TW") =>
      labels(trayModel({ type: "idle" }, { ...mac, language, recordingResults: histories[history] }).menu);
    expect(idle("unread", "en")).toEqual([
      "Ready", "Start recording", "—",
      "Unreviewed recording failures: 1", "View recording failures…", "—",
      "Open RecordStuff", "Show last recording", "—",
      "Quit RecordStuff",
    ]);
    // Reviewed failures leave the menu: no way back here, and no "Recent failure" line.
    expect(idle("reviewed", "zh-TW")).toEqual(["待命中", "開始錄影", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    expect(idle("none", "en")).toEqual(["Ready", "Start recording", "—", "Open RecordStuff", "Show last recording", "—", "Quit RecordStuff"]);
    const recording = labels(trayModel({ type: "recording", startedAt: "" }, { ...mac, language: "en", recordingResults: histories.unread }).menu);
    expect(recording).toEqual(["Recording", "Stop", "—", "Unreviewed recording failures: 1", "View recording failures…", "—", "Open RecordStuff", "Show last recording", "—", "Quit RecordStuff"]);
    const countdown = labels(trayModel({ type: "countdown", remaining: 3 }, { ...mac, recordingResults: histories.reviewed }).menu);
    expect(countdown).toEqual(["3 秒後開始錄影", "取消錄影", "—", "開啟 RecordStuff", "顯示最後一個錄影", "—", "結束 RecordStuff"]);
    for (const history of Object.keys(histories) as Array<keyof typeof histories>) {
      for (const state of STATES) {
        const menu = labels(trayModel(state, { ...mac, recordingResults: histories[history] }).menu);
        expect(menu.some((label) => label.startsWith("最近一次失敗")), `${state.type}/${history}`).toBe(false);
      }
    }
  });

  it("never leads, trails or doubles a separator, whatever the state, history, language or shortcut", () => {
    const shortcuts = [undefined, { kind: "registered" as const, accelerator: "CommandOrControl+Alt+," }, { kind: "conflict" as const }];
    for (const state of STATES) for (const history of Object.values(histories)) for (const language of ["en", "zh-TW"] as const) for (const settingsShortcut of shortcuts) {
      for (const quitting of [false, true]) {
        const menu = trayModel(state, { ...mac, language, recordingResults: history, ...(settingsShortcut ? { settingsShortcut } : {}), quitting,
          ...(quitting ? {} : { quitDeferred: "media" as const, errorBoxHeld: true }) }).menu;
        const kinds = menu.map((entry) => entry.kind).join(",");
        expect(menu[0]?.kind, kinds).toBe("item");
        expect(menu.at(-1)?.kind, kinds).toBe("item");
        expect(kinds.includes("separator,separator"), kinds).toBe(false);
      }
    }
  });

  it("offers Start recording exactly where a left click would start: idle", () => {
    for (const state of STATES) {
      const offered = enabledActions(trayModel(state, mac).menu).includes("start");
      expect(offered, state.type).toBe(state.type === "idle");
    }
    expect(enabledActions(trayModel({ type: "idle", outputDirUnavailable: true }, mac).menu)).toContain("start");
  });

  it("shows right-aligned accelerators only for registered shortcuts, keeping the tooltips", () => {
    const primary = (state: RecordingState, ctx: AppContext) => trayModel(state, ctx).menu.find((i) => i.kind === "item" && ["start", "stop", "cancelCountdown"].includes(String(i.action)));
    const states: RecordingState[] = [{ type: "idle" }, { type: "recording", startedAt: "" }, { type: "countdown", remaining: 3 }];
    for (const state of states) {
      expect(primary(state, mac), state.type).toMatchObject({ accelerator: "CommandOrControl+Shift+1", toolTip: expect.stringContaining("⇧⌘1") });
      for (const hotkey of [{ ...DEFAULT_HOTKEY, registered: false }, { ...DEFAULT_HOTKEY, enabled: false, registered: true }]) {
        const entry = primary(state, { ...mac, hotkey });
        expect(entry, state.type).not.toHaveProperty("accelerator");
        expect(entry, state.type).not.toHaveProperty("toolTip");
      }
    }
    // Settings… carries its own shortcut only while it is registered; nothing else has one.
    const registered = trayModel({ type: "idle" }, { ...mac, settingsShortcut: { kind: "registered", accelerator: "CommandOrControl+Alt+," } }).menu;
    expect(registered.filter((i) => i.kind === "item" && i.accelerator).map((i) => i.kind === "item" ? [i.action, i.accelerator] : [])).toEqual([
      ["start", "CommandOrControl+Shift+1"], ["openSettings", "CommandOrControl+Alt+,"],
    ]);
  });
});

describe("update notification", () => {
  it("names the version and what a click does, in both languages", () => {
    expect(updateAvailableNotification("1.3.0", "en")).toEqual({ title: "RecordStuff", body: "RecordStuff 1.3.0 is available. Click to open the download page." });
    expect(updateAvailableNotification("1.3.0", "zh-TW").body).toBe("RecordStuff 1.3.0 已推出，按一下開啟下載頁。");
  });
});

describe("the icon's left click in the tray's own words (2026-10-04)", () => {
  it("keeps the icon's tooltip to the state, the same whatever the click does", () => {
    const menu = { ...mac, language: "en" as const, trayClick: "menu" as const };
    const record = { ...menu, trayClick: "record" as const };
    const { trayClick: _choice, ...older } = menu;
    for (const state of [{ type: "idle" }, { type: "countdown", remaining: 2 }, { type: "recording", startedAt: "x" }] as RecordingState[]) {
      const tooltips = [menu, record, older].map(ctx => trayModel(state, ctx).tooltip);
      expect(new Set(tooltips).size, state.type).toBe(1);
      expect(tooltips[0]).not.toMatch(/click/i);
    }
    expect(trayModel({ type: "countdown", remaining: 2 }, record).tooltip).toBe("RecordStuff: Recording starts in 2 s");
  });
  it("first-run hint tells a new install to choose Start recording from the menu", () => {
    expect(trayHintNotification("darwin", "en", "menu").body).toBe("RecordStuff is ready in the menu bar. Click its icon and choose Start recording.");
    expect(trayHintNotification("win32", "zh-TW", "menu").body).toBe("RecordStuff 在系統匣待命。點圖示並選「開始錄影」即可開始。");
    expect(trayHintNotification("darwin", "en").body).toBe("RecordStuff is ready in the menu bar. Click to start recording; click again to stop.");
  });
});

describe("the menu bar's Record menu while the window is open (2026-10-04)", () => {
  const actions = (menu: TrayMenuItem[]) => menu.map(m => m.kind === "separator" ? "—" : `${m.label}${m.enabled ? "" : " (disabled)"}${m.accelerator ? ` ${m.accelerator}` : ""}`);
  it("holds the tray's state actions without their lines, Stop in full, then the newest take", () => {
    const shortcut = mac.hotkey.accelerator;
    expect(actions(recordMenu({ type: "idle" }, mac))).toEqual([`開始錄影 ${shortcut}`, "—", "顯示最後一個錄影"]);
    expect(actions(recordMenu({ type: "recording", startedAt: "2026-10-04T00:00:00Z" }, mac))).toEqual([`停止錄影 ${shortcut}`, "—", "顯示最後一個錄影"]);
    expect(actions(recordMenu({ type: "needsPermission", needsRelaunch: false }, mac))).toEqual(["開啟系統設定", "已經允許了？重新啟動 RecordStuff", "—", "顯示最後一個錄影"]);
    // Saving has no action: its line stays, so the menu never stands empty.
    expect(actions(recordMenu({ type: "stopping" }, mac))).toEqual(["儲存中… (disabled)", "—", "顯示最後一個錄影"]);
  });
  it("stays the same through a countdown, so a menu held open is not rebuilt every second", () => {
    expect(recordMenu({ type: "countdown", remaining: 3 }, mac)).toEqual(recordMenu({ type: "countdown", remaining: 2 }, mac));
    expect(actions(recordMenu({ type: "countdown", remaining: 3 }, mac))[0]).toBe(`取消錄影 ${mac.hotkey.accelerator}`);
  });
  it("names no shortcut while it is not registered, as while the editor records a new one", () => {
    const suspended = { ...mac, hotkey: { ...mac.hotkey, registered: false } };
    expect(actions(recordMenu({ type: "idle" }, suspended))[0]).toBe("開始錄影");
  });
  it("offers nothing to act on while a quit is in progress", () => {
    const quitting = recordMenu({ type: "recording", startedAt: "2026-10-04T00:00:00Z" }, { ...mac, quitting: true });
    expect(quitting.every(m => m.kind === "separator" || !m.enabled)).toBe(true);
  });
});
