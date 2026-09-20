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
  isSupported(): boolean;
}

vi.mock("electron", () => {
  class FakeNotification {
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    shown = 0;
    close = vi.fn();
    static instances: FakeNotification[] = [];
    static supported = true;

    constructor(readonly options: { title: string; body: string; silent?: boolean }) {
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

  const image = { setTemplateImage: vi.fn() };
  // `app` only needs the activation events the reveal listens to.
  const app = new EventEmitter();
  return {
    app,
    Menu: { buildFromTemplate: vi.fn(() => ({})) },
    Notification: FakeNotification,
    Tray: class {
      setIgnoreDoubleClickEvents = vi.fn();
      setImage = vi.fn();
      setTitle = vi.fn();
      setToolTip = vi.fn();
      popUpContextMenu = vi.fn();
      destroy = vi.fn();
      on = vi.fn();
    },
    nativeImage: { createFromPath: vi.fn(() => image) },
    shell: { showItemInFolder: vi.fn() },
  };
});

import { app, Notification, shell } from "electron";
import type { Language } from "../shared/i18n";
import { DEFAULT_QUALITY } from "../shared/quality";
import { ACTIVATION_WINDOW_MS, AppTray } from "./tray";

const Fake = Notification as unknown as FakeNotificationCtor;

function setup(supported = true): { tray: AppTray; logs: string[] } {
  vi.mocked(shell.showItemInFolder).mockReset();
  app.removeAllListeners();
  Fake.instances.length = 0;
  Fake.supported = supported;
  const logs: string[] = [];
  const tray = new AppTray({
    resourcesDir: "/resources",
    context: () => ({
      platform: process.platform,
      outputDir: "/Users/eric/Movies/RecordStuff",
      homeDir: "/Users/eric",
      quality: DEFAULT_QUALITY,
      language: "en",
      hotkey: { ...DEFAULT_HOTKEY, registered: true },
      updates: { state: { kind: "idle" }, enabled: true },
    }),
    onToggle: vi.fn(),
    onAction: vi.fn(),
    log: (message) => logs.push(message),
  });
  return { tray, logs };
}

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

  it("logs and gives up when notifications are not supported at all", () => {
    const { tray, logs } = setup(false);
    tray.notifyError("no_audio_track", undefined);
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
      context: () => ({ platform: process.platform, outputDir: "/tmp/recordings", homeDir: "/tmp", quality: DEFAULT_QUALITY, language, hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: "idle" }, enabled: true } }),
      onToggle: vi.fn(), onAction: action,
    });
    tray.notifySaved("/tmp/demo.mp4");
    expect(Fake.instances.at(-1)?.options.body).toBe("Saved demo.mp4");
    language = "zh-TW";
    tray.refresh();
    tray.notifySaved("/tmp/demo.mp4");
    expect(Fake.instances.at(-1)?.options.body).toBe("已儲存 demo.mp4");
    tray.notifyError("permission_denied", undefined);
    expect(Fake.instances.at(-1)?.options.body).toContain("沒有螢幕錄製權限");
    Fake.instances.at(-1)?.listeners.get("click")?.();
    expect(action).toHaveBeenCalledWith("openPermissionSettings");
    tray.notifyLanguageWriteFailed();
    expect(Fake.instances.at(-1)?.options.body).toContain("無法儲存語言設定");
    language = "en";
    tray.notifyPermission(true);
    expect(Fake.instances.at(-1)?.options.body).toContain("needs to relaunch");
    Fake.instances.at(-1)?.listeners.get("click")?.();
    expect(action).toHaveBeenCalledWith("relaunch");
    tray.destroy();
  });
});
