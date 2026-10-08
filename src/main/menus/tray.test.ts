import { DEFAULT_HOTKEY } from "../../shared/hotkey";
import { EventEmitter } from "node:events";
import path from "node:path";
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
    // Like Electron's Menu, it says when it closes.
    Menu: { buildFromTemplate: vi.fn(() => new EventEmitter()) },
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
      setContextMenu = vi.fn(this.live);
      destroy = vi.fn(() => { this.destroyed = true; });
      on = vi.fn();
    },
    nativeImage: { createFromPath: vi.fn((file: string) => image(file)) },
    shell: { showItemInFolder: vi.fn() },
  };
});

import { app, Menu, Notification, shell } from "electron";
import type { Language } from "../../shared/i18n";
import { DEFAULT_QUALITY } from "../../shared/quality";
import { AppTray, NOTIFICATIONS_KEPT, RETURN_IDLE_SECONDS, TRAY_ICON_FILES, WAKE_CHECK_MS } from "./tray";

const Fake = Notification as unknown as FakeNotificationCtor;

const onToggle = vi.fn();
/** The saved notification's click; reset with each setup. */
const showSaved = vi.fn();
/** The icon's left click the context reports; each test sets what it needs. */
let trayClick: "menu" | "record" | undefined;
function setup(supported = true, canNotify?: () => boolean, idleSeconds?: () => number, onNotificationClick?: () => void, now?: () => number): { tray: AppTray; logs: string[]; onAction: ReturnType<typeof vi.fn> } {
  vi.mocked(shell.showItemInFolder).mockReset();
  showSaved.mockReset();
  app.removeAllListeners();
  Fake.instances.length = 0;
  Fake.supported = supported;
  const logs: string[] = [];
  const onAction = vi.fn();
  onToggle.mockReset();
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
      ...(trayClick ? { trayClick } : {}),
    }),
    onToggle,
    showSaved,
    permissionAction: vi.fn(),
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
    expect(created.mock.calls.map(([file]) => file)).toEqual(Object.values(TRAY_ICON_FILES).map((files) => path.join("/resources", process.platform === "win32" ? files.win32 : files.template)));
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
    new AppTray({ resourcesDir: "/missing", context: () => { throw new Error("unused"); }, onToggle: vi.fn(), onAction: vi.fn(), showSaved: vi.fn(), permissionAction: vi.fn(), log: (m) => logs.push(m) });
    expect(logs.filter((m) => m.startsWith("tray: icon "))).toHaveLength(Object.keys(TRAY_ICON_FILES).length);
    expect(logs[0]).toContain(`${path.join("/missing")}${path.sep}`);
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

  it("holds only the newest notifications, letting older ones go without closing them", () => {
    const { tray } = setup();
    for (let index = 0; index < NOTIFICATIONS_KEPT + 3; index++) tray.notifySaved(`/tmp/${index}.mp4`);
    const shown = [...Fake.instances];
    tray.destroy();
    // Only the ones still held are closed at shutdown; the three let go were never closed.
    expect(shown.map(notification => notification.close.mock.calls.length))
      .toEqual([...Array(3).fill(0), ...Array(NOTIFICATIONS_KEPT).fill(1)]);
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
    expect(order).toEqual(["clicked", "openRecordingSettings"]);
    tray.notifyTrayHint();
    Fake.instances.at(-1)!.listeners.get("click")?.();
    expect(order).toEqual(["clicked", "openRecordingSettings", "clicked"]);
  });

  it("opens Settings at the shortcut card from the shortcut-refused banner that tells the user to go there", () => {
    const { tray, onAction } = setup();
    tray.notifyHotkeyRegistrationFailed(DEFAULT_HOTKEY.accelerator);
    const notification = Fake.instances.at(-1)!;
    expect(notification.options.body).toContain("Open RecordStuff to choose another shortcut.");
    notification.listeners.get("click")?.();
    expect(onAction).toHaveBeenCalledWith("openShortcutSettings");
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
    tray.notifyAnswer("RecordStuff will stay open.");
    expect(Fake.instances.map((notification) => notification.options)).toEqual([{ title: "RecordStuff", body: "RecordStuff will stay open.", silent: true }]);
    expect(Fake.instances[0]!.shown).toBe(1);
  });

  it("tells an output-folder problem found during recording work with the switch off, since the user clicked (plan 056)", () => {
    const { tray } = setup(true, () => false);
    tray.notifyOutputFolderProblem("/Volumes/X was not found.");
    expect(Fake.instances.map((notification) => notification.options)).toEqual([{ title: "Could not open the output folder", body: "/Volumes/X was not found.", silent: true }]);
    expect(Fake.instances[0]!.shown).toBe(1);
  });

  it("tells System Settings could not open during recording work with the switch off, since the user clicked (plan 056)", () => {
    const { tray } = setup(true, () => false);
    tray.notifyAnswer("Could not open System Settings.");
    expect(Fake.instances.map((notification) => notification.options)).toEqual([{ title: "RecordStuff", body: "Could not open System Settings.", silent: true }]);
    expect(Fake.instances[0]!.shown).toBe(1);
  });

  it("answers a click that needs permission with the switch off, but drops the automatic permission notice", () => {
    const { tray, logs } = setup(true, () => false);
    tray.notifyPermission(false);
    expect(Fake.instances).toHaveLength(0);
    expect(logs.filter((line) => line.includes("turned off in settings"))).toHaveLength(1);
    tray.notifyPermission(false, true);
    expect(Fake.instances).toHaveLength(1);
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

  it("opens the saved recording in Recordings from its notification, never Finder (2026-10-04)", () => {
    const { tray, logs } = setup();
    const file = "/Users/eric/Movies/RecordStuff/測試 錄影 2026-09-20 01-27-11.mp4";
    tray.notifySaved(file);
    expect(showSaved).not.toHaveBeenCalled();
    Fake.instances.at(-1)?.listeners.get("click")?.();
    expect(showSaved).toHaveBeenCalledExactlyOnceWith(file);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(logs).toContain(`notification: show saved ${file}`);
    // The activation macOS gives the clicked app is what brings the window forward: nothing waits for it.
    expect(app.listenerCount("did-become-active")).toBe(0);
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
    const permissionAction = vi.fn();
    const tray = new AppTray({
      resourcesDir: "/resources",
      context: () => ({ platform: process.platform, outputDir: "/tmp/recordings", homeDir: "/tmp", quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, language, hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: "idle" }, enabled: true }, notifications: true, displays: [], display: { kind: "primary" } }),
      onToggle: vi.fn(), onAction: action, showSaved: vi.fn(), permissionAction,
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
    expect(Fake.instances.at(-1)?.options.body).toContain("then click to relaunch");
    Fake.instances.at(-1)?.listeners.get("click")?.();
    // Main resolves the click against the permission state it has then, not the one the banner was sent for.
    expect(permissionAction).toHaveBeenCalledOnce();
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

it("answers an update notification's click with main's download opener, not a tray action, and drops it when notifications are off", () => {
  const { tray, onAction } = setup();
  const openDownload = vi.fn();
  tray.notifyUpdateAvailable("9.0.0", openDownload);
  const notification = Fake.instances[0]!;
  expect(notification.options.body).toBe("RecordStuff 9.0.0 is available. Click to open the download page.");
  notification.listeners.get("click")?.();
  expect(openDownload).toHaveBeenCalledOnce();
  expect(onAction).not.toHaveBeenCalled();
  tray.destroy();
  const off = setup(true, () => false);
  off.tray.notifyUpdateAvailable("9.0.0", openDownload);
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
    expect(template.find((entry) => entry.label === "Quit RecordStuff")).not.toHaveProperty("accelerator");
    expect(template.at(-1)).toMatchObject({ label: "Quit RecordStuff" });
  });

  it("logs the menu it pops up, so a native runner can compare the NSMenu with it (plan 063)", async () => {
    const { Menu, Tray } = await import("electron");
    const { tray, logs } = setup();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    const instance = (tray as unknown as { tray: InstanceType<typeof Tray> }).tray;
    const rightClick = vi.mocked(instance.on).mock.calls.find(([name]) => name === "right-click")?.[1] as () => void;
    rightClick();
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]![0] as Electron.MenuItemConstructorOptions[];
    const line = logs.find((message) => message.startsWith("tray: menu opened in idle: "))!;
    const logged = JSON.parse(line.slice("tray: menu opened in idle: ".length)) as Array<{ separator?: true; label?: string; enabled?: boolean; accelerator?: string }>;
    expect(logged).toEqual(template.map((entry) => entry.type === "separator" ? { separator: true }
      : { label: entry.label, enabled: entry.enabled, ...(entry.accelerator === undefined ? {} : { accelerator: entry.accelerator }) }));
    expect(logged.find((entry) => entry.label === "Start recording")).toEqual({ label: "Start recording", enabled: true, accelerator: "CommandOrControl+Shift+1" });
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
        [`Saved a.mp4. Stopped because the ${process.platform === "darwin" ? "Mac" : "computer"} went to sleep.`, 1],
        [expect.stringContaining("Click for details."), 1],
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

describe("the icon's left click (2026-10-04)", () => {
  type Native = { on: ReturnType<typeof vi.fn>; popUpContextMenu: ReturnType<typeof vi.fn> };
  const nativeOf = (tray: AppTray): Native => (tray as unknown as { tray: Native }).tray;
  const leftClick = (native: Native): void => {
    const handler = native.on.mock.calls.findLast((call: unknown[]) => call[0] === "click")?.[1] as (() => void) | undefined;
    handler?.();
  };
  it("opens the menu when the user chose the menu, and records only from it", () => {
    trayClick = "menu";
    const native = nativeOf(setup().tray);
    native.popUpContextMenu.mockClear();
    leftClick(native);
    expect(native.popUpContextMenu).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });
  it("starts or stops recording when the user chose that, and when an older context names no choice", () => {
    for (const choice of ["record", undefined] as const) {
      trayClick = choice;
      const native = nativeOf(setup().tray);
      native.popUpContextMenu.mockClear();
      leftClick(native);
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(native.popUpContextMenu).not.toHaveBeenCalled();
    }
    trayClick = undefined;
  });
  it("reads the choice alone at a click when given it, without projecting the whole context", () => {
    setup();
    const context = vi.fn(() => { throw new Error("not needed for a click"); });
    const tray = new AppTray({ resourcesDir: "/resources", context, trayClick: () => "record", onToggle, showSaved, permissionAction: vi.fn(), onAction: vi.fn() });
    leftClick(nativeOf(tray));
    expect([onToggle.mock.calls.length, context.mock.calls.length]).toEqual([1, 0]);
  });
  it("knows while its menu is open and says when it closes, so a Dock icon hide can wait for it", () => {
    trayClick = "menu";
    const menuClosed = vi.fn();
    setup();
    const tray = new AppTray({ resourcesDir: "/resources", context: () => ({ platform: "darwin", outputDir: "/o", homeDir: "/h", quality: DEFAULT_QUALITY,
      countdown: 3, countdownSound: true, language: "en", hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: "idle" }, enabled: true },
      notifications: true, displays: [], display: { kind: "primary" }, trayClick: "menu" }), onToggle, showSaved, permissionAction: vi.fn(), onAction: vi.fn(), menuClosed });
    expect(tray.menuOpen).toBe(false);
    leftClick(nativeOf(tray));
    expect(tray.menuOpen).toBe(true);
    const menu = vi.mocked(Menu.buildFromTemplate).mock.results.at(-1)!.value as EventEmitter;
    menu.emit("menu-will-close");
    expect([tray.menuOpen, menuClosed.mock.calls.length]).toEqual([false, 1]);
    trayClick = undefined;
  });
  it("follows a change of choice at the next click, without a new tray", () => {
    trayClick = "record";
    const native = nativeOf(setup().tray);
    trayClick = "menu";
    native.popUpContextMenu.mockClear();
    leftClick(native);
    expect(native.popUpContextMenu).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    trayClick = undefined;
  });
});

describe("the menu a press attaches on macOS (2026-10-05)", () => {
  type Native = { on: ReturnType<typeof vi.fn>; popUpContextMenu: ReturnType<typeof vi.fn>; setContextMenu: ReturnType<typeof vi.fn> };
  const handler = (native: Native, name: string): (() => void) => native.on.mock.calls.findLast((call: unknown[]) => call[0] === name)?.[1] as () => void;
  /** Electron's order for a mouse press on a menu that opens: `mouse-down`, then `click`, then the menu shows. */
  const press = (native: Native): void => { handler(native, "mouse-down")(); handler(native, "click")(); };
  /** A tray on `platform` whose click reads `choice()`, with the hotkey and language of the other tests. */
  function pressSetup(platform: NodeJS.Platform, choice: () => "menu" | "record") {
    setup();
    const logs: string[] = [];
    const menuClosed = vi.fn();
    const tray = new AppTray({ resourcesDir: "/resources", context: () => ({ platform, outputDir: "/o", homeDir: "/h", quality: DEFAULT_QUALITY,
      countdown: 3, countdownSound: true, language: "en", hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: "idle" }, enabled: true },
      notifications: true, displays: [], display: { kind: "primary" } }), trayClick: choice, onToggle, showSaved, permissionAction: vi.fn(),
      onAction: vi.fn(), menuClosed, log: (message) => logs.push(message) });
    const native = (tray as unknown as { tray: Native }).tray;
    native.popUpContextMenu.mockClear();
    return { tray, native, logs, menuClosed };
  }
  const lastMenu = (): EventEmitter => vi.mocked(Menu.buildFromTemplate).mock.results.at(-1)!.value as EventEmitter;

  it("attaches the current menu on the press, so macOS opens it there, and the click that follows does nothing", () => {
    vi.useFakeTimers();
    try {
      const { tray, native, logs, menuClosed } = pressSetup("darwin", () => "menu");
      tray.render({ type: "countdown", remaining: 2 });
      press(native);
      const menu = lastMenu();
      expect(native.setContextMenu.mock.calls).toEqual([[menu]]);
      expect([native.popUpContextMenu.mock.calls.length, onToggle.mock.calls.length]).toEqual([0, 0]);
      // Showing it logs the line the tray runner compares, once, and marks it open for the Dock icon's hide.
      menu.emit("menu-will-show");
      menu.emit("menu-will-show");
      expect(tray.menuOpen).toBe(true);
      expect(logs.filter(line => line.startsWith("tray: menu opened in countdown: ")).length).toBe(1);
      expect(logs.at(-1)).toContain("\"label\":\"Cancel recording\"");
      // Open: it stays attached through the timers.
      vi.runAllTimers();
      expect(native.setContextMenu).toHaveBeenCalledTimes(1);
      menu.emit("menu-will-close");
      expect([tray.menuOpen, menuClosed.mock.calls.length]).toEqual([false, 1]);
      // Taken off after the close's own callback, not inside it.
      expect(native.setContextMenu).toHaveBeenCalledTimes(1);
      vi.runAllTimers();
      expect(native.setContextMenu.mock.calls.at(-1)).toEqual([null]);
      // Nothing attached any more: the next press attaches a menu of its own.
      press(native);
      expect(native.setContextMenu.mock.calls.at(-1)).toEqual([lastMenu()]);
      expect(lastMenu()).not.toBe(menu);
      tray.destroy();
    } finally { vi.useRealTimers(); }
  });

  it("takes off a menu that did not open, so a later click that records cannot open it", () => {
    vi.useFakeTimers();
    try {
      let choice: "menu" | "record" = "menu";
      const { tray, native } = pressSetup("darwin", () => choice);
      handler(native, "mouse-down")();
      vi.runAllTimers();
      expect(native.setContextMenu.mock.calls.at(-1)).toEqual([null]);
      choice = "record";
      press(native);
      expect(native.setContextMenu).toHaveBeenCalledTimes(2);
      expect(onToggle).toHaveBeenCalledTimes(1);
      tray.destroy();
    } finally { vi.useRealTimers(); }
  });

  it("keeps a later press's menu when an earlier one's removal runs after it", () => {
    vi.useFakeTimers();
    try {
      const { tray, native } = pressSetup("darwin", () => "menu");
      handler(native, "mouse-down")();
      const first = lastMenu();
      first.emit("menu-will-show");
      first.emit("menu-will-close");
      // Pressed again before the first menu came off: a fresh menu replaces it, and the late removal leaves it.
      handler(native, "mouse-down")();
      const second = lastMenu();
      second.emit("menu-will-show");
      vi.runAllTimers();
      expect(native.setContextMenu.mock.calls).toEqual([[first], [second]]);
      expect(tray.menuOpen).toBe(true);
      tray.destroy();
    } finally { vi.useRealTimers(); }
  });

  it("attaches nothing while a left click records, nor on Windows, nor for VoiceOver's press, which clicks first", () => {
    for (const [platform, choice] of [["darwin", "record"], ["win32", "menu"]] as const) {
      const { tray, native } = pressSetup(platform, () => choice);
      press(native);
      expect(native.setContextMenu).not.toHaveBeenCalled();
      expect(choice === "record" ? onToggle : native.popUpContextMenu).toHaveBeenCalledTimes(1);
      tray.destroy();
    }
    const { tray, native } = pressSetup("darwin", () => "menu");
    handler(native, "click")();
    handler(native, "mouse-down")();
    expect([native.popUpContextMenu.mock.calls.length, native.setContextMenu.mock.calls.length]).toEqual([1, 0]);
    tray.destroy();
  });

  it("ignores a press after the tray is destroyed", () => {
    const { tray, native } = pressSetup("darwin", () => "menu");
    tray.destroy();
    expect(() => handler(native, "mouse-down")()).not.toThrow();
    expect(native.setContextMenu).not.toHaveBeenCalled();
  });
});
