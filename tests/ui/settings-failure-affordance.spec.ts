/** Failure disclosure appearance and mouse/keyboard interaction on the hidden production renderer. */
import { test, expect } from "./fixtures";

for (const language of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`failure separators and technical disclosure ${language}/${scheme}`, async ({ launchView }, testInfo) => {
    const { launched: host, page } = await launchView({ mode: "components" });
    await expect(page.locator("#tab-library")).toBeVisible();
    await host.evaluate((h, args) => {
      h.theme(args.scheme);
      h.setSize(...h.SNAPSHOT_SIZES.default);
      h.pushModel({ type: "idle" }, { language: args.language, recordingResults: [
        { id: "terminated", occurredAt: "2026-09-29T04:38:00Z", code: "app_terminated", outcome: "unknown", detail: "Capture host exited before finalization.", acknowledged: true },
        { id: "permission", occurredAt: "2026-09-29T01:08:00Z", code: "permission_denied", outcome: "empty", acknowledged: true },
        { id: "capture", occurredAt: "2026-09-29T00:58:00Z", code: "capture_start_failed", outcome: "empty", acknowledged: true },
      ] });
    }, { language, scheme });
    await page.locator("#tab-failures").click();
    const rows = page.locator(".recording-result");
    const headers = page.locator(".result-summary");
    const card = page.locator(".result-rows");
    const cardBox = await card.boundingBox(), headerBox = await headers.first().boundingBox();
    if (!cardBox || !headerBox) throw new Error("Failure card or header is missing");
    // The top and side whitespace belongs to the header, rather than a separate unresponsive card gutter.
    for (const [edge, x, y] of [
      ["top", cardBox.x + cardBox.width / 2, cardBox.y + 2],
      ["left", cardBox.x + 2, headerBox.y + headerBox.height / 2],
      ["right", cardBox.x + cardBox.width - 2, headerBox.y + headerBox.height / 2],
    ] as const) {
      await page.mouse.move(x, y);
      await expect.poll(() => headers.first().evaluate(node => node.matches(":hover")), { message: `${edge} gutter responds to hover` }).toBe(true);
      const tint = await headers.first().evaluate(node => {
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
        context.fillStyle = getComputedStyle(node).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      });
      expect(tint[0], `${edge} hover is red based`).toBeGreaterThan(tint[1]!);
      expect(tint[0]).toBeGreaterThan(tint[2]!);
      expect(tint[3]).toBe(255);
      if (edge === "top") await card.screenshot({ path: testInfo.outputPath(`failure-row-hover-${language}-${scheme}.png`), animations: "disabled" });
      await page.mouse.click(x, y);
      await expect(headers.first()).toHaveAttribute("aria-expanded", "true");
      await page.mouse.click(x, y);
      await expect(headers.first()).toHaveAttribute("aria-expanded", "false");
    }
    const assertSeparators = async () => {
      for (const index of [1, 2]) {
        const separator = await rows.nth(index).evaluate(node => {
          const style = getComputedStyle(node, "::before");
          return { width: style.borderTopWidth, style: style.borderTopStyle, opacity: style.opacity };
        });
        expect(separator).toEqual({ width: "1px", style: "solid", opacity: "1" });
      }
    };
    await headers.first().click();
    await expect(headers.first()).toHaveAttribute("aria-expanded", "true");
    await assertSeparators();
    // Opening the middle row retains a boundary on each side of its content too.
    await headers.nth(1).click();
    await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "true");
    await assertSeparators();
    await headers.nth(1).click();
    const technical = rows.first().getByRole("button", { name: language === "en" ? "Technical details" : "技術詳細資料", exact: true });
    const chevron = technical.locator("svg");
    const content = rows.first().locator(".result-technical pre");
    await expect(technical).toHaveAttribute("aria-expanded", "false");
    await expect(chevron).toBeVisible();
    await expect(chevron).toHaveCSS("transform", "none");
    await technical.hover();
    await expect(technical).toHaveCSS("text-decoration-line", "underline");
    await expect(technical).toHaveCSS("text-decoration-color", await page.locator("#tab-failures").evaluate(el => getComputedStyle(el, "::after").backgroundColor));
    const primary = await page.locator("#tab-failures").evaluate(el => getComputedStyle(el, "::after").backgroundColor);
    await expect(technical).toHaveCSS("color", primary);
    await expect(chevron).toHaveCSS("color", primary);
    await expect(technical).toHaveCSS("cursor", "pointer");
    await assertSeparators();
    await page.locator(".result-rows").screenshot({ path: testInfo.outputPath(`failure-hover-${language}-${scheme}.png`), animations: "disabled" });
    await technical.click();
    await expect(technical).toHaveAttribute("aria-expanded", "true");
    await expect(content).toBeVisible();
    await expect(chevron).toHaveCSS("transform", "matrix(-1, 0, 0, -1, 0, 0)");
    await page.mouse.move(0, 0);
    await technical.focus();
    await page.keyboard.press("Space");
    await expect(technical).toHaveAttribute("aria-expanded", "false");
    await expect(content).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(technical).toHaveAttribute("aria-expanded", "true");
    await expect(content).toBeVisible();
    await expect(technical).toBeFocused();
    await expect(technical).toHaveCSS("text-decoration-line", "underline");
    await expect(technical).toHaveCSS("text-decoration-color", await page.locator("#tab-failures").evaluate(el => getComputedStyle(el, "::after").backgroundColor));
    await assertSeparators();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.locator("body").evaluate(node => getComputedStyle(node).fontFamily.split(",")[0]!.replaceAll('"', ""))).toBe("Inter");
    expect(await content.evaluate(node => getComputedStyle(node).fontFamily)).toContain('"JetBrains Mono"');
    const loadedFonts = await page.evaluate(() => [...document.fonts].filter(font => font.status === "loaded").map(font => font.family.replaceAll('"', "")));
    expect(loadedFonts).toEqual(expect.arrayContaining(["Inter", "JetBrains Mono"]));
    await page.locator(".result-rows").screenshot({ path: testInfo.outputPath(`failure-expanded-${language}-${scheme}.png`), animations: "disabled" });
  });
}
