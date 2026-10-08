/** Failure disclosure mouse/keyboard interaction on the hidden production renderer. */
import { test, expect } from "./fixtures";

for (const language of ["en", "zh-TW"] as const) {
  test(`failure rows and technical details open and close by pointer and keyboard ${language}`, async ({ launchView }, testInfo) => {
    const { launched: host, page } = await launchView({ mode: "components" });
    await expect(page.locator("#tab-library")).toBeVisible();
    await host.evaluate((h, args) => {
      h.setSize(...h.SNAPSHOT_SIZES.default);
      h.pushModel({ type: "idle" }, { language: args.language, recordingResults: [
        { id: "terminated", occurredAt: "2026-09-29T04:38:00Z", code: "app_terminated", outcome: "unknown", detail: "Capture host exited before finalization.", acknowledged: true },
        { id: "permission", occurredAt: "2026-09-29T01:08:00Z", code: "permission_denied", outcome: "empty", acknowledged: true },
        { id: "capture", occurredAt: "2026-09-29T00:58:00Z", code: "capture_start_failed", outcome: "empty", acknowledged: true },
      ] });
    }, { language });
    await page.locator("#tab-failures").click();
    const row = page.locator("#recording-result-terminated");
    const header = page.locator("#recording-result-terminated-summary");
    const middle = page.locator("#recording-result-permission-summary");
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    // Rows open independently.
    await middle.click();
    await expect(middle).toHaveAttribute("aria-expanded", "true");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await middle.click();
    await expect(middle).toHaveAttribute("aria-expanded", "false");
    const technical = row.getByRole("button", { name: language === "en" ? "Technical details" : "技術詳細資料", exact: true });
    const content = row.getByText("Capture host exited before finalization.");
    await expect(technical).toHaveAttribute("aria-expanded", "false");
    await expect(content).toBeHidden();
    await technical.click();
    await expect(technical).toHaveAttribute("aria-expanded", "true");
    await expect(content).toBeVisible();
    await page.mouse.move(0, 0);
    await technical.focus();
    await page.keyboard.press("Space");
    await expect(technical).toHaveAttribute("aria-expanded", "false");
    await expect(content).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(technical).toHaveAttribute("aria-expanded", "true");
    await expect(content).toBeVisible();
    await expect(technical).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`failure-expanded-${language}.png`), animations: "disabled" });
  });
}
