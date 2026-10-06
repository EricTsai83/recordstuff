/**
 * Shared steps for the background specs. Reads are page expressions, as the former fixtures read the page; input goes
 * through Playwright's mouse and keyboard (Chromium input events, CDP), except `mainKey`, which sends an Electron
 * input event for the keys main intercepts before the page (`before-input-event`: zoom, Escape after full screen),
 * which CDP input never reaches. None of this is OS input.
 */
import type { Page } from "@playwright/test";
import { expect, type Launched } from "./fixtures";
import { TRAFFIC_LIGHT_ZONE } from "../../src/shared/window-controls";

export const read = <T = unknown>(page: Page, expression: string): Promise<T> => page.evaluate(expression) as Promise<T>;

/** Resolves when `expression` is truthy in the page, polling; a page error counts as not yet. */
export async function until(page: Page, expression: string, timeout = 3000): Promise<boolean> {
  try {
    await expect.poll(async () => { try { return Boolean(await read(page, expression)); } catch { return false; } }, { timeout }).toBe(true);
    return true;
  } catch { return false; }
}

/** Whether `check` holds within `timeout`, polling; a check that throws counts as not yet. */
export async function eventually(check: () => Promise<boolean> | boolean, timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  do {
    try { if (await check()) return true; } catch { /* not yet */ }
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  return false;
}

/** The centre of the first element matching `selector`, scrolled into view first when `scroll` is set. */
export async function centre(page: Page, selector: string, scroll: ScrollLogicalPosition | false = "center"): Promise<{ x: number; y: number }> {
  return read(page, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ${scroll ? `el.scrollIntoView({ block: ${JSON.stringify(scroll)} });` : ""}
    const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
}

/** A mouse click at the centre of `selector`, as the former fixtures aimed theirs. */
export async function clickAt(page: Page, selector: string, options: { button?: "left" | "right"; scroll?: ScrollLogicalPosition | false } = {}): Promise<void> {
  const at = await centre(page, selector, options.scroll ?? "center");
  await page.mouse.click(at.x, at.y, { button: options.button ?? "left" });
}

/**
 * An Electron input event sent to the window's page (`webContents.sendInputEvent`), for keys main intercepts
 * (`before-input-event`), which CDP input does not pass through. `window` picks the host's window by URL fragment.
 */
export async function mainKey(host: Launched, fragment: string, keyCode: string, modifiers: string[] = []): Promise<void> {
  await host.evaluate((_h, args, electron) => {
    const window = electron.BaseWindow.getAllWindows().find(w => !w.isDestroyed() && (w as Electron.BrowserWindow).webContents?.getURL().includes(args.fragment)) as Electron.BrowserWindow | undefined;
    if (!window) throw new Error(`No window shows ${args.fragment}`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: args.keyCode, modifiers: args.modifiers as NonNullable<Electron.KeyboardInputEvent["modifiers"]> });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: args.keyCode, modifiers: args.modifiers as NonNullable<Electron.KeyboardInputEvent["modifiers"]> });
  }, { fragment, keyCode, modifiers });
}

/**
 * The window controls sit over the page's top-left corner (TRAFFIC_LIGHT_ZONE) where the page lays out for macOS:
 * nothing a person can click may lie under them. The page's own hit testing decides, every 2 px across the zone and
 * through every layer; while a modal dialog is open only what it holds can be clicked. Returns what was found, or
 * `undefined` when the page is not laid out for macOS.
 */
export async function underControls(page: Page): Promise<string[] | undefined> {
  return read(page, `(() => {
    if (document.documentElement.dataset.platform !== "darwin") return undefined;
    const clickable = 'button, select, input, a[href], summary, [tabindex]:not([tabindex="-1"])';
    const modal = document.querySelector('[role="dialog"][data-open]');
    const found = new Set();
    for (let x = 1; x < ${TRAFFIC_LIGHT_ZONE.width}; x += 2) for (let y = 1; y < ${TRAFFIC_LIGHT_ZONE.height}; y += 2) {
      for (const hit of document.elementsFromPoint(x, y)) {
        const control = hit.closest(clickable);
        if (control && (!modal || modal.contains(control))) found.add(control.id || control.className || control.tagName);
      }
    }
    return [...found];
  })()`);
}

/** Two animation frames: the frame holding a change, not the one before it. */
export const frames = (page: Page): Promise<unknown> => read(page, "new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))");

/**
 * A key Playwright's keyboard layout does not name (F13–F24), sent through the same Chromium input path it uses
 * (CDP `Input.dispatchKeyEvent`): a keyDown and keyUp with the given modifiers.
 */
export async function cdpKey(page: Page, key: { key: string; code: string; keyCode: number }, modifiers: Array<"alt" | "control" | "meta" | "shift"> = []): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const mask = modifiers.reduce((sum, name) => sum | { alt: 1, control: 2, meta: 4, shift: 8 }[name], 0);
  try {
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      await session.send("Input.dispatchKeyEvent", { type, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: mask });
    }
  } finally { await session.detach(); }
}

/**
 * Chooses `value` in a settings menu (shadcn Select, 2026-10-07) with Playwright's mouse: opens it from its trigger and
 * clicks the item, which carries its value as data-value.
 */
export async function pickMenu(page: Page, id: string, value: string): Promise<void> {
  await page.locator(`#${id}`).click();
  await page.locator(`[data-slot="select-item"][data-value="${value}"]`).click();
  await expect(page.locator('[data-slot="select-content"][data-open]')).toHaveCount(0);
}
