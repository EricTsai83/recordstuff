/**
 * Drives RecordStuff's real status item and its menu (plan 063, step 3;
 * docs/system-design/tooling.md#scripted-native-acceptance). The menu opens
 * with a CoreGraphics right-click at the item's Accessibility frame, never
 * with `AXPress` on the item, which is a left click and would start a
 * recording. Items are chosen with `AXPress` on the menu item or by keyboard,
 * and every wait is bounded. The comparison of the native menu with the
 * production model's `tray: menu opened` line and the structural checks are
 * pure and unit-tested (tray-driver.test.ts).
 */
import { setTimeout as delay } from "node:timers/promises";
import { translate, type Language, type PlainMessageKey } from "../../src/shared/i18n.ts";
import { AccessibilityBlockedError, KEY, centre, type Frame, type NativeAx, type NativeMenuItem, type StatusSnapshot } from "./native-ax.mts";

/** Each UI state gets this long, as in the native acceptance skill. */
export const UI_TIMEOUT_MS = 30_000;

/** One entry of the logged production menu (`menuLogText` in src/main/tray-model.ts). */
export type LoggedEntry = { separator: true } | { label: string; enabled: boolean; accelerator?: string };

/** `tray: menu opened in <state>: <json>` → the state and the menu Electron was given. */
export function parseMenuLogLine(line: string): { state: string; menu: LoggedEntry[] } | undefined {
  const match = /\] tray: menu opened in (\w+): (\[.*\])$/.exec(line);
  if (!match) return undefined;
  try { return { state: match[1]!, menu: JSON.parse(match[2]!) as LoggedEntry[] }; } catch { return undefined; }
}

/** NSMenu separators have no title and are never enabled; Electron never builds an empty-label item. */
export function isSeparator(item: Pick<NativeMenuItem, "title" | "enabled">): boolean {
  return item.title === "" && !item.enabled;
}

const MODIFIER_ORDER = ["Command", "Control", "Option", "Shift"] as const;
const ELECTRON_MODIFIERS: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  commandorcontrol: "Command", cmdorctrl: "Command", command: "Command", cmd: "Command", super: "Command", meta: "Command",
  control: "Control", ctrl: "Control", alt: "Option", option: "Option", shift: "Shift",
};

/** An Electron accelerator as macOS shows it: `CommandOrControl+Shift+1` → `Command+Shift+1`. */
export function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator.split("+");
  // "Plus" names the key, and a trailing "+" split leaves an empty last part.
  const key = parts.at(-1) === "" ? "+" : parts.at(-1)!;
  const modifiers = new Set(parts.slice(0, parts.at(-1) === "" ? -2 : -1).map(part => ELECTRON_MODIFIERS[part.toLowerCase()] ?? part));
  return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key === "Plus" ? "+" : key.toUpperCase()].join("+");
}

/** The shortcut AX reports for a menu item, in the same form, or undefined when it shows none. */
export function axAccelerator(item: Pick<NativeMenuItem, "cmdChar" | "cmdModifiers">): string | undefined {
  if (!item.cmdChar) return undefined;
  const bits = item.cmdModifiers;
  const modifiers = [
    ...(bits & 8 ? [] : ["Command"]), ...(bits & 4 ? ["Control"] : []), ...(bits & 2 ? ["Option"] : []), ...(bits & 1 ? ["Shift"] : []),
  ];
  return [...modifiers, item.cmdChar.toUpperCase()].join("+");
}

/**
 * Differences between the native menu read through Accessibility and the
 * production model logged for the same popup: order, separators, labels,
 * enabled state and right-aligned shortcuts. A key that AX reports only as a
 * virtual key (F-keys, arrows, Space) cannot be compared through
 * `AXMenuItemCmdChar`; it is returned as a note, not a difference.
 */
export function compareMenu(native: readonly NativeMenuItem[], logged: readonly LoggedEntry[]): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  if (native.length !== logged.length) problems.push(`the native menu has ${native.length} entries, the model ${logged.length}`);
  for (let i = 0; i < Math.min(native.length, logged.length); i += 1) {
    const actual = native[i]!;
    const expected = logged[i]!;
    const at = `entry ${i + 1}`;
    if ("separator" in expected) {
      if (!isSeparator(actual)) problems.push(`${at}: expected a separator, found "${actual.title}"`);
      continue;
    }
    if (isSeparator(actual)) { problems.push(`${at}: expected "${expected.label}", found a separator`); continue; }
    if (actual.title !== expected.label) problems.push(`${at}: label "${actual.title}", model "${expected.label}"`);
    if (actual.enabled !== expected.enabled) problems.push(`${at} "${expected.label}": ${actual.enabled ? "enabled" : "disabled"} natively, ${expected.enabled ? "enabled" : "disabled"} in the model`);
    const shown = axAccelerator(actual);
    if (expected.accelerator === undefined) {
      if (shown) problems.push(`${at} "${expected.label}": shows ${shown}, the model has no shortcut`);
      continue;
    }
    const wanted = normalizeAccelerator(expected.accelerator);
    if (wanted.split("+").at(-1)!.length > 1) {
      notes.push(`${at} "${expected.label}": ${wanted} is a named key, which AXMenuItemCmdChar does not report; not compared`);
      continue;
    }
    if (shown !== wanted) problems.push(`${at} "${expected.label}": shows ${shown ?? "no shortcut"}, the model ${wanted}`);
  }
  return { problems, notes };
}

export type TrayState = "idle" | "starting" | "countdown" | "recording";

/**
 * The acceptance case's rules for one state's menu (docs/acceptance.md, plan
 * 048), judged on the native entries: no separator leads, trails or doubles;
 * Start recording only in idle; Stop only while recording and Cancel recording
 * only while starting (plan 065's long start) or in the countdown; Open RecordStuff in every state; no output-folder
 * item but the fix for an unavailable folder, and no Show log (2026-10-04: RecordStuff holds them); the menu ends with Quit RecordStuff.
 */
export function structureProblems(native: readonly NativeMenuItem[], state: TrayState, language: Language): string[] {
  const problems: string[] = [];
  const t = (key: PlainMessageKey): string => translate(key, language);
  const separators = native.map(isSeparator);
  if (separators[0]) problems.push("the menu starts with a separator");
  if (separators.at(-1)) problems.push("the menu ends with a separator");
  if (separators.some((separator, i) => separator && separators[i + 1])) problems.push("two separators are adjacent");
  const find = (label: string): NativeMenuItem | undefined => native.find(item => item.title === label);
  const start = find(t("Start recording"));
  if (state === "idle" && !start?.enabled) problems.push("idle has no enabled Start recording");
  if (state !== "idle" && start) problems.push(`${state} offers Start recording`);
  const stop = find(t("Stop"));
  if ((state === "recording") !== Boolean(stop?.enabled)) problems.push(state === "recording" ? "recording has no enabled Stop" : `${state} offers Stop`);
  const cancel = find(t("Cancel recording"));
  const cancellable = state === "starting" || state === "countdown";
  if (cancellable !== Boolean(cancel?.enabled)) problems.push(cancellable ? `${state} has no enabled Cancel recording` : `${state} offers Cancel recording`);
  if (!find(t("Open RecordStuff"))?.enabled) problems.push(`${state} has no enabled Open RecordStuff`);
  // The way to the newest take, through the window rather than the folder (2026-10-04), in every state.
  if (!find(t("Show last recording"))?.enabled) problems.push(`${state} has no enabled Show last recording`);
  if (native.some(item => item.title.startsWith(translate("Output folder: {path}", language, { path: "" })) || item.title === t("Show log")))
    problems.push(`${state} still lists an item RecordStuff now holds (output folder or Show log)`);
  const last = native.at(-1)?.title;
  if (last !== t("Quit RecordStuff")) problems.push(`the menu ends with ${JSON.stringify(last)}, not Quit RecordStuff`);
  return problems;
}

/**
 * Where a click reaches the status item. AX reports one frame, on one display's menu bar, even
 * when that copy is crowded out by the front app's menus (seen on a 1080 pt portrait display once
 * `REC` widened the item): the window there is off screen and a click lands on nothing. The copy
 * on the primary menu bar is named by the bundle identifier, so the click goes to the copy AX
 * reports when it is on screen, otherwise to the on-screen window named after this bundle, and
 * fails when neither is visible.
 */
export function clickTarget(snapshot: StatusSnapshot, bundleId: string): { point: { x: number; y: number }; via: string } | { hidden: string } {
  const frame = snapshot.item.frame;
  const windows = snapshot.statusWindows;
  if (!windows) return frame ? { point: centre(frame), via: "the Accessibility frame" } : { hidden: "no frame" };
  const near = (a: Frame, b: Frame): boolean => Math.abs(a.x - b.x) <= 3 && Math.abs(a.width - b.width) <= 4 && Math.abs(a.y - b.y) <= 6;
  if (frame && windows.some(window => window.onscreen && near(window.frame, frame))) return { point: centre(frame), via: "the Accessibility frame" };
  const named = windows.find(window => window.onscreen && window.name === bundleId);
  if (named) return { point: centre(named.frame), via: `the on-screen ${bundleId} window` };
  return { hidden: `the status item is not on screen on any menu bar (Accessibility frame ${JSON.stringify(frame)}); the front app's menus may crowd it out` };
}

export interface OpenMenu {
  items: NativeMenuItem[];
  snapshot: StatusSnapshot;
}

/** The status item and menu of one process, by pid; every wait is bounded and cancellable. */
export class TrayDriver {
  private readonly ax: NativeAx;
  private readonly pid: number;
  private readonly signal: AbortSignal;
  private readonly timeoutMs: number;
  private readonly bundleId: string;

  constructor(ax: NativeAx, pid: number, signal: AbortSignal, timeoutMs = UI_TIMEOUT_MS, bundleId = "com.ericts.record") {
    this.ax = ax;
    this.pid = pid;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.bundleId = bundleId;
  }

  /** Polls `read` until it returns a value, or fails after the UI timeout. */
  async until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = this.timeoutMs): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
      this.signal.throwIfAborted();
      try {
        const value = await read();
        if (value !== undefined) return value;
      } catch (error) {
        last = error;
        if (error instanceof AccessibilityBlockedError) throw error;
      }
      if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs / 1000} s${last ? ` (last error: ${String(last)})` : ""}`);
      await delay(100, undefined, { signal: this.signal });
    }
  }

  status(): Promise<StatusSnapshot> {
    return this.ax.status(this.pid);
  }

  /** Where each click of this driver went and how it was located, for the report. */
  readonly clicks: string[] = [];

  private async itemCentre(): Promise<{ x: number; y: number }> {
    const target = await this.until("a visible status item", async () => {
      const found = clickTarget(await this.status(), this.bundleId);
      return "point" in found ? found : undefined;
    }, 5000).catch(async (error: unknown) => {
      if (this.signal.aborted || error instanceof AccessibilityBlockedError) throw error;
      const found = clickTarget(await this.status(), this.bundleId);
      throw new Error("hidden" in found ? found.hidden : "the status item could not be located");
    });
    this.clicks.push(`${target.point.x},${target.point.y} via ${target.via}`);
    return target.point;
  }

  /**
   * Right-clicks the status item and waits for its menu; refuses when a menu is already open.
   * On 2026-10-02 one right-click in a recording reached nothing while the next ones opened the
   * menu, so a click that opens nothing within 3 s is repeated, at most three times, each only
   * after confirming that no menu is open.
   */
  async open(attempts = 3, perAttemptMs = 3000): Promise<OpenMenu> {
    if ((await this.status()).menu) throw new Error("a menu is already open; close it before opening another");
    const deadline = Date.now() + this.timeoutMs;
    const opened = async (): Promise<OpenMenu | undefined> => {
      const snapshot = await this.status();
      return snapshot.menu?.items.length ? { items: snapshot.menu.items, snapshot } : undefined;
    };
    for (let attempt = 1; ; attempt += 1) {
      const point = await this.itemCentre();
      await this.ax.mouse("right", point.x, point.y);
      const last = attempt >= attempts;
      const wait = last ? Math.max(0, deadline - Date.now()) : Math.min(perAttemptMs, Math.max(0, deadline - Date.now()));
      const menu = await this.until(`the tray menu to open (click ${attempt} of ${attempts})`, opened, wait).catch((error: unknown) => {
        if (last || this.signal.aborted || error instanceof AccessibilityBlockedError) throw error;
        return undefined;
      });
      if (menu) return menu;
      // A menu that opened just after the wait must not be closed by another right-click.
      const late = await opened();
      if (late) return late;
    }
  }

  /** Left-clicks the status item: the same toggle a person's click is (start, cancel or stop). */
  async click(): Promise<void> {
    const point = await this.itemCentre();
    await this.ax.mouse("left", point.x, point.y);
  }

  /** Whether the process still runs; a menu item such as Quit ends it, and then no menu can stay open. */
  alive(): boolean {
    try { process.kill(this.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }

  async waitClosed(): Promise<void> {
    await this.until("the tray menu to close", async () => {
      if (!this.alive()) return true;
      try { return (await this.status()).menu ? undefined : true; }
      // The app is quitting: its AX tree goes away before the process does.
      catch (error) { if (!this.alive()) return true; throw error; }
    });
  }

  /** Escape, then confirms the menu is gone. */
  async close(): Promise<void> {
    if (!this.alive() || !(await this.status()).menu) return;
    await this.ax.key(KEY.escape);
    await this.waitClosed();
  }

  /** Presses the open menu's item with this exact label and waits for the menu to close. */
  async select(label: string): Promise<void> {
    const snapshot = await this.status();
    const index = snapshot.menu?.items.findIndex(item => item.title === label) ?? -1;
    if (!snapshot.menu) throw new Error(`no menu is open to choose "${label}"`);
    if (index < 0) throw new Error(`the open menu has no "${label}": ${snapshot.menu.items.map(item => item.title || "—").join(" | ")}`);
    if (!snapshot.menu.items[index]!.enabled) throw new Error(`"${label}" is disabled`);
    await this.ax.press(this.pid, index);
    await this.waitClosed();
  }

  /** Sends one navigation key and returns the selected item's label afterwards ("" when none). */
  async navigate(key: number): Promise<string> {
    await this.ax.key(key);
    return this.until("the menu selection to settle", async () => {
      await delay(150, undefined, { signal: this.signal });
      const menu = (await this.status()).menu;
      if (!menu) return "";
      return menu.items.find(item => item.selected)?.title ?? "";
    });
  }
}
