/**
 * The application menu, and on macOS the app's presence in the Dock (2026-10-04, at the maintainer's request).
 *
 * RecordStuff lives in the menu bar. While its window is open on macOS it is also an ordinary app, as other
 * recorders are: a Dock icon, and its menus in the menu bar with a Record menu that starts, stops or cancels
 * as the tray does ([tray-model.ts](tray-model.ts) `recordMenu`). The Dock icon's menu offers the same items.
 * When the window closes, or RecordStuff is hidden (⌘H), it is a menu-bar app again; only Quit ends it. macOS shows
 * an app's menus only while it is a regular app, which always brings a Dock icon, so the two come and go together.
 *
 * Without a window the menu stays, undrawn: macOS still routes key equivalents through it, so it keeps Quit,
 * Hide, copy and paste, and Minimize, and leaves out Electron's default Reload and Developer Tools. Elsewhere
 * no menu removes the menu bar.
 */
import { Menu, app, nativeImage, type MenuItemConstructorOptions } from "electron";
import { translate, type Language, type PlainMessageKey } from "../shared/i18n";
import type { RecordingState } from "../shared/state";
import { recordMenu, type TrayMenuItem } from "./tray-model";
import type { AppAction, AppContext } from "./ui-model";
import type { ZoomRequest } from "./settings-window";

/**
 * The app, Edit and Window menus in the app's language, which Electron's roles would leave in English. They keep
 * the key equivalents the window relies on (Quit, Hide, copy and paste, Minimize); Close stays out, as the page
 * closes on ⌘W itself, and Zoom too, as the window is not maximizable. View lists the page's zoom keys (2026-10-05):
 * the window handles them itself on every platform (settings-window.ts `zoomRequest`), so the items show their keys
 * without binding them, and a key is never handled twice.
 */
function systemMenus(language: Language, record: MenuItemConstructorOptions[], hide?: () => void, zoom?: (request: ZoomRequest) => void): MenuItemConstructorOptions[] {
  const t = (key: PlainMessageKey): string => translate(key, language);
  const separator: MenuItemConstructorOptions = { type: "separator" };
  return [
    { role: "appMenu", submenu: [
      { role: "about", label: t("About RecordStuff") }, separator,
      { role: "services", label: t("Services") }, separator,
      // Hiding leaves the menu bar's icon alone, as closing does: no Dock icon stays behind (2026-10-05).
      hide ? { label: t("Hide RecordStuff"), accelerator: "Command+H", click: hide } : { role: "hide", label: t("Hide RecordStuff") },
      { role: "hideOthers", label: t("Hide Others") }, { role: "unhide", label: t("Show All") }, separator,
      { role: "quit", label: t("Quit RecordStuff") },
    ] },
    { label: t("Edit"), submenu: [
      { role: "undo", label: t("Undo") }, { role: "redo", label: t("Redo") }, separator,
      { role: "cut", label: t("Cut") }, { role: "copy", label: t("Copy") }, { role: "paste", label: t("Paste") }, { role: "selectAll", label: t("Select All") },
    ] },
    ...(zoom ? [{ label: t("View"), submenu: [
      { label: t("Actual Size"), accelerator: "Command+0", registerAccelerator: false, click: () => zoom("reset") },
      { label: t("Zoom In"), accelerator: "Command+Plus", registerAccelerator: false, click: () => zoom("in") },
      { label: t("Zoom Out"), accelerator: "Command+-", registerAccelerator: false, click: () => zoom("out") },
    ] } satisfies MenuItemConstructorOptions] : []),
    ...record,
    { label: t("Window"), role: "window", submenu: [{ role: "minimize", label: t("Minimize") }, separator, { role: "front", label: t("Bring All to Front") }] },
  ];
}

/** When a hidden Dock icon is looked at again (see `hideDock`). */
const DOCK_RECHECK_MS = [300, 1000] as const;

/** SF Symbols beside the state's own actions, as macOS menus draw them. */
const SYMBOLS: Partial<Record<string, string>> = { start: "record.circle", stop: "stop.circle", cancelCountdown: "xmark.circle" };

export interface AppMenuOptions {
  /** Hide RecordStuff (⌘H): the window goes out of sight and the app is a menu-bar app until it is opened again. */
  hide?: () => void;
  /** Zooms the window's page (View → Zoom In, Zoom Out, Actual Size). */
  zoom?: (request: ZoomRequest) => void;
  state: () => RecordingState;
  context: () => AppContext;
  /** The saved language, readable before the rest of the context exists. */
  language: () => Language;
  onAction: (action: AppAction) => void;
  /** The tray's menu is open: a Dock icon hide then would close it, so it waits for `trayMenuClosed`. */
  trayMenuOpen?: () => boolean;
  log?: (message: string) => void;
}

export class AppMenu {
  private windowOpen = false;
  /** A recheck found the Dock icon back while the tray's menu was open, and hides it once that menu closes. */
  private hidePending = false;
  /** What the menus were last built from: most refreshes change nothing they show, and a rebuild would close an open menu. */
  private built: string | undefined;

  constructor(private readonly options: AppMenuOptions) {
    this.refresh();
  }

  /** The window is being shown: a Dock icon and the menus, then the app comes forward again, as a new Dock app may not be. */
  windowOpened(): void {
    if (process.platform !== "darwin" || this.windowOpen) return;
    this.windowOpen = true;
    this.refresh();
    // The bundle declares no LSUIElement (2026-10-05, at the maintainer's request): with it, an app reopened from
    // Finder or Spotlight was made active while still a menu-bar app and kept the previous app's menu bar until the
    // user switched apps (macOS 26, 0 of 3 probes); without it the menus came every time (3 of 3).
    void app.dock?.show().then(() => {
      // Closed while the icon was coming: its hide ran first and must still win.
      if (this.windowOpen) app.focus({ steal: true }); else this.hideDock();
    }, (cause: unknown) => this.options.log?.(`app menu: Dock icon not shown: ${String(cause)}`));
  }

  /** The window closed or its page died: back to the menu bar alone. */
  windowClosed(): void {
    if (process.platform !== "darwin" || !this.windowOpen) return;
    this.windowOpen = false;
    this.hideDock();
    this.refresh();
  }

  /**
   * Hides the Dock icon, and looks again shortly after: a hide that lands while macOS is still making the app a
   * regular one (⌘H as the window loads) was undone when that finished, leaving the icon and the menus behind a
   * hidden window (2026-10-05, 3 of 3 on the built app).
   */
  private hideDock(): void {
    app.dock?.hide();
    for (const ms of DOCK_RECHECK_MS) setTimeout(() => this.hideDockAgain(), ms);
  }

  /**
   * A hide transforms the process, which closes any menu that is open: the tray's menu opened just after the window
   * closed vanished under the pointer about a second later (2026-10-05, `pnpm acceptance:tray`). While it is open,
   * the hide waits for it to close (`trayMenuClosed`).
   */
  private hideDockAgain(): void {
    if (this.windowOpen || !app.dock?.isVisible()) return;
    if (this.options.trayMenuOpen?.()) { this.hidePending = true; return; }
    this.hidePending = false;
    app.dock.hide();
  }

  /** The tray's menu closed: a hide held back while it was open runs now, if the window is still closed. */
  trayMenuClosed(): void {
    if (!this.hidePending) return;
    this.hidePending = false;
    this.hideDockAgain();
  }

  /** The state or the context changed: the Record menu follows, as the tray does. */
  refresh(): void {
    if (process.platform !== "darwin") {
      if (this.built === undefined) Menu.setApplicationMenu(null);
      this.built = "";
      return;
    }
    // Without a window only the language is read: at launch the menu is installed before the recorder exists.
    const ctx = this.windowOpen ? this.options.context() : undefined;
    const language = ctx?.language ?? this.options.language();
    const items = ctx ? recordMenu(this.options.state(), ctx) : [];
    const key = JSON.stringify([language, items]);
    if (key === this.built) return;
    this.built = key;
    const record: MenuItemConstructorOptions[] = items.length
      ? [{ label: translate("Record", language), submenu: items.map(entry => this.toTemplate(entry)) }] : [];
    Menu.setApplicationMenu(Menu.buildFromTemplate(systemMenus(language, record, this.options.hide, this.options.zoom)));
    // The Dock's own items (Show All Windows, Quit) follow ours.
    if (items.length) app.dock?.setMenu(Menu.buildFromTemplate(items.map(entry => this.toTemplate(entry))));
  }

  private toTemplate(entry: TrayMenuItem): MenuItemConstructorOptions {
    if (entry.kind === "separator") return { type: "separator" };
    const template: MenuItemConstructorOptions = { label: entry.label, enabled: entry.enabled };
    if (entry.toolTip !== undefined) template.toolTip = entry.toolTip;
    // The registered recording shortcut, shown as other apps show theirs. On macOS a menu's shortcut is a key
    // equivalent too, but the global shortcut takes the keys first; while the editor suspends it to record a new
    // one, it is not registered, so `recordMenu` names none and the menu cannot start a recording instead.
    if (entry.accelerator !== undefined) template.accelerator = entry.accelerator;
    const symbol = typeof entry.action === "string" ? SYMBOLS[entry.action] : undefined;
    if (symbol) {
      const image = nativeImage.createMenuSymbol(symbol);
      if (!image.isEmpty()) template.icon = image;
    }
    const action = entry.action;
    if (action) template.click = () => this.options.onAction(action);
    return template;
  }
}
