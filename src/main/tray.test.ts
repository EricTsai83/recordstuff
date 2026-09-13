import { describe, expect, it, vi } from "vitest";

/**
 * A notification the OS refuses to show is invisible to the user *and* to the
 * developer (plan 004: a save whose notification never appeared, with nothing
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

import { Notification } from "electron";
import { DEFAULT_QUALITY } from "../shared/quality";
import { AppTray } from "./tray";

const Fake = Notification as unknown as FakeNotificationCtor;

function setup(supported = true): { tray: AppTray; logs: string[] } {
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

describe("AppTray notifications (plans/004-permission-flow-clean-tcc.md)", () => {
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
    expect(logs).toEqual(["notification: failed (Notification permission denied): 已儲存 a.mp4"]);
  });

  it("logs and gives up when notifications are not supported at all", () => {
    const { tray, logs } = setup(false);
    tray.notifyError("no_audio_track", "", undefined);
    expect(Fake.instances).toHaveLength(0);
    expect(logs.at(-1)).toContain("notification: not supported");
  });

  it("keeps the click handler working alongside the failure listener", () => {
    const { tray } = setup();
    tray.notifySaved("/Users/eric/Movies/RecordStuff/a.mp4");
    const notification = Fake.instances.at(-1);
    expect(notification?.listeners.get("click")).toBeTypeOf("function");
    expect(() => notification?.listeners.get("click")?.()).not.toThrow();
  });
});
