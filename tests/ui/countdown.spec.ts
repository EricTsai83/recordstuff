/**
 * The countdown overlay in a hidden host (plan 066 ledger C01–C06; new background coverage, no former runner case):
 * the production `CountdownOverlay` with the built countdown preload and page, driven as the recorder drives it.
 * The digit, the faces, the fade and the window's lifetime are the page's and main's; showing it is an adapter call
 * (`showInactive`), never focus. The tick is muted here: the page's sound flag says whether one was requested, not
 * that it was heard. Capture exclusion and the audio route stay with real recording rounds (docs/testing.md).
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import { read, eventually } from "./helpers";
import { COUNTDOWN_SOUND_QUERY, COUNTDOWN_TIMING, overlayBounds } from "../../src/shared/countdown";

let host: Launched;
test.beforeEach(async ({ launchCountdown }) => { host = await launchCountdown(); });

const faces = (page: Page): Promise<{ faces: string[]; front: string; visible: boolean }> => read(page, `(() => { const stage = document.getElementById("stage");
  if (!stage) return { faces: [], front: "", visible: false };
  return { faces: [...stage.querySelectorAll(".face")].map(face => face.textContent), front: stage.querySelector(".face.front")?.textContent ?? "", visible: stage.classList.contains("visible") }; })()`);

test("C01–C04 a countdown shows its digits in a hidden, non-activating overlay sized for the display, fades out on dismissal and is destroyed on cancel", async () => {
  const waiting = host.page("countdown.html");
  await host.evaluate(h => { h.overlay.show(3, { sound: false }); });
  const page = await waiting;
  await expect.poll(async () => (await faces(page)).front, { message: "the first digit" }).toBe("3");
  const shown = await host.evaluate(h => { const window = h.overlayWindow(); return { bounds: window.getBounds(), display: h.display(), state: h.boundary.windowState(window), url: window.webContents.getURL() }; });
  const calls = (await host.calls()).map(call => call.kind);
  expect.soft(shown.bounds, "C01 the overlay is sized for the recorded display (overlayBounds)").toEqual(overlayBounds(shown.display.bounds, shown.display.workArea));
  expect.soft({ visible: (await faces(page)).visible, requested: calls.includes("window:showInactive"), focused: shown.state?.focused, focusCalls: calls.filter(kind => kind === "window:focus" || kind === "window:show" || kind === "app:focus") },
    "C01 the digit is drawn and the window is asked to show without activating").toEqual({ visible: true, requested: true, focused: false, focusCalls: [] });
  expect.soft(new URL(shown.url).searchParams.has(COUNTDOWN_SOUND_QUERY), "C01 without the tick the page is loaded without its sound flag").toBe(false);
  for (const digit of [2, 1]) {
    await host.evaluate((h, value) => h.overlay.update(value), digit);
    expect.soft(await eventually(async () => (await faces(page)).front === String(digit)), `C02 update ${digit} brings that digit to the front face`).toBe(true);
  }
  const dismissedAt = Date.now();
  const dismissing = host.evaluate(h => h.overlay.dismiss());
  expect.soft(await eventually(async () => !(await faces(page)).visible, 1000), "C03 dismissal fades the digit out on the page").toBe(true);
  await dismissing;
  const elapsed = Date.now() - dismissedAt;
  expect.soft(page.isClosed() || await eventually(() => page.isClosed(), 1000), "C03 …then destroys the window").toBe(true);
  expect.soft(elapsed >= COUNTDOWN_TIMING.fadeOutMs, `C03 …no sooner than its fade (${elapsed} ms ≥ ${COUNTDOWN_TIMING.fadeOutMs} ms)`).toBe(true);
  // A cancelled countdown: gone at once.
  const again = host.page("countdown.html");
  await host.evaluate(h => { h.overlay.show(3, { sound: false }); });
  const second = await again;
  await expect.poll(async () => (await faces(second)).front).toBe("3");
  await host.evaluate(h => h.overlay.close());
  expect.soft(await eventually(() => second.isClosed(), 1000) && !await host.evaluate(h => Boolean(h.overlayWindow())), "C04 close destroys the overlay at once").toBe(true);
});

test("C05–C06 the tick preference loads the page with its sound flag and a change of it replaces the page; the page stays muted", async () => {
  const waiting = host.page("countdown.html");
  await host.evaluate(h => { h.overlay.prepare({ sound: true }); });
  const page = await waiting;
  await page.waitForLoadState("domcontentloaded");
  const first = await host.evaluate(h => { const window = h.overlayWindow(); return { url: window.webContents.getURL(), muted: window.webContents.isAudioMuted(), id: window.id }; });
  expect.soft(new URL(first.url).searchParams.get(COUNTDOWN_SOUND_QUERY), "C05 with the tick on the page is loaded with its sound flag").toBe("1");
  expect.soft(first.muted, "C06 the overlay's page is muted in the background host (nothing is heard)").toBe(true);
  const replacing = host.application.waitForEvent("window", { predicate: next => next.url().includes("countdown.html") && next !== page });
  await host.evaluate(h => { h.overlay.show(3, { sound: false }); });
  const replaced = await replacing;
  const second = await host.evaluate(h => { const window = h.overlayWindow(); return { url: window.webContents.getURL(), id: window.id }; });
  expect.soft(second.id !== first.id && !new URL(second.url).searchParams.has(COUNTDOWN_SOUND_QUERY) && await eventually(() => page.isClosed()),
    "C05 a different tick preference replaces the page, as only a load can change its flag").toBe(true);
  await expect.poll(async () => (await faces(replaced)).front).toBe("3");
  await host.evaluate(h => h.overlay.close());
});
