/** The settings panel scrolls to its end by wheel and keyboard and never scrolls the outer page; no desktop input. */
import { test, expect } from "./fixtures";

test("the settings panel scrolls to its end by wheel and keyboard without scrolling the outer page", async ({ launchView }, testInfo) => {
  const { launched: host, page } = await launchView();
  const panel = page.locator("#settings-panel");
  for (const scheme of ["light", "dark"] as const) {
    await host.evaluate(async (h, theme) => {
      h.theme(theme);
      await h.setContentSize(960, 400);
      h.pushModel({ type: "idle" }, { library: { ...h.library().state, files: [] } });
    }, scheme);
    await page.locator("#tab-general").click();
    await panel.evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const viewport = (await panel.boundingBox())!;
    await page.screenshot({ path: testInfo.outputPath(`long-card-top-${scheme}.png`), animations: "disabled" });
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await panel.focus();
    const before = await panel.evaluate(el => el.scrollTop);
    await page.keyboard.press("PageDown");
    // The key's scroll is animated, and a wheel during it is lost: wait for it to settle, the panel being longer than
    // one page down now.
    await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBeGreaterThan(before);
    await expect.poll(async () => {
      const at = await panel.evaluate(el => el.scrollTop);
      await page.waitForTimeout(100);
      return (await panel.evaluate(el => el.scrollTop)) === at;
    }).toBe(true);
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => panel.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollTop), "the outer page does not scroll").toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`long-card-bottom-${scheme}.png`), animations: "disabled" });
  }
});
