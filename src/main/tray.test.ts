import { DEFAULT_HOTKEY } from "../shared/hotkey";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

/**
 * A notification the OS refuses to show is invisible to the user *and* to the
 * developer (a save whose notification never appeared, with nothing
 * in the log to say who dropped it). These tests pin the diagnostics down: the
 * `failed` listener is always attached, and neither an unsupported system nor
 * a failure escapes into the caller — a notification must never affect a
 * recording.
 */
interface FakeNotification {
  options: { title: string; body: string };
  shown: number;
  close: ReturnType<typeof vi.fn>;
  listeners: Map<string, (...args: unknown[]) => void>;
}

interface FakeNotificationCtor {
  new (options: { title: string; body: string; silent?: boolean }): FakeNotification;
  instances: FakeNotification[];
  supported: boolean;
  throwOnConstruct: boolean;
  isSupported(): boolean;
}

vi.mock("electron", () => {
  class FakeNotification {
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    shown = 0;
    close = vi.fn();
    static instances: FakeNotification[] = [];
    static supported = true;
    static throwOnConstruct = false;

    constructor(readonly options: { title: string; body: string; silent?: boolean }) {
      if (FakeNotification.throwOnConstruct) throw new Error("native notification unavailable");
      FakeNotification.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, listener);
      return this;
    }

    show(): void {
      this.shown += 1;
    }

    static isSupported(): boolean {
      return FakeNotification.supported;
    }
  }

  const images = new Map<string, { file: string; setTemplateImage: ReturnType<typeof vi.fn>; isEmpty: () => boolean }>();
  // Like Electron, a missing file yields an empty image rather than an error.
  const image = (file: string) => images.get(file) ?? images.set(file, { file, setTemplateImage: vi.fn(), isEmpty: () => file.includes("missing") }).get(file)!;
  // `app` only needs the activation events the reveal listens to.
  const app = new EventEmitter();
  return {
    app,
    Menu: { buildFromTemplate: vi.fn(() => ({})) },
    Notification: FakeNotification,
    // Like Electron, a destroyed tray throws on every native call.
    Tray: class {
      destroyed = false;
      live = (): void => { if (this.destroyed) throw new Error("Tray is destroyed"); };
      setIgnoreDoubleClickEvents = vi.fn();
      setImage = vi.fn(this.live);
      setTitle = vi.fn(this.live);
      setToolTip = vi.fn(this.live);
      popUpContextMenu = vi.fn(this.live);
      destroy = vi.fn(() => { this.destroyed = true; });
      on = vi.fn();
    },
    nativeImage: { createFromPath: vi.fn((file: string) => image(file)) },
    shell: { showItemInFolder: vi.fn() },
  };
});

import { app, Notification, shell } from "electron";
import type { Language } from "../shared/i18n";
import { DEFAULT_QUALITY } from "../shared/quality";
import { ACTIVATION_WINDOW_MS, AppTray, RETURN_IDLE_SECONDS, TRAY_ICON_FILES, WAKE_CHECK_MS } from "./tray";

const Fake = Notification as unknown as FakeNotificationCtor;

function setup(supported = true, canNotify?: () => boolean, idleSeconds?: () => number, onNotificationClick?: () => void, now?: () => number): { tray: AppTray; logs: string[]; onAction: ReturnType<typeof vi.fn> } {
  vi.mocked(shell.showItemInFolder).mockReset();
  app.removeAllListeners();
  Fake.instances.length = 0;
  Fake.supported = supported;
  const logs: string[] = [];
  const onAction = vi.fn();
  const tray = new AppTray({
    ...(onNotificationClick ? { onNotificationClick } : {}),
    resourcesDir: "/resources",
    context: () => ({
      platform: process.platform,
      outputDir: "/Users/eric/Movies/RecordStuff",
      homeDir: "/Users/eric",
      quality: DEFAULT_QUALITY,
      countdown: 3, countdownSound: true,
      language: "en",
      hotkey: { ...DEFAULT_HOTKEY, registered: true },
      updates: { state: { kind: "idle" }, enabled: true },
      notifications: true,
  displays: [], display: { kind: "primary" },
    }),
    onToggle: vi.fn(),
    onAction,
    log: (message) => logs.push(message),
    ...(canNotify ? { canNotify } : {}),
    ...(idleSeconds ? { idleSeconds } : {}),
    ...(now ? { now } : {}),
  });
  return { tray, logs, onAction };
}

describe("AppTray icons (plan 040)", () => {
  it("loads one template per state and switches icon and title with the state", async () => {
    const { nativeImage } = await import("electron");
    const created = vi.mocked(nativeImage.createFromPath);
    created.mockClear();
    const { tray } = setup();
    expect(created.mock.calls.map(([file]) => file)).toEqual(Object.values(TRAY_ICON_FILES).map((files) => `/resources/${process.platform === "win32" ? files.win32 : files.template}`));
    const native = (tray as unknown as { tray: { setImage: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> } }).tray;
    const icons = (tray as unknown as { icons: Record<string, unknown> }).icons;
    for (const [state, icon, title] of [
      [{ type: "starting" }, "busy", ""], [{ type: "countdown", remaining: 3 }, "countdown", ""],
      [{ type: "recording", startedAt: "x" }, "recording", "REC"], [{ type: "stopping" }, "busy", ""], [{ type: "idle" }, "idle", ""],
    ] as const) {
      native.setImage.mockClear();
      tray.render(state);
      expect(native.setImage, state.type).toHaveBeenCalledWith(icons[icon]);
      if (process.platform === "darwin") expect(native.setTitle).toHaveBeenLastCalledWith(title);
    }
    // Another countdown tick keeps the icon; only the tooltip changes.
    tray.render({ type: "countdown", remaining: 3 });
    native.setImage.mockClear();
    tray.render({ type: "countdown", remaining: 2 });
    expect(native.setImage).not.toHaveBeenCalled();
  });

  it("makes no native call for a refresh that changes nothing the item shows", () => {
    const { tray } = setup();
    const native = (tray as unknown as { tray: { setTitle: ReturnType<typeof vi.fn>; setToolTip: ReturnType<typeof vi.fn> } }).tray;
    tray.render({ type: "recording", startedAt: "x" });
    native.setTitle.mockClear(); native.setToolTip.mockClear();
    tray.refresh();
    tray.render({ type: "recording", startedAt: "x" });
    expect(native.setTitle).not.toHaveBeenCalled();
    expect(native.setToolTip).not.toHaveBeenCalled();
    tray.render({ type: "stopping" });
    expect(native.setToolTip).toHaveBeenCalledTimes(1);
    if (process.platform === "darwin") expect(native.setTitle).toHaveBeenCalledWith("");
  });

  it("logs an icon file that yields an empty image instead of showing an invisible item", () => {
    const logs: string[] = [];
    new AppTray({ resourcesDir: "/missing", context: () => { throw new Error("unused"); }, onToggle: vi.fn(), onAction: vi.fn(), log: (m) => logs.push(m) });
    expect(logs.filter((m) => m.startsWith("tray: icon "))).toHaveLength(Object.keys(TRAY_ICON_FILES).length);
    expect(logs[0]).toContain("/missing/");
    const { logs: healthy } = setup();
    expect(healthy.filter((m) => m.startsWith("tray: icon "))).toEqual([]);
  });
});

describe("AppTray notifications (docs/system-design/desktop.md)", () => {
  it("keeps multiple pending notifications owned until shutdown, even after show", () => {
    const { tray } = setup();
    tray.notifySaved("/tmp/第一 段.mp4");
    tray.notifySaved("/tmp/second.mp4");
    const pending = [...Fake.instances];
    for (const notification of pending) notification.listeners.get("show")?.();
    Fake.instances.length = 0;
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    tray.destroy();
    for (const notification of pending) expect(notification.close).toHaveBeenCalledOnce();
    tray.destroy();
    for (const notification of pending) expect(notification.close).toHaveBeenCalledOnce();
  });

  it.each(["click", "close", "failed"])("releases a notification on %s without releasing another", async (event) => {
    const { tray } = setup();
    tray.notifySaved("/tmp/handled.mp4");
    tray.notifySaved("/tmp/pending.mp4");
    const handled = Fake.instances[0]!;
    const pending = Fake.instances[1]!;
    handled.listeners.get(event)?.({}, "delivery failed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    tray.destroy();
    expect(handled.close).not.toHaveBeenCalled();
    expect(pending.close).toHaveBeenCalledOnce();
  });

  it("releases a synchronous show failure and does not throw into recording", () => {
    const { tray, logs } = setup();
    const show = vi.spyOn(Notification.prototype, "show").mockImplementationOnce(() => { throw new Error("show refused"); });
    try {
      expect(() => tray.notifySaved("/tmp/failed.mp4")).not.toThrow();
      expect(logs).toContain("notification: failed (Error: show refused): Saved failed.mp4");
      tray.destroy();
      expect(Fake.instances[0]!.close).not.toHaveBeenCalled();
    } finally { show.mockRestore(); }
  });

  it("continues shutdown after one native close throws", () => {
    const { tray, logs } = setup();
    tray.notifySaved("/tmp/first.mp4");
    tray.notifySaved("/tmp/second.mp4");
    Fake.instances[0]!.close.mockImplementation(() => { throw new Error("close refused"); });
    expect(() => tray.destroy()).not.toThrow();
    expect(Fake.instances[1]!.close).toHaveBeenCalledOnce();
    expect(logs).toContain("notification: close failed (Error: close refused)");
  });

  it("logs the reason when the OS refuses to show a notification", () => {
    const { tray, logs } = setup();
    tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
    const notification = Fake.instances.at(-1);
    expect(notification?.shown).toBe(1);

    const failed = notification?.listeners.get("failed");
    expect(failed).toBeTypeOf("function");
    // Electron's listener signature is (event, error); the error text is the
    // only clue the user's machine gives us.
    expect(() => failed?.({}, "Notification permission denied")).not.toThrow();
    expect(logs).toContain("notification: failed (Notification permission denied): Saved a.mp4");
  });

  it("records requested, shown, clicked and closed with the notification body", async () => {
    const { tray, logs } = setup();
    tray.notifySaved("/tmp/diagnostic.mp4");
    const notification = Fake.instances.at(-1)!;
    expect(logs).toEqual(["notification: show requested: Saved diagnostic.mp4"]);
    notification.listeners.get("show")?.();
    notification.listeners.get("close")?.();
    expect(logs).toContain("notification: shown: Saved diagnostic.mp4");
    expect(logs).toContain("notification: closed: Saved diagnostic.mp4");
    notification.listeners.get("click")?.();
    expect(logs).toContain("notification: clicked: Saved diagnostic.mp4");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("reports every click before the notification's own action, and titles the capture warning with the app name", () => {
    const order: string[] = [];
    const { tray, onAction } = setup(true, undefined, undefined, () => order.push("clicked"));
    onAction.mockImplementation((action: unknown) => { order.push(String(action)); });
    tray.notifyCaptureWarning("The resolution cap could not be confirmed.");
    const notification = Fake.instances.at(-1)!;
    expect(notification.options.title).toBe("RecordStuff");
    notification.listeners.get("click")?.();
    expect(order).toEqual(["clicked", "openSettings"]);
    tray.notifyTrayHint();
    Fake.instances.at(-1)!.listeners.get("click")?.();
    expect(order).toEqual(["clicked", "openSettings", "clicked"]);
  });

  it("opens Settings from the shortcut-refused banner that tells the user to go there", () => {
    const { tray, onAction } = setup();
    tray.notifyHotkeyRegistrationFailed(DEFAULT_HOTKEY.accelerator);
    const notification = Fake.instances.at(-1)!;
    expect(notification.options.body).toContain("Choose another shortcut in Settings.");
    notification.listeners.get("click")?.();
    expect(onAction).toHaveBeenCalledWith("openSettings");
  });

  it("drops every notification while the user's switch is off, before asking the OS", () => {
    const { tray, logs } = setup(true, () => false);
    tray.notifySaved("/tmp/a.mp4");
    tray.notifyRecordingFailure("no_audio_track");
    expect(Fake.instances).toHaveLength(0);
    expect(logs.filter((line) => line.includes("turned off in settings"))).toHaveLength(2);
    expect(logs.some((line) => line.includes("not supported"))).toBe(false);
  });

  it("still answers a deferred quit with the switch off, since the user asked to quit (plan 055)", () => {
    const { tray } = setup(true, () => false);
    tray.notifySaved("/tmp/a.mp4");
    tray.notifyQuitDeferred("RecordStuff will stay open.");
    expect(Fake.instances.map((notification) => notification.options)).toEqual([{ title: "RecordStuff", body: "RecordStuff will stay open.", silent: true }]);
    expect(Fake.instances[0]!.shown).toBe(1);
  });

  it("tells an output-folder problem found during recording work with the switch off, since the user clicked (plan 056)", () => {
    const { tray } = setup(true, () => false);
    tray.notifyOutputFolderProblem("/Volumes/X was not found.");
    expect(Fake.instances.map((notification) => notification.options)).toEqual([{ title: "Could not open the output folder", body: "/Volumes/X was not found.", silent: true }]);
    expect(Fake.instances[0]!.shown).toBe(1);
  });

  it("sends the enable confirmation through the same path as any other notification", () => {
    const { tray } = setup();
    tray.notifyNotificationsEnabled();
    expect(Fake.instances).toHaveLength(1);
    expect(Fake.instances[0]?.options.body).toContain("Notifications are on");
    expect(Fake.instances[0]?.shown).toBe(1);
  });

  it("logs and gives up when notifications are not supported at all", () => {
    const { tray, logs } = setup(false);
    tray.notifyRecordingFailure("no_audio_track");
    expect(Fake.instances).toHaveLength(0);
    expect(logs.at(-1)).toContain("notification: not supported");
  });

  it("reveals the saved file after the native macOS click callback returns", async () => {
    const { tray, logs } = setup();
    const file = "/Users/eric/Movies/RecordStuff/a.mp4";
    tray.notifySaved(file);
    Fake.instances.at(-1)?.listeners.get("click")?.();
    if (process.platform === "darwin") {
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file);
    expect(logs).toContain(`notification: reveal requested ${file}`);
  });

  const darwin = process.platform === "darwin" ? describe : describe.skip;
  darwin("macOS foreground after the notification click (plan 014)", () => {
    const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

    it("saving in the background never touches Finder or listens for activation", () => {
      const { tray } = setup();
      tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(app.listenerCount("did-become-active")).toBe(0);
    });

    it("reveals again when macOS activates the app after the first reveal, so Finder ends in front", async () => {
      vi.useFakeTimers();
      try {
        const { tray, logs } = setup();
        const file = "/Users/eric/Movies/RecordStuff/測試 錄影 2026-09-20 01-27-11.mp4";
        tray.notifySaved(file);
        Fake.instances.at(-1)?.listeners.get("click")?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
        expect(app.listenerCount("did-become-active")).toBe(1);
        // The system's activation for the click lands ~110 ms after our callback (measured on macOS 26.6).
        await vi.advanceTimersByTimeAsync(110);
        app.emit("did-become-active");
        expect(shell.showItemInFolder).toHaveBeenCalledTimes(2);
        expect(shell.showItemInFolder).toHaveBeenLastCalledWith(file);
        expect(logs.filter((line) => line.startsWith("notification: reveal"))).toEqual([`notification: reveal requested ${file}`, `notification: reveal repeated after activation ${file}`]);
        // One-shot: a later activation (the user switching apps) does not re-open Finder.
        app.emit("did-become-active");
        expect(shell.showItemInFolder).toHaveBeenCalledTimes(2);
        expect(app.listenerCount("did-become-active")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops listening after the activation window so a later app switch is not treated as the click", async () => {
      vi.useFakeTimers();
      try {
        const { tray } = setup();
        tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
        Fake.instances.at(-1)?.listeners.get("click")?.();
        await vi.advanceTimersByTimeAsync(ACTIVATION_WINDOW_MS + 1);
        expect(app.listenerCount("did-become-active")).toBe(0);
        app.emit("did-become-active");
        expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("logs a failed reveal without throwing into the click handler or the activation listener", async () => {
      const { tray, logs } = setup();
      const file = "/Users/eric/Movies/RecordStuff/a b.mp4";
      vi.mocked(shell.showItemInFolder).mockImplementation(() => {
        throw new Error("Finder is gone");
      });
      tray.notifySaved(file);
      expect(() => Fake.instances.at(-1)?.listeners.get("click")?.()).not.toThrow();
      await flush();
      expect(() => app.emit("did-become-active")).not.toThrow();
      expect(logs.filter((l) => l.startsWith("notification: reveal failed (Error: Finder is gone)"))).toHaveLength(2);
    });
  });

  it("keeps the click handler working alongside the failure listener", () => {
    const { tray } = setup();
    tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
    const notification = Fake.instances.at(-1);
    expect(notification?.listeners.get("click")).toBeTypeOf("function");
    expect(() => notification?.listeners.get("click")?.()).not.toThrow();
  });
});


describe("notification language follows current settings", () => {
  it("uses the new language for subsequent notifications and preserves recovery actions", () => {
    Fake.instances.length = 0;
    Fake.supported = true;
    let language: Language = "en";
    const action = vi.fn();
    const tray = new AppTray({
      resourcesDir: "/resources",
      context: () => ({ platform: process.platform, outputDir: "/tmp/recordings", homeDir: "/tmp", quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, language, hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: "idle" }, enabled: true }, notifications: true, displays: [], display: { kind: "primary" } }),
      onToggle: vi.fn(), onAction: action,
    });
    tray.notifySaved("/tmp/demo.mp4");
    expect(Fake.instances.at(-1)?.options.body).toBe("Saved demo.mp4");
    language = "zh-TW";
    tray.refresh();
    tray.notifySaved("/tmp/demo.mp4");
    expect(Fake.instances.at(-1)?.options.body).toBe("已儲存 demo.mp4");
    tray.notifyRecordingFailure("permission_denied");
    expect(Fake.instances.at(-1)?.options.body).toContain("需要螢幕錄製權限");
    Fake.instances.at(-1)?.listeners.get("click")?.();
    expect(action).toHaveBeenCalledWith("openRecordingResult");
    tray.notifyLanguageWriteFailed();
    expect(Fake.instances.at(-1)?.options.body).toContain("無法儲存語言設定");
    language = "en";
    tray.notifyPermission(true);
    expect(Fake.instances.at(-1)?.options.body).toContain("then relaunch RecordStuff");
    Fake.instances.at(-1)?.listeners.get("click")?.();
    expect(action).toHaveBeenCalledWith("relaunch");
    tray.destroy();
  });
});

it("routes recording-failure notification clicks to results without acknowledging or revealing prematurely", () => {
  const { tray, onAction } = setup();
  tray.notifyRecordingFailure("disk_full");
  const notification = Fake.instances[0]!;
  expect(notification.options.title).toBe("Recording failed");
  expect(notification.options.body).toContain("disk is full");
  notification.listeners.get("click")?.();
  expect(onAction).toHaveBeenCalledWith("openRecordingResult");
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  tray.destroy();
  const off = setup(true, () => false);
  off.tray.notifyRecordingFailure("disk_full");
  expect(Fake.instances).toHaveLength(0);
  off.tray.destroy();
});

describe("tray menu template (plan 048)", () => {
  it("shows a registered shortcut right-aligned without registering it again, and Start calls the start action", async () => {
    const { Menu, Tray } = await import("electron");
    const { tray, onAction } = setup();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    const instance = (tray as unknown as { tray: InstanceType<typeof Tray> }).tray;
    const rightClick = vi.mocked(instance.on).mock.calls.find(([name]) => name === "right-click")?.[1] as () => void;
    rightClick();
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]![0] as Electron.MenuItemConstructorOptions[];
    const start = template.find((entry) => entry.label === "Start recording")!;
    expect(start).toMatchObject({ accelerator: "CommandOrControl+Shift+1", registerAccelerator: false, enabled: true });
    start.click?.({} as never, undefined, {} as never);
    expect(onAction).toHaveBeenCalledWith("start");
    // Items without a registered shortcut carry no accelerator at all.
    expect(template.find((entry) => entry.label === "Show log")).not.toHaveProperty("accelerator");
    expect(template.at(-1)).toMatchObject({ label: "Quit RecordStuff" });
  });
});

describe("AppTray after destroy (plan 035 D4)", () => {
  it("ignores a late render, refresh or right-click, as the quit-feedback timer after a quit prompt did", async () => {
    const { Tray } = await import("electron");
    const { tray } = setup();
    const instance = (tray as unknown as { tray: InstanceType<typeof Tray> }).tray;
    const rightClick = vi.mocked(instance.on).mock.calls.find(([name]) => name === "right-click")?.[1] as () => void;
    tray.destroy();
    vi.mocked(instance.setToolTip).mockClear();
    expect(() => tray.render({ type: "idle" })).not.toThrow();
    expect(() => tray.refresh()).not.toThrow();
    expect(() => rightClick()).not.toThrow();
    expect(() => tray.destroy()).not.toThrow();
    expect(instance.setToolTip).not.toHaveBeenCalled();
    expect(instance.popUpContextMenu).not.toHaveBeenCalled();
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    // The fake behaves like Electron, so without the guard the render above would have thrown.
    expect(() => instance.setToolTip("x")).toThrow("Tray is destroyed");
  });
});

describe("notifications around sleep (plan 050)", () => {
  // The injected idle time decides whether the user is back after waking.
  const sleepy = (idle: { seconds: number }, canNotify?: () => boolean) => setup(true, canNotify, () => idle.seconds);

  it("holds notifications while the Mac sleeps and shows them in order once the user is back", async () => {
    vi.useFakeTimers();
    try {
      const idle = { seconds: 30 };
      const { tray, logs } = sleepy(idle);
      tray.systemWillSleep();
      tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4", "sleep");
      tray.notifyRecordingFailure("capture_failed");
      expect(Fake.instances).toHaveLength(0);
      expect(logs.filter((line) => line.startsWith("notification: held during sleep"))).toHaveLength(2);
      // A maintenance wake reports resume without any input: nothing is shown.
      tray.systemDidWake();
      await vi.advanceTimersByTimeAsync(5 * WAKE_CHECK_MS);
      expect(Fake.instances).toHaveLength(0);
      idle.seconds = RETURN_IDLE_SECONDS;
      await vi.advanceTimersByTimeAsync(WAKE_CHECK_MS);
      expect(Fake.instances.map((n) => [n.options.body, n.shown])).toEqual([
        ["Saved a.mp4. Recording stopped because the Mac went to sleep.", 1],
        [expect.stringContaining("Click to view the recording result."), 1],
      ]);
      // Awake again: the next one is shown at once, and checking has stopped.
      tray.notifySaved("/Users/eric/Movies/RecordStuff/b.mp4");
      expect(Fake.instances).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never shows held notifications on a timer alone, and shows them at once on unlock", async () => {
    vi.useFakeTimers();
    try {
      const idle = { seconds: 0 };
      const { tray } = sleepy(idle);
      tray.systemWillSleep();
      tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(Fake.instances).toHaveLength(0);
      tray.userDidUnlock();
      expect(Fake.instances).toHaveLength(1);
      tray.userDidUnlock();
      expect(Fake.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the notification switch when held ones are shown", async () => {
    vi.useFakeTimers();
    try {
      let allowed = true;
      const { tray, logs } = sleepy({ seconds: 0 }, () => allowed);
      tray.systemWillSleep();
      tray.notifySaved("/Users/eric/Movies/RecordStuff/b.mp4");
      allowed = false;
      tray.systemDidWake();
      await vi.advanceTimersByTimeAsync(WAKE_CHECK_MS);
      expect(Fake.instances).toHaveLength(0);
      expect(logs.at(-1)).toBe("notification: turned off in settings, dropped: Saved b.mp4");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows at once after a wake with nothing held once the user is back, and holds while still away", async () => {
    vi.useFakeTimers();
    try {
      const idle = { seconds: 0 };
      const { tray } = sleepy(idle);
      tray.systemWillSleep();
      tray.systemDidWake();
      expect(vi.getTimerCount()).toBe(0);
      tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
      expect(Fake.instances.map((n) => n.shown)).toEqual([1]);
      expect(vi.getTimerCount()).toBe(0);

      tray.systemWillSleep();
      tray.systemDidWake();
      idle.seconds = 30;
      tray.notifySaved("/Users/eric/Movies/RecordStuff/b.mp4");
      expect(Fake.instances).toHaveLength(1);
      idle.seconds = 0;
      tray.notifySaved("/Users/eric/Movies/RecordStuff/c.mp4");
      // Held first, in order, then the new one.
      expect(Fake.instances.map((n) => n.options.body)).toEqual(["Saved a.mp4", "Saved b.mp4", "Saved c.mp4"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts input since the wake as a return, so a user who came back and paused is not held until their next keystroke", async () => {
    vi.useFakeTimers();
    try {
      const clock = { ms: 0 };
      // Without input the idle time grows with the time since the wake: 30 s before the sleep, plus every second awake.
      let lastInputAt: number | undefined;
      const idle = (): number => Math.floor(lastInputAt === undefined ? 30 + clock.ms / 1000 : (clock.ms - lastInputAt) / 1000);
      const { tray } = setup(true, undefined, idle, undefined, () => clock.ms);
      tray.systemWillSleep();
      tray.systemDidWake();
      // A maintenance wake: no input, however long it lasts.
      clock.ms = 10 * 60_000;
      tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
      expect(Fake.instances).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(WAKE_CHECK_MS);
      expect(Fake.instances).toHaveLength(0);
      // The user touched the Mac a minute ago and then paused: that input came after the wake.
      lastInputAt = clock.ms;
      clock.ms += 60_000;
      await vi.advanceTimersByTimeAsync(WAKE_CHECK_MS);
      expect(Fake.instances.map((n) => n.options.body)).toEqual(["Saved a.mp4"]);
      tray.notifySaved("/Users/eric/Movies/RecordStuff/b.mp4");
      expect(Fake.instances).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold while awake, ignores a wake or unlock without a sleep, and drops held notifications on destroy", async () => {
    vi.useFakeTimers();
    try {
      const { tray } = sleepy({ seconds: 0 });
      tray.systemDidWake();
      tray.userDidUnlock();
      tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
      expect(Fake.instances).toHaveLength(1);
      tray.systemWillSleep();
      tray.notifySaved("/Users/eric/Movies/RecordStuff/b.mp4");
      tray.destroy();
      tray.systemDidWake();
      await vi.advanceTimersByTimeAsync(10 * WAKE_CHECK_MS);
      expect(Fake.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});


it("contains native notification constructor failures", () => {
  const { tray, logs } = setup();
  Fake.throwOnConstruct = true;
  try {
    expect(() => tray.notifySaved("/saved.mp4")).not.toThrow();
    expect(logs.join("\n")).toContain("native notification unavailable");
  } finally { Fake.throwOnConstruct = false; tray.destroy(); }
});
