/**
 * Native macOS input and Accessibility reads for the scripted acceptance runners
 * (plan 063; docs/system-design/tooling.md#scripted-native-acceptance). One
 * JavaScript for Automation helper calls the AX C API through the ObjC bridge,
 * which reads a menu in about 0.1 s where System Events took 29 s, and posts
 * CoreGraphics mouse and key events, which the OS delivers like a person's.
 * Every read names its target by pid; nothing here looks up an app by name.
 * The parsers are pure and unit-tested against recorded dumps (native-ax.test.ts).
 */
import { command } from "./processes.mts";

/**
 * `osascript -l JavaScript -e <script> <command> …`, one JSON object out.
 * Commands: `status <pid>`, `press <pid> <menu index>`, `mouse left|right <x> <y>`,
 * `key <code> [flags]`, `windows <pid>`, `layout <pid> <title> <zone json>`, `menubar <pid>`, `manual <pid>`, `banners`,
 * `pasteboard-save <dir>` and `pasteboard-restore <manifest json>`.
 * `drag-events <event json>`, `release-mouse`, `move-mouse <x> <y>`, `screen-access` support native window dragging.
 * Any failed AX call is reported as its AXError code rather than thrown, so the
 * caller can tell a missing permission (-25211) from an element that is gone.
 */
export const AX_SCRIPT = String.raw`
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
function run(argv) {
  ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
  ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
  ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
  ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
  ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
  ObjC.bindFunction('CFCopyDescription', ['id', ['id']]);
  const [cmd, a, b, c] = argv;
  const out = value => JSON.stringify(value);
  if (cmd === 'screen-access') {
    ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
    return out({ allowed: $.CGPreflightScreenCaptureAccess() });
  }
  if (cmd === 'drag-events') {
    const events = JSON.parse(a);
    let point = $.CGPointMake(events[0].x, events[0].y);
    const post = type => {
      const event = $.CGEventCreateMouseEvent($(), type, point, 0);
      $.CGEventSetFlags(event, 0);
      $.CGEventSetIntegerValueField(event, 1, 1); // kCGMouseEventClickState
      $.CGEventPost(0, event);
    };
    try {
      for (const event of events) {
        point = $.CGPointMake(event.x, event.y);
        post(event.type);
        delay(event.delayMs / 1000);
      }
    } finally { post(2); } // Always release, including a JXA failure while held.
    return out({ posted: true });
  }
  if (cmd === 'release-mouse' || cmd === 'move-mouse') {
    const event = $.CGEventCreate($());
    if (cmd === 'move-mouse') $.CGEventSetLocation(event, $.CGPointMake(Number(a), Number(b)));
    $.CGEventSetType(event, cmd === 'release-mouse' ? 2 : 5);
    $.CGEventSetFlags(event, 0);
    $.CGEventPost(0, event);
    delay(0.08);
    const point = $.CGEventGetLocation($.CGEventCreate($()));
    return out({ posted: true, point: { x: point.x, y: point.y }, leftDown: $.CGEventSourceButtonState(0, 0) });
  }
  if (cmd === 'mouse') {
    const right = a === 'right';
    const point = $.CGPointMake(Number(b), Number(c));
    const button = right ? 1 : 0;
    // Move first, as a pointer would, then down and up: kCGEventMouseMoved 5, left 1/2, right 3/4.
    // A plain click, whatever modifier state earlier synthetic keys left: a status item takes a Command-click as a
    // drag to rearrange the menu bar and never reports it (2026-10-04, after a synthetic Command+W).
    for (const type of [5, right ? 3 : 1, right ? 4 : 2]) {
      const event = $.CGEventCreateMouseEvent($(), type, point, button);
      $.CGEventSetFlags(event, 0);
      $.CGEventPost(0, event);
      delay(0.04);
    }
    return out({ posted: true });
  }
  if (cmd === 'key') {
    for (const down of [true, false]) {
      const event = $.CGEventCreateKeyboardEvent($(), Number(a), down);
      $.CGEventSetFlags(event, Number(b || 0));
      $.CGEventPost(0, event);
      delay(0.03);
    }
    // The modifiers were only flags on this key, never pressed: release them as a person's hand would (kCGEventFlagsChanged 12),
    // so the session's modifier state does not stay on for the next synthetic or real input.
    if (Number(b || 0)) {
      const release = $.CGEventCreate($());
      $.CGEventSetType(release, 12);
      $.CGEventSetFlags(release, 0);
      $.CGEventPost(0, release);
      delay(0.03);
    }
    return out({ posted: true });
  }
  // Every item and type of the general pasteboard, each type's bytes in its own file so a large
  // image never passes through stdout; restoring an empty manifest clears the pasteboard.
  if (cmd === 'pasteboard-save') {
    const items = $.NSPasteboard.generalPasteboard.pasteboardItems;
    const manifest = [];
    // A type whose data cannot be read now (promised data) could not be put back: name it, so the caller leaves the pasteboard alone.
    const unsaved = [];
    for (let i = 0; i < (items.isNil() ? 0 : items.count); i++) {
      const item = items.objectAtIndex(i);
      const entry = [];
      for (let j = 0; j < item.types.count; j++) {
        const type = item.types.objectAtIndex(j);
        const data = item.dataForType(type);
        if (data.isNil()) { unsaved.push(ObjC.unwrap(type)); continue; }
        const file = a + '/' + i + '-' + j;
        if (!data.writeToFileAtomically(file, true)) return out({ error: 'cannot write ' + file });
        entry.push({ type: ObjC.unwrap(type), file });
      }
      manifest.push(entry);
    }
    return out({ items: manifest, unsaved });
  }
  if (cmd === 'pasteboard-restore') {
    const pasteboard = $.NSPasteboard.generalPasteboard;
    // Every saved file is read and every type accepted before the current contents are cleared.
    const objects = [];
    for (const entry of JSON.parse(a)) {
      const item = $.NSPasteboardItem.alloc.init;
      for (const { type, file } of entry) {
        const data = $.NSData.dataWithContentsOfFile(file);
        if (data.isNil()) return out({ error: 'cannot read ' + file });
        if (!item.setDataForType(data, type)) return out({ error: 'pasteboard item refused ' + type });
      }
      objects.push(item);
    }
    pasteboard.clearContents;
    if (objects.length && !pasteboard.writeObjects($(objects))) return out({ error: 'pasteboard refused the restored items' });
    return out({ restored: objects.length });
  }
  if (!$.AXIsProcessTrusted()) return out({ error: -25211 });
  const raw = (el, name) => { const ref = Ref(); const err = $.AXUIElementCopyAttributeValue(el, $(name), ref); return err === 0 ? ref[0] : err; };
  const ok = v => typeof v !== 'number';
  const plain = v => { if (!ok(v)) return undefined; const u = ObjC.unwrap(v); return typeof u === 'string' || typeof u === 'number' || typeof u === 'boolean' ? u : undefined; };
  const geometry = el => {
    const pos = raw(el, 'AXPosition'), size = raw(el, 'AXSize');
    if (!ok(pos) || !ok(size)) return undefined;
    const p = /x:(-?[\d.]+) y:(-?[\d.]+)/.exec(ObjC.unwrap($.CFCopyDescription(pos)));
    const s = /w:(-?[\d.]+) h:(-?[\d.]+)/.exec(ObjC.unwrap($.CFCopyDescription(size)));
    return p && s ? { x: Number(p[1]), y: Number(p[2]), width: Number(s[1]), height: Number(s[2]) } : undefined;
  };
  const children = (el, name) => { const list = raw(el, name || 'AXChildren'); const items = []; if (ok(list)) for (let i = 0; i < list.count; i++) items.push(list.objectAtIndex(i)); return items; };
  if (cmd === 'banners') {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.notificationcenterui');
    if (!apps.count) return out({ banners: [] });
    const center = $.AXUIElementCreateApplication(apps.objectAtIndex(0).processIdentifier);
    const banners = [];
    const walk = (el, depth) => {
      const subrole = plain(raw(el, 'AXSubrole'));
      if (subrole === 'AXNotificationCenterBanner' || subrole === 'AXNotificationCenterAlert') {
        const texts = {};
        for (const child of children(el)) { const id = plain(raw(child, 'AXIdentifier')); if (id) texts[id] = plain(raw(child, 'AXValue')); }
        banners.push({ id: plain(raw(el, 'AXIdentifier')), subrole, description: plain(raw(el, 'AXDescription')), title: texts.title, body: texts.body });
        return;
      }
      if (depth < 12) for (const child of children(el)) walk(child, depth + 1);
    };
    for (const window of children(center, 'AXWindows')) walk(window, 0);
    return out({ banners });
  }
  const pid = Number(a);
  const app = $.AXUIElementCreateApplication(pid);
  if (cmd === 'menubar') {
    // A failed read must not pass as an item without a shortcut: only kAXErrorNoValue and
    // kAXErrorAttributeUnsupported mean the attribute is absent; any other error is returned.
    const failure = code => ({ ax: code });
    const read = (el, name, absent) => {
      const value = raw(el, name);
      if (!ok(value)) { if (absent !== undefined && (value === -25212 || value === -25205)) return absent; throw failure(value); }
      const unwrapped = plain(value);
      return unwrapped === undefined ? absent : unwrapped;
    };
    const kids = el => { const list = raw(el, 'AXChildren'); if (!ok(list)) throw failure(list); const items = []; for (let i = 0; i < list.count; i++) items.push(list.objectAtIndex(i)); return items; };
    const items = top => {
      const menu = kids(top).find(child => read(child, 'AXRole') === 'AXMenu');
      return menu ? kids(menu).filter(child => read(child, 'AXRole') === 'AXMenuItem').map(entry => ({
        title: read(entry, 'AXTitle', ''), cmdChar: read(entry, 'AXMenuItemCmdChar', ''), cmdModifiers: read(entry, 'AXMenuItemCmdModifiers', 0),
      })) : [];
    };
    try {
      const bar = raw(app, 'AXMenuBar');
      if (!ok(bar)) return out({ error: bar });
      return out({ menus: kids(bar).map(top => ({ title: read(top, 'AXTitle', ''), items: items(top) })) });
    } catch (error) {
      if (error && error.ax !== undefined) return out({ error: error.ax });
      throw error;
    }
  }
  if (cmd === 'manual') return out({ error: $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true)) || undefined });
  if (cmd === 'status' || cmd === 'press') {
    const bar = raw(app, 'AXExtrasMenuBar');
    if (!ok(bar)) return out({ error: bar });
    const item = children(bar)[0];
    if (!item) return out({ error: 'no status item' });
    const menu = children(item).find(child => plain(raw(child, 'AXRole')) === 'AXMenu');
    const entries = menu ? children(menu).filter(child => plain(raw(child, 'AXRole')) === 'AXMenuItem') : [];
    if (cmd === 'press') {
      const target = entries[Number(b)];
      if (!target) return out({ error: 'no menu item ' + b });
      return out({ error: $.AXUIElementPerformAction(target, $('AXPress')) || undefined });
    }
    // macOS 26 draws status items in Control Center's windows, one per display, named by the
    // owner's bundle identifier on the primary menu bar; an item crowded out by the front app's
    // menus stays in the list but off screen, while AX still reports its frame.
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))) || [];
    const hosts = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.controlcenter');
    const host = hosts.count ? hosts.objectAtIndex(0).processIdentifier : -1;
    const statusWindows = list.filter(w => w.kCGWindowOwnerPID === host && w.kCGWindowLayer === 25 && w.kCGWindowBounds).map(w => ({
      name: w.kCGWindowName || '', onscreen: w.kCGWindowIsOnscreen === true,
      frame: { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height },
    }));
    return out({
      statusWindows,
      item: { frame: geometry(item), title: plain(raw(item, 'AXTitle')) || '' },
      menu: menu && entries.length ? { frame: geometry(menu), items: entries.map(entry => ({
        title: plain(raw(entry, 'AXTitle')) || '', enabled: plain(raw(entry, 'AXEnabled')) === true,
        cmdChar: plain(raw(entry, 'AXMenuItemCmdChar')) || '', cmdModifiers: plain(raw(entry, 'AXMenuItemCmdModifiers')) || 0,
        selected: plain(raw(entry, 'AXSelected')) === true, frame: geometry(entry),
      })) } : null,
    });
  }
  if (cmd === 'windows') {
    const describe = el => ({ title: plain(raw(el, 'AXTitle')) || '', main: plain(raw(el, 'AXMain')) === true, minimized: plain(raw(el, 'AXMinimized')) === true, frame: geometry(el) });
    const focusedWindow = raw(app, 'AXFocusedWindow');
    const focused = raw(app, 'AXFocusedUIElement');
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    return out({
      frontmostPid: front.isNil() ? null : front.processIdentifier,
      windows: children(app, 'AXWindows').map(describe),
      focusedWindow: ok(focusedWindow) ? plain(raw(focusedWindow, 'AXTitle')) || '' : null,
      focused: ok(focused) ? { role: plain(raw(focused, 'AXRole')) || '', title: plain(raw(focused, 'AXTitle')) || '', description: plain(raw(focused, 'AXDescription')) || '',
        domId: plain(raw(focused, 'AXDOMIdentifier')) || '' } : null,
    });
  }
  if (cmd === 'layout') {
    // The window titled b: its frame, its window controls, its web content's frame and the clickable web elements
    // that overlap the zone c ({width,height} from the window's corner). Read right after the window opens, before
    // anything scrolls, so no element is scrolled out of view yet. Every node is walked: a fixed or absolutely placed
    // control stays under its flow parent in the tree wherever it is drawn, so no subtree can be skipped by its box.
    const win = children(app, 'AXWindows').find(w => plain(raw(w, 'AXTitle')) === b);
    if (!win) return out({ error: 'no window ' + b });
    const frame = geometry(win);
    if (!frame) return out({ error: 'no frame for window ' + b });
    const zone = JSON.parse(c);
    const overlaps = f => f && f.x < frame.x + zone.width && f.x + f.width > frame.x && f.y < frame.y + zone.height && f.y + f.height > frame.y;
    const controls = ['AXCloseButton', 'AXMinimizeButton', 'AXZoomButton'].map(name => { const el = raw(win, name); return { name, frame: ok(el) ? geometry(el) : undefined }; });
    const find = (el, depth) => { if (plain(raw(el, 'AXRole')) === 'AXWebArea') return el; if (depth > 12) return undefined; for (const child of children(el)) { const hit = find(child, depth + 1); if (hit) return hit; } return undefined; };
    const web = find(win, 0);
    const clickable = [];
    const roles = ['AXButton', 'AXPopUpButton', 'AXCheckBox', 'AXRadioButton', 'AXTextField', 'AXLink', 'AXMenuButton', 'AXDisclosureTriangle', 'AXComboBox', 'AXSlider'];
    let visited = 0, truncated = false;
    const walk = (el, depth) => {
      if (visited >= 20000 || depth > 120) { truncated = true; return; }
      visited++;
      const role = plain(raw(el, 'AXRole'));
      if (roles.includes(role)) {
        const f = geometry(el);
        if (f && f.width > 0 && f.height > 0 && overlaps(f)) clickable.push({ role, title: plain(raw(el, 'AXTitle')) || plain(raw(el, 'AXDescription')) || '', frame: f });
      }
      for (const child of children(el)) walk(child, depth + 1);
    };
    if (web) walk(web, 0);
    return out({ frame, controls, webArea: web ? geometry(web) : null, clickable, visited, truncated });
  }
  throw new Error('unknown command ' + cmd);
}
`;

/** kAXErrorAPIDisabled: the terminal running the runner has no Accessibility access. */
export const AX_API_DISABLED = -25211;

export class AccessibilityBlockedError extends Error {}

export interface Frame { x: number; y: number; width: number; height: number }

export interface NativeMenuItem {
  title: string;
  enabled: boolean;
  /** `AXMenuItemCmdChar`: the key of a right-aligned shortcut, "" when none. */
  cmdChar: string;
  /** `AXMenuItemCmdModifiers`: 1 Shift, 2 Option, 4 Control, 8 no Command. */
  cmdModifiers: number;
  selected: boolean;
  frame: Frame | undefined;
}

/** One status-item window of Control Center (layer 25), as the window list reports it. */
export interface StatusWindow { name: string; onscreen: boolean; frame: Frame }

export interface StatusSnapshot {
  /** Control Center's status-item windows on every display; absent from older helpers. */
  statusWindows?: StatusWindow[];
  item: { frame: Frame | undefined; title: string };
  /** The open menu, or null when none is open. */
  menu: { frame: Frame | undefined; items: NativeMenuItem[] } | null;
}

export interface WindowSnapshot {
  frontmostPid: number | null;
  windows: Array<{ title: string; main: boolean; minimized: boolean; frame: Frame | undefined }>;
  focusedWindow: string | null;
  /** `domId`: the element's HTML id, which Chromium exposes once its web accessibility is on; empty elsewhere. */
  focused: { role: string; title: string; description: string; domId?: string } | null;
}

/** What `layout` reads of one window: where its controls and its web content are, and what can be clicked in a corner. */
export interface WindowLayout {
  frame: Frame;
  controls: Array<{ name: string; frame: Frame | undefined }>;
  webArea: Frame | null;
  clickable: Array<{ role: string; title: string; frame: Frame }>;
  visited: number;
  /** The walk hit its node or depth bound: what it did not reach is unjudged (review pass 1, F1-2). */
  truncated: boolean;
}

/**
 * Problems with a `hiddenInset` window's top-left corner, empty when there are none: the web content fills the window
 * (no title bar above it), each window control lies inside `zone` (the page's own reserve, src/shared/window-controls.ts),
 * and nothing clickable in the page overlaps that zone. One point of rounding is allowed.
 */
export function judgeWindowLayout(layout: WindowLayout, zone: { width: number; height: number }): string[] {
  const problems: string[] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  const { frame, webArea } = layout;
  if (!webArea) problems.push("no web content found in the window");
  else if (!near(webArea.y, frame.y) || !near(webArea.height, frame.height)) problems.push(`the web content starts ${webArea.y - frame.y} pt below the window's top (a title bar?)`);
  for (const control of layout.controls) {
    const f = control.frame;
    if (!f) problems.push(`${control.name} not found`);
    else if (f.x < frame.x - 1 || f.y < frame.y - 1 || f.x + f.width > frame.x + zone.width + 1 || f.y + f.height > frame.y + zone.height + 1)
      problems.push(`${control.name} at ${f.x - frame.x},${f.y - frame.y} ${f.width}×${f.height} lies outside the ${zone.width}×${zone.height} zone`);
  }
  for (const element of layout.clickable) problems.push(`${element.role} "${element.title}" at ${element.frame.x - frame.x},${element.frame.y - frame.y} lies under the window controls`);
  if (layout.truncated) problems.push(`the page's accessibility tree was read only in part (${layout.visited} elements): nothing past them was checked`);
  return problems;
}

/** One top-level menu of an app's menu bar and its own items (submenus are not opened). */
export interface AppMenu {
  title: string;
  items: Array<Pick<NativeMenuItem, "title" | "cmdChar" | "cmdModifiers">>;
}

/**
 * The key equivalents RecordStuff's application menu must and must not bind
 * (src/main/index.ts): Electron's default View menu answers ⌘R and ⌥⌘I in
 * Settings, while Edit and the App and Window menus keep copy and select all
 * (the panel's only text use: copying an error's details), minimize and quit.
 * Settings has no field to paste into, so ⌘V is not required. Modifiers are
 * `AXMenuItemCmdModifiers` (0 is ⌘ alone).
 */
const MENU_FORBIDDEN = [{ key: "R", modifiers: 0, name: "⌘R (Reload)" }, { key: "I", modifiers: 2, name: "⌥⌘I (Developer Tools)" }];
const MENU_REQUIRED = [{ key: "C", name: "⌘C" }, { key: "A", name: "⌘A" }, { key: "M", name: "⌘M" }, { key: "Q", name: "⌘Q" }].map(entry => ({ ...entry, modifiers: 0 }));

/** Which forbidden shortcuts some item binds, and which required ones none does. */
export function judgeAppMenu(menus: readonly AppMenu[]): { bound: string[]; missing: string[] } {
  const binds = (key: string, modifiers: number): boolean =>
    menus.some(menu => menu.items.some(item => item.cmdChar.toUpperCase() === key && item.cmdModifiers === modifiers));
  return {
    bound: MENU_FORBIDDEN.filter(entry => binds(entry.key, entry.modifiers)).map(entry => entry.name),
    missing: MENU_REQUIRED.filter(entry => !binds(entry.key, entry.modifiers)).map(entry => entry.name),
  };
}

export interface Banner {
  id: string | undefined;
  subrole: string;
  /** "<app name> <title>, <body>" as Notification Center describes the group. */
  description: string | undefined;
  title: string | undefined;
  body: string | undefined;
}

/** Parses one helper result; an AXError becomes a typed failure, a missing permission a blocked one. */
export function parseAxResult<T>(output: string, what: string): T {
  const value = JSON.parse(output) as { error?: number | string } & T;
  if (value.error === AX_API_DISABLED) {
    throw new AccessibilityBlockedError(`${what}: macOS denied Accessibility access to this terminal (AXError -25211). Allow it in System Settings → Privacy & Security → Accessibility; runners never change that list.`);
  }
  if (value.error !== undefined) throw new Error(`${what}: ${typeof value.error === "number" ? `AXError ${value.error}` : value.error}`);
  return value;
}

/** Key codes and CGEventFlags the runners post. */
export const KEY = { escape: 53, down: 125, up: 126, return: 36, tab: 48, m: 46, w: 13, r: 15, i: 34, q: 12, a: 0, c: 8 } as const;
export const FLAG = { command: 0x100000, shift: 0x20000, option: 0x80000 } as const;

export interface NativeAx {
  status(pid: number): Promise<StatusSnapshot>;
  press(pid: number, index: number): Promise<void>;
  mouse(button: "left" | "right", x: number, y: number): Promise<void>;
  key(code: number, flags?: number): Promise<void>;
  windows(pid: number): Promise<WindowSnapshot>;
  /** The titled window's corner as `judgeWindowLayout` needs it; read with web accessibility enabled. */
  layout(pid: number, title: string, zone: { width: number; height: number }): Promise<WindowLayout>;
  menuBar(pid: number): Promise<AppMenu[]>;
  /** Asks Chromium to build its accessibility tree, as assistive software does, so web focus is readable. */
  enableWebAccessibility(pid: number): Promise<void>;
  banners(): Promise<Banner[]>;
  /** Saves the general pasteboard into `directory`; the manifest restores it, and `unsaved` names types whose data could not be read. */
  savePasteboard(directory: string): Promise<{ items: PasteboardManifest; unsaved: string[] }>;
  /** Replaces the pasteboard with a saved manifest; `[]` clears it. */
  restorePasteboard(manifest: PasteboardManifest): Promise<void>;
}

/** Per pasteboard item, each type and the file holding its bytes. */
export type PasteboardManifest = Array<Array<{ type: string; file: string }>>;

/** The real helper, each call bounded by `timeoutMs` and the runner's signal. */
export function osascriptAx(signal: AbortSignal, timeoutMs = 10_000): NativeAx {
  const runFor = async <T,>(limitMs: number, what: string, ...args: Array<string | number>): Promise<T> =>
    parseAxResult<T>(await command("osascript", ["-l", "JavaScript", "-e", AX_SCRIPT, ...args.map(String)], signal, limitMs), what);
  const run = <T,>(what: string, ...args: Array<string | number>): Promise<T> => runFor<T>(timeoutMs, what, ...args);
  return {
    status: pid => run<StatusSnapshot>("status item", "status", pid),
    press: async (pid, index) => { await run("menu item press", "press", pid, index); },
    mouse: async (button, x, y) => { await run(`${button} click`, "mouse", button, x, y); },
    key: async (code, flags = 0) => { await run(`key ${code}`, "key", code, flags); },
    windows: pid => run<WindowSnapshot>("windows", "windows", pid),
    // Every element of the page is read, a few AX calls each: a long Recordings tab needs longer than one menu.
    layout: (pid, title, zone) => runFor<WindowLayout>(60_000, "window layout", "layout", pid, title, JSON.stringify(zone)),
    menuBar: async pid => (await run<{ menus: AppMenu[] }>("menu bar", "menubar", pid)).menus,
    enableWebAccessibility: async pid => { await run("web accessibility", "manual", pid); },
    banners: async () => (await run<{ banners: Banner[] }>("Notification Center", "banners")).banners,
    savePasteboard: directory => run<{ items: PasteboardManifest; unsaved: string[] }>("pasteboard save", "pasteboard-save", directory),
    restorePasteboard: async manifest => { await run("pasteboard restore", "pasteboard-restore", JSON.stringify(manifest)); },
  };
}

/** The centre of a frame, where a click lands. */
export function centre(frame: Frame): { x: number; y: number } {
  return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}

/** `screencapture -R` takes whole points; grow the frame by `margin` so its shadow and edges show. */
export function captureRect(frame: Frame, margin = 8): string {
  return [Math.floor(frame.x - margin), Math.floor(frame.y - margin), Math.ceil(frame.width + 2 * margin), Math.ceil(frame.height + 2 * margin)].join(",");
}
