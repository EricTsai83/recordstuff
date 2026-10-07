import { test, expect } from "./fixtures";

test("layout switching with 300 recordings preserves cards and applies updated file data", async ({ launchView }, testInfo) => {
  test.setTimeout(60_000);
  const { launched: host, page } = await launchView({ mode: "components" });
  await host.evaluate(async h => {
    const view = await h.window().webContents.executeJavaScript("window.settings.read()");
    const template = view.library.items[0];
    h.setView({ ...view, library: { ...view.library, layout: "list", items: Array.from({ length: 300 }, (_, i) => ({
      ...template, id: `perf-${i}`, title: `Recording ${i}`, name: `${i}.mp4`, day: `Day ${Math.floor(i / 10)}`,
    })) } });
    const debug = h.window().webContents.debugger;
    debug.attach("1.3");
    await debug.sendCommand("Performance.enable");
  });
  await expect(page.locator(".clip")).toHaveCount(300);
  const transitions = await page.locator(".clip-open").first().evaluate(node => getComputedStyle(node).transitionProperty.split(",").map(value => value.trim()));
  expect(transitions).not.toContain("all");
  expect(transitions.some(property => property.startsWith("padding"))).toBe(false);
  await page.evaluate(() => {
    (window as unknown as { originalCard: Element | null }).originalCard = document.querySelector(".clip");
  });
  const metrics = () => host.evaluate(async h => {
    const result = await h.window().webContents.debugger.sendCommand("Performance.getMetrics");
    return Object.fromEntries(result.metrics.map((m: { name: string; value: number }) => [m.name, m.value])) as Record<string, number>;
  });
  const before = await metrics();
  for (let i = 0; i < 6; i++) {
    const layout = i % 2 ? "list" : "grid";
    await page.locator(`#library-layout-${layout}`).click();
    await expect(page.locator("#library")).toHaveAttribute("data-layout", layout);
    await expect.poll(() => host.evaluate(h => h.chooseCalls.length)).toBe(i + 1);
    // Wait for the reply and a painted frame, including the second render after persistence.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  const after = await metrics();
  const timing = Object.fromEntries(["ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"].map(key => [key, (after[key]! - before[key]!) * 1000]));
  await testInfo.attach("layout-timing-ms", { body: JSON.stringify(timing, null, 2), contentType: "application/json" });
  console.log("layout-timing-ms", timing);
  expect(await page.evaluate(() => document.querySelector(".clip") === (window as unknown as { originalCard: Element }).originalCard)).toBe(true);
  await page.locator("#library-layout-grid").click();
  await expect(page.locator("#library")).toHaveAttribute("data-layout", "grid");
  await page.screenshot({ path: testInfo.outputPath("library-grid.png") });
  await host.evaluate(async h => {
    const view = await h.window().webContents.executeJavaScript("window.settings.read()");
    h.setView({ ...view, library: { ...view.library, items: view.library.items.map((item: { id: string }) => item.id === "perf-0" ? {
      ...item, title: "Updated recording", duration: "9:42", size: "42 MB",
    } : item) } });
  });
  await expect(page.locator("#clip-perf-0 .clip-title")).toHaveText("Updated recording");
  await expect(page.locator("#clip-perf-0 .clip-duration")).toHaveText("9:42");
  await expect(page.locator("#clip-perf-0 .clip-meta")).toContainText("42 MB");
  await page.locator("#clip-perf-0-more").click();
  await expect(page.locator("#clip-menu")).toBeVisible();
});
