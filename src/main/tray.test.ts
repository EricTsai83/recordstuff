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
  return {
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

import { Notification, shell } from "electron";
import type { Language } from "../shared/i18n";
import { DEFAULT_QUALITY } from "../shared/quality";
import { AppTray } from "./tray";

const Fake = Notification as unknown as FakeNotificationCtor;

function setup(supported = true): { tray: AppTray; logs: string[] } {
  vi.mocked(shell.showItemInFolder).mockReset();
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
    }),
    onToggle: vi.fn(),
    onAction: vi.fn(),
    log: (message) => logs.push(message),
  });
  return { tray, logs };
}

describe("AppTray notifications (docs/system-design/desktop.md)", () => {
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
    expect(logs).toEqual(["notification: failed (Notification permission denied): Saved a.mp4"]);
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
      context: () => ({ platform: process.platform, outputDir: "/tmp/recordings", homeDir: "/tmp", quality: DEFAULT_QUALITY, language }),
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
