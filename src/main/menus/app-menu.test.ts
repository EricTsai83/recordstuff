import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY } from "../../shared/quality";
import { DEFAULT_HOTKEY } from "../../shared/hotkey";
import type { RecordingState } from "../../shared/state";
import type { AppContext } from "../app/ui-model";

const electron = vi.hoisted(() => {
  const dock = { show: vi.fn(() => Promise.resolve()), hide: vi.fn(), setMenu: vi.fn(), visible: false, isVisible: vi.fn(() => dock.visible) };
  return {
    dock,
    focus: vi.fn(),
    setApplicationMenu: vi.fn(),
    reset() { for (const mock of [dock.show, dock.hide, dock.setMenu, this.focus, this.setApplicationMenu]) mock.mockClear(); },
  };
});
vi.mock("electron", () => ({
  app: { dock: electron.dock, focus: electron.focus },
  Menu: {
    buildFromTemplate: (template: unknown) => ({ template }),
    setApplicationMenu: electron.setApplicationMenu,
  },
  nativeImage: { createMenuSymbol: (name: string) => ({ name, isEmpty: () => false }) },
}));

const { AppMenu } = await import("./app-menu");

const ctx: AppContext = {
  platform: "darwin", language: "en", outputDir: "/Users/eric/Movies/RecordStuff", homeDir: "/Users/eric",
  quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true,
  hotkey: { ...DEFAULT_HOTKEY, registered: true },
  updates: { state: { kind: "idle" }, enabled: true }, notifications: true,
  displays: [], display: { kind: "primary" },
};
type Template = { label?: string; role?: string; type?: string; enabled?: boolean; accelerator?: string; icon?: { name: string }; click?: () => void; submenu?: Template[] };
const lastMenu = (): Template[] => (electron.setApplicationMenu.mock.lastCall as unknown as [{ template: Template[] }])[0].template;
const titles = (menu: Template[]) => menu.map(entry => entry.label ?? entry.role);

describe("the app menu and Dock icon (2026-10-04)", () => {
  const platform = process.platform;
  let state: RecordingState;
  let menu: InstanceType<typeof AppMenu>;
  const onAction = vi.fn();
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    electron.reset(); onAction.mockClear();
    state = { type: "idle" };
    menu = new AppMenu({ state: () => state, context: () => ctx, language: () => ctx.language, onAction });
  });
  afterEach(() => { Object.defineProperty(process, "platform", { value: platform }); });

  it("keeps the key-equivalent menu without a window, and adds Record and the Dock icon while one is open", async () => {
    expect(titles(lastMenu())).toEqual(["appMenu", "Edit", "Window"]);
    menu.windowOpened();
    expect(titles(lastMenu())).toEqual(["appMenu", "Edit", "Record", "Window"]);
    const start = lastMenu()[2]!.submenu![0]!;
    expect([start.label, start.accelerator, start.icon?.name]).toEqual(["Start recording", ctx.hotkey.accelerator, "record.circle"]);
    start.click!();
    expect(onAction).toHaveBeenCalledWith("start");
    expect(electron.dock.show).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(electron.focus).toHaveBeenCalledWith({ steal: true });
    // The Dock icon's menu offers the same items.
    expect((electron.dock.setMenu.mock.lastCall as unknown as [{ template: Template[] }])[0].template.map(entry => entry.label ?? entry.type))
      .toEqual(["Start recording", "separator", "Show last recording"]);
    menu.windowClosed();
    expect(electron.dock.hide).toHaveBeenCalledOnce();
    expect(titles(lastMenu())).toEqual(["appMenu", "Edit", "Window"]);
  });

  it("keeps the key equivalents the window relies on, in the app's language", () => {
    const keys = lastMenu().flatMap(entry => entry.submenu ?? []).flatMap(entry => entry.role ? [entry.role] : []);
    expect(keys).toEqual(expect.arrayContaining(["quit", "hide", "copy", "paste", "selectAll", "minimize"]));
    expect(keys).not.toContain("close");
    const zh = new AppMenu({ state: () => state, context: () => ({ ...ctx, language: "zh-TW" }), language: () => "zh-TW", onAction });
    zh.windowOpened();
    expect(titles(lastMenu())).toEqual(["appMenu", "編輯", "錄影", "視窗"]);
    expect(lastMenu()[1]!.submenu!.map(entry => entry.label ?? entry.type)).toEqual(["還原", "重做", "separator", "剪下", "拷貝", "貼上", "全選"]);
  });

  it("hides into the menu bar on Hide RecordStuff, leaving no Dock icon behind (2026-10-05)", () => {
    const hide = vi.fn();
    const hiding = new AppMenu({ state: () => state, context: () => ctx, language: () => ctx.language, onAction, hide });
    hiding.windowOpened();
    const item = lastMenu()[0]!.submenu!.find(entry => entry.label === "Hide RecordStuff")!;
    expect([item.role, item.accelerator]).toEqual([undefined, "Command+H"]);
    item.click!();
    expect(hide).toHaveBeenCalledOnce();
    // Without the callback the system's own Hide stays.
    expect(titles(lastMenu()[0]!.submenu!)).toContain("Hide RecordStuff");
  });
  it("lists the page's zoom keys under View without binding them, and runs the same zoom when chosen (2026-10-05)", () => {
    const zoom = vi.fn();
    const zooming = new AppMenu({ state: () => state, context: () => ctx, language: () => ctx.language, onAction, zoom });
    zooming.windowOpened();
    expect(titles(lastMenu())).toEqual(["appMenu", "Edit", "View", "Record", "Window"]);
    const items = lastMenu()[2]!.submenu! as Array<Template & { registerAccelerator?: boolean }>;
    expect(items.map(entry => [entry.label, entry.accelerator, entry.registerAccelerator]))
      .toEqual([["Actual Size", "Command+0", false], ["Zoom In", "Command+Plus", false], ["Zoom Out", "Command+-", false]]);
    items[1]!.click!();
    expect(zoom).toHaveBeenCalledWith("in");
  });
  it("hides the Dock icon again when macOS finishes making the app regular after a quick hide (2026-10-05)", () => {
    vi.useFakeTimers();
    try {
      menu.windowOpened();
      menu.windowClosed();
      electron.dock.hide.mockClear();
      // The transform the open started lands after the hide: the icon is back.
      electron.dock.visible = true;
      vi.advanceTimersByTime(300);
      expect(electron.dock.hide).toHaveBeenCalledOnce();
      // Opened again meanwhile: the icon belongs to the window and stays.
      menu.windowOpened();
      electron.dock.hide.mockClear();
      vi.advanceTimersByTime(1000);
      expect(electron.dock.hide).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); electron.dock.visible = false; }
  });
  it("holds a Dock icon hide back while the tray's menu is open, which the hide would close, and runs it once the menu closes", () => {
    vi.useFakeTimers();
    let trayOpen = false;
    const held = new AppMenu({ state: () => state, context: () => ctx, language: () => ctx.language, onAction, trayMenuOpen: () => trayOpen });
    try {
      held.windowOpened();
      held.windowClosed();
      electron.dock.hide.mockClear();
      electron.dock.visible = true;
      // The tray's menu opened just after the window closed: the recheck must not close it under the pointer.
      trayOpen = true;
      vi.advanceTimersByTime(1000);
      expect(electron.dock.hide).not.toHaveBeenCalled();
      trayOpen = false;
      held.trayMenuClosed();
      expect(electron.dock.hide).toHaveBeenCalledOnce();
      // Without a hide held back, a closing menu changes nothing; nor does it once the window is open again.
      held.trayMenuClosed();
      held.windowOpened();
      held.trayMenuClosed();
      expect(electron.dock.hide).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); electron.dock.visible = false; }
  });
  it("rebuilds only when what it shows changes, so a menu held open stays open", () => {
    menu.windowOpened();
    const builds = electron.setApplicationMenu.mock.calls.length;
    state = { type: "countdown", remaining: 3 }; menu.refresh();
    state = { type: "countdown", remaining: 2 }; menu.refresh();
    expect(electron.setApplicationMenu.mock.calls.length).toBe(builds + 1);
    state = { type: "recording", startedAt: "2026-10-04T00:00:00Z" }; menu.refresh();
    expect(lastMenu()[2]!.submenu![0]!.label).toBe("Stop recording");
  });

  it("hides the Dock icon again when the window closed before it finished appearing", async () => {
    menu.windowOpened();
    menu.windowClosed();
    await Promise.resolve();
    expect(electron.dock.hide).toHaveBeenCalledTimes(2);
    expect(electron.focus).not.toHaveBeenCalled();
  });
});
