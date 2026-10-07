import { test, expect } from "./fixtures";

for (const layout of ["grid", "list"] as const) {
  test(`recordings ${layout}: shared scroll fades diminish at both ends`, async ({ launchView }, testInfo) => {
    const { launched: host, page } = await launchView();
    host.expectedErrors.push(/Failed to load resource: the server responded with a status of 404 .*\(recordstuff-media:\/\/thumb\//);
    await host.evaluate((h, layout) => {
      h.setSize(380, 360);
      h.pushModel({ type: "idle" }, { library: h.library().state, libraryLayout: layout });
    }, layout);
    await page.locator("#tab-library").click();
    await expect(page.locator("#library")).toHaveAttribute("data-layout", layout);
    const panel = page.locator("#settings-panel");
    const opacity = (id: string) => page.locator(`#${id}`).evaluate(node => Number(getComputedStyle(node).opacity));
    await panel.evaluate(node => { node.scrollTop = 0; });
    await expect.poll(() => opacity("scroll-hint-top")).toBe(0);
    await expect.poll(() => opacity("scroll-hint")).toBe(1);
    await panel.evaluate(node => { node.scrollTop = 30; });
    await expect.poll(() => opacity("scroll-hint-top")).toBeCloseTo(0.5, 1);
    const duration = await page.locator("#scroll-hint-top").evaluate(node => parseFloat(getComputedStyle(node).transitionDuration));
    expect(duration, "the shared blur retains its brief opacity animation").toBeGreaterThan(0);
    expect(duration).toBeLessThanOrEqual(0.2);
    await panel.evaluate(node => { node.scrollTop = 1; });
    await expect.poll(() => opacity("scroll-hint-top")).toBeLessThan(0.01);
    await panel.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight - 38; });
    await expect.poll(() => opacity("scroll-hint")).toBeCloseTo(0.5, 1);
    await page.screenshot({ path: testInfo.outputPath(`library-${layout}-partial-fade.png`) });
    await panel.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight - 1; });
    await expect.poll(() => opacity("scroll-hint")).toBeLessThan(0.01);
    await panel.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => opacity("scroll-hint")).toBe(0);
    const bottomGap = await page.locator(".settings-card").evaluate(node => innerHeight - node.getBoundingClientRect().bottom);
    expect(bottomGap).toBeGreaterThanOrEqual(20);
    await page.screenshot({ path: testInfo.outputPath(`library-${layout}-bottom.png`) });
    // A fitting page must not inherit the previous tab's fade.
    await host.evaluate(h => h.setSize(720, 900));
    await page.locator("#tab-recording").click();
    await expect.poll(() => opacity("scroll-hint-top")).toBe(0);
    await expect.poll(() => opacity("scroll-hint")).toBe(0);
  });
}
