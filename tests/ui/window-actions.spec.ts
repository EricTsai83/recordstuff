/** The split control reaches production actions: hiding retains the window and tray; quitting ends the app. */
import { test, expect } from "./fixtures";
import { pickMenu } from "./helpers";

for (const language of ["en", "zh-TW"] as const) for (const size of ["default", "minimum"] as const) {
  test(`window actions ${language}/${size}: hide releases shortcut capture, keeps the app alive and reopens the same tab; Quit exits`, async ({ launchApp }) => {
    const app = await launchApp({ settings: { language, notifications: false } });
    await app.evaluate(h => { h.rightClickTray(); h.clickTrayItem("^(Open RecordStuff|開啟 RecordStuff)$"); });
    const page = await app.page("settings.html");
    // Resize the opened fixture window: a bare stored width/height is treated as an older layout by main.
    const dimensions = size === "default" ? { width: 960, height: 640 } : { width: 380, height: 360 };
    await app.evaluate((h, dimensions) => h.settingsWindow().setSize(dimensions.width, dimensions.height), dimensions);
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(dimensions);
    await page.locator("#tab-general").click();
    await pickMenu(page, "setting-hotkey", "custom");
    await expect(page.locator("#shortcut-capture")).toBeVisible();
    const windowId = await app.evaluate(h => h.settingsWindow().id);
    // The full sidebar shows Hide interface and a more-actions menu; a minimum window's collapsed sidebar one button whose
    // menu holds Hide interface and Quit.
    const group = language === "en" ? "RecordStuff window actions" : "RecordStuff 視窗操作";
    const actions = page.getByRole("group", { name: group, exact: true }).filter({ visible: true }).first();
    const hide = language === "en" ? "Hide interface" : "隱藏介面";
    if (size === "default") await actions.getByRole("button", { name: hide, exact: true }).click();
    else {
      await actions.getByRole("button", { name: group, exact: true }).click();
      await page.getByRole("menuitem", { name: hide, exact: true }).click();
    }
    await expect.poll(() => app.evaluate(h => h.settingsState().visible)).toBe(false);
    expect(await app.evaluate((h, windowId) => h.settingsWindow().id === windowId && !h.settingsWindow().isDestroyed(), windowId)).toBe(true);
    expect(app.child.exitCode).toBeNull();
    await expect(page.locator("#shortcut-capture")).toBeHidden();
    await app.evaluate(h => { h.rightClickTray(); h.clickTrayItem("^(Open RecordStuff|開啟 RecordStuff)$"); });
    await expect.poll(() => app.evaluate(h => h.settingsState().visible)).toBe(true);
    await expect(page.locator("#tab-general")).toHaveAttribute("aria-selected", "true");
    expect(await app.evaluate(h => h.settingsWindow().id)).toBe(windowId);
    const more = actions.getByRole("button", { name: size === "default" ? language === "en" ? "More window actions" : "更多視窗操作" : group, exact: true });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    // The last request uses the quit coordinator, rather than the hide path.
    const exited = new Promise<number | null>(resolve => app.child.once("exit", code => resolve(code)));
    await more.click();
    await page.getByRole("menuitem", { name: language === "en" ? "Quit RecordStuff" : "結束 RecordStuff", exact: true }).click();
    expect(await exited).toBe(0);
  });
}
