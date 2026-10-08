/** Notification help follows the committed switch without adding a persistent note. */
import { test, expect } from "./fixtures";

interface HelpProbe {
  before: number[];
  frames: number[][];
  stop(): void;
}

for (const language of ["en", "zh-TW"] as const) {
  test(`notification help changes with the switch ${language}`, async ({ launchApp }, testInfo) => {
    const app = await launchApp({ settings: { language } });
    const waiting = app.page("settings.html");
    await app.evaluate(h => { h.rightClickTray(); h.clickTrayItem("Open RecordStuff|開啟 RecordStuff"); });
    const page = await waiting;
    await page.locator("#tab-general").click();
    const toggle = page.locator("#setting-notifications");
    const help = page.locator("#setting-notifications-info-button");
    const popup = page.locator("#setting-notifications-info-popup");
    const fallback = language === "en"
      ? `Failures still appear in the ${process.platform === "darwin" ? "menu bar" : "system tray"} and the Troubleshooting tab.`
      : `失敗仍會顯示在${process.platform === "darwin" ? "選單列" : "系統匣"}與「疑難排解」分頁。`;

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("#setting-notifications-row")).toHaveAttribute("aria-busy", "false");
    await expect(help).toBeVisible();
    await expect(popup).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-describedby", /setting-notifications-info/);
    // Sample from insertion through the opening animation: a settled-only check misses a transient shift.
    await page.evaluate(() => {
      const panel = document.getElementById("settings-panel")!;
      const toggle = document.getElementById("setting-notifications")!;
      const geometry = () => {
        const rect = toggle.getBoundingClientRect();
        return [panel.clientWidth, panel.scrollWidth, panel.scrollHeight, rect.x, rect.y, rect.width, rect.height];
      };
      let running = true;
      const probe: HelpProbe = { before: geometry(), frames: [], stop: () => { running = false; observer.disconnect(); } };
      (window as unknown as { notificationHelpProbe: HelpProbe }).notificationHelpProbe = probe;
      const sample = () => {
        const popup = document.getElementById("setting-notifications-info-popup");
        if (popup) probe.frames.push(geometry());
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { childList: true, subtree: true });
      const tick = () => { if (running) { sample(); requestAnimationFrame(tick); } };
      requestAnimationFrame(tick);
    });
    await help.hover();
    await expect(popup).toBeVisible();
    await expect(popup).toHaveText(fallback);
    await page.waitForTimeout(200);
    const probe = await page.evaluate(() => {
      const probe = (window as unknown as { notificationHelpProbe: HelpProbe }).notificationHelpProbe;
      probe.stop();
      return { before: probe.before, frames: probe.frames };
    });
    expect(probe.frames.length).toBeGreaterThan(1);
    for (const frame of probe.frames) {
      expect(frame, "opening help does not shift the setting or change the panel's scroll extent").toEqual(probe.before);
    }
    await page.screenshot({ path: testInfo.outputPath(`notifications-off-${language}.png`), animations: "disabled" });
    await page.mouse.move(0, 0);
    await expect(popup).toBeHidden();
    await help.focus();
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();

    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    if (process.platform === "darwin") {
      await help.hover();
      await expect(popup).toHaveText(language === "en"
        ? "macOS must also allow RecordStuff in System Settings → Notifications."
        : "macOS 另外還要在「系統設定 → 通知」中允許 RecordStuff。");
    } else await expect(help).toBeHidden();
  });
}
