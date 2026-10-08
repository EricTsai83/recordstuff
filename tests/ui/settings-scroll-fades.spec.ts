import { test, expect } from "./fixtures";
import fs from "node:fs/promises";

for (const scheme of ["light", "dark"] as const) {
  test(`short zoomed settings ${scheme}: the final note and control read in full and are not covered at the bottom`, async ({ launchView }, testInfo) => {
    const { launched: host, page } = await launchView();
    await host.evaluate((h, scheme) => {
      h.theme(scheme);
      h.setContentSize(380, 360);
      h.window().webContents.setZoomFactor(1.5);
      h.pushModel({ type: "idle" });
    }, scheme);
    await page.locator("#tab-recording").click();
    const panel = page.locator("#settings-panel");
    await panel.evaluate(node => { node.scrollTop = node.scrollHeight; });
    // The last visible text in the panel (the size estimate) reads in full at the bottom.
    expect(await panel.evaluate(node => {
      // Skip visually hidden text, which is clipped to a 1px box.
      const texts = [...node.querySelectorAll<HTMLElement>("*")].filter(el => el.checkVisibility({ opacityProperty: true })
        && el.getBoundingClientRect().width > 1 && el.getBoundingClientRect().height > 1 && [...el.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent!.trim()));
      const last = texts.reduce((a, b) => b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a);
      const bounds = last.getBoundingClientRect(), viewport = node.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom && Boolean(hit && last.contains(hit));
    }), "the final text stays fully readable and uncovered at the bottom").toBe(true);
    const frame = await host.evaluate(async h => (await h.window().webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString("base64"));
    await fs.writeFile(testInfo.outputPath(`short-settings-${scheme}.png`), Buffer.from(frame, "base64"));
    await page.locator("#setting-frameRate").scrollIntoViewIfNeeded();
    const bottomState = await page.locator("#setting-frameRate").evaluate(control => {
      const bounds = control.getBoundingClientRect();
      const viewport = document.getElementById("settings-panel")!.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return { visible: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom && Boolean(hit && control.contains(hit)),
        control: { top: bounds.top, bottom: bounds.bottom }, viewport: { top: viewport.top, bottom: viewport.bottom }, hit: hit?.id || hit?.className };
    });
    expect(bottomState.visible, JSON.stringify(bottomState)).toBe(true);
  });
}
