/**
 * A window's new size or zoom reaches its page a moment after it is asked for, later still on a busy CI runner: a test
 * that measured at once read the old layout, and two equal reads of it passed for a settled new one (S142, S146 and
 * the zoom cases, 2026-10). The hosts' setters wait here instead, so no test has to.
 */
import type * as ElectronModule from "electron";

const SETTLE_TIMEOUT_MS = 5_000;

/**
 * The page's size in CSS pixels, read at once: it changes as the renderer takes the window's new size, and a test's
 * measurement lays the page out anew. No frame or timer of the page's is awaited, as a test may have paused its clock
 * (`page.clock`); the polling is main's.
 */
const READ_PAGE = "[window.innerWidth, window.innerHeight]";

/**
 * Resolves once `window`'s page is laid out at its window's content size and zoom (within a pixel of either, for the
 * zoom's rounding); throws with both sizes if it is not within five seconds.
 */
export async function settled(window: ElectronModule.BrowserWindow): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    if (window.isDestroyed()) return;
    const [width = 0, height = 0] = window.getContentSize();
    const zoom = window.webContents.getZoomFactor();
    const [innerWidth, innerHeight] = await window.webContents.executeJavaScript(READ_PAGE, true) as [number, number];
    const near = (css: number, device: number): boolean => Math.abs(css * zoom - device) <= zoom + 0.5;
    if (near(innerWidth, width) && near(innerHeight, height)) return;
    if (Date.now() > deadline) {
      throw new Error(`the page did not reach its window's size: ${innerWidth}×${innerHeight} CSS px at ${zoom}× in a ${width}×${height} window`);
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}
