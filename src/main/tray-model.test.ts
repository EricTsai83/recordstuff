import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import type { RecordingState } from "../shared/state";
import { DEFAULT_HOTKEY } from "../shared/hotkey";
import {
  trayHintNotification,
  frameRateDowngradeNotification,
  hotkeyRegistrationFailedNotification,
  recordingFailureNotification,
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
  { type: "idle", lastSavedPath: "/tmp/a.mp4" },
  { type: "starting" },
  { type: "countdown", remaining: 3 },
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
      "—",
      "設定…",
      "—",
      "顯示 log",
      "結束 RecordStuff",
    ]);
    expect(m.menu[0]).toMatchObject({ enabled: false });
    expect(enabledActions(m.menu)).toEqual([
      "openPermissionSettings",
      "relaunch",
      "openOutputDir",
      "changeOutputDir",
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

  it("needsPermission after a save keeps the reveal item below the permission actions", () => {
    const m = trayModel({ type: "needsPermission", needsRelaunch: true, lastSavedPath: "/Users/eric/Movies/RecordStuff/a.mp4" }, mac);
    expect(labels(m.menu).slice(0, 4)).toEqual(["需要螢幕錄製權限", "重新啟動", "—", "顯示最後一個錄影"]);
    expect(enabledActions(m.menu).slice(0, 2)).toEqual(["relaunch", "revealLastSaved"]);
  });

  it("idle without a last recording", () => {
    const m = trayModel({ type: "idle" }, mac);
    expect(m.icon).toBe("idle");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual([
      "待命中",
      "開始錄製",
      "—",
      "儲存位置：~/Movies/RecordStuff",
      "更改儲存位置…",
      "—",
      "設定…",
      "—",
      "顯示 log",
      "結束 RecordStuff",
    ]);
    expect(enabledActions(m.menu)).toEqual([
      "start",
      "openOutputDir",
      "changeOutputDir",
      "openSettings",
      "revealLog",
      "quit",
    ]);
  });

  it("idle with a last recording adds the reveal item", () => {
    const m = trayModel({ type: "idle", lastSavedPath: "/Users/eric/Movies/RecordStuff/a.mp4" }, mac);
    expect(labels(m.menu)[3]).toBe("顯示最後一個錄影");
    expect(enabledActions(m.menu).slice(0, 2)).toEqual(["start", "revealLastSaved"]);
  });

  it("idle with an unusable output dir says so on the first line", () => {
    const m = trayModel({ type: "idle", outputDirUnavailable: true }, mac);
    expect(labels(m.menu)[0]).toBe("儲存位置無法使用");
    expect(enabledActions(m.menu)).toContain("changeOutputDir");
  });

  it("starting: hourglass, no title, Settings, log and quit", () => {
    const m = trayModel({ type: "starting" }, mac);
    expect(m.icon).toBe("busy");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual(["啟動中，請留意系統權限提示…", "取消錄影", "—", "設定…", "—", "顯示 log", "結束 RecordStuff"]);
    expect(enabledActions(m.menu)).toEqual(["cancelCountdown", "openSettings", "revealLog", "quit"]);
  });

  it("starting names the shortcut on Cancel recording, as the countdown does (plan 065)", () => {
    const cancel = (ctx: AppContext) => trayModel({ type: "starting" }, ctx).menu.find((i) => i.kind === "item" && i.action === "cancelCountdown");
    expect(cancel(mac)).toMatchObject({ label: "取消錄影", toolTip: "以 ⌘⇧1 取消錄影", accelerator: "CommandOrControl+Shift+1" });
    expect(cancel({ ...mac, language: "en" })).toMatchObject({ label: "Cancel recording", toolTip: "Cancel recording with ⌘⇧1", accelerator: "CommandOrControl+Shift+1" });
    for (const hotkey of [{ ...DEFAULT_HOTKEY, registered: false }, { ...DEFAULT_HOTKEY, enabled: false, registered: true }]) {
      expect(cancel({ ...mac, hotkey })).not.toHaveProperty("toolTip");
      expect(cancel({ ...mac, hotkey })).not.toHaveProperty("accelerator");
    }
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
      "—",
      "設定…",
      "—",
      "顯示 log",
      "結束 RecordStuff",
    ]);
    expect(enabledActions(m.menu)).toEqual(["stop", "openSettings", "revealLog", "quit"]);
  });

  it("stopping: hourglass, no title, Settings, log and quit", () => {
    const m = trayModel({ type: "stopping" }, mac);
    expect(m.icon).toBe("busy");
    expect(m.title).toBe("");
    expect(labels(m.menu)).toEqual(["儲存中…", "—", "設定…", "—", "顯示 log", "結束 RecordStuff"]);
    expect(enabledActions(m.menu)).toEqual(["openSettings", "revealLog", "quit"]);
  });

  it("countdown: stopwatch without a title, a status line and Cancel recording naming the shortcut", () => {
    const ctx = { ...mac, hotkey: { ...DEFAULT_HOTKEY, registered: true } };
    const m = trayModel({ type: "countdown", remaining: 3 }, ctx);
    expect(m.icon).toBe("countdown");
    expect(m.title).toBe("");
    expect(m.tooltip.split("\n")[0]).toBe("RecordStuff: 3 秒後開始錄製，按一下即可取消。");
    expect(labels(m.menu)).toEqual(["3 秒後開始錄製", "取消錄影", "—", "設定…", "—", "顯示 log", "結束 RecordStuff"]);
    expect(enabledActions(m.menu)).toEqual(["cancelCountdown", "openSettings", "revealLog", "quit"]);
    expect(m.menu.find((i) => i.kind === "item" && i.action === "cancelCountdown")).toMatchObject({ toolTip: "以 ⌘⇧1 取消錄影", accelerator: "CommandOrControl+Shift+1" });
    expect(trayModel({ type: "countdown", remaining: 1 }, ctx).menu[0]).toMatchObject({ label: "1 秒後開始錄製", enabled: false });
    const english = trayModel({ type: "countdown", remaining: 2 }, { ...ctx, language: "en" });
    expect(english.tooltip.split("\n")[0]).toBe("RecordStuff: Recording starts in 2 s. Click to cancel.");
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
      ["needsPermission", "warning"], ["needsPermission", "warning"], ["idle", "warning"], ["idle", "warning"],
      ["starting", "busy"], ["countdown", "countdown"], ["recording", "recording"], ["stopping", "busy"],
    ]);
    // Only REC changes the item width: every other state has an empty title.
    expect(STATES.map((state) => trayModel(state, mac).title)).toEqual(["", "", "", "", "", "", "REC", ""]);
  });

  it("a long output folder is shortened in the label and kept whole in the toolTip (plan 035)", () => {
    const outputDir = "/Users/eric/personal-project/recordstuff/docs/verification/measurements/2026-09-27T19-04-32-324Z-controlled/recordings";
    for (const state of [{ type: "idle" } as const, { type: "recording", startedAt: "2026-09-14T00:00:00Z" } as const]) {
      const item = trayModel(state, { ...mac, outputDir }).menu.find((i) => i.kind === "item" && i.label.startsWith("儲存位置"));
      expect(item).toMatchObject({ label: "儲存位置：~/personal-project/…/recordings", toolTip: outputDir });
    }
    expect(trayModel({ type: "idle" }, { ...mac, outputDir: "/Volumes/RS035H" }).menu.find((i) => i.kind === "item" && i.action === "openOutputDir"))
      .toMatchObject({ label: "儲存位置：/Volumes/RS035H" });
  });

  it("a quit waiting on recording work says so with the busy icon instead of looking ready (plan 035)", () => {
    const unread = [{ id: "f", code: "disk_full" as const, detail: "", occurredAt: "2026-09-26T00:00:00Z", outcome: "empty" as const, acknowledged: false }];
    for (const state of [{ type: "idle" } as const, { type: "needsPermission", needsRelaunch: false } as const]) {
      const m = trayModel(state, { ...mac, quitting: true, recordingResults: unread });
      expect(m.icon).toBe("busy");
      expect(m.tooltip.split("\n")[0]).toBe("RecordStuff: 正在結束…錄影存檔或清理完成後就會結束");
      expect(labels(m.menu)).toEqual(["正在結束…錄影存檔或清理完成後就會結束", "—", "尚未確認的錄影失敗：1 筆", "查看失敗紀錄…", "—", "設定…", "—", "顯示 log", "結束 RecordStuff"]);
    }
    const english = trayModel({ type: "idle" }, { ...mac, language: "en", quitting: true });
    expect(english.menu[0]).toMatchObject({ label: "Quitting… RecordStuff quits once the recording is saved or cleaned up.", enabled: false });
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
    expect(labels(zh.menu).slice(0, 3)).toEqual(["待命中", "退出或重新啟動已延後：錄影工作仍在進行，完成後請重試原本的操作", "開始錄製"]);
    expect(zh.menu[1]).toMatchObject({ enabled: false });
    expect(zh.tooltip.split("\n").slice(0, 2)).toEqual(["RecordStuff: 待命中", "退出或重新啟動已延後：錄影工作仍在進行，完成後請重試原本的操作"]);
    const saving = trayModel({ type: "stopping" }, { ...mac, language: "en", quitDeferred: "metadata" });
    expect(labels(saving.menu).slice(0, 2)).toEqual(["Saving…", "Quit or relaunch postponed: settings or the log are still being written. Retry the same action in a moment."]);
    expect(labels(trayModel({ type: "idle" }, mac).menu)).not.toContain("退出或重新啟動已延後：錄影工作仍在進行，完成後請重試原本的操作");
  });

  it("says an error box is waiting for the recording, even while it records (plan 056)", () => {
    const m = trayModel({ type: "recording", startedAt: "2026-09-14T00:00:00Z" }, { ...mac, language: "en", errorBoxHeld: true, quitDeferred: "media" });
    expect(m.title).toBe("REC");
    expect(labels(m.menu).slice(0, 4)).toEqual(["Recording", "An unexpected error occurred. See the log for details.",
      "Quit or relaunch postponed: recording work is still pending. Retry the same action once it finishes.", "Stop"]);
    expect(m.tooltip.split("\n")[1]).toBe("An unexpected error occurred. See the log for details.");
    expect(enabledActions(m.menu)).toContain("revealLog");
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

  it("every state ends with enabled Settings…, then Show log and Quit RecordStuff in their own group", () => {
    for (const state of STATES) {
      const menu = trayModel(state, mac).menu;
      expect(menu.at(-5), state.type).toEqual({ kind: "separator" });
      expect(menu.at(-4)).toMatchObject({ label: "設定…", action: "openSettings", enabled: true });
      expect(menu.at(-3)).toEqual({ kind: "separator" });
      expect(menu.at(-2)).toMatchObject({ label: "顯示 log", action: "revealLog", enabled: true });
      expect(menu.at(-1)).toMatchObject({ label: "結束 RecordStuff", action: "quit", enabled: true });
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

  it("a recording stopped by the disk guard says so in the saved notification", () => {
    expect(savedNotification("/Volumes/Small/demo.mp4", "en", "lowDisk").body).toBe(
      "Saved demo.mp4. Recording stopped early because the disk is almost full.",
    );
    expect(savedNotification("/Volumes/Small/demo.mp4", "zh-TW", "lowDisk").body).toBe("已儲存 demo.mp4。磁碟空間即將用盡，已提前停止錄製。");
  });

  it("a recording stopped because the Mac went to sleep says so in the saved notification (plan 050)", () => {
    expect(savedNotification("/Users/eric/Movies/RecordStuff/demo.mp4", "en", "sleep").body).toBe(
      "Saved demo.mp4. Recording stopped because the Mac went to sleep.",
    );
    expect(savedNotification("/Users/eric/Movies/RecordStuff/demo.mp4", "zh-TW", "sleep").body).toBe("已儲存 demo.mp4。Mac 進入睡眠，已停止錄製。");
  });

  it("a failure notification joins its reason and the result hint as sentences in each language (plan 035 D1)", () => {
    expect(recordingFailureNotification("output_write_failed", "zh-TW")).toEqual({ title: "錄影失敗", body: "寫入錄影失敗。點此查看錄影結果。" });
    expect(recordingFailureNotification("output_open_failed", "zh-TW").body).toBe("無法寫入儲存位置。點此查看錄影結果。");
    expect(recordingFailureNotification("output_write_failed", "en")).toEqual({ title: "Recording failed", body: "Could not write the recording. Click to view the recording result." });
  });
  it("a refused shortcut registration points at Settings, in the user's language", () => {
    expect(hotkeyRegistrationFailedNotification(DEFAULT_HOTKEY.accelerator, "darwin", "zh-TW").body).toBe(
      "無法註冊快捷鍵 ⌘⇧1，可能被其他 App 佔用。可以在設定視窗改用其他快捷鍵。",
    );
    expect(hotkeyRegistrationFailedNotification(DEFAULT_HOTKEY.accelerator, "win32").body).toContain("Ctrl+Shift+1");
  });
});

describe("English default and language switching", () => {
  it("renders the explicit English context", () => {
    const ctx = { ...mac, language: "en" as const };
    const m = trayModel({ type: "idle" }, ctx);
    expect(labels(m.menu)[0]).toBe("Ready");
    expect(labels(m.menu)).toContain("Settings…");
    expect(labels(m.menu).slice(0, 2)).toEqual(["Ready", "Start recording"]);
    expect(labels(m.menu).at(-1)).toBe("Quit RecordStuff");
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
    expect(stop(withHotkey())).toMatchObject({ toolTip: "Start / stop recording with ⌘⇧1" });
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
      label: language === "en" ? "Settings…" : "設定…", accelerator: "CommandOrControl+Alt+," }));
    for (const status of [{ kind: "conflict" as const }, { kind: "failed" as const, accelerator: "CommandOrControl+Alt+,", reason: "OS" }]) {
      const menu = trayModel({ type: "idle" }, { ...ctx, settingsShortcut: status }).menu;
      const settings = menu.find(item => item.kind === "item" && item.action === "openSettings");
      expect(settings).toMatchObject({ enabled: true, label: language === "en" ? "Settings…" : "設定…" });
      expect(settings).not.toHaveProperty("accelerator");
      expect(menu.some(item => item.kind === "item" && !item.enabled && item.label.includes(language === "en" ? "Settings shortcut unavailable" : "設定快捷鍵無法使用"))).toBe(true);
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
    expect(menu[1]).toMatchObject({ label: "Last display failure: Display is connected but its capture source is unavailable. Retry or choose another screen." });
  });
});

it("uses one badged idle icon, prioritizes REC and retains the result entry after acknowledgement", () => {
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
  expect(acknowledged.menu).toContainEqual(expect.objectContaining({ action: "openRecordingResult" }));
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

  it("puts the state first, unread failures next, then files, windows and the app, in both languages", () => {
    const idle = (history: keyof typeof histories, language: "en" | "zh-TW") =>
      labels(trayModel({ type: "idle", lastSavedPath: "/Users/eric/Movies/RecordStuff/a.mp4" }, { ...mac, language, recordingResults: histories[history] }).menu);
    expect(idle("unread", "en")).toEqual([
      "Ready", "Start recording", "—",
      "Unreviewed recording failures: 1", "View recording failures…", "—",
      "Show last recording", "Output folder: ~/Movies/RecordStuff", "Change output folder…", "—",
      "Settings…", "—",
      "Show log", "Quit RecordStuff",
    ]);
    // Reviewed failures leave the top: only a way back beside Settings, and no "Recent failure" line.
    expect(idle("reviewed", "zh-TW")).toEqual([
      "待命中", "開始錄製", "—",
      "顯示最後一個錄影", "儲存位置：~/Movies/RecordStuff", "更改儲存位置…", "—",
      "查看失敗紀錄…", "設定…", "—",
      "顯示 log", "結束 RecordStuff",
    ]);
    expect(idle("none", "en")).toEqual(["Ready", "Start recording", "—", "Show last recording", "Output folder: ~/Movies/RecordStuff", "Change output folder…", "—",
      "Settings…", "—", "Show log", "Quit RecordStuff"]);
    const recording = labels(trayModel({ type: "recording", startedAt: "" }, { ...mac, language: "en", recordingResults: histories.unread }).menu);
    expect(recording).toEqual(["Recording", "Stop", "—", "Unreviewed recording failures: 1", "View recording failures…", "—",
      "Output folder: ~/Movies/RecordStuff", "Change output folder…", "—", "Settings…", "—", "Show log", "Quit RecordStuff"]);
    const countdown = labels(trayModel({ type: "countdown", remaining: 3 }, { ...mac, recordingResults: histories.reviewed }).menu);
    expect(countdown).toEqual(["3 秒後開始錄製", "取消錄影", "—", "查看失敗紀錄…", "設定…", "—", "顯示 log", "結束 RecordStuff"]);
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
      expect(primary(state, mac), state.type).toMatchObject({ accelerator: "CommandOrControl+Shift+1", toolTip: expect.stringContaining("⌘⇧1") });
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
